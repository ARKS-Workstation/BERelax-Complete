import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import { entryId } from '../ledger/entry.ts'
import { aed, filsFrom, type Money, money, UAE_STANDARD_VAT_BP } from '../money.ts'
import { localDate } from '../time.ts'
import {
  breakageExposure,
  type ExpiringPackage,
  MalformedDrawdown,
  type PackageBalanceState,
  packageRedemptionPosting,
  probePackageRedemptionPosting,
  redemptionIsInTime,
  releaseForSessions,
  releaseThrough,
  VOUCHER_BREAKAGE_ACCOUNT,
} from './package-drawdown.ts'
import { PACKAGE_DEFERRED_REVENUE_ACCOUNT } from './package-terms.ts'

/**
 * The drawdown arithmetic, the release posting, expiry, and breakage.
 *
 * Every claim here is paired with a control that must FAIL (brief rule 3), and the controls are chosen so
 * that the WRONG answer is one somebody would plausibly write: the arguments transposed, the net taxed
 * instead of the gross, the remainder dropped, the expiry boundary made exclusive.
 */

const fils = (value: number): Money => money(filsFrom(value))

describe('releaseThrough — the four properties the closed form has by construction', () => {
  it('releases nothing at zero sessions and the whole value at the last one', () => {
    for (const value of [1, 2, 3, 7, 100, 100_000, 999_983]) {
      for (const total of [1, 2, 3, 5, 12, 30]) {
        expect(releaseThrough(fils(value), total, 0).fils).toBe(0)
        expect(releaseThrough(fils(value), total, total).fils).toBe(value)
      }
    }
  })

  it('never decreases, and each session is worth floor or ceil of the even share', () => {
    for (const value of [1, 7, 33, 100, 100_000]) {
      for (const total of [1, 3, 7, 30]) {
        const floorShare = Math.floor(value / total)
        const ceilShare = Math.ceil(value / total)
        for (let r = 1; r <= total; r += 1) {
          const step =
            releaseThrough(fils(value), total, r).fils -
            releaseThrough(fils(value), total, r - 1).fils
          expect(step).toBeGreaterThanOrEqual(floorShare)
          expect(step).toBeLessThanOrEqual(ceilShare)
        }
      }
    }
  })

  // The control for the pair above: a formula that DROPPED the remainder instead of carrying it satisfies
  // "never decreases" and fails the "whole value at the last session" half. Stated as arithmetic rather
  // than by editing the module, because the gate block does the editing and this proves the property has
  // teeth even when the gate is not running.
  it('the control: a floor-division release loses the remainder on a value that does not divide', () => {
    const floorRelease = (value: number, total: number, redeemed: number) =>
      Math.floor((value * redeemed) / total)
    expect(floorRelease(100, 3, 3)).toBe(100)
    // 3 sessions of 100 fils: the floor version is right at the end and one fils short in the middle,
    // which is the fils that makes the liability disagree with the cash taken.
    expect(floorRelease(100, 3, 1)).toBe(33)
    expect(releaseThrough(fils(100), 3, 1).fils).toBe(34)
    expect(floorRelease(1, 3, 3)).toBe(1)
    // And on a value smaller than the session count it releases NOTHING until the very last session,
    // which is a treatment delivered against no money at all.
    expect(floorRelease(1, 3, 2)).toBe(0)
    expect(releaseThrough(fils(1), 3, 2).fils).toBe(1)
  })

  it('refuses a balance or a count that cannot carry a drawdown', () => {
    expect(() => releaseThrough(fils(100), 0, 0)).toThrow(MalformedDrawdown)
    expect(() => releaseThrough(fils(100), 3, -1)).toThrow(MalformedDrawdown)
    expect(() => releaseThrough(fils(100), 3, 4)).toThrow(MalformedDrawdown)
    expect(() => releaseThrough(fils(100), 2.5 as unknown as number, 1)).toThrow(MalformedDrawdown)
  })
})

