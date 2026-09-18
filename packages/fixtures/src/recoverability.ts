import {
  ACCOUNTS,
  type AccountCode,
  type BillTaxTreatment,
  type InputVatRecoverability,
  type LocalDate,
  localDate,
} from '@berelax/core'

/**
 * The committed input-VAT recovery worked example: the bills of one period, and what the return may
 * claim from them.
 *
 * Two of M-VAT-02's acceptance criteria are assertions about *these figures* — "the recoverable input VAT
 * total for a seeded period excludes every blocked line and matches a committed worked example to the
 * fils, with one entertainment bill present", and a table-driven test over "every blocked account in the
 * chart". So the figures are worked out by hand at 5% and checked in. `recoverability.test.ts` proves the
 * pure derivation agrees with them; `recoverability.itest.ts` posts them through `postBill` and proves the
 * database does too.
 *
 * If the expectations were computed from `deriveBill` they would hold however wrong `deriveBill` became,
 * which is the whole reason M-VAT-01 committed its own figures the same way.
 *
 * ## The period is its own, and the reason is not tidiness
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind, so a
 * "recoverable input VAT for September 2026" assertion would be summing other suites' bills within a
 * month. These bills are entered on a business day in **December 2026**, which no other suite posts into,
 * and the itest still asserts a *delta* across its own writes rather than a total — a foreign row in this
 * period would then be visible as a failure of the delta rather than silently inflating a figure that
 * looked right.
 *
 * ## Nothing here could be mistaken for a real supplier
 *
 * The same rule as `purchases.ts`: every supplier code carries the `fixture-` prefix and the TRN is one
 * that cannot have been issued. These reuse M-VAT-01's fixture suppliers by code so nothing invents a
 * second landlord.
 */

/** The business day every bill in the worked example is entered on. */
export const RECOVERABILITY_ENTRY_DATE: LocalDate = localDate('2026-12-15')

/**
 * The VAT period the worked example covers.
 *
 * A calendar month, which is not a claim about the FTA's period length — that is the authority's to set
 * (Y11-tax-agent) — but a range with the entry date inside it and nothing else of this suite's in it.
 */
export const RECOVERABILITY_PERIOD = {
  from: localDate('2026-12-01'),
  to: localDate('2026-12-31'),
} as const

/**
 * The instant the entry date is resolved FROM, in the itest.
 *
 * 21:30Z on 15 December is 01:30 on the 16th in Abu Dhabi, and trading runs 11:00–02:00 — so it belongs
 * to the 15th's session. The fixture carries the instant rather than only the date so the itest resolves
 * it with `resolveTradingDate` instead of asserting a date it was handed: a bill entered after midnight on
 * the last day of a VAT period is exactly the case a truncated instant files into the next period, and the
 * next period's return is one nobody has filed yet.
 */
export const RECOVERABILITY_ENTRY_INSTANT_ISO = '2026-12-15T21:30:00.000Z'

export interface RecoverabilityBillLine {
  readonly description: string
  readonly account: AccountCode
  /** VAT-inclusive and authoritative. Net, VAT and the claim are derived from it. */
  readonly grossFils: number
  readonly treatment: BillTaxTreatment
}

export interface RecoverabilityBillShape {
  /** Why this shape exists — the case it is the only test of. */
  readonly why: string
  /** A supplier code from `FIXTURE_SUPPLIERS` in `./purchases.ts`. Nothing invents a supplier here. */
  readonly supplierCode: string
  readonly supplierReference: string
  readonly lines: readonly RecoverabilityBillLine[]
  /** Worked out by hand at 5%, not computed from the code under test. */
  readonly expected: {
    readonly netFils: number
    readonly vatFils: number
    readonly grossFils: number
    readonly recoverableInputVatFils: number
    readonly blockedInputVatFils: number
    /** `[accountCode, 'debit' | 'credit', fils]`, in the order the entry posts them. */
    readonly journalLines: readonly [AccountCode, 'debit' | 'credit', number][]
  }
}

/**
 * The bills of the period: two blocked categories, a recoverable one, a bill that mixes them, and the two
 * non-recoverable reasons that are not "blocked".
 *
 * Every blocked account in the chart appears, and `recoverability.test.ts` fails if one does not — a
 * blocked category with no fixture is a category nothing has ever posted to, which is how a posting rule
 * that never worked stays green.
 */
