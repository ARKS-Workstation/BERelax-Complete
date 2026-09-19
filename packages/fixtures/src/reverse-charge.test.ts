import {
  ACCOUNTS,
  accountFor,
  billCreditTotal,
  billDebitTotal,
  deriveBill,
  filsFrom,
  money,
  recoverabilityOf,
  reverseChargeForAccount,
  reverseChargeProblems,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import { describe, expect, it } from 'vitest'
import {
  REVERSE_CHARGE_BILL_SHAPES,
  REVERSE_CHARGE_SUPPLIERS,
  REVERSE_CHARGE_TOTAL_GROSS_FILS,
  REVERSE_CHARGE_WORKED_EXAMPLE,
  type ReverseChargeBillShape,
  reverseChargeShape,
  shapesDeclaringAReverseCharge,
  UNREPORTED_REVERSE_CHARGE,
} from './reverse-charge.ts'

/**
 * The committed reverse-charge worked example, checked against the pure derivation.
 *
 * The figures in `reverse-charge.ts` were worked out by hand; this is what proves they are right, and what
 * would fail if `reverseChargeOn` ever stopped agreeing with them. `reverse-charge.itest.ts` then proves the
 * database agrees too. Neither file computes its expectation from the code it is testing — that is the whole
 * reason the figures are committed rather than derived.
 */

function derive(shape: ReverseChargeBillShape) {
  return deriveBill(
    shape.lines.map((line) => {
      const gross = money(filsFrom(line.considerationFils))
      if (line.treatment !== 'imported_services_reverse_charge') {
        return {
          description: line.description,
          account: line.account,
          gross,
          treatment: line.treatment,
        }
      }
      return {
        description: line.description,
        account: line.account,
        gross,
        treatment: line.treatment,
        reverseCharge: reverseChargeForAccount(gross, accountFor(STANDARD_SPA_CHART, line.account)),
      }
    }),
  )
}

describe('the worked example agrees with the pure derivation', () => {
  it('derives every shape to the committed figures, both sides of every pair', () => {
    for (const shape of REVERSE_CHARGE_BILL_SHAPES) {
      const derived = derive(shape)
      expect(derived.net.fils, shape.supplierReference).toBe(shape.expected.netFils)
      expect(derived.gross.fils, shape.supplierReference).toBe(shape.expected.grossFils)
      expect(derived.recoverableInputVat.fils, shape.supplierReference).toBe(
        shape.expected.recoverableInputVatFils,
      )
      expect(derived.reverseChargeOutputVat.fils, shape.supplierReference).toBe(
        shape.expected.declaredFils,
      )
      expect(derived.reverseChargeInputVat.fils, shape.supplierReference).toBe(
        shape.expected.reclaimedFils,
      )
      expect(derived.reverseChargeBorneVat.fils, shape.supplierReference).toBe(
        shape.expected.borneFils,
      )
      // Nothing is internally inconsistent, which is what the report looks for on the other side.
      expect(reverseChargeProblems(derived), shape.supplierReference).toEqual([])
    }
  })

  it('balances every shape: the debits are the gross plus the declaration', () => {
    for (const shape of REVERSE_CHARGE_BILL_SHAPES) {
      const derived = derive(shape)
      expect(billDebitTotal(derived).fils, shape.supplierReference).toBe(
        billCreditTotal(derived).fils,
      )
      // And the committed journal lines say the same thing, summed by side.
      const debits = shape.expected.journalLines
        .filter(([, side]) => side === 'debit')
        .reduce((total, [, , fils]) => total + fils, 0)
      const credits = shape.expected.journalLines
        .filter(([, side]) => side === 'credit')
        .reduce((total, [, , fils]) => total + fils, 0)
      expect(debits, shape.supplierReference).toBe(credits)
      expect(debits, shape.supplierReference).toBe(
        shape.expected.grossFils + shape.expected.declaredFils,
      )
    }
  })

  it('adds up to the committed period totals, and the borne figure is not zero', () => {
    const declared = REVERSE_CHARGE_BILL_SHAPES.reduce(
      (total, shape) => total + shape.expected.declaredFils,
      0,
    )
    const reclaimed = REVERSE_CHARGE_BILL_SHAPES.reduce(
      (total, shape) => total + shape.expected.reclaimedFils,
      0,
    )
    expect(declared).toBe(REVERSE_CHARGE_WORKED_EXAMPLE.declaredFils)
    expect(reclaimed).toBe(REVERSE_CHARGE_WORKED_EXAMPLE.reclaimedFils)
    expect(declared - reclaimed).toBe(REVERSE_CHARGE_WORKED_EXAMPLE.borneFils)
    // The assertion that makes the period worth having: a worked example where every import happened to be
    // recoverable would net to nothing, and the case that costs money would never be exercised.
    expect(REVERSE_CHARGE_WORKED_EXAMPLE.borneFils).toBeGreaterThan(0)
    expect(REVERSE_CHARGE_TOTAL_GROSS_FILS).toBeGreaterThan(declared)
  })
})

describe('the shapes cover the cases the acceptance names', () => {
  it('holds a blocked import that declares and reclaims nothing', () => {
    const shape = reverseChargeShape('FIX-RC-BLOCKED-0001')
    expect(shape.expected.declaredFils).toBeGreaterThan(0)
    expect(shape.expected.reclaimedFils).toBe(0)
    // Blocked because the ACCOUNT is, not because the shape says so. A chart that re-tagged 6090 would move
    // this derivation and fail the committed figure, which is the point of reading it here.
    expect(recoverabilityOf(accountFor(STANDARD_SPA_CHART, ACCOUNTS.entertainment))).toBe('blocked')
    expect(
      reverseChargeForAccount(
        money(filsFrom(shape.lines[0]?.considerationFils ?? 0)),
        accountFor(STANDARD_SPA_CHART, ACCOUNTS.entertainment),
      ).inputVat.fils,
    ).toBe(0)
  })

  it('holds a domestic bill that declares no reverse charge at all', () => {
    const shape = reverseChargeShape('FIX-RC-DOMESTIC-0001')
    expect(shape.expected.declaredFils).toBe(0)
    expect(shape.expected.reclaimedFils).toBe(0)
    // Its VAT is the ordinary claim against a supplier's tax invoice: a different column, a different
    // document, and the control that makes "offshore generates a pair" an assertion about the residency.
    expect(shape.expected.recoverableInputVatFils).toBeGreaterThan(0)
    expect(shapesDeclaringAReverseCharge()).not.toContain(shape)
  })

  it('holds a mixed invoice where the header sits between all and nothing', () => {
    const shape = reverseChargeShape('FIX-RC-MIXED-0001')
    expect(shape.expected.reclaimedFils).toBeGreaterThan(0)
    expect(shape.expected.reclaimedFils).toBeLessThan(shape.expected.declaredFils)
    // Which is why all-or-nothing is a rule about the LINE: every line is all or nothing, and the bill is the
    // sum of them.
    for (const line of shape.lines) {
      expect(line.reclaimedFils === 0 || line.reclaimedFils === line.declaredFils).toBe(true)
    }
  })

  it('holds the half-fils case, where half-up and truncation disagree', () => {
    const shape = reverseChargeShape('FIX-RC-HALF-0001')
    const consideration = shape.lines[0]?.considerationFils ?? 0
    // 4,010 × 500 / 10,000 = 200.5 exactly. If the two conventions agreed here the shape would prove nothing.
    expect((consideration * 500) % 10_000).toBe(5_000)
    expect(shape.expected.declaredFils).toBe(201)
    expect(Math.trunc((consideration * 500) / 10_000)).toBe(200)
  })

  it('states what the unreported bill should have declared, and posts it as out of scope', () => {
    // 63,000 × 5% = 3,150: the understatement the report puts in front of somebody. The bill itself is
    // recorded `out_of_scope`, which is what its supplier's rule said at the time — and is why it posted.
    expect(UNREPORTED_REVERSE_CHARGE.shouldHaveDeclaredFils).toBe(
      (UNREPORTED_REVERSE_CHARGE.considerationFils * 500) / 10_000,
    )
    expect(UNREPORTED_REVERSE_CHARGE.treatment).toBe('out_of_scope')
    expect(REVERSE_CHARGE_WORKED_EXAMPLE.understatedFils).toBe(
      UNREPORTED_REVERSE_CHARGE.shouldHaveDeclaredFils,
    )
    const debits = UNREPORTED_REVERSE_CHARGE.journalLines
      .filter(([, side]) => side === 'debit')
      .reduce((total, [, , fils]) => total + fils, 0)
    // It balances, which is the whole problem: nothing about this bill looks wrong.
    expect(debits).toBe(UNREPORTED_REVERSE_CHARGE.considerationFils)
  })
})

describe('no fixture supplier could be mistaken for a real one', () => {
  it('marks every legal name and holds no UAE TRN on an offshore supplier', () => {
    expect(REVERSE_CHARGE_SUPPLIERS.length).toBeGreaterThan(0)
    for (const supplier of REVERSE_CHARGE_SUPPLIERS) {
      expect(supplier.legalName, supplier.code).toContain('FIXTURE (not a real supplier)')
      expect(supplier.code, supplier.code).toMatch(/^fixture-/)
      expect(supplier.residency, supplier.code).toBe('offshore')
      // Not a fixture convention but the law: an offshore supplier issues no UAE tax invoice, and
      // `supplier_tax_profile_offshore_holds_no_uae_trn` refuses one.
      expect(supplier.trn, supplier.code).toBeNull()
    }
    // And none of them is one of the five REAL offshore vendors 0028 seeds. A fixture bill on a real vendor is
    // a payable to a company somebody will eventually pay.
    const real = ['digitalocean', 'resend', 'google', 'meta', 'anthropic']
    for (const supplier of REVERSE_CHARGE_SUPPLIERS) {
      expect(real).not.toContain(supplier.code)
    }
  })

  it('starts the misclassified supplier out of scope, which is what lets its bill post', () => {
    const misclassified = REVERSE_CHARGE_SUPPLIERS.find(
      (supplier) => supplier.code === UNREPORTED_REVERSE_CHARGE.supplierCode,
    )
    // The whole fixture rests on this: `outside_scope` is a legitimate position, so every layer accepts the
    // bill — and correcting the rule afterwards is what makes it an exception no constraint can catch.
    expect(misclassified?.placeOfSupplyRule).toBe('outside_scope')
  })
})
