import { describe, expect, it } from 'vitest'
import type { AuditWriter } from '../audit.ts'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import type { TransitionActor, TransitionDecider } from './appointment-transition.ts'
import type { SlotRecheck } from './create-booking.ts'
import {
  RESCHEDULE_REFUSALS,
  type RescheduleDeps,
  type RescheduleInput,
  rescheduleAppointment,
  rescheduleRefusalOf,
  type TradingDateResolver,
} from './reschedule.ts'

/**
 * The half of the reschedule that needs no database.
 *
 * The room lock, the release-then-acquire order, the exclusion constraint and the five records committing
 * together are properties of PostgreSQL and cannot be tested against a mock — those are
 * `packages/fixtures/src/appointment-reschedule.itest.ts`, against a real server with core's own rules
 * injected. What is here is everything decided *before* a statement is issued, asserted with a **unit of
 * work that fails if it is used**, so "refused before anything was written" is a property of the test rather
 * than a claim in a comment.
 */

/** A unit of work whose every statement throws. Using it is the failure the assertions are about. */
function unusableUow(): UnitOfWork {
  const explode = () => {
    throw new Error('the transaction issued a statement after it should have refused the request')
  }
  return {
    sql: explode as unknown as Sql,
    audit: { record: explode } as unknown as AuditWriter,
    publish: explode,
  }
}

const ACTOR: TransitionActor = { kind: 'staff', role: 'manager', label: 'reschedule unit test' }
const APPOINTMENT = '00000000-0000-4000-8000-0000000000d1'
const AT = Date.parse('2099-11-06T15:00:00.000Z')

const decide: TransitionDecider = () => ({
  kind: 'allowed',
  transition: {
    from: 'confirmed',
    to: 'rescheduled',
    permission: 'booking:reschedule',
    eventType: 'appointment.rescheduled',
    emitsRevenue: false,
    reasonRequired: true,
    why: 'the unit test never reaches the decider',
  },
})
const recheck: SlotRecheck = () => ({
  kind: 'assigned',
  roomId: 'room',
  therapistIds: ['therapist'],
  placesUsed: 1,
})
const resolveTradingDate: TradingDateResolver = () => ({
  kind: 'trading',
  tradingDate: '2099-11-06',
})

const DEPS: RescheduleDeps = { decide, recheck, resolveTradingDate }

const input = (overrides: Partial<RescheduleInput> = {}): RescheduleInput => ({
  appointmentId: APPOINTMENT,
  actor: ACTOR,
  reason: 'the client asked to come an hour later',
  treatment: { startsAt: AT, endsAt: AT + 45 * 60_000 },
  ...overrides,
})

const refusalFrom = async (promise: Promise<unknown>): Promise<string | null> => {
  try {
    await promise
    return null
  } catch (err) {
    return rescheduleRefusalOf(err)
  }
}

describe('the refusals raised before a statement is issued', () => {
  it('refuses when no slot re-check was injected, rather than assuming the slot is free', async () => {
    // Fail closed, exactly as `createBooking` does. A reschedule written with nothing re-applying the
    // availability rule is a reschedule nobody checked — and the old period has already been released.
    expect(
      await refusalFrom(
        rescheduleAppointment(unusableUow(), input(), {
          decide,
          resolveTradingDate,
        } as unknown as RescheduleDeps),
      ),
    ).toBe('slot_not_revalidated')
  })

  it('refuses when the re-check is not a function at all', async () => {
    expect(
      await refusalFrom(
        rescheduleAppointment(unusableUow(), input(), {
          decide,
          resolveTradingDate,
          recheck: 'yes' as unknown as SlotRecheck,
        }),
      ),
    ).toBe('slot_not_revalidated')
  })

  it('refuses when no trading-date resolver was injected', async () => {
    // Trading runs 11:00-02:00, so 01:30 belongs to the PREVIOUS trading date. A reschedule that filed
    // itself under a date nobody resolved puts the late-night move on tomorrow's rota and cash-up.
    expect(
      await refusalFrom(
        rescheduleAppointment(unusableUow(), input(), {
          decide,
          recheck,
        } as unknown as RescheduleDeps),
      ),
    ).toBe('trading_date_not_resolved')
  })

  it('refuses a period that ends before it starts, and one of zero length', async () => {
    expect(
      await refusalFrom(
        rescheduleAppointment(
          unusableUow(),
          input({ treatment: { startsAt: AT, endsAt: AT - 60_000 } }),
          DEPS,
        ),
      ),
    ).toBe('new_period_invalid')
    expect(
      await refusalFrom(
        rescheduleAppointment(
          unusableUow(),
          input({ treatment: { startsAt: AT, endsAt: AT } }),
          DEPS,
        ),
      ),
    ).toBe('new_period_invalid')
  })

  it('reaches the database for a well-formed request, which is the control', async () => {
    // The control every case above needs: with nothing wrong, the function DOES issue a statement — so
    // each refusal is the argument it names rather than a guard that rejects everything.
    const error = await rescheduleAppointment(unusableUow(), input(), DEPS).catch(
      (err: unknown) => err,
    )
    expect((error as Error).message).toContain('issued a statement')
    expect(rescheduleRefusalOf(error)).toBeNull()
  })
})

describe('the refusal vocabulary', () => {
  it('is a closed list of values a caller can branch on', () => {
    expect(new Set(RESCHEDULE_REFUSALS).size).toBe(RESCHEDULE_REFUSALS.length)
    // `slot_taken` is deliberately the same name `createBooking` uses: it is the same fact, and
    // `bookingError` — reused for the SQLSTATE translation — produces exactly that name.
    expect(RESCHEDULE_REFUSALS).toContain('slot_taken')
  })

  it('answers null for an error that carries no refusal', () => {
    expect(rescheduleRefusalOf(new Error('a disk failure is not a taken slot'))).toBeNull()
    expect(rescheduleRefusalOf(undefined)).toBeNull()
  })

  it('translates a therapist exclusion violation into slot_taken', () => {
    // 23P01 on `appointment` can only be `appointment_therapist_no_overlap`: it is the only EXCLUDE on the
    // table. A caller branching on the refusal must not have to know the SQLSTATE.
    const exclusion = Object.assign(new Error('conflicting key value'), {
      code: '23P01',
      constraint_name: 'appointment_therapist_no_overlap',
    })
    expect(rescheduleRefusalOf(exclusion)).toBe('slot_taken')
  })
})
