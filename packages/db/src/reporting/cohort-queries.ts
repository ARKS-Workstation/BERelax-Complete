import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { KpiPeriod } from './kpi-queries.ts'

/**
 * The reads behind the cohorts, CAC and the outstanding package liability (R-REP-05).
 *
 * The **arithmetic** is `packages/core/src/reporting/cohorts.ts`, `.../cac.ts` and
 * `.../package-liability.ts` and stays there: `packages/db` may never import `packages/core`
 * (ADR 0001), so this module returns ROWS and computes no KPI.
 * `packages/fixtures/src/cohorts.itest.ts` is where the two halves meet against a real database, for
 * the reason the brief gives — `packages/fixtures` may depend on both. That is R-REP-02's and
 * R-REP-04's arrangement, one subject along.
 *
 * # A cohort month is a trading month, and the key is defined exactly once
 *
 * `reporting.dim_customer.first_visit_business_day` is "the trading date of the earliest DELIVERED
 * appointment" — migration 0110's own words, which go on to say that R-REP-05 "reads this rather than
 * recomputing it; a second definition of 'first visit' is two answers to one question". So
 * {@link cohortMembers} reads that column and `date_trunc('month', ...)` is the only arithmetic it
 * applies to it.
 *
 * It is a MATERIALISED view, so the figures are never fresher than the last
 * `reporting.refresh('dim_customer')` (ADR 0060). That is the right trade for a cohort report and the
 * wrong one for an operational question, and R-REP-07 reads `reporting.refresh_run` to mark a stale
 * tile rather than rendering a number nobody can date.
 *
 * # Why the member query resolves `merge_survivor_of` as well as reading the view
 *
 * `merge_record` keeps a merged-away record as a TOMBSTONE rather than deleting it (0069), and
 * `booking.customer_id` is re-pointed to the survivor (`repoint_update`, C-CRM-05) — so after a refresh
 * the view holds the survivor with the earlier first visit and the tombstone with none. Between the
 * merge and the next refresh it holds BOTH, each with its own first visit, and a cohort report would
 * then show one person twice in two different months.
 *
 * So the query groups on `merge_survivor_of(customer_id)` and takes `min(first_visit_business_day)`,
 * which makes "exactly one cohort, the earlier one" true even against a stale view, and
 * `collapseCohortMembers` in core does the same to whatever arrives. Two mechanisms for one property,
 * because the window in which the first is wrong is exactly the window in which somebody has just run a
 * merge and is looking at the screen to see whether it worked.
 *
 * # What this module does NOT read
 *
 * A **paid channel**, because nothing records one. The caller supplies the classifier — `cac.ts`'s
 * `firstTouchPaidStateOf`, which answers `not_recorded` for all six labels in
 * `customer_acquisition_source` — so {@link cohortMembers} returns the raw `acquisitionSource` and
 * states no paid-ness of its own. And an **account code**, because the chart lives in a package this one
 * may not import: every query that needs one takes it as an argument, which is R-REP-04's arrangement
 * and what gate case 148n refuses a four-digit string literal in `kpi-queries.ts` for.
 *
 * Every money figure comes back as a `bigint`. `sum()` over the `fils` domain returns `numeric` and
 * `connection.ts` hands it back as a string precisely so nothing rounds it;
 * `queries/trial-balance.ts` records the four fils a `number` produced out of nothing on a cumulative
 * ledger position, and an outstanding liability over every package ever sold is the same shape.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** The same guard the two sibling query modules apply, over this module's own columns. */
function assertCohortPeriod(period: KpiPeriod): void {
  for (const [what, value] of [
    ['startsOn', period.startsOn],
    ['endsOn', period.endsOn],
  ] as const) {
    if (!ISO_DATE.test(value)) {
      throw new AppError(
        'validation',
        `${what} must be an ISO business day (YYYY-MM-DD), got "${value}"`,
      )
    }
  }
  if (period.endsOn < period.startsOn) {
    throw new AppError(
      'validation',
      `A cohort period ends ${period.endsOn}, before it starts ${period.startsOn}. Read backwards it ` +
        'returns no cohort and looks like a business that acquired nobody.',
    )
  }
  if (period.periodId.trim() === '') {
    throw new AppError(
      'validation',
      'periodId is the identifier a report is filed under; it is blank',
    )
  }
}

const assertIsoDate = (what: string, value: string): void => {
  if (!ISO_DATE.test(value)) {
    throw new AppError('validation', `${what} must be an ISO date (YYYY-MM-DD), got "${value}"`)
  }
}

