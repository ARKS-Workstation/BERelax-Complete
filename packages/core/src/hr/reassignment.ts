import { AppError } from '@berelax/shared'
import type { CommittedAppointment } from '../availability/assign-shape.ts'
import type {
  EligibilityExclusionReason,
  EligibleTherapist,
  ExcludedTherapist,
} from '../availability/eligibility-port.ts'
import { ELIGIBILITY_EXCLUSION_REASONS } from '../availability/eligibility-port.ts'
import { coveredWithoutGap, therapistOccupancy } from '../availability/intervals.ts'
import type { Period } from '../availability/room-predicates.ts'
import {
  appointmentOccupancy,
  rosteredByTherapist,
  type ScheduledAppointment,
  type TherapistShift,
  therapistsFreeFor,
} from '../availability/solve.ts'
import type { Instant } from '../time.ts'

/**
 * Reassignment: who may take an appointment its therapist can no longer deliver, and the vocabulary
 * that decision is recorded in (P-HR-04).
 *
 * P-HR-03 produces the work queue — `appointment_reassignment_flag`, raised by the nightly credential
 * sweep, deliberately without touching `appointment.status` — and defers *acting* on it to this unit.
 * This module is the pure half: the candidate rule, the reason vocabulary the transaction writes into
 * `appointment_status_history`, the customer notice's own rule, and the order the queue is worked in.
 *
 * ## The candidate finder adds TWO checks and re-implements none
 *
 * The one thing this unit must not do is offer a therapist the booking path would then refuse. There is
 * exactly one answer to "may this therapist take an appointment on this trading date" — B-AVAIL-04's
 * read model, mirrored by `resolveTherapistPool` in `../availability/eligibility-port.ts` and computed
 * in SQL by `@berelax/db` — and five of the seven checks the acceptance line names are that answer:
 * employment, the required skill, credential validity, the roster for the DAY, approved leave, and
 * B-AVAIL-05's same-gender rule. So {@link reassignmentCandidates} takes a {@link ReassignmentPool} and
 * **consumes** it: an excluded therapist is rejected with the pool's own reason, spelled as the pool
 * spelled it, and an eligible one is not re-judged on any of those grounds. A second copy of the
 * credential predicate here would be a third answer to that question, and the failure mode is the one
 * P-HR-03's header describes: the two answers disagree and only one of them is in front of a human.
 *
 * What it adds is the two checks the pool cannot make, because the pool is about a DATE and an
 * appointment is about a period:
 *
 *   1. the candidate is rostered for the WHOLE of the appointment's buffered interval — "a shift
 *      overlaps it" would send somebody home at 22:00 in the middle of a treatment that started at
 *      21:00;
 *   2. the candidate holds no other appointment overlapping that interval, counted with *that*
 *      appointment's own buffer.
 *
 * Both are `therapistsFreeFor`'s (B-AVAIL-02), and that function decides MEMBERSHIP here: the survivors
 * it returns are the candidates, verbatim. The two primitives are used again afterwards only to
 * attribute a REASON to the therapists it dropped, which cannot change who is in the answer. The
 * alternative — deciding membership from the primitives directly — is a second reading of "free", and
 * the boundary minute is where two readings of that differ.
 *
 * ## The incumbent is rejected by name, and their own appointment stays in the input
 *
 * The appointment being reassigned is a committed appointment like any other, and it is deliberately
 * left in `committed`: it blocks its own therapist, who is rejected as `already_assigned` before any
 * interval is computed, and it blocks nobody else. Filtering it out would be a rule about which rows to
 * ignore, and the row it would teach a caller to ignore is the one that makes the sibling row of a Four
 * Hands block its own therapist — which is exactly the case that must not be offered.
 *
 * ## Composed exclusions are removed before the rule runs, never reported by it
 *
 * C-CRM-01's do-not-pair flag and M-VAT-10's overdue blocking obligation are `TherapistExclusion`s in
 * `@berelax/db`, and the first of them reports **no reason** on purpose: a reason travels to whoever
 * asked, and naming that one would tell somebody which therapist declined a customer. `composedExclusions`
 * therefore removes such a candidate from the candidate set rather than labelling it, and it THROWS on a
 * reason colliding with the seven. This module keeps that shape: the caller narrows the pool it passes
 * in, so a silently excluded therapist is absent rather than rejected, and there is no row here for a
 * reason to leak from. {@link REASSIGNMENT_REJECTIONS} adds two labels to the seven and
 * `reassignment.test.ts` asserts neither collides with them, which is the same claim `composedExclusions`
 * makes at runtime, made at authoring time on this side.
 */

