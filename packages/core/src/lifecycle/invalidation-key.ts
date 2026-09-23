/**
 * The invalidation key, the reminder plan, and the verdict on one due step (B-MSG-03).
 *
 * ## The bug this file exists to make impossible
 *
 * A booking is confirmed for Friday 19:00 and a reminder is queued with a 24-hour delay. The customer
 * moves it to Saturday. The delayed job is still in the queue, still carrying the body it was built with,
 * and on Thursday evening it tells her to come tomorrow at seven. She arrives on the wrong day, the room
 * has been sold to somebody else, and nothing recorded a fault: the send succeeded, the receipt was
 * positive, every log line is green.
 *
 * No queue prevents that. A delayed job has no notion of a world that has changed, and a deduplication
 * key does not help because the job is not a duplicate — it is correct about a period that no longer
 * exists. The only thing that can refuse it is a check made at the MOMENT of sending, against the
 * appointment as it is then. {@link invalidationKeyFor} is that check in one comparable value, and
 * {@link decideScheduledStep} is the moment it is made.
 *
 * ## Why a key and not a period comparison
 *
 * Because the key travels. It goes into the `scheduled_step` row, into `appointment.rescheduled`'s outbox
 * payload (B-LIFE-03 already carries it), into the audit row and into a log line — and at every one of
 * those points it is compared by equality, with no reader needing to know how a `tstzrange` renders or
 * which of its bounds is inclusive. A period comparison spread across four readers is four chances to
 * spell it differently.
 *
 * The key is an opaque token: it is compared, never parsed. Its shape is chosen so that a person reading
 * a log can see at a glance which appointment and which period a step was built for, because that is the
 * question asked of it when something has gone wrong.
 *
 * ## Why the key is deliberately NOT unique
 *
 * Reschedule Friday to Saturday and back to Friday. The final period is the original one, so the key
 * re-derives to exactly the string the first — now superseded — step holds. That is correct: the key
 * answers "is this step still about the appointment's current period?" and nothing else. It answers
 * nothing about WHICH row to send, which is the row's own identity and its own state. Migration 0051's
 * partial unique index on `(appointment_id, step_type) where state = 'pending'` is what makes "exactly one
 * live step per step type" true, and its resurrection trigger is what stops the superseded row coming
 * back. Putting that job on the key instead would refuse a legal reschedule.
 *
 * ## Pure, and the instant is an argument
 *
 * `packages/core` reads no clock (`pnpm purity`), which is the whole reason the outage case is testable:
 * "the step was due six hours ago" is a pair of numbers passed in, so the assertion reads the same at
 * 03:00 as at noon.
 */
import {
  AppError,
  MAX_REMINDER_OFFSET_HOURS,
  MAX_REMINDER_OFFSETS,
  REMINDER_OFFSETS_SETTING_KEY,
} from '@berelax/shared'

/**
 * A step type label, as 0051's CHECK constraint accepts it.
 *
 * The type is derived from the offset rather than drawn from a fixed enum, and that is what makes the
 * acceptance criterion about a timing change producing NEW KEYS true: the label is part of the key, so
 * moving the reminder from 24 hours to 48 changes every key of every pending step.
 */
export const REMINDER_STEP_TYPE_PATTERN = /^reminder_[1-9][0-9]{0,2}h$/

/** `reminder_24h`. The one place the label is spelled, so the SQL pattern has a single counterpart. */
export function reminderStepType(offsetHours: number): string {
  if (
    !Number.isInteger(offsetHours) ||
    offsetHours < 1 ||
    offsetHours > MAX_REMINDER_OFFSET_HOURS
  ) {
    throw new AppError(
      'validation',
      `A reminder offset must be a whole number of hours between 1 and ${MAX_REMINDER_OFFSET_HOURS}, ` +
        `not ${JSON.stringify(offsetHours)}. 0051 refuses a step type outside that range, so an ` +
        'unbounded offset would schedule a reminder for a year before the booking.',
      { details: { offsetHours } },
    )
  }
  return `reminder_${offsetHours}h`
}

