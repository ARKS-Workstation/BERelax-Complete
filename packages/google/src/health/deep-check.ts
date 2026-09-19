import {
  anyCallSucceeded,
  CAPABILITY_SCOPE,
  type CapabilityProbe,
  capabilityHealthFromScopes,
  deriveConnectionHealth,
  everyCallFailed,
  type GoogleCapability,
  type GoogleCapabilityHealth,
  type GoogleConnectionHealth,
  healthAfterProbe,
  type Instant,
  LISTING_DRIFT,
  LISTING_NOT_VERIFIED,
  type ListingDriftFinding,
  type ListingSnapshot,
  listingDriftFinding,
} from '@berelax/core'
// Subpath imports, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type { BusinessProfileProvider, SearchConsoleProvider } from '@berelax/providers/google'
import { isAppError } from '@berelax/shared'
import { LOCATION_READ_MASK, readLocationSnapshot } from '../adapters/business-information.ts'
import { assertSiteSelectable, listSearchConsoleSites } from '../adapters/search-console.ts'
import {
  parseGbpResourceRef,
  parseGscResourceRef,
  RESOURCE_REF_MALFORMED,
  reviewsPathFor,
} from '../capability-resolver.ts'
import type {
  GoogleCapabilityRecord,
  GoogleConnectionRecord,
  GoogleHealthStore,
} from '../connection-store.ts'
import { type DeclaredCapability, isDeclaredCapability } from '../consumers.ts'
import { capabilityHealthFor, classifyGoogleError, isRetryableGoogleError } from '../errors.ts'
import type { DegradationCause, WithGoogleDeps } from '../with-google.ts'
import { withGoogle } from '../with-google.ts'
import {
  connectionSnapshot,
  type GooglePublishingStatus,
  testingExpiryFor,
} from './testing-expiry.ts'

/**
 * The daily deep check: force a refresh, read once per capability, and say what is true.
 *
 * ## What it is for, in one sentence
 *
 * Every invalidation in docs/10 §4 is silent. A Testing-status grant dies on day seven, a revocation at
 * `myaccount.google.com` takes effect immediately, six months unused auto-invalidates, a listing can be
 * merged or moved by Google, and a listing can lose verification while still reading perfectly. Not one
 * of those produces an error anywhere until something tries to use the connection — and the things that
 * use it run weekly. This pass is the thing that tries, daily, on purpose.
 *
 * ## Three rules it is built around, each from a defect this repository has already had
 *
 * **1. The I/O goes inside `withGoogle`; every decision stays outside it.** The chokepoint classifies
 * anything thrown in its body through the Google taxonomy, so a judgement of ours — *"that is not the
 * listing the owner confirmed"*, *"that reference is malformed"*, *"this account is not verified on that
 * property"* — comes back as `TransientUpstream` with its reason discarded **and writes a
 * `health_check_failed` row onto the owner's dashboard for something Google had not done**. G-CONN-05
 * found that with `assertSiteSelectable`. So every parse and every comparison in this file happens
 * before or after the call, never during it.
 *
 * **2. A pg-boss job failure is not evidence anybody has seen** (docs/10 §4), because nobody reads
 * `pgboss.job`. Every failure this pass observes lands in `google_connection_events`, which is
 * append-only, mirrored into `audit_event` by a trigger in the same transaction, and what the connection
 * panel renders. The chokepoint writes one row per failed call; this pass writes one summary row per
 * connection per run, so *"the check ran and found nothing wrong"* is also a row rather than an absence.
 *
 * **3. `ok` is written here and nowhere else.** A consent proves the owner ticked the product
 * (G-CONN-02) and a selection proves the resource resolves (G-CONN-05); neither proves the legacy v4
 * reviews path works. This pass makes the read, so this pass is what may write `ok` — and the read it
 * makes per capability is the one that capability's consumer actually depends on.
 *
 * ## Why it forces the refresh
 *
 * Because the cached-token fast path cannot fail. A token with fifty minutes to live proves that
 * something refreshed recently and says nothing about whether the grant is still good — and the
 * seven-day expiry and the six-months-unused invalidation are observable *only* by asking Google for a
 * token. `refresh: 'forced'` still takes the advisory lock; see `AccessTokenOptions.force`.
 */

