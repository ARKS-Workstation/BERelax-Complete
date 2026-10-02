import { describe, expect, it } from 'vitest'
import { partitionWindowDate, partitionWindowIso } from './partition-window.ts'

describe('the date a suite may pin an instant on', () => {
  it('is today, so the current month holds its partition and the seed holds its calendar row', () => {
    expect(partitionWindowDate({}, new Date('2026-10-02T09:00:00.000Z'))).toBe('2026-10-02')
    // Late in the UTC day, which is the case where a naive local-date read answers tomorrow.
    expect(partitionWindowDate({}, new Date('2026-10-02T23:59:59.000Z'))).toBe('2026-10-02')
  })

  it('goes back the days asked for, while they stay inside the month', () => {
    expect(partitionWindowDate({ daysAgo: 7 }, new Date('2026-10-20T09:00:00.000Z'))).toBe(
      '2026-10-13',
    )
  })

  it('CLAMPS to the first of the month, which is the whole reason it is a function', () => {
    // The defect in one line: on the 2nd, seven days back is in September, whose partition was never
    // created on a database migrated in October — so the insert is refused by ZY061 and the suite fails
    // for a reason that has nothing to do with what it tests.
    expect(partitionWindowDate({ daysAgo: 7 }, new Date('2026-10-02T09:00:00.000Z'))).toBe(
      '2026-10-01',
    )
    expect(partitionWindowDate({ daysAgo: 400 }, new Date('2026-10-02T09:00:00.000Z'))).toBe(
      '2026-10-01',
    )
    // And on the first, where there is nowhere to go back to at all.
    expect(partitionWindowDate({ daysAgo: 1 }, new Date('2026-11-01T02:00:00.000Z'))).toBe(
      '2026-11-01',
    )
  })

  it('refuses a future or fractional day rather than rounding one', () => {
    expect(() => partitionWindowDate({ daysAgo: -1 })).toThrow(/whole number of days in the past/)
    expect(() => partitionWindowDate({ daysAgo: 1.5 })).toThrow(/whole number of days in the past/)
  })

  it('puts a named time of day on it, and refuses anything that is not one', () => {
    expect(partitionWindowIso('17:00', {}, new Date('2026-10-02T09:00:00.000Z'))).toBe(
      '2026-10-02T17:00:00.000Z',
    )
    expect(partitionWindowIso('05:00:30', {}, new Date('2026-10-02T09:00:00.000Z'))).toBe(
      '2026-10-02T05:00:30.000Z',
    )
    for (const notATime of ['17:00:00Z', '5:00', '2026-10-02', '', '25:00', '17:60']) {
      expect(() => partitionWindowIso(notATime), notATime).toThrow()
    }
  })
})
