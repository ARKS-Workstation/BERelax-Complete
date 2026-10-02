import { AppError } from '@berelax/shared'
import { PACKAGE_BREAKAGE_OPEN_QUESTION } from '../money/package-drawdown.ts'
import type {
  KpiPackageEntitlement,
  KpiProvisionalMarker,
  KpiSpec,
  Measure,
} from './kpi-expression.ts'
import { measureRef } from './kpi-expression.ts'

/**
 * The outstanding package liability, derived at the SESSION grain and tied to `2050` (R-REP-05).
 *
 * # The acceptance line asks for a third derivation of one figure, and that is the point
 *
 * "outstanding package liability = Σ remaining_sessions × snapshotted gross per session, equal to the
 * deferred-revenue ledger account balance to the fils". There are now three independent reads of what
 * the business owes its package holders, and each can be wrong in a way the other two cannot see:
 *
 *   1. **`sold − released`**, which is `readPackageLiability`'s (M-TILL-10) and reads `package_sale`
 *      and `package_redemption` totals. It is wrong if a balance row disagrees with its sale.
 *   2. **`2050`'s own balance**, which reads `journal_line` and is wrong if a posting was missed or an
 *      adjustment was made outside the package path.
 *   3. **Σ over balances of remaining_sessions × the per-session gross**, which is this module's and is
 *      the only one at the grain the entitlement actually has: a holder with two sessions left on one
 *      line and none on another.
 *
 * {@link reconcilePackageLiabilityToLedger} holds all three equal. It is not a second statement of a
 * figure in the sense the brief warns about — it is `month-reconciliation.ts`'s arrangement, where "the
 * refinement is not a second answer, it is an answer whose total the report itself holds to the one
 * source", and the identity is a LINE of the report.
 *
 * # Why a per-session gross is not a division, and why that is the whole of "to the fils"
 *
 * The obvious implementation of "remaining sessions × gross per session" is
 * `remaining × round(value ÷ total)`, and it is wrong for most real packages. 0078 allocates a sale's
 * price across the template version's lines by largest remainder so the shares sum to the price exactly
 * (ZG006), and 0083 releases a line's share as `release_through(value, total, redeemed) =
 * ceil(value × redeemed ÷ total)` — which is the ONE statement of what a session of a balance is worth
 * (`releaseThrough` in `../money/package-drawdown.ts` is its TypeScript half, and ZG009 re-adds it over
 * every balance).
 *
 * A price that does not divide by its session count therefore has no single per-session figure, and
 * rounding one produces a residue per line. Three sessions of a 10,000-fils line are worth 3,333,
 * 3,334 and 3,333 in the order they are taken, and `remaining × 3333` is a fils short of the truth with
 * one session gone. Summed over a few hundred balances the liability drifts from `2050` by an amount
 * nobody can trace, and the acceptance line says "to the fils".
 *
 * So the per-session arithmetic is the release formula's own complement:
 *
 *     remaining_share(value, total, remaining) = floor(value × remaining ÷ total)
 *
 * and that is EXACTLY `value − ceil(value × redeemed ÷ total)` for whole `value`, because
 * `v − ceil(vr/n) = v + floor(−vr/n) = floor(v(n−r)/n)`. The tie to the stored `released_fils` is
 * therefore an algebraic identity rather than a rounding convention that happens to agree — which is
 * why {@link PackageEntitlementDisagrees} is a refusal: if the two differ on a real row, the row's
 * `released_fils` is not what the release formula gives, and ZG009 should have refused the drawdown
 * that wrote it.
 *
 * # What the figure is provisional against
 *
 * `Y9-package-policy`, through `PACKAGE_BREAKAGE_OPEN_QUESTION`, and it moves the figure rather than
 * labelling it: an expired package whose unredeemed balance is RETAINED is still a liability and one
 * whose balance is FORFEITED is revenue the day it expires. This module takes the entitlements the
 * caller selected and states neither reading — an `asAt` filter on `expires_on` is the caller's, and
 * `package_expiry_exposure` (M-TILL-10) is what reports the exposure either way.
 *
 * Every figure is a `bigint` and none is a `Fils`, which matters here more than anywhere: a cumulative
 * liability over every package ever sold is exactly the shape `packages/db/src/queries/trial-balance.ts`
 * recorded a `number` failing at.
 */

// --- the per-session share ----------------------------------------------------------------------

/** Raised when an entitlement row is not one. See {@link remainingSessionShareFils}. */
export class MalformedEntitlement extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('validation', `A package entitlement is malformed: ${message}.`, { details })
    this.name = 'MalformedEntitlement'
  }
}

