import {
  ACCOUNTS,
  accountFor,
  BLOCKED_INPUT_VAT_CATEGORIES,
  billDebitTotal,
  billEntryDraft,
  blockedInputVatAccounts,
  deriveBill,
  filsFrom,
  isBalanced,
  localDate,
  money,
  postEntry,
  recoverabilityOf,
  STANDARD_SPA_CHART,
  vatBearingTreatmentFor,
} from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { FIXTURE_SUPPLIERS } from './purchases.ts'
import {
  RECOVERABILITY_ACCOUNT_CLASSIFICATIONS,
  RECOVERABILITY_BILL_SHAPES,
  RECOVERABILITY_ENTRY_DATE,
  RECOVERABILITY_PERIOD,
  RECOVERABILITY_TOTAL_GROSS_FILS,
  RECOVERABILITY_WORKED_EXAMPLE,
  type RecoverabilityBillShape,
  recoverabilityShape,
  shapesTouching,
} from './recoverability.ts'

/**
 * M-VAT-02's committed worked example, checked against the pure derivation before any database is
 * involved.
 *
 * The acceptance criteria this file covers:
 *
 *   - *a table-driven test covers every blocked account in the chart* — the table is
 *     `RECOVERABILITY_BILL_SHAPES`, and the enumeration below fails if the chart gains a blocked account
 *     that nothing posts to.
 *   - *the recoverable input VAT total for a seeded period excludes every blocked line and matches a
 *     committed worked example to the fils, with one entertainment bill present* — the arithmetic half.
 *     `recoverability.itest.ts` then proves the database produces the same figures from the same bills.
 */
const CHART = STANDARD_SPA_CHART

/** The lines of one shape, derived in core: gross in, net, VAT, claim and blocked tax out. */
function derive(shape: RecoverabilityBillShape) {
  return deriveBill(
    shape.lines.map((line) => ({
      description: line.description,
      account: line.account,
      gross: money(filsFrom(line.grossFils)),
      treatment: line.treatment,
    })),
  )
}

describe('every blocked account in the chart is exercised by a committed bill', () => {
  it.each(
    blockedInputVatAccounts(CHART).map((account) => [account.code as string, account] as const),
  )('%s has a fixture bill that posts to it', (code, account) => {
    const shapes = shapesTouching(account.code)
    // A blocked category nothing has ever posted to is a posting rule that has never run. This is the
    // assertion that makes the next blocked account somebody adds a failing test rather than a silent
    // gap in the working papers.
    expect(shapes.length, code).toBeGreaterThan(0)
    for (const shape of shapes) {
      const blockedLines = shape.lines.filter((line) => line.account === account.code)
      for (const line of blockedLines) {
        expect(line.treatment, `${code} ${shape.supplierReference}`).toBe('blocked_not_recoverable')
      }
    }
    // And the treatment the fixture uses is the one the chart says the account must carry, so the
    // fixture cannot drift away from the classification it is testing.
    expect(vatBearingTreatmentFor(account)).toBe('blocked_not_recoverable')
  })

  it('covers every category the classification names, and nothing it does not', () => {
    const posted = new Set(
      RECOVERABILITY_BILL_SHAPES.flatMap((shape) =>
        shape.lines
          .filter((line) => line.treatment === 'blocked_not_recoverable')
          .map((line) => line.account as string),
      ),
    )
    expect([...posted].sort()).toEqual(
      BLOCKED_INPUT_VAT_CATEGORIES.map((category) => category.account as string).sort(),
    )
    // The control: the fixture does NOT record a blocked line on a recoverable account. That is the
    // over-claim's mirror image — an under-claim — and it is refused by ZV006 in the database, so a
    // fixture carrying one would fail the itest for the wrong reason.
    for (const shape of RECOVERABILITY_BILL_SHAPES) {
      for (const line of shape.lines) {
        if (line.treatment !== 'blocked_not_recoverable') continue
        expect(recoverabilityOf(accountFor(CHART, line.account))).toBe('blocked')
      }
    }
  })

  it('states the classification of every account it touches, and the chart agrees', () => {
    for (const { account, recoverability } of RECOVERABILITY_ACCOUNT_CLASSIFICATIONS) {
      expect(recoverabilityOf(accountFor(CHART, account)), account as string).toBe(recoverability)
    }
    // Every account the bills post to is in that committed table, so a shape cannot quietly use an
    // account whose classification nobody stated.
    const touched = new Set(
      RECOVERABILITY_BILL_SHAPES.flatMap((shape) =>
        shape.lines.map((line) => line.account as string),
      ),
    )
    const stated = new Set(
      RECOVERABILITY_ACCOUNT_CLASSIFICATIONS.map((row) => row.account as string),
    )
    for (const code of touched) expect(stated.has(code), code).toBe(true)
  })
})