/** `detail.reason` values a surface or a caller branches on, rather than parsing prose. */
export const HEALTH_NO_CONSUMER = 'no_consumer_declares_it'
export const HEALTH_RESOURCE_REF_MALFORMED = 'resource_ref_malformed'
export const HEALTH_NO_RESOURCE_SELECTED = 'no_resource_selected'
export const HEALTH_NO_CONFIRMED_LISTING = 'no_confirmed_listing'
export const HEALTH_SCOPE_MISSING = 'scope_not_granted'

/** The two event names 0016's CHECK permits for this pass, named so the call sites cannot diverge. */
export const HEALTH_EVENT_OK = 'health_check_ok'
export const HEALTH_EVENT_FAILED = 'health_check_failed'

export interface ListingNotVerifiedFinding {
  readonly kind: typeof LISTING_NOT_VERIFIED
  readonly capability: GoogleCapability
  readonly placeId: string
  /** False when the listing itself is unverified or suspended. */
  readonly hasVoiceOfMerchant: boolean
  /** False when the connected account is not trusted to act for the business. */
  readonly hasBusinessAuthority: boolean
}

export type HealthFinding = ListingDriftFinding | ListingNotVerifiedFinding

export interface CapabilityCheck {
  readonly capability: GoogleCapability
  /** The health this pass decided. Written unless the decision was to keep the stored value. */
  readonly health: GoogleCapabilityHealth
  readonly probe: CapabilityProbe
  /** Whether an authenticated call was made at all. False when the scope or the resource is absent. */
  readonly called: boolean
  /** Whether Google answered it. True for a read that succeeded and then failed OUR judgement. */
  readonly reachedGoogle: boolean
  /** Why the health is what it is, when a code says it better than the probe kind does. */
  readonly reason: string | null
  /** The chokepoint's correlation id, so the log line and this row are one grep. */
  readonly correlationId: string | null
  /** True when the failure was one the next attempt could plausibly fix. Drives the queue's retry. */
  readonly retryable: boolean
}

export interface ConnectionCheck {
  readonly connectionId: string
  readonly googleEmail: string
  readonly capabilities: readonly CapabilityCheck[]
  readonly findings: readonly HealthFinding[]
  /** The derivation every surface and every email reads, recomputed from what this pass just wrote. */
  readonly health: GoogleConnectionHealth
  /** True when calls were made on this connection and none of them was answered. docs/10 §4. */
  readonly totalFailure: boolean
  /** Null when the consent screen is published: there is no seven-day fuse to show. */
  readonly testingExpiresAt: Instant | null
  readonly event: typeof HEALTH_EVENT_OK | typeof HEALTH_EVENT_FAILED
}

export interface DeepCheckResult {
  readonly checkedAt: Instant
  readonly connections: readonly ConnectionCheck[]
  /**
   * True when the pass learned nothing at all and trying again might change that.
   *
   * The retry decision, made once with the whole picture. Every connection was a total failure **and** at
   * least one of those failures was retryable — a rate limit, a timeout, a 500. Anything less than that is
   * a pass that did its job: it looked, it wrote the rows, and the next one is tomorrow. Retrying the
   * whole check because one capability got a 500 would spend three more forced refreshes to re-learn what
   * is already recorded, and a forced refresh is the request Google may answer with a rotated token.
   */
  readonly retryWorthwhile: boolean
}