/**
 * Why an appointment is being reassigned, as the `appointment_status_history` row records it.
 *
 * Four values and not free prose, and the reason is the row: 0065 mirrors this list as a CHECK
 * constraint on `appointment_status_history.reason` for any row carrying a therapist pair, and
 * `packages/fixtures/src/reassignment.itest.ts` parses the accepted set out of `pg_constraint` and
 * asserts it equals this array in both directions — the arrangement 0046 made for `actor_role` and
 * B-LIFE-01 made for the status enum. A fifth reason added to one side and not the other is a
 * reassignment the database refuses at the last statement of a transaction that has already done
 * everything else.
 *
 *   * `credential_expiry` — P-HR-03's sweep raised the flag: a mandatory document has lapsed or was
 *     never filed, so the availability query has already stopped offering this therapist.
 *   * `leave_approved` — leave was approved over an appointment already in the diary.
 *   * `therapist_archived` — the employment ended, or the person was taken off the rota for good.
 *   * `manual` — a human decided, for a reason the note beside it carries. Deliberately last and
 *     deliberately present: without it every off-model reassignment would be filed under one of the
 *     other three, which is worse than a label that says "somebody decided".
 */
export const REASSIGNMENT_REASONS = [
  'credential_expiry',
  'leave_approved',
  'therapist_archived',
  'manual',
] as const
export type ReassignmentReason = (typeof REASSIGNMENT_REASONS)[number]

/**
 * `value` as a {@link ReassignmentReason}, or a refusal.
 *
 * Throws rather than returning `undefined`, for the reason `exclusionReasonFrom` in `@berelax/db`
 * gives: the permissive version turns a reason this build has not learned about into a reassignment
 * with no reason attached, and the database would then refuse the history row from inside a transaction
 * that has already written everything else — a failure reported against the chain rather than against
 * the caller who chose the word.
 */
export function reassignmentReason(value: string): ReassignmentReason {
  if (!(REASSIGNMENT_REASONS as readonly string[]).includes(value)) {
    throw new AppError(
      'validation',
      `"${value}" is not a reassignment reason. The four are ${REASSIGNMENT_REASONS.join(', ')}, and ` +
        '0065 mirrors them as a CHECK on appointment_status_history.reason, so a fifth word is refused ' +
        'by the database rather than recorded.',
      { details: { value, known: [...REASSIGNMENT_REASONS] } },
    )
  }
  return value as ReassignmentReason
}

/**
 * Why a therapist is not a candidate for THIS appointment.
 *
 * The seven of the pool, plus two that are about the appointment's period rather than about the day —
 * and they are separate labels rather than a second use of `not_rostered`, because they are different
 * conversations. `not_rostered` is "this person is not working that day" and is a rota question;
 * `not_rostered_for_the_period` is "they are working, and not at 21:00", which is an answer the front
 * desk can act on by moving the appointment rather than the person.
 *
 * `already_assigned` is not a rejection of the therapist at all — it is the incumbent, and the answer to
 * "why are they not offered" is that offering them would be a reassignment that reassigns nothing.
 */
export const REASSIGNMENT_REJECTIONS = [
  ...ELIGIBILITY_EXCLUSION_REASONS,
  /** They already hold this appointment. Reassigning to them is not a reassignment. */
  'already_assigned',
  /** Rostered on the date, and not across the whole of the treatment plus its buffers. */
  'not_rostered_for_the_period',
  /** Free on the date, and holding another appointment that overlaps this one's buffered interval. */
  'therapist_busy',
] as const
export type ReassignmentRejection = (typeof REASSIGNMENT_REJECTIONS)[number]

/** One therapist who may not take this appointment, and why. Ids only: therapists have no names here. */
export interface RejectedCandidate {
  readonly therapistId: string
  readonly reason: ReassignmentRejection
}

/**
 * The appointment being reassigned, as this rule needs it.
 *
 * `therapistBufferMinutes` is the appointment's OWN snapshot (0038) and never today's catalogue figure:
 * re-deriving it would move the busy interval of an appointment already sold, which is the retroactive
 * occupancy change `solve.ts` warns about — and here it would do it while deciding who may deliver it.
 */
export interface ReassignableAppointment {
  readonly appointmentId: string
  /** The therapist who holds it now. Rejected as `already_assigned`, never silently dropped. */
  readonly therapistId: string
  /**
   * The treatment itself, in epoch milliseconds. Turnaround and buffer are added by the rule.
   *
   * Unbranded, for the reason `CommittedAppointment` in `../availability/assign-shape.ts` is: `Instant`
   * is a branded number and `packages/db` cannot name the brand, so the branding happens on the one side
   * that owns it. A branded `Period` is still assignable here, which is why core's own callers and its
   * property test pass one unchanged.
   */
  readonly treatment: { readonly startsAt: number; readonly endsAt: number }
  readonly therapistBufferMinutes: number
}

