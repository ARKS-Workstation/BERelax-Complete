import type { GoogleCapability, GoogleCapabilityHealth, Instant } from '@berelax/core'
import { type GoogleConnectionDisplayState, stateShownFor } from '@berelax/core'
import type { GoogleHealthStore } from '../connection-store.ts'
import { type ConnectionCheck, type HealthCheckDeps, runDeepCheck } from './deep-check.ts'

/**
 * *Test connection*: the nightly pass, run now, against one connection.
 *
 * ## Why this is four lines of narrowing and not an implementation
 *
 * docs/10 §4 asks for a daily cron **plus an on-demand Test connection button**, and the danger in that
 * sentence is the word *plus*. A button with its own code path reports a health the cron does not agree
 * with, and the owner then has two answers about one connection with nothing to say which is right —
 * which is worse than having no button, because the button is what they press when they already suspect
 * something.
 *
 * So there is no second implementation. {@link TEST_CONNECTION_PASS} **is** `runDeepCheck`, the same
 * exported function reference `apps/worker`'s 03:00 handler invokes, and this module's whole job is to
 * hand it a store that can see one connection instead of all of them. `test-connection.test.ts` asserts
 * the identity of the reference, and `apps/worker/src/jobs/google-connection-health.test.ts` asserts the
 * cron's end of it, so the two cannot drift apart without a named failure.
 *
 * Narrowing the STORE rather than passing a connection id is what makes that possible: `runDeepCheck`
 * decides for itself which connections to skip (`disconnected`) and whether a retry is worthwhile, and a
 * variant that took an id would have to repeat both decisions. The narrowed store is also honest about
 * what the button does — it is the same pass, over a smaller list.
 *
 * ## Why the outcome is computed from evidence and not from the absence of an exception
 *
 * ADR 0005 and docs/12 §1 both say it in different words: a stand-in must never look like it worked. The
 * available mistake here is the classic one — wrap the call in a `try`, report success when nothing threw
 * — and it would report success for a connection where **no call was made at all**: every scope missing,
 * no resource selected, or a capability set nothing declares. The pass records all of that faithfully and
 * throws nothing, because the product of a health pass is the record rather than the read.
 *
 * So `ok` is true only when at least one authenticated call was answered by Google
 * (`reachedGoogle`), and every other case carries a {@link TestConnectionReason} by name. The two failing
 * cases a caller most needs told apart are `nothing_was_checked` — the pass ran and had nothing to ask —
 * and `no_call_reached_google`, where it asked and got nowhere.
 */

/** The exact reference the scheduled pass uses. Exported so the identity is assertable, not reviewable. */
export const TEST_CONNECTION_PASS: typeof runDeepCheck = runDeepCheck

/** Why a test failed, in the vocabulary a surface branches on rather than prose it parses. */
export type TestConnectionReason =
  /** No connection with that id. */
  | 'connection_not_found'
  /** The connection was offboarded on purpose; the pass skips it and probing it would be a fault nobody wants fixed. */
  | 'connection_disconnected'
  /** The pass ran and made no authenticated call at all: nothing selected, or no scope for anything. */
  | 'nothing_was_checked'
  /** Calls were made and not one of them was answered. docs/10 §4's total failure. */
  | 'no_call_reached_google'
  /** The grant is dead. Only a re-consent fixes it. */
  | 'grant_needs_reauth'
  /** Something the owner can act on is failing, or nothing has succeeded for two days. */
  | 'capability_failing'

export interface TestedCapability {
  readonly capability: GoogleCapability
  readonly health: GoogleCapabilityHealth
  /** Whether an authenticated call was attempted. False when the scope or the resource is absent. */
  readonly called: boolean
  /** Whether Google answered it. True for a read that succeeded and then failed OUR judgement. */
  readonly reachedGoogle: boolean
  readonly reason: string | null
}

export interface TestConnectionOutcome {
  readonly connectionId: string
  /** True only when a call reached Google and nothing the owner must act on came back. */
  readonly ok: boolean
  /** Null exactly when `ok`. */
  readonly reason: TestConnectionReason | null
  readonly checkedAt: Instant
  /** What a person is shown afterwards — `stateShownFor`, so the button and the card cannot disagree. */
  readonly state: GoogleConnectionDisplayState
  readonly capabilities: readonly TestedCapability[]
  /** How many capabilities were actually asked. Zero is the case `nothing_was_checked` names. */
  readonly called: number
  /** How many of those Google answered. Zero with `called > 0` is a total failure. */
  readonly reachedGoogle: number
  /** Listing drift and unverified-listing findings the pass recorded. */
  readonly findings: number
}

