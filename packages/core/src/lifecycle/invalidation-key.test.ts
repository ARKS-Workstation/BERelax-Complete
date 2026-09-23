import {
  DEFAULT_REMINDER_OFFSETS_HOURS,
  MAX_REMINDER_OFFSET_HOURS,
  MAX_REMINDER_OFFSETS,
} from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  decideScheduledStep,
  invalidationKeyFor,
  REMINDER_STEP_TYPE_PATTERN,
  reminderOffsetsFrom,
  reminderPlanFor,
  reminderStepType,
  SCHEDULED_STEP_LATE_TOLERANCE_MINUTES,
  SCHEDULED_STEP_SKIP_REASONS,
  type ScheduledStepPeriod,
} from './invalidation-key.ts'

/**
 * B-MSG-03 — the key, the plan and the verdict, case by case.
 *
 * The 2,000-sequence property test lives beside this file in `invalidation-key.property.test.ts`; this one
 * holds the worked examples and the refusals, which a property test states as an invariant and cannot show.
 */
const APPOINTMENT = '9f1c4a2e-0000-4000-8000-00000000b301'
const OTHER_APPOINTMENT = '9f1c4a2e-0000-4000-8000-00000000b302'

/** Friday 2099-12-04, 19:00 to 19:45 Dubai — 15:00 to 15:45 UTC. */
const FRIDAY: ScheduledStepPeriod = {
  startsAtMs: Date.parse('2099-12-04T15:00:00.000Z'),
  endsAtMs: Date.parse('2099-12-04T15:45:00.000Z'),
}
/** The same treatment a day later. Every key over it differs from every key over FRIDAY. */
const SATURDAY: ScheduledStepPeriod = {
  startsAtMs: Date.parse('2099-12-05T15:00:00.000Z'),
  endsAtMs: Date.parse('2099-12-05T15:45:00.000Z'),
}

const step = (over: ScheduledStepPeriod, stepType = 'reminder_24h') => ({
  appointmentId: APPOINTMENT,
  stepType,
  invalidationKey: invalidationKeyFor({ appointmentId: APPOINTMENT, stepType, period: over }),
  sendAtMs: over.startsAtMs - 24 * 3_600_000,
})

const verdict = (args: {
  readonly over?: ScheduledStepPeriod
  readonly now?: ScheduledStepPeriod
  readonly atMs?: number
  readonly holdsResources?: boolean
  readonly contentAvailable?: boolean
}) => {
  const over = args.over ?? FRIDAY
  const now = args.now ?? over
  return decideScheduledStep({
    step: step(over),
    appointment: { period: now, holdsResources: args.holdsResources ?? true },
    atMs: args.atMs ?? over.startsAtMs - 24 * 3_600_000,
    contentAvailable: args.contentAvailable ?? true,
  })
}

describe('the invalidation key', () => {
  it('is a deterministic function of the appointment, the step type and the period', () => {
    const once = invalidationKeyFor({
      appointmentId: APPOINTMENT,
      stepType: 'reminder_24h',
      period: FRIDAY,
    })
    const again = invalidationKeyFor({
      appointmentId: APPOINTMENT,
      stepType: 'reminder_24h',
      period: { startsAtMs: FRIDAY.startsAtMs, endsAtMs: FRIDAY.endsAtMs },
    })
    expect(again).toBe(once)
    expect(once).toBe(
      `reminder_24h:${APPOINTMENT}:2099-12-04T15:00:00.000Z/2099-12-04T15:45:00.000Z`,
    )
  })

  it('changes when any one of the three inputs changes, and nothing else does', () => {
    const base = invalidationKeyFor({
      appointmentId: APPOINTMENT,
      stepType: 'reminder_24h',
      period: FRIDAY,
    })
    const otherAppointment = invalidationKeyFor({
      appointmentId: OTHER_APPOINTMENT,
      stepType: 'reminder_24h',
      period: FRIDAY,
    })
    const otherType = invalidationKeyFor({
      appointmentId: APPOINTMENT,
      stepType: 'reminder_2h',
      period: FRIDAY,
    })
    const otherPeriod = invalidationKeyFor({
      appointmentId: APPOINTMENT,
      stepType: 'reminder_24h',
      period: SATURDAY,
    })
    // A one-millisecond move is a different period. It has to be: a period is the identity of the slot,
    // and a key that rounded would let a nudged appointment keep a step built for the old one.
    const nudged = invalidationKeyFor({
      appointmentId: APPOINTMENT,
      stepType: 'reminder_24h',
      period: { startsAtMs: FRIDAY.startsAtMs + 1, endsAtMs: FRIDAY.endsAtMs },
    })
    expect(new Set([base, otherAppointment, otherType, otherPeriod, nudged]).size).toBe(5)
  })

  it('refuses a blank appointment id and a step type the database would refuse', () => {
    expect(() =>
      invalidationKeyFor({ appointmentId: '   ', stepType: 'reminder_24h', period: FRIDAY }),
    ).toThrow(/needs the appointment/)
    expect(() =>
      invalidationKeyFor({ appointmentId: APPOINTMENT, stepType: 'reminder', period: FRIDAY }),
    ).toThrow(/is not a step type/)
    expect(() =>
      invalidationKeyFor({
        appointmentId: APPOINTMENT,
        stepType: 'reminder_24h',
        period: { startsAtMs: Number.NaN, endsAtMs: FRIDAY.endsAtMs },
      }),
    ).toThrow(/not a finite instant/)
  })
})

