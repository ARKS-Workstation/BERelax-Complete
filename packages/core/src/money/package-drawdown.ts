import { AppError } from '@berelax/shared'
import type { AccountCode } from '../ledger/account.ts'
import type { ChartOfAccounts } from '../ledger/chart-of-accounts.ts'
import { ACCOUNTS, accountFor } from '../ledger/chart-of-accounts.ts'
import type { EntryDraft, EntryId, JournalEntry } from '../ledger/entry.ts'
import { credit, debit, postEntry } from '../ledger/entry.ts'
import type { Money, VatRateBp } from '../money.ts'
import { filsFrom, money, splitGross, UAE_STANDARD_VAT_BP } from '../money.ts'
import type { LocalDate } from '../time.ts'
import {
  PACKAGE_DEFERRED_REVENUE_ACCOUNT,
  PACKAGE_OUTPUT_VAT_ACCOUNT,
  PACKAGE_REDEMPTION_REVENUE_ACCOUNT,
  type UnredeemedBalancePolicy,
} from './package-terms.ts'

/**
 * The redemption: what a delivered treatment releases out of a prepaid balance, the posting that
 * recognises it, expiry, and what breakage is under the provisional policy — which is not a posting.
 *
 * Pure, like everything in `packages/core`: no clock, no I/O, no `process`. `expiresOn` and the date a
 * redemption happens on are both ARGUMENTS, because the one thing this module must not do is ask what day
 * it is. The writes are `packages/db/src/services/redeem-package.ts`, which may not import this package
 * (brief rule 4), and `packages/fixtures/src/package-redemption.ts` is the mapping between the two.
 *
 * ## A redemption is where the supply happens
 *
 * **[UNVERIFIED] Y11-vat-package.** M-TILL-09 sold a package as a pure liability — `Dr` tender,
 * `Cr 2050 Deferred revenue` at the full gross, nothing on revenue and nothing on `2030` — on the
 * provisional answer that the date of supply is the REDEMPTION. This module is that answer's other half:
 *
 * ```
 *   Dr  2050   Deferred revenue — packages, at the released GROSS
 *     Cr  4020 Package redemption revenue, at the NET
 *     Cr  2030 Output VAT payable, at the VAT
 * ```
 *
 * So the sale period's output-VAT box contains nothing from packages and the redemption period's box 1
 * contains the tax on what was actually delivered. If the owner answers the other way — supply at sale —
 * what changes is this posting and `packageSalePosting`'s: the sale would credit `4020` net and `2030` the
 * VAT, and a redemption would move the balance and nothing else. No table changes in either file, because
 * a balance still has to be drawn down.
 *
 * ## What one session releases, and why it is a closed form
 *
 * A balance carries `valueGross` — its share of the sale's price, allocated once at the sale — and
 * `sessionsTotal` sessions. Redeeming the r-th session has to release a figure; the figures have to sum to
 * `valueGross` EXACTLY over the whole course (ADR 0007); and the r-th figure must not depend on the order
 * the sessions were taken in, because a customer who takes a facial before a massage has not bought
 * something different.
 *
 *     releaseThrough(value, total, redeemed) = ceil(value × redeemed / total)
 *
 * and one redemption of `units` sessions releases the difference between that at `redeemed + units` and at
 * `redeemed`. {@link releaseThrough} is the TypeScript half; `package_release_through_fils` in
 * `0083_package_redemption.sql` is the same expression in SQL, and ZG009 uses it to refuse a balance whose
 * `released_fils` is not the figure for the point it has reached. The two are held equal over a census
 * rather than by inspection — `packages/fixtures/src/package-redemption.itest.ts` — because "they look the
 * same" is how two implementations of one rule start disagreeing.
 *
 * **It is deliberately not `allocateByWeight` over equal weights**, which is what the per-LINE split uses.
 * Largest remainder gives the spare fils to the FIRST sessions; this gives them to sessions spread through
 * the course. Both sum to the value exactly and neither is more correct commercially. The closed form was
 * chosen because a CONSTRAINT has to be able to check it, and checking a largest-remainder allocation in
 * SQL means reimplementing largest remainder in PL/pgSQL — a second implementation of an arithmetic rule,
 * which is the defect this codebase spends most of its constraints preventing.
 *
 * The arithmetic runs in `BigInt`. `value × redeemed` is exact in a double only below 2^53, and a
 * 1,000,000-dirham balance over 30 sessions is 10^8 × 30 — comfortably inside it today, and a single
 * multiplication away from not being, which is the reason `allocateByWeight` gives for the same choice.
 *
 * ## Breakage is a MEASUREMENT, not a posting
 *
 * **[UNVERIFIED] Y9-package-policy**, provisionally `retained` and not `forfeited`, and that answer is
 * what decides whether expiry posts anything. It posts nothing, and the argument matters because the other
 * reading is the one that looks like accounting:
 *
 *   - `forfeited` means the salon keeps the money and owes nothing, so the unreleased part of `2050`
 *     becomes income and expiry is a journal entry.
 *   - `retained` means the customer is STILL OWED the treatments. The liability is real. An entry moving
 *     `2050` into revenue would recognise money the business owes, on a VAT box, for a supply that has not
 *     happened — and reversing it when the owner says "of course we honour it" means amending a filed
 *     return.
 *
 * So {@link breakageExposure} MEASURES what has expired and what is still unreleased against it, and there
 * is no `breakagePosting` in this file at all. A function that built the entry and left it to a caller not
 * to post it would be the "stub that looks like it works" docs/12 §1 forbids.
 *
 * `4050 Unredeemed voucher breakage` exists in the chart and is deliberately NOT reused: a voucher and a
 * package are different products that happen to share a VAT box, and reusing the account would make the
 * one report that could tell them apart unable to. If the owner answers `forfeited`, what is needed is that
 * posting, an account for it, and a SECOND tax question nobody has asked — whether forfeited consideration
 * is a supply at all, which Y11-vat-package's wording does not reach. Until then
 * {@link BreakagePolicyUnanswered} is what a `forfeited` balance gets, because a refusal that names the
 * question is visible and a guessed posting is not.
 */

