import {
  ACCOUNTS,
  type AccountCode,
  type BillTaxTreatment,
  filsFrom,
  type LocalDate,
  localDate,
  type Money,
  money,
  type PayablesAgingBucket,
  type PlaceOfSupplyRule,
  type SupplierResidency,
} from '@berelax/core'
import { FIXTURE_TODAY } from './clock.ts'

/**
 * The committed purchase fixtures: the supplier shapes, the bill shapes and the payables aging worked
 * example every M-VAT-01 test asserts against.
 *
 * They are committed data rather than values built inside each test, because two of the acceptance
 * criteria are literally "for every seeded bill shape" and "match a committed worked example exactly".
 * A test that computed its own expectation from the same code it is testing would assert that the code
 * agrees with itself: these figures were worked out by hand from a 5% rate and are checked in.
 *
 * ## Nothing here could be mistaken for a real supplier
 *
 * Suppliers are companies rather than people, so there is no invented name of a person to worry about —
 * but a plausible company name is the same liability as a plausible personal one: it gets exported to a
 * spreadsheet, demoed, pasted into a ticket, and at some point somebody pays it. So every fixture
 * supplier carries {@link SUPPLIER_FIXTURE_PREFIX} in its legal name and an unissuable TRN, the same
 * way `synthetic.ts` uses an unallocated mobile prefix and an `.invalid` email domain.
 *
 * The five **real** offshore vendors (DigitalOcean, Resend, Google, Meta, Anthropic) are seeded by
 * `0028_purchases.sql` instead, because their residency is a fact the system must not be able to get
 * wrong. Nothing here duplicates them.
 */

/** Every fixture supplier's legal name starts with this. A real invoice never would. */
export const SUPPLIER_FIXTURE_PREFIX = 'FIXTURE (not a real supplier) —'

/**
 * A TRN that cannot have been issued.
 *
 * Fifteen digits, so it satisfies the format check and exercises the recoverable path — and it starts
 * with a zero, which an issued UAE TRN does not. Same reasoning as the `+971 59` mobile prefix in
 * `synthetic.ts`: the guarantee is arithmetic rather than a convention somebody has to remember.
 */
export const SYNTHETIC_TRN = '000000000000003'

export interface FixtureSupplier {
  readonly code: string
  readonly legalName: string
  readonly residency: SupplierResidency
  readonly placeOfSupplyRule: PlaceOfSupplyRule
  readonly trn: string | null
}

/**
 * The four supplier shapes a purchase test needs.
 *
 * The first two are the whole point of the supplier tax profile: a domestic supplier **with** a TRN can
 * support a recoverable claim, and a domestic supplier **without** one cannot — while a bill from it
 * must still be postable, because below the registration threshold an unregistered supplier is the
 * normal case and a system that refused the bill is a system somebody keeps in a spreadsheet instead.
 */
export const FIXTURE_SUPPLIERS: readonly FixtureSupplier[] = [
  {
    code: 'fixture-registered-landlord',
    legalName: `${SUPPLIER_FIXTURE_PREFIX} registered landlord`,
    residency: 'domestic',
    placeOfSupplyRule: 'domestic_uae',
    trn: SYNTHETIC_TRN,
  },
  {
    code: 'fixture-unregistered-laundry',
    legalName: `${SUPPLIER_FIXTURE_PREFIX} unregistered laundry`,
    residency: 'domestic',
    placeOfSupplyRule: 'domestic_uae',
    trn: null,
  },
  {
    code: 'fixture-registered-consumables',
    legalName: `${SUPPLIER_FIXTURE_PREFIX} registered consumables wholesaler`,
    residency: 'domestic',
    placeOfSupplyRule: 'domestic_uae',
    trn: SYNTHETIC_TRN,
  },
  {
    // Out of scope rather than reverse charge: the reverse-charge pair is M-VAT-03, and a fixture that
    // recorded an imported service before the pair existed would post a bill the exception report is
    // meant to flag.
    code: 'fixture-offshore-training',
    legalName: `${SUPPLIER_FIXTURE_PREFIX} offshore training provider`,
    residency: 'offshore',
    placeOfSupplyRule: 'outside_scope',
    trn: null,
  },
]

export interface FixtureBillLine {
  readonly description: string
  readonly account: AccountCode
  /** VAT-inclusive and authoritative. Net and VAT are derived from it. */
  readonly grossFils: number
  readonly treatment: BillTaxTreatment
}

