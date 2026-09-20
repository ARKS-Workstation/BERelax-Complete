import { describe, expect, it } from 'vitest'
import type { AuditWriter } from '../audit.ts'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import type { TransitionActor, TransitionDecider } from './appointment-transition.ts'
import {
  CANCELLATION_REFUSALS,
  CANCELLATION_STATUSES,
  type CancelDeps,
  type CancellationPolicy,
  cancelAppointment,
  cancellationRefusalOf,
  markNoShow,
  type NoShowClockCheck,
  type NoShowDeps,
} from './cancel.ts'

/**
 * The half of cancellation and the no-show that needs no database.
 *
 * The flag, its whole-or-nothing constraint, the all-or-none boundary and the zero row counts are properties
 * of PostgreSQL and belong to `packages/fixtures/src/appointment-reschedule.itest.ts`. What is here is the
 * two fail-closed guards, asserted with a **unit of work whose every statement throws** — so "refused before
 * anything was written" is a property of the test.
 */

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

const ACTOR: TransitionActor = { kind: 'staff', role: 'manager', label: 'cancel unit test' }
const APPOINTMENT = '00000000-0000-4000-8000-0000000000e1'
const NOW = Date.parse('2099-11-06T15:00:00.000Z')

const decide: TransitionDecider = () => ({
  kind: 'refused',
  refusal: 'illegal_transition',
  why: 'the unit test never reaches the decider',
})
const classify: CancellationPolicy = () => ({
  late: true,
  windowHours: 24,
  noticeMinutes: 60,
  chargeFils: 0,
})
const clock: NoShowClockCheck = () => ({ kind: 'allowed', minutesSinceStart: 1 })

const refusalFrom = async (promise: Promise<unknown>): Promise<string | null> => {
  try {
    await promise
    return null
  } catch (err) {
    return cancellationRefusalOf(err)
  }
}

describe('the cancellation guards fail closed', () => {
  it('refuses a cancellation with no policy injected, rather than recording it as on time', async () => {
    // The permissive default — "not late" — is the one that quietly stops the flag ever being set, and a
    // flag that is never set is indistinguishable from a salon with no late cancellations.
    expect(
      await refusalFrom(
        cancelAppointment(
          unusableUow(),
          { appointmentId: APPOINTMENT, to: 'cancelled_by_customer', actor: ACTOR, nowMs: NOW },
          { decide } as unknown as CancelDeps,
        ),
      ),
    ).toBe('cancellation_not_classified')
  })

  it('refuses when the policy is not a function at all', async () => {
    expect(
      await refusalFrom(
        cancelAppointment(
          unusableUow(),
          { appointmentId: APPOINTMENT, to: 'cancelled_by_salon', actor: ACTOR, nowMs: NOW },
          { decide, classify: 24 as unknown as CancellationPolicy },
        ),
      ),
    ).toBe('cancellation_not_classified')
  })

  it('reaches the database once a policy is injected, which is the control', async () => {
    const error = await cancelAppointment(
      unusableUow(),
      { appointmentId: APPOINTMENT, to: 'cancelled_by_customer', actor: ACTOR, nowMs: NOW },
      { decide, classify },
    ).catch((err: unknown) => err)
    expect((error as Error).message).toContain('issued a statement')
    expect(cancellationRefusalOf(error)).toBeNull()
  })
})

describe('the no-show clock guard fails closed', () => {
  it('refuses a no-show with no clock guard injected', async () => {
    // Without the guard a no-show is markable against tomorrow's appointment, and the row reads exactly
    // like a real one — which is why the absence has to be a refusal rather than a default.
    expect(
      await refusalFrom(
        markNoShow(unusableUow(), { appointmentId: APPOINTMENT, actor: ACTOR, nowMs: NOW }, {
          decide,
        } as unknown as NoShowDeps),
      ),
    ).toBe('no_show_clock_not_checked')
  })

  it('reaches the database once a clock guard is injected, which is the control', async () => {
    const error = await markNoShow(
      unusableUow(),
      { appointmentId: APPOINTMENT, actor: ACTOR, nowMs: NOW },
      { decide, clock },
    ).catch((err: unknown) => err)
    expect((error as Error).message).toContain('issued a statement')
  })
})

describe('the vocabularies', () => {
  it('keeps the two cancellations distinct, with no shared cancelled label', () => {
    expect([...CANCELLATION_STATUSES]).toEqual(['cancelled_by_customer', 'cancelled_by_salon'])
    expect(CANCELLATION_STATUSES).not.toContain('cancelled')
  })

  it('declares its refusals as a closed list of values', () => {
    expect(new Set(CANCELLATION_REFUSALS).size).toBe(CANCELLATION_REFUSALS.length)
    expect(cancellationRefusalOf(new Error('a disk failure is not an unstarted appointment'))).toBe(
      null,
    )
  })
})