export interface HealthCheckDeps {
  /** The chokepoint's dependencies. Every Google call below goes through it. */
  readonly google: WithGoogleDeps
  /** The narrow store seam: it reads, writes a health, records that it looked, and appends an event. */
  readonly health: GoogleHealthStore
  readonly profile: Pick<
    BusinessProfileProvider,
    'getLocation' | 'getVoiceOfMerchantState' | 'listReviews'
  >
  readonly searchConsole: Pick<SearchConsoleProvider, 'listSites'>
  /**
   * Whether the OAuth consent screen is still in Testing.
   *
   * Passed in rather than read here, because it is an owner-editable setting
   * (`google.consent_screen_publishing_status`) and this package may not import `@berelax/config`. Its
   * default there is `testing`, which is the strict answer: Testing is the default state of every Cloud
   * project, so assuming Production would silence the tripwire by omission.
   */
  readonly publishingStatus: GooglePublishingStatus
  /**
   * Whether Google has approved Basic API Access (quota moved 0 → 300 QPM).
   *
   * Also a setting, and it changes what a Business Profile failure *means*: while access is pending, a
   * refused GBP read is the launch-day normal and reads as *pending approval*; once approved, the same
   * refusal is a fault the owner has to act on. Deriving it from the failures themselves was the
   * alternative and is circular — the run would conclude "not approved" from the very refusal it is
   * trying to classify, and a genuine permission problem would read as the launch-day normal for ever.
   */
  readonly gbpAccessGranted: boolean
}

/** What one capability's read established, before it becomes a row. */
interface ProbeResult {
  readonly probe: CapabilityProbe
  readonly called: boolean
  readonly reachedGoogle: boolean
  readonly reason: string | null
  readonly correlationId: string | null
  readonly findings: readonly HealthFinding[]
  /** True when the chokepoint THREW rather than degrading: a rate limit or a transient upstream. */
  readonly retryable: boolean
}

const notCalled = (probe: CapabilityProbe, reason: string): ProbeResult => ({
  probe,
  called: false,
  reachedGoogle: false,
  reason,
  correlationId: null,
  findings: [],
  retryable: false,
})

/**
 * The capability rows this pass checks: the primary row of each capability, in a stable order.
 *
 * Primary only. A non-primary row is a second Search Console property or a second location the owner
 * registered, and it is not what any consumer resolves to — `resolveTarget` prefers the primary. A pass
 * that read every row would spend a Google call on resources nothing asks for and would then have to
 * decide which of them the connection's health is.
 */
function primaryRows(rows: readonly GoogleCapabilityRecord[]): readonly GoogleCapabilityRecord[] {
  return [...rows]
    .filter((row) => row.isPrimary)
    .sort((a, b) => a.capability.localeCompare(b.capability))
}

/**
 * What a degradation is evidence of, as a total function over every cause.
 *
 * `NotConnected` and `ResourceNotSelected` cannot arrive here — the connection was resolved by name and
 * the resource was parsed before the call — but they are mapped rather than cast away, because a cast is
 * how a cause that later *can* arrive gets filed under whichever branch was written first.
 */
function evidenceFor(cause: DegradationCause): GoogleCapabilityHealth | null {
  if (cause === 'NotConnected' || cause === 'ResourceNotSelected') return null
  return capabilityHealthFor(cause)
}

/** The degraded branch, shared by all three reads: the taxonomy's verdict, as evidence or as nothing. */
function degradedProbe(cause: DegradationCause, correlationId: string): ProbeResult {
  const evidence = evidenceFor(cause)
  return {
    // null means "evidence of nothing" — a rate limit or a dropped connection. The stored health
    // survives rather than an amber badge appearing because a network blipped.
    probe: evidence === null ? { kind: 'no_evidence' } : { kind: 'evidence', health: evidence },
    called: true,
    reachedGoogle: false,
    reason: cause,
    correlationId,
    findings: [],
    retryable: false,
  }
}

/**
 * The branch where the chokepoint **threw** instead of degrading, caught so the pass continues.
 *
 * `withGoogle` throws for `RateLimited` and `TransientUpstream` on purpose, so an ordinary consumer's
 * pg-boss job retries with backoff rather than degrading a sixty-second wait into a day of manual work.
 * For this pass, letting that propagate would be the wrong answer twice over: it would abandon every
 * capability and every connection after the first one, and it would leave the summary row unwritten — so
 * the owner's evidence for the night would be a pg-boss job row, which docs/10 §4 says is no evidence at
 * all. **The product of this pass is the record, not the read.**
 *
 * So the throw is caught, classified with the same function the chokepoint used, and recorded. The retry
 * decision is not discarded: it travels as `retryable` and `runDeepCheck` decides once, at the end, with
 * the whole picture rather than with the first failure.
 */
