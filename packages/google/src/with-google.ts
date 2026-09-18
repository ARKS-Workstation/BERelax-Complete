import { randomUUID } from 'node:crypto'
import type { Kek } from '@berelax/clinical'
import type { Clock, GoogleCapability, GoogleCapabilityHealth } from '@berelax/core'
// Subpath import, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type { GoogleOAuthProvider } from '@berelax/providers/google'
import type { GoogleConnectionStore, GoogleConsentStore } from './connection-store.ts'
import {
  type DeclaredCapability,
  type DegradedMode,
  declarationFor,
  type GoogleConsumer,
} from './consumers.ts'
import {
  capabilityHealthFor,
  classifyGoogleError,
  DEGRADES,
  type GoogleErrorClass,
  googleCallError,
  isRetryableGoogleError,
  type UpstreamFingerprint,
  upstreamFingerprint,
} from './errors.ts'
import { accessTokenUnderLock, type RefreshLockRunner } from './token-refresh.ts'

/**
 * `withGoogle` — the single chokepoint every consumer of Google goes through.
 *
 * One function resolves the connection and the resource, obtains a token, injects a correlation id,
 * classifies every failure into the seven-class taxonomy, writes the row the owner's dashboard reads, and
 * converts a failure the next attempt cannot fix into the consumer's **declared** degraded mode.
 *
 * ## Why one chokepoint rather than three adapters calling fetch
 *
 * docs/10 §2 is blunt about it: *one chokepoint is what makes observability and graceful degradation
 * possible; three ad-hoc fetch calls make both impossible.* Concretely, the things that exist because this
 * function exists and would each have to be re-implemented three times otherwise:
 *
 *   - a correlation id shared by every line a single call emits, so *"what happened at 03:00"* is one
 *     grep rather than a reconstruction;
 *   - a taxonomy with no silent `else`, so an unmapped upstream code is named rather than swallowed;
 *   - the row the dashboard renders, because **a pg-boss job failure is not evidence anybody has seen —
 *     nobody reads `pgboss.job`** (docs/10 §4);
 *   - and degradation that comes from the CONSUMERS table rather than from the call site.
 *
 * ## Why it resolves per capability rather than taking a connection id
 *
 * The schema is deliberately not a singleton: the account that owns the Business Profile listing is
 * frequently not the account verified on the Search Console property (docs/10 §2). So *which* connection
 * serves a call is a function of the capability, and a caller that passed a connection id would have to
 * know that — which is how the SEO agent ends up pointed at the GBP-owning account.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * One structured line.
 *
 * The correlation id, the capability and the connection id are **fields rather than message text** on
 * purpose: they are what a query groups by, and a message a human wrote is not a field a query can group
 * by. `fields` carries the rest, and nothing that reaches it is a secret — see the leak detector in
 * `with-google.test.ts`, which drives every taxonomy case and greps every level.
 */
export interface GoogleLogLine {
  readonly level: LogLevel
  readonly message: string
  readonly correlationId: string
  readonly capability: GoogleCapability
  readonly consumer: GoogleConsumer
  /** Null before a connection has been resolved, which is itself the interesting case. */
  readonly connectionId: string | null
  readonly fields: Readonly<Record<string, unknown>>
}

export interface GoogleLogger {
  log(line: GoogleLogLine): void
}

/**
 * The error reporter, shaped like the subset of Sentry this system uses.
 *
 * An interface rather than the SDK, for the reason docs/10 §4 gives: a breadcrumb is one of the six places
 * a token must never reach, and a seam here is what lets a test assert that by capturing every breadcrumb
 * the chokepoint emits. Asserting it against the real SDK would mean asserting against Sentry's
 * serialiser.
 */
export interface GoogleErrorSink {
  addBreadcrumb(crumb: {
    readonly category: string
    readonly message: string
    readonly data?: Readonly<Record<string, unknown>>
  }): void
  captureException(
    error: unknown,
    context: { readonly tags: Readonly<Record<string, string>> },
  ): void
}

