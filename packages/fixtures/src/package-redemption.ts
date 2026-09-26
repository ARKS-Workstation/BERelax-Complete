import type { EntryId, JournalEntry, LocalDate, VatRateBp } from '@berelax/core'
import {
  ACCOUNTS,
  PACKAGE_DEFERRED_REVENUE_ACCOUNT,
  PACKAGE_OUTPUT_VAT_ACCOUNT,
  PACKAGE_REDEMPTION_REVENUE_ACCOUNT,
  type PackageBalanceState,
  type PackageRedemptionPosting,
  packageRedemptionPosting,
  probePackageRedemptionPosting,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import {
  DEFERRED_REVENUE_ACCOUNT_CODE,
  type JournalEntryInput,
  type RedeemPackageInput,
} from '@berelax/db'

/**
 * The mapping between `@berelax/core`'s redemption rule and `@berelax/db`'s writer.
 *
 * `packages/db` may never import `packages/core` — the dependency runs the other way — so something has to
 * turn a balance, a number of sessions and a business day into the structural mirrors `redeemPackage` takes:
 * a `JournalEntryInput` and the three figures that go on the row. `packages/fixtures` is the package allowed
 * to depend on both, which is what `package.ts` is for the sale side and `cash-up.ts` for the drawer.
 *
 * Nothing here decides an account, computes a release or derives a date. The accounts come from
 * `packageRedemptionPosting`, the release from `releaseForSessions` inside it, the VAT from `splitGross`
 * inside that, and the business day is the caller's — resolved with `resolveTradingDate`, because trading
 * runs 11:00–02:00 and a 01:30 treatment belongs to the previous trading date.
 *
 * ## Why the reconciliation reads the MAPPED input and not core's objects
 *
 * The mapping is the layer neither half's own suite can see. A mapping that dropped the `2030` line or sent
 * `net` where the row wanted `gross` would leave both halves green and put a wrong figure in a VAT box —
 * `cash-up.ts` learned that the hard way, and gate 103 showed a mapping that silently omitted a posting was
 * invisible to everything but the pair. So {@link reconcilePackageRedemptionMapping} measures off
 * `input.journal`, which is the object `postJournalEntry` will actually write, and compares it against the
 * three figures on `input` — two independently mapped things rather than one thing twice.
 *
 * That distinction is the whole point and it is easy to lose. A reconciliation that read both sides out of
 * `posting` would compare a value to itself and report agreement for a mapping that had mangled every field,
 * which is the defect M-TILL-11 shipped in its expectedFloat control and reported as PASS.
 */

export interface PackageRedemptionMappingInput {
  readonly entryId: EntryId
  /** The BUSINESS DAY. Both the entry's date and the row's — ZG008 requires them equal. */
  readonly tradingDate: LocalDate
  /** The balance as the database holds it. `releasedGross` is checked against the formula by core. */
  readonly balance: PackageBalanceState
  readonly appointmentId: string
  readonly units: number
  readonly rateBp?: VatRateBp
  /** The template's internal name. Never a person's name (brief rule 10). */
  readonly packageLabel: string
}

export interface PackageRedemptionMapping {
  /** What `redeemPackage` is called with. */
  readonly input: RedeemPackageInput
  /** Core's own result, so a caller can assert against the rule rather than against the mapping. */
  readonly posting: PackageRedemptionPosting
}

export class PackageRedemptionMappingMismatch extends Error {
  constructor(message: string) {
    super(`PackageRedemptionMappingMismatch: ${message}`)
    this.name = 'PackageRedemptionMappingMismatch'
  }
}

const toEntryInput = (entry: JournalEntry): JournalEntryInput => ({
  entryId: entry.entryId as string,
  entryDate: entry.entryDate as string,
  narrative: entry.narrative,
  source: entry.source,
  lines: entry.lines.map((line) => ({
    accountCode: line.account as string,
    debitFils: line.debitFils,
    creditFils: line.creditFils,
    memo: line.memo,
  })),
})

export function packageRedemptionMapping(
  options: PackageRedemptionMappingInput,
): PackageRedemptionMapping {
  const posting = packageRedemptionPosting(
    {
      entryId: options.entryId,
      entryDate: options.tradingDate,
      balance: options.balance,
      units: options.units,
      packageLabel: options.packageLabel,
      ...(options.rateBp === undefined ? {} : { rateBp: options.rateBp }),
    },
    STANDARD_SPA_CHART,
  )

  return {
    posting,
    input: {
      packageBalanceId: options.balance.balanceId,
      appointmentId: options.appointmentId,
      units: options.units,
      tradingDate: options.tradingDate as string,
      releasedFils: posting.releasedGross.fils,
      vatFils: posting.vat.fils,
      vatRateBp: posting.rateBp,
      journal: toEntryInput(posting.entry),
    },
  }
}

export interface PackageRedemptionReconciliation {
  /** `Dr 2050` minus `Cr 2050`, off the MAPPED entry. Must equal `input.releasedFils`. */
  readonly deferredReleasedFils: number
  /** `Cr 4020` minus `Dr 4020`, off the MAPPED entry. Must equal `released - vat`. */
  readonly redemptionRevenueFils: number
  /** `Cr 2030` minus `Dr 2030`, off the MAPPED entry. Must equal `input.vatFils`. */
  readonly outputVatFils: number
  /** Debits PLUS credits on every revenue account that is not `4020`. Must be zero. */
  readonly otherRevenueMovementFils: number
  /** Whether the entry's date equals the row's `tradingDate`. ZG008's first fact, before COMMIT. */
  readonly entryIsOnTheTradingDay: boolean
  /** Whether `net + vat === gross` holds on the mapped figures. ADR 0007, measured not assumed. */
  readonly splitIsExact: boolean
  /**
   * Whether core's account constant and db's `DEFERRED_REVENUE_ACCOUNT_CODE` agree.
   *
   * The third statement of the code is ZG008's literal `'2050'` in SQL, which no import can reach; the
   * itest beside this file compares that one.
   */
  readonly deferredRevenueCodeAgrees: boolean
  /** Whether `4050 Unredeemed voucher breakage` is touched. Must be false: a package is not a voucher. */
  readonly touchesVoucherBreakage: boolean
}

/**
 * Reconciles a mapping against the claims the two halves each make separately.
 *
 * Every figure on the left comes from the MAPPED `JournalEntryInput` and every figure it is compared against
 * comes from the MAPPED row fields, so a mapping that mangled either is visible here and nowhere else.
 *
 * `otherRevenueMovementFils` sums debits PLUS credits rather than the net, ZG005's and ZG008's reason: an
 * entry crediting `4010` and debiting the contra `4095` by the same figure nets to zero and has put a
 * package's revenue on the wrong account and the wrong VAT box, with the trial balance still balancing.
 */
export function reconcilePackageRedemptionMapping(
  mapping: PackageRedemptionMapping,
): PackageRedemptionReconciliation {
  const { journal } = mapping.input
  let deferred = 0
  let revenue = 0
  let outputVat = 0
  let otherRevenue = 0
  let voucher = false
  for (const line of journal.lines) {
    if (line.accountCode === (PACKAGE_DEFERRED_REVENUE_ACCOUNT as string)) {
      deferred += line.debitFils - line.creditFils
    }
    if (line.accountCode === (PACKAGE_REDEMPTION_REVENUE_ACCOUNT as string)) {
      revenue += line.creditFils - line.debitFils
    } else {
      // The chart, not a list of codes: a rule that credited an account added to the chart tomorrow would
      // still be measured. `find` rather than `accountFor` because the mapped line is a plain string and an
      // unknown code here is a mapping defect worth reporting as one rather than a thrown UnknownAccount.
      const account = STANDARD_SPA_CHART.accounts.find(
        (row) => (row.code as string) === line.accountCode,
      )
      if (account?.type === 'revenue') otherRevenue += line.debitFils + line.creditFils
    }
    if (line.accountCode === (PACKAGE_OUTPUT_VAT_ACCOUNT as string)) {
      outputVat += line.creditFils - line.debitFils
    }
    if (line.accountCode === (ACCOUNTS.voucherBreakageRevenue as string)) voucher = true
  }
  return {
    deferredReleasedFils: deferred,
    redemptionRevenueFils: revenue,
    outputVatFils: outputVat,
    otherRevenueMovementFils: otherRevenue,
    entryIsOnTheTradingDay: journal.entryDate === mapping.input.tradingDate,
    splitIsExact:
      mapping.posting.net.fils + mapping.posting.vat.fils === mapping.input.releasedFils,
    deferredRevenueCodeAgrees:
      DEFERRED_REVENUE_ACCOUNT_CODE === (PACKAGE_DEFERRED_REVENUE_ACCOUNT as string),
    touchesVoucherBreakage: voucher,
  }
}

/**
 * Throws unless every claim holds. What a test calls instead of restating seven assertions.
 *
 * The comparisons are stated with the MAPPED row figure on one side, never with core's `posting` on both:
 * that is the difference between a reconciliation and a tautology.
 */
export function assertPackageRedemptionMappingReconciles(
  mapping: PackageRedemptionMapping,
): PackageRedemptionMapping {
  const measured = reconcilePackageRedemptionMapping(mapping)
  const row = mapping.input
  const expectedNet = row.releasedFils - row.vatFils
  // The probe off core's own frozen `JournalEntry`, as a second opinion on the same entry by a different
  // route. Not redundant with the first comparison below: that one reads the MAPPED input and this reads
  // core's object, so a mapping that lost a line agrees with neither.
  const probed = probePackageRedemptionPosting(mapping.posting.entry, STANDARD_SPA_CHART)
  // A TABLE of (held, what it would mean) rather than a run of `if`s, so every comparison has the ledger
  // figure on one side and the ROW figure on the other and none of them can quietly become a comparison of
  // core's posting with itself.
  const checks: readonly (readonly [boolean, string])[] = [
    [
      measured.deferredReleasedFils === row.releasedFils,
      `the entry debits 2050 by ${measured.deferredReleasedFils} fils and the row releases ` +
        `${row.releasedFils}`,
    ],
    [
      measured.redemptionRevenueFils === expectedNet,
      `the entry credits 4020 by ${measured.redemptionRevenueFils} fils and the row's net is ` +
        `${expectedNet}`,
    ],
    [
      measured.outputVatFils === row.vatFils,
      `the entry credits 2030 by ${measured.outputVatFils} fils and the row carries ${row.vatFils}`,
    ],
    [
      measured.otherRevenueMovementFils === 0,
      `the entry moves ${measured.otherRevenueMovementFils} fils across revenue accounts other than 4020`,
    ],
    [
      measured.entryIsOnTheTradingDay,
      `the entry is dated ${row.journal.entryDate} and the redemption is on ${row.tradingDate}`,
    ],
    [measured.splitIsExact, 'net + vat does not equal the released gross'],
    [
      measured.deferredRevenueCodeAgrees,
      `core says the liability is ${PACKAGE_DEFERRED_REVENUE_ACCOUNT} and db says ` +
        `${DEFERRED_REVENUE_ACCOUNT_CODE}`,
    ],
    [
      !measured.touchesVoucherBreakage,
      'the entry touches 4050 Unredeemed voucher breakage, which is the voucher account',
    ],
    [
      probed.deferredReleasedFils === row.releasedFils,
      `core's own entry releases ${probed.deferredReleasedFils} fils and the mapped row says ` +
        `${row.releasedFils}`,
    ],
  ]

  const failures = checks.filter(([held]) => !held).map(([, why]) => why)
  if (failures.length > 0) throw new PackageRedemptionMappingMismatch(failures.join('; '))
  return mapping
}

/**
 * What the per-session release formula gives, computed by `@berelax/core`, for a census against SQL.
 *
 * Exported from here rather than from a test file because the census is the only thing that says the
 * TypeScript and the SQL agree, and it is run from the itest beside this file — the one place that can call
 * `releaseThrough` and `package_release_through_fils` in the same process. A re-implementation of the
 * formula in either place would make the census compare something to itself.
 */
export type ReleaseCensusRow = {
  readonly valueFils: number
  readonly sessionsTotal: number
  readonly sessionsRedeemed: number
  readonly releasedFils: number
}

/** The (value, total, redeemed) box the census walks. Bounded, and stated once so both halves walk it. */
export function releaseCensusBox(): readonly { valueFils: number; sessionsTotal: number }[] {
  const values = [1, 2, 3, 7, 11, 99, 100, 101, 999, 1_000, 33_333, 100_000, 999_983]
  const totals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 24, 30]
  return values.flatMap((valueFils) =>
    totals.map((sessionsTotal) => ({ valueFils, sessionsTotal })),
  )
}