/**
 * The stored setting value, validated.
 *
 * Refuses rather than coercing, and refuses rather than falling back to the default. A corrupt stored
 * value and a deliberate empty list ("remind nobody") must not read the same: the empty list is legal and
 * is exactly how an owner turns reminders off, so `[]` is accepted and anything malformed is a named
 * failure. `Number(null)` is 0, which is why nothing here goes through `Number`.
 */
export function reminderOffsetsFrom(value: unknown): readonly number[] {
  const refuse = (why: string): never => {
    throw new AppError(
      'validation',
      `${REMINDER_OFFSETS_SETTING_KEY} is not a reminder set: ${why}. A stored value this rule cannot ` +
        'read is not defaulted away, because a corrupt value and a deliberate empty list would then be ' +
        'indistinguishable — and the empty list is how an owner turns reminders off.',
      { details: { value } },
    )
  }
  if (!Array.isArray(value)) return refuse('it is not an array')
  if (value.length > MAX_REMINDER_OFFSETS) {
    return refuse(
      `it declares ${value.length} reminders and the ceiling is ${MAX_REMINDER_OFFSETS}`,
    )
  }
  const offsets: number[] = []
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) {
      return refuse(`${JSON.stringify(entry)} is not a whole number of hours`)
    }
    if (entry < 1 || entry > MAX_REMINDER_OFFSET_HOURS) {
      return refuse(`${entry} is outside 1 to ${MAX_REMINDER_OFFSET_HOURS} hours`)
    }
    if (offsets.includes(entry)) return refuse(`${entry} appears twice`)
    offsets.push(entry)
  }
  // Descending, so the plan reads in the order the customer receives it: the 24-hour reminder before the
  // 2-hour one. The stored value's order is not trusted for that — an owner typing [2, 24] means the same
  // set, and a plan whose order depended on the typing would make the row order in the table arbitrary.
  return Object.freeze([...offsets].sort((a, b) => b - a))
}

/**
 * The appointment period, as two epoch-millisecond instants.
 *
 * Milliseconds rather than a `Date` pair, for the reason every other boundary in this package takes them:
 * a number is comparable, serialisable and has one spelling. `timestamptz` holds microseconds, but every
 * period in this system is written from a millisecond-precision ISO string, so the truncation below is a
 * no-op on real rows rather than a lossy normalisation — and it is here so that a row somehow carrying
 * microseconds produces a STABLE key instead of one that depends on which reader rendered it.
 */
export interface ScheduledStepPeriod {
  readonly startsAtMs: number
  readonly endsAtMs: number
}

const isFiniteInstant = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isoOf = (epochMs: number, label: string): string => {
  if (!isFiniteInstant(epochMs)) {
    throw new AppError(
      'validation',
      `${label} is not a finite instant (${JSON.stringify(epochMs)}). An invalidation key derived from ` +
        'NaN would compare equal to nothing and every step would be refused as stale.',
      { details: { label, epochMs } },
    )
  }
  return new Date(Math.trunc(epochMs)).toISOString()
}

export interface InvalidationKeyRequest {
  readonly appointmentId: string
  /** `reminder_24h`. Validated, because a key over a label 0051 refuses can never match a stored row. */
  readonly stepType: string
  readonly period: ScheduledStepPeriod
}

/**
 * The key. `reminder_24h:<appointment id>:<start>/<end>`, in UTC, to the millisecond.
 *
 * Deterministic in the strong sense: the same three inputs give the same string in any process, on any
 * machine, in any order, for ever. Not a hash, deliberately — a sha256 prefix would be the same length
 * whatever went into it and would tell a person reading a log nothing about which period fired.
 */