describe('the reminder set', () => {
  it('labels each offset the way 0051 accepts, and refuses one outside the registry bounds', () => {
    expect(reminderStepType(24)).toBe('reminder_24h')
    expect(REMINDER_STEP_TYPE_PATTERN.test(reminderStepType(MAX_REMINDER_OFFSET_HOURS))).toBe(true)
    for (const bad of [0, -1, 1.5, MAX_REMINDER_OFFSET_HOURS + 1]) {
      expect(() => reminderStepType(bad), String(bad)).toThrow(/whole number of hours/)
    }
  })

  it('reads the stored setting, refusing anything it cannot read rather than defaulting', () => {
    expect(reminderOffsetsFrom([24, 2])).toEqual([24, 2])
    // Order is the plan's, not the typing's: [2, 24] and [24, 2] are the same set.
    expect(reminderOffsetsFrom([2, 24])).toEqual([24, 2])
    // The empty list is LEGAL and is how an owner turns reminders off. It must not read as corruption.
    expect(reminderOffsetsFrom([])).toEqual([])
    expect(reminderOffsetsFrom(DEFAULT_REMINDER_OFFSETS_HOURS as number[])).toEqual([24, 2])
    for (const bad of [
      null,
      undefined,
      24,
      '24',
      ['24'],
      [0],
      [MAX_REMINDER_OFFSET_HOURS + 1],
      [24, 24],
      Array.from({ length: MAX_REMINDER_OFFSETS + 1 }, (_value, index) => index + 1),
    ]) {
      expect(() => reminderOffsetsFrom(bad), JSON.stringify(bad ?? null)).toThrow(
        /is not a reminder set/,
      )
    }
  })

  it('plans one step per offset, each carrying the key of the period it was planned over', () => {
    const plan = reminderPlanFor({
      appointmentId: APPOINTMENT,
      period: FRIDAY,
      offsetsHours: [24, 2],
    })
    expect(plan.map((planned) => planned.stepType)).toEqual(['reminder_24h', 'reminder_2h'])
    expect(plan.map((planned) => new Date(planned.sendAtMs).toISOString())).toEqual([
      '2099-12-03T15:00:00.000Z',
      '2099-12-04T13:00:00.000Z',
    ])
    for (const planned of plan) {
      expect(planned.invalidationKey).toBe(
        invalidationKeyFor({
          appointmentId: APPOINTMENT,
          stepType: planned.stepType,
          period: FRIDAY,
        }),
      )
    }
  })

  it('keeps an offset with no notice left in the plan, so the miss can be counted', () => {
    // A booking taken three hours before the treatment has missed its 24-hour reminder. The step still
    // exists and is then skipped with a reason code, because "no row" cannot be counted and "skipped
    // because there was no time" can.
    const plan = reminderPlanFor({ appointmentId: APPOINTMENT, period: FRIDAY, offsetsHours: [24] })
    const [planned] = plan
    expect(planned?.sendAtMs).toBeLessThan(FRIDAY.startsAtMs)
    expect(
      reminderPlanFor({ appointmentId: APPOINTMENT, period: FRIDAY, offsetsHours: [] }),
    ).toEqual([])
    expect(() =>
      reminderPlanFor({
        appointmentId: APPOINTMENT,
        period: { startsAtMs: Number.NaN, endsAtMs: 1 },
        offsetsHours: [24],
      }),
    ).toThrow(/finite treatment start/)
  })
})

