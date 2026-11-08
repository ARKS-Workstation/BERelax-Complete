import type { BackdatedOutcome, BackdatedRefusal } from '@berelax/core'
import type { AdminChrome } from '../../../src/components/admin/google-reauth-banner.ts'

/**
 * `/record-visit` — the visit that happened and was never entered, as a view.
 *
 * ## Why this is not a page of `/quick-book`
 *
 * `/quick-book` is an availability screen. Every start it offers comes from `queryAvailability`, which
 * filters the grid against the desk's lead time from *now*; its confirm step goes through
 * `handleBookingRequest`, which is the one booking endpoint and is about a promise the salon has still to
 * keep. None of that applies to a treatment already delivered — "was this therapist free at 19:00
 * yesterday" is answered by what they actually did, not by a solver — so a `step=past` on that screen
 * would be a second code path wearing the first one's clothes, sharing its name and almost none of its
 * rules.
 *
 * What the two DO share is the lookups that are about the catalogue rather than the calendar: the variant's
 * duration, the trading date that owns an instant, and the price. Those are `resolveDeliveryInput` in the
 * bookings handler, called by both, so the two screens cannot disagree about how long a treatment is or
 * what it cost.
 *
 * ## Two POSTs, for the reason quick-book gives and one of its own
 *
 * `step=check` resolves and shows — the trading date, the price, who was rostered that day, the rooms —
 * and `step=record` writes the tuple that was shown. Quick-book's argument holds here (an assignment the
 * desk can read before a row exists), and backdating adds a second: the therapist list is a list of who
 * was ON SHIFT on a date in the past, which is a fact the desk cannot be expected to remember and which no
 * single-step form could show them.
 *
 * Neither step needs JavaScript, and there is no inline script on this screen at all. Quick-book's one
 * script narrows a start list against a chosen treatment; here the start is typed, so there is nothing to
 * narrow.
 */

export const RECORD_VISIT_PATH = '/record-visit'

/**
 * The form field names, spelled once.
 *
 * `date` and `time` are two native inputs rather than one `datetime-local`, and that is a decision about
 * who uses this. A desk entering Friday's walk-in on Monday types a date they have to think about and a
 * time they were told; two labelled controls can each say what they want ("the day of the visit", "when it
 * started"), where one combined control has a single label that has to mean both. Both are native, both are
 * keyboard-operable, and both get the platform's own picker on a tablet.
 */
export const RECORD_VISIT_FIELDS = {
  step: 'step',
  phone: 'phone',
  variant: 'variant',
  gender: 'gender',
  date: 'date',
  time: 'time',
  outcome: 'outcome',
  reason: 'reason',
  notes: 'notes',
  therapist: 'therapist',
  room: 'room',
} as const

export interface RecordVisitForm {
  readonly step: string
  readonly phone: string
  readonly variant: string
  readonly gender: string
  readonly date: string
  readonly time: string
  readonly outcome: string
  readonly reason: string
  readonly notes: string
  readonly therapist: string
  readonly room: string
}

/**
 * Every way this screen refuses.
 *
 * Five of them are `BackdatedRefusal` re-spelled, and they are repeated rather than spread because this
 * list is the screen's vocabulary and `@berelax/core`'s is the policy's: a refusal the gate gains is not
 * automatically a sentence somebody has written, and a union that widened silently would render
 * `undefined` at the reader. `recordVisitRefusalFor` is the one mapping, and it is exhaustive by type.
 */
export const RECORD_VISIT_REFUSALS = [
  /** The POST did not parse, or named a `step` this screen does not serve. */
  'unreadable_request',
  /** The number is not a mobile this system can hold (ADR 0014's normalisation). */
  'phone_not_eligible',
  /** No treatment chosen, or one the catalogue does not sell. */
  'unknown_treatment',
  /** Who the treatment was for. Needed because B-AVAIL-05's same-gender rule is re-applied on the write. */
  'requires_client_gender',
  /** The date and time did not parse into an instant. */
  'start_unreadable',
  /** The outcome was neither `completed` nor `no_show`. */
  'unknown_outcome',
  // --- the policy gate, `backdatedVisitVerdict` ---------------------------------------------------
  'not_in_the_past',
  'beyond_the_horizon',
  'period_not_positive',
  'still_running',
  'outside_a_trading_session',
  // --- the catalogue and calendar lookups, `resolveDeliveryInput` --------------------------------
  /** No trading session owns the instant. The gate's `outside_a_trading_session` with the day's reason. */
  'outside_trading_hours',
  /** The variant has no price at all — a catalogue state, not a number this screen may invent. */
  'no_applicable_price',
  /** The catalogue does not say which skill the treatment's style needs, so nobody can be qualified. */
  'no_required_skill',
  // --- the money half ---------------------------------------------------------------------------
  /**
   * The trading date is inside a closed accounting period.
   *
   * The refusal the owner asked for in so many words. A completed treatment emits a revenue event, and a
   * revenue event dated into a month whose VAT has been filed is a restatement — so this refuses the whole
   * entry rather than writing the diary row and losing the money, which is the half-done state that is
   * worst to find later.
   */
  'period_closed',
  // --- the tuple the desk named ------------------------------------------------------------------
  'therapist_not_chosen',
  'room_not_chosen',
  /** `createBooking` or the transition machine refused. The reason is carried verbatim. */
  'write_refused',
] as const
export type RecordVisitRefusal = (typeof RECORD_VISIT_REFUSALS)[number]