// --- the cohort membership ----------------------------------------------------------------------

/** One customer, their cohort month, and the acquisition label the classifier will read. */
export interface CohortMemberRow {
  readonly customerId: string
  /** `YYYY-MM-01`: the business month of the first DELIVERED visit. */
  readonly cohortMonth: string
  /** The trading date itself, so a drill-down can show the visit the cohort rests on. */
  readonly firstVisitBusinessDay: string
  /** `customer.acquisition_source`, carried RAW. This module classifies nothing. */
  readonly acquisitionSource: string
  readonly isErased: boolean
}

/**
 * Every customer whose first delivered visit falls inside the period, one row per SURVIVOR.
 *
 * `is_erased` is carried rather than filtered. An erased customer's delivered visits happened and their
 * contribution is in the ledger, so dropping them would move a cohort's size and its revenue by
 * different amounts and make the per-customer figure wrong; a caller that wants to exclude them can,
 * and now has to say so.
 */
export async function cohortMembers(
  sql: Sql,
  args: { readonly period: KpiPeriod },
): Promise<readonly CohortMemberRow[]> {
  assertCohortPeriod(args.period)
  const rows = await sql<
    {
      customerId: string
      cohortMonth: string
      firstVisitBusinessDay: string
      acquisitionSource: string
      isErased: boolean
    }[]
  >`
    select survivor_id::text                                 as "customerId",
           date_trunc('month', first_visit)::date::text      as "cohortMonth",
           first_visit::text                                 as "firstVisitBusinessDay",
           acquisition_source                                as "acquisitionSource",
           is_erased                                         as "isErased"
      from (
        select merge_survivor_of(c.customer_id)              as survivor_id,
               min(c.first_visit_business_day)               as first_visit,
               -- The label of the row carrying the EARLIEST first visit, which is the record the
               -- customer's history hangs off. A merge retains the earlier first touch (A-FIRST-08),
               -- so taking min() of the month and an arbitrary label would put a customer in one
               -- month's cohort with another month's channel.
               (array_agg(c.acquisition_source
                          order by c.first_visit_business_day, c.customer_id))[1]
                                                             as acquisition_source,
               bool_and(c.is_erased)                         as is_erased
          from reporting.dim_customer c
         where c.first_visit_business_day is not null
         group by merge_survivor_of(c.customer_id)
      ) collapsed
     where first_visit between ${args.period.startsOn}::date and ${args.period.endsOn}::date
     order by first_visit, survivor_id
  `
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })))
}

/** One month in which a customer had at least one delivered appointment. */
export interface CohortActivityRow {
  readonly customerId: string
  /** `YYYY-MM-01`. */
  readonly activityMonth: string
}

/**
 * Every (survivor, business month) pair with a delivered appointment in it, from a cohort's first
 * month up to and including `throughMonth`.
 *
 * `fact_appointment` and not `public.appointment`, so the trading date is the one the diary resolved
 * across midnight: a 01:30 treatment is filed under the PREVIOUS trading date and therefore counts in
 * the previous month, which is the whole reason ADR 0060 keys the facts on `business_day`. Truncating
 * `lower(period)` here would move the last two hours of every night — and, on the last night of a
 * month, a retention — into the next month.
 */
export async function cohortActivity(
  sql: Sql,
  args: { readonly fromMonth: string; readonly throughMonth: string },
): Promise<readonly CohortActivityRow[]> {
  assertIsoDate('fromMonth', args.fromMonth)
  assertIsoDate('throughMonth', args.throughMonth)
  const rows = await sql<{ customerId: string; activityMonth: string }[]>`
    select merge_survivor_of(a.customer_id)::text          as "customerId",
           date_trunc('month', a.business_day)::date::text as "activityMonth"
      from reporting.fact_appointment a
     where a.is_delivered
       and a.customer_id is not null
       and a.business_day >= date_trunc('month', ${args.fromMonth}::date)
       and a.business_day < (date_trunc('month', ${args.throughMonth}::date) + interval '1 month')
     group by 1, 2
     order by 1, 2
  `
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })))
}

// --- what a cohort's customers have been worth --------------------------------------------------

/** One customer-month's realised net revenue from tax documents, with the deliveries behind it. */
export interface CohortRevenueRow {
  readonly customerId: string
  /** `YYYY-MM-01`, from `tax_point_date` — the date of SUPPLY (0026). */
  readonly revenueMonth: string
  /** Invoices less credit notes, net of VAT. `fact_sale` already signs a credit note negative (0110). */
  readonly netFils: bigint
  readonly documentCount: number
}

