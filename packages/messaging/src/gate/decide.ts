/**
 * The promotional compliance gate: code, not settings, and it fails closed.
 *
 * ## Why every check here is a function and not a toggle
 *
 * Consent, suppression, the global frequency cap and the 07:00–21:00 Asia/Dubai window are the four
 * things TDRA can suspend a sender ID over, and the practical sanction is suspension rather than a
 * fine (docs/04 §5). A settings page that can switch any of them off is a page somebody uses at 2am
 * to get a campaign out. So the rules live in this module and in `@berelax/core` as code; what is
 * configurable is *bounded* — the window may be narrowed inside 07:00–21:00 by the owner and audited,
 * and nothing more. See `./window.ts` and ADR 0016.
 *
 * `scripts/check-send-chokepoint.mjs` is the half of that claim a type cannot make. Its
 * `gate-evaluator-answers-a-constant` rule refuses `hasConsent: () => true` in any shipped module, which
 * is what a toggle actually looks like once somebody has written one: not a setting, a stub. The five
 * runtimes that wire this gate today all supply evaluators that THROW, and a throw is a refusal.
 *
 * ## Why an evaluator that throws blocks the send
 *
 * Consent and suppression are stored state, so reading them can fail: a connection pool exhausted, a
 * replica behind, a migration mid-flight. The tempting default is to carry on — the message is
 * probably fine, the campaign is running, the error is transient.
 *
 * That default is what sends a promotional SMS to somebody who opted out, and the evidence that it
 * happened is a stack trace in a log nobody reads. **An input that cannot be evaluated is not
 * permission.** Every evaluator here is wrapped, and a throw — or a non-boolean answer, which is what
 * a repository returns on a cache miss it did not expect — becomes `blocked_unevaluable`. The send is
 * recorded as blocked and the transport is never reached.
 *
 * ## Why transactional traffic never enters this function's body
 *
 * The first line returns `allow` for a transactional message, before the kill switch and before any
 * evaluator. That is deliberate and it is the whole point of two registered sender IDs: an
 * unreachable consent store, an engaged marketing kill switch or a suspended promotional identity must
 * not stop a booking confirmation or an OTP. A marketing problem that becomes an operational outage is
 * the failure ADR 0016 exists to remove.
 */
import {
  ASIA_DUBAI,
  type Instant,
  instantToIso,
  type LocalDateTime,
  type TimeZone,
  toLocal,
} from '@berelax/core'
import type { OutboundMessage } from '../port.ts'
import {
  type DatedPromotionalOverride,
  decideSendWindow,
  type PromotionalWindow,
} from './window.ts'

// --- the gate ----------------------------------------------------------------------------------

/** Which input could not be evaluated. Named, because "blocked" without the reason is unactionable. */
export type GateEvaluatorName = 'consent' | 'suppression' | 'frequency_cap' | 'quiet_hours'

export type GateRefusal =
  | 'marketing_kill_switch'
  | 'refused_no_consent'
  | 'refused_suppressed'
  | 'refused_frequency_cap'

export type GateDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'refuse'; readonly reason: GateRefusal; readonly detail: string }
  | {
      readonly kind: 'unevaluable'
      readonly reason: 'blocked_unevaluable'
      readonly evaluator: GateEvaluatorName
      readonly detail: string
    }
  /** Outside the window, so held rather than dropped. A dropped reminder is indistinguishable from one that was never scheduled. */
  | {
      readonly kind: 'queue'
      readonly reason: 'queued_for_window'
      readonly releaseAtIso: string
    }
  /**
   * Held past the staleness ceiling. Expires unsent — never sent late, never silently discarded.
   *
   * A separate kind from `refuse` because the two answer different questions and a caller acts on them
   * differently: a refusal is about this contact and is the same answer tomorrow, an expiry is about this
   * message and says the offer outlived its window. Folding it into `refuse` would file "we held it too
   * long" under the same heading as "they opted out", and the report the owner is owed (`Y9-queued-staleness`)
   * would be unable to tell them apart.
   */
  | {
      readonly kind: 'expire'
      readonly reason: 'stale_outside_window'
      readonly detail: string
      readonly queuedSinceIso: string
      readonly maxStalenessSeconds: number
    }