/**
 * The eligibility answer as a caller outside this package spells it: epoch milliseconds, no brands.
 *
 * Field for field `TherapistPool`, and a branded `TherapistPool` is assignable to it — so
 * `resolveTherapistPool`'s output goes in unchanged and a repository's rows do too. `excluded.reason` is
 * the port's CLOSED union rather than a string, because this rule reports it verbatim: a bare string
 * would let a caller invent a reason and have it printed beside a therapist as though the pool had said
 * it.
 */
export interface ReassignmentPool {
  readonly therapists: readonly EligibleTherapist[]
  readonly shifts: readonly {
    readonly therapistId: string
    readonly period: { readonly startsAt: number; readonly endsAt: number }
  }[]
  readonly excluded: readonly ExcludedTherapist[]
}

export interface ReassignmentQuery {
  readonly appointment: ReassignableAppointment
  /**
   * The eligibility answer for the appointment's trading date, narrowed to the candidates the caller
   * is willing to consider and with any composed exclusion already removed. See the header.
   */
  readonly pool: ReassignmentPool
  /**
   * Every appointment still holding a therapist on that trading date, INCLUDING the one being
   * reassigned. The header says why that one stays.
   */
  readonly committed: readonly CommittedAppointment[]
}

/** The answer: who may take it, and why everybody else may not. */
export interface ReassignmentCandidates {
  /** Ascending by id, so a queue screen and a screenshot stay diffable. */
  readonly candidates: readonly string[]
  /** Ascending by id. Every therapist the pool answered about is in exactly one of the two lists. */
  readonly rejected: readonly RejectedCandidate[]
  /** The interval the candidates were judged free over: the treatment plus the buffer on both sides. */
  readonly buffered: Period
}

const byId = (a: { readonly therapistId: string }, b: { readonly therapistId: string }): number =>
  a.therapistId < b.therapistId ? -1 : a.therapistId > b.therapistId ? 1 : 0

/**
 * The candidates for one appointment. Pure, over facts somebody else read.
 *
 * The order of the checks is the order of {@link REASSIGNMENT_REJECTIONS}: the pool's seven first,
 * because they are facts about the person and the day, then the incumbent, then the two facts about this
 * appointment's period. A therapist failing more than one is reported by the first, which is what makes
 * two implementations of this comparable at all.
 */
export function reassignmentCandidates(query: ReassignmentQuery): ReassignmentCandidates {
  const { appointment, pool } = query
  // The brands are applied here, on the side that owns them (`recheckShapeAssignment` makes the same
  // move for the same reason). Everything below is the branded rule.
  const committed: readonly ScheduledAppointment[] = query.committed.map((row) => ({
    id: row.id,
    roomId: row.roomId,
    therapistIds: row.therapistIds,
    delivery: row.delivery,
    treatment: {
      startsAt: row.treatment.startsAt as Instant,
      endsAt: row.treatment.endsAt as Instant,
    },
    turnaroundMinutes: row.turnaroundMinutes,
    therapistBufferMinutes: row.therapistBufferMinutes,
  }))
  const shifts: readonly TherapistShift[] = pool.shifts.map((shift) => ({
    therapistId: shift.therapistId,
    period: {
      startsAt: shift.period.startsAt as Instant,
      endsAt: shift.period.endsAt as Instant,
    },
  }))
  const buffered = therapistOccupancy({
    startsAt: appointment.treatment.startsAt as Instant,
    durationMinutes: Math.round(
      (appointment.treatment.endsAt - appointment.treatment.startsAt) / 60_000,
    ),
    bufferMinutes: appointment.therapistBufferMinutes,
  })

  // The pool's own answer, verbatim and in its own words. Nothing here re-judges employment, skill,
  // credentials, the roster for the day, approved leave or gender.
  const rejected: RejectedCandidate[] = pool.excluded.map((entry) => ({
    therapistId: entry.therapistId,
    reason: entry.reason satisfies EligibilityExclusionReason as ReassignmentRejection,
  }))

  const eligibleIds = pool.therapists
    .map((therapist) => therapist.therapistId)
    .filter((id) => id !== appointment.therapistId)
  for (const therapist of pool.therapists) {
    if (therapist.therapistId === appointment.therapistId) {
      rejected.push({ therapistId: therapist.therapistId, reason: 'already_assigned' })
    }
  }

  // MEMBERSHIP is `therapistsFreeFor`'s, so "free" has one reading (B-AVAIL-02). The occupancy and the
  // roster index are hoisted because both loops below read them, which is the only reason those
  // parameters exist on that function.
  const occupancy = appointmentOccupancy(committed)
  const rostered = rosteredByTherapist(shifts)
  const free = new Set(
    therapistsFreeFor({
      therapistIds: eligibleIds,
      period: buffered,
      shifts,
      appointments: committed,
      occupancy,
      rostered,
    }),
  )

  // And the REASON for the ones it dropped, attributed from the same two primitives that function uses.
  // It cannot change who is in the answer: every id here is already outside `free`.
  for (const therapistId of eligibleIds) {
    if (free.has(therapistId)) continue
    const presence: readonly Period[] = rostered.get(therapistId) ?? []
    rejected.push({
      therapistId,
      reason: coveredWithoutGap(buffered, presence)
        ? 'therapist_busy'
        : 'not_rostered_for_the_period',
    })
  }

  return {
    candidates: eligibleIds.filter((id) => free.has(id)).sort(),
    rejected: rejected.sort(byId),
    buffered,
  }
}