/**
 * The gross still owed on a balance: `floor(value × remaining ÷ total)`.
 *
 * `bigint` division truncates towards zero and `valueFils` is non-negative, so the division IS the
 * floor — stated rather than relied on silently, because a negative `valueFils` would make truncation
 * round the other way and `package_balance.value_fils` is `fils_nonneg` with `check (value_fils > 0)`,
 * which is what makes the refusal below a check on the caller's query rather than on the schema.
 */
export function remainingSessionShareFils(
  valueFils: bigint,
  sessionsTotal: number,
  sessionsRemaining: number,
): bigint {
  if (!Number.isInteger(sessionsTotal) || sessionsTotal < 1) {
    throw new MalformedEntitlement(
      `a balance of ${sessionsTotal} session(s) has no per-session share`,
      { sessionsTotal },
    )
  }
  if (!Number.isInteger(sessionsRemaining) || sessionsRemaining < 0) {
    throw new MalformedEntitlement(`${sessionsRemaining} session(s) remaining is not a count`, {
      sessionsRemaining,
    })
  }
  if (sessionsRemaining > sessionsTotal) {
    throw new MalformedEntitlement(
      `${sessionsRemaining} of ${sessionsTotal} session(s) remaining: a balance cannot owe more than ` +
        'it sold, which `package_balance_cannot_overdraw` already refuses in the database',
      { sessionsTotal, sessionsRemaining },
    )
  }
  if (valueFils < 0n) {
    throw new MalformedEntitlement(
      `a balance worth ${valueFils} fils has no share to owe; truncation would round the wrong way`,
      { valueFils: valueFils.toString() },
    )
  }
  return (valueFils * BigInt(sessionsRemaining)) / BigInt(sessionsTotal)
}

/** One row of the liability schedule: the entitlement, its share, and what the ledger released. */
export interface PackageLiabilityLine {
  readonly packageSaleId: string
  readonly balanceId: string
  readonly sessionsTotal: number
  readonly sessionsRemaining: number
  readonly valueFils: bigint
  /** `floor(valueFils × sessionsRemaining ÷ sessionsTotal)`. What this line still owes. */
  readonly outstandingFils: bigint
}

/** Raised when a row's session share and its stored `released_fils` disagree. See the header. */
export class PackageEntitlementDisagrees extends AppError {
  constructor(line: PackageLiabilityLine, releasedFils: bigint) {
    super(
      'invariant_violated',
      `Balance ${line.balanceId} of sale ${line.packageSaleId} has ${line.sessionsRemaining} of ` +
        `${line.sessionsTotal} session(s) left on ${line.valueFils} fils, which owes ` +
        `${line.outstandingFils} fils by the release formula's own complement — and its released_fils ` +
        `of ${releasedFils} leaves ${line.valueFils - releasedFils}. The two are equal for every row ` +
        'the release formula wrote, by an algebraic identity rather than by a rounding convention, so a ' +
        'difference means this row was drawn down by something ZG009 should have refused.',
      {
        details: {
          balanceId: line.balanceId,
          packageSaleId: line.packageSaleId,
          sessionShareFils: line.outstandingFils.toString(),
          valueLessReleasedFils: (line.valueFils - releasedFils).toString(),
        },
      },
    )
    this.name = 'PackageEntitlementDisagrees'
  }
}

/** The schedule: one line per balance, with its outstanding share. */
export function packageLiabilitySchedule(
  entitlements: readonly KpiPackageEntitlement[],
): readonly PackageLiabilityLine[] {
  return Object.freeze(
    entitlements.map((row) =>
      Object.freeze({
        packageSaleId: row.packageSaleId,
        balanceId: row.balanceId,
        sessionsTotal: row.sessionsTotal,
        sessionsRemaining: row.sessionsRemaining,
        valueFils: row.valueFils,
        outstandingFils: remainingSessionShareFils(
          row.valueFils,
          row.sessionsTotal,
          row.sessionsRemaining,
        ),
      }),
    ),
  )
}

/** The schedule's total. One line of arithmetic, named so a report can cite it. */
export const packageLiabilityTotalFils = (lines: readonly PackageLiabilityLine[]): bigint =>
  lines.reduce((total, line) => total + line.outstandingFils, 0n)

// --- the reconciliation -------------------------------------------------------------------------