describe('releaseForSessions — and the transposition that must change the answer', () => {
  it('two single redemptions release exactly what one double does', () => {
    const value = fils(100)
    const first = releaseForSessions(value, 3, 0, 1).fils
    const second = releaseForSessions(value, 3, 1, 1).fils
    expect(first + second).toBe(releaseForSessions(value, 3, 0, 2).fils)
  })

  /**
   * THE control for this module, and the one the session's findings asked for.
   *
   * `releaseForSessions(value, total, alreadyRedeemed, units)` takes the balance's state and the units
   * being taken, in that order. Transposing them is the plausible mistake — both are small integers and
   * both are "sessions" — and it must CHANGE the answer rather than produce something that still adds up.
   * M-TILL-11 shipped an expectedFloat control that transposed two figures which were both subtracted, so
   * it compared a value to itself and reported PASS; this asserts a disagreement rather than an agreement.
   */
  it('the control: transposing alreadyRedeemed and units changes the figure', () => {
    // 7 fils over 3 sessions: shares 3, 2, 2. Taking 2 sessions from a fresh balance releases 5;
    // taking 1 session from a balance with 2 gone releases 2.
    expect(releaseForSessions(fils(7), 3, 0, 2).fils).toBe(5)
    expect(releaseForSessions(fils(7), 3, 2, 1).fils).toBe(2)
    expect(releaseForSessions(fils(7), 3, 0, 2).fils).not.toBe(
      releaseForSessions(fils(7), 3, 2, 1).fils,
    )
    // And a case where the transposition is arithmetically legal in both directions, so a test that only
    // checked "it throws" would pass while the wrong figure went into the ledger.
    expect(releaseForSessions(fils(100), 5, 1, 3).fils).toBe(60)
    expect(releaseForSessions(fils(100), 5, 3, 1).fils).toBe(20)
  })

  it('refuses a redemption of nothing', () => {
    expect(() => releaseForSessions(fils(100), 3, 0, 0)).toThrow(MalformedDrawdown)
    expect(() => releaseForSessions(fils(100), 3, 3, 1)).toThrow(MalformedDrawdown)
  })
})

// --- the property the acceptance line names ------------------------------------------------------

/**
 * "at every point the deferred-revenue liability balance === sold gross minus redeemed gross".
 *
 * Over random redemption SEQUENCES, because the claim is about every intermediate point and not only the
 * end: a rule that released the whole value on the first session would satisfy the end state.
 *
 * The generator's arms are MEASURED and not hoped for. Three units in the last batch got this wrong — one
 * put 231 of 400 cases in a single arm where a third of each was intended, and one had a generator that
 * never produced the input its property was about. So the counters below are incremented inside the
 * property, the floors are set from eight measured runs, and the assertion on them is outside the
 * property where it can fail.
 *
 * Measured over eight runs of 400 cases, each with its own seed, by running the same generator and
 * counting (the measurement harness is not shipped; the figures are):
 *   - sequences that FULLY redeem the balance:      227 250 234 256 259 253 251 242  (lowest 227)
 *   - balances whose value does NOT divide evenly:  294 271 288 286 274 289 285 282  (lowest 271)
 *   - sequences containing a MULTI-session step:    390 385 384 390 380 390 388 390  (lowest 380)
 *   - sequences that took AT LEAST ONE step at all: 385 382 387 386 380 381 387 383  (lowest 380)
 *
 * The fourth arm is the one brief rule 22 is actually about. A step that would overdraw the balance is
 * SKIPPED, so a generated sequence can walk the whole property without redeeming anything and assert
 * nothing at all — 20 of 400 do exactly that. Counting it is what says the other 380 did the work.
 *
 * The floors sit at about half of each lowest observed, which is what keeps a floor from becoming its own
 * flake (brief rule 22).
 */
/** One generated sequence walked, so the property's own callback stays readable. */
interface WalkedSequence {
  readonly stepsTaken: number
  readonly redeemed: number
  readonly released: number
  /** True while what has been released is the formula's figure for the point reached, at every step. */
  readonly heldAtEveryPoint: boolean
}

