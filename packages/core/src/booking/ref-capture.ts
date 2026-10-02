import {
  normaliseWhatsappRefCode,
  PROVISIONAL_WHATSAPP_REF_EXPECTED,
  WHATSAPP_REF_OPEN_QUESTION,
  WHATSAPP_REF_TTL_OPEN_QUESTION,
} from '@berelax/shared'
import type { Instant } from '../time.ts'

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

/**
 * The five outcomes, mirroring the `whatsapp_ref_capture_outcome` enum of migrations 0079 and 0127.
 *
 * 0079 shipped three and its own comment said what a fourth would cost: "adding a member would be a code
 * change in `@berelax/core` either way". A-FIRST-07 added two, and both are about a code that DID resolve
 * to a row and still did not produce an attribution — which is the state 0079 had no spelling for at all,
 * because without a lifetime and without a prior claim it could not arise.
 */
export const REF_CAPTURE_OUTCOMES = [
  'matched',
  'unknown_code',
  'not_offered',
  /** The code exists and its lifetime had run out (Y12-ref-ttl). The booking is taken regardless. */
  'ref_expired',
  /** The code exists and another CUSTOMER's booking has already claimed it. Surfaced, never reassigned. */
  'ref_conflict',
] as const
export type RefCaptureOutcome = (typeof REF_CAPTURE_OUTCOMES)[number]

/**
 * The outcomes in which the code RESOLVED, and therefore the ones that carry a `refCode`.
 *
 * The TypeScript spelling of 0127's `booking_whatsapp_ref_capture_resolved_names_its_ref`, and derived
 * here rather than written twice: `decideRefCapture`'s own invariant test walks this list against the
 * decisions, so a sixth outcome added to {@link REF_CAPTURE_OUTCOMES} and not classified here is a failing
 * test instead of a row the database refuses at the counter.
 */
export const RESOLVED_REF_CAPTURE_OUTCOMES: readonly RefCaptureOutcome[] = Object.freeze([
  'matched',
  'ref_expired',
  'ref_conflict',
])

/**
 * The code's row, as the caller found it — plus the one prior claim that can make this one a conflict.
 *
 * Every field is a LOOKUP RESULT. There is deliberately no field this function could use to infer a
 * match, an expiry or a conflict from something the caller chose: `sessionId` is the code's own session
 * and becomes the attribution unchanged, so a handler cannot credit a booking to a session it was handed.
 * 0127's ZY332 is the same refusal at the database boundary, for every writer that is not this rule.
 */
export interface MatchedRefCode {
  readonly refCode: string
  /** The analytics session the code was issued into. The attribution, and never the caller's choice. */
  readonly sessionId: string
  /** When the code stops being claimable: `whatsapp_ref.expires_at`, stamped at issue. */
  readonly expiresAt: Instant
  /**
   * The customer whose booking has already claimed this code, or null.
   *
   * The CUSTOMER and not the booking, because one customer booking twice out of one conversation is not a
   * conflict — the code identifies a conversation, and both of that person's bookings came from it. Two
   * different people is the conflict, and it means either the code was shared or the desk typed somebody
   * else's.
   */
  readonly claimedByCustomerId: string | null
}

/** What the desk typed and what the table said about it. `matched` is the table's answer, never a guess. */
export interface RefCaptureInput {
  /** Exactly what was in the field, untouched. Blank, whitespace and malformed are all legitimate. */
  readonly entered: string
  /**
   * The code's row, when the normalised value matched one, and `null` when it did not.
   *
   * A LOOKUP RESULT and not a predicate: the caller has already asked the database, and this function
   * cannot ask. That is what makes "an attribution is only ever a row that exists" structural rather than
   * a rule somebody has to keep remembering — there is no input here from which a match could be inferred.
   */
  readonly matched: MatchedRefCode | null
  /**
   * When the capture is being recorded. An ARGUMENT, because nothing in `@berelax/core` reads a clock —
   * and because the comparison has to be the same instant the row is stamped with, or a decision of
   * `matched` can be followed by a database refusal of ZY331 for a code that expired in between.
   */
  readonly at: Instant
  /** The booking's customer, which is what makes a prior claim a CONFLICT rather than a repeat. */
  readonly customerId: string
}

export interface RefCaptureDecision {
  readonly outcome: RefCaptureOutcome
  /** The code, for the three resolving outcomes. Null for the two in which nothing was found. */
  readonly refCode: string | null
  /** What was typed, kept for `unknown_code` alone. Null otherwise — including for a blank field. */
  readonly enteredCode: string | null
  /** The attribution. Non-null for `matched` alone; nothing else may carry one (0127's CHECK). */
  readonly attributedSessionId: string | null
  /** True when the screen must show a warning. A blank field is not a warning; the other three are. */
  readonly warns: boolean
}