export const RECOVERABILITY_BILL_SHAPES: readonly RecoverabilityBillShape[] = [
  {
    why: 'the entertainment bill the acceptance names: VAT charged, and none of it claimable',
    supplierCode: 'fixture-registered-consumables',
    supplierReference: 'FIX-BLOCK-TEA-0001',
    lines: [
      {
        description: 'Herbal tea and refreshments for the treatment rooms',
        account: ACCOUNTS.entertainment,
        grossFils: 21_000,
        treatment: 'blocked_not_recoverable',
      },
    ],
    expected: {
      // 21,000 × 20 / 21 = 20,000 exactly, so the split is checkable by eye.
      netFils: 20_000,
      vatFils: 1_000,
      grossFils: 21_000,
      recoverableInputVatFils: 0,
      blockedInputVatFils: 1_000,
      // The expense carries the whole gross: the 1,000 fils of VAT is cost, and account 1080 is not
      // touched at all.
      journalLines: [
        [ACCOUNTS.entertainment, 'debit', 21_000],
        [ACCOUNTS.tradePayables, 'credit', 21_000],
      ],
    },
  },
  {
    why: 'the other blocked category: a staff benefit no document records an obligation to provide',
    supplierCode: 'fixture-registered-landlord',
    supplierReference: 'FIX-BLOCK-TRANSPORT-0001',
    lines: [
      {
        description: 'Staff transport, 02:00 shift end',
        account: ACCOUNTS.staffAccommodation,
        grossFils: 52_500,
        treatment: 'blocked_not_recoverable',
      },
    ],
    expected: {
      netFils: 50_000,
      vatFils: 2_500,
      grossFils: 52_500,
      recoverableInputVatFils: 0,
      blockedInputVatFils: 2_500,
      journalLines: [
        [ACCOUNTS.staffAccommodation, 'debit', 52_500],
        [ACCOUNTS.tradePayables, 'credit', 52_500],
      ],
    },
  },
  {
    why: 'a recoverable bill in the same period, so the claim total is a figure rather than a zero',
    supplierCode: 'fixture-registered-landlord',
    supplierReference: 'FIX-RECOVER-RENT-0001',
    lines: [
      {
        description: 'Premises rent, December',
        account: ACCOUNTS.rent,
        grossFils: 2_100_000,
        treatment: 'standard_recoverable',
      },
    ],
    expected: {
      netFils: 2_000_000,
      vatFils: 100_000,
      grossFils: 2_100_000,
      recoverableInputVatFils: 100_000,
      blockedInputVatFils: 0,
      journalLines: [
        [ACCOUNTS.rent, 'debit', 2_000_000],
        [ACCOUNTS.recoverableInputVat, 'debit', 100_000],
        [ACCOUNTS.tradePayables, 'credit', 2_100_000],
      ],
    },
  },
  {
    why: 'one bill mixing a recoverable line with a blocked one — the case a per-BILL treatment could not express',
    supplierCode: 'fixture-registered-consumables',
    supplierReference: 'FIX-MIXED-BLOCK-0001',
    lines: [
      {
        description: 'Treatment consumables',
        account: ACCOUNTS.consumablesUsed,
        grossFils: 10_500,
        treatment: 'standard_recoverable',
      },
      {
        description: 'Customer refreshments',
        account: ACCOUNTS.entertainment,
        grossFils: 4_200,
        treatment: 'blocked_not_recoverable',
      },
    ],
    expected: {
      // 10,500 → 10,000 + 500 and 4,200 → 4,000 + 200. The VAT partitions exactly: 500 claimed, 200
      // disclosed, and nothing unaccounted for.
      netFils: 14_000,
      vatFils: 700,
      grossFils: 14_700,
      recoverableInputVatFils: 500,
      blockedInputVatFils: 200,
      journalLines: [
        [ACCOUNTS.consumablesUsed, 'debit', 10_000],
        [ACCOUNTS.entertainment, 'debit', 4_200],
        [ACCOUNTS.recoverableInputVat, 'debit', 500],
        [ACCOUNTS.tradePayables, 'credit', 14_700],
      ],
    },
  },
  {
    why: 'an unregistered supplier: not blocked, and not recoverable either — a different disclosure reason',
    supplierCode: 'fixture-unregistered-laundry',
    supplierReference: 'FIX-NOTRN-LAUNDRY-0001',
    lines: [
      {
        description: 'Linen laundry, weekly',
        account: ACCOUNTS.laundryAndCleaning,
        grossFils: 63_000,
        treatment: 'no_trn_not_recoverable',
      },
    ],
    expected: {
      netFils: 63_000,
      vatFils: 0,
      grossFils: 63_000,
      recoverableInputVatFils: 0,
      // Nothing is BLOCKED here: no VAT was charged at all, which is why the disclosure separates the
      // two. Tax the business bore and tax that never existed are different answers to a tax agent.
      blockedInputVatFils: 0,
      journalLines: [
        [ACCOUNTS.laundryAndCleaning, 'debit', 63_000],
        [ACCOUNTS.tradePayables, 'credit', 63_000],
      ],
    },
  },
  {
    why: 'a government fee: out of scope, so no VAT existed and the account carries none either',
    supplierCode: 'fixture-registered-landlord',
    supplierReference: 'FIX-OUTSCOPE-FEE-0001',
    lines: [
      {
        description: 'Municipality inspection fee',
        account: ACCOUNTS.licenceAndGovernmentFees,
        grossFils: 20_000,
        treatment: 'out_of_scope',
      },
    ],
    expected: {
      netFils: 20_000,
      vatFils: 0,
      grossFils: 20_000,
      recoverableInputVatFils: 0,
      blockedInputVatFils: 0,
      journalLines: [
        [ACCOUNTS.licenceAndGovernmentFees, 'debit', 20_000],
        [ACCOUNTS.tradePayables, 'credit', 20_000],
      ],
    },
  },
]

