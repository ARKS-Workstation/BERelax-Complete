import { describe, expect, it } from 'vitest'
import {
  BOOKING_EDGE_STATES,
  type BookingAttemptFacts,
  type BookingEdgeState,
  decideBookingEdgeState,
  noBookingEdgeFacts,
} from './edge-state.ts'

/**
 * The nine edge states, and the precedence that decides between them.
 *
 * Two things are proved here and only one of them is obvious. The obvious one is that each of the nine is
 * reachable. The other is the one that matters: the ORDER. Three states describe one symptom — the time
 * you chose cannot be delivered — with three different remedies, and the shortest implementation reports
 * `slot_taken` for all three. That implementation passes every "is the panel reachable" test, because the
 * panel is reachable; what it does not do is ever show the two more useful ones. So every ordering claim
 * below is paired with a **mutant decider** that gets it wrong, and the mutant is asserted to disagree.
 */

const NOW = Date.parse('2026-09-24T15:00:00Z')
const MINUTE = 60_000

/** A fact set with a chosen start that is still perfectly bookable. */
const bookable = (over: Partial<BookingAttemptFacts> = {}): BookingAttemptFacts => ({
  ...noBookingEdgeFacts(NOW),
  sessionExpiresAt: NOW + 20 * MINUTE,
  chosenStart: NOW + 6 * 60 * MINUTE,
  treatmentEndsAt: NOW + 7 * 60 * MINUTE,
  closesAt: NOW + 11 * 60 * MINUTE,
  startStillOffered: true,
  compatibleRoomStillFree: true,
  ...over,
})

describe('the nine edge states', () => {
  it('declares exactly the nine docs/09 §3 enumerates, once each', () => {
    // The list itself, against the document. A tenth member added without copy would render a blank
    // panel, and a member removed would make a `Record<BookingEdgeState, string>` compile with a hole.
    expect(BOOKING_EDGE_STATES).toHaveLength(9)
    expect(new Set(BOOKING_EDGE_STATES).size).toBe(9)
    expect([...BOOKING_EDGE_STATES]).toEqual([
      'slot_taken',
      'otp_not_arrived',
      'network_drop',
      'double_submission',
      'therapist_became_unavailable',
      'required_room_taken',
      'duration_no_longer_fits',
      'session_expired',
      'back_after_confirm',
    ])
  })

  it('reaches every one of the nine from a fact set that differs in one field', () => {
    // One case per state, and the shape is the assertion: each row changes ONE thing about a bookable
    // flow. A row that needed three changes would be a state nothing in the real flow can produce.
    const cases: readonly { state: BookingEdgeState; facts: BookingAttemptFacts }[] = [
      { state: 'double_submission', facts: bookable({ replayed: true }) },
      {
        state: 'back_after_confirm',
        facts: bookable({ existingBookingId: 'b1', revisitingEarlierStep: true }),
      },
      { state: 'session_expired', facts: bookable({ sessionExpiresAt: NOW - 1 }) },
      { state: 'network_drop', facts: bookable({ submissionInterrupted: true }) },
      { state: 'otp_not_arrived', facts: bookable({ codeNotReceived: true }) },
      {
        state: 'duration_no_longer_fits',
        facts: bookable({ closesAt: NOW + 6 * 60 * MINUTE + 30 * MINUTE }),
      },
      {
        state: 'therapist_became_unavailable',
        facts: bookable({ requestedTherapistStillFree: false }),
      },
      { state: 'required_room_taken', facts: bookable({ compatibleRoomStillFree: false }) },
      { state: 'slot_taken', facts: bookable({ startStillOffered: false }) },
    ]
    expect(cases.map((entry) => entry.state).sort()).toEqual([...BOOKING_EDGE_STATES].sort())
    for (const entry of cases) {
      expect(decideBookingEdgeState(entry.facts), entry.state).toBe(entry.state)
    }
  })

  it('answers null when nothing is wrong, at every stage of the flow', () => {
    // The control for the whole file. A decider that answered a state for everything would satisfy every
    // assertion above, and the page would render an error panel on a first arrival at /book.
    expect(decideBookingEdgeState(noBookingEdgeFacts(NOW))).toBeNull()
    expect(decideBookingEdgeState(bookable())).toBeNull()
    // A live session with a booking already taken, looking at the CONFIRMATION rather than an earlier
    // step: that is the ordinary happy end of the flow, not `back_after_confirm`.
    expect(
      decideBookingEdgeState(bookable({ existingBookingId: 'b1', revisitingEarlierStep: false })),
    ).toBeNull()
  })

  it('does not diagnose a slot nobody has chosen', () => {
    // Every slot diagnosis needs a chosen start. Without this guard a bare /book — no start, no close,
    // nothing offered — reports `slot_taken` to every reader who has not picked a time yet.
    const nothingChosen = noBookingEdgeFacts(NOW)
    expect(decideBookingEdgeState(nothingChosen)).toBeNull()
    expect(
      decideBookingEdgeState({
        ...nothingChosen,
        startStillOffered: false,
        compatibleRoomStillFree: false,
        requestedTherapistStillFree: false,
      }),
    ).toBeNull()
  })
})