/**
 * The decision. Total over its input, and the five outcomes are mutually exclusive by construction.
 *
 * ## The order of the tests is the rule
 *
 * A resolved code is tested for its LIFETIME before its prior claim, and the order is not arbitrary: an
 * expired code that somebody else also claimed is reported as expired, because the expiry is a fact about
 * our own issuing and the conflict is a fact about two customers. Telling the desk "another customer has
 * this code" about a code that was dead anyway sends them to ask the wrong question.
 *
 * ## Why a resolved row still wins over the shape test
 *
 * If the caller found a row, the value is a code whatever this function thinks of its shape, because the
 * row's own CHECK constraint already proved it. Re-deriving it here would be a second opinion about the
 * alphabet, and the failure it produces is the worst available one — a booking whose matched row is
 * discarded and recorded as unknown.
 */
export function decideRefCapture(input: RefCaptureInput): RefCaptureDecision {
  const matched = input.matched
  if (matched !== null) {
    // `<=` and not `<`: `expires_at` is the first instant at which the code is dead, which is the same
    // boundary 0127's trigger takes (`v_expires <= new.recorded_at`). The two comparisons are the same
    // claim in two languages and a strict-versus-inclusive difference between them would show up as a
    // ZY331 on exactly one booking a week.
    if (matched.expiresAt <= input.at) {
      return {
        outcome: 'ref_expired',
        refCode: matched.refCode,
        enteredCode: null,
        attributedSessionId: null,
        warns: true,
      }
    }
    if (matched.claimedByCustomerId !== null && matched.claimedByCustomerId !== input.customerId) {
      return {
        outcome: 'ref_conflict',
        refCode: matched.refCode,
        enteredCode: null,
        attributedSessionId: null,
        warns: true,
      }
    }
    return {
      outcome: 'matched',
      refCode: matched.refCode,
      enteredCode: null,
      // The code's own session, copied straight across. This is the line that makes the attribution
      // unfakeable from this side: there is no other value in scope it could be.
      attributedSessionId: matched.sessionId,
      warns: false,
    }
  }
  const typed = input.entered.trim()
  if (typed.length === 0) {
    return {
      outcome: 'not_offered',
      refCode: null,
      enteredCode: null,
      attributedSessionId: null,
      warns: false,
    }
  }
  // Normalised where it is a code and raw where it is not, so the stored text is comparable with
  // `whatsapp_ref.ref_code` when A-FIRST writes the row LATER — a code typed today and issued tomorrow is
  // the commonest way this state arises, and a lower-case copy of it would not join.
  return {
    outcome: 'unknown_code',
    refCode: null,
    enteredCode: normaliseWhatsappRefCode(typed) ?? typed,
    attributedSessionId: null,
    warns: true,
  }
}

/**
 * The counts the BOOKING-side capture rate is computed from. Every one a `count(*)`, never a total.
 *
 * One field per outcome and no `other` bucket, which is what makes a sixth outcome a compile error here
 * rather than a silent absence from the denominator — the failure `readRefCaptureCounts` describes from
 * the SQL side ("a fourth enum member added without a change here would be silently absent").
 */
export interface RefCaptureCounts {
  readonly matched: number
  readonly unknownCode: number
  readonly notOffered: number
  readonly refExpired: number
  readonly refConflict: number
}

/**
 * The empty value, for a caller that has one or two of the five.
 *
 * A spread of this (`{ ...EMPTY_REF_CAPTURE_COUNTS, matched: 3 }`) and never a cast: an absent count and a
 * count of zero are the same claim here, and a cast would let a caller that has never heard of
 * `refExpired` omit it and quietly shrink the denominator. The repository's own reader fills all five.
 */
export const EMPTY_REF_CAPTURE_COUNTS: RefCaptureCounts = Object.freeze({
  matched: 0,
  unknownCode: 0,
  notOffered: 0,
  refExpired: 0,
  refConflict: 0,
})

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
  const total =
    counts.matched + counts.unknownCode + counts.notOffered + counts.refExpired + counts.refConflict
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

/** ------------------------------------------------------------------------------------------------
 * The ISSUE-side rate: of the codes we handed out, how many came back.
 * ------------------------------------------------------------------------------------------------ */

/**
 * The two counts of one day's ref loop, read off `analytics.daily_ref_capture`.
 *
 * ## Why this is a different measure from {@link refCaptureRate} and the two may never be averaged
 *
 * {@link refCaptureRate} divides matched BOOKINGS by bookings taken at the desk: its question is "is the
 * front desk filling the field", and its denominator is every booking whatever happened to the ref field.
 * This one divides CLAIMED CODES by codes ISSUED: its question is "does a WhatsApp conversation become a
 * booking", and its denominator is every code that went into a message.
 *
 * They answer different questions, they can move in opposite directions, and only one of them is a
 * conversion rate. A desk that pastes every code it is given scores 100% on the first measure and 4% on
 * the second, and both figures are correct. Averaging or substituting them produces a number that means
 * nothing and reads like a conversion rate, which is why they are two functions with two result types
 * rather than one function with a flag.
 */