function threwProbe(error: unknown): ProbeResult {
  const errorClass = classifyGoogleError(error)
  const evidence = capabilityHealthFor(errorClass)
  return {
    probe: evidence === null ? { kind: 'no_evidence' } : { kind: 'evidence', health: evidence },
    called: true,
    reachedGoogle: false,
    reason: errorClass,
    correlationId: isAppError(error) ? String(error.details['correlationId'] ?? '') || null : null,
    findings: [],
    retryable: isRetryableGoogleError(error),
  }
}

/**
 * `gbp_reviews`: the legacy v4 reviews path, built from the stored reference alone.
 *
 * The read that matters most and the one nothing else makes. `locations.get` succeeding says nothing
 * about `accounts/{a}/locations/{l}/reviews` — a different service, on a different host, still on `v4`
 * while everything else migrated to `v1` (docs/10 §7). It is also the only read that exercises the
 * `account` a selection persists, which is the whole reason that field is stored.
 */
async function checkReviews(
  deps: HealthCheckDeps,
  connectionId: string,
  resourceRef: Readonly<Record<string, unknown>>,
): Promise<ProbeResult> {
  const path = reviewsPathFor(resourceRef)
  const outcome = await withGoogle(
    deps.google,
    'gbp_reviews',
    async () => deps.profile.listReviews(path),
    { connectionId, refresh: 'forced' },
  )
  if (outcome.kind === 'degraded') return degradedProbe(outcome.cause, outcome.correlationId)
  return {
    probe: { kind: 'ok' },
    called: true,
    reachedGoogle: true,
    reason: null,
    correlationId: outcome.correlationId,
    findings: [],
    retryable: false,
  }
}

/**
 * `gbp_location`: the listing, its postal address, and whether Google will let it be written to.
 *
 * Two facts from one call, and each answers a question nothing else can. The title and address are what
 * listing drift is measured on — *"the listing was merged, moved between accounts, or edited by Google"*
 * (docs/10 §4). Voice of Merchant is the only clean programmatic answer to *"why are my writes failing
 * when my token is fine"*: an unverified or suspended listing reads perfectly and refuses every reply.
 */
async function checkLocation(
  deps: HealthCheckDeps,
  connectionId: string,
  location: string,
): Promise<ProbeResult> {
  const outcome = await withGoogle(
    deps.google,
    'gbp_location',
    async () => ({
      listing: await readLocationSnapshot(deps.profile, location, LOCATION_READ_MASK),
      voiceOfMerchant: await deps.profile.getVoiceOfMerchantState(location),
    }),
    { connectionId, refresh: 'forced' },
  )
  if (outcome.kind === 'degraded') return degradedProbe(outcome.cause, outcome.correlationId)

  const returned: ListingSnapshot = {
    placeId: outcome.value.listing.placeId,
    title: outcome.value.listing.title,
    address: outcome.value.listing.address,
  }
  const findings: HealthFinding[] = []
  let reason: string | null = null

  const confirmed = await deps.health.confirmedListing({ connectionId, capability: 'gbp_location' })
  if (confirmed === null) {
    // Nothing to compare against, and deliberately NOT a finding. The owner-confirmed snapshot is the
    // `capability_changed` row the picker wrote; with no such row the only "stored" values available
    // would be the ones this very read returned, and a check compared against its own input is a check
    // that cannot fail (ADR 0003). The reason is recorded so the absence is visible rather than read as
    // "no drift".
    reason = HEALTH_NO_CONFIRMED_LISTING
  } else {
    const drift = listingDriftFinding({
      capability: 'gbp_location',
      stored: {
        placeId: confirmed.placeId,
        title: confirmed.title,
        address: confirmed.address,
      },
      returned,
    })
    if (drift !== null) findings.push(drift)
  }

  const vom = outcome.value.voiceOfMerchant
  const verified = vom.hasVoiceOfMerchant && vom.hasBusinessAuthority
  if (!verified) {
    findings.push({
      kind: LISTING_NOT_VERIFIED,
      capability: 'gbp_location',
      placeId: returned.placeId,
      hasVoiceOfMerchant: vom.hasVoiceOfMerchant,
      hasBusinessAuthority: vom.hasBusinessAuthority,
    })
  }

  return {
    // Drift does NOT move the health, and that is a decision rather than an omission. The capability
    // works: the listing resolved, the reply path is intact. What has changed is whether the listing is
    // still the one the owner confirmed, and the action is to look at it and confirm or re-pick. Writing
    // amber on a working capability is the mistake this file refuses everywhere else, and it would make
    // the badge mean two different things.
    probe: verified ? { kind: 'ok' } : { kind: 'listing_not_verified' },
    called: true,
    reachedGoogle: true,
    reason,
    correlationId: outcome.correlationId,
    findings,
    retryable: false,
  }
}