/**
 * `2050`'s movement, split by the journal source that caused it.
 *
 * SPLIT and not a total, and the reason is a case this build can already produce. H-MIG-03 posts a
 * reconstructed package's opening liability as `Dr 3030 / Cr 2050` with `source = 'opening_balance'`,
 * and it also writes the `package_sale` and `package_balance` rows the schedule reads — so a schedule
 * total compared against a `2050` balance scoped to `source in ('package_sale', 'package_redemption')`
 * would disagree by exactly the imported liability, with the message naming neither the import nor the
 * scope. `readPackageLiability` (M-TILL-10) uses that narrower scope deliberately, for a claim about
 * what the till wrote, and it is right for that claim and not for this one.
 *
 * `other` is therefore reported rather than filtered out: `2050` is a real account and nothing stops an
 * accountant posting an adjustment to it. A reconciliation that dropped those postings would balance
 * and would be describing a different liability — ADR 0064's census argument, where "an account posted
 * to that no line claims leaves the sheet balancing and is invisible to every identity".
 */
export interface DeferredRevenueMovement {
  readonly packageSaleFils: bigint
  readonly packageRedemptionFils: bigint
  readonly openingBalanceFils: bigint
  /** Every other journal source, summed. Non-zero is a named variance and not a figure to absorb. */
  readonly otherFils: bigint
}

/** The three sources a package liability may legitimately have been posted by, summed. */
export const packageSourcedDeferredRevenueFils = (movement: DeferredRevenueMovement): bigint =>
  movement.packageSaleFils + movement.packageRedemptionFils + movement.openingBalanceFils

/** The whole account, which is what a balance sheet shows. */
export const totalDeferredRevenueFils = (movement: DeferredRevenueMovement): bigint =>
  packageSourcedDeferredRevenueFils(movement) + movement.otherFils

/** Every named line of the reconciliation, in the order it reports them. */
export const PACKAGE_LIABILITY_RECONCILIATION_LINES = [
  'session_schedule_against_the_deferred_revenue_account',
  'session_schedule_against_sold_less_released',
  'deferred_revenue_postings_from_outside_the_package_path',
] as const

export type PackageLiabilityReconciliationLine =
  (typeof PACKAGE_LIABILITY_RECONCILIATION_LINES)[number]

export interface PackageLiabilityVariance {
  readonly line: PackageLiabilityReconciliationLine
  readonly scheduleFils: bigint
  readonly comparedFils: bigint
  /** `schedule − compared`. Zero is the only value that means the figures agree. */
  readonly differenceFils: bigint
  readonly detail: string
}

export interface PackageLiabilityReconciliation {
  readonly outstandingFils: bigint
  readonly lineCount: number
  readonly sessionsRemaining: number
  readonly ledger: DeferredRevenueMovement
  /** Every line, whether or not it balanced, so a report shows the identities it checked. */
  readonly checked: readonly PackageLiabilityVariance[]
  /** The subset whose difference is non-zero. Empty is the only acceptable state. */
  readonly variances: readonly PackageLiabilityVariance[]
  readonly provisional: KpiProvisionalMarker
}

/**
 * The three identities, each reported with its figures whether it held or not.
 *
 * Reported rather than thrown, for `statementLayoutFindings`' reason one subject along: a caller that
 * wants all three — a report, a test, a gate — gets all three, and a rule that stops matching reports
 * nothing rather than passing silently. The caller asserts `variances` is empty; this function only
 * measures.
 *
 * The third line is the one that earns the split. It is not an identity at all — it is a census — and a
 * non-zero figure on it says the liability account holds money the package path did not put there,
 * which leaves the first line failing for a reason that has nothing to do with the schedule.
 */
export function reconcilePackageLiabilityToLedger(args: {
  readonly lines: readonly PackageLiabilityLine[]
  readonly ledger: DeferredRevenueMovement
  /** `readPackageLiability`'s own `sold − released`, in fils. M-TILL-10 owns this figure. */
  readonly soldLessReleasedFils: bigint
}): PackageLiabilityReconciliation {
  const outstandingFils = packageLiabilityTotalFils(args.lines)
  const sessionsRemaining = args.lines.reduce((total, line) => total + line.sessionsRemaining, 0)
  const packageSourced = packageSourcedDeferredRevenueFils(args.ledger)

  const checked: PackageLiabilityVariance[] = [
    {
      line: 'session_schedule_against_the_deferred_revenue_account',
      scheduleFils: outstandingFils,
      comparedFils: packageSourced,
      differenceFils: outstandingFils - packageSourced,
      detail:
        'Sum over package_balance of floor(value_fils x sessions_remaining / sessions_total), against ' +
        '2050 credited less debited by the package sale, package redemption and opening balance ' +
        "sources. Equal to the fils by the release formula's own complement.",
    },
    {
      line: 'session_schedule_against_sold_less_released',
      scheduleFils: outstandingFils,
      comparedFils: args.soldLessReleasedFils,
      differenceFils: outstandingFils - args.soldLessReleasedFils,
      detail:
        "The same total against readPackageLiability's sold less released (M-TILL-10). A difference " +
        'means a balance row disagrees with the sale it belongs to, which the sale-level figure cannot ' +
        'see and the session-level one can.',
    },
    {
      line: 'deferred_revenue_postings_from_outside_the_package_path',
      scheduleFils: 0n,
      comparedFils: args.ledger.otherFils,
      differenceFils: -args.ledger.otherFils,
      detail:
        '2050 is a real account and nothing stops an adjustment landing on it. A non-zero figure here ' +
        'is money in the liability that no package put there, and it makes the first line fail for a ' +
        'reason that has nothing to do with the schedule.',
    },
  ]

  return Object.freeze({
    outstandingFils,
    lineCount: args.lines.length,
    sessionsRemaining,
    ledger: args.ledger,
    checked: Object.freeze(checked),
    variances: Object.freeze(checked.filter((variance) => variance.differenceFils !== 0n)),
    provisional: PACKAGE_LIABILITY_PROVISIONAL,
  })
}