export interface GateEvaluators {
  /** True when an affirmative marketing consent record exists for this recipient and channel. */
  readonly hasConsent: (message: OutboundMessage) => boolean
  /** True when the recipient is on the suppression list. */
  readonly isSuppressed: (message: OutboundMessage) => boolean
  /** True when this contact has already had its week's allowance across every flow and campaign. */
  readonly frequencyCapReached: (message: OutboundMessage) => boolean
  /**
   * Wall-clock reader for the quiet-hours rule, defaulting to `toLocal`.
   *
   * Overridable only so the unevaluable path is reachable from a test — there is deliberately no
   * setting behind it, and the window itself is the code rule in `./window.ts`. A clock that cannot
   * answer is the third way quiet hours become unevaluable, alongside an unreachable consent store and
   * an unreachable suppression list.
   */
  readonly localTimeAt?: (instant: Instant, zone: TimeZone) => LocalDateTime
}

export interface GateContext {
  /**
   * Stops every promotional send. Structurally unable to touch transactional traffic, because
   * `evaluateGate` returns before reading it for a transactional message.
   */
  readonly marketingKillSwitch: boolean
  readonly promotionalWindow: PromotionalWindow
  readonly evaluators: GateEvaluators
  readonly zone?: TimeZone
  /**
   * Dated narrowings of the window, as `business_calendar` holds them (migration 0003,
   * `kind = 'ramadan_hours'`).
   *
   * Supplied rather than read, and empty by default, because no Ramadan date appears anywhere in this
   * build: the dates are announced by an authority and are a fact about the world, not a value a unit may
   * invent (brief rule 15, `Y9-ramadan-window`). An override may only NARROW, and `@berelax/core` refuses
   * one that would widen as well as intersecting it so it structurally cannot.
   */
  readonly windowOverrides?: readonly DatedPromotionalOverride[]
}

/**
 * What this attempt already knows about itself. Absent for a first attempt.
 *
 * Only `queuedSince` today, and an object rather than a bare instant so the release path can grow a
 * second fact — the campaign, the flow run — without changing `evaluateGate`'s arity again.
 */
export interface GateAttempt {
  /** When this message was first held for the window. Its age is what the staleness ceiling measures. */
  readonly queuedSince: Instant
}

type Evaluated =
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly detail: string }

/**
 * Runs one evaluator without letting it decide "allowed" by accident.
 *
 * `read` is typed as returning `unknown` on purpose. A repository that answers `undefined` on a cache
 * miss satisfies a `boolean` signature at compile time and is falsy at runtime, which would read as
 * "no consent" for consent and as "not suppressed" for suppression — the same non-answer allowing one
 * check and blocking the other.
 */
