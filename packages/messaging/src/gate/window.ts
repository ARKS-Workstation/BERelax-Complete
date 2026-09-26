/**
 * The promotional window as the gate sees it: the setting, its bounded change rule, and the send decision.
 *
 * ## Why this file exists separately from the gate
 *
 * Two of the three things here are about a SETTING rather than about a send — reading the ceiling out of
 * the registry, and refusing a change to it that is not a narrowing — and they are consumed by the admin
 * surface as well as by the choke point. The third, {@link decideSendWindow}, is the send decision, and it
 * is a thin adaptor over `decidePromotionalWindow` in `@berelax/core`: the RULE is pure and lives there,
 * where it can be driven over a cross product with no clock and no provider, and what is left here is the
 * part that needs `@berelax/config` — which `packages/core` may not import.
 *
 * ## Why the ceiling is read and never written down
 *
 * `TDRA_PROMOTIONAL_WINDOW` comes from `messaging.promotional_window`'s registry default. Copying
 * `07:00-21:00` into this module would let the gate and the admin panel disagree, and the symptom of that
 * disagreement is a message sent at 21:30 that every screen says was compliant. `@berelax/core`'s rule
 * takes the ceiling as an argument for the same reason, from the other side of the boundary.
 *
 * ## The three layers that make the window unswitchable
 *
 * The frequency cap's arrangement in migration 0080, applied to the window, because the failure is the
 * same one — somebody at 2am who wants a campaign out:
 *
 *   1. {@link assertPromotionalWindowChange} refuses `null`, `false` and `'off'` BY SHAPE before any range
 *      is consulted — those are the three ways "switch quiet hours off" is actually spelled — then refuses
 *      a window that never opens, then one outside the ceiling, each with the sentence that says why;
 *   2. the registry's zod schema bounds the hours inside the ceiling, so the ADMIN PANEL refuses a widening
 *      too, and so does anything writing the row through `writeSetting` without coming through this module;
 *   3. `promotional_window_is_a_narrowing()` in migration 0087 refuses the same values in the database, so
 *      the refusal holds for a `psql` session and under `session_replication_role = replica`.
 *
 * Three layers is not belt-and-braces. Each one is the only layer that holds against a different route in:
 * a `PATCH` from the admin API, a seed or import that writes the setting directly, and a hand-edited row.
 *
 * The ORDER within layer 1 is deliberate and cost a red test to get right: the schema check runs LAST, not
 * first, because zod reports "endHour: expected <= 21" where this module names the ceiling, the role and why
 * widening it is how quiet hours get disabled. Validating first made the worse sentence win for every
 * widening. See {@link assertPromotionalWindowChange}.
 */
import { assertRoleMayEdit, getDefinition, validateSetting } from '@berelax/config'
import {
  ASIA_DUBAI,
  type DatedPromotionalOverride,
  decidePromotionalWindow,
  type Instant,
  type LocalDateTime,
  MAX_QUEUED_PROMOTIONAL_STALENESS_SECONDS,
  nextPromotionalOpen,
  type PromotionalWindowDecision,
  type TimeZone,
  withinPromotionalHours,
} from '@berelax/core'
import { AppError, type MessageClass } from '@berelax/shared'

export type { DatedPromotionalOverride }

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
function readWindowShape(value: unknown): PromotionalWindow {
  if (!isWindowShape(value)) {
    throw new AppError(
      'validation',
      'The promotional send window must be an object with startHour and endHour. It cannot be ' +
        'switched off, set to null or set to "off": outside 07:00-21:00 Asia/Dubai a promotional ' +
        'SMS is a TDRA breach whose practical sanction is sender-ID suspension.',
      { userFacing: true, details: { key: PROMOTIONAL_WINDOW_SETTING_KEY, value } },
    )
  }
  return { startHour: value.startHour, endHour: value.endHour }
}

export function asPromotionalWindow(value: unknown): PromotionalWindow {
  const window = readWindowShape(value)
  // The registry owns the bounded ranges, so the hours cannot drift from what the admin panel
  // accepts.
  validateSetting(PROMOTIONAL_WINDOW_SETTING_KEY, value)
  return window
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
  // The SHAPE first, then this function's own two refusals, and the registry schema LAST.
  //
  // The order is about which sentence a person reads. C-AUTO-04 bounded the registry schema inside
  // 07:00-21:00 as well, which is right — it is what makes the admin panel refuse a widening — but zod
  // reports "startHour: expected >= 7" where this function reports the ceiling, the role and why widening
  // it is how quiet hours get disabled. Validating first made the schema's message win for every widening,
  // and `send.test.ts`'s "refuses the widening that disables quiet hours" caught it. So the explanatory
  // refusals come first and the schema is the final layer rather than the first: a value that passes both
  // checks below is still schema-validated, so a fractional hour is refused even though it is inside the
  // ceiling and does open.
  const proposed = readWindowShape(args.proposed)

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

  validateSetting(PROMOTIONAL_WINDOW_SETTING_KEY, args.proposed)
  return proposed
}

const hourLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00`

/** True when the instant's wall-clock time in the business zone is inside the window. */
export function withinPromotionalWindow(local: LocalDateTime, window: PromotionalWindow): boolean {
  return withinPromotionalHours(local, window)
}

/**
 * The next instant the window opens.
 *
 * Trading runs 11:00–02:00, so the interesting case is 01:00: inside trading hours, outside the
 * promotional window, and the next opening is 07:00 the *same* calendar day rather than the next.
 *
 * Kept as a named export because the campaign scheduler (C-AUTO-10) and the interpreter (C-AUTO-07) both
 * need the release instant without taking a send decision, and a second implementation of "when does it
 * next open" is a second answer to the question the gate is about.
 */
export function nextPromotionalWindowOpen(
  local: LocalDateTime,
  window: PromotionalWindow,
  zone: TimeZone = ASIA_DUBAI,
  overrides?: readonly DatedPromotionalOverride[],
): Instant {
  return nextPromotionalOpen({
    local,
    ceiling: window,
    zone,
    ...(overrides === undefined ? {} : { overrides }),
  })
}

/** What the gate hands the window rule about one send attempt. */
export interface SendWindowQuestion {
  readonly messageClass: MessageClass
  readonly at: Instant
  readonly local: LocalDateTime
  readonly zone: TimeZone
  readonly window: PromotionalWindow
  readonly overrides?: readonly DatedPromotionalOverride[] | undefined
  /** When this message was first held, for a release attempt. Absent for a first attempt. */
  readonly queuedSince?: Instant | undefined
  readonly maxStalenessSeconds?: number | undefined
}

/**
 * The window decision for one send, delegated whole to `@berelax/core`.
 *
 * A one-line adaptor on purpose. The alternative — the gate deciding here and core deciding for the
 * scheduler — is two implementations of quiet hours, which is the failure C-AUTO-07's acceptance line
 * ("the interpreter contains no window logic of its own") is written against. There is one rule and every
 * caller reaches it through this or through core directly.
 */
export function decideSendWindow(question: SendWindowQuestion): PromotionalWindowDecision {
  return decidePromotionalWindow({
    messageClass: question.messageClass,
    at: question.at,
    local: question.local,
    zone: question.zone,
    ceiling: question.window,
    overrides: question.overrides,
    queuedSince: question.queuedSince,
    maxStalenessSeconds: question.maxStalenessSeconds,
  })
}

export { MAX_QUEUED_PROMOTIONAL_STALENESS_SECONDS }