/** The rate a redemption is taxed at unless a caller states another. 5% today. */
export const PACKAGE_REDEMPTION_VAT_RATE: VatRateBp = UAE_STANDARD_VAT_BP

/** The open question the retained-balance reading stands in for, spelled once. */
export const PACKAGE_BREAKAGE_OPEN_QUESTION = 'Y9-package-policy'

/**
 * The share of a balance's value released after `sessionsRedeemed` of `sessionsTotal` sessions.
 *
 * `ceil(value × redeemed / total)`, in `BigInt`, which is one expression and has these four properties by
 * construction rather than by testing: it is 0 at 0, it is exactly `value` at `total`, it never decreases,
 * and every single-session difference is either `floor(value/total)` or `ceil(value/total)`. The fourth is
 * what makes it a defensible split of a price rather than merely an exact one.
 */
export function releaseThrough(
  valueGross: Money,
  sessionsTotal: number,
  sessionsRedeemed: number,
): Money {
  if (!Number.isInteger(sessionsTotal) || sessionsTotal < 1) {
    throw new MalformedDrawdown(
      `a balance of ${sessionsTotal} session(s) has no share to release`,
      { sessionsTotal },
    )
  }
  if (!Number.isInteger(sessionsRedeemed) || sessionsRedeemed < 0) {
    throw new MalformedDrawdown(`${sessionsRedeemed} session(s) redeemed is not a count`, {
      sessionsRedeemed,
    })
  }
  if (sessionsRedeemed > sessionsTotal) {
    // The same refusal `package_balance_cannot_overdraw` makes in the database, made here so a caller is
    // told before a posting is built rather than at the UPDATE that would have been refused.
    throw new MalformedDrawdown(
      `${sessionsRedeemed} of ${sessionsTotal} session(s) redeemed: a balance cannot be drawn past what ` +
        'was sold',
      { sessionsTotal, sessionsRedeemed },
    )
  }
  if (valueGross.fils < 0 || !Number.isInteger(valueGross.fils)) {
    throw new MalformedDrawdown(`a balance worth ${valueGross.fils} fils has no share to release`, {
      valueFils: valueGross.fils,
    })
  }
  const total = BigInt(sessionsTotal)
  const released = (BigInt(valueGross.fils) * BigInt(sessionsRedeemed) + total - 1n) / total
  return money(filsFrom(Number(released)), valueGross.currency)
}