export interface RecoverabilityDisclosure {
  readonly reason: 'blocked_category' | 'no_supplier_trn' | 'no_vat_charged'
  readonly lineCount: number
  readonly netFils: number
  readonly grossFils: number
  readonly nonRecoverableVatFils: number
}

/**
 * What the period's input-VAT working paper must say, to the fils.
 *
 * Added up by hand from the shapes above:
 *
 *   recoverable      100,000 (rent) + 500 (consumables)                     = 100,500
 *   blocked            1,000 (tea) + 2,500 (transport) + 200 (refreshments) =   3,700
 *
 * The blocked figure is the non-recoverable disclosure line, and it is deliberately NOT zero: a blocked
 * bill that vanished from the return would look like a bill nobody entered.
 */
export const RECOVERABILITY_WORKED_EXAMPLE = {
  recoverableInputVatFils: 100_500,
  blockedInputVatFils: 3_700,
  /** Every reason, in report order. A reason with nothing in it is a zero row, never an absent one. */
  disclosures: [
    {
      reason: 'blocked_category',
      lineCount: 3,
      netFils: 20_000 + 50_000 + 4_000,
      grossFils: 21_000 + 52_500 + 4_200,
      nonRecoverableVatFils: 3_700,
    },
    {
      reason: 'no_supplier_trn',
      lineCount: 1,
      netFils: 63_000,
      grossFils: 63_000,
      // No VAT was charged, so nothing was borne. The disclosure is the expenditure, not a tax figure.
      nonRecoverableVatFils: 0,
    },
    {
      reason: 'no_vat_charged',
      lineCount: 1,
      netFils: 20_000,
      grossFils: 20_000,
      nonRecoverableVatFils: 0,
    },
  ] as readonly RecoverabilityDisclosure[],
} as const

/** What every shape in the worked example adds up to: the payable the period creates. */
export const RECOVERABILITY_TOTAL_GROSS_FILS = RECOVERABILITY_BILL_SHAPES.reduce(
  (total, shape) => total + shape.expected.grossFils,
  0,
)

/**
 * The classification each account in the worked example is coded under, as the chart states it today.
 *
 * Committed so the table-driven test asserts against a stated expectation rather than against whatever
 * the chart currently says — the difference between a test of the classification and a test that agrees
 * with itself.
 */
export const RECOVERABILITY_ACCOUNT_CLASSIFICATIONS: readonly {
  readonly account: AccountCode
  readonly recoverability: InputVatRecoverability
}[] = [
  { account: ACCOUNTS.entertainment, recoverability: 'blocked' },
  { account: ACCOUNTS.staffAccommodation, recoverability: 'blocked' },
  { account: ACCOUNTS.rent, recoverability: 'recoverable' },
  { account: ACCOUNTS.consumablesUsed, recoverability: 'recoverable' },
  { account: ACCOUNTS.laundryAndCleaning, recoverability: 'recoverable' },
  { account: ACCOUNTS.licenceAndGovernmentFees, recoverability: 'out_of_scope' },
  // The contrast that makes the employee-benefit rule mean something: the business IS obliged to provide
  // health insurance (docs/04 §7), so its input VAT is recoverable.
  { account: ACCOUNTS.insurance, recoverability: 'recoverable' },
]

/** One shape by its supplier reference. For a test that wants a specific case without a find(). */
export function recoverabilityShape(supplierReference: string): RecoverabilityBillShape {
  const found = RECOVERABILITY_BILL_SHAPES.find(
    (shape) => shape.supplierReference === supplierReference,
  )
  if (found === undefined) {
    throw new Error(`No recoverability fixture shape "${supplierReference}"`)
  }
  return found
}

/** Every shape that posts a line to this account. */
export function shapesTouching(account: AccountCode): readonly RecoverabilityBillShape[] {
  return RECOVERABILITY_BILL_SHAPES.filter((shape) =>
    shape.lines.some((line) => line.account === account),
  )
}