/**
 * Net revenue per (survivor, business month) over the documents' own tax points.
 *
 * **This is NOT a contribution and must not be read as one.** It is what the documents say the customer
 * paid, net of VAT; a contribution is that less the costs attributable to delivering it, and ADR 0070
 * settled that three of the four cost components do not exist in this build.
 * `cohortContributionRow` in core refuses to build a contribution out of a delivery whose margin is
 * `not_attributable`, so this figure cannot reach a cohort value by accident — it is here because the
 * pairing suite MEASURES the gap rather than asserting it, and because a revenue cohort is a legitimate
 * figure under its own name.
 *
 * Bounded on `tax_point_date` and not on `entry_date` or `issued_at`, which is R-REP-04's three-column
 * table applied here: net revenue is the DOCUMENTS' net, the quantity `fact_sale` sums.
 */
export async function cohortNetRevenue(
  sql: Sql,
  args: { readonly fromMonth: string; readonly throughMonth: string },
): Promise<readonly CohortRevenueRow[]> {
  assertIsoDate('fromMonth', args.fromMonth)
  assertIsoDate('throughMonth', args.throughMonth)
  const rows = await sql<
    { customerId: string; revenueMonth: string; netFils: string; documentCount: string }[]
  >`
    select merge_survivor_of(s.customer_id)::text          as "customerId",
           date_trunc('month', s.business_day)::date::text  as "revenueMonth",
           coalesce(sum(s.net_fils), 0)::text              as "netFils",
           count(*)::text                                  as "documentCount"
      from reporting.fact_sale s
     where s.customer_id is not null
       and s.business_day >= date_trunc('month', ${args.fromMonth}::date)
       and s.business_day < (date_trunc('month', ${args.throughMonth}::date) + interval '1 month')
     group by 1, 2
     order by 1, 2
  `
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        customerId: row.customerId,
        revenueMonth: row.revenueMonth,
        netFils: BigInt(row.netFils),
        documentCount: Number(row.documentCount),
      }),
    ),
  )
}

// --- acquisition spend, which is a census and not a figure --------------------------------------

/**
 * What the marketing accounts moved by in a period, and the count of rows that say which CHANNEL.
 *
 * `channelTaggedRows` is structurally zero and the query is written so that it stays measured rather
 * than assumed: `bill_line` and `recurring_cost` reference `account (code)` and carry no channel column
 * at all, so there is nothing to join and the count is taken over the rows that exist. When a channel
 * tag arrives — `Y9-paid-channel-attribution` — this query grows a join and the caller's branch does not
 * move, because it already reads the count.
 *
 * The caller turns this into `channelAttributedSpend` or `spendNotChannelAttributed`: a non-zero
 * movement with no channel-tagged row is the second, which is what makes a CAC over the whole marketing
 * movement unreachable rather than merely discouraged.
 */
export interface AcquisitionSpendCensus {
  readonly periodId: string
  /** The accounts that were read, echoed, so a report says what it counted. */
  readonly accountCodes: readonly string[]
  /** Debits less credits on those accounts over the window. The whole movement, channel or not. */
  readonly movementFils: bigint
  readonly journalLineCount: number
  /** How many of those postings name a marketing channel. Zero, structurally, until a tag exists. */
  readonly channelTaggedRows: number
  /** The bill lines and recurring costs behind the movement, for a drill-down. */
  readonly billLineCount: number
  readonly recurringCostCount: number
}