export interface FixtureBillShape {
  /** Why this shape exists — the case it is the only test of. */
  readonly why: string
  readonly supplierCode: string
  readonly supplierReference: string
  /** Days before {@link FIXTURE_TODAY} the supplier invoiced. */
  readonly billDateDaysAgo: number
  /** Days after the invoice date payment falls due. */
  readonly creditDays: number
  readonly lines: readonly FixtureBillLine[]
  /** Worked out by hand at 5%, not computed from the code under test. */
  readonly expected: {
    readonly netFils: number
    readonly vatFils: number
    readonly grossFils: number
    readonly recoverableInputVatFils: number
    /** `[accountCode, 'debit' | 'credit', fils]`, in the order the entry posts them. */
    readonly journalLines: readonly [AccountCode, 'debit' | 'credit', number][]
  }
}

/**
 * Every bill shape this unit can post, with the entry each one produces.
 *
 * The shapes cover the five treatments, a bill that mixes them, a supplier with no TRN, an offshore
 * supplier, and a gross that does not divide by 21 — which is where an independently rounded VAT would
 * differ from the remainder by a fils.
 */
export const FIXTURE_BILL_SHAPES: readonly FixtureBillShape[] = [
  {
    why: 'the ordinary recoverable bill: one standard-rated line from a supplier with a TRN',
    supplierCode: 'fixture-registered-landlord',
    supplierReference: 'FIX-RENT-0001',
    billDateDaysAgo: 40,
    creditDays: 30,
    lines: [
      {
        description: 'Premises rent',
        account: ACCOUNTS.rent,
        grossFils: 2_100_000,
        treatment: 'standard_recoverable',
      },
    ],
    expected: {
      // 2,100,000 × 20 / 21 = 2,000,000 exactly, so this shape is the one where the arithmetic is
      // checkable by eye and any change to the split shows up immediately.
      netFils: 2_000_000,
      vatFils: 100_000,
      grossFils: 2_100_000,
      recoverableInputVatFils: 100_000,
      journalLines: [
        [ACCOUNTS.rent, 'debit', 2_000_000],
        [ACCOUNTS.recoverableInputVat, 'debit', 100_000],
        [ACCOUNTS.tradePayables, 'credit', 2_100_000],
      ],
    },
  },
  {
    why: 'a supplier with no TRN: postable, and claiming nothing — the case this unit exists for',
    supplierCode: 'fixture-unregistered-laundry',
    supplierReference: 'FIX-LAUNDRY-0001',
    billDateDaysAgo: 20,
    creditDays: 14,
    lines: [
      {
        description: 'Linen laundry, weekly',
        account: ACCOUNTS.laundryAndCleaning,
        grossFils: 63_000,
        treatment: 'no_trn_not_recoverable',
      },
    ],
    expected: {
      // The whole amount is cost: there is no valid tax invoice, so nothing is carved out as VAT.
      netFils: 63_000,
      vatFils: 0,
      grossFils: 63_000,
      recoverableInputVatFils: 0,
      journalLines: [
        [ACCOUNTS.laundryAndCleaning, 'debit', 63_000],
        [ACCOUNTS.tradePayables, 'credit', 63_000],
      ],
    },
  },
  {
    why: 'one bill mixing a recoverable line with an out-of-scope one, which is the ordinary utilities invoice',
    supplierCode: 'fixture-registered-consumables',
    supplierReference: 'FIX-MIXED-0001',
    billDateDaysAgo: 75,
    creditDays: 30,
    lines: [
      {
        description: 'Treatment consumables',
        account: ACCOUNTS.consumablesUsed,
        grossFils: 52_500,
        treatment: 'standard_recoverable',
      },
      {
        description: 'Municipality inspection fee',
        account: ACCOUNTS.licenceAndGovernmentFees,
        grossFils: 20_000,
        treatment: 'out_of_scope',
      },
      {
        description: 'Exempt financial charge',
        account: ACCOUNTS.bankCharges,
        grossFils: 1_500,
        treatment: 'exempt',
      },
    ],
    expected: {
      // 52,500 → 50,000 + 2,500. The other two lines carve out nothing, so the bill's net is
      // 50,000 + 20,000 + 1,500 and its VAT is the one line's 2,500.
      netFils: 71_500,
      vatFils: 2_500,
      grossFils: 74_000,
      recoverableInputVatFils: 2_500,
      journalLines: [
        [ACCOUNTS.consumablesUsed, 'debit', 50_000],
        [ACCOUNTS.licenceAndGovernmentFees, 'debit', 20_000],
        [ACCOUNTS.bankCharges, 'debit', 1_500],
        [ACCOUNTS.recoverableInputVat, 'debit', 2_500],
        [ACCOUNTS.tradePayables, 'credit', 74_000],
      ],
    },
  },
  {
    why: 'a gross that does not divide by 21, where an independently rounded VAT differs from the remainder',
    supplierCode: 'fixture-registered-consumables',
    supplierReference: 'FIX-ODD-0001',
    billDateDaysAgo: 100,
    creditDays: 7,
    lines: [
      {
        description: 'Retail stock, part carton',
        account: ACCOUNTS.costOfRetailGoodsSold,
        grossFils: 10_501,
        treatment: 'standard_recoverable',
      },
    ],
    expected: {
      // round(10,501 × 10,000 / 10,500) = round(10,000.95) = 10,001, and the VAT is the remainder, 500.
      netFils: 10_001,
      vatFils: 500,
      grossFils: 10_501,
      recoverableInputVatFils: 500,
      journalLines: [
        [ACCOUNTS.costOfRetailGoodsSold, 'debit', 10_001],
        [ACCOUNTS.recoverableInputVat, 'debit', 500],
        [ACCOUNTS.tradePayables, 'credit', 10_501],
      ],
    },
  },
  {
    why: 'an offshore supplier whose supply is outside the scope of UAE VAT: no claim, no VAT, and still a payable',
    supplierCode: 'fixture-offshore-training',
    supplierReference: 'FIX-TRAINING-0001',
    billDateDaysAgo: 5,
    creditDays: 0,
    lines: [
      {
        description: 'Therapist training delivered abroad',
        account: ACCOUNTS.professionalFees,
        grossFils: 400_000,
        treatment: 'out_of_scope',
      },
    ],
    expected: {
      netFils: 400_000,
      vatFils: 0,
      grossFils: 400_000,
      recoverableInputVatFils: 0,
      journalLines: [
        [ACCOUNTS.professionalFees, 'debit', 400_000],
        [ACCOUNTS.tradePayables, 'credit', 400_000],
      ],
    },
  },
  {
    why: 'a bill not yet due, so the `current` bucket is populated rather than assumed empty',
    supplierCode: 'fixture-registered-landlord',
    supplierReference: 'FIX-CURRENT-0001',
    billDateDaysAgo: 5,
    creditDays: 30,
    lines: [
      {
        description: 'Chilled water and electricity, recharged by the landlord',
        account: ACCOUNTS.utilities,
        grossFils: 315_000,
        treatment: 'standard_recoverable',
      },
    ],
    expected: {
      netFils: 300_000,
      vatFils: 15_000,
      grossFils: 315_000,
      recoverableInputVatFils: 15_000,
      journalLines: [
        [ACCOUNTS.utilities, 'debit', 300_000],
        [ACCOUNTS.recoverableInputVat, 'debit', 15_000],
        [ACCOUNTS.tradePayables, 'credit', 315_000],
      ],
    },
  },
  {
    why: "seventy-five days overdue: the 61-90 bucket, which is the one the acceptance's four names leave out",
    supplierCode: 'fixture-registered-consumables',
    supplierReference: 'FIX-OLD-0001',
    billDateDaysAgo: 80,
    creditDays: 5,
    lines: [
      {
        description: 'Repairs to the treatment room plumbing',
        account: ACCOUNTS.repairsAndMaintenance,
        grossFils: 21_000,
        treatment: 'standard_recoverable',
      },
    ],
    expected: {
      netFils: 20_000,
      vatFils: 1_000,
      grossFils: 21_000,
      recoverableInputVatFils: 1_000,
      journalLines: [
        [ACCOUNTS.repairsAndMaintenance, 'debit', 20_000],
        [ACCOUNTS.recoverableInputVat, 'debit', 1_000],
        [ACCOUNTS.tradePayables, 'credit', 21_000],
      ],
    },
  },
  {
    why: 'a zero-rated supply, so the fifth treatment is exercised rather than merely declared',
    supplierCode: 'fixture-registered-consumables',
    supplierReference: 'FIX-ZERO-0001',
    billDateDaysAgo: 130,
    creditDays: 30,
    lines: [
      {
        description: 'Exported goods handling, zero-rated',
        account: ACCOUNTS.marketing,
        grossFils: 88_000,
        treatment: 'zero_rated',
      },
    ],
    expected: {
      netFils: 88_000,
      vatFils: 0,
      grossFils: 88_000,
      recoverableInputVatFils: 0,
      journalLines: [
        [ACCOUNTS.marketing, 'debit', 88_000],
        [ACCOUNTS.tradePayables, 'credit', 88_000],
      ],
    },
  },
]