describe('the committed figures are the figures the derivation produces', () => {
  it.each(RECOVERABILITY_BILL_SHAPES.map((shape) => [shape.supplierReference, shape] as const))(
    '%s splits, claims and blocks exactly as committed',
    (reference, shape) => {
      const bill = derive(shape)
      expect(bill.net.fils, reference).toBe(shape.expected.netFils)
      expect(bill.vat.fils, reference).toBe(shape.expected.vatFils)
      expect(bill.gross.fils, reference).toBe(shape.expected.grossFils)
      expect(bill.recoverableInputVat.fils, reference).toBe(shape.expected.recoverableInputVatFils)
      expect(bill.blockedInputVat.fils, reference).toBe(shape.expected.blockedInputVatFils)
      // net + vat === gross, and the VAT partitions into the claim and the disclosure with nothing left
      // over. Both, because the second is what a report that read `vat` for the claim would break.
      expect(bill.net.fils + bill.vat.fils, reference).toBe(bill.gross.fils)
      expect(bill.recoverableInputVat.fils + bill.blockedInputVat.fils, reference).toBe(
        bill.vat.fils,
      )
    },
  )

  it.each(RECOVERABILITY_BILL_SHAPES.map((shape) => [shape.supplierReference, shape] as const))(
    '%s posts the committed journal lines, and balances',
    (reference, shape) => {
      const bill = derive(shape)
      const draft = billEntryDraft({
        entryId: `JE-FIX-${reference}`,
        entryDate: RECOVERABILITY_ENTRY_DATE,
        narrative: `Supplier bill ${reference}`,
        bill,
      })
      expect(draft.lines.map((line) => [line.account, line.side, line.amount.fils])).toEqual(
        shape.expected.journalLines.map(([account, side, fils]) => [account, side, fils]),
      )
      expect(isBalanced(postEntry(draft, CHART))).toBe(true)
      expect(billDebitTotal(bill).fils, reference).toBe(bill.gross.fils)
    },
  )

  it('claims the committed total for the period and excludes every blocked line', () => {
    const bills = RECOVERABILITY_BILL_SHAPES.map(derive)
    const recoverable = bills.reduce((total, bill) => total + bill.recoverableInputVat.fils, 0)
    const blocked = bills.reduce((total, bill) => total + bill.blockedInputVat.fils, 0)
    expect(recoverable).toBe(RECOVERABILITY_WORKED_EXAMPLE.recoverableInputVatFils)
    expect(blocked).toBe(RECOVERABILITY_WORKED_EXAMPLE.blockedInputVatFils)

    // The wrong answer, named so it can be asserted absent: claiming every fils of VAT the period was
    // charged. That is the figure a return would report if recoverability were read off `vat` — 3,700
    // fils of over-claim on this small a period.
    const allVat = bills.reduce((total, bill) => total + bill.vat.fils, 0)
    expect(allVat).toBe(
      RECOVERABILITY_WORKED_EXAMPLE.recoverableInputVatFils +
        RECOVERABILITY_WORKED_EXAMPLE.blockedInputVatFils,
    )
    expect(recoverable).not.toBe(allVat)
    // And the disclosure is not zero: a blocked bill must appear in the return, not vanish from it.
    expect(blocked).toBeGreaterThan(0)
  })

  it('totals the committed disclosure rows to the committed figures', () => {
    // The disclosure is grouped by REASON, and the three reasons are not interchangeable: blocked VAT is
    // tax the business bore, and the other two are expenditure that never carried any.
    const byReason = new Map(
      RECOVERABILITY_WORKED_EXAMPLE.disclosures.map((row) => [row.reason, row]),
    )
    expect([...byReason.keys()]).toEqual(['blocked_category', 'no_supplier_trn', 'no_vat_charged'])
    expect(byReason.get('blocked_category')?.nonRecoverableVatFils).toBe(
      RECOVERABILITY_WORKED_EXAMPLE.blockedInputVatFils,
    )
    expect(byReason.get('no_supplier_trn')?.nonRecoverableVatFils).toBe(0)
    expect(byReason.get('no_vat_charged')?.nonRecoverableVatFils).toBe(0)

    // Every line of every shape is in exactly one reason, and the recoverable lines are in none of them:
    // the partition the working paper's detail has to satisfy.
    const counted = RECOVERABILITY_WORKED_EXAMPLE.disclosures.reduce(
      (total, row) => total + row.lineCount,
      0,
    )
    const lines = RECOVERABILITY_BILL_SHAPES.flatMap((shape) => shape.lines)
    const recoverableLines = lines.filter((line) => line.treatment === 'standard_recoverable')
    expect(counted + recoverableLines.length).toBe(lines.length)
    // And the disclosed net plus the recoverable net is every line's net, so nothing is disclosed twice.
    const disclosedNet = RECOVERABILITY_WORKED_EXAMPLE.disclosures.reduce(
      (total, row) => total + row.netFils,
      0,
    )
    const shapeNet = RECOVERABILITY_BILL_SHAPES.reduce(
      (total, shape) => total + shape.expected.netFils,
      0,
    )
    const recoverableNet = recoverableLines.reduce(
      (total, line) => total + Math.round((line.grossFils * 10_000) / 10_500),
      0,
    )
    expect(disclosedNet + recoverableNet).toBe(shapeNet)
  })

  it('adds up to the gross the period owes', () => {
    expect(RECOVERABILITY_TOTAL_GROSS_FILS).toBe(
      21_000 + 52_500 + 2_100_000 + 14_700 + 63_000 + 20_000,
    )
  })
})