/**
 * A view of the store that can see exactly one connection.
 *
 * Written out method by method rather than spread over `deps.health`, because a spread copies whatever
 * the store happens to expose and silently keeps working when the interface grows a method — while
 * `listAll` would go on being overridden and the new method would not. Delegating explicitly means a
 * method added to `GoogleHealthStore` is a compile error here, which is the only moment anybody would
 * think about whether the button should see it.
 */
function onlyThisConnection(store: GoogleHealthStore, connectionId: string): GoogleHealthStore {
  return {
    listAll: async () => {
      const connection = await store.load(connectionId)
      return connection === null ? [] : [connection]
    },
    load: (id) => store.load(id),
    capabilitiesFor: (id) => store.capabilitiesFor(id),
    confirmedListing: (args) => store.confirmedListing(args),
    updateCapabilityHealth: (write) => store.updateCapabilityHealth(write),
    recordCheckOutcome: (write) => store.recordCheckOutcome(write),
    appendEvent: (event) => store.appendEvent(event),
  }
}

function refusal(
  connectionId: string,
  reason: TestConnectionReason,
  checkedAt: Instant,
  state: GoogleConnectionDisplayState,
): TestConnectionOutcome {
  return {
    connectionId,
    ok: false,
    reason,
    checkedAt,
    state,
    capabilities: [],
    called: 0,
    reachedGoogle: 0,
    findings: 0,
  }
}

/**
 * Why a completed check is not a success, or null when it is.
 *
 * **Ordered cause before symptom**, which is the opposite of the order the conditions are cheapest to
 * evaluate in. A dead grant satisfies `no_call_reached_google` as well — of course it does, no token was
 * issued — and reporting the symptom would send the owner looking at Google's status page for a problem
 * whose fix is one button on this screen. So `broken` is asked first, and every reason below it is a
 * statement about a connection whose grant is alive.
 */
function failureReason(check: ConnectionCheck): TestConnectionReason | null {
  const state = stateShownFor(check.health)
  if (state === 'broken') return 'grant_needs_reauth'
  const called = check.capabilities.filter((capability) => capability.called)
  if (called.length === 0) return 'nothing_was_checked'
  if (!called.some((capability) => capability.reachedGoogle)) return 'no_call_reached_google'
  if (state === 'degraded') return 'capability_failing'
  // `expiring_soon` and `pending_gbp_approval` are deliberately successes. Both are amber on the card and
  // neither is a failed test: the connection answered, and what is left is a deadline the owner can act on
  // and an approval they cannot. Reporting them as failures would make the button disagree with docs/10
  // §1's whole point about the launch-day normal.
  return null
}

/**
 * Runs the nightly pass over one connection and says, by name, whether anything was proved.
 *
 * `now` is injected like every other instant in this package, so the button is reproducible at a frozen
 * clock — which is what lets the day-seven Testing expiry be tested at all.
 */
export async function testConnection(
  deps: HealthCheckDeps,
  connectionId: string,
  now: Instant,
): Promise<TestConnectionOutcome> {
  const connection = await deps.health.load(connectionId)
  if (connection === null) {
    return refusal(connectionId, 'connection_not_found', now, 'never_connected')
  }
  if (connection.status === 'disconnected') {
    // The pass skips a disconnected connection on purpose, so the button must say why rather than
    // reporting the empty result as "nothing was checked" — which would read as a fault on a row whose
    // token was revoked at Google deliberately.
    return refusal(connectionId, 'connection_disconnected', now, 'never_connected')
  }

  const result = await TEST_CONNECTION_PASS(
    { ...deps, health: onlyThisConnection(deps.health, connectionId) },
    now,
  )
  const check = result.connections[0]
  if (check === undefined) {
    // Unreachable through the two guards above, and mapped rather than asserted: if `runDeepCheck` ever
    // grows another reason to skip a connection, the button says nothing was checked instead of throwing
    // an exception a settings screen would have to render.
    return refusal(connectionId, 'nothing_was_checked', now, 'never_connected')
  }

  const reason = failureReason(check)
  return {
    connectionId,
    ok: reason === null,
    reason,
    checkedAt: result.checkedAt,
    state: stateShownFor(check.health),
    capabilities: check.capabilities.map((capability) => ({
      capability: capability.capability,
      health: capability.health,
      called: capability.called,
      reachedGoogle: capability.reachedGoogle,
      reason: capability.reason,
    })),
    called: check.capabilities.filter((capability) => capability.called).length,
    reachedGoogle: check.capabilities.filter((capability) => capability.reachedGoogle).length,
    findings: check.findings.length,
  }
}
