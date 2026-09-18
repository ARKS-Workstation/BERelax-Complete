import { isAppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  assertMayRetire,
  type FutureBookingReport,
  RETIRE_ACTIONS,
  type RetireAction,
  refusalOf,
  retireRefusal,
  SERVICE_NARRATIVE_BOOKINGS_UNKNOWABLE,
  SERVICE_NARRATIVE_HAS_FUTURE_BOOKINGS,
} from './lifecycle.ts'

const SERVICE = '0198f0a0-0000-7000-8000-000000000001'
const counted = (count: number): FutureBookingReport => ({ kind: 'counted', count })
const unknowable: FutureBookingReport = {
  kind: 'unknowable',
  reason: 'the catalogue has not been migrated into this database',
}

const removals: readonly RetireAction[] = RETIRE_ACTIONS.filter((action) => action !== 'archive')

describe('acceptance — a narrative with future bookings cannot be unpublished or deleted', () => {
  for (const action of removals) {
    it(`refuses ${action} by name`, () => {
      expect(retireRefusal({ action, catalogueServiceId: SERVICE, bookings: counted(1) })).toBe(
        SERVICE_NARRATIVE_HAS_FUTURE_BOOKINGS,
      )
    })

    it(`allows ${action} once nothing is booked`, () => {
      // The control for the case above. A policy that refused every removal would satisfy it and would
      // make a draft nobody wants permanent.
      expect(
        retireRefusal({ action, catalogueServiceId: SERVICE, bookings: counted(0) }),
      ).toBeNull()
    })
  }

  it('always allows archiving, which is what the editor wanted', () => {
    expect(
      retireRefusal({ action: 'archive', catalogueServiceId: SERVICE, bookings: counted(12) }),
    ).toBeNull()
    expect(() =>
      assertMayRetire({ action: 'archive', catalogueServiceId: SERVICE, bookings: unknowable }),
    ).not.toThrow()
  })

  it('throws a user-facing conflict naming the refusal and pointing at archiving', () => {
    try {
      assertMayRetire({ action: 'delete', catalogueServiceId: SERVICE, bookings: counted(3) })
      expect.unreachable('the refusal did not throw')
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      if (!isAppError(error)) return
      expect(error.kind).toBe('conflict')
      expect(error.userFacing).toBe(true)
      expect(error.message).toContain(SERVICE_NARRATIVE_HAS_FUTURE_BOOKINGS)
      expect(error.message).toContain('Archive it instead')
      expect(refusalOf(error)).toBe(SERVICE_NARRATIVE_HAS_FUTURE_BOOKINGS)
      expect(error.details['catalogueServiceId']).toBe(SERVICE)
    }
  })
})

describe('acceptance — a count that cannot be taken is not a count of zero', () => {
  for (const action of removals) {
    it(`refuses ${action} when the booking records cannot be read`, () => {
      // The fail-closed half. `unknowable` exists because a probe that returned 0 on failure would let a
      // treatment with bookings be deleted the moment the query broke — and a broken query is silent.
      expect(retireRefusal({ action, catalogueServiceId: SERVICE, bookings: unknowable })).toBe(
        SERVICE_NARRATIVE_BOOKINGS_UNKNOWABLE,
      )
    })
  }

  it('says so in the message rather than reporting no bookings', () => {
    try {
      assertMayRetire({ action: 'unpublish', catalogueServiceId: SERVICE, bookings: unknowable })
      expect.unreachable('the refusal did not throw')
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      if (!isAppError(error)) return
      expect(error.message).toContain(SERVICE_NARRATIVE_BOOKINGS_UNKNOWABLE)
      expect(error.message).toContain('cannot be read')
      expect(refusalOf(error)).toBe(SERVICE_NARRATIVE_BOOKINGS_UNKNOWABLE)
    }
  })
})

describe('acceptance — a narrative referencing no service is not held hostage', () => {
  for (const action of removals) {
    it(`allows ${action} on an unattached draft even when bookings are unknowable`, () => {
      // Without this, the fail-closed rule makes every unattached draft undeletable until the catalogue
      // lands — and a rule that blocks ordinary work is a rule somebody switches off.
      expect(retireRefusal({ action, catalogueServiceId: null, bookings: unknowable })).toBeNull()
    })
  }
})

describe('refusalOf', () => {
  it('returns null for anything that is not one of these refusals', () => {
    expect(refusalOf(new Error('unrelated'))).toBeNull()
    expect(refusalOf(undefined)).toBeNull()
    expect(refusalOf('service_narrative_has_future_bookings')).toBeNull()
  })
})