describe('the fixture period and its suppliers', () => {
  it('sits inside the committed period, which is a month no other suite posts into', () => {
    expect(RECOVERABILITY_ENTRY_DATE >= RECOVERABILITY_PERIOD.from).toBe(true)
    expect(RECOVERABILITY_ENTRY_DATE <= RECOVERABILITY_PERIOD.to).toBe(true)
    // The control: a date outside the period is outside it, so the comparison is real rather than two
    // strings that happen to be equal.
    expect(localDate('2026-11-30') >= RECOVERABILITY_PERIOD.from).toBe(false)
  })

  it('reuses M-VAT-01 fixture suppliers rather than inventing a second landlord', () => {
    const known = new Set(FIXTURE_SUPPLIERS.map((supplier) => supplier.code))
    for (const shape of RECOVERABILITY_BILL_SHAPES) {
      expect(known.has(shape.supplierCode), shape.supplierReference).toBe(true)
    }
    // Every blocked line's supplier holds a TRN: only a registered supplier can charge the VAT that is
    // then blocked, which is what `bill_blocked_needs_a_trn` refuses in SQL.
    for (const shape of RECOVERABILITY_BILL_SHAPES) {
      if (!shape.lines.some((line) => line.treatment === 'blocked_not_recoverable')) continue
      const supplier = FIXTURE_SUPPLIERS.find((s) => s.code === shape.supplierCode)
      expect(supplier?.trn, shape.supplierReference).not.toBeNull()
    }
  })

  it('finds a shape by reference and refuses one that does not exist', () => {
    expect(recoverabilityShape('FIX-BLOCK-TEA-0001').lines[0]?.account).toBe(ACCOUNTS.entertainment)
    expect(() => recoverabilityShape('FIX-NOT-A-SHAPE')).toThrow(/No recoverability fixture shape/)
    expect(shapesTouching(ACCOUNTS.therapistWages)).toEqual([])
  })
})
