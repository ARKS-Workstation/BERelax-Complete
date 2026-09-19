import {
  capabilityHealthFromScopes,
  type GoogleCapability,
  type Instant,
  isBusinessProfileCapability,
} from '@berelax/core'
// Subpath imports, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type { BusinessProfileProvider, SearchConsoleProvider } from '@berelax/providers/google'
import { enumerateAccounts } from '../adapters/account-management.ts'
import { listSearchConsoleSites } from '../adapters/search-console.ts'
import type { GoogleConnectionRecord, GoogleHealthStore } from '../connection-store.ts'
import { classifyGoogleError } from '../errors.ts'
import type { WithGoogleDeps, WithGoogleOutcome } from '../with-google.ts'
import { type DegradationCause, withGoogle } from '../with-google.ts'

/**
 * The hourly liveness probe: one cheap call per connection, to notice a dead grant within the hour.
 *
 * ## Why an hourly pass exists at all when there is a daily one
 *
 * Because the gap the daily pass leaves is a whole day, and the failure it leaves it for is the one that
 * matters most. A revoked grant, a Testing-status expiry, a Workspace administrator restricting the
 * service: each of those turns every Google capability off at once, at a moment nobody chose. The daily
 * deep check would find it at 03:00 the following morning — after up to 24 hours in which the review
 * autoresponder has been drafting against a connection nobody knows is dead, and after the owner has
 * had a whole working day in which nothing told them.
 *
 * ## What makes it cheap, and why cheap is the design rather than an optimisation
 *
 * One call per connection, against the **account** rather than against a resource, and with the refresh
 * left proactive rather than forced:
 *
 *   - **Search Console first.** `sites.list` is not behind the Basic API Access application, so it works
 *     on launch day while every Business Profile call returns `access_not_granted` (docs/10 §2 and §9).
 *     A probe that asked Business Profile first would report the launch-day normal as an outage, hourly,
 *     for the weeks the application takes.
 *   - **`accounts.list` as the fallback**, for a connection with no Search Console scope. Also cheap,
 *     and an empty list is HTTP 200 rather than an error (docs/10 §7) — which is a *successful* probe:
 *     the grant is alive, this account simply administers no profiles.
 *   - **No forced refresh.** The daily pass forces one because it has to prove the refresh token still
 *     works; this one runs 24 times a day, and 24 refreshes a day against a 100-token-per-account limit
 *     is a cost with no answer attached. When the cached token is inside its five-minute margin the
 *     refresh happens anyway, so a dead grant is still discovered within the hour of the token expiring.
 *
 * ## What it deliberately does not do
 *
 * **It does not write capability health.** It makes one call, which proves the grant rather than any
 * particular capability, and inferring *"reviews work"* from a Search Console read would put a green
 * tick on the one path nothing exercised. The chokepoint still records a failure the call itself
 * produces, which is right: that failure happened.
 *
 * **It skips a connection that is not `active`.** A grant already known to need re-authorising would
 * otherwise produce 24 identical `health_check_failed` rows a day on the owner's panel for a fact the
 * `status` column already states — and a panel with 24 copies of yesterday's problem on it is a panel
 * nobody reads, which is the failure this whole unit exists to remove. The daily deep check still
 * records one row a day for it.
 */

export interface LivenessDeps {
  readonly google: WithGoogleDeps
  readonly health: GoogleHealthStore
  readonly profile: Pick<BusinessProfileProvider, 'listAccounts'>
  readonly searchConsole: Pick<SearchConsoleProvider, 'listSites'>
}

/** Why a connection was not probed. A closed set, so the summary line is not prose. */
export type LivenessSkip = 'disconnected' | 'not_active' | 'no_scope'

export interface LivenessProbe {
  readonly connectionId: string
  readonly googleEmail: string
  /** The capability the probe ran as, or null when it was skipped. */
  readonly capability: GoogleCapability | null
  readonly alive: boolean
  readonly cause: DegradationCause | null
  readonly skipped: LivenessSkip | null
  readonly correlationId: string | null
}

