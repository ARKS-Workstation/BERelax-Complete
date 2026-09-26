import { AppError } from '@berelax/shared'
import type { PostedTender, TenderLine } from '../checkout/posting.ts'
import type { AccountCode } from '../ledger/account.ts'
import type { ChartOfAccounts } from '../ledger/chart-of-accounts.ts'
import { ACCOUNTS, accountFor } from '../ledger/chart-of-accounts.ts'
import type { EntryDraft, EntryId, EntryLineDraft, JournalEntry } from '../ledger/entry.ts'
import { credit, debit, postEntry } from '../ledger/entry.ts'
import type { Fils, Money } from '../money.ts'
import { filsFrom, money } from '../money.ts'
import type { LocalDate } from '../time.ts'
import { TenderReferenceMissing, tenderTypeOf } from './tender.ts'

/**
 * The terms a prepaid package is sold under, the allocation of its price across its lines, and the one
 * posting a sale produces.
 *
 * Pure, like everything else in `packages/core` — no clock, no I/O, no `process`. The *writes* are
 * `packages/db/src/services/sell-package.ts`, which may not import this package (brief rule 4), so it
 * takes the structural mirror `JournalEntryInput` and `packages/fixtures/src/package.ts` is the mapping.
 *
 * ## A package sale is not a supply
 *
 * **[UNVERIFIED] Y11-vat-package.** Whether the date of supply on a prepaid package is the sale or the
 * redemption is a tax-agent question and nobody has answered it. The provisional position — and the
 * strictest safe one, because it neither claims input recovery early nor understates a later return — is
 * **date of supply at redemption**: the money taken is a liability the salon owes treatments against, so
 * a sale posts
 *
 * ```
 *   Dr  1010 / 1040 / 1020   each tender, at what was handed over
 *     Cr  2050              Deferred revenue — packages, at the FULL gross
 * ```
 *
 * and posts **nothing** to any revenue account and **nothing** to `2030 Output VAT payable`. That is not
 * a convention this module happens to follow: {@link probePackageSalePosting} measures it off the entry's
 * own lines against the chart, `package_sale_posts_deferred_revenue_only` (ZG005, a DEFERRED constraint
 * trigger in `0078_package.sql`) measures it again off the rows PostgreSQL holds, and gate block 105
 * breaks each of the three and requires the suites to go red.
 *
 * Releasing `2050` into `4020 Package redemption revenue` and `2030` — recognising the supply, at the
 * value on the balance — is **M-TILL-10's**. If Y11-vat-package is answered the other way, what changes
 * is this posting and the trigger that holds it: the sale would credit `4020` net and `2030` the VAT, and
 * a redemption would move nothing. The tables do not change, because a balance still has to be drawn
 * down; nothing in `0078_package.sql` assumes which end the VAT event sits at.
 *
 * ## Why the price is ALLOCATED across the lines rather than left on the sale
 *
 * A package of five 60-minute massages and three facials, sold for less than the sum of its parts, has a
 * *per line* worth the moment one session is redeemed: the release into revenue has to be a figure, and
 * "the package cost 3,000" does not say what one facial out of it was worth. So the sale's gross is split
 * across the lines here, once, in proportion to what the lines would have cost at the version's own
 * prices, and `package_balance.value_fils` stores the result. M-TILL-10 reads it and never re-derives it:
 * a second allocation at redemption time is a second answer, and the two would disagree the moment the
 * catalogue's prices moved.
 *
 * The split is **largest remainder**, so the parts sum to the price EXACTLY (ADR 0007: integer fils, and
 * `net + vat === gross` exactly). Rounding each share independently loses or invents fils, and the fils
 * it loses is the one that makes the deferred-revenue balance disagree with the cash taken — which is the
 * acceptance line this unit is judged on.
 */

/** The liability a package sale credits. Named, so a posting rule never spells `'2050'` inline. */
export const PACKAGE_DEFERRED_REVENUE_ACCOUNT: AccountCode = ACCOUNTS.packageDeferredRevenue

/** The revenue a REDEMPTION credits. Declared here, used by M-TILL-10, and posted by nothing yet. */
export const PACKAGE_REDEMPTION_REVENUE_ACCOUNT: AccountCode = ACCOUNTS.packageRedemptionRevenue

