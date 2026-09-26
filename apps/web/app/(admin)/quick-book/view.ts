import type { AdminChrome } from '../../../src/components/admin/google-reauth-banner.ts'

/**
 * The quick-book screen's view type and its vocabularies (B-UI-04).
 *
 * A module of its own so `render.ts` stays pure HTML and `handler.ts` stays the decisions, and so the two
 * cannot disagree about a field name: the form names, the refusal names and the sentence for each refusal
 * are declared once here and read by both.
 *
 * ## Why the sentences are here and not in the handler
 *
 * The same reason the pipeline board gives. The repository's message explains a decision to whoever reads a
 * log; these tell somebody at a front desk what just happened and what to do about it. And every refusal
 * has to be reproducible from its NAME alone, because the name is what survives being carried between two
 * POSTs — a sentence assembled in one place and a sentence assembled in another is two wordings for one
 * outcome.
 */

/** The form field names. One spelling each, read by the render, the handler and the browser suite. */
export const QUICK_BOOK_FIELDS = {
  /** `check` or `confirm`. A field rather than a path: one handler, one place the body is parsed. */
  step: 'step',
  phone: 'phone',
  /** The WhatsApp ref code. The first OPTIONAL field in DOM order — see `render.ts`. */
  ref: 'ref',
  variant: 'variant',
  gender: 'gender',
  start: 'start',
  notes: 'notes',
  /** The override the desk asked for, or empty for "whoever the solver chose". */
  therapist: 'therapist',
  /** The room the check displayed, carried to the confirm so the booking is the tuple that was shown. */
  room: 'room',
  /** Each therapist the check displayed, repeated once per therapist for a Four Hands or a Couple. */
  assigned: 'assigned',
} as const

export const QUICK_BOOK_PATH = '/quick-book'

export type RenderDirection = 'ltr' | 'rtl'

/**
 * Why a check or a confirm was refused.
 *
 * Named values and never prose, for the reason `pipelineRefusalOf` records: the UI branches on these, the
 * log records these, and a sentence is a thing anybody can put in a query string.
 */
export const QUICK_BOOK_REFUSALS = [
  /** The body was not something this screen could have sent. */
  'unreadable_request',
  /** `normalisePhone` refused the number, or it is not a mobile that can be booked against. */
  'phone_not_eligible',
  /** The variant id names no published, priced treatment. */
  'unknown_treatment',
  /** The start is not an instant, or not one this screen offered for that treatment. */
  'start_not_offered',
  /**
   * The start was offered when the check was made and the clock has since passed it.
   *
   * A refusal of its own and NOT `start_not_offered`, because the two send the desk to different places. A
   * start this screen never offered means "choose from the list"; a start that has passed means "the list has
   * moved on, check again" — and with no minimum notice at the counter the first grid option can be one
   * minute away, so a desk that reads out an assignment and then confirms is the ordinary case rather than an
   * edge one. Telling them they picked something that was never offered would be false.
   */
  'start_has_passed',
  /** The premises does not trade at that instant, so there is no trading date to book against. */
  'not_a_trading_date',
  /** The engine offered nothing at that start: no therapist, no room, or both. */
  'no_assignment',
  /** A therapist was named who may not take it. `therapistReason` says which of the reasons it is. */
  'therapist_not_eligible',
  /** The tuple the check displayed is no longer deliverable. Somebody else took it in between. */
  'slot_taken',
  /** The client's gender was not stated, which strict same-gender matching refuses outright. */
  'requires_client_gender',
  /** The booking endpoint refused for a reason this screen does not have its own wording for. */
  'booking_refused',
] as const
export type QuickBookRefusal = (typeof QUICK_BOOK_REFUSALS)[number]

/**
 * The four reasons the acceptance line names, plus the fifth that is not an eligibility question at all.
 *
 * `gender_mismatch`, `missing_skill`, `credential_expired` and `not_rostered` are `EligibilityExclusionReason`
 * values and come from the read model rather than from anything decided here. `not_free_at_that_start` is
 * this screen's, and it is deliberately separate: a therapist who is eligible and simply busy is not
 * ineligible, and reporting "off shift" for somebody who is on shift with a client would send the desk to
 * fix a rota that is correct. The other three eligibility reasons the read model can produce —
 * `not_employed`, `credential_missing` and `on_approved_leave` — are carried through as themselves rather
 * than folded into these, because folding them would tell the desk to do the wrong thing too.
 */