/**
 * What redeeming `units` more sessions releases, given how many have already gone.
 *
 * The DIFFERENCE of two cumulative figures and never a per-session amount multiplied up: multiplying would
 * make two single redemptions release a different total from one double redemption, and the balance would
 * then be unable to release its whole value over the course.
 *
 * Note which argument is which. `alreadyRedeemed` is the state of the balance and `units` is what is being
 * taken now; swapping them changes the answer for every balance where the two differ, which is what
 * `package-drawdown.test.ts` asserts rather than assuming.
 */
export function releaseForSessions(
  valueGross: Money,
  sessionsTotal: number,
  alreadyRedeemed: number,
  units: number,
): Money {
  if (!Number.isInteger(units) || units < 1) {
    throw new MalformedDrawdown(`a redemption of ${units} session(s) is not a redemption`, {
      units,
    })
  }
  const before = releaseThrough(valueGross, sessionsTotal, alreadyRedeemed)
  const after = releaseThrough(valueGross, sessionsTotal, alreadyRedeemed + units)
  return money(filsFrom(after.fils - before.fils), valueGross.currency)
}

/** Raised when a drawdown is asked about a balance that cannot carry one. */
export class MalformedDrawdown extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('validation', `MalformedDrawdown: ${message}`, { details })
    this.name = 'MalformedDrawdown'
  }
}

/**
 * Raised when a balance sold under `forfeited` terms expires, because the posting cannot be built.
 *
 * `forfeited` is not the provisional default and a sale can only carry it because somebody typed it in.
 * Writing it off needs an account that does not exist and an answer to a tax question nobody has asked —
 * whether forfeited consideration is a supply — so the sweep refuses and names the question. Guessing
 * would put revenue and possibly output VAT into a filed period on an assumption, which is the one thing
 * docs/12 §2 says a provisional value may never do.
 */
export class BreakagePolicyUnanswered extends AppError {
  constructor(packageSaleId: string, unreleasedFils: number) {
    super(
      'invariant_violated',
      `BreakagePolicyUnanswered: package sale ${packageSaleId} expired with ${unreleasedFils} fils ` +
        'unreleased under FORFEITED terms, and there is no posting for that. Writing it off needs an ' +
        'account of its own — 4050 is the voucher account and a package is a different product — and an ' +
        `answer to whether forfeited consideration is a supply at all, which ` +
        `${PACKAGE_BREAKAGE_OPEN_QUESTION} and Y11-vat-package between them do not settle. The ` +
        'provisional policy is RETAINED, which posts nothing.',
      { details: { packageSaleId, unreleasedFils, openQuestion: PACKAGE_BREAKAGE_OPEN_QUESTION } },
    )
    this.name = 'BreakagePolicyUnanswered'
  }
}

/**
 * Whether a treatment delivered on `onDate` is inside a package's validity.
 *
 * The DECISION is here because it is arithmetic over two dates; the REFUSAL is not. `PackageExpired` lives
 * in `packages/db/src/services/redeem-package.ts`, beside the read of `package_sale.expires_on` and of the
 * policy that decides what its message says about the money — this package may not be imported by
 * `packages/db` (brief rule 4), so a class declared here could not be thrown by the writer anyway, and two
 * classes of one name in two packages is worse than one in the right place.
 *
 * Both dates are arguments and neither is derived here. `expiresOn` is `package_sale.expires_on`, a
 * GENERATED column — `(trading_date + make_interval(months => validity_months))::date` — so the
 * derivation exists once, in the row; recomputing it from the validity months in TypeScript would be a
 * second answer about when a customer's money runs out. `onDate` is the redemption's BUSINESS DAY,
 * resolved with `resolveTradingDate`: trading runs 11:00–02:00, so a 01:30 treatment belongs to the
 * previous trading date and comparing a calendar date would expire a package a day early.
 *
 * Inclusive of the expiry date itself. A validity of "6 months" that refused the last day would be five
 * months and thirty days, and the customer counts in months.
 *
 * `LocalDate` is a branded `YYYY-MM-DD`, which orders correctly as a string — the comparison is stated
 * here once rather than inlined at each caller, so a caller cannot accidentally compare a `Date`.
 */
