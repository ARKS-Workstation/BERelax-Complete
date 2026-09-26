import { AppError } from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type HoursForDate,
  resolveTradingDate,
  type TradingDateResolution,
} from '../business-day/resolve.ts'
import { ACCOUNTS, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import { entryId } from '../ledger/entry.ts'
import { aed, filsFrom, money } from '../money.ts'
import { instantFromIso, localDate, localTime, type TradingHours } from '../time.ts'
import {
  CASH_OVER_SHORT_ACCOUNT,
  CountRequired,
  cashDropPosting,
  cashSessionCorrection,
  cashUpPosting,
  DrawerBalances,
  type DrawerReconciliation,
  type DrawerTakings,
  drawerDirection,
  expectedFloat,
  NothingToMove,
  reconcileDrawer,
} from './cash-up.ts'

/** The real hours: 11:00 to 02:00, every day (docs/13 §2). */
const OPEN_11_TO_02: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const DAILY: HoursForDate = () => OPEN_11_TO_02

const DRAWER = 'reception'
const DRAWER_ACCOUNT = ACCOUNTS.cashInDrawer

/** A day of takings that is not round in any direction, so an off-by-one shows up. */
const TAKINGS: DrawerTakings = {
  openingFloatFils: 50_000,
  cashReceivedFils: 137_300,
  changeGivenFils: 8_700,
  cashRefundedFils: 4_100,
  dropsFils: 60_000,
}
/** 50,000 + 137,300 - 8,700 - 4,100 - 60,000 */
const EXPECTED = 114_500

describe('the business day is the key, and a shift across midnight is ONE of them', () => {
  /**
   * The acceptance line, table-driven: the four instants either side of midnight.
   *
   * A cash payment taken at 01:30 belongs to the PREVIOUS trading date, because 01:30 is inside the
   * previous date's 11:00–02:00 session. Each row therefore states the calendar date the instant fell on
   * AND the trading date it must resolve to, and the test asserts the resolution is the trading date and
   * — separately — that it is NOT the calendar date wherever the two differ. Asserting only the first
   * would pass for a resolver that returned the calendar date on the two rows where they coincide.
   */
  const cases: readonly {
    readonly iso: string
    readonly calendarDate: string
    readonly tradingDate: string
    readonly what: string
  }[] = [
    {
      iso: '2026-10-02T23:59:00+04:00',
      calendarDate: '2026-10-02',
      tradingDate: '2026-10-02',
      what: 'a minute before midnight is still the 2nd, and the 2nd is its own trading date',
    },
    {
      iso: '2026-10-03T00:01:00+04:00',
      calendarDate: '2026-10-03',
      tradingDate: '2026-10-02',
      what: 'a minute after midnight is the 3rd by the calendar and the 2nd by the till',
    },
    {
      iso: '2026-10-03T01:30:00+04:00',
      calendarDate: '2026-10-03',
      tradingDate: '2026-10-02',
      what: '01:30 is the acceptance line itself',
    },
    {
      iso: '2026-10-03T01:59:00+04:00',
      calendarDate: '2026-10-03',
      tradingDate: '2026-10-02',
      what: 'a minute before the 02:00 close is the last minute of the 2nd',
    },
  ]

  const dateOf = (resolution: TradingDateResolution): string =>
    resolution.kind === 'trading' ? resolution.date : `outside:${resolution.reason}`

  for (const row of cases) {
    it(`${row.iso} belongs to ${row.tradingDate} — ${row.what}`, () => {
      const resolved = resolveTradingDate(instantFromIso(row.iso), DAILY)
      expect(dateOf(resolved)).toBe(row.tradingDate)
    })
  }

  it('fails if any of the four after-midnight instants resolves to its CALENDAR date', () => {
    // The half that makes the table a test rather than a restatement of the resolver. Three of the four
    // rows have a calendar date that differs from their trading date; a resolver that truncated
    // `receivedAt` would put those three in the next day's drawer, which is the error this key exists to
    // prevent, and it would still pass every assertion above for the first row.
    const differing = cases.filter((row) => row.calendarDate !== row.tradingDate)
    expect(differing).toHaveLength(3)
    for (const row of differing) {
      expect(dateOf(resolveTradingDate(instantFromIso(row.iso), DAILY))).not.toBe(row.calendarDate)
    }
  })

  it('puts the whole 23:00-to-02:00 shift on one business day, so one session covers it', () => {
    // THE reason the key is the business day. A shift that opens at 23:00 on the 2nd and ends at 02:00 on
    // the 3rd is one session: every instant in it resolves to 2026-10-02, so one opening float and one
    // count cover the whole shift. Keyed on the calendar date it would be two sessions, and the second
    // would start with a float nobody declared.
    const shift = [
      '2026-10-02T23:00:00+04:00',
      '2026-10-02T23:59:59+04:00',
      '2026-10-03T00:00:00+04:00',
      '2026-10-03T01:00:00+04:00',
      '2026-10-03T01:59:59+04:00',
    ]
    const resolved = new Set(
      shift.map((iso) => dateOf(resolveTradingDate(instantFromIso(iso), DAILY))),
    )
    expect([...resolved]).toEqual(['2026-10-02'])
    // And the control: the CALENDAR dates of the same instants are two, not one. Without this the
    // assertion above is satisfied by a set of one element for a trivially constant resolver.
    expect(new Set(shift.map((iso) => iso.slice(0, 10))).size).toBe(2)
  })

  it('treats the 02:00 close as outside, so nothing is counted into a shift that has finished', () => {
    const resolved = resolveTradingDate(instantFromIso('2026-10-03T02:00:00+04:00'), DAILY)
    expect(dateOf(resolved)).toBe('outside:before_opening')
  })
})

describe('expectedFloat', () => {
  it('is opening + received - change - refunded - drops', () => {
    expect(expectedFloat(TAKINGS)).toBe(EXPECTED)
  })

  it('subtracts change given rather than netting it into what was received', () => {
    // 0068 separated `amount_fils` from `change_given_fils` for this unit. The two figures are not
    // interchangeable with their difference for the drawer, and the control is the case that proves it:
    // moving 1,000 fils from `received` into `change` changes the expectation by 2,000, not by nothing.
    const moved = expectedFloat({
      ...TAKINGS,
      cashReceivedFils: TAKINGS.cashReceivedFils - 1_000,
      changeGivenFils: TAKINGS.changeGivenFils + 1_000,
    })
    expect(EXPECTED - moved).toBe(2_000)
  })

  it('refuses more change than was ever tendered', () => {
    expect(() =>
      expectedFloat({ ...TAKINGS, changeGivenFils: TAKINGS.cashReceivedFils + 1 }),
    ).toThrowError(/hand back more than it took in/)
  })

  it('refuses a fractional figure, naming the field', () => {
    expect(() => expectedFloat({ ...TAKINGS, dropsFils: 1.5 })).toThrowError(/dropsFils/)
  })

  it('is zero for a drawer that opened empty, took nothing and dropped nothing', () => {
    expect(
      expectedFloat({
        openingFloatFils: 0,
        cashReceivedFils: 0,
        changeGivenFils: 0,
        cashRefundedFils: 0,
        dropsFils: 0,
      }),
    ).toBe(0)
  })
})

describe('reconcileDrawer', () => {
  const context = { drawerCode: DRAWER, businessDay: localDate('2026-10-02') }

  it('refuses a close with no counted amount, by name', () => {
    expect(() => reconcileDrawer(TAKINGS, undefined, context)).toThrowError(CountRequired)
    expect(() => reconcileDrawer(TAKINGS, undefined, context)).toThrowError(/CountRequired/)
  })

  it('does NOT treat a count of zero as no count', () => {
    // A zero count is an empty drawer, which is a fact; no count at all is the absence of one. Treating
    // the two alike is how a close with no count comes to report the whole float as missing — the very
    // figure below, arrived at for the wrong reason.
    const zero = reconcileDrawer(TAKINGS, money(filsFrom(0)), context)
    expect(zero.countedFils).toBe(0)
    expect(zero.discrepancyFils).toBe(-EXPECTED)
    expect(zero.direction).toBe('short')
  })

  it('reports a SHORT drawer as a negative figure', () => {
    const short = reconcileDrawer(TAKINGS, money(filsFrom(EXPECTED - 2_500)), context)
    expect(short.discrepancyFils).toBe(-2_500)
    expect(short.direction).toBe('short')
  })

  it('reports an OVER drawer as a positive figure', () => {
    const over = reconcileDrawer(TAKINGS, money(filsFrom(EXPECTED + 700)), context)
    expect(over.discrepancyFils).toBe(700)
    expect(over.direction).toBe('over')
  })

  it('reports an exact count as balanced, with a zero discrepancy', () => {
    const exact = reconcileDrawer(TAKINGS, money(filsFrom(EXPECTED)), context)
    expect(exact.discrepancyFils).toBe(0)
    expect(exact.direction).toBe('balanced')
  })

  it('carries the signed figure and not a flag, so 5 fils and 500 dirhams are different events', () => {
    // The whole argument for a stored signed figure rather than a boolean. Two drawers that a
    // `balanced: false` column could not tell apart.
    const tiny = reconcileDrawer(TAKINGS, money(filsFrom(EXPECTED - 5)), context)
    const large = reconcileDrawer(TAKINGS, money(filsFrom(EXPECTED - 50_000)), context)
    expect(tiny.direction).toBe(large.direction)
    expect(tiny.discrepancyFils).not.toBe(large.discrepancyFils)
    expect(large.discrepancyFils - tiny.discrepancyFils).toBe(-49_995)
  })

  it('refuses a negative count, because a drawer holds no negative cash', () => {
    expect(() => reconcileDrawer(TAKINGS, money(filsFrom(-1)), context)).toThrowError(AppError)
  })

  it('derives the direction from the sign, so the two cannot disagree', () => {
    expect(drawerDirection(0)).toBe('balanced')
    expect(drawerDirection(1)).toBe('over')
    expect(drawerDirection(-1)).toBe('short')
  })
})

describe('cashUpPosting', () => {
  const businessDay = localDate('2026-10-02')
  const context = { drawerCode: DRAWER, businessDay }
  const post = (countedFils: number, countNote = 'Recounted twice; the till roll agrees.') =>
    cashUpPosting(
      {
        entryId: entryId('cash-up-2026-10-02-reception'),
        businessDay,
        drawerCode: DRAWER,
        drawerAccount: DRAWER_ACCOUNT,
        reconciliation: reconcileDrawer(TAKINGS, money(filsFrom(countedFils)), context),
        countNote,
      },
      STANDARD_SPA_CHART,
    )

  it('debits 6140 and credits the drawer when the till is SHORT', () => {
    const entry = post(EXPECTED - 2_500)
    expect(entry.lines.map((line) => [line.account, line.debitFils, line.creditFils])).toEqual([
      [CASH_OVER_SHORT_ACCOUNT, 2_500, 0],
      [DRAWER_ACCOUNT, 0, 2_500],
    ])
    expect(entry.source).toBe('cash_up')
    expect(entry.entryDate).toBe('2026-10-02')
  })

  it('debits the drawer and credits 6140 when the till is OVER', () => {
    const entry = post(EXPECTED + 700)
    expect(entry.lines.map((line) => [line.account, line.debitFils, line.creditFils])).toEqual([
      [DRAWER_ACCOUNT, 700, 0],
      [CASH_OVER_SHORT_ACCOUNT, 0, 700],
    ])
  })

  it('posts to 6140 and not to revenue or to the tips account', () => {
    // Without a discrepancy account a short till is absorbed into revenue or into the therapists' tips,
    // and the variance nobody can see is the variance nobody investigates (chart-of-accounts.ts).
    const accounts = post(EXPECTED - 2_500).lines.map((line) => line.account)
    expect(accounts).toContain(ACCOUNTS.cashOverShort)
    expect(accounts).not.toContain(ACCOUNTS.treatmentRevenue)
    expect(accounts).not.toContain(ACCOUNTS.tipsPayable)
  })

  it('posts the discrepancy on the business day and not on a calendar date', () => {
    // A cash-up for the 2nd whose shift ran to 02:00 on the 3rd still posts on the 2nd. Dating it on the
    // 3rd would file the loss in a period the shift never reached, and at a month end in the wrong month.
    expect(post(EXPECTED - 1).entryDate).toBe('2026-10-02')
  })

  it('refuses to build an entry for a drawer that balanced', () => {
    expect(() => post(EXPECTED)).toThrowError(DrawerBalances)
  })

  it('refuses a variance with no reason', () => {
    expect(() => post(EXPECTED - 2_500, '   ')).toThrowError(/carries no reason/)
  })

  it('reads the drawer account from the registry rather than assuming 1010', () => {
    // A float kept in the safe is `1015`, and writing its shortfall off against the till's balance would
    // leave two accounts each carrying a figure nothing explains.
    const entry = cashUpPosting(
      {
        entryId: entryId('cash-up-2026-10-02-safe'),
        businessDay,
        drawerCode: 'safe',
        drawerAccount: ACCOUNTS.pettyCash,
        reconciliation: reconcileDrawer(TAKINGS, money(filsFrom(EXPECTED - 300)), {
          drawerCode: 'safe',
          businessDay,
        }),
        countNote: 'Safe float short after the banking run.',
      },
      STANDARD_SPA_CHART,
    )
    expect(entry.lines.map((line) => line.account)).toEqual([
      ACCOUNTS.cashOverShort,
      ACCOUNTS.pettyCash,
    ])
  })

  it('balances, and carries the reason onto every line', () => {
    const entry = post(EXPECTED - 2_500)
    const debits = entry.lines.reduce((total, line) => total + line.debitFils, 0)
    const credits = entry.lines.reduce((total, line) => total + line.creditFils, 0)
    expect(debits).toBe(credits)
    for (const line of entry.lines) expect(line.memo).toContain('the till roll agrees')
  })
})

describe('cashDropPosting', () => {
  const businessDay = localDate('2026-10-02')
  it('debits the destination and credits the drawer, classified payout and not cash_up', () => {
    const entry = cashDropPosting(
      {
        entryId: entryId('drop-2026-10-02-1'),
        businessDay,
        drawerCode: DRAWER,
        drawerAccount: DRAWER_ACCOUNT,
        destinationAccount: ACCOUNTS.bankCurrent,
        amount: aed(600),
        reason: 'Mid-shift banking run.',
      },
      STANDARD_SPA_CHART,
    )
    expect(entry.lines.map((line) => [line.account, line.debitFils, line.creditFils])).toEqual([
      [ACCOUNTS.bankCurrent, 60_000, 0],
      [DRAWER_ACCOUNT, 0, 60_000],
    ])
    // Not `cash_up`: ZU004 searches for the session's variance entry by that source, and a drop sharing
    // the classification is the one way a real discrepancy could be made to look posted when it was not.
    expect(entry.source).toBe('payout')
  })

  it('refuses a zero drop and a drop to the drawer itself', () => {
    const base = {
      entryId: entryId('drop-2026-10-02-2'),
      businessDay,
      drawerCode: DRAWER,
      drawerAccount: DRAWER_ACCOUNT,
      destinationAccount: ACCOUNTS.bankCurrent,
      reason: 'Banking.',
    }
    expect(() =>
      cashDropPosting({ ...base, amount: money(filsFrom(0)) }, STANDARD_SPA_CHART),
    ).toThrowError(NothingToMove)
    expect(() =>
      cashDropPosting(
        { ...base, destinationAccount: DRAWER_ACCOUNT, amount: aed(1) },
        STANDARD_SPA_CHART,
      ),
    ).toThrowError(/moves\s+nothing/)
  })
})

describe('cashSessionCorrection', () => {
  it('posts on its OWN business day, not the session it corrects', () => {
    const entry = cashSessionCorrection(
      {
        entryId: entryId('cash-up-correction-1'),
        businessDay: localDate('2026-10-06'),
        drawerCode: DRAWER,
        drawerAccount: DRAWER_ACCOUNT,
        correctsBusinessDay: localDate('2026-10-02'),
        amountFils: 2_500,
        reason: 'The 2,500 short on the 2nd was found in the safe.',
      },
      STANDARD_SPA_CHART,
    )
    expect(entry.entryDate).toBe('2026-10-06')
    // Positive means the drawer held MORE than the close recorded, so the drawer is debited and 6140 is
    // credited back — undoing the loss the cash-up wrote off.
    expect(entry.lines.map((line) => [line.account, line.debitFils, line.creditFils])).toEqual([
      [DRAWER_ACCOUNT, 2_500, 0],
      [CASH_OVER_SHORT_ACCOUNT, 0, 2_500],
    ])
    expect(entry.source).toBe('adjustment')
  })

  it('reverses the sides for a negative correction', () => {
    const entry = cashSessionCorrection(
      {
        entryId: entryId('cash-up-correction-2'),
        businessDay: localDate('2026-10-06'),
        drawerCode: DRAWER,
        drawerAccount: DRAWER_ACCOUNT,
        correctsBusinessDay: localDate('2026-10-02'),
        amountFils: -400,
        reason: 'A 400 note double-counted at the close.',
      },
      STANDARD_SPA_CHART,
    )
    expect(entry.lines.map((line) => line.account)).toEqual([
      CASH_OVER_SHORT_ACCOUNT,
      DRAWER_ACCOUNT,
    ])
  })

  it('refuses a zero correction and one with no reason', () => {
    const base = {
      entryId: entryId('cash-up-correction-3'),
      businessDay: localDate('2026-10-06'),
      drawerCode: DRAWER,
      drawerAccount: DRAWER_ACCOUNT,
      correctsBusinessDay: localDate('2026-10-02'),
      reason: 'Found in the safe.',
    }
    expect(() =>
      cashSessionCorrection({ ...base, amountFils: 0 }, STANDARD_SPA_CHART),
    ).toThrowError(NothingToMove)
    expect(() =>
      cashSessionCorrection({ ...base, amountFils: 5, reason: ' ' }, STANDARD_SPA_CHART),
    ).toThrowError(/carries no reason/)
  })
})

/**
 * The acceptance line stated as a property: **no close can absorb a variance silently.**
 *
 * For every generated set of takings and count, exactly one of two things is true — the drawer balanced
 * and `cashUpPosting` REFUSES to build an entry, or it is out and the entry it builds carries exactly the
 * absolute discrepancy to `6140` on the side the sign demands. There is no third outcome in which an
 * entry exists for some other figure, and none in which a non-zero discrepancy produces no entry.
 *
 * ## Why the generator is weighted, and why the counts are asserted
 *
 * Brief rule 22. The claim is vacuous on a count that happens to equal the expectation, and a uniform
 * draw over a wide range of counts would make an exact match vanishingly rare — so a property that only
 * ever saw non-zero discrepancies would never exercise the `DrawerBalances` half, and one that only saw
 * zeroes would never exercise the posting. The count is therefore drawn as the expectation PLUS a
 * deliberate delta whose distribution puts a third of the mass on exactly zero.
 *
 * The floors are MEASURED, over eight runs of 400 cases, whose minima were:
 *
 *     balanced 108, short 118, over 118, non-zero 275
 *
 * Each floor is set at about half its observed minimum, because a floor placed just under the minimum
 * becomes its own intermittent failure.
 */
describe('property — a reconciliation that cannot fail to balance is not a reconciliation', () => {
  const RUNS = 400
  /**
   * An explicit timeout, because `vitest.config.ts` declares no `testTimeout` and the default is 5,000 ms.
   *
   * 400 cases, each reconciling and building an entry against the full chart; measured at about 0.4s
   * alone. Brief rule 21 has cost five files: a correctness test with no explicit timeout fails under
   * coverage on a loaded machine and names the wrong thing.
   */
  const TIMEOUT_MS = 30_000
  const businessDay = localDate('2026-10-02')

  /**
   * Positive, negative and exactly zero, with a third of the mass on zero.
   *
   * Three equally weighted arbitraries, so `fc.constant(0)` is drawn about a third of the time. A
   * uniform draw over a wide range would make an exact count vanishingly rare and the
   * `DrawerBalances` half of the claim would never be exercised at all.
   */
  const delta = fc.oneof(
    fc.constant(0),
    fc.integer({ min: 1, max: 250_000 }),
    fc.integer({ min: -250_000, max: -1 }),
  )

  /**
   * A day of takings that a real drawer could have had.
   *
   * Two of the five figures are drawn as a SHARE of another rather than independently, and both are
   * MEASURED corrections to a generator that drew all five freely:
   *
   *   - `changeGiven` as a share of `cashReceived`, so `changeGiven <= cashReceived` holds by
   *     construction. Drawn freely it exceeded the takings often enough to make `expectedFloat`'s own
   *     refusal the common case and leave the arithmetic untested.
   *   - `drops` and `cashRefunded` as shares of the cash actually in the drawer, so `expectedFloat` is
   *     never NEGATIVE. Drawn freely it often was, which is physically impossible — nobody banks money
   *     the till never held — and it skewed the run badly: `Math.max(0, …)` clamped the count to zero, so
   *     `0 - (a negative expectation)` came out POSITIVE, and a measured run put 231 of 400 cases in the
   *     "over" arm and only 75 in "balanced" where a third of each was intended.
   */
  const takings = fc
    .record({
      openingFloatFils: fc.integer({ min: 0, max: 200_000 }),
      cashReceivedFils: fc.integer({ min: 0, max: 900_000 }),
      changeShare: fc.integer({ min: 0, max: 100 }),
      refundShare: fc.integer({ min: 0, max: 40 }),
      dropShare: fc.integer({ min: 0, max: 80 }),
    })
    .map((raw): DrawerTakings => {
      const changeGivenFils = Math.floor((raw.cashReceivedFils * raw.changeShare) / 100)
      const inDrawer = raw.openingFloatFils + raw.cashReceivedFils - changeGivenFils
      const cashRefundedFils = Math.floor((inDrawer * raw.refundShare) / 100)
      return {
        openingFloatFils: raw.openingFloatFils,
        cashReceivedFils: raw.cashReceivedFils,
        changeGivenFils,
        cashRefundedFils,
        dropsFils: Math.floor(((inDrawer - cashRefundedFils) * raw.dropShare) / 100),
      }
    })

  const postFor = (reconciliation: DrawerReconciliation) =>
    cashUpPosting(
      {
        entryId: entryId('property-cash-up'),
        businessDay,
        drawerCode: DRAWER,
        drawerAccount: DRAWER_ACCOUNT,
        reconciliation,
        countNote: 'Counted twice.',
      },
      STANDARD_SPA_CHART,
    )

  /**
   * A balanced drawer must not be able to produce an entry AT ALL.
   *
   * The half that closes silent absorption from the other direction: a zero-value line is refused
   * (`journal_line_exactly_one_side`), so any entry built here would be about some other figure.
   */
  const refusesToPost = (reconciliation: DrawerReconciliation): boolean => {
    try {
      postFor(reconciliation)
      return false
    } catch (err) {
      return err instanceof DrawerBalances
    }
  }

  /**
   * The entry carries exactly the discrepancy to 6140, signed.
   *
   * A debit for a short drawer, a credit for an over one, and exactly its magnitude. A posting on the
   * wrong side balances just as well and states the opposite of what happened, which is the one error in
   * a cash-up that reconciles.
   */
  const postsTheVariance = (reconciliation: DrawerReconciliation): boolean => {
    const entry = postFor(reconciliation)
    const line = entry.lines.find((candidate) => candidate.account === CASH_OVER_SHORT_ACCOUNT)
    if (line === undefined) return false
    const signed = line.debitFils > 0 ? -line.debitFils : line.creditFils
    if (signed !== reconciliation.discrepancyFils) return false
    if (entry.source !== 'cash_up' || entry.entryDate !== businessDay) return false
    return entry.lines.reduce((total, l) => total + l.debitFils - l.creditFils, 0) === 0
  }

  it(
    'either refuses to post, or posts exactly the discrepancy to 6140 on the right side',
    () => {
      let balanced = 0
      let short = 0
      let over = 0

      fc.assert(
        fc.property(takings, delta, (generated, shift) => {
          const expected = expectedFloat(generated)
          // A count is never negative, so a delta that would take it below zero is clamped — and the
          // clamp is applied to the COUNT, after which the discrepancy is re-derived from it, so the
          // case is still a real one rather than skipped.
          const counted = Math.max(0, expected + shift)
          const reconciliation = reconcileDrawer(generated, money(filsFrom(counted)), {
            drawerCode: DRAWER,
            businessDay,
          })
          if (reconciliation.discrepancyFils !== counted - expected) return false

          if (reconciliation.discrepancyFils === 0) {
            balanced += 1
            return refusesToPost(reconciliation)
          }
          if (reconciliation.discrepancyFils < 0) short += 1
          else over += 1
          return postsTheVariance(reconciliation)
        }),
        { numRuns: RUNS },
      )

      // The counts, against the measured floors. Without them the property above is satisfied by a
      // generator that only ever produced one of the three outcomes — which is how a property held for
      // a completely wrong implementation about one run in eight (brief rule 22).
      expect(balanced).toBeGreaterThanOrEqual(50)
      expect(short).toBeGreaterThanOrEqual(60)
      expect(over).toBeGreaterThanOrEqual(55)
      expect(short + over).toBeGreaterThanOrEqual(120)
      expect(balanced + short + over).toBe(RUNS)
    },
    TIMEOUT_MS,
  )
})
