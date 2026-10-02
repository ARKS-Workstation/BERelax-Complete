import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { AppointmentBillingSnapshot, Basket } from '../checkout/basket.ts'
import { buildBasket, serviceLineFromAppointment } from '../checkout/basket.ts'
import { basketId } from '../checkout/line.ts'
import type { CheckoutPosting, TenderLine } from '../checkout/posting.ts'
import { checkoutPosting } from '../checkout/posting.ts'
import { ACCOUNTS, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import type { JournalEntry } from '../ledger/entry.ts'
import { entryId, imbalanceFils } from '../ledger/entry.ts'
import { filsFrom, money, splitGross } from '../money.ts'
import { localDate } from '../time.ts'
import {
  applyDepositToInvoice,
  DEPOSIT_TENDER_KIND,
  depositReceiptEntry,
  depositReleaseTender,
} from './deposit.ts'

/**
 * The acceptance line: *"property test over 500 random deposit/price pairs: applying a deposit reduces
 * amount due by exactly the deposit in fils and total revenue posted equals the invoice total, with no
 * double recognition"*.
 *
 * Three claims, and the third is the one that needed the real posting rule rather than arithmetic in a
 * vacuum. "Total revenue posted equals the invoice total" is only a claim at all if the revenue is read
 * from the ENTRIES — both of them, the receipt and the sale — rather than from the figure the splitter
 * returned. So each case builds the whole life of the deposit: `depositReceiptEntry` posts the money
 * arriving, `checkoutPosting` posts the sale with the release as one of its tenders, and the assertions
 * sum the journal lines of both. Nothing is shared between the split and the sum but the integers, so an
 * arithmetic change on either side breaks the equality.
 *
 * **"No double recognition" is the claim that fails silently if it is not measured.** The mistake it is
 * about is a deposit receipt that credits revenue — the money came in, so the obvious reading is that
 * something was earned — and the result is a document whose revenue is recognised twice and whose VAT is
 * charged twice, on a return that balances. `ZY303` refuses it in the database and this is the same claim
 * over the pure postings: exactly ONE of the two entries may carry a revenue line, and the sum across
 * both must equal the document's net rather than twice it.
 *
 * ## Why the generator weights the three shapes, and why they are counted
 *
 * Brief rule 22. The identities hold trivially when the deposit is zero — amount due is the gross and
 * nothing is released — so a uniform draw over a wide range would make most cases say nothing about the
 * release at all. The deposit is therefore drawn as a SHARE of the gross, weighted so that all three
 * shapes arrive often: a deposit smaller than the document (the normal case), one that exactly covers it
 * (the boundary, where the cash tender must disappear rather than be zero), and one that exceeds it (the
 * excess that stays held). Each count is asserted against a floor that was MEASURED, not reasoned.
 *
 * ## The floors are MEASURED
 *
 * Over six runs of 500 cases:
 *
 *     partiallyCovered   256  235  235  244  238  239   (minimum 235)
 *     exactlyCovered      84   90   96   95  116   85   (minimum 84)
 *     exceeded           116  125  123  107  108  125   (minimum 107)
 *     roundingResidue    471  481  477  484  486  470   (minimum 470)
 *
 * Each floor is set at a little over half the observed minimum. That distance is deliberate: a floor
 * placed just under an observed minimum becomes its own intermittent failure, which is the shape a
 * property test in this build has already taken once.
 *
 * `roundingResidue` counts the cases whose gross does not divide evenly by 1.05 — where net and VAT are a
 * rounding decision somebody could get wrong — because an identity that only ever saw round numbers would
 * say nothing about the figures a real menu price produces.
 */

/** The acceptance line's figure, exactly. */
const RUNS = 500

/**
 * An explicit timeout, because `vitest.config.ts` declares no `testTimeout` and every test inherits
 * 5,000 ms. 500 cases of two posting builds each, measured at between 1.1s and 1.9s alone. Brief rule 21.
 */
const TIMEOUT_MS = 30_000

const CHART = STANDARD_SPA_CHART
const ENTRY_DATE = localDate('2026-09-19')

const REVENUE_CODES = CHART.accounts
  .filter((account) => account.type === 'revenue')
  .map((account) => account.code as string)

interface Shape {
  readonly grossFils: number
  /** Basis points of the gross. Over 10,000 is a deposit bigger than the document. */
  readonly depositShareBp: number
}

const shapeArbitrary: fc.Arbitrary<Shape> = fc.record({
  // Real menu prices are in the low tens of thousands of fils; the wide band is there so the identities
  // are not only ever asserted over figures of one magnitude.
  grossFils: fc.oneof(
    { arbitrary: fc.integer({ min: 1, max: 500 }), weight: 1 },
    { arbitrary: fc.integer({ min: 5_000, max: 80_000 }), weight: 4 },
    { arbitrary: fc.integer({ min: 100_000, max: 5_000_000 }), weight: 1 },
  ),
  depositShareBp: fc.oneof(
    // Nothing held at all: the control shape, where the release must not be written.
    { arbitrary: fc.constant(0), weight: 1 },
    // Part of the document.
    { arbitrary: fc.integer({ min: 1, max: 9_999 }), weight: 6 },
    // Exactly the document, which is the boundary the cash tender has to disappear at.
    { arbitrary: fc.constant(10_000), weight: 2 },
    // More than the document.
    { arbitrary: fc.integer({ min: 10_001, max: 20_000 }), weight: 3 },
  ),
})

function snapshotOf(grossFils: number): AppointmentBillingSnapshot {
  const split = splitGross(money(filsFrom(grossFils)))
  return {
    appointmentId: 'appt-ypay06',
    serviceVariantId: 'variant-ypay06',
    status: 'completed',
    description: 'Deposit property treatment',
    gross: split.gross,
    net: split.net,
    vat: split.vat,
    vatRateBp: split.rateBp,
    priceListId: null,
    promotionId: null,
  }
}

const basketOf = (grossFils: number, index: number): Basket =>
  buildBasket(
    {
      basketId: basketId(`ypay06-prop-${index}`),
      customerId: 'cust-ypay06',
      lines: [serviceLineFromAppointment('line-1', snapshotOf(grossFils))],
    },
    CHART,
  )

/** `sum(credit - debit)` on one account across any number of entries. */
const movedOn = (entries: readonly JournalEntry[], code: string): number =>
  entries
    .flatMap((entry) => entry.lines)
    .filter((line) => (line.account as string) === code)
    .reduce((total, line) => total + line.creditFils - line.debitFils, 0)

/** Total movement across every revenue account — debits PLUS credits, not the net. */
const revenueTouchedBy = (entry: JournalEntry): number =>
  entry.lines
    .filter((line) => REVENUE_CODES.includes(line.account as string))
    .reduce((total, line) => total + line.debitFils + line.creditFils, 0)

describe('a deposit reduces the amount due by exactly itself, and revenue is recognised once', () => {
  it(
    'holds both identities and the revenue sum over 500 random deposit/price pairs',
    () => {
      let partiallyCovered = 0
      let exactlyCovered = 0
      let exceeded = 0
      let roundingResidue = 0
      let index = 0

      fc.assert(
        fc.property(shapeArbitrary, (shape) => {
          index += 1
          const basket = basketOf(shape.grossFils, index)
          const invoiceGross = basket.totals.taxableGross.fils
          const invoiceNet = basket.totals.netTotal.fils
          const invoiceVat = basket.totals.vatTotal.fils
          // 10,500 basis points is 1.05. A gross that is not a multiple of 21 leaves a residue, which is
          // where the net is a rounding decision rather than a division.
          if (shape.grossFils % 21 !== 0) roundingResidue += 1

          const heldFils = Math.floor((shape.grossFils * shape.depositShareBp) / 10_000)
          const application = applyDepositToInvoice({ invoiceGrossFils: invoiceGross, heldFils })

          // --- identity 1: the amount due is the gross less exactly what was applied ---------------
          expect(application.appliedFils + application.amountDueFils).toBe(invoiceGross)
          expect(application.appliedFils).toBe(Math.min(heldFils, invoiceGross))
          // --- identity 2: nothing is created or destroyed on the liability's side -----------------
          expect(application.appliedFils + application.remainingHeldFils).toBe(heldFils)

          if (heldFils > 0 && heldFils < invoiceGross) partiallyCovered += 1
          else if (heldFils > 0 && heldFils === invoiceGross) exactlyCovered += 1
          else if (heldFils > invoiceGross) exceeded += 1

          // --- the postings ------------------------------------------------------------------------
          const entries: JournalEntry[] = []
          if (heldFils > 0) {
            entries.push(
              depositReceiptEntry(
                {
                  entryId: entryId(`je-ypay06-receipt-${index}`),
                  entryDate: ENTRY_DATE,
                  appointmentId: 'appt-ypay06',
                  amount: money(filsFrom(heldFils)),
                  tenderKind: 'cash',
                },
                CHART,
              ),
            )
          }

          const release = depositReleaseTender(application, `movement-${index}`)
          const tenders: TenderLine[] = []
          if (release !== null) tenders.push(release)
          if (application.amountDueFils > 0) {
            tenders.push({ kind: 'cash', amount: money(filsFrom(application.amountDueFils)) })
          }
          const posting: CheckoutPosting = checkoutPosting(
            {
              entryId: entryId(`je-ypay06-sale-${index}`),
              entryDate: ENTRY_DATE,
              basket,
              tenders,
            },
            CHART,
          )
          entries.push(posting.entry)

          // Every entry balances. A posting rule that produced nothing would satisfy this, which is why
          // the figures below are asserted as well.
          for (const entry of entries) expect(imbalanceFils(entry.lines)).toBe(0)

          // --- revenue is the document's net, recognised ONCE --------------------------------------
          expect(movedOn(entries, ACCOUNTS.treatmentRevenue)).toBe(invoiceNet)
          expect(movedOn(entries, ACCOUNTS.outputVatPayable)).toBe(invoiceVat)
          // "No double recognition", as a count rather than as a sum: exactly one of the two entries may
          // touch a revenue account at all. A receipt that credited revenue AND a sale that credited it
          // would be caught by the sums above only if the figures happened to differ.
          expect(entries.filter((entry) => revenueTouchedBy(entry) > 0)).toHaveLength(1)
          expect(revenueTouchedBy(posting.entry)).toBeGreaterThan(0)

          // --- the liability ends holding exactly the excess ---------------------------------------
          expect(movedOn(entries, ACCOUNTS.customerDepositsHeld)).toBe(
            application.remainingHeldFils,
          )
          // And the deposit never reaches the package liability, which is decision 19b's whole subject.
          expect(movedOn(entries, ACCOUNTS.packageDeferredRevenue)).toBe(0)

          // --- the tenders settle the document and nothing more ------------------------------------
          expect(posting.tenderTotal.fils).toBe(invoiceGross)
          const released = posting.tenders.filter((t) => t.kind === DEPOSIT_TENDER_KIND)
          expect(released).toHaveLength(application.appliedFils > 0 ? 1 : 0)
          expect(released.reduce((total, t) => total + t.amount.fils, 0)).toBe(
            application.appliedFils,
          )
        }),
        { numRuns: RUNS },
      )

      // The floors. A run that drew almost no deposits, or no boundary cases, would have proved nothing
      // about the release and says so instead of passing.
      expect(partiallyCovered, 'partially covered cases drawn').toBeGreaterThan(118)
      expect(exactlyCovered, 'exactly covered cases drawn').toBeGreaterThan(42)
      expect(exceeded, 'cases where the deposit exceeded the document').toBeGreaterThan(54)
      expect(roundingResidue, 'cases whose gross does not divide evenly by 1.05').toBeGreaterThan(
        236,
      )
    },
    TIMEOUT_MS,
  )

  it('the control: a receipt that credited revenue would be caught by the count, not only the sum', () => {
    // The mistake the property is about, constructed by hand. A deposit receipt crediting 4010 and a
    // sale crediting it again produce a document whose revenue is recognised twice — and the TOTAL would
    // still look plausible to anyone reading one entry at a time.
    const basket = basketOf(26_250, 0)
    const posting = checkoutPosting(
      {
        entryId: entryId('je-ypay06-control-sale'),
        entryDate: ENTRY_DATE,
        basket,
        tenders: [{ kind: 'cash', amount: money(filsFrom(basket.totals.taxableGross.fils)) }],
      },
      CHART,
    )
    const honest = depositReceiptEntry(
      {
        entryId: entryId('je-ypay06-control-receipt'),
        entryDate: ENTRY_DATE,
        appointmentId: 'appt-ypay06',
        amount: money(filsFrom(5_250)),
        tenderKind: 'cash',
      },
      CHART,
    )
    expect(revenueTouchedBy(honest)).toBe(0)

    // A FABRICATED receipt that recognises revenue, which is what `depositReceiptEntry` must never
    // build. The count the property asserts goes from 1 to 2 for it.
    const doubleRecognising: JournalEntry = {
      ...honest,
      lines: [
        ...honest.lines,
        {
          account: ACCOUNTS.treatmentRevenue,
          debitFils: filsFrom(0),
          creditFils: filsFrom(5_000),
          currency: 'AED',
          memo: 'a deposit wrongly recognised',
        },
        {
          account: ACCOUNTS.customerDepositsHeld,
          debitFils: filsFrom(5_000),
          creditFils: filsFrom(0),
          currency: 'AED',
          memo: 'the liability wrongly released',
        },
      ],
    }
    expect(revenueTouchedBy(doubleRecognising)).toBeGreaterThan(0)
    expect(
      [doubleRecognising, posting.entry].filter((entry) => revenueTouchedBy(entry) > 0),
    ).toHaveLength(2)
    // And it still balances, which is why "debits equal credits" cannot catch it.
    expect(imbalanceFils(doubleRecognising.lines)).toBe(0)
  })
})