export function redemptionIsInTime(expiresOn: LocalDate, onDate: LocalDate): boolean {
  return (onDate as string) <= (expiresOn as string)
}

/** One balance, as a redemption has to see it. Every figure is read from the row, none re-derived. */
export interface PackageBalanceState {
  /** The `package_balance` row. Carried through so a caller can match a posting back to it. */
  readonly balanceId: string
  readonly sessionsTotal: number
  readonly sessionsRedeemed: number
  /** The share of the sale's gross this line carries. Allocated at the sale and never re-derived. */
  readonly valueGross: Money
  /** What has already been released out of it. Held equal to the formula by ZG009. */
  readonly releasedGross: Money
}

export interface PackageRedemptionPostingInput {
  /** Allocated by the caller. Core never invents an id. */
  readonly entryId: EntryId
  /** The redemption's BUSINESS DAY, already resolved. Both the entry's date and the row's. */
  readonly entryDate: LocalDate
  readonly balance: PackageBalanceState
  /** Whole entitlements consumed. One treatment normally consumes one. */
  readonly units: number
  /** Defaults to {@link PACKAGE_REDEMPTION_VAT_RATE}. Snapshotted onto the row by the writer. */
  readonly rateBp?: VatRateBp
  /** What the entry's narrative calls the package. The template's internal name, never a person's. */
  readonly packageLabel: string
  readonly narrative?: string
}

export interface PackageRedemptionPosting {
  /** Balanced, frozen, and the only thing that reaches `journal_entry`. */
  readonly entry: JournalEntry
  /** The gross released out of `2050` by this redemption. */
  readonly releasedGross: Money
  /** The supply recognised on `4020`. `net + vat === releasedGross` exactly (ADR 0007). */
  readonly net: Money
  /** The output VAT on it, credited to `2030`. */
  readonly vat: Money
  readonly rateBp: VatRateBp
  /** What the balance will have released once this redemption is written. ZG009 checks it. */
  readonly releasedThroughGross: Money
  /** What the balance will have redeemed once this redemption is written. */
  readonly sessionsRedeemedAfter: number
}

/**
 * The one journal entry a redemption produces.
 *
 * One line per ACCOUNT and sorted by account code, `checkout/posting.ts`'s reason: an insertion-ordered
 * entry diffs everywhere the moment somebody changes the order the rule builds its lines in. Here that is
 * `2030`, `2050`, `4020` — so the debit is not first, which is fine and is why `postEntry` checks the
 * totals rather than the order.
 *
 * Debits equal credits by construction: the debit is `releasedGross` and the credits are its own `net` and
 * `vat`, which `splitGross` guarantees sum to it. `postEntry` checks anyway, and the deferred trigger in
 * `0018_ledger.sql` checks again at COMMIT; neither is redundant, because this module is not the only
 * thing that can reach the journal.
 *
 * A zero release is refused rather than posted. It arises only from a balance worth zero fils, which
 * `package_balance_value_positive` already forbids, and an entry of two zero lines is a supply recorded as
 * having happened for nothing.
 */