/**
 * `gsc`: the property list, and whether the stored property is still readable by this account.
 *
 * `assertSiteSelectable` runs **outside** the chokepoint. Inside it, *"this account is listed on the
 * property but is not verified on it"* came back as `TransientUpstream` with its reason discarded and
 * wrote a failure row for something Google had not done — the defect G-CONN-05 recorded, in the one
 * place it would recur.
 *
 * A property that has gone is `permission_missing` rather than `quota_zero`: no approval from Google
 * changes it, somebody has to be added back in Search Console. And the call itself **succeeded**, so
 * `reachedGoogle` stays true and the connection's `last_ok_at` still moves — the grant is alive, the
 * property is not.
 */
async function checkSearchConsole(
  deps: HealthCheckDeps,
  connectionId: string,
  siteUrl: string,
): Promise<ProbeResult> {
  const outcome = await withGoogle(
    deps.google,
    'gsc',
    async () => listSearchConsoleSites(deps.searchConsole),
    { connectionId, refresh: 'forced' },
  )
  if (outcome.kind === 'degraded') return degradedProbe(outcome.cause, outcome.correlationId)

  try {
    assertSiteSelectable(outcome.value, siteUrl)
  } catch (error) {
    return {
      probe: { kind: 'evidence', health: 'permission_missing' },
      called: true,
      reachedGoogle: true,
      reason: isAppError(error) ? String(error.details['reason'] ?? 'unknown') : 'unknown',
      correlationId: outcome.correlationId,
      findings: [],
      retryable: false,
    }
  }
  return {
    probe: { kind: 'ok' },
    called: true,
    reachedGoogle: true,
    reason: null,
    correlationId: outcome.correlationId,
    findings: [],
    retryable: false,
  }
}

/** The read for one declared capability, dispatched exhaustively so a fourth cannot be forgotten. */
async function readFor(
  deps: HealthCheckDeps,
  connection: GoogleConnectionRecord,
  capability: DeclaredCapability,
  resourceRef: Readonly<Record<string, unknown>>,
): Promise<ProbeResult> {
  switch (capability) {
    case 'gbp_reviews':
      return checkReviews(deps, connection.id, resourceRef)
    case 'gbp_location':
      return checkLocation(deps, connection.id, parseGbpResourceRef(resourceRef).location)
    case 'gsc':
      return checkSearchConsole(deps, connection.id, parseGscResourceRef(resourceRef).siteUrl)
  }
}

/** One capability: the scope diff, then the reference, then the one cheap read. */
async function checkCapability(
  deps: HealthCheckDeps,
  connection: GoogleConnectionRecord,
  row: GoogleCapabilityRecord,
): Promise<{ readonly check: CapabilityCheck; readonly findings: readonly HealthFinding[] }> {
  const capability = row.capability
  const result = await probeCapability(deps, connection, row)
  return {
    check: {
      capability,
      health: healthAfterProbe(result.probe, row.health),
      probe: result.probe,
      called: result.called,
      reachedGoogle: result.reachedGoogle,
      reason: result.reason,
      correlationId: result.correlationId,
      retryable: result.retryable,
    },
    findings: result.findings,
  }
}