/** Where output VAT would go if the answer to Y11-vat-package moved the supply to the sale. */
export const PACKAGE_OUTPUT_VAT_ACCOUNT: AccountCode = ACCOUNTS.outputVatPayable

/**
 * What happens to a balance still outstanding when the validity expires.
 *
 * `retained` leaves the liability where it is and lets the customer come back; `forfeited` writes it off
 * to breakage. Both are real commercial positions and the business has taken neither on paper.
 */
export const UNREDEEMED_BALANCE_POLICIES = ['retained', 'forfeited'] as const
export type UnredeemedBalancePolicy = (typeof UNREDEEMED_BALANCE_POLICIES)[number]

/** The three terms of a package, as a version fixes them and a sale snapshots them. */
export interface PackageTerms {
  /** Months from the sale's business day. The expiry DATE is derived in SQL — see below. */
  readonly validityMonths: number
  readonly transferable: boolean
  readonly unredeemedBalancePolicy: UnredeemedBalancePolicy
}

/** The open question all three terms stand in for, spelled once. */
export const PACKAGE_TERMS_OPEN_QUESTION = 'Y9-package-policy'

/**
 * The provisional terms, and each one is the STRICTEST SAFE option rather than the convenient one
 * (docs/12 §2).
 *
 * - **6 months.** Short enough that an uncorrected assumption does not leave an unbounded liability on
 *   the balance sheet; long enough to be a real package. A longer default would be the convenient one.
 * - **Non-transferable.** A transferable balance can be moved between customers, which is both a fraud
 *   path and a data-protection question nobody has been asked. False is the option that cannot be wrong
 *   in a way that costs the business money.
 * - **Retained, not forfeited.** Forfeiting a paid-for balance is the aggressive reading and, if the
 *   owner's real policy turns out to be retention, a forfeited balance has already been written off
 *   against a customer who was entitled to it. Retention also posts NOTHING at expiry, so the
 *   conservative answer is the one with no journal entry to reverse.
 *
 * There is deliberately no expiry ARITHMETIC here. `package_sale.expires_on` is a GENERATED column,
 * `(trading_date + make_interval(months => validity_months))::date`, so the derivation exists once, in
 * the place the row lives; a second copy in TypeScript is the "two answers" defect this codebase fights,
 * and it is M-TILL-10 that reads the column to decide whether a redemption is in time.
 */
export const PROVISIONAL_PACKAGE_TERMS: PackageTerms = Object.freeze({
  validityMonths: 6,
  transferable: false,
  unredeemedBalancePolicy: 'retained',
})

/** One line of a template version, as a sale has to value it. */
export interface PackageSaleLineDraft {
  /**
   * The caller's handle for the line — the template line's id or its number. Never invented here, and
   * carried through to the balance so the caller can match the allocation back to the row.
   */
  readonly lineId: string
  /** Strictly positive. A line entitling nobody to anything is not a line. */
  readonly sessionCount: number
  /**
   * What these sessions would have cost at the version's own prices: the variant gross × the session
   * count. The WEIGHT of the allocation, and never the amount posted.
   */
  readonly listGross: Money
}

/** One balance a sale opens: the entitlement, and the share of the price it carries. */
export interface PackageBalanceDraft {
  readonly lineId: string
  readonly sessionsTotal: number
  /** The share of the sale's gross this line carries. The shares sum to the price exactly. */
  readonly valueGross: Money
}

export interface PackageSalePostingInput {
  /** Allocated by the caller. Core never invents an id. */
  readonly entryId: EntryId
  /** The business day, already resolved with `resolveTradingDate`. Never a calendar date. */
  readonly entryDate: LocalDate
  /** What the customer is charged, VAT-inclusive gross. Authoritative (ADR 0007). */
  readonly priceGross: Money
  readonly lines: readonly PackageSaleLineDraft[]
  readonly tenders: readonly TenderLine[]
  /** Overrides the default, which names the package and counts its lines. */
  readonly narrative?: string
  /** What the entry's narrative calls the package. The template's internal name, never a person's. */
  readonly packageLabel: string
}

