import {
  normaliseWhatsappRefCode,
  PROVISIONAL_WHATSAPP_REF_EXPECTED,
  WHATSAPP_REF_OPEN_QUESTION,
} from '@berelax/shared'

/**
 * What a booking's WhatsApp attribution IS, decided from what the desk typed and what the table holds.
 *
 * Pure, and in `@berelax/core` rather than beside the write, for the reason the whole package exists: this
 * is the rule, and the rule is the thing that must not have a second implementation. The quick-book handler
 * calls it; `packages/db` stores its answer under two CHECK constraints that say the same thing in SQL, so
 * a handler that tried to record a matched outcome with no code is refused by the database as well.
 *
 * ## The one rule, stated once
 *
 * **An attribution is recorded only when a code the desk typed equals a code the table holds.** Everything
 * else is *unknown*, and unknown has two spellings because the two are different conversations with the
 * front desk, not because they are different attributions:
 *
 *   - `not_offered` — the field was left blank. Nothing was claimed and nothing is wrong.
 *   - `unknown_code` — something was typed and it matched nothing. The booking is taken, a warning is
 *     shown, and what was typed is KEPT, because "the desk is pasting codes that we have no rows for" is
 *     a different defect from "the desk is not pasting codes" and only the stored text can tell them
 *     apart. A-FIRST not having written the row is the likeliest cause and is not the desk's mistake.
 *
 * There is deliberately no fourth outcome for *"the code looked plausible so we guessed"*. Y9-crm-source
 * settles the shape of this for the whole build — `unknown` is the default acquisition source "because it
 * is true of every record the business already has" — and Y12-ref-loop asks the question this module is
 * the answer to: if the front desk will not paste the code, attribution stops at the click, and it stops
 * *visibly*.
 *
 * ## Why a malformed code and a blank field are not the same outcome
 *
 * `normaliseWhatsappRefCode` answers `null` for both, which is correct for everything below this function
 * and wrong here: a page that reported "no code was given" when the operator had typed four characters
 * would be telling them their keystrokes went nowhere. So the raw value is an input as well as the
 * normalised one, and `trim().length` is what separates the two.
 */

/** The three outcomes, mirroring the `whatsapp_ref_capture_outcome` enum of migration 0079. */
export const REF_CAPTURE_OUTCOMES = ['matched', 'unknown_code', 'not_offered'] as const
export type RefCaptureOutcome = (typeof REF_CAPTURE_OUTCOMES)[number]

/** What the desk typed and what the table said about it. `matched` is the table's answer, never a guess. */
export interface RefCaptureInput {
  /** Exactly what was in the field, untouched. Blank, whitespace and malformed are all legitimate. */
  readonly entered: string
  /**
   * The code the ref table holds, when the normalised value matched a row, and `null` when it did not.
   *
   * A LOOKUP RESULT and not a predicate: the caller has already asked the database, and this function
   * cannot ask. That is what makes "an attribution is only ever a row that exists" structural rather than
   * a rule somebody has to keep remembering — there is no input here from which a match could be inferred.
   */
  readonly matchedRefCode: string | null
}

export interface RefCaptureDecision {
  readonly outcome: RefCaptureOutcome
  /** The attribution, or null. Non-null for `matched` alone; nothing else may carry one. */
  readonly refCode: string | null
  /** What was typed, kept for `unknown_code` alone. Null otherwise — including for a blank field. */
  readonly enteredCode: string | null
  /** True when the screen must show a warning. `unknown_code` only: a blank field is not a warning. */
  readonly warns: boolean
}

/**
 * The decision. Total over its input, and the three outcomes are mutually exclusive by construction.
 *
 * `matchedRefCode` wins over the shape test deliberately: if the caller found a row, the value is a code
 * whatever this function thinks of its shape, because the row's own CHECK constraint already proved the
 * shape. Re-deriving it here would be a second opinion about the alphabet, and the failure it produces is
 * the worst available one — a booking whose matched row is discarded and recorded as unknown.
 */
