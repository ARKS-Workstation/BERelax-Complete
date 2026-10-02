import { describe, expect, it } from 'vitest'
import { localDate } from '../time.ts'
import { accountCode } from './account.ts'
import { STANDARD_SPA_CHART } from './chart-of-accounts.ts'
import {
  accountsOutsideTheChart,
  boundaryVerdict,
  type CutoverBoundary,
  openingRemainder,
} from './period-lock.ts'

/**
 * The cutover boundary and the remainder, each with a control that must fail.
 *
 * This module is a second statement of migration 0132's two triggers, which is deliberate and is stated
 * in its header: the database holds, and this is what explains a refusal before it is attempted. The
 * check that holds the two equal is `packages/fixtures/src/opening-boundary.itest.ts`, which drives both
 * over the same inputs — so what is asserted here is the predicate's own shape, and nothing here claims
 * the database agrees.
 */

const BOUNDARY: CutoverBoundary = { opensOn: localDate('2026-10-01') }

describe('the boundary refuses what is behind it', () => {
  it('permits anything while no opening balance has been attested', () => {
    // The window the opening entry itself is inserted in: it commits, and only then does the attestation
    // exist to guard against it. 0027 records the same thing as the reason its guard returns early.
    for (const source of ['sale', 'opening_balance', 'reversal'] as const) {
      expect(
        boundaryVerdict({
          boundary: BOUNDARY,
          entryDate: localDate('2024-01-01'),
          source,
          attested: false,
        }),
      ).toEqual({ ok: true })
    }
  })

  it('refuses an entry dated before the boundary, whatever its source', () => {
    for (const source of ['sale', 'payment', 'opening_balance', 'reversal'] as const) {
      const verdict = boundaryVerdict({
        boundary: BOUNDARY,
        entryDate: localDate('2026-09-30'),
        source,
        attested: true,
      })
      expect(verdict.ok).toBe(false)
      expect(verdict.ok ? '' : verdict.refusal).toBe('behind_the_boundary')
      // The remedy is in the answer and not left to the caller, which is why a verdict is not a boolean.
      expect(verdict.ok ? '' : verdict.remedy).toMatch(/dated reversal/)
    }
  })

  it('refuses a second opening_balance entry dated ON the boundary', () => {
    const verdict = boundaryVerdict({
      boundary: BOUNDARY,
      entryDate: localDate('2026-10-01'),
      source: 'opening_balance',
      attested: true,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok ? '' : verdict.refusal).toBe('opening_position_is_closed')
  })

  it('permits every other source ON the boundary, which is the control', () => {
    // Without this the two cases above would pass for a predicate that refused everything once attested,
    // and the books could not be posted to at all.
    for (const source of ['sale', 'payment', 'reversal'] as const) {
      expect(
        boundaryVerdict({
          boundary: BOUNDARY,
          entryDate: localDate('2026-10-01'),
          source,
          attested: true,
        }),
      ).toEqual({ ok: true })
    }
  })

  it('permits everything after the boundary', () => {
    expect(
      boundaryVerdict({
        boundary: BOUNDARY,
        entryDate: localDate('2026-10-02'),
        source: 'opening_balance',
        attested: true,
      }),
    ).toEqual({ ok: true })
  })
})

describe('the remainder', () => {
  const code = accountCode('2050')

  it('is the whole stated figure when nothing is posted', () => {
    expect(
      openingRemainder({
        accountCode: code,
        statedDebitFils: 0,
        statedCreditFils: 733_337,
        postedNetFils: 0,
      }),
    ).toEqual({ ok: true, debitFils: 0, creditFils: 733_337 })
  })

  it('is nothing at all when the stated figure is already fully posted', () => {
    // The normal case for the package liability H-MIG-03 attested: the trial balance includes it because
    // the attested totals are the whole position's, and this import adds nothing to it.
    expect(
      openingRemainder({
        accountCode: code,
        statedDebitFils: 0,
        statedCreditFils: 733_337,
        postedNetFils: -733_337,
      }),
    ).toEqual({ ok: true, debitFils: 0, creditFils: 0 })
  })

  it('is the difference when the stated figure is larger', () => {
    expect(
      openingRemainder({
        accountCode: code,
        statedDebitFils: 0,
        statedCreditFils: 1_000_000,
        postedNetFils: -733_337,
      }),
    ).toEqual({ ok: true, debitFils: 0, creditFils: 266_663 })
  })

  it('refuses a stated figure SMALLER than what is posted, naming both', () => {
    const verdict = openingRemainder({
      accountCode: code,
      statedDebitFils: 0,
      statedCreditFils: 500_000,
      postedNetFils: -733_337,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok ? '' : verdict.refusal).toBe('stated_below_what_is_already_posted')
    // Both figures in the message: a variance is named rather than absorbed (ADR 0071), so the two
    // numbers somebody has to reconcile are in the sentence.
    expect(verdict.ok ? '' : verdict.message).toContain('-500000')
    expect(verdict.ok ? '' : verdict.message).toContain('-733337')
  })

  it('refuses a posted figure on the other side of zero from the stated one', () => {
    // A liability stated as a credit with a DEBIT already posted is not a remainder of any size: it is
    // the two books disagreeing about which way round the balance is.
    const verdict = openingRemainder({
      accountCode: code,
      statedDebitFils: 0,
      statedCreditFils: 733_337,
      postedNetFils: 10_000,
    })
    expect(verdict.ok).toBe(false)
  })

  it('works the same way on the debit side, which is the control for the sign handling', () => {
    expect(
      openingRemainder({
        accountCode: accountCode('1010'),
        statedDebitFils: 400_000,
        statedCreditFils: 0,
        postedNetFils: 150_000,
      }),
    ).toEqual({ ok: true, debitFils: 250_000, creditFils: 0 })
    expect(
      openingRemainder({
        accountCode: accountCode('1010'),
        statedDebitFils: 400_000,
        statedCreditFils: 0,
        postedNetFils: 500_000,
      }).ok,
    ).toBe(false)
  })
})

describe('the chart the statement is posted against', () => {
  it('names every account the chart does not hold, once each', () => {
    const missing = accountsOutsideTheChart(STANDARD_SPA_CHART, [
      { accountCode: accountCode('9998'), debitFils: 1, creditFils: 0 },
      { accountCode: accountCode('9998'), debitFils: 2, creditFils: 0 },
      { accountCode: accountCode('9999'), debitFils: 0, creditFils: 3 },
    ])
    expect([...missing]).toEqual([accountCode('9998'), accountCode('9999')])
  })

  it('names nothing for a statement the chart holds, which is the control', () => {
    const held = STANDARD_SPA_CHART.accounts[0]
    expect(held).toBeDefined()
    expect([
      ...accountsOutsideTheChart(STANDARD_SPA_CHART, [
        { accountCode: held?.code ?? accountCode('1010'), debitFils: 1, creditFils: 0 },
      ]),
    ]).toEqual([])
  })
})