export interface PackageSalePosting {
  /** Balanced, frozen, and the only thing that reaches `journal_entry`. */
  readonly entry: JournalEntry
  /** One per tender, with the account resolved. What the caller records per payment row. */
  readonly tenders: readonly PostedTender[]
  /** One per line, in the input's order. `valueGross` sums to `priceGross` exactly. */
  readonly balances: readonly PackageBalanceDraft[]
  readonly priceGross: Money
  /** The sum of the lines' session counts. What `package_sale.session_count` snapshots. */
  readonly sessionsTotal: number
}

/** Raised when a package has no sessions to sell, or a line has a non-positive count. */
export class MalformedPackage extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('validation', `MalformedPackage: ${message}`, { details })
    this.name = 'MalformedPackage'
  }
}

/**
 * Raised when the tenders do not add up to the package price.
 *
 * Both directions are refused, for `TendersDoNotCoverBasket`'s reasons one domain along: under-tendering
 * is a receivable and over-tendering is change, and a sale that absorbed either would credit `2050` with
 * a liability the salon was never paid for — so every later reconciliation of the deferred-revenue
 * balance against the cash taken would be out by it, which is the one identity this unit exists to hold.
 */
export class PackageTendersDoNotCoverPrice extends AppError {
  readonly priceFils: number
  readonly tenderedFils: number
  constructor(packageLabel: string, priceFils: number, tenderedFils: number) {
    super(
      'validation',
      `PackageTendersDoNotCoverPrice: "${packageLabel}" is priced at ${priceFils} fils and the ` +
        `tenders come to ${tenderedFils} fils, a difference of ${tenderedFils - priceFils}. A ` +
        'partial payment leaves a receivable and an over-tender gives change; neither may be ' +
        'absorbed into a liability the salon was not paid for.',
      { details: { packageLabel, priceFils, tenderedFils } },
    )
    this.name = 'PackageTendersDoNotCoverPrice'
    this.priceFils = priceFils
    this.tenderedFils = tenderedFils
  }
}

/**
 * The price, split across `weights` so the parts sum to the total EXACTLY.
 *
 * Largest remainder: each part gets `floor(total × weight / Σweights)`, and the fils left over go one
 * each to the parts with the largest fractional remainders, ties broken by position. Deterministic, so
 * two runs over one package produce byte-identical balances — `trialBalance`'s reason for sorting.
 *
 * The arithmetic runs in `BigInt` and comes back to `number` at the end. `total × weight` is exact in a
 * double only below 2^53, and a 1,000,000-dirham package weighted by a 1,000,000-dirham line is
 * 10^8 × 10^8 = 10^16, which is past it — so the product would round and the shares would stop summing
 * to the total for inputs that are individually perfectly legal. Every value here is an integer, so the
 * `BigInt` conversion is exact and the result is back inside `Number.MAX_SAFE_INTEGER` by construction:
 * no share can exceed the total.
 *
 * A zero total weight allocates by position — it cannot arise from a catalogue variant, whose price is
 * `> 0` in the database, but "every weight is zero" has to mean something and losing the whole price
 * would be the worst of the available answers.
 */