function walkSequence(
  valueFils: number,
  sessionsTotal: number,
  steps: readonly number[],
): WalkedSequence {
  const value = fils(valueFils)
  let redeemed = 0
  let released = 0
  let stepsTaken = 0
  let held = true
  for (const step of steps) {
    // A step that would overdraw is SKIPPED rather than clamped: clamping would turn a generated
    // sequence into a different one and the count of sequences that did nothing would then be zero.
    if (redeemed + step > sessionsTotal) continue
    stepsTaken += 1
    released += releaseForSessions(value, sessionsTotal, redeemed, step).fils
    redeemed += step
    // The invariant, at EVERY point: what has been released is exactly the formula's figure for the
    // point reached, so the liability still holding `value - released` is the sold gross minus the
    // redeemed gross to the fils.
    if (released !== releaseThrough(value, sessionsTotal, redeemed).fils) held = false
    if (released > valueFils) held = false
  }
  return { stepsTaken, redeemed, released, heldAtEveryPoint: held }
}

describe('property — the liability is the sold gross minus everything released, at every point', () => {
  it('holds over random redemption sequences, and the arms are counted', () => {
    let fullyRedeemed = 0
    let indivisible = 0
    let multiStep = 0
    let tookAStep = 0
    let cases = 0

    fc.assert(
      fc.property(
        fc.record({
          valueFils: fc.integer({ min: 1, max: 5_000_000 }),
          sessionsTotal: fc.integer({ min: 1, max: 12 }),
          steps: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 12 }),
        }),
        ({ valueFils, sessionsTotal, steps }) => {
          cases += 1
          if (valueFils % sessionsTotal !== 0) indivisible += 1
          if (steps.some((step) => step > 1)) multiStep += 1

          const walked = walkSequence(valueFils, sessionsTotal, steps)
          if (walked.stepsTaken > 0) tookAStep += 1
          if (walked.redeemed !== sessionsTotal) return walked.heldAtEveryPoint
          fullyRedeemed += 1
          // The end state, which is the half that says the liability reaches exactly zero.
          return walked.heldAtEveryPoint && walked.released === valueFils
        },
      ),
      { numRuns: 400 },
    )

    expect(cases).toBe(400)
    expect(fullyRedeemed).toBeGreaterThanOrEqual(110)
    expect(indivisible).toBeGreaterThanOrEqual(135)
    expect(multiStep).toBeGreaterThanOrEqual(190)
    expect(tookAStep).toBeGreaterThanOrEqual(190)
    // An explicit timeout, because 400 cases each walking up to 12 steps is a property test and
    // `vitest.config.ts` declares no `testTimeout`, so it would inherit 5,000 ms and fail under coverage
    // on a loaded machine while passing in two seconds alone (brief rule 21).
  }, 30_000)
})

// --- the posting ---------------------------------------------------------------------------------

const balanceState = (overrides: Partial<PackageBalanceState> = {}): PackageBalanceState => ({
  balanceId: 'balance-1',
  sessionsTotal: 3,
  sessionsRedeemed: 0,
  valueGross: aed(300),
  releasedGross: fils(0),
  ...overrides,
})

const posting = (overrides: Record<string, unknown> = {}) =>
  packageRedemptionPosting(
    {
      entryId: entryId('PKG-RED-1'),
      entryDate: localDate('2026-09-18'),
      balance: balanceState(),
      units: 1,
      packageLabel: 'Course',
      ...overrides,
    },
    STANDARD_SPA_CHART,
  )