export interface WithGoogleDeps {
  /**
   * The connection store, plus the one capability write.
   *
   * Spelled as an intersection rather than as a wider interface so the chokepoint cannot insert a
   * capability or exchange a consent — the narrowest seam that expresses what a job needs is the cheapest
   * way to guarantee it does nothing else, which is the argument `rewrapRefreshToken` already makes.
   */
  readonly store: GoogleConnectionStore & Pick<GoogleConsentStore, 'updateCapabilityHealth'>
  readonly oauth: GoogleOAuthProvider
  readonly kek: Kek
  readonly clock: Clock
  /**
   * The advisory transaction lock a proactive refresh is serialised by (G-CONN-04).
   *
   * **Required, not optional**, and that is the substance of it. An optional lock is a lock every
   * consumer may omit, and a refresh path that can be bypassed looks serialised without being it —
   * exactly the failure `lifecycle.ts` refused to introduce by taking the lock one level too low.
   * `createPostgresRefreshLock(sql)` in production; `createMemoryRefreshLock(store)` for a unit test,
   * which serialises too rather than pretending to.
   */
  readonly lock: RefreshLockRunner
  readonly logger: GoogleLogger
  readonly errors?: GoogleErrorSink
  /** Injected so a test can assert on a known id. Defaults to a v4 UUID. */
  readonly newCorrelationId?: () => string
}

/** What the body gets. A token for the duration of one call, and never a way to store one. */
export interface GoogleCallContext {
  readonly accessToken: string
  /** `{account, location, placeId}` or `{siteUrl}`; null when no resource has been selected yet. */
  readonly resourceRef: Readonly<Record<string, unknown>> | null
  readonly correlationId: string
  readonly connectionId: string
  readonly capability: DeclaredCapability
}

/**
 * Why a call degraded.
 *
 * A superset of the taxonomy, because two of the reasons are not upstream failures at all: there may be no
 * connection, or no resource selected on the one there is. Both are ordinary states before onboarding
 * finishes, and both must degrade rather than throw for exactly the reason docs/10 §6 gives — the fallback
 * is the launch mode, not an error state.
 */
export type DegradationCause = GoogleErrorClass | 'NotConnected' | 'ResourceNotSelected'

export type WithGoogleOutcome<T> =
  | {
      readonly kind: 'ok'
      readonly value: T
      readonly correlationId: string
      readonly connectionId: string
      readonly capability: DeclaredCapability
      readonly consumer: GoogleConsumer
    }
  | {
      readonly kind: 'degraded'
      readonly mode: DegradedMode
      readonly cause: DegradationCause
      readonly correlationId: string
      readonly connectionId: string | null
      readonly capability: DeclaredCapability
      readonly consumer: GoogleConsumer
    }

interface ResolvedTarget {
  readonly connectionId: string
  readonly googleEmail: string
  readonly resourceRef: Readonly<Record<string, unknown>> | null
  /** The health already on the row, so a write that would change nothing is not made. */
  readonly health: GoogleCapabilityHealth
  readonly resourceSelected: boolean
}

/**
 * The connection and resource serving a capability, or null when nothing does.
 *
 * Preference order: an `active` connection whose capability row is primary, then any `active` one, then
 * any at all. The last step matters — a `needs_reauth` connection must still be *resolved*, because the
 * consumer needs to be told `GoogleReauthRequired` and degrade, and a resolver that skipped it would
 * report `NotConnected` instead. Those two look the same on a dashboard and need different actions: one
 * needs a button pressed, the other needs onboarding finished.
 */