/** Calendar arithmetic on a `LocalDate`, without a clock. `days` may be negative. */
export function shiftDate(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(`${date}T00:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return localDate(shifted.toISOString().slice(0, 10))
}

/** The supplier's invoice date of one shape, as at the frozen clock. */
export function billDateOf(shape: FixtureBillShape, asOf: LocalDate = FIXTURE_TODAY): LocalDate {
  return shiftDate(asOf, -shape.billDateDaysAgo)
}

/** When the shape falls due: its invoice date plus its credit terms. */
export function dueDateOf(shape: FixtureBillShape, asOf: LocalDate = FIXTURE_TODAY): LocalDate {
  return shiftDate(billDateOf(shape, asOf), shape.creditDays)
}

/** The gross of one shape as `Money`, so a caller need not rebuild it from the line figures. */
export function grossOf(shape: FixtureBillShape): Money {
  return money(filsFrom(shape.expected.grossFils))
}

/**
 * The payables aging worked example: which bucket each shape falls in as at the frozen clock, and what
 * each bucket totals.
 *
 * Worked out from the due dates by hand. `FIXTURE_TODAY` is 18 September 2026, so:
 *
 *   FIX-CURRENT-0001   invoiced 5 days ago, 30 days credit   -> due in 25 days  -> current
 *   FIX-TRAINING-0001  invoiced 5 days ago, due on receipt   -> 5 days overdue  -> 1-30
 *   FIX-LAUNDRY-0001   invoiced 20 days ago, 14 days credit  -> 6 days overdue  -> 1-30
 *   FIX-RENT-0001      invoiced 40 days ago, 30 days credit  -> 10 days overdue -> 1-30
 *   FIX-MIXED-0001     invoiced 75 days ago, 30 days credit  -> 45 days overdue -> 31-60
 *   FIX-OLD-0001       invoiced 80 days ago, 5 days credit   -> 75 days overdue -> 61-90
 *   FIX-ODD-0001       invoiced 100 days ago, 7 days credit  -> 93 days overdue -> over 90
 *   FIX-ZERO-0001      invoiced 130 days ago, 30 days credit -> 100 days overdue -> over 90
 *
 * Every bucket is populated, including 61-90 — the one the acceptance's four names leave out, and the
 * one that would silently absorb into "90+" if the boundaries were wrong.
 *
 * The references are the **supplier's** invoice numbers, not our own. Our internal reference comes from
 * the gapless counter, so it depends on how many bills the database has ever issued and cannot be
 * committed; the supplier's number is a property of the fixture.
 */
export const FIXTURE_PAYABLES_AGING: readonly {
  readonly bucket: PayablesAgingBucket
  readonly totalFils: number
  readonly supplierReferences: readonly string[]
}[] = [
  { bucket: 'current', totalFils: 315_000, supplierReferences: ['FIX-CURRENT-0001'] },
  {
    bucket: 'days_1_30',
    totalFils: 2_100_000 + 63_000 + 400_000,
    supplierReferences: ['FIX-LAUNDRY-0001', 'FIX-RENT-0001', 'FIX-TRAINING-0001'],
  },
  { bucket: 'days_31_60', totalFils: 74_000, supplierReferences: ['FIX-MIXED-0001'] },
  { bucket: 'days_61_90', totalFils: 21_000, supplierReferences: ['FIX-OLD-0001'] },
  {
    bucket: 'days_over_90',
    totalFils: 10_501 + 88_000,
    supplierReferences: ['FIX-ODD-0001', 'FIX-ZERO-0001'],
  },
]

/** What every fixture bill adds up to: the payable the aging report must account for in full. */
export const FIXTURE_PAYABLES_TOTAL_FILS = FIXTURE_BILL_SHAPES.reduce(
  (total, shape) => total + shape.expected.grossFils,
  0,
)
