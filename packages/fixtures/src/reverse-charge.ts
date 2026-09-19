import {
  ACCOUNTS,
  type AccountCode,
  type BillTaxTreatment,
  type LocalDate,
  localDate,
  type PlaceOfSupplyRule,
  type SupplierResidency,
} from '@berelax/core'
import { SUPPLIER_FIXTURE_PREFIX } from './purchases.ts'

/**
 * The committed reverse-charge worked example: the offshore bills of one period, both sides of every pair,
 * and the one bill posted without a pair that the nightly report must find.
 *
 * Three of M-VAT-03's acceptance criteria are assertions about *these figures* — the pair of equal fils, the
 * blocked case "matching a committed worked example to the fils", and "exactly the one seeded fixture bill
 * posted without a pair and nothing else" — so the figures are worked out by hand at 5% and checked in.
 * `reverse-charge.test.ts` proves the pure derivation agrees with them; `reverse-charge.itest.ts` posts them
 * through `postBill` and proves the database, the ledger and the report do too.
 *
 * If the expectations were computed from `reverseChargeOn` they would hold however wrong it became, which is
 * the reason M-VAT-01 and M-VAT-02 both committed their own figures the same way.
 *
 * ## The period is its own, and the reason is not tidiness
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind, so a
 * "reverse charge declared in September 2026" assertion would be summing other suites' bills. These bills
 * are entered on a business day in **March 2027**, which no other suite posts into and which is past the
 * 400-day horizon `business-days.itest.ts` generates — so the trading-calendar row this suite inserts for
 * the report to resolve cannot be swept away by a regeneration that did not create it.
 *
 * ## Nothing here could be mistaken for a real supplier
 *
 * The five REAL offshore vendors — DigitalOcean, Resend, Google, Meta and Anthropic — are seeded by
 * `0028_purchases.sql`, because their residency is the fact the system must not be able to get wrong, and
 * nothing here duplicates them or posts a fixture invoice against them. A fixture bill on a real vendor is a
 * payable to a company that will be exported, demoed and eventually paid. So these suppliers carry
 * {@link SUPPLIER_FIXTURE_PREFIX} in their legal name and a `fixture-` code, and their TRN is null — which
 * is not a fixture convention but the law: an offshore supplier holds no UAE TRN, and
 * `supplier_tax_profile_offshore_holds_no_uae_trn` refuses one.
 */

/** The business day every bill in the worked example is entered on. */
export const REVERSE_CHARGE_ENTRY_DATE: LocalDate = localDate('2027-03-15')

/**
 * The VAT period the worked example covers.
 *
 * A calendar month, which is not a claim about the FTA's period length — that is the authority's to set
 * (Y11-tax-agent) — but a range with the entry date inside it and nothing else of this suite's in it.
 */
export const REVERSE_CHARGE_PERIOD = {
  from: localDate('2027-03-01'),
  to: localDate('2027-03-31'),
} as const

/**
 * The instant the entry date is resolved FROM, in the itest.
 *
 * 21:30Z on 15 March is 01:30 on the 16th in Abu Dhabi, and trading runs 11:00–02:00 — so it belongs to the
 * 15th's session. The fixture carries the instant rather than only the date so the itest resolves it with
 * `resolveTradingDate` instead of asserting a date it was handed: a bill entered after midnight is exactly
 * the case a truncated instant files into the next VAT period, and a reverse charge filed into the wrong
 * period is understated in one return and overstated in the next.
 */
export const REVERSE_CHARGE_ENTRY_INSTANT_ISO = '2027-03-15T21:30:00.000Z'

/**
 * The instant the nightly report is driven at, and the trading session it must resolve to.
 *
 * 04:15 Gulf time on 17 March is the cron's own hour. Trading closed at 02:00, so the session that has just
 * ended opened on the **16th** — which is why the report's business day is the 16th and not the 17th, and
 * why a pass that truncated its timestamp would scan one day too far and, at a month boundary, into a period
 * already filed.
 */
