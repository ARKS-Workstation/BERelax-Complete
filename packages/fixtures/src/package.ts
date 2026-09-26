import type { EntryId, JournalEntry, LocalDate, Money, TenderLine } from '@berelax/core'
import {
  filsFrom,
  money,
  PACKAGE_DEFERRED_REVENUE_ACCOUNT,
  type PackageSaleLineDraft,
  type PackageSalePosting,
  packageSalePosting,
  probePackageSalePosting,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import type {
  JournalEntryInput,
  PackageBalanceInput,
  PackageTenderInput,
  SellPackageInput,
} from '@berelax/db'
import { DEFERRED_REVENUE_ACCOUNT_CODE } from '@berelax/db'

/**
 * The mapping between `@berelax/core`'s package-sale rule and `@berelax/db`'s writer.
 *
 * `packages/db` may never import `packages/core` — the dependency runs the other way — so something has
 * to turn a template version, a price and a set of tenders into the structural mirrors `sellPackage`
 * takes: a `JournalEntryInput` and one `PackageBalanceInput` per line. `packages/fixtures` is the package
 * allowed to depend on both, which is what `checkout.ts` is for the checkout side and `cash-up.ts` for
 * the drawer.
 *
 * Nothing here decides an account, allocates anything or derives a date. The accounts come from
 * `packageSalePosting`, the per-line shares from `allocateByWeight` inside it, and the business day is
 * the caller's — resolved with `resolveTradingDate`, because trading runs 11:00–02:00 and a 01:30 sale
 * belongs to the previous trading date.
 *
 * ## The line NUMBER is the join, and it is the template's
 *
 * Core works in opaque `lineId`s and knows nothing about `package_template_line.line_no`; the database
 * keys a balance on `(package_sale_id, line_no)`. So the caller supplies the template's lines in
 * `line_no` order and this mapping pairs them by POSITION, asserting the counts match. Pairing them by
 * the id would be tidier and would silently drop a line whose id the caller spelled differently, and a
 * dropped line is an entitlement the customer paid for and cannot draw on — which ZG006 would refuse at
 * COMMIT, naming a count rather than the line.
 */

/** One line of the version being sold, as the caller reads it out of `package_template_line`. */
export interface PackageSaleLineOrigin {
  readonly lineNo: number
  readonly serviceVariantId: string
  readonly sessionCount: number
  /** The variant's gross price × the session count. The allocation WEIGHT, never an amount posted. */
  readonly listGrossFils: number
}

export interface PackageSaleMappingInput {
  readonly entryId: EntryId
  /** The business day. Both the sale's `trading_date` and the entry's date — ZG005 requires them equal. */
  readonly tradingDate: LocalDate
  readonly customerId: string
  readonly templateVersionId: string
  /** What the customer is charged, VAT-inclusive gross. */
  readonly priceGross: Money
  /** The version's lines, in `line_no` order. */
  readonly lines: readonly PackageSaleLineOrigin[]
  readonly tenders: readonly TenderLine[]
  /** The version's terms, snapshotted onto the sale and held equal to it by ZG002. */
  readonly validityMonths: number
  readonly transferable: boolean
  readonly unredeemedBalancePolicy: 'retained' | 'forfeited'
  /** The template's internal name. Never a person's name (brief rule 10). */
  readonly packageLabel: string
}

export interface PackageSaleMapping {
  /** What `sellPackage` is called with. */
  readonly input: SellPackageInput
  /** Core's own result, so a caller can assert against the rule rather than against the mapping. */
  readonly posting: PackageSalePosting
}

export class PackageSaleMappingMismatch extends Error {
  constructor(message: string) {
    super(`PackageSaleMappingMismatch: ${message}`)
    this.name = 'PackageSaleMappingMismatch'
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

export function packageSaleMapping(options: PackageSaleMappingInput): PackageSaleMapping {
  const drafts: readonly PackageSaleLineDraft[] = options.lines.map((line) => ({
    lineId: String(line.lineNo),
    sessionCount: line.sessionCount,
    listGross: money(filsFrom(line.listGrossFils), options.priceGross.currency),
  }))

  const posting = packageSalePosting(
    {
      entryId: options.entryId,
      entryDate: options.tradingDate,
      priceGross: options.priceGross,
      lines: drafts,
      tenders: options.tenders,
      packageLabel: options.packageLabel,
    },
    STANDARD_SPA_CHART,
  )

  if (posting.balances.length !== options.lines.length) {
    throw new PackageSaleMappingMismatch(
      `the rule returned ${posting.balances.length} balance(s) for ${options.lines.length} line(s)`,
    )
  }

  const balances: readonly PackageBalanceInput[] = options.lines.map((line, index) => {
    const balance = posting.balances[index]
    if (balance === undefined) {
      throw new PackageSaleMappingMismatch(`no allocated share for line ${line.lineNo}`)
    }
    // Paired by POSITION, and the id is checked rather than trusted: `lineId` is this mapping's own
    // `String(line_no)`, so a mismatch here means the rule reordered the lines — which would put one
    // line's money on another line's entitlement, and both would still sum to the price.
    if (balance.lineId !== String(line.lineNo)) {
      throw new PackageSaleMappingMismatch(
        `share ${index + 1} is for line "${balance.lineId}" and line ${index + 1} is ${line.lineNo}`,
      )
    }
    return {
      lineNo: line.lineNo,
      serviceVariantId: line.serviceVariantId,
      sessionsTotal: balance.sessionsTotal,
      valueFils: balance.valueGross.fils,
    }
  })

  const tenders: readonly PackageTenderInput[] = posting.tenders.map((tender) => ({
    tenderKind: tender.kind,
    postingAccountCode: tender.account as string,
    amountFils: tender.amount.fils,
    ...(tender.reference === undefined ? {} : { reference: tender.reference }),
  }))

  return {
    posting,
    input: {
      customerId: options.customerId,
      templateVersionId: options.templateVersionId,
      tradingDate: options.tradingDate as string,
      priceFils: options.priceGross.fils,
      sessionCount: posting.sessionsTotal,
      validityMonths: options.validityMonths,
      transferable: options.transferable,
      unredeemedBalancePolicy: options.unredeemedBalancePolicy,
      journal: toEntryInput(posting.entry),
      balances,
      tenders,
    },
  }
}

export interface PackageSaleReconciliation {
  /** `sum(debit) - sum(credit)` over the mapped entry. Zero for every mapping. */
  readonly imbalanceFils: number
  /** Credits to `2050` minus debits to it, off the MAPPED lines rather than off core's entry. */
  readonly deferredRevenueFils: number
  /**
   * Total movement — debits PLUS credits — on every revenue account, measured TWICE and reported twice.
   *
   * `...ByCodeFils` reads the MAPPED lines and matches the chart's 4xxx revenue block; `...ByTypeFils`
   * reads core's entry and asks the chart what each account's `type` is. Two numbers rather than one,
   * because they answer slightly different questions and a single field would have to pick: the block is
   * what a mapping that renamed a code would break, and the type is what the chart actually says. A
   * `Math.max` of the two was the first version, and "the larger of two measurements" is not a
   * measurement of anything.
   */
  readonly revenueMovementByCodeFils: number
  readonly revenueMovementByTypeFils: number
  readonly outputVatMovementFils: number
  /** The balances' shares, summed. Equal to the price for every mapping. */
  readonly allocatedFils: number
  readonly tenderedFils: number
  /** Whether the three layers agree on which code the liability is. */
  readonly deferredRevenueCodeAgrees: boolean
}

/**
 * Reconciles a mapping against the claims the two halves each make separately.
 *
 * Read off the MAPPED `JournalEntryInput` and the MAPPED balances, not off core's objects: the mapping is
 * the layer neither half's own suite can see, and a mapping that dropped the `2050` line or truncated the
 * balances would leave both halves green. `cash-up.ts` learned that the hard way — gate 103 showed a
 * mapping that silently omitted a posting was invisible to everything but the pair.
 *
 * `deferredRevenueCodeAgrees` is the third statement of the account code, and the only place all three
 * can be compared: `@berelax/core`'s `ACCOUNTS.packageDeferredRevenue`, `@berelax/db`'s
 * `DEFERRED_REVENUE_ACCOUNT_CODE`, and — in SQL, which no import can reach — ZG005's literal. The
 * itest beside this file compares the third.
 */
export function reconcilePackageSaleMapping(
  mapping: PackageSaleMapping,
): PackageSaleReconciliation {
  const lines = mapping.input.journal.lines
  const probe = probePackageSalePosting(mapping.posting.entry, STANDARD_SPA_CHART)
  const revenueMovement = lines
    .filter((line) => line.accountCode.startsWith('4'))
    .reduce((running, line) => running + line.debitFils + line.creditFils, 0)
  return {
    imbalanceFils: lines.reduce((running, line) => running + line.debitFils - line.creditFils, 0),
    deferredRevenueFils: lines
      .filter((line) => line.accountCode === DEFERRED_REVENUE_ACCOUNT_CODE)
      .reduce((running, line) => running + line.creditFils - line.debitFils, 0),
    revenueMovementByCodeFils: revenueMovement,
    revenueMovementByTypeFils: probe.revenueMovementFils,
    outputVatMovementFils: lines
      .filter((line) => line.accountCode === '2030')
      .reduce((running, line) => running + line.debitFils + line.creditFils, 0),
    allocatedFils: mapping.input.balances.reduce(
      (running, balance) => running + balance.valueFils,
      0,
    ),
    tenderedFils: mapping.input.tenders.reduce((running, tender) => running + tender.amountFils, 0),
    deferredRevenueCodeAgrees:
      (PACKAGE_DEFERRED_REVENUE_ACCOUNT as string) === DEFERRED_REVENUE_ACCOUNT_CODE,
  }
}

/** Throws unless every identity holds. What a caller uses when it wants the mapping or nothing. */
export function assertPackageSaleMappingReconciles(
  mapping: PackageSaleMapping,
): PackageSaleMapping {
  const r = reconcilePackageSaleMapping(mapping)
  const problems: string[] = []
  if (r.imbalanceFils !== 0) problems.push(`the entry is out by ${r.imbalanceFils} fils`)
  if (r.deferredRevenueFils !== mapping.input.priceFils) {
    problems.push(
      `2050 is credited ${r.deferredRevenueFils} fils against a price of ${mapping.input.priceFils}`,
    )
  }
  if (r.revenueMovementByCodeFils !== 0) {
    problems.push(`${r.revenueMovementByCodeFils} fils moved on a 4xxx revenue code`)
  }
  if (r.revenueMovementByTypeFils !== 0) {
    problems.push(
      `${r.revenueMovementByTypeFils} fils moved on an account the chart types as revenue`,
    )
  }
  if (r.outputVatMovementFils !== 0) {
    problems.push(`${r.outputVatMovementFils} fils moved on 2030 Output VAT payable`)
  }
  if (r.allocatedFils !== mapping.input.priceFils) {
    problems.push(
      `the balances are worth ${r.allocatedFils} fils against a price of ${mapping.input.priceFils}`,
    )
  }
  if (r.tenderedFils !== mapping.input.priceFils) {
    problems.push(`the tenders come to ${r.tenderedFils} fils`)
  }
  if (!r.deferredRevenueCodeAgrees) {
    problems.push('core and db disagree about which account the package liability is')
  }
  if (problems.length > 0) {
    throw new PackageSaleMappingMismatch(problems.join('; '))
  }
  return mapping
}