async function resolveTarget(
  store: Pick<GoogleConnectionStore, 'listAll' | 'capabilitiesFor'>,
  capability: GoogleCapability,
): Promise<ResolvedTarget | null> {
  const candidates: { target: ResolvedTarget; rank: number }[] = []
  for (const connection of await store.listAll()) {
    if (connection.status === 'disconnected') continue
    const rows = (await store.capabilitiesFor(connection.id)).filter(
      (row) => row.capability === capability,
    )
    for (const row of rows) {
      const active = connection.status === 'active'
      candidates.push({
        target: {
          connectionId: connection.id,
          googleEmail: connection.googleEmail,
          resourceRef: row.resourceRef,
          health: row.health,
          resourceSelected: row.resourceRef !== null,
        },
        rank: (active ? 0 : 2) + (row.isPrimary ? 0 : 1),
      })
    }
  }
  candidates.sort((a, b) => a.rank - b.rank)
  return candidates[0]?.target ?? null
}

/**
 * Records a capability failure where the owner will see it.
 *
 * `google_connection_events` and nothing new. It is already append-only, already mirrored into
 * `audit_event` by a trigger in the same transaction, already refuses a payload carrying a token, and it
 * is already what the connection panel renders — so a third failure ledger beside it and `agent_alert`
 * would only create a question about which one to believe. The event name is `health_check_failed`, which
 * is the vocabulary migration 0016's CHECK constraint permits for *"an authenticated call against this
 * capability failed"*; a synonym would have cost a migration to say the same thing.
 *
 * The capability's own health is updated too, but only for a class that is evidence about the capability.
 * A rate limit is not: writing amber on a working capability because a call was throttled is the same
 * mistake as marking a grant dead on a 500.
 */
async function recordFailure(
  deps: WithGoogleDeps,
  args: {
    readonly target: ResolvedTarget
    readonly capability: DeclaredCapability
    readonly consumer: GoogleConsumer
    readonly errorClass: GoogleErrorClass
    readonly degradedTo: DegradedMode | null
    readonly correlationId: string
    readonly retryable: boolean
    readonly fingerprint: UpstreamFingerprint
  },
): Promise<void> {
  await deps.store.appendEvent({
    connectionId: args.target.connectionId,
    googleSub: null,
    event: 'health_check_failed',
    actorKind: 'agent',
    actorLabel: args.consumer,
    // The class and the decision, never the upstream message: an upstream library that built its message
    // from the request would carry an Authorization header into a row, and rows reach query logs,
    // pg_stat_statements, backups and pg-boss job payloads.
    detail: {
      capability: args.capability,
      consumer: args.consumer,
      errorClass: args.errorClass,
      degradedTo: args.degradedTo,
      retryable: args.retryable,
      correlationId: args.correlationId,
      source: 'withGoogle',
      // The class says what to DO; the fingerprint says what happened. Every field in it comes from a
      // closed set or a five-character SQLSTATE, so none of them can be a secret — see errors.ts.
      ...args.fingerprint,
    },
  })

  const health = capabilityHealthFor(args.errorClass)
  if (health !== null && health !== args.target.health) {
    await deps.store.updateCapabilityHealth({
      connectionId: args.target.connectionId,
      capability: args.capability,
      resourceRef: args.target.resourceRef,
      health,
    })
  }
}

/**
 * Runs `body` against Google for `capability`, or resolves to the consumer's declared degraded mode.
 *
 * It does **not** throw for a failure the next attempt cannot fix. That is the substance of the unit: a
 * consumer that has to catch in order to degrade is a consumer where somebody eventually does not, and the
 * symptom is a pg-boss job failing every six hours for the six weeks Business Profile access takes to
 * arrive — with no reply drafts, which is the one thing that still worked.
 *
 * It **does** throw for `RateLimited` and `TransientUpstream`, so the queue retries with backoff. A rate
 * limit converted into draft-only mode would turn a sixty-second wait into a day of manual work.
 */
