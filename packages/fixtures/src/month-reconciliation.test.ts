import { MONTH_RECONCILIATION_LINE_IDS } from '@berelax/db'
import { describe, expect, it } from 'vitest'
import {
  WORKED_EXAMPLE_APPOINTMENTS,
  WORKED_EXAMPLE_DOCUMENTS,
  WORKED_EXAMPLE_EXPECTATIONS,
  WORKED_EXAMPLE_IDENTITIES,
  WORKED_EXAMPLE_NOT_COVERED,
  WORKED_TREATMENT_GROSS,
  WORKED_TREATMENT_NET,
  WORKED_TREATMENT_VAT,
} from './month-reconciliation.ts'

/**
 * The committed worked example for M-VAT-12, checked without a database.
 *
 * What only this file can do: hold the worked example to arithmetic a reader can verify, and hold it to
 * the report's own line list. `packages/db/src/queries/month-reconciliation.itest.ts` measures the real
 * report over the real month; this one proves the thing the measurement is compared against is internally
 * sound — because a worked example that nothing checks is a set of numbers somebody typed once, and the
 * first time one of them is wrong the itest agrees with it.
 */
describe('the worked example is internally consistent', () => {
  it('splits the treatment price exactly, so no identity hides a rounding remainder', () => {
    expect(WORKED_TREATMENT_NET + WORKED_TREATMENT_VAT).toBe(WORKED_TREATMENT_GROSS)
    // Exact at 5% in both directions. The control is the SECOND expectation: a price whose net does not
    // come back to the same gross would put a rounding question inside every identity below, and 21,000
    // is chosen precisely because it does not.
    expect(Math.round((WORKED_TREATMENT_GROSS * 10_000) / 10_500)).toBe(WORKED_TREATMENT_NET)
    expect(WORKED_TREATMENT_GROSS - WORKED_TREATMENT_NET).toBe(WORKED_TREATMENT_VAT)
    // And the control, which is what makes the three above a claim about this fixture's CHOICE of price
    // rather than about arithmetic: 21,000 divides exactly at 5% and a round-looking 20,000 does not, so
    // a price picked for looking tidy would fail here.
    expect((WORKED_TREATMENT_GROSS * 10_000) % 10_500).toBe(0)
    expect((20_000 * 10_000) % 10_500).not.toBe(0)
  })

  it('derives every identity from the documents it lists, not from a figure typed beside them', () => {
    const grossOf = (what: RegExp) =>
      WORKED_EXAMPLE_DOCUMENTS.filter((row) => what.test(row.what)).reduce(
        (total, row) => total + row.grossFils,
        0,
      )
    const vatOf = (what: RegExp) =>
      WORKED_EXAMPLE_DOCUMENTS.filter((row) => what.test(row.what)).reduce(
        (total, row) => total + row.vatFils,
        0,
      )

    // Revenue: the two invoices less the credit note. The refund, the package sale and the redemption are
    // deliberately absent from this one — a refund recognises nothing and a redemption has no document.
    expect(grossOf(/^invoice|^credit note/)).toBe(WORKED_EXAMPLE_IDENTITIES.revenueFils)
    // Tenders: everything that moved money, which is a different set of documents from the line above.
    expect(grossOf(/cash$|card$/)).toBe(WORKED_EXAMPLE_IDENTITIES.tenderFils)
    // Output tax: the invoices, less the credit note, PLUS the redemption — the one figure in the report
    // whose left side reaches across all three kinds of document.
    expect(vatOf(/^invoice|^credit note|^redemption/)).toBe(WORKED_EXAMPLE_IDENTITIES.outputTaxFils)
    // The package liability: sold LESS released, and the subtraction is the point. The redemption's gross
    // is positive in the table because it recognises revenue, so adding the two rows gives 84,000 — the
    // liability moved by 42,000 and a sum rather than a difference would state it as double.
    expect(grossOf(/^package sale/) - grossOf(/^redemption/)).toBe(
      WORKED_EXAMPLE_IDENTITIES.packageLiabilityFils,
    )
    expect(grossOf(/^redemption/)).toBe(WORKED_EXAMPLE_IDENTITIES.redemptionFils)

    // The vacuity floor, and it is the assertion that makes the five above mean anything: the four
    // subsets have to be DIFFERENT sums, or every one of them could be the same arithmetic passing five
    // times. 42,000 / 105,000 / 42,000 / 21,000 / 3,000 — four distinct values out of five.
    const sums = Object.values(WORKED_EXAMPLE_IDENTITIES)
    expect(new Set(sums).size).toBeGreaterThanOrEqual(4)
    expect(WORKED_EXAMPLE_IDENTITIES.appointmentsWithoutADocument).toBe(0)
  })

  it('bills or redeems every completed appointment, and neither of the other two states', () => {
    // Four completed: two on invoice 1, one on invoice 2, one redeemed. The identity is that every one of
    // them reaches a document, so the month has to contain exactly as many document slots as completions.
    const invoicedLines = 2 + 1
    const redeemed = 1
    expect(invoicedLines + redeemed).toBe(WORKED_EXAMPLE_APPOINTMENTS.completed)
    // TWO cancellations, because `cancelled_by_customer` and `cancelled_by_salon` are different policies
    // and the same reporting treatment: a month with one of them cannot show the report counts both.
    expect(WORKED_EXAMPLE_APPOINTMENTS.cancelled).toBe(2)
    expect(WORKED_EXAMPLE_APPOINTMENTS.noShow).toBeGreaterThan(0)
  })
})