export interface RecordVisitRefused {
  readonly name: RecordVisitRefusal
  readonly sentence: string
  /** The database's or the gate's own words, when there are any. Never shown as the whole answer. */
  readonly detail: string | null
}

/**
 * One sentence per refusal, in the words the person at the desk needs.
 *
 * Each says what to do next, because a refusal that only states a fact sends somebody to ask a manager.
 * The five policy refusals are separate sentences rather than one `invalid_period` for the reason
 * `backdated-visit.ts` records: "you typed next week", "you typed last year", "the client is still on the
 * table" and "we were closed then" need different answers at the counter.
 */
export const RECORD_VISIT_SENTENCES: Readonly<Record<RecordVisitRefusal, string>> = {
  unreadable_request:
    'That request could not be read. Start again from the form rather than reloading the page.',
  phone_not_eligible:
    'That is not a mobile number this system can hold. Check the digits and the country code.',
  unknown_treatment: 'Choose the treatment that was given.',
  requires_client_gender:
    'Say who the treatment was for. The same-gender rule is checked on the way in, exactly as it is for a ' +
    'live booking, and it cannot be checked without this.',
  start_unreadable: 'Enter the day of the visit and the time it started.',
  unknown_outcome: 'Say whether the treatment was given or the client did not arrive.',
  not_in_the_past:
    'That is in the future, which is a booking rather than a record of a visit. Use Quick book.',
  beyond_the_horizon:
    'That is further back than entries may reach. A manager can widen the window in Settings, or the ' +
    'visit can be entered by the accounts team as a correction.',
  period_not_positive:
    'The treatment cannot end before it starts. Check the time, and the treatment that was given.',
  still_running:
    'That treatment has not finished yet, so it cannot be recorded as given. Use the diary to check the ' +
    'client in, and record the outcome when they leave.',
  outside_a_trading_session: 'The salon was not open then. Check the day and the time.',
  outside_trading_hours: 'The salon was not open then. Check the day and the time.',
  no_applicable_price:
    'That treatment has no price on the day of the visit, so there is no figure to put in the books. ' +
    'Ask a manager to price it before recording the visit.',
  no_required_skill:
    'The catalogue does not say which qualification that treatment needs, so nobody can be shown to have ' +
    'been able to give it. Ask a manager.',
  period_closed:
    'That month has been closed, so nothing more may be posted into it. The visit has NOT been recorded. ' +
    'Pass it to the accounts team, who can post it as a correction into the open period.',
  therapist_not_chosen: 'Choose the therapist who gave the treatment.',
  room_not_chosen: 'Choose the room the treatment was given in.',
  write_refused:
    'The entry was refused and nothing has been written. The reason is below; most often it is that the ' +
    'therapist was not on shift then, or that they already have a treatment at that time.',
}

/**
 * Every `BackdatedRefusal` as this screen's own name.
 *
 * A `Record` and not a cast, so a refusal added to the gate is a compile error here rather than a blank
 * sentence on the screen — the whole reason the two vocabularies are written out separately.
 */
export const REFUSAL_FOR_VERDICT: Readonly<Record<BackdatedRefusal, RecordVisitRefusal>> = {
  not_in_the_past: 'not_in_the_past',
  beyond_the_horizon: 'beyond_the_horizon',
  period_not_positive: 'period_not_positive',
  still_running: 'still_running',
  outside_a_trading_session: 'outside_a_trading_session',
}

export function recordVisitRefused(
  name: RecordVisitRefusal,
  detail: string | null = null,
): RecordVisitRefused {
  return { name, sentence: RECORD_VISIT_SENTENCES[name], detail }
}

export interface RecordVisitVariant {
  readonly serviceVariantId: string
  readonly label: string
  readonly durationMinutes: number
}

export interface RecordVisitTherapist {
  readonly therapistId: string
  readonly reference: string
}

/** A therapist the roster read removed, and why. Shown, because "they are not in the list" is not an answer. */
export interface RecordVisitExclusion {
  readonly reference: string
  readonly reason: string
}

export interface RecordVisitRoom {
  readonly roomId: string
  readonly label: string
  readonly capacity: number
}

/** What `step=check` resolved: the facts, and the two lists the desk now picks from. */
export interface RecordVisitChecked {
  readonly tradingDate: string
  readonly startLabel: string
  readonly endLabel: string
  readonly priceLabel: string
  readonly outcome: BackdatedOutcome
  readonly therapists: readonly RecordVisitTherapist[]
  readonly excluded: readonly RecordVisitExclusion[]
  readonly rooms: readonly RecordVisitRoom[]
}

/** What `step=record` wrote. The appointment ids are shown so the entry can be found in the diary. */
export interface RecordVisitRecorded {
  readonly bookingId: string
  readonly appointmentIds: readonly string[]
  readonly tradingDate: string
  readonly outcome: BackdatedOutcome
  readonly startLabel: string
  readonly priceLabel: string
  /** Every lifecycle step walked, in order, as `checked_in → in_progress → completed`. */
  readonly walked: readonly string[]
}

export type RenderDirection = 'ltr' | 'rtl'

export interface RecordVisitView {
  readonly direction: RenderDirection
  readonly chrome: AdminChrome
  /** Echoed back so a refusal does not empty the form somebody has just filled in. */
  readonly form: RecordVisitForm
  readonly variants: readonly RecordVisitVariant[]
  /** From `app_setting`, and stated on the screen so the refusal is not the first time anybody sees it. */
  readonly horizonDays: number
  readonly announcement: string
  readonly refusal: RecordVisitRefused | null
  readonly checked: RecordVisitChecked | null
  readonly recorded: RecordVisitRecorded | null
}
