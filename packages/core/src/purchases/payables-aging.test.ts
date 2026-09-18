import { describe, expect, it } from 'vitest'
import { aed, filsFrom, money } from '../money.ts'
import { localDate } from '../time.ts'
import {
  agePayables,
  bucketTotal,
  daysBetween,
  daysOverdue,
  OLDEST_PAYABLES_BUCKET,
  overdueTotal,
  PAYABLES_AGING_BOUNDARY_DAYS,
  PAYABLES_AGING_BUCKETS,
  type PayableForAging,
  type PayablesAging,
  payablesBucketFor,
} from './payables-aging.ts'

/**
 * The aging boundaries, one day at a time.
 *
 * Every boundary is tested on both sides, because an aging report is only ever wrong by one day: the
 * bill due today that reads as overdue, or the 91-day debt that reads as 90. The first makes the
 * business chase a supplier it does not owe yet; the second understates the oldest debt in the
 * business, which is the one figure the report exists to show.
 */

/** The frozen "today" the fixture salon lives in (packages/fixtures/src/clock.ts). */
const AS_OF = localDate('2026-09-18')

describe('the bucket boundaries', () => {
  it.each([
    ['2026-09-19', 'current', 'due tomorrow'],
    ['2026-09-18', 'current', 'due today — not overdue by anything'],
    ['2026-09-17', 'days_1_30', 'one day overdue'],
    ['2026-08-19', 'days_1_30', 'thirty days overdue'],
    ['2026-08-18', 'days_31_60', 'thirty-one days overdue'],
    ['2026-07-20', 'days_31_60', 'sixty days overdue'],
    ['2026-07-19', 'days_61_90', 'sixty-one days overdue'],
    ['2026-06-20', 'days_61_90', 'ninety days overdue'],
    ['2026-06-19', 'days_over_90', 'ninety-one days overdue'],
    ['2024-01-01', 'days_over_90', 'a debt from another year'],
  ])('%s falls in %s (%s)', (dueDate, bucket) => {
    expect(payablesBucketFor(localDate(dueDate), AS_OF)).toBe(bucket)
  })

  it('counts days overdue as as-of minus due date, negative before it falls due', () => {
    expect(daysOverdue(localDate('2026-09-17'), AS_OF)).toBe(1)
    expect(daysOverdue(localDate('2026-09-18'), AS_OF)).toBe(0)
    expect(daysOverdue(localDate('2026-09-20'), AS_OF)).toBe(-2)
  })

  it('counts whole days across a month end and a leap day', () => {
    expect(daysBetween(localDate('2026-08-31'), localDate('2026-09-01'))).toBe(1)
    // 2028 is a leap year: 28 February to 1 March is two days, not one.
    expect(daysBetween(localDate('2028-02-28'), localDate('2028-03-01'))).toBe(2)
    expect(daysBetween(localDate('2027-02-28'), localDate('2027-03-01'))).toBe(1)
  })

  it('refuses a date that is not a calendar date rather than bucketing NaN days', () => {
    // A NaN comparison is false against every boundary, so the payable would silently land in the
    // oldest bucket and read as a two-year-old debt.
    expect(() => payablesBucketFor('18/09/2026' as ReturnType<typeof localDate>, AS_OF)).toThrow(
      /LocalDate must be YYYY-MM-DD/,
    )
  })

  it('has exactly one open-ended bucket, and it is the last one', () => {
    // The control on the cascade in payablesBucketFor: it falls through to the open-ended bucket, so a
    // second one — or one that was not last — would make the fall-through unreachable and some bucket
    // impossible to land in.
    const openEnded = PAYABLES_AGING_BOUNDARY_DAYS.filter((b) => b.upToDaysOverdue === null)
    expect(openEnded).toHaveLength(1)
    expect(openEnded[0]?.bucket).toBe(OLDEST_PAYABLES_BUCKET)
    expect(PAYABLES_AGING_BOUNDARY_DAYS.at(-1)?.bucket).toBe(OLDEST_PAYABLES_BUCKET)
    expect(PAYABLES_AGING_BOUNDARY_DAYS.map((b) => b.bucket)).toEqual([...PAYABLES_AGING_BUCKETS])
  })
})