export const THERAPIST_REFUSAL_REASONS = [
  'not_employed',
  'missing_skill',
  'credential_missing',
  'credential_expired',
  'not_rostered',
  'on_approved_leave',
  'gender_mismatch',
  'not_free_at_that_start',
  'reason_not_recognised',
] as const
export type TherapistRefusalReason = (typeof THERAPIST_REFUSAL_REASONS)[number]

/**
 * What the screen says for each reason, as a table.
 *
 * A table and not a conditional, because a `Record` over the union makes a reason added to the read model
 * without a wording here a `pnpm typecheck` failure rather than a blank cell at a front desk. Each sentence
 * names the REMEDY, because that is the only thing the desk can act on: a renewal, a training record, a
 * rota edit, another time, or nothing at all.
 */
const THERAPIST_REFUSAL_SENTENCES: Readonly<Record<TherapistRefusalReason, string>> = {
  not_employed: 'they are not employed on this trading date. Nothing about today can change that.',
  missing_skill:
    'they do not hold the skill this treatment’s style requires. That is a training record, not a rota ' +
    'edit.',
  credential_missing:
    'a mandatory document has no row on file at all. An empty file is not permission — it is treated ' +
    'exactly as an expired one.',
  credential_expired:
    'a mandatory document has expired. It is a renewal, and the therapist is unbookable until it is on ' +
    'file.',
  not_rostered: 'they are not on shift on this trading date. That is a rota edit.',
  on_approved_leave: 'approved leave covers every rostered minute of this date.',
  // Deliberately says nothing about the therapist. It is not a question about them — the same person is
  // eligible for the next client — and there is no renewal, rota edit or training record that answers it.
  gender_mismatch:
    'same-gender matching does not allow this pairing. It is not a fact about the therapist: they are ' +
    'available for the next client.',
  not_free_at_that_start:
    'they are eligible and already have work over this period. Another time, or somebody else.',
  /*
    The reason the read model gave is one this screen has no wording for.

    It exists because `AvailabilityAnswer.excluded[].reason` is a plain `string` — it comes straight out of
    the SQL `case` and is NOT passed through `exclusionReasonFrom`, so a reason added to the query and not
    here reaches this table as an unknown value. The alternative was a `??` fallback onto one of the real
    reasons, which is what this file first did: it would have told the desk to fix a rota for a therapist
    whose rota is correct, which is worse than saying nothing, and is the quiet-wrong-answer shape this
    repository keeps paying for. Saying so out loud is the honest answer and is actionable in the one way it
    can be — somebody looks at the code.
  */
  reason_not_recognised:
    'the availability engine gave a reason this screen does not recognise. The therapist is not bookable ' +
    'for this treatment and the reason needs looking at in the code rather than at the desk.',
}

export function therapistRefusalSentence(reason: TherapistRefusalReason): string {
  return THERAPIST_REFUSAL_SENTENCES[reason]
}

/** What the ref field produced, when it produced something worth saying. */
export const REF_NOTICES = ['unknown_code', 'matched'] as const
export type RefNotice = (typeof REF_NOTICES)[number]

const REF_NOTICE_SENTENCES: Readonly<Record<RefNotice, string>> = {
  // The wording is the whole of "accepts an unknown code with a visible warning without blocking". It says
  // what happened, what it means for the record, and that the booking is unaffected — in that order,
  // because the third is the thing the desk needs to know before they decide whether to retype.
  unknown_code:
    'That ref code is not one we hold. The booking is not affected and can be confirmed. The attribution ' +
    'is recorded as unknown rather than guessed, and what was typed is kept so it can be matched if the ' +
    'code is issued later.',
  matched: 'That ref code matches a WhatsApp conversation. The booking will be attributed to it.',
}

export function refNoticeSentence(notice: RefNotice): string {
  return REF_NOTICE_SENTENCES[notice]
}

/** One priced duration, as the treatment select offers it. */
export interface QuickBookVariant {
  readonly serviceVariantId: string
  /** Style, treatment, duration and price in one string, which is what a type-ahead select searches. */
  readonly label: string
}

