/**
 * The nine edge states docs/09 §3 enumerates, and the rule that decides which one a reader is in.
 *
 * docs/09 §3 lists them under a heading that is itself the specification: *"Error and edge states —
 * enumerated, because these are what get skipped and then handled by phone calls"*. So every one of them
 * is a **named** state here rather than a message composed at a call site, and the naming is the part that
 * needs a pure function: three of the nine describe the same visible symptom — the time you chose is not
 * bookable any more — with three different remedies, and a flow that collapsed them into one would send
 * every reader to the same dead end.
 *
 * ## Why this is a rule and not a switch at the call site
 *
 * Because the answer is a **precedence**, and a precedence is exactly what is wrong in a way no screenshot
 * shows. Several facts are true at once in the interesting cases: the session has expired *and* the slot
 * has gone; the therapist is unavailable *and* therefore the start is no longer offered. Whichever of
 * those the flow reports is what the reader is asked to do next, and the useful order is
 * **most specific first** — `therapist_became_unavailable` tells somebody that *widening to any therapist*
 * will work, where `slot_taken` tells them the evening is gone. Put `slot_taken` first, as the shortest
 * code does, and all three of its more specific siblings become unreachable while every assertion about
 * them still passes: the panel renders, the copy exists, and nobody ever sees it.
 * {@link decideBookingEdgeState} is therefore a pure function of stated facts with its own test, and the
 * test's controls are the mutants that get the order wrong.
 *
 * ## What is NOT in here
 *
 * No copy, no URL and no remedy. A state is a name; what it says and where its button goes is the
 * locale's (`apps/web/src/book/copy.ts`) and the page's. And no fact is re-derived: every input below is
 * something the caller already knows from the availability answer, the session row or the booking
 * endpoint's refusal, because a second derivation of "is this start still offered" is a second answer.
 */

/**
 * The nine, in docs/09 §3's own order.
 *
 * Kept in that order deliberately: the document is the specification, and a reader checking the list
 * against the document should not have to reorder it. The precedence
 * {@link decideBookingEdgeState} applies is a separate thing and is written out there.
 */
export const BOOKING_EDGE_STATES = [
  /** "Slot taken while deciding." The start is no longer offerable, and nothing more specific explains it. */
  'slot_taken',
  /** "OTP never arrives." The reader said so; the remedy is a resend, or the desk. */
  'otp_not_arrived',
  /** "Network drop mid-submit." The browser could not complete the submission, so nobody knows. */
  'network_drop',
  /** "Double submission (idempotency key)." The same key arrived twice and answered with one booking. */
  'double_submission',
  /** "Therapist became unavailable after selection." Widening to any therapist is the remedy. */
  'therapist_became_unavailable',
  /** "Required room type now booked." Another time or another day is the remedy; another therapist is not. */
  'required_room_taken',
  /** "Service duration no longer fits before closing." The close moved, or the treatment did. */
  'duration_no_longer_fits',
  /** "Session expiry mid-flow." The verified phone is no longer verified; the remedy is a new code. */
  'session_expired',
  /** "Browser back after confirm." The booking exists; showing the form again would take a second slot. */
  'back_after_confirm',
] as const

export type BookingEdgeState = (typeof BOOKING_EDGE_STATES)[number]

/**
 * The refusals this rule can be handed from the booking endpoint.
 *
 * A narrow subset of `BookingRefusal` in `@berelax/db`, and narrow on purpose: the refusals that are a
 * malformed request (`therapist_count_wrong`, `price_split_disagrees`) are defects rather than states a
 * reader is in, and giving them an edge state would put a designed panel in front of a bug.
 */
export const BOOKING_ATTEMPT_REFUSALS = [
  'slot_taken',
  'requires_client_gender',
  'not_a_trading_date',
  'idempotency_key_reused',
] as const

export type BookingAttemptRefusal = (typeof BOOKING_ATTEMPT_REFUSALS)[number]

/**
 * Everything the decision is made of, each field already answered by the caller.
 *
 * Every one is nullable where "not known yet" is a real answer, and the difference matters: `false` for
 * {@link requestedTherapistStillFree} means *checked, and they are not*, while `null` means *nobody asked
 * for a named therapist*. Collapsing the two into a boolean is how `therapist_became_unavailable` comes to
 * be reported on every booking that named no therapist at all.
 */