export async function acquisitionSpendCensus(
  sql: Sql,
  args: { readonly period: KpiPeriod; readonly marketingAccountCodes: readonly string[] },
): Promise<AcquisitionSpendCensus> {
  assertCohortPeriod(args.period)
  if (args.marketingAccountCodes.length === 0) {
    throw new AppError(
      'validation',
      'A spend census needs the accounts to read. The chart lives in packages/core, which this ' +
        'package may not import, so the codes are an argument — ACQUISITION_SPEND_ACCOUNTS is the one ' +
        'statement of them.',
    )
  }
  const codes = [...args.marketingAccountCodes]
  const [row] = await sql<
    {
      movementFils: string
      journalLineCount: string
      billLineCount: string
      recurringCostCount: string
    }[]
  >`
    select
      coalesce((select sum(l.debit_fils - l.credit_fils)
                  from journal_line l
                  join journal_entry e on e.entry_id = l.entry_id
                 where l.account_code = any(${codes}::text[])
                   and e.entry_date between ${args.period.startsOn}::date
                                        and ${args.period.endsOn}::date), 0)::text
        as "movementFils",
      coalesce((select count(*)
                  from journal_line l
                  join journal_entry e on e.entry_id = l.entry_id
                 where l.account_code = any(${codes}::text[])
                   and e.entry_date between ${args.period.startsOn}::date
                                        and ${args.period.endsOn}::date), 0)::text
        as "journalLineCount",
      coalesce((select count(*)
                  from bill_line bl
                  join bill b on b.bill_id = bl.bill_id
                 where bl.expense_account_code = any(${codes}::text[])
                   and b.bill_date between ${args.period.startsOn}::date
                                       and ${args.period.endsOn}::date), 0)::text
        as "billLineCount",
      coalesce((select count(*)
                  from recurring_cost rc
                 where rc.expense_account_code = any(${codes}::text[])), 0)::text
        as "recurringCostCount"
  `
  return Object.freeze({
    periodId: args.period.periodId,
    accountCodes: Object.freeze(codes),
    movementFils: BigInt(row?.movementFils ?? '0'),
    journalLineCount: Number(row?.journalLineCount ?? '0'),
    // Nothing in this schema tags a cost with a marketing channel. Stated as a figure rather than
    // omitted so that the caller's branch reads a COUNT rather than a comment, and so that the day a
    // tag exists this line becomes a join and no caller changes.
    channelTaggedRows: 0,
    billLineCount: Number(row?.billLineCount ?? '0'),
    recurringCostCount: Number(row?.recurringCostCount ?? '0'),
  })
}

// --- the outstanding package liability ----------------------------------------------------------

/** One `package_balance` row's outstanding entitlement, with what the ledger released against it. */
export interface PackageEntitlementRow {
  readonly packageSaleId: string
  readonly balanceId: string
  readonly sessionsTotal: number
  readonly sessionsRemaining: number
  readonly valueFils: bigint
  /** `package_balance.released_fils`. Read so the session share can be held equal to it. */
  readonly releasedFils: bigint
  readonly expiresOn: string
  readonly isReconstruction: boolean
}

/**
 * Every balance with sessions left as at `asAt`, including the reconstructed ones.
 *
 * `isReconstruction` is carried rather than filtered, because H-MIG-03's liability is a real liability:
 * the entitlement remains and `2050` was credited for it. What it is NOT is a till sale, and the two are
 * posted by different journal sources — which is why {@link packageDeferredRevenueBySource} splits them
 * rather than scoping to one.
 *
 * `expires_on` is carried and NOT filtered on, which is the one place this query refuses to take a
 * position. Whether an expired package's unredeemed balance is retained (still owed) or forfeited
 * (revenue on the day it expired) is `Y9-package-policy`, and it moves the figure rather than labelling
 * it. The caller selects; `package_expiry_exposure` (M-TILL-10) is what reports the exposure either way.
 */
export async function packageEntitlements(
  sql: Sql,
  args: { readonly asAt: string },
): Promise<readonly PackageEntitlementRow[]> {
  assertIsoDate('asAt', args.asAt)
  const rows = await sql<
    {
      packageSaleId: string
      balanceId: string
      sessionsTotal: string
      sessionsRemaining: string
      valueFils: string
      releasedFils: string
      expiresOn: string
      isReconstruction: boolean
    }[]
  >`
    select b.package_sale_id::text                        as "packageSaleId",
           b.id::text                                     as "balanceId",
           b.sessions_total::text                         as "sessionsTotal",
           (b.sessions_total - b.sessions_redeemed)::text as "sessionsRemaining",
           b.value_fils::text                             as "valueFils",
           b.released_fils::text                          as "releasedFils",
           s.expires_on::text                             as "expiresOn",
           exists (select 1 from imported_package_sale i where i.package_sale_id = s.id)
                                                          as "isReconstruction"
      from package_balance b
      join package_sale s on s.id = b.package_sale_id
     where s.trading_date <= ${args.asAt}::date
       and b.sessions_redeemed < b.sessions_total
     order by s.trading_date, b.package_sale_id, b.line_no
  `
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        packageSaleId: row.packageSaleId,
        balanceId: row.balanceId,
        sessionsTotal: Number(row.sessionsTotal),
        sessionsRemaining: Number(row.sessionsRemaining),
        valueFils: BigInt(row.valueFils),
        releasedFils: BigInt(row.releasedFils),
        expiresOn: row.expiresOn,
        isReconstruction: row.isReconstruction,
      }),
    ),
  )
}

