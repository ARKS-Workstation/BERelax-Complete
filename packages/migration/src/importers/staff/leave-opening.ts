import { AppError } from '@berelax/shared'

/**
 * What a reconstructed leave opening balance has to SAY about itself, and the one conversion nobody may
 * make.
 *
 * ## The question this module exists to refuse to answer
 *
 * A previous arrangement's spreadsheet says somebody has fourteen days of leave left. Fourteen of what?
 *
 * `0066_leave.sql` settled that the statutory entitlement is counted in CALENDAR days ("a leave day is a
 * calendar day, never a working day") and `leave_movement.hundredths` is in those units throughout the
 * ledger. Nothing here changes that. But `0092_leave_approval.sql` settled something else, about the same
 * day seen from the other end: `ZY020` refuses a leave period bounded by a midnight that falls inside a
 * trading session, because trading runs 11:00 to 02:00 and *"a leave day aligned to the CALENDAR starts
 * in the middle of the previous session and leaves its last two hours rostered — the therapist is still
 * bookable for a 01:30 treatment on a day they are on leave for."*
 *
 * So every day of that fourteen will be SPENT as a session. This business opens on every date, so the two
 * readings are the same quantity today and there is no conversion to apply — which is exactly why the
 * cell matters: if there were a conversion, somebody would notice it was missing. There is not, so the
 * only thing that can go wrong is that nobody ever checked, and the figure then quietly becomes wrong the
 * first time a date in the leave year is not a trading day.
 *
 * The basis cell is therefore a CONFIRMATION and not an arithmetic input, and that is the whole of this
 * module: {@link LEAVE_BASES} is the closed set, `trading_session_day` is the confirmation, `calendar_day`
 * is the honest admission that nobody has checked, and the second quarantines the line. The migration's
 * own refusal (ZY371) names, from `business_day`, how many dates of the covering leave year the business
 * does not trade — zero means the readings coincide and the cell is the confirmation nobody has given,
 * and above zero means they are different numbers and the old records do not say which was meant.
 *
 * ## Why a calendar-day line is quarantined WHOLE, and not imported without its balance
 *
 * The employment record, the skills and the credential expiries on that line are perfectly good, so
 * importing the person and leaving the leave balance out is tempting. It produces the exact failure
 * `ZY372` exists to refuse, reached the long way round: an employee with no `opening_balance` movement
 * has a balance of zero by construction, accrual then runs forward from zero, and nothing is marked
 * provisional because no row was written to mark. A quarantined line is visibly unanswered; an employee
 * with a silent zero is not.
 *
 * ## Hundredths and not days
 *
 * The cell is whole day-hundredths — 250 is 2.5 days — for ADR 0007's reason one subject along. A
 * decimal cell in a spreadsheet is how `Number('2.50')` becomes 2 and a balance ends up a hundred times
 * too small, which is the defect H-MIG-05 found in its own price column. `wholeOrNaN` is shared with that
 * importer rather than restated here.
 */

/** The two things an imported balance can say it counted. A closed set, mirrored by a CHECK in 0131. */
export const LEAVE_BASES = {
  /** Each day of the balance has been confirmed to be a day this business rosters. Accepted. */
  tradingSessionDay: 'trading_session_day',
  /** Nobody has checked. Quarantined by name; ZY371 is the refusal behind it. */
  calendarDay: 'calendar_day',
} as const

export type LeaveBasis = (typeof LEAVE_BASES)[keyof typeof LEAVE_BASES]

export const LEAVE_BASIS_VALUES: readonly LeaveBasis[] = Object.freeze(Object.values(LEAVE_BASES))

export const isLeaveBasis = (value: unknown): value is LeaveBasis =>
  typeof value === 'string' && (LEAVE_BASIS_VALUES as readonly string[]).includes(value)

/**
 * The leave-year anchor, injected.
 *
 * `leaveYearStart()` lives in `@berelax/core` and `packages/migration` may not import it (H-MIG-01 states
 * the constraint and gives the reason: there is no calculation in this package, and the importer that
 * needs one takes the answer as an argument). `leave_movement.leaveYearStart`'s own comment says why it
 * may not be re-derived in SQL either — "a second reading of that policy which disagrees for every
 * employee not engaged on 1 January" — so the one implementation is reached from the door script and
 * handed in, which is the same seam `decideAppointmentTransition` crosses for the lifecycle.
 *
 * There is deliberately no default. An identity function, or "1 January of the as-at year", would anchor
 * every balance to a leave year the policy does not use, and the symptom would be a carry-over forfeited
 * on the wrong date — months later, in a job nobody was watching.
 */
export type LeaveYearAnchor = (args: {
  readonly startsOnAnniversary: boolean
  readonly employedFrom: string
  readonly on: string
}) => string

/** A date in `YYYY-MM-DD`, which is the only form every cell of this file uses. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** `YYYY-MM-DD` that is also a real date — `2026-02-30` matches the shape and is not a day. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** One `type=YYYY-MM-DD` pair of the `credential_expiries` cell, or a named reason it is not one. */
export type CredentialCell =
  | { readonly ok: true; readonly documentType: string; readonly expiresOn: string }
  | { readonly ok: false }

/**
 * Splits one credential pair.
 *
 * It judges the SHAPE and never the vocabulary: which document types exist is
 * `regulatory_profile_current`'s, read inside the transaction, and naming them here would be a second
 * list for that one to disagree with — the same division `import.ts` keeps between its rejections and
 * `@berelax/db`'s quarantines.
 */
export function readCredentialCell(cell: string): CredentialCell {
  const at = cell.indexOf('=')
  if (at <= 0) return { ok: false }
  const documentType = cell.slice(0, at).trim()
  const expiresOn = cell.slice(at + 1).trim()
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(documentType)) return { ok: false }
  if (!isIsoDate(expiresOn)) return { ok: false }
  return { ok: true, documentType, expiresOn }
}

/**
 * Asserts an anchor was injected, by name.
 *
 * Called at the point the plan is built rather than where the value is first needed, which is H-MIG-04's
 * arrangement for the normaliser and for its reason: the failure has to name the wiring that is missing,
 * not the row that happened to be first.
 */
export function assertLeaveYearAnchor(anchor: unknown): asserts anchor is LeaveYearAnchor {
  if (typeof anchor === 'function') return
  throw new AppError(
    'invariant_violated',
    'No leave-year anchor was injected, so nothing could say which leave year an imported balance opens. ' +
      'Wire `leaveYearStart` from @berelax/core. There is no fallback on purpose: anchoring every ' +
      'balance to 1 January would be a leave year the policy does not use for anybody not engaged on ' +
      'that date, and the symptom is a carry-over forfeited on the wrong day, months later, in a job ' +
      'nobody is watching.',
  )
}