export const REVERSE_CHARGE_REPORT_AT_ISO = '2027-03-17T04:15:00+04:00'
export const REVERSE_CHARGE_REPORT_AS_OF: LocalDate = localDate('2027-03-16')
/** The trading session the report resolves its business day from. Inserted by the itest. */
export const REVERSE_CHARGE_REPORT_SESSION = {
  tradingDate: REVERSE_CHARGE_REPORT_AS_OF,
  opensAt: '2027-03-16T07:00:00Z',
  closesAt: '2027-03-16T22:00:00Z',
} as const

export interface ReverseChargeFixtureSupplier {
  readonly code: string
  readonly legalName: string
  readonly residency: SupplierResidency
  readonly placeOfSupplyRule: PlaceOfSupplyRule
  /** Always null for an offshore supplier: it issues no UAE tax invoice and can hold no UAE TRN. */
  readonly trn: null
}

/**
 * The offshore supplier shapes this unit needs, and the one misclassified supplier the report exists for.
 *
 * `fixture-offshore-misclassified` is the load-bearing one. It starts `outside_scope`, which is a legitimate
 * position for an offshore supplier, so a bill from it posts with no reverse charge and every constraint in
 * `0039_reverse_charge.sql` is satisfied. The itest then **corrects** its place-of-supply rule — an ordinary
 * admin change, which 0028 grants UPDATE on the profile for — and the bills already posted become missing
 * reverse charges retroactively. Nothing fires: PostgreSQL does not re-validate a CHECK on a row nobody
 * touched, and `bill` is append-only. That is the hole no constraint can close and the entire reason a
 * nightly scan exists.
 */
export const REVERSE_CHARGE_SUPPLIERS: readonly ReverseChargeFixtureSupplier[] = [
  {
    code: 'fixture-offshore-cloud',
    legalName: `${SUPPLIER_FIXTURE_PREFIX} offshore cloud hosting`,
    residency: 'offshore',
    placeOfSupplyRule: 'imported_services_reverse_charge',
    trn: null,
  },
  {
    // The blocked case needs an offshore supplier of something the chart denies recovery on. Hospitality
    // bought for customers is entertainment (0034, docs/04 §4), and an offshore platform billing for it is
    // the ordinary shape of a reverse charge that costs real money.
    code: 'fixture-offshore-hospitality',
    legalName: `${SUPPLIER_FIXTURE_PREFIX} offshore hospitality platform`,
    residency: 'offshore',
    placeOfSupplyRule: 'imported_services_reverse_charge',
    trn: null,
  },
  {
    code: 'fixture-offshore-misclassified',
    legalName: `${SUPPLIER_FIXTURE_PREFIX} offshore supplier recorded out of scope`,
    residency: 'offshore',
    placeOfSupplyRule: 'outside_scope',
    trn: null,
  },
]

/** What `fixture-offshore-misclassified` is corrected to, which is what turns its bill into an exception. */
export const CORRECTED_PLACE_OF_SUPPLY_RULE: PlaceOfSupplyRule = 'imported_services_reverse_charge'

export interface ReverseChargeBillLine {
  readonly description: string
  readonly account: AccountCode
  /**
   * What the supplier charged. For an offshore supply this is both the gross and the net: there is no UAE
   * VAT inside it, and the reverse-charge VAT is owed to the FTA rather than to the vendor.
   */
  readonly considerationFils: number
  readonly treatment: BillTaxTreatment
  /** The reverse charge this line declares, worked out by hand. Zero for a line that owes none. */
  readonly declaredFils: number
  /** What it reclaims: the whole declaration on a recoverable account, nothing on a blocked one. */
  readonly reclaimedFils: number
}

export interface ReverseChargeBillShape {
  /** Why this shape exists — the case it is the only test of. */
  readonly why: string
  /** A supplier code from {@link REVERSE_CHARGE_SUPPLIERS} or from `FIXTURE_SUPPLIERS`. */
  readonly supplierCode: string
  readonly supplierReference: string
  readonly lines: readonly ReverseChargeBillLine[]
  /** Worked out by hand at 5%, not computed from the code under test. */
  readonly expected: {
    readonly netFils: number
    readonly grossFils: number
    readonly recoverableInputVatFils: number
    readonly declaredFils: number
    readonly reclaimedFils: number
    /** `declared - reclaimed`: the reverse-charge tax the business bore. */
    readonly borneFils: number
    /** `[accountCode, 'debit' | 'credit', fils]`, in the order the entry posts them. */
    readonly journalLines: readonly [AccountCode, 'debit' | 'credit', number][]
  }
}