export interface LivenessResult {
  readonly checkedAt: Instant
  readonly probes: readonly LivenessProbe[]
}

/**
 * The cheapest capability whose scope this grant actually carries.
 *
 * `gsc` before `gbp_location`, which is the sequencing fact docs/10 §9 turns the build order on: Search
 * Console is ungated and Business Profile is not. Null when the grant carries neither scope, which is a
 * connection nothing can probe rather than a connection that is broken.
 */
export function livenessCapabilityFor(
  grantedScopes: readonly string[],
): 'gsc' | 'gbp_location' | null {
  if (capabilityHealthFromScopes('gsc', grantedScopes) === 'ok') return 'gsc'
  if (capabilityHealthFromScopes('gbp_location', grantedScopes) === 'ok') return 'gbp_location'
  return null
}

async function probe(
  deps: LivenessDeps,
  connection: GoogleConnectionRecord,
  now: Instant,
): Promise<LivenessProbe> {
  const base = { connectionId: connection.id, googleEmail: connection.googleEmail }
  if (connection.status === 'disconnected') {
    return {
      ...base,
      capability: null,
      alive: false,
      cause: null,
      skipped: 'disconnected',
      correlationId: null,
    }
  }
  if (connection.status !== 'active') {
    return {
      ...base,
      capability: null,
      alive: false,
      cause: null,
      skipped: 'not_active',
      correlationId: null,
    }
  }
  const capability = livenessCapabilityFor(connection.grantedScopes)
  if (capability === null) {
    return {
      ...base,
      capability: null,
      alive: false,
      cause: null,
      skipped: 'no_scope',
      correlationId: null,
    }
  }

  let outcome: WithGoogleOutcome<unknown>
  try {
    outcome = await withGoogle(
      deps.google,
      capability,
      async () =>
        isBusinessProfileCapability(capability)
          ? enumerateAccounts(deps.profile)
          : listSearchConsoleSites(deps.searchConsole),
      // `enumerating`, because liveness is a question about the GRANT and not about the resource.
      // Requiring a resource would make this answer `ResourceNotSelected` for a connection whose token is
      // perfectly alive and whose listing has simply not been picked yet — and the one thing this probe
      // exists to do is notice a dead token within the hour. See `WithGoogleOptions.resource`.
      { connectionId: connection.id, resource: 'enumerating' },
    )
  } catch (error) {
    // `withGoogle` throws for `RateLimited` and `TransientUpstream` so an ordinary consumer's job retries
    // with backoff. Here that would mean one connection's blip abandoning every connection after it — and
    // a probe that stops at the first problem is a probe that reports the rest as unprobed rather than as
    // alive, which is the failure this whole unit is about. The chokepoint has already written the row the
    // owner reads, so the classification is all that is needed to carry on.
    await deps.health.recordCheckOutcome({
      connectionId: connection.id,
      lastOkAt: null,
      lastCheckedAt: now,
    })
    return {
      ...base,
      capability,
      alive: false,
      cause: classifyGoogleError(error),
      skipped: null,
      correlationId: null,
    }
  }

  await deps.health.recordCheckOutcome({
    connectionId: connection.id,
    lastOkAt: outcome.kind === 'ok' ? now : null,
    lastCheckedAt: now,
  })

  return {
    ...base,
    capability,
    alive: outcome.kind === 'ok',
    cause: outcome.kind === 'degraded' ? outcome.cause : null,
    skipped: null,
    correlationId: outcome.correlationId,
  }
}

export async function runLiveness(deps: LivenessDeps, now: Instant): Promise<LivenessResult> {
  const connections = await deps.health.listAll()
  const probes: LivenessProbe[] = []
  for (const connection of connections) {
    probes.push(await probe(deps, connection, now))
  }
  return { checkedAt: now, probes }
}