export function allocateByWeight(total: Money, weights: readonly number[]): readonly Money[] {
  if (weights.length === 0) {
    throw new MalformedPackage('an allocation needs at least one part', { total: total.fils })
  }
  for (const [index, weight] of weights.entries()) {
    if (!Number.isInteger(weight) || weight < 0) {
      throw new MalformedPackage(
        `weight ${index + 1} is ${weight}; weights are non-negative integers`,
        { index, weight },
      )
    }
  }
  const totalWeight = weights.reduce((running, weight) => running + weight, 0)
  const effective = totalWeight === 0 ? weights.map(() => 1) : weights
  const effectiveTotal = totalWeight === 0 ? weights.length : totalWeight

  const totalFils = BigInt(total.fils)
  const denominator = BigInt(effectiveTotal)
  const scaled = effective.map((weight) => totalFils * BigInt(weight))
  const floors = scaled.map((product) => product / denominator)
  let left = totalFils - floors.reduce((running, part) => running + part, 0n)
  const order = scaled
    .map((product, index) => ({ index, remainder: product % denominator }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    )
  const shares = [...floors]
  for (const { index } of order) {
    if (left <= 0n) break
    shares[index] = (shares[index] ?? 0n) + 1n
    left -= 1n
  }
  return shares.map((share) => money(filsFrom(Number(share)), total.currency))
}

/**
 * The one journal entry a package sale produces, plus the balances it opens.
 *
 * One line per ACCOUNT, sorted by account code, for `checkout/posting.ts`'s reasons: two cash tenders on
 * one drawer are one debit, the per-tender detail is on the `payment` rows, and an insertion-ordered
 * entry diffs everywhere the moment a till changes the order somebody keys the money in.
 *
 * Debits equal credits **by construction**: the tenders are required to equal `priceGross` and the only
 * credit is `priceGross`. `postEntry` checks it anyway, and the deferred trigger in `0018_ledger.sql`
 * checks it again at COMMIT; neither is redundant, because this module is not the only thing that can
 * reach the journal.
 */
export function packageSalePosting(
  input: PackageSalePostingInput,
  chart: ChartOfAccounts,
): PackageSalePosting {
  if (input.lines.length === 0) {
    throw new MalformedPackage('a package with no lines entitles the customer to nothing', {
      packageLabel: input.packageLabel,
    })
  }
  for (const [index, line] of input.lines.entries()) {
    if (!Number.isInteger(line.sessionCount) || line.sessionCount <= 0) {
      throw new MalformedPackage(
        `line ${index + 1} ("${line.lineId}") sells ${line.sessionCount} session(s); a line ` +
          'entitling the customer to nothing is not a line',
        { lineId: line.lineId, sessionCount: line.sessionCount },
      )
    }
    if (line.listGross.fils < 0 || !Number.isInteger(line.listGross.fils)) {
      throw new MalformedPackage(
        `line ${index + 1} ("${line.lineId}") has a list value of ${line.listGross.fils} fils`,
        { lineId: line.lineId, listGrossFils: line.listGross.fils },
      )
    }
  }
  if (input.priceGross.fils <= 0) {
    throw new MalformedPackage(
      `"${input.packageLabel}" is priced at ${input.priceGross.fils} fils. A package sold for ` +
        'nothing is a gift, which is a different document and a different posting.',
      { packageLabel: input.packageLabel, priceFils: input.priceGross.fils },
    )
  }
  if (input.tenders.length === 0) {
    throw new PackageTendersDoNotCoverPrice(input.packageLabel, input.priceGross.fils, 0)
  }

  const tendered = input.tenders.reduce((running, tender) => running + tender.amount.fils, 0)
  if (tendered !== input.priceGross.fils) {
    throw new PackageTendersDoNotCoverPrice(input.packageLabel, input.priceGross.fils, tendered)
  }

  // `tenderTypeOf` is the ONE reader of "which account does this form of money land in" (M-TILL-07's
  // registry). Spelling the account here would be a second mapping, and the one that matters is
  // `card_in_salon` -> 1040 rather than 1020: the terminal settles in a batch, net of fees, days later.
  const posted: readonly PostedTender[] = input.tenders.map((tender) => {
    const spec = tenderTypeOf(tender.kind)
    if (tender.amount.fils <= 0) {
      throw new PackageTendersDoNotCoverPrice(input.packageLabel, input.priceGross.fils, tendered)
    }
    // Reused from the registry rather than restated: `requiresReference` is a property of the tender
    // type, and a card payment with nothing to settle a dispute with is the same storable row here as it
    // is at a checkout. `TenderReferenceMissing` is M-TILL-07's class for exactly this refusal.
    if (spec.requiresReference && tender.reference === undefined) {
      throw new TenderReferenceMissing(tender.kind)
    }
    return { ...tender, account: spec.account }
  })

  const byAccount = new Map<string, Fils>()
  for (const tender of posted) {
    const running = byAccount.get(tender.account as string) ?? filsFrom(0)
    byAccount.set(tender.account as string, filsFrom(running + tender.amount.fils))
  }

  const memo = `Package sold: ${input.packageLabel}`
  const lines: EntryLineDraft[] = [
    ...[...byAccount.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([account, fils]) =>
        debit(
          accountFor(chart, account as AccountCode).code,
          money(fils, input.priceGross.currency),
          memo,
        ),
      ),
    // The whole gross, and nothing split off it. This is the line Y11-vat-package's provisional answer
    // IS: no revenue, no output VAT, the entire consideration held as a liability until a treatment is
    // actually delivered against it.
    credit(PACKAGE_DEFERRED_REVENUE_ACCOUNT, input.priceGross, memo),
  ]

  const draft: EntryDraft = {
    entryId: input.entryId,
    entryDate: input.entryDate,
    narrative:
      input.narrative ??
      `Package sale: ${input.packageLabel}, ${input.lines.length} line(s), ` +
        `${input.tenders.length} tender(s)`,
    source: 'package_sale',
    lines,
  }
  const entry = postEntry(draft, chart)

  const shares = allocateByWeight(
    input.priceGross,
    input.lines.map((line) => line.listGross.fils),
  )
  const balances: readonly PackageBalanceDraft[] = input.lines.map((line, index) => ({
    lineId: line.lineId,
    sessionsTotal: line.sessionCount,
    valueGross: shares[index] ?? money(filsFrom(0), input.priceGross.currency),
  }))

  return {
    entry,
    tenders: posted,
    balances,
    priceGross: input.priceGross,
    sessionsTotal: input.lines.reduce((running, line) => running + line.sessionCount, 0),
  }
}

/** What a posting actually moved, measured off its own lines against the chart. */
export interface PackageSalePostingProbe {
  /**
   * TOTAL movement — debits PLUS credits — on every account the chart types as `revenue`.
   *
   * Deliberately not the net. A posting that credited `4010` and debited the contra `4095` by the same
   * figure has a NET revenue movement of zero and has recognised revenue on a package sale, which is the
   * exact thing Y11-vat-package's provisional answer forbids. The first version of this probe summed
   * `credit - debit` and would have reported that posting as clean: a check whose stated claim was not
   * what it measured.
   */
  readonly revenueMovementFils: number
  /** Total movement on `2030 Output VAT payable`, both sides, for the same reason. */
  readonly outputVatMovementFils: number
  /** Credits to `2050` minus debits to it. What the liability actually gained. */
  readonly deferredRevenueFils: number
  /** Every account code the entry touches, sorted. */
  readonly accountsTouched: readonly AccountCode[]
}

/**
 * Measures a posting against the claim "a package sale posts no revenue and no output VAT".
 *
 * Off the ENTRY's lines and the CHART's types, so it is a measurement rather than a restatement of how
 * {@link packageSalePosting} happens to be written: a rule that credited `4010` would be caught even
 * though nothing in the rule's own source says `4010`. `accountFor` throws `UnknownAccount` on a code the
 * chart does not contain, which is the right answer for a posting nobody can classify.
 *
 * Exported because three layers need it and none of them can be the only one: this unit's core tests,
 * `packages/fixtures/src/package.ts`'s reconciliation of the mapping, and — in SQL, over the rows
 * PostgreSQL holds rather than the object a caller built — ZG005.
 */
export function probePackageSalePosting(
  entry: JournalEntry,
  chart: ChartOfAccounts,
): PackageSalePostingProbe {
  let revenue = 0
  let outputVat = 0
  let deferred = 0
  const touched: AccountCode[] = []
  for (const line of entry.lines) {
    const account = accountFor(chart, line.account)
    touched.push(account.code)
    const movement = line.debitFils + line.creditFils
    if (account.type === 'revenue') revenue += movement
    if (account.code === PACKAGE_OUTPUT_VAT_ACCOUNT) outputVat += movement
    if (account.code === PACKAGE_DEFERRED_REVENUE_ACCOUNT) {
      deferred += line.creditFils - line.debitFils
    }
  }
  return {
    revenueMovementFils: revenue,
    outputVatMovementFils: outputVat,
    deferredRevenueFils: deferred,
    accountsTouched: [...touched].sort((a, b) =>
      (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0,
    ),
  }
}