describe('the aging report', () => {
  const payables: readonly PayableForAging[] = [
    {
      reference: 'BILL-2026-00001',
      supplierCode: 'a',
      dueDate: localDate('2026-10-01'),
      outstanding: aed(1_000),
    },
    {
      reference: 'BILL-2026-00002',
      supplierCode: 'a',
      dueDate: localDate('2026-09-18'),
      outstanding: aed(250),
    },
    {
      reference: 'BILL-2026-00003',
      supplierCode: 'b',
      dueDate: localDate('2026-09-01'),
      outstanding: aed(500),
    },
    {
      reference: 'BILL-2026-00004',
      supplierCode: 'b',
      dueDate: localDate('2026-08-01'),
      outstanding: aed(125),
    },
    {
      reference: 'BILL-2026-00005',
      supplierCode: 'c',
      dueDate: localDate('2026-07-01'),
      outstanding: aed(75),
    },
    {
      reference: 'BILL-2026-00006',
      supplierCode: 'c',
      dueDate: localDate('2026-01-05'),
      outstanding: aed(40),
    },
  ]

  const aging = agePayables(AS_OF, payables)

  it('puts every payable in exactly one bucket and totals each to the fils', () => {
    expect(aging.rows.map((row) => [row.bucket, row.total.fils, row.billCount])).toEqual([
      ['current', 125_000, 2],
      ['days_1_30', 50_000, 1],
      ['days_31_60', 12_500, 1],
      ['days_61_90', 7_500, 1],
      ['days_over_90', 4_000, 1],
    ])
    expect(aging.billCount).toBe(6)
    expect(aging.total.fils).toBe(199_000)
    // The control: the buckets add up to the total, so a payable counted twice or dropped would show.
    expect(aging.rows.reduce((sum, row) => sum + row.total.fils, 0)).toBe(aging.total.fils)
    expect(aging.rows.reduce((sum, row) => sum + row.billCount, 0)).toBe(aging.billCount)
  })

  it('lists every bucket even when it is empty, so the shape does not change between months', () => {
    const onlyCurrent = agePayables(AS_OF, [payables[0] as PayableForAging])
    expect(onlyCurrent.rows.map((row) => row.bucket)).toEqual([...PAYABLES_AGING_BUCKETS])
    expect(onlyCurrent.rows.filter((row) => row.billCount === 0)).toHaveLength(4)
    expect(bucketTotal(onlyCurrent, 'days_over_90').fils).toBe(0)
  })

  it('sorts the references inside a bucket, so two runs produce identical working papers', () => {
    const scrambled = agePayables(AS_OF, [
      {
        reference: 'BILL-2026-00009',
        supplierCode: 'a',
        dueDate: localDate('2026-09-01'),
        outstanding: aed(1),
      },
      {
        reference: 'BILL-2026-00007',
        supplierCode: 'a',
        dueDate: localDate('2026-09-02'),
        outstanding: aed(1),
      },
      {
        reference: 'BILL-2026-00008',
        supplierCode: 'a',
        dueDate: localDate('2026-09-03'),
        outstanding: aed(1),
      },
    ])
    expect(bucketTotal(scrambled, 'days_1_30').fils).toBe(300)
    expect(scrambled.rows.find((row) => row.bucket === 'days_1_30')?.references).toEqual([
      'BILL-2026-00007',
      'BILL-2026-00008',
      'BILL-2026-00009',
    ])
  })

  it('reports the overdue total as the difference from current, not a second sum', () => {
    expect(overdueTotal(aging).fils).toBe(199_000 - 125_000)
  })

  it('answers zero for a bucket a report does not carry', () => {
    // Defensive rather than hypothetical: a report narrowed by a caller — one supplier, one period — is
    // still asked for every bucket by the screen that prints it.
    const empty: PayablesAging = { asOf: AS_OF, rows: [], total: aed(0), billCount: 0 }
    expect(bucketTotal(empty, 'current').fils).toBe(0)
    expect(overdueTotal(empty).fils).toBe(0)
  })

  it('refuses a negative outstanding amount rather than netting it off a bucket', () => {
    // A supplier credit is their credit note, which is its own document with its own VAT treatment.
    // Letting it through as a negative bill would reduce an aging bucket without reducing what is owed.
    expect(() =>
      agePayables(AS_OF, [
        {
          reference: 'BILL-2026-00010',
          supplierCode: 'a',
          dueDate: localDate('2026-09-01'),
          outstanding: money(filsFrom(-500)),
        },
      ]),
    ).toThrow(/negative outstanding amount/)
  })

  it('is empty, not undefined, with nothing outstanding', () => {
    const nothing = agePayables(AS_OF, [])
    expect(nothing.total.fils).toBe(0)
    expect(nothing.billCount).toBe(0)
    expect(nothing.rows).toHaveLength(PAYABLES_AGING_BUCKETS.length)
  })
})