/** `2050`'s balance, split by the journal source that moved it. See the core module's own header. */
export interface DeferredRevenueBySource {
  readonly packageSaleFils: bigint
  readonly packageRedemptionFils: bigint
  readonly openingBalanceFils: bigint
  readonly otherFils: bigint
}

/**
 * The deferred-revenue account's credit-less-debit balance as at `asAt`, split by `journal_entry.source`.
 *
 * Three named sources and an `other`, and the split is what makes the tie to the schedule legible rather
 * than a single number that is either right or unexplained:
 *
 *   * `package_sale` and `package_redemption` are the till's, and are the scope `readPackageLiability`
 *     (M-TILL-10) uses for its own claim about what the till wrote.
 *   * `opening_balance` is H-MIG-03's reconstructed liability — `Dr 3030 / Cr 2050` on the opening date.
 *     It writes `package_sale` and `package_balance` rows too, so a schedule compared against the
 *     till's two sources alone would be out by exactly the import, with a message naming neither.
 *   * `other` is everything else. `2050` is a real account and nothing stops an adjustment landing on
 *     it; a reconciliation that filtered those postings out would balance while describing a different
 *     liability (ADR 0064's census argument).
 *
 * The total of the four is the whole account, which is the figure `readPackageDeferredRevenueFils`
 * returns and which `cohorts.itest.ts` holds this split equal to in the same commit — the arrangement
 * `month-reconciliation.ts` states in so many words: "the refinement is not a second answer, it is an
 * answer whose total the report itself holds to the one source".
 */
export async function packageDeferredRevenueBySource(
  sql: Sql,
  args: { readonly asAt: string; readonly deferredRevenueAccountCode: string },
): Promise<DeferredRevenueBySource> {
  assertIsoDate('asAt', args.asAt)
  if (args.deferredRevenueAccountCode.trim() === '') {
    throw new AppError(
      'validation',
      'The deferred-revenue account code is an argument, because the chart lives in a package this ' +
        'one may not import. It is blank.',
    )
  }
  const [row] = await sql<
    {
      packageSaleFils: string
      packageRedemptionFils: string
      openingBalanceFils: string
      otherFils: string
    }[]
  >`
    select
      coalesce(sum(l.credit_fils - l.debit_fils)
                 filter (where e.source = 'package_sale'), 0)::text      as "packageSaleFils",
      coalesce(sum(l.credit_fils - l.debit_fils)
                 filter (where e.source = 'package_redemption'), 0)::text as "packageRedemptionFils",
      coalesce(sum(l.credit_fils - l.debit_fils)
                 filter (where e.source = 'opening_balance'), 0)::text    as "openingBalanceFils",
      coalesce(sum(l.credit_fils - l.debit_fils)
                 filter (where e.source not in
                   ('package_sale', 'package_redemption', 'opening_balance')), 0)::text as "otherFils"
      from journal_line l
      join journal_entry e on e.entry_id = l.entry_id
     where l.account_code = ${args.deferredRevenueAccountCode}
       and e.entry_date <= ${args.asAt}::date
  `
  return Object.freeze({
    packageSaleFils: BigInt(row?.packageSaleFils ?? '0'),
    packageRedemptionFils: BigInt(row?.packageRedemptionFils ?? '0'),
    openingBalanceFils: BigInt(row?.openingBalanceFils ?? '0'),
    otherFils: BigInt(row?.otherFils ?? '0'),
  })
}

/**
 * `sold − released` as a `bigint`, over the same `asAt` `readPackageLiability` uses.
 *
 * A second READ of M-TILL-10's figure and deliberately not a second derivation: the subtraction is the
 * same one, over the same two tables, and it exists here only because `readPackageLiability` returns
 * `number` and this unit's figures are `bigint` for ADR 0064's measured reason — a ledger holding
 * 2^53 + 1 fils on each side reported a difference of −4 fils out of nothing. `cohorts.itest.ts` holds
 * the two equal in the same commit, which is what stops this becoming a second answer.
 */
export async function packageSoldLessReleasedFils(
  sql: Sql,
  args: { readonly asAt: string },
): Promise<bigint> {
  assertIsoDate('asAt', args.asAt)
  const [row] = await sql<{ soldFils: string; releasedFils: string }[]>`
    select
      coalesce((select sum(price_fils) from package_sale
                 where trading_date <= ${args.asAt}::date), 0)::text as "soldFils",
      coalesce((select sum(released_fils) from package_redemption
                 where trading_date <= ${args.asAt}::date), 0)::text as "releasedFils"
  `
  return BigInt(row?.soldFils ?? '0') - BigInt(row?.releasedFils ?? '0')
}