/**
 * The bills of the period: a recoverable import, a blocked one, a rounding case, a mixed invoice, a domestic
 * control and the one posted without a pair.
 *
 * The domestic control is not padding. "A domestic bill generates no pair" is an acceptance criterion, and a
 * suite with no domestic bill in the period could not tell a report that finds the right exception from one
 * that flags everything.
 */
export const REVERSE_CHARGE_BILL_SHAPES: readonly ReverseChargeBillShape[] = [
  {
    why: 'the ordinary imported service: declared and reclaimed in equal fils, so the net cash effect is nil',
    supplierCode: 'fixture-offshore-cloud',
    supplierReference: 'FIX-RC-CLOUD-0001',
    lines: [
      {
        description: 'Cloud hosting, March',
        account: ACCOUNTS.importedServices,
        considerationFils: 100_000,
        treatment: 'imported_services_reverse_charge',
        // 100,000 × 5% = 5,000 exactly, so this shape is the one where the arithmetic is checkable by eye
        // and any change to the rounding shows up immediately.
        declaredFils: 5_000,
        reclaimedFils: 5_000,
      },
    ],
    expected: {
      netFils: 100_000,
      grossFils: 100_000,
      recoverableInputVatFils: 0,
      declaredFils: 5_000,
      reclaimedFils: 5_000,
      borneFils: 0,
      // The pair, posted as two lines and never netted. Zero out of the ledger's VAT accounts on balance,
      // and 5,000 in each of the two VAT201 groupings — which is the whole point: netting them to nothing
      // would leave both boxes empty and the entry would still balance.
      journalLines: [
        [ACCOUNTS.importedServices, 'debit', 100_000],
        [ACCOUNTS.recoverableInputVat, 'debit', 5_000],
        [ACCOUNTS.reverseChargeVatPayable, 'credit', 5_000],
        [ACCOUNTS.tradePayables, 'credit', 100_000],
      ],
    },
  },
  {
    why: 'the blocked import: declared, NOT reclaimed, so the reverse charge costs the business the tax',
    supplierCode: 'fixture-offshore-hospitality',
    supplierReference: 'FIX-RC-BLOCKED-0001',
    lines: [
      {
        description: 'Customer refreshments sourced abroad',
        account: ACCOUNTS.entertainment,
        considerationFils: 42_000,
        treatment: 'imported_services_reverse_charge',
        declaredFils: 2_100,
        // Nothing. 0034 classifies entertainment as a category UAE VAT denies recovery on, and the
        // declaration stands regardless — which is where M-VAT-02's classification decides a figure here.
        reclaimedFils: 0,
      },
    ],
    expected: {
      netFils: 42_000,
      grossFils: 42_000,
      recoverableInputVatFils: 0,
      declaredFils: 2_100,
      reclaimedFils: 0,
      borneFils: 2_100,
      // The expense carries the consideration PLUS the tax that cannot be reclaimed: 42,000 + 2,100. And
      // 1080 is not touched at all, which is what makes the blocked case visible in the ledger.
      journalLines: [
        [ACCOUNTS.entertainment, 'debit', 44_100],
        [ACCOUNTS.reverseChargeVatPayable, 'credit', 2_100],
        [ACCOUNTS.tradePayables, 'credit', 42_000],
      ],
    },
  },
  {
    why: 'a consideration that does not divide by twenty, where the rounding rule is the only thing deciding the figure',
    supplierCode: 'fixture-offshore-cloud',
    supplierReference: 'FIX-RC-ROUNDING-0001',
    lines: [
      {
        description: 'Model tokens, part month',
        account: ACCOUNTS.importedServices,
        considerationFils: 10_101,
        treatment: 'imported_services_reverse_charge',
        // 10,101 × 500 / 10,000 = 505.05, and half-up gives 505. Truncation would give the same answer
        // here; FIX-RC-HALF-0001 below is the case where the two differ.
        declaredFils: 505,
        reclaimedFils: 505,
      },
    ],
    expected: {
      netFils: 10_101,
      grossFils: 10_101,
      recoverableInputVatFils: 0,
      declaredFils: 505,
      reclaimedFils: 505,
      borneFils: 0,
      journalLines: [
        [ACCOUNTS.importedServices, 'debit', 10_101],
        [ACCOUNTS.recoverableInputVat, 'debit', 505],
        [ACCOUNTS.reverseChargeVatPayable, 'credit', 505],
        [ACCOUNTS.tradePayables, 'credit', 10_101],
      ],
    },
  },
  {
    why: 'exactly half a fils of reverse charge, which is where half-up and truncation disagree',
    supplierCode: 'fixture-offshore-cloud',
    supplierReference: 'FIX-RC-HALF-0001',
    lines: [
      {
        description: 'Transactional email, part month',
        account: ACCOUNTS.importedServices,
        considerationFils: 4_010,
        treatment: 'imported_services_reverse_charge',
        // 4,010 × 500 / 10,000 = 200.5. Half-up gives 201; truncation would give 200, and `round()` in
        // PostgreSQL is half-up too — which is the agreement `reverse-charge.itest.ts` asserts rather than
        // assumes, because the rule is stated in SQL as well as in core.
        declaredFils: 201,
        reclaimedFils: 201,
      },
    ],
    expected: {
      netFils: 4_010,
      grossFils: 4_010,
      recoverableInputVatFils: 0,
      declaredFils: 201,
      reclaimedFils: 201,
      borneFils: 0,
      journalLines: [
        [ACCOUNTS.importedServices, 'debit', 4_010],
        [ACCOUNTS.recoverableInputVat, 'debit', 201],
        [ACCOUNTS.reverseChargeVatPayable, 'credit', 201],
        [ACCOUNTS.tradePayables, 'credit', 4_010],
      ],
    },
  },
  {
    why: 'one offshore invoice mixing a recoverable import with a blocked one — the case a per-BILL pair could not express',
    supplierCode: 'fixture-offshore-hospitality',
    supplierReference: 'FIX-RC-MIXED-0001',
    lines: [
      {
        description: 'Booking platform subscription',
        account: ACCOUNTS.importedServices,
        considerationFils: 20_000,
        treatment: 'imported_services_reverse_charge',
        declaredFils: 1_000,
        reclaimedFils: 1_000,
      },
      {
        description: 'Customer hospitality boxes',
        account: ACCOUNTS.entertainment,
        considerationFils: 8_400,
        treatment: 'imported_services_reverse_charge',
        declaredFils: 420,
        reclaimedFils: 0,
      },
    ],
    expected: {
      netFils: 28_400,
      grossFils: 28_400,
      recoverableInputVatFils: 0,
      // 1,420 declared and 1,000 reclaimed: the header sits BETWEEN all and nothing, which is why the
      // all-or-nothing rule is on the line and not on the bill.
      declaredFils: 1_420,
      reclaimedFils: 1_000,
      borneFils: 420,
      journalLines: [
        [ACCOUNTS.importedServices, 'debit', 20_000],
        [ACCOUNTS.entertainment, 'debit', 8_820],
        [ACCOUNTS.recoverableInputVat, 'debit', 1_000],
        [ACCOUNTS.reverseChargeVatPayable, 'credit', 1_420],
        [ACCOUNTS.tradePayables, 'credit', 28_400],
      ],
    },
  },
  {
    why: 'a domestic bill in the same period, which must generate no pair at all',
    supplierCode: 'fixture-registered-landlord',
    supplierReference: 'FIX-RC-DOMESTIC-0001',
    lines: [
      {
        description: 'Premises rent, March',
        account: ACCOUNTS.rent,
        // The gross here IS VAT-inclusive, unlike every other line above: a domestic supplier charged UAE
        // VAT inside it. 2,100,000 → 2,000,000 + 100,000.
        considerationFils: 2_100_000,
        treatment: 'standard_recoverable',
        declaredFils: 0,
        reclaimedFils: 0,
      },
    ],
    expected: {
      netFils: 2_000_000,
      grossFils: 2_100_000,
      recoverableInputVatFils: 100_000,
      declaredFils: 0,
      reclaimedFils: 0,
      borneFils: 0,
      journalLines: [
        [ACCOUNTS.rent, 'debit', 2_000_000],
        [ACCOUNTS.recoverableInputVat, 'debit', 100_000],
        [ACCOUNTS.tradePayables, 'credit', 2_100_000],
      ],
    },
  },
]

