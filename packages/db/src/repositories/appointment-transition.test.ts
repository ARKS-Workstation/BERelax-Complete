import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import type { AuditWriter } from '../audit.ts'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import {
  TRANSITION_REFUSALS,
  type TransitionActor,
  type TransitionDecider,
  type TransitionDecision,
  type TransitionInput,
  transitionAppointment,
  transitionRefusalOf,
} from './appointment-transition.ts'

/**
 * The half of the transition write path that needs no database.
 *
 * The row lock, the trigger, the history read-back and the four records committing together are
 * properties of PostgreSQL and cannot be tested against a mock — those are
 * `packages/fixtures/src/appointment-lifecycle.itest.ts`, against a real server and with core's own table
 * injected. What is here is everything that decides *before* a statement is issued, and it is asserted
 * with a **unit of work that fails if it is used**, so "refused before anything was written" is a
 * property of the test rather than a claim in a comment.
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

const ACTOR: TransitionActor = { kind: 'staff', role: 'manager', label: 'gate probe' }
const APPOINTMENT = '00000000-0000-4000-8000-0000000000a7'

const input = (overrides: Partial<TransitionInput> = {}): TransitionInput => ({
  appointmentId: APPOINTMENT,
  to: 'confirmed',
  actor: ACTOR,
  ...overrides,
})

/** A decider that answers one fixed verdict and records what it was asked. */
const decider = (
  decision: TransitionDecision,
  seen: { from?: string; to?: string; role?: string; reason?: string | null } = {},
): TransitionDecider => {
  return (from, to, role, reason) => {
    seen.from = from
    seen.to = to
    seen.role = role
    seen.reason = reason
    return decision
  }
}

const refusalFrom = async (promise: Promise<unknown>): Promise<string | null> => {
  try {
    await promise
    return null
  } catch (err) {
    return transitionRefusalOf(err)
  }
}

describe('the refusals raised before a statement is issued', () => {
  it('refuses a call with no decider, rather than assuming the move was fine', async () => {
    // Fail closed, exactly as `createBooking` refuses without its slot re-check. A transition written
    // with nothing applying the table is a transition nobody judged.
    expect(
      await refusalFrom(
        transitionAppointment(
          unusableUow(),
          input(),
          {} as unknown as { decide: TransitionDecider },
        ),
      ),
    ).toBe('transition_not_decided')
  })

  it('refuses when the decider is not a function at all', async () => {
    expect(
      await refusalFrom(
        transitionAppointment(unusableUow(), input(), {
          decide: 'yes' as unknown as TransitionDecider,
        }),
      ),
    ).toBe('transition_not_decided')
  })

  it('reports the refusal as an invariant violation, not as a 500', async () => {
    try {
      await transitionAppointment(unusableUow(), input(), {
        decide: undefined as unknown as TransitionDecider,
      })
      expect.unreachable('should have refused')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).kind).toBe('invariant_violated')
      expect((err as AppError).details['refusal']).toBe('transition_not_decided')
      // Named in the message too: the caller who sees only a log needs the reason in the line.
      expect((err as AppError).message).toContain('transition_not_decided')
    }
  })
})

describe('the refusal names are values a caller can branch on', () => {
  it('lists every refusal exactly once and names each one in the error it carries', () => {
    expect(new Set(TRANSITION_REFUSALS).size).toBe(TRANSITION_REFUSALS.length)
    expect([...TRANSITION_REFUSALS]).toEqual([
      'appointment_not_found',
      'illegal_transition',
      'transition_forbidden',
      'already_in_status',
      'reason_required',
      'transition_not_decided',
      'transition_not_recorded',
      'event_not_enqueued',
    ])
  })

  it('answers null for an error that is not a refusal, rather than guessing', () => {
    // The control for `transitionRefusalOf`. A translator that answered something for every error
    // would send the front desk looking for a booking problem when the disk filled up.
    expect(transitionRefusalOf(new Error('connection reset'))).toBeNull()
    expect(transitionRefusalOf(new AppError('conflict', 'something else entirely'))).toBeNull()
    expect(transitionRefusalOf(null)).toBeNull()
    expect(
      transitionRefusalOf(
        new AppError('conflict', 'x', { details: { refusal: 'illegal_transition' } }),
      ),
    ).toBe('illegal_transition')
  })
})