/** Raised by a caller that needs the reconciliation to have held. Names every line that did not. */
export function assertPackageLiabilityReconciles(
  reconciliation: PackageLiabilityReconciliation,
): void {
  if (reconciliation.variances.length === 0) return
  throw new AppError(
    'invariant_violated',
    `The outstanding package liability does not tie: ${reconciliation.variances
      .map((variance) => `${variance.line} is out by ${variance.differenceFils} fils`)
      .join('; ')}. The schedule is ${reconciliation.outstandingFils} fils over ` +
      `${reconciliation.lineCount} balance(s).`,
    { details: { lines: reconciliation.variances.map((variance) => variance.line) } },
  )
}

/** What the liability figure rests on that nobody has decided. See the module header. */
export const PACKAGE_LIABILITY_PROVISIONAL: KpiProvisionalMarker = Object.freeze({
  openQuestionId: PACKAGE_BREAKAGE_OPEN_QUESTION,
  note:
    "Whether an expired package's unredeemed balance is RETAINED or FORFEITED moves this figure " +
    'rather than labelling it: retained, an expired entitlement is still owed; forfeited, it became ' +
    'revenue on the day it expired. This module states neither reading — which entitlements are in ' +
    "scope is the caller's selection, and package_expiry_exposure (M-TILL-10) reports the exposure " +
    'either way.',
})

// --- the measure and the KPI --------------------------------------------------------------------

export const OUTSTANDING_PACKAGE_LIABILITY_FILS: Measure = {
  id: 'outstanding_package_liability_fils',
  summary:
    'What the business still owes its package holders, in fils: summed over package_balance rows as ' +
    "floor(value_fils x sessions_remaining / sessions_total), which is the release formula's own " +
    'complement and therefore ties to 2050 to the fils rather than to a rounded per-session price.',
  unit: 'fils',
  reads: [
    'packageEntitlements.valueFils',
    'packageEntitlements.sessionsTotal',
    'packageEntitlements.sessionsRemaining',
  ],
  reduce: (input) => {
    let total = 0n
    for (const row of input.packageEntitlements) {
      total += remainingSessionShareFils(row.valueFils, row.sessionsTotal, row.sessionsRemaining)
    }
    return total
  },
}

/**
 * The liability as the registry publishes it: one measure, no quotient, no denominator to be empty.
 *
 * A KPI whose expression is a bare measure, which is legitimate and worth stating: it is a figure with a
 * published formula and a unit, and the thing that makes it a KPI rather than a query result is that the
 * formula is RENDERED from the expression the figure was computed from (ADR 0068). A sum over an empty
 * set is nought here and is RIGHT to be — no packages sold is no liability — which is available to it
 * precisely because it is a sum and not a division (ADR 0070's two measured zeros, one subject along).
 */
export const OUTSTANDING_PACKAGE_LIABILITY: KpiSpec = {
  id: 'outstanding_package_liability',
  label: 'Outstanding package liability',
  summary:
    'The deferred revenue the business holds against sessions it has sold and not yet delivered, at ' +
    'the session grain. It ties to 2050 to the fils, and reconcilePackageLiabilityToLedger is what ' +
    'says so — including the census line that catches a posting to 2050 from outside the package path.',
  unit: 'fils',
  expression: measureRef(OUTSTANDING_PACKAGE_LIABILITY_FILS.id),
  provisional: PACKAGE_LIABILITY_PROVISIONAL,
}

export const PACKAGE_LIABILITY_MEASURES: readonly Measure[] = Object.freeze([
  OUTSTANDING_PACKAGE_LIABILITY_FILS,
])

export const PACKAGE_LIABILITY_KPIS: readonly KpiSpec[] = Object.freeze([
  OUTSTANDING_PACKAGE_LIABILITY,
])