/**
 * The one bill posted WITHOUT a reverse charge, and the only row the nightly report must list.
 *
 * Kept apart from the shapes above because it is not a shape the posting path can produce: `postBill` and
 * `assert_reverse_charge_matches_place_of_supply()` both refuse an imported service that declares nothing.
 * It exists because its supplier was recorded `outside_scope` when the bill arrived — a legitimate position,
 * accepted by every layer — and the rule was corrected afterwards. That is the exception a scan finds and a
 * constraint cannot.
 */
export const UNREPORTED_REVERSE_CHARGE = {
  supplierCode: 'fixture-offshore-misclassified',
  supplierReference: 'FIX-RC-UNREPORTED-0001',
  description: 'Analytics platform, annual',
  account: ACCOUNTS.importedServices,
  /** Posted as `out_of_scope`, which is what the supplier's rule said at the time. */
  treatment: 'out_of_scope' as BillTaxTreatment,
  considerationFils: 63_000,
  /** What the reverse charge on it should have been: 63,000 × 5% = 3,150. The understatement. */
  shouldHaveDeclaredFils: 3_150,
  journalLines: [
    [ACCOUNTS.importedServices, 'debit', 63_000],
    [ACCOUNTS.tradePayables, 'credit', 63_000],
  ] as readonly [AccountCode, 'debit' | 'credit', number][],
} as const