describe("the decider's refusal is carried through with its context", () => {
  /**
   * A unit of work that answers the appointment read and then fails on anything else.
   *
   * The refusals below are raised after ONE statement — the locking read — so the fake answers exactly
   * that and explodes on the update, the audit row and the publish. A test that allowed all of them
   * would not be able to say a refusal wrote nothing.
   */
  function readOnlyUow(status: string): UnitOfWork {
    let reads = 0
    const sql = ((): unknown => {
      reads += 1
      if (reads === 1) {
        return Promise.resolve([
          {
            id: APPOINTMENT,
            booking_id: '00000000-0000-4000-8000-0000000000b7',
            status,
            trading_date: '2099-11-04',
            gross_price_fils: '20000',
            net_fils: '19048',
            vat_fils: '952',
            vat_rate_bp: 500,
          },
        ])
      }
      throw new Error(`statement ${reads} was issued after the request should have been refused`)
    }) as unknown as Sql
    return {
      sql,
      audit: {
        record: () => {
          throw new Error('an audit row was written for a refused transition')
        },
      } as unknown as AuditWriter,
      publish: () => {
        throw new Error('an event was published for a refused transition')
      },
    }
  }

  const refusalCases = [
    { refusal: 'illegal_transition', kind: 'conflict' },
    { refusal: 'transition_forbidden', kind: 'forbidden' },
    { refusal: 'already_in_status', kind: 'conflict' },
    { refusal: 'reason_required', kind: 'validation' },
  ] as const

  for (const { refusal, kind } of refusalCases) {
    it(`reports ${refusal} as a ${kind} and writes nothing`, async () => {
      const decide = decider({
        kind: 'refused',
        refusal,
        why: `the table says ${refusal}`,
        permittedRoles: ['owner', 'manager'],
      })
      try {
        await transitionAppointment(readOnlyUow('confirmed'), input({ to: 'completed' }), {
          decide,
        })
        expect.unreachable('should have refused')
      } catch (err) {
        expect(err).toBeInstanceOf(AppError)
        expect((err as AppError).kind).toBe(kind)
        expect(transitionRefusalOf(err)).toBe(refusal)
        const details = (err as AppError).details
        // The context a caller needs to explain the refusal without re-reading the row.
        expect(details['from']).toBe('confirmed')
        expect(details['to']).toBe('completed')
        expect(details['role']).toBe('manager')
        expect(details['permittedRoles']).toEqual(['owner', 'manager'])
      }
    })
  }

  it('hands the decider the status it read, the target, the role and the trimmed reason', async () => {
    const seen: { from?: string; to?: string; role?: string; reason?: string | null } = {}
    const decide = decider({ kind: 'refused', refusal: 'illegal_transition', why: 'no' }, seen)
    await refusalFrom(
      transitionAppointment(
        readOnlyUow('checked_in'),
        input({ to: 'cancelled_by_salon', reason: '  the therapist is ill  ' }),
        { decide },
      ),
    )
    // The `from` is the status the DATABASE holds, never one the caller supplied: a caller-supplied
    // `from` is a caller asserting what the row said before it read it.
    expect(seen.from).toBe('checked_in')
    expect(seen.to).toBe('cancelled_by_salon')
    expect(seen.role).toBe('manager')
    expect(seen.reason).toBe('the therapist is ill')
  })

  it('treats a blank or whitespace-only reason as absent, never as a reason somebody gave', async () => {
    // 0046 refuses `''` in the column, and `set_config` cannot store NULL — so "no reason" has exactly
    // one representation and it is NULL.
    for (const reason of ['', '   ', '\n\t'] as const) {
      const seen: { reason?: string | null } = {}
      const decide = decider({ kind: 'refused', refusal: 'reason_required', why: 'no' }, seen)
      await refusalFrom(
        transitionAppointment(readOnlyUow('confirmed'), input({ to: 'rescheduled', reason }), {
          decide,
        }),
      )
      expect(seen.reason).toBeNull()
    }
  })

  it('refuses an appointment that does not exist, before asking the table anything', async () => {
    let asked = 0
    const decide: TransitionDecider = () => {
      asked += 1
      return { kind: 'allowed', transition: TRANSITION }
    }
    const uow: UnitOfWork = {
      // An empty result set: the id matched nothing.
      sql: (() => Promise.resolve([])) as unknown as Sql,
      audit: unusableUow().audit,
      publish: unusableUow().publish,
    }
    expect(await refusalFrom(transitionAppointment(uow, input(), { decide }))).toBe(
      'appointment_not_found',
    )
    // Not "illegal transition from undefined": there is nothing to transition, and a decision taken
    // about a row that does not exist is a decision about nothing.
    expect(asked).toBe(0)
  })
})

/** A legal transition, as core's table describes the completion. */
const TRANSITION = {
  from: 'in_progress',
  to: 'completed',
  permission: 'booking:complete',
  eventType: 'appointment.completed',
  emitsRevenue: true,
  reasonRequired: false,
  why: 'the treatment finished',
} as const

describe('a declared no-op writes nothing at all', () => {
  it('returns the status unchanged without an update, an audit row or an event', async () => {
    let statements = 0
    const uow: UnitOfWork = {
      sql: (() => {
        statements += 1
        if (statements === 1) {
          return Promise.resolve([
            {
              id: APPOINTMENT,
              booking_id: '00000000-0000-4000-8000-0000000000b7',
              status: 'cancelled_by_customer',
              trading_date: '2099-11-04',
              gross_price_fils: '20000',
              net_fils: '19048',
              vat_fils: '952',
              vat_rate_bp: 500,
            },
          ])
        }
        throw new Error('a no-op issued a second statement')
      }) as unknown as Sql,
      audit: {
        record: () => {
          throw new Error('a no-op wrote an audit row')
        },
      } as unknown as AuditWriter,
      publish: () => {
        throw new Error('a no-op published an event')
      },
    }
    const result = await transitionAppointment(uow, input({ to: 'cancelled_by_customer' }), {
      decide: decider({
        kind: 'no_op',
        status: 'cancelled_by_customer',
        why: 'already cancelled by the customer, and a repeat is declared idempotent',
      }),
    })
    expect(result.kind).toBe('no_op')
    if (result.kind !== 'no_op') return
    expect(result.status).toBe('cancelled_by_customer')
    expect(result.why).toContain('idempotent')
    // One statement: the locking read. A no-op that wrote a history row would make the chain read as
    // activity where nothing happened, which is what 0024's `_is_a_change` constraint refuses.
    expect(statements).toBe(1)
  })
})
