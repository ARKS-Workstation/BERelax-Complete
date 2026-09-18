/**
 * The promotional compliance gate: code, not settings, and it fails closed.
 *
 * ## Why every check here is a function and not a toggle
 *
 * Consent, suppression, the weekly frequency cap and the 07:00–21:00 Asia/Dubai window are the four
 * things TDRA can suspend a sender ID over, and the practical sanction is suspension rather than a
 * fine (docs/04 §5). A settings page that can switch any of them off is a page somebody uses at 2am
 * to get a campaign out. So the rules live in this module as code; what is configurable is *bounded*
 * — the window may be narrowed inside 07:00–21:00 by the owner and audited, and nothing more. See
 * `assertPromotionalWindowChange` below and ADR 0016.
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
import { assertRoleMayEdit, getDefinition, validateSetting } from '@berelax/config'
import {
  ASIA_DUBAI,
  fromLocal,
  type Instant,
  instantToIso,
  type LocalDate,
  type LocalDateTime,
  localDate,
  localTime,
  minutesSinceMidnight,
  type TimeZone,
  toLocal,
} from '@berelax/core'
import { AppError } from '@berelax/shared'
import type { OutboundMessage } from './port.ts'

/** Hours of the day, in the business timezone, that promotional traffic may leave in. */
export interface PromotionalWindow {
  /** Inclusive. */
  readonly startHour: number
  /** Exclusive, so 21 means "nothing after 20:59". */
  readonly endHour: number
}

export const PROMOTIONAL_WINDOW_SETTING_KEY = 'messaging.promotional_window'

function isWindowShape(value: unknown): value is PromotionalWindow {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Record<keyof PromotionalWindow, unknown>>
  return typeof candidate.startHour === 'number' && typeof candidate.endHour === 'number'
}

/**
 * Reads a proposed window, rejecting anything that is not one.
 *
 * `null`, `false` and `'off'` all arrive here from the same intention — switching quiet hours off —
 * and all three are refused by shape before the bounded ranges in the settings registry are even
 * consulted.
 */
export function asPromotionalWindow(value: unknown): PromotionalWindow {
  if (!isWindowShape(value)) {
    throw new AppError(
      'validation',
      'The promotional send window must be an object with startHour and endHour. It cannot be ' +
        'switched off, set to null or set to "off": outside 07:00-21:00 Asia/Dubai a promotional ' +
        'SMS is a TDRA breach whose practical sanction is sender-ID suspension.',
      { userFacing: true, details: { key: PROMOTIONAL_WINDOW_SETTING_KEY, value } },
    )
  }
  // The registry owns the bounded ranges, so the hours cannot drift from what the admin panel
  // accepts.
  validateSetting(PROMOTIONAL_WINDOW_SETTING_KEY, value)
  return { startHour: value.startHour, endHour: value.endHour }
}

/**
 * The window as TDRA restricts it, read from the settings registry rather than copied.
 *
 * Copying `07:00-21:00` into this module would let the gate and the admin panel disagree, and the
 * symptom of that disagreement is a message sent at 21:30 that every screen says was compliant.
 */
export const TDRA_PROMOTIONAL_WINDOW: PromotionalWindow = asPromotionalWindow(
  getDefinition(PROMOTIONAL_WINDOW_SETTING_KEY).defaultValue,
)

/**
 * Validates a change to the window, and who is making it.
 *
 * Narrowing is accepted: an owner who wants promotional traffic confined to 09:00–20:00 is being
 * stricter than the regulator, which is always allowed. Widening is refused, and so is a window with
 * no hours in it — both are how "disable quiet hours" is actually spelled in a change request.
 *
 * The role check comes first because the setting is compliance-locked: a manager cannot touch it at
 * all, and finding that out only after the value validated would let the admin panel show a
 * validation error where the honest answer is "not you".
 */
export function assertPromotionalWindowChange(args: {
  readonly proposed: unknown
  readonly role: string
}): PromotionalWindow {
  assertRoleMayEdit(PROMOTIONAL_WINDOW_SETTING_KEY, args.role)
  const proposed = asPromotionalWindow(args.proposed)

  if (proposed.startHour >= proposed.endHour) {
    throw new AppError(
      'validation',
      `A promotional window of ${hourLabel(proposed.startHour)}-${hourLabel(proposed.endHour)} ` +
        'never opens. That is not a narrowing of the window, it is a different rule with no hours ' +
        'in it; disable the campaign instead.',
      { userFacing: true, details: { proposed } },
    )
  }

  const ceiling = TDRA_PROMOTIONAL_WINDOW
  if (proposed.startHour < ceiling.startHour || proposed.endHour > ceiling.endHour) {
    throw new AppError(
      'forbidden',
      `The promotional window may only be narrowed inside ` +
        `${hourLabel(ceiling.startHour)}-${hourLabel(ceiling.endHour)} Asia/Dubai, never widened ` +
        `to ${hourLabel(proposed.startHour)}-${hourLabel(proposed.endHour)}. Widening it to the ` +
        'full day is how quiet hours get disabled, and quiet hours a manager can disable are not ' +
        'quiet hours.',
      { userFacing: true, details: { proposed, ceiling } },
    )
  }

  return proposed
}

const hourLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00`

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
   * setting behind it, and the window itself is the code rule above. A clock that cannot answer is
   * the third way quiet hours become unevaluable, alongside an unreachable consent store and an
   * unreachable suppression list.
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

/** True when the instant's wall-clock time in the business zone is inside the window. */
export function withinPromotionalWindow(local: LocalDateTime, window: PromotionalWindow): boolean {
  const minutes = minutesSinceMidnight(local.time)
  return minutes >= window.startHour * 60 && minutes < window.endHour * 60
}

/**
 * The next instant the window opens.
 *
 * Trading runs 11:00–02:00, so the interesting case is 01:00: inside trading hours, outside the
 * promotional window, and the next opening is 07:00 the *same* calendar day rather than the next.
 */
export function nextPromotionalWindowOpen(
  local: LocalDateTime,
  window: PromotionalWindow,
  zone: TimeZone = ASIA_DUBAI,
): Instant {
  const openAt = localTime(hourLabel(window.startHour))
  const alreadyOpenedToday = minutesSinceMidnight(local.time) >= window.startHour * 60
  return fromLocal(alreadyOpenedToday ? nextDay(local.date) : local.date, openAt, zone)
}

function nextDay(date: LocalDate): LocalDate {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return localDate(next.toISOString().slice(0, 10))
}

/**
 * The gate. Order matters and is asserted:
 *
 * 1. transactional traffic is out of scope entirely;
 * 2. the marketing kill switch, before any store is read, so a stopped campaign reads nothing;
 * 3. consent, suppression, frequency cap — each failing closed;
 * 4. the window, which queues rather than refuses, because a promotional message at 01:00 is not
 *    wrong, it is early.
 */
export function evaluateGate(
  ctx: GateContext,
  message: OutboundMessage,
  instant: Instant,
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

  if (withinPromotionalWindow(local, ctx.promotionalWindow)) return ALLOW

  return {
    kind: 'queue',
    reason: 'queued_for_window',
    releaseAtIso: instantToIso(nextPromotionalWindowOpen(local, ctx.promotionalWindow, zone)),
  }
}

function unevaluable(evaluator: GateEvaluatorName, detail: string): GateDecision {
  return { kind: 'unevaluable', reason: 'blocked_unevaluable', evaluator, detail }
}