export function invalidationKeyFor(request: InvalidationKeyRequest): string {
  const appointmentId = request.appointmentId.trim()
  if (appointmentId === '') {
    throw new AppError(
      'validation',
      'An invalidation key needs the appointment it belongs to. A key with a blank id would be shared ' +
        'by every appointment with the same period, which is the opposite of what it is for.',
    )
  }
  if (!REMINDER_STEP_TYPE_PATTERN.test(request.stepType)) {
    throw new AppError(
      'validation',
      `'${request.stepType}' is not a step type (${String(REMINDER_STEP_TYPE_PATTERN)}). 0051 refuses ` +
        'the label, so a key built over one could never match a stored step and every send would be ' +
        'refused as stale — a silent failure wearing a safe answer.',
      { details: { stepType: request.stepType } },
    )
  }
  const startsAt = isoOf(request.period.startsAtMs, 'the period start')
  const endsAt = isoOf(request.period.endsAtMs, 'the period end')
  return `${request.stepType}:${appointmentId}:${startsAt}/${endsAt}`
}

/** One step the plan says should exist. */
export interface PlannedScheduledStep {
  readonly stepType: string
  readonly offsetHours: number
  readonly sendAtMs: number
  readonly invalidationKey: string
}

export interface ReminderPlanRequest {
  readonly appointmentId: string
  readonly period: ScheduledStepPeriod
  /** From {@link reminderOffsetsFrom}. An empty set is a legal answer and plans nothing. */
  readonly offsetsHours: readonly number[]
}

/**
 * The reminder set an appointment should have, given the period it currently holds.
 *
 * The send instant is the treatment start minus the offset, which is why it moves with the period and why
 * a moved appointment produces NEW ROWS rather than an UPDATE of `send_at`: a row whose send instant was
 * edited in place would keep the key it was inserted with, and the key is the only thing standing between
 * the schedule and the bug at the top of this file.
 *
 * An offset larger than the notice available produces a send instant in the PAST, and that is left in the
 * plan on purpose rather than filtered out. A booking taken three hours before the treatment really does
 * want its 2-hour reminder and really has missed its 24-hour one, and the row for the missed one is what
 * makes the miss countable: it is drained like any other and answered by {@link decideScheduledStep} — sent
 * late with a recorded note if the treatment has not begun, `send_window_missed` if it has. "No row" and
 * "a row that says why it went out late" are different facts and only the second one can be reported on.
 *
 * The one case the plan can produce and the table cannot hold is a send instant AT or after the treatment
 * start, which 0051's trigger refuses — a "reminder" arriving after the massage. It is unreachable for
 * every offset of an hour or more, and `buildScheduledSteps` leaves such a step out rather than letting the
 * trigger refuse the booking that carried it.
 */
export function reminderPlanFor(request: ReminderPlanRequest): readonly PlannedScheduledStep[] {
  const startsAtMs = Math.trunc(request.period.startsAtMs)
  if (!isFiniteInstant(startsAtMs)) {
    throw new AppError('validation', 'A reminder plan needs a finite treatment start.', {
      details: { period: request.period },
    })
  }
  return Object.freeze(
    request.offsetsHours.map((offsetHours) => {
      const stepType = reminderStepType(offsetHours)
      return Object.freeze({
        stepType,
        offsetHours,
        sendAtMs: startsAtMs - offsetHours * 3_600_000,
        invalidationKey: invalidationKeyFor({
          appointmentId: request.appointmentId,
          stepType,
          period: request.period,
        }),
      })
    }),
  )
}

/**
 * Every reason a step is settled without a message.
 *
 * A CLOSED set, and 0051's CHECK constraint holds the same list, because this column is what a report
 * groups by: "how many reminders did we skip last month, and why" is answerable over a vocabulary and
 * unanswerable over free text.
 *
 * The last one is not a verdict {@link decideScheduledStep} can reach — it is what the caller records when
 * the send choke point did not hand the message to a vendor. The vocabulary belongs to the COLUMN rather
 * than to this function, which is why it is longer than the verdict union.
 */