/**
 * Fails when the answer does not account for every therapist the pool did.
 *
 * The same claim `assertPoolIsTotal` makes one layer down, and it catches the same invisible defect: a
 * therapist in neither list reads as a shorter roster, so the queue offers fewer people with no reason
 * given for the one who vanished. Listed twice is the same defect from the other side — it would let a
 * candidate also carry a rejection, and a screen showing both would be showing one person as two.
 */
export function assertCandidatesAreTotal(
  answer: ReassignmentCandidates,
  pool: ReassignmentPool,
): void {
  const asked = [
    ...pool.therapists.map((therapist) => therapist.therapistId),
    ...pool.excluded.map((entry) => entry.therapistId),
  ]
  const answered = [...answer.candidates, ...answer.rejected.map((entry) => entry.therapistId)]
  const missing = asked.filter((id) => !answered.includes(id))
  const duplicated = [...new Set(answered.filter((id, i) => answered.indexOf(id) !== i))]
  const unasked = answered.filter((id) => !asked.includes(id))
  if (missing.length > 0 || duplicated.length > 0 || unasked.length > 0) {
    throw new AppError(
      'invariant_violated',
      'A reassignment answer must place every therapist the pool answered about in exactly one of ' +
        `candidates or rejected. Unaccounted for: [${missing.join(', ')}]; listed twice: ` +
        `[${duplicated.join(', ')}]; never asked about: [${unasked.join(', ')}].`,
      { details: { missing, duplicated, unasked } },
    )
  }
}

/**
 * The customer notice a reassignment sends, and the ONE class it may be sent under.
 *
 * `transactional`, and that is a compliance answer rather than a preference: a message telling a
 * customer their booking has changed is a service update, not marketing, so it must not be consent-gated
 * (B-MSG-02's `evaluateGate` returns `allow` on its first line for a transactional message) and must not
 * leave from the `AD-` promotional identity. The mirror-image failure is the one C-AUTO-01 built
 * `message_class` immutability for: a promotional template sent under a restated transactional class
 * skips every gate there is.
 *
 * The template's words are `@berelax/messaging`'s (`booking.therapist_changed` in `templates.ts`), and
 * they name neither the treatment nor either therapist — docs/06 D2's discretion rule, and brief rule 10
 * besides: a therapist has no display name until an admin sets one, so a notice naming "your new
 * therapist" would either invent one or print an id.
 */
export const REASSIGNMENT_NOTICE_TEMPLATE_KEY = 'booking.therapist_changed'
export const REASSIGNMENT_NOTICE_CLASS = 'transactional'

/** The template row as the notice rule judges it. Field for field what `readCurrentTemplate` returns. */
export interface ResolvedNoticeTemplate {
  readonly templateKey: string
  readonly messageClass: string
  readonly approvalState: string
}

/** Every reason a reassignment notice may not be sent. A caller branches on these, never on prose. */
export const NOTICE_REFUSALS = [
  /** No current template for the key, in this channel and locale. */
  'notice_template_missing',
  /** The row resolved is not the notice's own template — a caller asked about something else. */
  'notice_template_wrong',
  /** Its class is not `transactional`. A reclassification, and the one thing this rule exists for. */
  'notice_not_transactional',
  /** Nobody has approved these words, so the send path would refuse them (`template_not_approved`). */
  'notice_not_approved',
] as const
export type NoticeRefusal = (typeof NOTICE_REFUSALS)[number]