describe('packageRedemptionPosting — Dr 2050 gross, Cr 4020 net, Cr 2030 vat', () => {
  it('releases the session share and splits it into net and VAT', () => {
    const result = posting()
    // 30,000 fils over 3 sessions: 10,000 released, net 9,524, VAT 476.
    expect(result.releasedGross.fils).toBe(10_000)
    expect(result.net.fils + result.vat.fils).toBe(result.releasedGross.fils)
    expect(result.vat.fils).toBe(476)
    expect(result.rateBp).toBe(UAE_STANDARD_VAT_BP)
    expect(result.sessionsRedeemedAfter).toBe(1)
    expect(result.releasedThroughGross.fils).toBe(10_000)
  })

  it('the probe measures the release, the revenue and the VAT off the entry itself', () => {
    const result = posting()
    const measured = probePackageRedemptionPosting(result.entry, STANDARD_SPA_CHART)
    expect(measured.deferredReleasedFils).toBe(result.releasedGross.fils)
    expect(measured.redemptionRevenueFils).toBe(result.net.fils)
    expect(measured.outputVatFils).toBe(result.vat.fils)
    expect(measured.otherRevenueMovementFils).toBe(0)
    expect(measured.accountsTouched).toEqual(['2030', '2050', '4020'])
    // The one thing the voucher account must never be: a package's.
    expect(measured.accountsTouched).not.toContain(VOUCHER_BREAKAGE_ACCOUNT)
  })

  /**
   * The control for the probe, and the mirror of the defect M-TILL-09 recorded as its worst arithmetic
   * one: an entry that credits `4010` and debits the contra `4095` by the same figure has a NET revenue
   * movement of zero and has put a package's revenue on the wrong account and the wrong VAT box.
   * `otherRevenueMovementFils` sums debits PLUS credits precisely so this is caught.
   */
  it('the control: revenue smuggled through a self-cancelling contra pair is measured, not netted', () => {
    const clean = posting()
    const smuggled = {
      ...clean.entry,
      lines: [
        ...clean.entry.lines,
        { account: '4010' as never, debitFils: 0, creditFils: 700, memo: null } as never,
        { account: '4095' as never, debitFils: 700, creditFils: 0, memo: null } as never,
      ],
    }
    const measured = probePackageRedemptionPosting(smuggled as never, STANDARD_SPA_CHART)
    expect(measured.otherRevenueMovementFils).toBe(1_400)
    // And the net would have reported zero, which is what makes the total the right measurement.
    const netted = 700 - 700
    expect(netted).toBe(0)
    expect(measured.otherRevenueMovementFils).not.toBe(netted)
  })

  it('taxes the GROSS released and not the net, which is the other plausible split', () => {
    const result = posting()
    // The wrong answer has a name so a test can assert it appears nowhere: 5% OF the net rather than the
    // VAT inside the gross. On 10,000 fils that is 500 and not 476, and it would overstate box 1.
    const vatIfTaxedOnTheRelease = Math.round((result.releasedGross.fils * 500) / 10_000)
    expect(vatIfTaxedOnTheRelease).toBe(500)
    expect(result.vat.fils).not.toBe(vatIfTaxedOnTheRelease)
  })

  it('refuses a balance whose released figure does not match the point it has reached', () => {
    expect(() =>
      posting({ balance: balanceState({ sessionsRedeemed: 1, releasedGross: fils(9_999) }) }),
    ).toThrow(MalformedDrawdown)
    // And accepts the one that does, so the refusal is about the figure rather than about the field.
    expect(() =>
      posting({ balance: balanceState({ sessionsRedeemed: 1, releasedGross: fils(10_000) }) }),
    ).not.toThrow()
  })

  it('sums the releases of a whole course back to the balance value, exactly', () => {
    // A value that divides into nothing tidy: 10,001 fils over 7 sessions.
    const value = fils(10_001)
    let redeemed = 0
    let released = 0
    for (let i = 0; i < 7; i += 1) {
      const result = packageRedemptionPosting(
        {
          entryId: entryId(`PKG-RED-SUM-${i}`),
          entryDate: localDate('2026-09-18'),
          balance: balanceState({
            sessionsTotal: 7,
            sessionsRedeemed: redeemed,
            valueGross: value,
            releasedGross: fils(released),
          }),
          units: 1,
          packageLabel: 'Course',
        },
        STANDARD_SPA_CHART,
      )
      released += result.releasedGross.fils
      redeemed += 1
      expect(
        probePackageRedemptionPosting(result.entry, STANDARD_SPA_CHART).deferredReleasedFils,
      ).toBe(result.releasedGross.fils)
    }
    expect(released).toBe(10_001)
    expect(PACKAGE_DEFERRED_REVENUE_ACCOUNT).toBe('2050')
  })
})