describe('the precedence, against the deciders that get it wrong', () => {
  /**
   * The mutant: `slot_taken` first, which is what the shortest implementation does.
   *
   * It is a whole decider rather than a flag, because a flag would be tested code. Its job is to produce
   * the WRONG answer for the three fact sets below, so that "the real decider says X" is a claim with
   * something to disagree with (ADR 0003).
   */
  const slotTakenFirst = (facts: BookingAttemptFacts): BookingEdgeState | null => {
    if (facts.chosenStart !== null && facts.startStillOffered === false) return 'slot_taken'
    return decideBookingEdgeState(facts)
  }

  it('names the therapist rather than the slot when the therapist is the reason', () => {
    // Both facts are true at once, and they always are: narrow the query to one therapist who has gone,
    // and the start stops being offered. Reporting the slot sends the reader to another evening; reporting
    // the therapist sends them to the control that widens the question, which is the one that works.
    const facts = bookable({ startStillOffered: false, requestedTherapistStillFree: false })
    expect(decideBookingEdgeState(facts)).toBe('therapist_became_unavailable')
    expect(slotTakenFirst(facts)).toBe('slot_taken')
  })

  it('names the room rather than the slot when the room type is the reason', () => {
    const facts = bookable({ startStillOffered: false, compatibleRoomStillFree: false })
    expect(decideBookingEdgeState(facts)).toBe('required_room_taken')
    expect(slotTakenFirst(facts)).toBe('slot_taken')
  })

  it('names the closing time rather than the slot when the treatment no longer fits', () => {
    const facts = bookable({
      startStillOffered: false,
      closesAt: NOW + 6 * 60 * MINUTE + 15 * MINUTE,
    })
    expect(decideBookingEdgeState(facts)).toBe('duration_no_longer_fits')
    expect(slotTakenFirst(facts)).toBe('slot_taken')
  })

  it('reports good news before any diagnosis', () => {
    // A replay is a booking that exists. A decider that checked the slot first would tell a customer who
    // IS booked that their time has gone, which is the worst available answer on this page.
    const facts = bookable({
      replayed: true,
      existingBookingId: 'b1',
      startStillOffered: false,
      requestedTherapistStillFree: false,
      sessionExpiresAt: NOW - 1,
      refusal: 'slot_taken',
    })
    expect(decideBookingEdgeState(facts)).toBe('double_submission')
  })

  it('refuses to render the confirm form again when a booking already exists', () => {
    // Second in the order, and the mutant is the one that checks the session first: an expired session
    // plus a committed booking would ask for a new code and then a second confirmation.
    const facts = bookable({
      existingBookingId: 'b1',
      revisitingEarlierStep: true,
      sessionExpiresAt: NOW - 1,
    })
    expect(decideBookingEdgeState(facts)).toBe('back_after_confirm')
    const sessionFirst = (input: BookingAttemptFacts): BookingEdgeState | null =>
      input.sessionExpiresAt !== null && input.sessionExpiresAt <= input.now
        ? 'session_expired'
        : decideBookingEdgeState(input)
    expect(sessionFirst(facts)).toBe('session_expired')
  })

  it('reports an unknown outcome as unknown rather than diagnosing the slot', () => {
    // A network drop leaves the outcome unknown, and the slot may look taken because THIS reader's own
    // booking took it. Diagnosing it would tell somebody their booking failed because they had booked.
    const facts = bookable({ submissionInterrupted: true, startStillOffered: false })
    expect(decideBookingEdgeState(facts)).toBe('network_drop')
  })

  it('distinguishes no session from an expired one', () => {
    // `null` is a first arrival at step 4 and `<= now` is the enumerated state. A decider that treated an
    // absent session as expired would show "your session has expired" to every reader who had not
    // started one.
    expect(
      decideBookingEdgeState({ ...noBookingEdgeFacts(NOW), sessionExpiresAt: null }),
    ).toBeNull()
    expect(decideBookingEdgeState({ ...noBookingEdgeFacts(NOW), sessionExpiresAt: NOW - 1 })).toBe(
      'session_expired',
    )
    // And the boundary: a session expiring at exactly `now` is expired, because `expires_at` is the
    // instant it stops being valid. The one a second earlier is not.
    expect(decideBookingEdgeState({ ...noBookingEdgeFacts(NOW), sessionExpiresAt: NOW })).toBe(
      'session_expired',
    )
    expect(
      decideBookingEdgeState({ ...noBookingEdgeFacts(NOW), sessionExpiresAt: NOW + 1 }),
    ).toBeNull()
  })

  it('treats a treatment ending exactly at closing as fitting', () => {
    // `>` and not `>=`. The close is the instant the premises stops trading, and a treatment that ends on
    // it has ended. An off-by-one here refuses the last bookable start of every single day.
    expect(decideBookingEdgeState(bookable({ treatmentEndsAt: NOW + 11 * 60 * MINUTE }))).toBeNull()
    expect(decideBookingEdgeState(bookable({ treatmentEndsAt: NOW + 11 * 60 * MINUTE + 1 }))).toBe(
      'duration_no_longer_fits',
    )
  })

  it('never reports the therapist when none was asked for', () => {
    // `null` means nobody named a therapist, and it must not read as `false`. This is the case that made
    // the field three-valued: a boolean here reports `therapist_became_unavailable` on every booking
    // taken with "any available therapist", which is every booking this business currently offers.
    expect(decideBookingEdgeState(bookable({ requestedTherapistStillFree: null }))).toBeNull()
    expect(
      decideBookingEdgeState(
        bookable({ requestedTherapistStillFree: null, startStillOffered: false }),
      ),
    ).toBe('slot_taken')
  })
})