export function decideRefCapture(input: RefCaptureInput): RefCaptureDecision {
  if (input.matchedRefCode !== null) {
    return {
      outcome: 'matched',
      refCode: input.matchedRefCode,
      enteredCode: null,
      warns: false,
    }
  }
  const typed = input.entered.trim()
  if (typed.length === 0) {
    return { outcome: 'not_offered', refCode: null, enteredCode: null, warns: false }
  }
  // Normalised where it is a code and raw where it is not, so the stored text is comparable with
  // `whatsapp_ref.ref_code` when A-FIRST writes the row LATER — a code typed today and issued tomorrow is
  // the commonest way this state arises, and a lower-case copy of it would not join.
  return {
    outcome: 'unknown_code',
    refCode: null,
    enteredCode: normaliseWhatsappRefCode(typed) ?? typed,
    warns: true,
  }
}

/** The counts a capture rate is computed from. Every one of them a `count(*)`, never a running total. */
export interface RefCaptureCounts {
  readonly matched: number
  readonly unknownCode: number
  readonly notOffered: number
}

/**
 * What a capture rate is allowed to CLAIM, which is not the same question as what the rate is.
 *
 * Three values rather than a percentage plus a comment, because the percentage is the same number in all
 * three cases and only the claim differs:
 *
 *   - `no_bookings` — nothing has been taken, so there is no rate. Reported as such rather than as 0%,
 *     which is the arithmetic of an empty set presented as a finding.
 *   - `loop_unconfirmed` — bookings exist and nobody has said the desk is supposed to paste the code
 *     (Y12-ref-loop, `booking.whatsapp_ref_expected` false). The rate is reported and it is NOT a process
 *     failure. This is the "capture rate reported rather than assumed" half of the unit's own provisional
 *     note, and it is why the setting exists.
 *   - `measured` — the loop is confirmed, so the rate is a measurement of the desk.
 */
export const REF_CAPTURE_CLAIMS = ['no_bookings', 'loop_unconfirmed', 'measured'] as const
export type RefCaptureClaim = (typeof REF_CAPTURE_CLAIMS)[number]

export interface RefCaptureRate {
  readonly counts: RefCaptureCounts
  /** Every booking with a capture row. The denominator, stated so a reader never has to add three up. */
  readonly total: number
  /** Matched over total, in whole basis points. Null when there is nothing to divide by. */
  readonly capturedBp: number | null
  readonly claim: RefCaptureClaim
  /** The OPEN-QUESTIONS id, carried on every answer while the loop is unconfirmed. */
  readonly openQuestionId: string | null
}

/**
 * The rate, and the claim it is entitled to make.
 *
 * Basis points and not a float: a percentage of a count is a ratio the whole system already spells in
 * integers (`vatRateBp`), and `0.1 + 0.2` has no business anywhere near a report somebody acts on.
 * Rounded to nearest, which is what a report wants; the counts are carried alongside so nobody has to
 * trust the rounding for anything that matters.
 */
export function refCaptureRate(
  counts: RefCaptureCounts,
  options: { readonly expected?: boolean } = {},
): RefCaptureRate {
  const total = counts.matched + counts.unknownCode + counts.notOffered
  // Absent is the PROVISIONAL value and not `true`: a caller that has never heard of the setting must not
  // be able to turn an unanswered question into a claim about the front desk by omission. The same
  // fail-safe-by-omission shape `genderMatching` takes.
  const expected = options.expected ?? PROVISIONAL_WHATSAPP_REF_EXPECTED
  const claim: RefCaptureClaim =
    total === 0 ? 'no_bookings' : expected ? 'measured' : 'loop_unconfirmed'
  return {
    counts,
    total,
    capturedBp: total === 0 ? null : Math.round((counts.matched * 10_000) / total),
    claim,
    openQuestionId: expected ? null : WHATSAPP_REF_OPEN_QUESTION,
  }
}