export interface BookingAttemptFacts {
  /** The instant the decision is made at. Injected; core reads no clock. */
  readonly now: number
  /**
   * When the reader's verified session expires, or null when there is no session at all.
   *
   * Null and "expired" are different states with different panels: no session is the ordinary first
   * arrival at step 4, and an expired one is the thing docs/09 §3 enumerates.
   */
  readonly sessionExpiresAt: number | null
  /** The booking this session has already produced, or null. */
  readonly existingBookingId: string | null
  /** True when the reader is looking at a step BEFORE the confirmation of a booking that exists. */
  readonly revisitingEarlierStep: boolean
  /** True when the confirm submission replayed an idempotency key that had already produced a booking. */
  readonly replayed: boolean
  /** True when the browser reported that a submission could not be completed. */
  readonly submissionInterrupted: boolean
  /** True when the reader said the code never arrived. */
  readonly codeNotReceived: boolean
  /** The start the reader chose, in epoch ms, or null when none has been chosen. */
  readonly chosenStart: number | null
  /** When the chosen treatment would END, or null when no start has been chosen. */
  readonly treatmentEndsAt: number | null
  /** When the session the chosen start belongs to closes, or null when that is not known. */
  readonly closesAt: number | null
  /** Whether the availability engine still offers the chosen start. Null when no start was chosen. */
  readonly startStillOffered: boolean | null
  /** Whether the therapist the reader asked for by id is still free for it. Null when none was asked for. */
  readonly requestedTherapistStillFree: boolean | null
  /** Whether a room this treatment can be delivered in is still free for it. Null when not evaluated. */
  readonly compatibleRoomStillFree: boolean | null
  /** A refusal the booking endpoint named, or null. */
  readonly refusal: BookingAttemptRefusal | null
}

/**
 * The reader's edge state, or `null` for "nothing is wrong".
 *
 * ## The precedence, and why it is this one
 *
 * 1. **`double_submission`** — the submit SUCCEEDED and handed back a booking that already existed. It
 *    outranks everything because it is the one case where the right answer is *good news*: the booking is
 *    made. Anything below would tell somebody who is already booked that something went wrong.
 * 2. **`back_after_confirm`** — a booking exists and the reader is looking at an earlier step. Second
 *    because the consequence of getting it wrong is the worst available: rendering the confirm form again
 *    invites a second slot for one customer.
 * 3. **`session_expired`** — nothing below can be trusted once the verification has lapsed, because the
 *    phone on the form is no longer a phone anybody proved.
 * 4. **`network_drop`** — the submission's outcome is *unknown*, which is a different statement from any
 *    slot diagnosis. Diagnosing the slot here would answer a question the reader did not ask.
 * 5. **`otp_not_arrived`** — the reader's own report, and the only state below that is about the code.
 * 6. **`duration_no_longer_fits`**, then **`therapist_became_unavailable`**, then
 *    **`required_room_taken`**, then **`slot_taken`**. Most specific first, and `slot_taken` LAST — see
 *    the module header. Each of the three has a remedy `slot_taken` does not: wait for the close to be
 *    extended, widen to any therapist, choose another time. A reader told only "that time has gone"
 *    telephones the front desk, which is the failure docs/09 §3 exists to prevent.
 *
 * `null` rather than a tenth state for "fine": a state vocabulary with a member meaning *no state* is one
 * every consumer has to remember to exclude, and the first one that forgets renders an empty panel.
 */
export function decideBookingEdgeState(facts: BookingAttemptFacts): BookingEdgeState | null {
  if (facts.replayed) return 'double_submission'
  if (facts.existingBookingId !== null && facts.revisitingEarlierStep) return 'back_after_confirm'
  if (facts.sessionExpiresAt !== null && facts.sessionExpiresAt <= facts.now) {
    return 'session_expired'
  }
  if (facts.submissionInterrupted) return 'network_drop'
  if (facts.codeNotReceived) return 'otp_not_arrived'

  // The slot diagnostics. All four need a chosen start: there is nothing to diagnose about a time nobody
  // has picked, and a page that reported `slot_taken` on a bare /book would be one every reader meets.
  if (facts.chosenStart === null) return null

  if (
    facts.treatmentEndsAt !== null &&
    facts.closesAt !== null &&
    facts.treatmentEndsAt > facts.closesAt
  ) {
    return 'duration_no_longer_fits'
  }
  if (facts.requestedTherapistStillFree === false) return 'therapist_became_unavailable'
  if (facts.compatibleRoomStillFree === false) return 'required_room_taken'
  if (facts.startStillOffered === false) return 'slot_taken'
  if (facts.refusal === 'slot_taken') return 'slot_taken'
  return null
}

/**
 * A fact set in which nothing is wrong, for a caller to spread over.
 *
 * Exported because the alternative is fourteen fields restated at every call site, and a field forgotten
 * there does not fail to compile — `exactOptionalPropertyTypes` makes it a type error only for a field
 * with no default, and every field here has a meaningful "not known". A caller that spreads this and
 * overrides the three or four it has measured cannot accidentally assert `requestedTherapistStillFree:
 * false` by omission.
 */
export function noBookingEdgeFacts(now: number): BookingAttemptFacts {
  return {
    now,
    sessionExpiresAt: null,
    existingBookingId: null,
    revisitingEarlierStep: false,
    replayed: false,
    submissionInterrupted: false,
    codeNotReceived: false,
    chosenStart: null,
    treatmentEndsAt: null,
    closesAt: null,
    startStillOffered: null,
    requestedTherapistStillFree: null,
    compatibleRoomStillFree: null,
    refusal: null,
  }
}