function evaluate(name: GateEvaluatorName, read: () => unknown): Evaluated {
  let answer: unknown
  try {
    answer = read()
  } catch (error) {
    return { ok: false, detail: `The ${name} evaluator threw: ${describe(error)}` }
  }
  if (typeof answer !== 'boolean') {
    return {
      ok: false,
      detail:
        `The ${name} evaluator answered with ${answer === null ? 'null' : typeof answer} rather ` +
        'than a boolean. A non-answer is not permission.',
    }
  }
  return { ok: true, value: answer }
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

const ALLOW: GateDecision = { kind: 'allow' }

/**
 * The gate. Order matters and is asserted:
 *
 * 1. transactional traffic is out of scope entirely;
 * 2. the marketing kill switch, before any store is read, so a stopped campaign reads nothing;
 * 3. consent, suppression, frequency cap — each failing closed;
 * 4. the window, which queues rather than refuses, because a promotional message at 01:00 is not
 *    wrong, it is early — or expires it, if it has been held too long to be worth sending.
 */
export function evaluateGate(
  ctx: GateContext,
  message: OutboundMessage,
  instant: Instant,
  attempt?: GateAttempt,
): GateDecision {
  if (message.messageClass === 'transactional') return ALLOW

  if (ctx.marketingKillSwitch) {
    return {
      kind: 'refuse',
      reason: 'marketing_kill_switch',
      detail:
        'The marketing kill switch is engaged. Promotional sends are stopped; transactional ' +
        'traffic is unaffected by design.',
    }
  }

  const consent = evaluate('consent', () => ctx.evaluators.hasConsent(message))
  if (!consent.ok) return unevaluable('consent', consent.detail)
  if (!consent.value) {
    return {
      kind: 'refuse',
      reason: 'refused_no_consent',
      detail:
        'No affirmative marketing consent record for this recipient. TDRA requires the opt-in ' +
        'proof to exist before the send, not after the complaint.',
    }
  }

  const suppressed = evaluate('suppression', () => ctx.evaluators.isSuppressed(message))
  if (!suppressed.ok) return unevaluable('suppression', suppressed.detail)
  if (suppressed.value) {
    return {
      kind: 'refuse',
      reason: 'refused_suppressed',
      detail:
        'The recipient is on the suppression list. A suppression is permanent until withdrawn.',
    }
  }

  const capped = evaluate('frequency_cap', () => ctx.evaluators.frequencyCapReached(message))
  if (!capped.ok) return unevaluable('frequency_cap', capped.detail)
  if (capped.value) {
    return {
      kind: 'refuse',
      reason: 'refused_frequency_cap',
      detail:
        'The weekly cap for this contact is already spent. The cap is global across every flow and ' +
        'campaign, not per campaign.',
    }
  }

  const zone = ctx.zone ?? ASIA_DUBAI
  const readLocal = ctx.evaluators.localTimeAt ?? toLocal
  let local: LocalDateTime
  try {
    local = readLocal(instant, zone)
  } catch (error) {
    return unevaluable('quiet_hours', `The quiet-hours clock threw: ${describe(error)}`)
  }

  // The window rule itself is pure and lives in `@berelax/core`. Reaching it through `decideSendWindow`
  // rather than re-deciding here is what makes the claim "there is one quiet-hours rule" true of the code
  // rather than of a comment — the scheduler and the interpreter read the same function.
  //
  // It can throw, and the throw is not a bug: a dated override that would WIDEN the window, or a set of
  // overrides under which the window never opens, are both refused by name there. Either is a
  // configuration fault the send must not proceed through, so it lands on the quiet-hours evaluator
  // exactly as an unreadable clock does.
  let decision: ReturnType<typeof decideSendWindow>
  try {
    decision = decideSendWindow({
      messageClass: message.messageClass,
      at: instant,
      local,
      zone,
      window: ctx.promotionalWindow,
      overrides: ctx.windowOverrides,
      queuedSince: attempt?.queuedSince,
    })
  } catch (error) {
    return unevaluable(
      'quiet_hours',
      `The promotional window could not be resolved: ${describe(error)}`,
    )
  }

  if (decision.kind === 'open' || decision.kind === 'not_applicable') return ALLOW

  if (decision.kind === 'expire') {
    return {
      kind: 'expire',
      reason: decision.reason,
      detail: decision.detail,
      queuedSinceIso: instantToIso(decision.queuedSince),
      maxStalenessSeconds: decision.maxStalenessSeconds,
    }
  }

  return {
    kind: 'queue',
    reason: decision.reason,
    releaseAtIso: instantToIso(decision.releaseAt),
  }
}

function unevaluable(evaluator: GateEvaluatorName, detail: string): GateDecision {
  return { kind: 'unevaluable', reason: 'blocked_unevaluable', evaluator, detail }
}