describe('the verdict on one due step', () => {
  it('sends a step whose key still matches, with no staleness note', () => {
    const answer = verdict({})
    expect(answer).toEqual({ kind: 'send', stalenessNote: null, lateByMinutes: 0 })
  })

  it('refuses a step built for a period the appointment no longer holds', () => {
    // The whole unit in one assertion: the step was built for Friday, the appointment is now Saturday,
    // and the step is due and the appointment is live. Every other check would pass it.
    const answer = verdict({ over: FRIDAY, now: SATURDAY })
    expect(answer.kind).toBe('skip')
    expect(answer.kind === 'skip' && answer.reason).toBe('invalidation_key_stale')
  })

  it('checks the key before anything else, so a stale step cannot be deferred instead', () => {
    const early = verdict({
      over: FRIDAY,
      now: SATURDAY,
      atMs: FRIDAY.startsAtMs - 40 * 3_600_000,
    })
    expect(early.kind === 'skip' && early.reason).toBe('invalidation_key_stale')
    const dead = verdict({ over: FRIDAY, now: SATURDAY, holdsResources: false })
    expect(dead.kind === 'skip' && dead.reason).toBe('invalidation_key_stale')
  })

  it('refuses a step on an appointment that no longer holds its resources', () => {
    const answer = verdict({ holdsResources: false })
    expect(answer.kind === 'skip' && answer.reason).toBe('appointment_not_live')
  })

  it('refuses a step whose treatment has already started', () => {
    const answer = verdict({ atMs: FRIDAY.startsAtMs })
    expect(answer.kind === 'skip' && answer.reason).toBe('send_window_missed')
  })

  it('defers a step that is not due, which is the one outcome that records nothing', () => {
    const answer = verdict({ atMs: FRIDAY.startsAtMs - 25 * 3_600_000 })
    expect(answer.kind).toBe('defer')
    expect(answer.kind === 'defer' && answer.why).toMatch(/stays pending/)
  })

  it('refuses a step whose message cannot be built, rather than sending it half-rendered', () => {
    const answer = verdict({ contentAvailable: false })
    expect(answer.kind === 'skip' && answer.reason).toBe('content_unavailable')
  })

  it('sends a step the outage made late, and records how late it was', () => {
    const due = FRIDAY.startsAtMs - 24 * 3_600_000
    const onTime = verdict({ atMs: due + SCHEDULED_STEP_LATE_TOLERANCE_MINUTES * 60_000 })
    expect(onTime).toEqual({
      kind: 'send',
      stalenessNote: null,
      lateByMinutes: SCHEDULED_STEP_LATE_TOLERANCE_MINUTES,
    })
    // Six hours: the outage in the acceptance criterion. The appointment is still eighteen hours away,
    // so the reminder is still worth sending — and the row says it was late.
    const afterOutage = verdict({ atMs: due + 6 * 3_600_000 })
    expect(afterOutage.kind).toBe('send')
    expect(afterOutage.kind === 'send' && afterOutage.lateByMinutes).toBe(360)
    expect(afterOutage.kind === 'send' && afterOutage.stalenessNote).toMatch(/360 minute\(s\)/)
  })

  it('names every skip reason 0051 accepts, and no others', () => {
    expect([...SCHEDULED_STEP_SKIP_REASONS]).toEqual([
      'invalidation_key_stale',
      'appointment_not_live',
      'send_window_missed',
      'content_unavailable',
      // The one the verdict never returns: the caller records it when the choke point did not hand the
      // message to a vendor. `decideScheduledStep` cannot reach it, which is asserted by the sweep over
      // every case above — none of them produces it.
      'send_refused',
    ])
  })
})