export const SCHEDULED_STEP_SKIP_REASONS = [
  /** The stored key disagrees with the key the appointment's current period derives. THE case. */
  'invalidation_key_stale',
  /** The appointment no longer holds its resources: cancelled, a no-show, or superseded. */
  'appointment_not_live',
  /** The treatment has already started. A reminder that arrives afterwards is not a reminder. */
  'send_window_missed',
  /** The message could not be built. See {@link ScheduledStepVerdictRequest.contentAvailable}. */
  'content_unavailable',
  /**
   * The message was built and the choke point did not hand it to a vendor.
   *
   * Two causes, and neither is a rendering failure: a promotional gate refusal, or F03's staging guard
   * diverting it to the local outbox because `APP_ENV` is not production and the recipient is not
   * allowlisted. Neither writes a `message` row (B-MSG-04's stated rule), so there is nothing for the step
   * to point at — and the second is the ORDINARY case on every staging worker, which is why recording it
   * as `content_unavailable` would be wrong rather than merely imprecise.
   */
  'send_refused',
] as const
export type ScheduledStepSkipReason = (typeof SCHEDULED_STEP_SKIP_REASONS)[number]

/** The five states 0051 declares. `pending` is the only one that is not terminal. */
export const SCHEDULED_STEP_STATES = [
  'pending',
  'sent',
  'skipped',
  'superseded',
  'cancelled',
] as const
export type ScheduledStepState = (typeof SCHEDULED_STEP_STATES)[number]

/**
 * How late a send may be before it is worth recording as late.
 *
 * Thirty minutes, and the figure is chosen against the sweep rather than by feel: the due sweep runs every
 * fifteen minutes (`reminder_scheduler`'s declared interval in 0021), so up to one sweep of lateness is
 * the design working normally. Two sweeps is the point at which something did not run — a deploy, a
 * restart, a machine that was asleep — and that is what the note is for. A tolerance shorter than the
 * sweep would put a note on every message ever sent, which is a note nobody reads.
 */
export const SCHEDULED_STEP_LATE_TOLERANCE_MINUTES = 30

/** The step, as much of it as the verdict needs. */
export interface ScheduledStepFacts {
  readonly appointmentId: string
  readonly stepType: string
  readonly invalidationKey: string
  readonly sendAtMs: number
}

/** The appointment, as it is NOW — read under the step's row lock, never remembered from earlier. */
export interface ScheduledStepAppointmentFacts {
  readonly period: ScheduledStepPeriod
  /** `appointment.holds_resources` (0024): false for both cancellations, a no-show and a reschedule. */
  readonly holdsResources: boolean
}

export interface ScheduledStepVerdictRequest {
  readonly step: ScheduledStepFacts
  readonly appointment: ScheduledStepAppointmentFacts
  readonly atMs: number
  /**
   * Whether the message can actually be built: a recipient, a template and every declared variable.
   *
   * An argument rather than something decided here, because it is not a rule — it is a fact about the
   * runtime. It is false in the shipped worker today, and the reason is recorded in
   * `apps/worker/src/jobs/send-scheduled-step.ts`: the reminder body's `{{link}}` is a magic link and
   * B-UI-02 owns magic links. Rendering a blank there is refused by B-MSG-01's allowlist, and inventing a
   * URL would be a plausible value indistinguishable from a configured one (brief rule 15). So the step
   * is skipped with a recorded reason, which is visible, rather than sent with a link to nothing.
   */
  readonly contentAvailable: boolean
}

/**
 * What to do with one step, right now.
 *
 * Three kinds and no fourth, and only one of them writes nothing. `defer` is not a failure and not a
 * silence: the step is not due yet, and a `pending` row IS the record of that — which is why the acceptance
 * criterion about "no step ends in a silent unrecorded state" is asked of steps whose send instant has
 * PASSED. `send` covers two cases in one, on time and late, because both hand the same message to the same
 * vendor; the difference is the note the row carries afterwards.
 */