export function packageRedemptionPosting(
  input: PackageRedemptionPostingInput,
  chart: ChartOfAccounts,
): PackageRedemptionPosting {
  const { balance } = input
  const rateBp = input.rateBp ?? PACKAGE_REDEMPTION_VAT_RATE

  // The state the caller handed over has to agree with itself before anything is released out of it. Read
  // off the row rather than trusted, ZG009's reason one layer up: a balance whose `releasedGross` is not
  // the figure for the point it has reached would make this redemption's difference wrong too, and the
  // symptom would be a liability that never reaches zero.
  const expectedAlready = releaseThrough(
    balance.valueGross,
    balance.sessionsTotal,
    balance.sessionsRedeemed,
  )
  if (expectedAlready.fils !== balance.releasedGross.fils) {
    throw new MalformedDrawdown(
      `balance "${balance.balanceId}" has released ${balance.releasedGross.fils} fils after ` +
        `${balance.sessionsRedeemed} of ${balance.sessionsTotal} session(s); the release formula gives ` +
        `${expectedAlready.fils}. Releasing a further share out of a balance that does not add up would ` +
        'carry the difference into the ledger',
      {
        balanceId: balance.balanceId,
        releasedFils: balance.releasedGross.fils,
        expectedFils: expectedAlready.fils,
      },
    )
  }

  const released = releaseForSessions(
    balance.valueGross,
    balance.sessionsTotal,
    balance.sessionsRedeemed,
    input.units,
  )
  if (released.fils <= 0) {
    throw new MalformedDrawdown(
      `redeeming ${input.units} session(s) of balance "${balance.balanceId}" releases ` +
        `${released.fils} fils. A supply recognised for nothing is not a supply`,
      { balanceId: balance.balanceId, units: input.units, releasedFils: released.fils },
    )
  }

  const { net, vat } = splitGross(released, rateBp)
  const memo = `Package redeemed: ${input.packageLabel}`

  const draft: EntryDraft = {
    entryId: input.entryId,
    entryDate: input.entryDate,
    narrative:
      input.narrative ??
      `Package redemption: ${input.packageLabel}, ${input.units} session(s) of ` +
        `${balance.sessionsTotal}`,
    source: 'package_redemption',
    lines: [
      // Sorted by account code, and the codes are named rather than spelled: 2030 < 2050 < 4020.
      credit(PACKAGE_OUTPUT_VAT_ACCOUNT, vat, memo),
      debit(PACKAGE_DEFERRED_REVENUE_ACCOUNT, released, memo),
      credit(PACKAGE_REDEMPTION_REVENUE_ACCOUNT, net, memo),
    ].sort((a, b) => ((a.account as string) < (b.account as string) ? -1 : 1)),
  }

  return {
    entry: postEntry(draft, chart),
    releasedGross: released,
    net,
    vat,
    rateBp,
    releasedThroughGross: money(
      filsFrom(balance.releasedGross.fils + released.fils),
      balance.valueGross.currency,
    ),
    sessionsRedeemedAfter: balance.sessionsRedeemed + input.units,
  }
}

/** What a redemption posting actually moved, measured off its own lines against the chart. */
export interface PackageRedemptionPostingProbe {
  /** Debits to `2050` minus credits to it. What the liability actually fell by. */
  readonly deferredReleasedFils: number
  /** Credits to `4020` minus debits to it. The supply recognised. */
  readonly redemptionRevenueFils: number
  /**
   * TOTAL movement — debits PLUS credits — on every revenue account that is NOT `4020`.
   *
   * Deliberately not the net, and this is ZG005's measurement rather than a new one: an entry crediting
   * `4010` and debiting the contra `4095` by the same figure has a net movement of zero and has put a
   * package's revenue on the wrong account and the wrong VAT box, with the trial balance still balancing.
   * `probePackageSalePosting` was first written summing the net and would have reported that entry clean.
   */
  readonly otherRevenueMovementFils: number
  /** Credits to `2030` minus debits to it. The output VAT the redemption period's box 1 gains. */
  readonly outputVatFils: number
  /** Every account code the entry touches, sorted. */
  readonly accountsTouched: readonly AccountCode[]
}

/**
 * Measures a posting against the claim "a redemption releases the liability and recognises the supply
 * once, on `4020`, with the VAT on `2030`".
 *
 * Off the ENTRY's lines and the CHART's types, so it is a measurement rather than a restatement of how
 * {@link packageRedemptionPosting} happens to be written: a rule that credited `4010` would be caught even
 * though nothing in the rule's own source says `4010`. `accountFor` throws `UnknownAccount` on a code the
 * chart does not contain, which is the right answer for a posting nobody can classify.
 *
 * Exported because three layers need it and none can be the only one: this unit's core tests, the
 * reconciliation of the MAPPED input in `packages/fixtures/src/package-redemption.ts`, and — in SQL, over
 * the rows PostgreSQL holds rather than the object a caller built — ZG008.
 */