export type NoticeVerdict =
  | { readonly kind: 'sendable'; readonly templateKey: string }
  | { readonly kind: 'refused'; readonly refusal: NoticeRefusal; readonly why: string }

/**
 * Whether the resolved template may carry a reassignment notice.
 *
 * `undefined` is a refusal and not an omission: a reassignment whose customer notice cannot be built is
 * a therapist swapped without the customer being told, and the reassign transaction refuses rather than
 * committing one. That direction is a decision with a cost — a template left in `draft` blocks every
 * reassignment until somebody approves it — and it is the right cost, because the appointment stays in
 * the reassignment queue where it already was, the refusal names the template, and the alternative is a
 * customer who finds out when a stranger opens the treatment-room door.
 */
export function judgeReassignmentNotice(
  resolved: ResolvedNoticeTemplate | undefined,
): NoticeVerdict {
  if (resolved === undefined) {
    return {
      kind: 'refused',
      refusal: 'notice_template_missing',
      why:
        `no current template for ${REASSIGNMENT_NOTICE_TEMPLATE_KEY}. It is a shipped default ` +
        '(`DEFAULT_TEMPLATES`), so an absent row means the corpus was never seeded into this database ' +
        'rather than that nobody wrote the words.',
    }
  }
  if (resolved.templateKey !== REASSIGNMENT_NOTICE_TEMPLATE_KEY) {
    return {
      kind: 'refused',
      refusal: 'notice_template_wrong',
      why:
        `the resolved template is "${resolved.templateKey}" and the reassignment notice is ` +
        `"${REASSIGNMENT_NOTICE_TEMPLATE_KEY}". Judging a row the caller read for another purpose ` +
        'would approve a send of whatever that row happens to say.',
    }
  }
  if (resolved.messageClass !== REASSIGNMENT_NOTICE_CLASS) {
    return {
      kind: 'refused',
      refusal: 'notice_not_transactional',
      why:
        `the template is ${resolved.messageClass} and a booking-change notice may only be sent as ` +
        `${REASSIGNMENT_NOTICE_CLASS}. A promotional class means the send is consent-gated, confined ` +
        'to 07:00-21:00 and leaves from the AD- identity, so a customer without a marketing grant ' +
        'would never be told their appointment changed.',
    }
  }
  if (resolved.approvalState !== 'approved') {
    return {
      kind: 'refused',
      refusal: 'notice_not_approved',
      why:
        `the template is ${resolved.approvalState}. The send choke point refuses an unapproved ` +
        'template with `template_not_approved` (C-AUTO-01), so emitting the notice against these ' +
        'words would enqueue a notification nothing can ever deliver.',
    }
  }
  return { kind: 'sendable', templateKey: resolved.templateKey }
}

/**
 * One entry of the reassignment queue, as the screen and the ordering rule see it.
 *
 * Ids and dates only. No customer name, no therapist name, no treatment: the queue is worked by staff
 * and the appointment it points at carries everything else.
 */
export interface ReassignmentQueueEntry {
  readonly appointmentId: string
  /** The treatment's start. The axis the queue is ordered on. */
  readonly startsAt: number
  readonly reason: string
  readonly documentType: string
}

/**
 * The queue's order: by the appointment's START, then by its id.
 *
 * By start and NOT by when the flag was raised, which is how `readLiveReassignmentFlags` orders the same
 * rows and is the right order for a different question: that reader answers "what has the sweep found",
 * newest problem last, and this one answers "what has to be dealt with first". An appointment tomorrow
 * evening is more urgent than one next month whose flag was raised first, and a queue ordered by
 * discovery buries it.
 *
 * The id is the tiebreak, and it is not decoration: two appointments legitimately start at the same
 * minute — a couple booking is two rows over one period — so a comparator that returned 0 for them
 * would leave the order to the sort's stability, which is a property of the input rather than of the
 * queue. `uuid_generate_v7` is time-ordered, so the tiebreak is "the one booked first".
 */
export function compareQueueEntries(a: ReassignmentQueueEntry, b: ReassignmentQueueEntry): number {
  if (a.startsAt !== b.startsAt) return a.startsAt - b.startsAt
  return a.appointmentId < b.appointmentId ? -1 : a.appointmentId > b.appointmentId ? 1 : 0
}

/** The queue in working order. A copy: the argument is not sorted in place. */
export function orderReassignmentQueue<T extends ReassignmentQueueEntry>(
  entries: readonly T[],
): readonly T[] {
  return [...entries].sort(compareQueueEntries)
}