export type ScheduledStepVerdict =
  | {
      readonly kind: 'send'
      /** Set only when the send is later than the tolerance allows. Recorded on the row. */
      readonly stalenessNote: string | null
      readonly lateByMinutes: number
    }
  | {
      readonly kind: 'skip'
      readonly reason: ScheduledStepSkipReason
      readonly why: string
    }
  | { readonly kind: 'defer'; readonly why: string }

const minutesBetween = (later: number, earlier: number): number =>
  Math.floor((later - earlier) / 60_000)

/**
 * The verdict. The key is checked FIRST, and the order is the point.
 *
 * Staleness is the damaging case, so nothing else may get to decide before it: a stale step attached to a
 * live appointment that is due right now passes every other test in this function, and it is exactly the
 * message that puts the customer in the salon on the wrong day. Checking it first also means `defer`
 * cannot mask it — a stale step that is not yet due is still refused rather than left to be refused later.
 *
 * Then, in this order: the appointment must still be live; the treatment must not have started; the step
 * must actually be due, which is the one outcome that writes nothing; and the message must be buildable.
 * Each skip carries its own reason code, because "we did not remind her" and "we did not remind her
 * because she had cancelled" are different answers to the same question.
 *
 * The start check sits before the due check and cannot hide it: every offset is at least an hour, so a
 * step's send instant is always before the treatment start, and a step that is not yet due therefore
 * cannot be one whose treatment has begun.
 */
export function decideScheduledStep(request: ScheduledStepVerdictRequest): ScheduledStepVerdict {
  const { step, appointment, atMs } = request
  const expected = invalidationKeyFor({
    appointmentId: step.appointmentId,
    stepType: step.stepType,
    period: appointment.period,
  })
  if (step.invalidationKey !== expected) {
    return {
      kind: 'skip',
      reason: 'invalidation_key_stale',
      why:
        `the step was built for a different period: it carries '${step.invalidationKey}' and the ` +
        `appointment's current period derives '${expected}'. Sending it would tell the customer to ` +
        'arrive at a time that no longer exists.',
    }
  }
  if (!appointment.holdsResources) {
    return {
      kind: 'skip',
      reason: 'appointment_not_live',
      why:
        'the appointment no longer holds its therapist and its room, so it was cancelled, marked a ' +
        'no-show or superseded. There is nothing to remind anybody about.',
    }
  }
  if (atMs >= Math.trunc(appointment.period.startsAtMs)) {
    return {
      kind: 'skip',
      reason: 'send_window_missed',
      why:
        'the treatment has already started. A reminder arriving now is not a reminder; it is a message ' +
        'about an appointment the customer either attended or missed, and either way it reads as a ' +
        'system that has lost track of them.',
    }
  }
  if (atMs < Math.trunc(step.sendAtMs)) {
    return {
      kind: 'defer',
      why:
        `the step is due at ${isoOf(step.sendAtMs, 'the send instant')} and it is now ` +
        `${isoOf(atMs, 'the current instant')}. It stays pending, which is the record of that.`,
    }
  }
  if (!request.contentAvailable) {
    return {
      kind: 'skip',
      reason: 'content_unavailable',
      why:
        'the message could not be built — a recipient, a template or a declared variable is missing. ' +
        'Recorded rather than retried for ever, and never sent half-rendered: a body with a blank in ' +
        'it sends successfully and is reported as delivered.',
    }
  }
  const lateByMinutes = Math.max(0, minutesBetween(atMs, Math.trunc(step.sendAtMs)))
  const late = lateByMinutes > SCHEDULED_STEP_LATE_TOLERANCE_MINUTES
  return {
    kind: 'send',
    lateByMinutes,
    stalenessNote: late
      ? `sent ${lateByMinutes} minute(s) after its send instant, which is past the ` +
        `${SCHEDULED_STEP_LATE_TOLERANCE_MINUTES}-minute tolerance. The step was still about the ` +
        "appointment's current period, so it was sent rather than dropped — a dropped reminder is " +
        'indistinguishable from one that was never scheduled.'
      : null,
  }
}