export async function withGoogle<T>(
  deps: WithGoogleDeps,
  capability: DeclaredCapability,
  body: (context: GoogleCallContext) => Promise<T>,
): Promise<WithGoogleOutcome<T>> {
  const declaration = declarationFor(capability)
  const consumer = declaration.consumer
  const correlationId = (deps.newCorrelationId ?? randomUUID)()

  const emit = (
    level: LogLevel,
    message: string,
    connectionId: string | null,
    fields: Readonly<Record<string, unknown>> = {},
  ): void => {
    deps.logger.log({ level, message, correlationId, capability, consumer, connectionId, fields })
  }

  const degrade = (cause: DegradationCause, connectionId: string | null): WithGoogleOutcome<T> => ({
    kind: 'degraded',
    mode: declaration.degradesTo,
    cause,
    correlationId,
    connectionId,
    capability,
    consumer,
  })

  emit('info', 'google call started', null, { degradesTo: declaration.degradesTo })
  deps.errors?.addBreadcrumb({
    category: 'google',
    message: `withGoogle ${capability}`,
    data: { correlationId, capability, consumer },
  })

  const target = await resolveTarget(deps.store, capability)
  if (target === null) {
    // Not an error, and deliberately not reported as one. Before onboarding finishes there is no
    // connection, and docs/10 §6: the fallback is the launch mode rather than something we hope not to
    // need. There is also no connection row to hang an event on, and the panel already renders
    // `never_connected` from the absence itself.
    emit('warn', 'no Google connection serves this capability', null, { cause: 'NotConnected' })
    return degrade('NotConnected', null)
  }
  if (!target.resourceSelected) {
    emit('warn', 'no resource selected for this capability', target.connectionId, {
      cause: 'ResourceNotSelected',
    })
    return degrade('ResourceNotSelected', target.connectionId)
  }

  try {
    // The proactive, serialised, double-checked path — never the lazy one. `accessTokenFor` would
    // refresh without a lock, and ten jobs starting in the same second would then spend ten refresh
    // requests on a token Google may rotate on any of them (docs/10 §4).
    const grant = await accessTokenUnderLock(
      {
        store: deps.store,
        oauth: deps.oauth,
        kek: deps.kek,
        clock: deps.clock,
        lock: deps.lock,
      },
      target.connectionId,
    )
    const value = await body({
      accessToken: grant.accessToken,
      resourceRef: target.resourceRef,
      correlationId,
      connectionId: target.connectionId,
      capability,
    })
    emit('info', 'google call succeeded', target.connectionId, { refreshed: grant.refreshed })
    return {
      kind: 'ok',
      value,
      correlationId,
      connectionId: target.connectionId,
      capability,
      consumer,
    }
  } catch (error) {
    const errorClass = classifyGoogleError(error)
    const retryable = isRetryableGoogleError(error)
    const degrades = DEGRADES[errorClass]
    const fingerprint = upstreamFingerprint(error)

    await recordFailure(deps, {
      target,
      capability,
      consumer,
      errorClass,
      degradedTo: degrades ? declaration.degradesTo : null,
      correlationId,
      retryable,
      fingerprint,
    })

    emit(degrades ? 'warn' : 'error', 'google call failed', target.connectionId, {
      errorClass,
      retryable,
      degradedTo: degrades ? declaration.degradesTo : null,
      ...fingerprint,
    })

    if (degrades) return degrade(errorClass, target.connectionId)

    // Only the classes that do not degrade reach the error reporter. Capturing the others would file the
    // launch-day normal — a Business Profile quota of zero — as an exception every six hours for six
    // weeks, and an issue tracker with six weeks of expected state in it is one nobody reads.
    //
    // A NEW error, not the upstream one, and never its `cause`: the classified error is assembled from
    // values this system generated, so nothing an upstream library put in a message or a stack can be
    // serialised into a Sentry issue (docs/10 §4).
    const classified = googleCallError({
      errorClass,
      capability,
      correlationId,
      connectionId: target.connectionId,
      retryable,
    })
    deps.errors?.captureException(classified, {
      tags: { errorClass, capability, consumer, correlationId },
    })
    throw classified
  }
}