async function probeCapability(
  deps: HealthCheckDeps,
  connection: GoogleConnectionRecord,
  row: GoogleCapabilityRecord,
): Promise<ProbeResult> {
  const capability = row.capability

  // 1. The scope diff, first and with no I/O. `granted_scopes` is what Google RETURNED, so a consent
  //    screen where the owner unticked one product leaves the scope absent — and calling anyway spends a
  //    request to be told what this already knows, then files the 403 under whichever class the taxonomy
  //    maps it to. It also scopes correctly by construction: only the capability whose scope is missing
  //    is marked, and the connection's own status is not touched at all.
  if (capabilityHealthFromScopes(capability, connection.grantedScopes) === 'permission_missing') {
    return notCalled(
      { kind: 'scope_missing', scope: CAPABILITY_SCOPE[capability] },
      HEALTH_SCOPE_MISSING,
    )
  }

  // 2. A capability no consumer declares cannot go through the chokepoint: `withGoogle` takes a
  //    `DeclaredCapability`, so this is a compile-time fact restated for a value that arrived from a
  //    database row. `gbp_performance` is the one — docs/10 §7 cannot even resolve its hostname, so
  //    there is no client to call and its health is honestly unknown.
  if (!isDeclaredCapability(capability)) {
    return notCalled({ kind: 'no_evidence' }, HEALTH_NO_CONSUMER)
  }

  if (row.resourceRef === null) {
    return notCalled({ kind: 'no_resource' }, HEALTH_NO_RESOURCE_SELECTED)
  }

  // 3. Parse the stored reference OUTSIDE the chokepoint. It refuses a half-written row with our own
  //    error, and inside the body that would be classified as an upstream Google failure and would write
  //    a failure row against Google's name.
  try {
    return await readFor(deps, connection, capability, row.resourceRef)
  } catch (error) {
    if (isAppError(error) && error.details['reason'] === RESOURCE_REF_MALFORMED) {
      return notCalled({ kind: 'no_resource' }, HEALTH_RESOURCE_REF_MALFORMED)
    }
    // Everything else is the chokepoint's own classified error for a class that does not degrade. Caught
    // so the pass records what it learned and carries on; see `threwProbe`.
    return threwProbe(error)
  }
}

/**
 * One connection, checked.
 *
 * Exported because *"Test connection"* (G-CONN-07) must run this exact code path rather than a second
 * implementation of it: a button that exercised different code would report a health the cron does not
 * agree with, which is worse than having no button.
 */
