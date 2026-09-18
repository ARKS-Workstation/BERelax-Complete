import {
  agePayables,
  BILL_TAX_TREATMENTS,
  billEntryDraft,
  bucketTotal,
  deriveBill,
  filsFrom,
  isBalanced,
  localDate,
  money,
  PAYABLES_AGING_BUCKETS,
  type PayableForAging,
  postEntry,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { FIXTURE_TODAY } from './clock.ts'
import {
  billDateOf,
  dueDateOf,
  FIXTURE_BILL_SHAPES,
  FIXTURE_PAYABLES_AGING,
  FIXTURE_PAYABLES_TOTAL_FILS,
  FIXTURE_SUPPLIERS,
  grossOf,
  SUPPLIER_FIXTURE_PREFIX,
  SYNTHETIC_TRN,
  shiftDate,
} from './purchases.ts'

/**
 * The committed purchase fixtures, checked against the pure derivation before any database is involved.
 *
 * Two acceptance criteria of M-VAT-01 are assertions about *these figures* — "balances to the fils for
 * every seeded bill shape" and "match a committed worked example exactly" — so the figures are checked
 * in and this file is what proves the code agrees with them. `purchases.itest.ts` then proves the
 * database agrees with both.
 *
 * The distinction matters: if the expectations were computed from `deriveBill`, every assertion here
 * would hold however wrong `deriveBill` became.
 */

describe('the fixture suppliers', () => {
  it('could not be mistaken for real suppliers', () => {
    for (const supplier of FIXTURE_SUPPLIERS) {
      expect(supplier.legalName.startsWith(SUPPLIER_FIXTURE_PREFIX)).toBe(true)
      expect(supplier.code.startsWith('fixture-')).toBe(true)
      // A TRN that could have been issued is the liability here: it would be recorded on a bill as
      // evidence for a claim. An issued UAE TRN does not start with a zero.
      if (supplier.trn !== null) {
        expect(supplier.trn).toBe(SYNTHETIC_TRN)
        expect(supplier.trn.startsWith('0')).toBe(true)
        expect(supplier.trn).toMatch(/^[0-9]{15}$/)
      }
    }
  })

  it('states a residency for every one, and never an offshore supplier holding a UAE TRN', () => {
    for (const supplier of FIXTURE_SUPPLIERS) {
      expect(['domestic', 'offshore']).toContain(supplier.residency)
      if (supplier.residency === 'offshore') expect(supplier.trn).toBeNull()
      expect(supplier.residency === 'domestic' ? 'domestic_uae' : supplier.placeOfSupplyRule).toBe(
        supplier.placeOfSupplyRule,
      )
    }
    // The pair the unit turns on: one domestic supplier that can support a claim and one that cannot.
    const domestic = FIXTURE_SUPPLIERS.filter((s) => s.residency === 'domestic')
    expect(domestic.some((s) => s.trn !== null)).toBe(true)
    expect(domestic.some((s) => s.trn === null)).toBe(true)
  })

  it('does not shadow a supplier the migration seeds', () => {
    // 0028 seeds the five real offshore vendors. A fixture that reused one of their codes would either
    // fail to insert or, worse, hand a test a supplier whose residency it did not set.
    for (const seeded of ['digitalocean', 'resend', 'google', 'meta', 'anthropic']) {
      expect(FIXTURE_SUPPLIERS.map((s) => s.code)).not.toContain(seeded)
    }
  })
})

describe('every committed bill shape', () => {
  it('exercises every tax treatment the unit supports', () => {
    // The vacuity guard on the whole file: without it, a shape silently dropped would leave a treatment
    // with no coverage at all and every assertion below would still pass.
    const exercised = new Set(FIXTURE_BILL_SHAPES.flatMap((s) => s.lines.map((l) => l.treatment)))
    expect([...exercised].sort()).toEqual([...BILL_TAX_TREATMENTS].sort())
  })

  it('names a supplier that exists, and a reference unique to that supplier', () => {
    const codes = new Set(FIXTURE_SUPPLIERS.map((s) => s.code))
    const seen = new Set<string>()
    for (const shape of FIXTURE_BILL_SHAPES) {
      expect(codes).toContain(shape.supplierCode)
      // `bill_supplier_reference_unique` is per supplier; a fixture that repeated a pair would fail
      // against the database for a reason that has nothing to do with the case it was written for.
      const pair = `${shape.supplierCode}/${shape.supplierReference}`
      expect(seen.has(pair)).toBe(false)
      seen.add(pair)
    }
  })

  it.each(FIXTURE_BILL_SHAPES.map((shape) => [shape.supplierReference, shape] as const))(
    '%s derives the committed net, VAT, gross and claim',
    (_reference, shape) => {
      const derived = deriveBill(
        shape.lines.map((line) => ({
          description: line.description,
          account: line.account,
          gross: money(filsFrom(line.grossFils)),
          treatment: line.treatment,
        })),
      )
      expect(derived.net.fils).toBe(shape.expected.netFils)
      expect(derived.vat.fils).toBe(shape.expected.vatFils)
      expect(derived.gross.fils).toBe(shape.expected.grossFils)
      expect(derived.recoverableInputVat.fils).toBe(shape.expected.recoverableInputVatFils)
      // The invariant behind all of it, asserted on every shape rather than once: net + vat === gross.
      expect(derived.net.fils + derived.vat.fils).toBe(derived.gross.fils)
      expect(grossOf(shape).fils).toBe(shape.expected.grossFils)
    },
  )

  it.each(FIXTURE_BILL_SHAPES.map((shape) => [shape.supplierReference, shape] as const))(
    '%s posts the committed journal lines, and they balance',
    (reference, shape) => {
      const derived = deriveBill(
        shape.lines.map((line) => ({
          description: line.description,
          account: line.account,
          gross: money(filsFrom(line.grossFils)),
          treatment: line.treatment,
        })),
      )
      const draft = billEntryDraft({
        entryId: `JE-${reference}`,
        entryDate: FIXTURE_TODAY,
        narrative: `Supplier bill ${reference}`,
        bill: derived,
      })
      expect(draft.lines.map((line) => [line.account, line.side, line.amount.fils])).toEqual(
        shape.expected.journalLines,
      )
      expect(isBalanced(postEntry(draft, STANDARD_SPA_CHART))).toBe(true)
    },
  )
})

describe('the payables aging worked example', () => {
  /** The shapes as the aging report sees them: what is owed, and when it fell due. */
  const payables: readonly PayableForAging[] = FIXTURE_BILL_SHAPES.map((shape) => ({
    reference: shape.supplierReference,
    supplierCode: shape.supplierCode,
    dueDate: dueDateOf(shape),
    outstanding: grossOf(shape),
  }))

  const aging = agePayables(FIXTURE_TODAY, payables)

  it('matches the committed buckets exactly, to the fils and to the reference', () => {
    expect(
      aging.rows.map((row) => ({
        bucket: row.bucket,
        totalFils: row.total.fils,
        supplierReferences: row.references,
      })),
    ).toEqual(
      FIXTURE_PAYABLES_AGING.map((row) => ({
        bucket: row.bucket,
        totalFils: row.totalFils,
        supplierReferences: [...row.supplierReferences],
      })),
    )
  })

  it('accounts for every bill exactly once and for the whole payable', () => {
    expect(aging.billCount).toBe(FIXTURE_BILL_SHAPES.length)
    expect(aging.total.fils).toBe(FIXTURE_PAYABLES_TOTAL_FILS)
    const bucketed = aging.rows.flatMap((row) => row.references)
    expect(bucketed.sort()).toEqual(FIXTURE_BILL_SHAPES.map((s) => s.supplierReference).sort())
  })

  it('populates all five buckets, so none of them is untested', () => {
    expect(aging.rows.map((row) => row.bucket)).toEqual([...PAYABLES_AGING_BUCKETS])
    for (const row of aging.rows) {
      expect(row.billCount).toBeGreaterThan(0)
    }
  })

  it('moves every payable a bucket along when the as-of date moves, which is the control', () => {
    // Without this the example could be satisfied by a bucketing function that ignored its dates
    // entirely. Twenty-six days later FIX-CURRENT-0001 is one day overdue, so `current` empties and it
    // is the only thing left in 1-30 — everything else has aged past it.
    const later = agePayables(shiftDate(FIXTURE_TODAY, 26), payables)
    expect(bucketTotal(later, 'current').fils).toBe(0)
    expect(bucketTotal(later, 'days_1_30').fils).toBe(315_000)
    expect(later.rows.find((row) => row.bucket === 'days_1_30')?.references).toEqual([
      'FIX-CURRENT-0001',
    ])
    // The total is unchanged: ageing moves money between buckets, it never creates or loses any.
    expect(later.total.fils).toBe(aging.total.fils)
  })

  it('derives the dates of a shape from the frozen clock rather than the machine', () => {
    const rent = FIXTURE_BILL_SHAPES.find(
      (shape) => shape.supplierReference === 'FIX-RENT-0001',
    ) as (typeof FIXTURE_BILL_SHAPES)[number]
    expect(billDateOf(rent)).toBe(localDate('2026-08-09'))
    expect(dueDateOf(rent)).toBe(localDate('2026-09-08'))
    expect(shiftDate(FIXTURE_TODAY, 0)).toBe(FIXTURE_TODAY)
  })
})