export interface RefIssueCaptureCounts {
  /** Codes issued into conversations on the day. The denominator. */
  readonly issued: number
  /**
   * How many of THOSE codes a booking later matched. Paired with the issue day and not the booking day:
   * dividing today's claims by today's issues mixes cohorts and can exceed 1, and a capture rate of 140%
   * is arithmetic nobody can act on. 0127's `daily_ref_capture_claimed_within_issued` is the same pairing
   * as a CHECK.
   */
  readonly claimed: number
}

/**
 * What an issue-side rate is allowed to CLAIM — the same three-way distinction {@link REF_CAPTURE_CLAIMS}
 * makes, with the empty case named for what is empty here.
 *
 * `no_codes_issued` rather than `no_bookings`, and it is not a rename for its own sake: on this measure
 * the empty denominator is the state this build is actually in, because `premises.phone_whatsapp` holds
 * the Y1-nap placeholder and the issue path refuses rather than minting a code for a message nobody can
 * send. Reporting that as 0% would be a claim about the front desk made out of the absence of a phone
 * number.
 */
export const REF_ISSUE_CAPTURE_CLAIMS = ['no_codes_issued', 'loop_unconfirmed', 'measured'] as const
export type RefIssueCaptureClaim = (typeof REF_ISSUE_CAPTURE_CLAIMS)[number]

export interface RefIssueCaptureRate {
  readonly counts: RefIssueCaptureCounts
  /** Claimed over issued, in whole basis points. Null when there is nothing to divide by. */
  readonly claimedBp: number | null
  readonly claim: RefIssueCaptureClaim
  /** The OPEN-QUESTIONS ids this answer is provisional against, in order. Empty once both are answered. */
  readonly openQuestionIds: readonly string[]
}

/**
 * The rate, and the claim it is entitled to make.
 *
 * Basis points and not a float, for {@link refCaptureRate}'s reason: a percentage of a count is a ratio
 * this system already spells in integers, and `0.1 + 0.2` has no business near a report somebody acts on.
 * The counts are carried alongside so nobody has to trust the rounding for anything that matters.
 *
 * Both open questions are carried while the loop is unconfirmed, and the TTL one is carried even when the
 * loop is confirmed: a measured rate computed against a seven-day window nobody chose is still a figure
 * whose denominator depends on an unanswered question, and a report that stopped saying so would read as
 * settled.
 */
export function refIssueCaptureRate(
  counts: RefIssueCaptureCounts,
  options: { readonly expected?: boolean } = {},
): RefIssueCaptureRate {
  // Absent is the PROVISIONAL value and not `true`, exactly as `refCaptureRate` takes it: a caller that
  // has never heard of the setting must not be able to turn an unanswered question into a claim about the
  // front desk by omission.
  const expected = options.expected ?? PROVISIONAL_WHATSAPP_REF_EXPECTED
  const claim: RefIssueCaptureClaim =
    counts.issued === 0 ? 'no_codes_issued' : expected ? 'measured' : 'loop_unconfirmed'
  return {
    counts,
    claimedBp: counts.issued === 0 ? null : Math.round((counts.claimed * 10_000) / counts.issued),
    claim,
    openQuestionIds: Object.freeze(
      expected
        ? [WHATSAPP_REF_TTL_OPEN_QUESTION]
        : [WHATSAPP_REF_OPEN_QUESTION, WHATSAPP_REF_TTL_OPEN_QUESTION],
    ),
  }
}

/**
 * A basis-point rate as the one decimal place a report prints — `4000` becomes `40.0%`.
 *
 * One decimal and never two, and never a bare integer: `40%` loses the difference between 40.0 and 40.4
 * on a day with a few hundred codes, and `40.00%` claims a precision that four claims out of ten do not
 * have. Here rather than in the page because three surfaces print this figure (the quick-book footer, the
 * analytics page A-FIRST-10 builds and the daily rollup's own log line) and a second spelling of the
 * conversion is a second rounding.
 *
 * `null` for an absent rate is the word and not `0.0%`, because the whole point of `claimedBp` being
 * nullable is that an empty denominator has no rate — see {@link REF_ISSUE_CAPTURE_CLAIMS}.
 */
export function formatCapturedBp(bp: number | null): string {
  return bp === null ? 'no rate' : `${(bp / 100).toFixed(1)}%`
}