export function probePackageRedemptionPosting(
  entry: JournalEntry,
  chart: ChartOfAccounts,
): PackageRedemptionPostingProbe {
  let deferred = 0
  let revenue = 0
  let otherRevenue = 0
  let outputVat = 0
  const touched: AccountCode[] = []
  for (const line of entry.lines) {
    const account = accountFor(chart, line.account)
    touched.push(account.code)
    if (account.code === PACKAGE_DEFERRED_REVENUE_ACCOUNT) {
      deferred += line.debitFils - line.creditFils
    }
    if (account.code === PACKAGE_REDEMPTION_REVENUE_ACCOUNT) {
      revenue += line.creditFils - line.debitFils
    } else if (account.type === 'revenue') {
      otherRevenue += line.debitFils + line.creditFils
    }
    if (account.code === PACKAGE_OUTPUT_VAT_ACCOUNT) {
      outputVat += line.creditFils - line.debitFils
    }
  }
  return {
    deferredReleasedFils: deferred,
    redemptionRevenueFils: revenue,
    otherRevenueMovementFils: otherRevenue,
    outputVatFils: outputVat,
    accountsTouched: [...touched].sort((a, b) =>
      (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0,
    ),
  }
}

/** One sale as the expiry sweep sees it. Read from `package_expiry_exposure`; nothing derived here. */
export interface ExpiringPackage {
  readonly packageSaleId: string
  readonly expiresOn: LocalDate
  readonly unredeemedBalancePolicy: UnredeemedBalancePolicy
  readonly soldGross: Money
  readonly releasedGross: Money
  /** `soldGross - releasedGross`: what `2050` still holds for this sale. */
  readonly unreleasedGross: Money
}

/** What the sweep found, and what it did about it — which under the provisional policy is nothing. */
export interface BreakageExposure {
  /** The sales whose validity had run out as at the date asked about, and that still owe something. */
  readonly expired: readonly ExpiringPackage[]
  /** The total still sitting in `2050` against them. A MEASUREMENT: nothing posts it anywhere. */
  readonly unreleasedFils: number
  /** How many of those are `retained` — so the liability stays and there is nothing to do. */
  readonly retainedCount: number
  /**
   * The ones sold under `forfeited` terms, which have no posting and need the owner.
   *
   * Reported rather than thrown over, so one such sale does not hide the measurement for the rest. The
   * sweep raises {@link BreakagePolicyUnanswered} per sale, which is what makes it visible.
   */
  readonly awaitingPolicy: readonly ExpiringPackage[]
  /** Stated on the result rather than left to a comment, because the answer is the whole point. */
  readonly journalEntriesPosted: 0
}

/**
 * What has expired as at `asAt`, and what is still owed against it.
 *
 * `asAt` is an argument. A function that read the clock would make every test of it depend on the machine's
 * date, which is what the frozen clock exists to remove — and would make "what did the sweep see on the
 * 1st" unanswerable after the 1st.
 *
 * `journalEntriesPosted` is `0` as a TYPE and not as a value that happens to be zero: under the
 * provisional `retained` answer to Y9-package-policy the customer is still owed the treatments, so moving
 * `2050` into revenue would recognise money the business owes. Making it a literal type means a future
 * edit that posted something would not compile without changing this signature, which is where the
 * argument is written down.
 */
export function breakageExposure(
  rows: readonly ExpiringPackage[],
  asAt: LocalDate,
): BreakageExposure {
  const expired = rows.filter(
    (row) => !redemptionIsInTime(row.expiresOn, asAt) && row.unreleasedGross.fils > 0,
  )
  return {
    expired,
    unreleasedFils: expired.reduce((running, row) => running + row.unreleasedGross.fils, 0),
    retainedCount: expired.filter((row) => row.unredeemedBalancePolicy === 'retained').length,
    awaitingPolicy: expired.filter((row) => row.unredeemedBalancePolicy === 'forfeited'),
    journalEntriesPosted: 0,
  }
}

/**
 * `4050 Unredeemed voucher breakage`, named here so a test can assert it is NOT what a package uses.
 *
 * There is deliberately no package breakage account and no `breakagePosting` in this module: under the
 * provisional `retained` answer nothing is written off, so an account would be a place for money that
 * never goes anywhere. Reusing the voucher account instead would make the one report that could tell a
 * voucher from a package unable to — they share a VAT box and are different products.
 *
 * `package-drawdown.test.ts` asserts a redemption posting touches this account not at all, which is a
 * measurement rather than a promise about how the rule is written.
 */
export const VOUCHER_BREAKAGE_ACCOUNT: AccountCode = ACCOUNTS.voucherBreakageRevenue