/**
 * What the period's reverse charge must total, to the fils.
 *
 * Added up by hand from the shapes above:
 *
 *   declared   5,000 (cloud) + 2,100 (blocked) + 505 (rounding) + 201 (half) + 1,420 (mixed) = 9,226
 *   reclaimed  5,000          +     0          + 505            + 201        + 1,000         = 6,706
 *   borne                       2,100                                        +   420         = 2,520
 *
 * `borne` is the figure that matters, and it is deliberately NOT zero: a period whose reverse charge netted
 * to nothing would be one where every import happened to be recoverable, and the blocked case — the one that
 * costs money — would never have been exercised.
 *
 * `understated` is the one bill the report finds: what it should have declared, and did not.
 */
export const REVERSE_CHARGE_WORKED_EXAMPLE = {
  declaredFils: 9_226,
  reclaimedFils: 6_706,
  borneFils: 2_520,
  understatedFils: UNREPORTED_REVERSE_CHARGE.shouldHaveDeclaredFils,
} as const

/** What every shape adds up to: the payable the period creates, the reverse charge excluded. */
export const REVERSE_CHARGE_TOTAL_GROSS_FILS =
  REVERSE_CHARGE_BILL_SHAPES.reduce((total, shape) => total + shape.expected.grossFils, 0) +
  UNREPORTED_REVERSE_CHARGE.considerationFils

/** One shape by its supplier reference. For a test that wants a specific case without a find(). */
export function reverseChargeShape(supplierReference: string): ReverseChargeBillShape {
  const found = REVERSE_CHARGE_BILL_SHAPES.find(
    (shape) => shape.supplierReference === supplierReference,
  )
  if (found === undefined) {
    throw new Error(`No reverse-charge fixture shape "${supplierReference}"`)
  }
  return found
}

/** Every shape that declares a reverse charge. The population the pair assertions run over. */
export function shapesDeclaringAReverseCharge(): readonly ReverseChargeBillShape[] {
  return REVERSE_CHARGE_BILL_SHAPES.filter((shape) => shape.expected.declaredFils > 0)
}