/**
 * One offerable start, with every treatment it is offerable FOR.
 *
 * One option per instant and not one per (treatment, instant) pair, which is a correctness property and not
 * a size optimisation. The first version emitted a pair per option, so the same clock time appeared once per
 * treatment with the SAME `value` — and a select with duplicate values cannot be set by value: the browser
 * takes the first match, which after narrowing is a disabled option belonging to another treatment, and the
 * field ends up empty. It presented as a check refused for no reason anybody could see.
 *
 * So the value is unique, and which treatments the instant suits — the grid is cut at the trading day's close
 * less each treatment's own duration, so a late start suits a 45-minute treatment and not a 120-minute one —
 * is carried as a list the narrowing script and the server both read.
 */
export interface QuickBookStart {
  /** The ISO instant. The server computed it; no browser turns a label back into a time (B-UI-03). */
  readonly value: string
  readonly label: string
  /** Every treatment this instant is offerable for. Never empty: an option no treatment suits is absent. */
  readonly serviceVariantIds: readonly string[]
}

/** A therapist, labelled the only way ADR 0020 allows: an internal reference, never an invented name. */
export interface QuickBookTherapist {
  readonly therapistId: string
  /** `Therapist 07`. An internal handle, and the only label a therapist has until an admin sets one. */
  readonly reference: string
}

export interface QuickBookExclusion extends QuickBookTherapist {
  readonly reason: TherapistRefusalReason
  readonly sentence: string
}

/** The assignment the solver made, as the check displays it. Nothing here is the desk's choice. */
export interface QuickBookAssignment {
  readonly treatmentLabel: string
  readonly startLabel: string
  readonly roomId: string
  readonly roomLabel: string
  readonly therapists: readonly QuickBookTherapist[]
  readonly priceLabel: string
  /** Everyone else the engine found free for this start. Empty means no override is offered. */
  readonly alternatives: readonly QuickBookTherapist[]
  /** Everyone the read model removed, with the reason. Read off the answer; costs no extra query. */
  readonly excluded: readonly QuickBookExclusion[]
}

export interface QuickBookBooked extends Omit<QuickBookAssignment, 'alternatives' | 'excluded'> {
  readonly bookingId: string
  /** The capture outcome, as `whatsapp_ref_capture_outcome` spells it. */
  readonly captureOutcome: string
  /** What that outcome means, in words. `unknown` is printed, never left blank. */
  readonly captureLabel: string
}

/** The form's values, echoed back so a refusal never throws away what the desk typed. */
export interface QuickBookForm {
  readonly phone: string
  readonly ref: string
  readonly variant: string
  readonly gender: string
  readonly start: string
  readonly notes: string
  readonly therapist: string
}

export interface QuickBookRefused {
  readonly name: QuickBookRefusal
  readonly sentence: string
  /** Set for `therapist_not_eligible` alone, and it is the specific reason code. */
  readonly therapistReason: TherapistRefusalReason | null
}

export interface QuickBookRateView {
  readonly matched: number
  readonly unknownCode: number
  readonly notOffered: number
  readonly total: number
  readonly claim: string
  /** The sentence for the claim. A rate is never printed as a bare percentage — see `refCaptureRate`. */
  readonly sentence: string
  readonly openQuestionId: string | null
}

/** One provisional value this screen stands on, and the question that settles it. */
export interface QuickBookAssumption {
  readonly what: string
  readonly openQuestionId: string
}

export interface QuickBookView {
  /**
   * The Google re-auth banner and the page a reconnect comes back to (G-CONN-08).
   *
   * Required rather than optional, for the reason the pipeline board and the duplicate queue both state: an
   * optional field is a permissive default, and the default would be the one state this banner exists to
   * make impossible — an admin page that says nothing while the Google grant is dead.
   */
  readonly chrome: AdminChrome
  readonly direction: RenderDirection
  /** Where every form posts. A field rather than a literal so the render never spells a path. */
  readonly action: string
  readonly dayLabel: string
  readonly lede: string
  readonly announcement: string
  readonly phoneHint: string
  readonly refHint: string
  readonly refCodePattern: string
  readonly refCodeLength: number
  readonly genderWhy: string
  readonly startHint: string
  readonly variants: readonly QuickBookVariant[]
  readonly starts: readonly QuickBookStart[]
  readonly form: QuickBookForm
  readonly checked: QuickBookAssignment | null
  readonly booked: QuickBookBooked | null
  readonly refusal: QuickBookRefused | null
  readonly refNotice: RefNotice | null
  readonly rate: QuickBookRateView
  readonly assumptions: readonly QuickBookAssumption[]
}