// --- expiry --------------------------------------------------------------------------------------

describe('redemptionIsInTime — inclusive of the expiry date', () => {
  it('accepts the expiry date itself and refuses the day after', () => {
    const expires = localDate('2027-03-18')
    expect(redemptionIsInTime(expires, localDate('2027-03-17'))).toBe(true)
    expect(redemptionIsInTime(expires, localDate('2027-03-18'))).toBe(true)
    expect(redemptionIsInTime(expires, localDate('2027-03-19'))).toBe(false)
  })

  // The control: an EXCLUSIVE boundary is the plausible off-by-one, and it would make a six-month validity
  // five months and thirty days. It has to be visibly a different answer on the boundary date.
  it('the control: an exclusive boundary would refuse the expiry date', () => {
    const exclusive = (expiresOn: string, onDate: string) => onDate < expiresOn
    expect(exclusive('2027-03-18', '2027-03-18')).toBe(false)
    expect(redemptionIsInTime(localDate('2027-03-18'), localDate('2027-03-18'))).toBe(true)
  })
})

// --- breakage ------------------------------------------------------------------------------------

const expiring = (overrides: Partial<ExpiringPackage> = {}): ExpiringPackage => ({
  packageSaleId: 'sale-1',
  expiresOn: localDate('2026-09-01'),
  unredeemedBalancePolicy: 'retained',
  soldGross: aed(300),
  releasedGross: aed(100),
  unreleasedGross: aed(200),
  ...overrides,
})

describe('breakageExposure — a measurement, and no journal entry at all', () => {
  it('counts what has expired with something still owed, and posts nothing', () => {
    const result = breakageExposure(
      [
        expiring(),
        expiring({ packageSaleId: 'sale-2', unreleasedGross: aed(50) }),
        // Not expired as at the date asked about.
        expiring({ packageSaleId: 'sale-3', expiresOn: localDate('2026-12-01') }),
        // Expired but fully drawn down: nothing owed, so nothing to measure.
        expiring({ packageSaleId: 'sale-4', unreleasedGross: aed(0) }),
      ],
      localDate('2026-09-18'),
    )
    expect(result.expired.map((row) => row.packageSaleId)).toEqual(['sale-1', 'sale-2'])
    expect(result.unreleasedFils).toBe(25_000)
    expect(result.retainedCount).toBe(2)
    expect(result.awaitingPolicy).toEqual([])
    expect(result.journalEntriesPosted).toBe(0)
  })

  it('separates the forfeited sales, which have no posting and need the owner', () => {
    const result = breakageExposure(
      [expiring(), expiring({ packageSaleId: 'sale-f', unredeemedBalancePolicy: 'forfeited' })],
      localDate('2026-09-18'),
    )
    expect(result.retainedCount).toBe(1)
    expect(result.awaitingPolicy.map((row) => row.packageSaleId)).toEqual(['sale-f'])
    // Still zero. A forfeited sale does not make the sweep post: it makes it raise, which the worker
    // job's own suite covers.
    expect(result.journalEntriesPosted).toBe(0)
  })

  /**
   * The control: a boundary that treated the expiry date as already past.
   *
   * The plausible off-by-one, and it matters more here than at redemption: a sweep that expired a package
   * a day early would report a liability as dead while the customer could still walk in and use it.
   */
  it('the control: a sale expiring ON the date asked about is not yet exposure', () => {
    const result = breakageExposure(
      [expiring({ expiresOn: localDate('2026-09-18') })],
      localDate('2026-09-18'),
    )
    expect(result.expired).toEqual([])
    expect(result.unreleasedFils).toBe(0)
    const dayAfter = breakageExposure(
      [expiring({ expiresOn: localDate('2026-09-17') })],
      localDate('2026-09-18'),
    )
    expect(dayAfter.expired).toHaveLength(1)
  })
})