export async function checkConnection(
  deps: HealthCheckDeps,
  connection: GoogleConnectionRecord,
  now: Instant,
): Promise<ConnectionCheck> {
  const rows = primaryRows(await deps.health.capabilitiesFor(connection.id))
  const checks: CapabilityCheck[] = []
  const findings: HealthFinding[] = []

  for (const row of rows) {
    const result = await checkCapability(deps, connection, row)
    checks.push(result.check)
    findings.push(...result.findings)
    // Written only when this pass decided something. `no_evidence` and `no_resource` resolve to the
    // stored value, and an UPDATE writing a row's own value back is a row version nobody needed plus an
    // `updated_at` claiming the health changed when it did not.
    if (result.check.probe.kind !== 'no_evidence' && result.check.probe.kind !== 'no_resource') {
      await deps.health.updateCapabilityHealth({
        connectionId: connection.id,
        capability: row.capability,
        resourceRef: row.resourceRef,
        health: result.check.health,
      })
    }
  }

  const calls = checks.filter((check) => check.called)
  const reached = anyCallSucceeded(calls)
  const totalFailure = everyCallFailed(calls)

  // `last_ok_at` moves only when something actually reached Google; `last_checked_at` moves either way.
  // That asymmetry is what makes "we looked and it did not work" distinguishable from "nothing has
  // looked" — and *"Connected"* with no recency is exactly how silent failure hides (docs/10 §4).
  await deps.health.recordCheckOutcome({
    connectionId: connection.id,
    lastOkAt: reached ? now : null,
    lastCheckedAt: now,
  })

  // Re-read, because the pass can change the thing it is describing: a forced refresh answered
  // `invalid_grant` moves the status to `needs_reauth` while this function is running, and a summary
  // derived from the row as it was loaded would call the connection healthy in the same breath as
  // recording that its grant is dead. `displayState` is what the banner and the email read.
  const current = (await deps.health.load(connection.id)) ?? connection
  const health = deriveConnectionHealth(
    connectionSnapshot({
      connection: current,
      capabilities: checks,
      publishingStatus: deps.publishingStatus,
      gbpAccessGranted: deps.gbpAccessGranted,
      lastOkAt: reached ? now : current.lastOkAt,
    }),
    now,
  )
  const expiry = testingExpiryFor({
    publishingStatus: deps.publishingStatus,
    consentAt: current.consentAt,
    now,
  })

  const event = totalFailure || findings.length > 0 ? HEALTH_EVENT_FAILED : HEALTH_EVENT_OK
  await deps.health.appendEvent({
    connectionId: connection.id,
    googleSub: connection.googleSub,
    event,
    actorKind: 'agent',
    actorLabel: 'google-connection-health',
    // Nothing here can be a secret: every value is a capability name, a health from a closed set, a
    // finding kind, a listing title the owner already published, or a number. Rows reach query logs,
    // `pg_stat_statements`, backups and pg-boss payloads (docs/10 §4), and a CHECK constraint refuses a
    // payload carrying a token key outright.
    detail: {
      source: 'google-connection-health',
      pass: 'deep',
      displayState: health.displayState,
      status: current.status,
      statusReason: current.statusReason,
      totalFailure,
      notify: health.notify ?? 'none',
      reachedGoogle: reached,
      // The tripwire, on the row the panel renders — so the expiry is in the connection's own history
      // and not only on a settings screen somebody has to open.
      testingExpiresAt: expiry === null ? null : expiry.expiresOn,
      hoursUntilTestingExpiry: health.hoursUntilTestingExpiry,
      capabilities: checks.map((check) => ({
        capability: check.capability,
        health: check.health,
        probe: check.probe.kind,
        called: check.called,
        reason: check.reason,
        correlationId: check.correlationId,
      })),
      findings: findings.map((finding) =>
        finding.kind === LISTING_DRIFT
          ? { kind: finding.kind, capability: finding.capability, drifted: finding.drifted }
          : {
              kind: finding.kind,
              capability: finding.capability,
              hasVoiceOfMerchant: finding.hasVoiceOfMerchant,
              hasBusinessAuthority: finding.hasBusinessAuthority,
            },
      ),
    },
  })

  return {
    connectionId: connection.id,
    googleEmail: connection.googleEmail,
    capabilities: checks,
    findings,
    health,
    totalFailure,
    testingExpiresAt: expiry?.expiresAt ?? null,
    event,
  }
}

/**
 * The daily pass over every connection.
 *
 * `disconnected` is skipped and nothing else is. A `needs_reauth` connection is still checked, and that
 * is deliberate: `withGoogle` resolves it, `loadActiveConnection` refuses to hand out a token, and the
 * pass records one row saying the grant is still dead. One row a day is the evidence the panel needs
 * that the problem has not gone away on its own. A `disconnected` connection was offboarded on purpose
 * and its token revoked at Google, so probing it daily would report a fault nobody wants fixed.
 */
export async function runDeepCheck(deps: HealthCheckDeps, now: Instant): Promise<DeepCheckResult> {
  const connections = (await deps.health.listAll()).filter(
    (connection) => connection.status !== 'disconnected',
  )
  const results: ConnectionCheck[] = []
  for (const connection of connections) {
    results.push(await checkConnection(deps, connection, now))
  }
  const learnedNothing =
    results.length > 0 && results.every((connection) => connection.totalFailure)
  const retryable = results.some((connection) =>
    connection.capabilities.some((capability) => capability.retryable),
  )
  return { checkedAt: now, connections: results, retryWorthwhile: learnedNothing && retryable }
}