describe('the worked example covers the report it is an example of', () => {
  it('states an expectation for every line the report carries, and for no other', () => {
    expect(Object.keys(WORKED_EXAMPLE_EXPECTATIONS).sort()).toEqual(
      [...MONTH_RECONCILIATION_LINE_IDS].sort(),
    )
    // A vacuity floor on the list itself: eleven lines, so a report that had been reduced to one identity
    // would fail here rather than agreeing with a one-entry table.
    expect(MONTH_RECONCILIATION_LINE_IDS).toHaveLength(11)
  })

  it('expects every line to hold, and expects the four named identities in fils', () => {
    for (const [id, expectation] of Object.entries(WORKED_EXAMPLE_EXPECTATIONS)) {
      expect({ id, variance: expectation.variance }).toEqual({ id, variance: 0 })
    }
    // The four the acceptance line names, each keyed to the identity it is.
    expect(
      WORKED_EXAMPLE_EXPECTATIONS.invoices_less_credit_notes_against_revenue_and_output_vat
        .leftFils,
    ).toBe(WORKED_EXAMPLE_IDENTITIES.revenueFils)
    expect(WORKED_EXAMPLE_EXPECTATIONS.payments_less_refunds_against_tender_accounts.leftFils).toBe(
      WORKED_EXAMPLE_IDENTITIES.tenderFils,
    )
    expect(
      WORKED_EXAMPLE_EXPECTATIONS.package_liability_movement_against_sales_less_redemptions
        .leftFils,
    ).toBe(WORKED_EXAMPLE_IDENTITIES.packageLiabilityFils)
    expect(WORKED_EXAMPLE_EXPECTATIONS.completed_appointments_without_a_document.measure).toBe(
      'rows',
    )
  })

  it('distinguishes the kinds, so a line that cannot fail is not counted as a check', () => {
    const kinds = Object.values(WORKED_EXAMPLE_EXPECTATIONS).map((row) => row.kind)
    // Seven identities, two excluded populations, one census and exactly ONE `stated` line. The last
    // figure is the one worth asserting: `stated` means "reported, nothing claimed", so more than one of
    // them would be a report quietly shrinking into a list of numbers.
    expect(kinds.filter((kind) => kind === 'identity')).toHaveLength(7)
    expect(kinds.filter((kind) => kind === 'excluded')).toHaveLength(2)
    expect(kinds.filter((kind) => kind === 'census')).toHaveLength(1)
    expect(kinds.filter((kind) => kind === 'stated')).toHaveLength(1)
  })

  it('says what it does not cover, and names the unit or question that owns each gap', () => {
    expect(WORKED_EXAMPLE_NOT_COVERED.length).toBeGreaterThanOrEqual(5)
    for (const gap of WORKED_EXAMPLE_NOT_COVERED) {
      // Every gap names an owner: a unit id, an open question, or an ADR. A gap with no owner is a gap
      // nobody has agreed to close, and a list of those reads as a list of things that are fine.
      expect(gap, gap).toMatch(/M-[A-Z]+-\d+|Y\d+-[a-z-]+|ADR \d{4}/)
    }
  })
})
