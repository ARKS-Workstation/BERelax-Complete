import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { StatementPeriod } from './statement-queries.ts'
import { statementLedgerFigures } from './statement-queries.ts'

/**
 * The reads behind the contribution margin and the operational KPI set (R-REP-04).
 *
 * The **arithmetic** is `packages/core/src/reporting/contribution-margin.ts` and
 * `.../operational-kpis.ts` and stays there: `packages/db` may never import `packages/core` (ADR 0001),
 * so this module returns ROWS and computes no KPI. `packages/fixtures/src/contribution-margin.itest.ts`
 * is where the two halves meet against a real database, for the reason the brief gives —
 * `packages/fixtures` may depend on both.
 *
 * # A KPI period is bounded on THREE different columns, deliberately
 *
 * This is the first thing to get right and the easiest to get silently wrong, because "the period" reads
 * as one thing:
 *
 *   | what                        | bounded on                 | why                                 |
 *   | --------------------------- | -------------------------- | ----------------------------------- |
 *   | a delivery (appointment)    | `appointment.trading_date` | the diary's own trading day (0011)  |
 *   | a tax document              | `invoice.tax_point_date`   | the date of SUPPLY (0026)           |
 *   | a ledger position           | `journal_entry.entry_date` | the journal has no business day     |
 *
 * They are three different facts and no two of them can be substituted. A supply delivered on the last
 * trading day of a month and invoiced the next morning keeps its tax point in the old month (0026's own
 * words) while its invoice is dated in the new one; and the journal deliberately has NO foreign key to
 * `business_day`, because it must be able to record the rent for a month containing days the premises
 * were shut (ADR 0064). Reading one window with another's column moves money between periods, which is
 * the defect `date(occurred_at)` causes one layer down (ADR 0060).
 *
 * # Which function is the ONE SOURCE of every figure here
 *
 *   | figure                                   | the one source                      | unit     |
 *   | ---------------------------------------- | ----------------------------------- | -------- |
 *   | debits and credits per account to a date | `statementLedgerFigures`            | R-REP-02 |
 *   | the snapshotted price of a delivery      | `invoice_line` / `package_redemption` | M-TILL   |
 *   | the price a delivery started at          | `appointment.gross_price_fils`      | B-AVAIL  |
 *
 * {@link kpiLedgerMovement} calls `statementLedgerFigures` rather than aggregating `journal_line`
 * itself, which `statement-queries.ts` asks for in so many words: "`trialBalanceMovement` would be a
 * third read of the same quantity". The SUBTRACTION is done here and not by the caller, which is the one
 * place this module departs from that file's arrangement, and the reason is ADR 0001: the caller is
 * `packages/core`'s `movementBetween`, and `packages/db` cannot reach it.
 *
 * # No account code is stated in this file
 *
 * Every query that needs one takes it as an argument. The chart of accounts lives in `packages/core`
 * (`ACCOUNTS`), so a four-digit code written here would be a second statement of a code whose first
 * is somewhere this package may not import — and the pairing suite passes `ACCOUNTS.therapistWages`,
 * which is what holds the two equal.
 *
 * # Every money figure is a `bigint`
 *
 * `sum()` over the `fils` domain returns `numeric` and `connection.ts` hands it back as a string
 * precisely so nothing rounds it; `queries/trial-balance.ts` records the four fils a `number` produced
 * out of nothing on a cumulative ledger position. Both ends of every window are arguments, so a KPI for
 * a closed month is the same figure next year.
 */

/**
 * The window a KPI is read over.
 *
 * The same SHAPE as `StatementPeriod` and deliberately the same type rather than a copy of it: an
 * accountant's period identifier, a first day and a last day is one fact. What differs is the COLUMN
 * each query compares it against, which is the table in the module note and is stated per query rather
 * than per period.
 */
export type KpiPeriod = StatementPeriod

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The same guard `statement-queries.ts` applies to its own period, over a different column.
 *
 * Written out rather than imported because that file keeps it private, and it is ten lines of validation
 * rather than a figure — the thing worth refusing is the backwards window, which returns nothing and
 * looks exactly like a month with no trade in it.
 */
function assertKpiPeriod(period: KpiPeriod): void {
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
      `A KPI period ends ${period.endsOn}, before it starts ${period.startsOn}. Read backwards it ` +
        'returns nothing and looks like a month with no trade in it.',
    )
  }
  if (period.periodId.trim() === '') {
    throw new AppError(
      'validation',
      'periodId is the identifier an accountant recognises; it is blank',
    )
  }
}

/** `null` stays `null`; digits become a `bigint`. Never `Number`. */
const filsOf = (value: string | null): bigint | null => (value === null ? null : BigInt(value))

const requiredFils = (value: string | null, what: string): bigint => {
  if (value === null) {
    throw new AppError(
      'invariant_violated',
      `${what} came back null from an aggregate with a coalesce`,
    )
  }
  return BigInt(value)
}

// --- the documents ------------------------------------------------------------------------------

export interface KpiDocumentCounts {
  /** Tax and simplified invoices whose TAX POINT falls in the period. */
  readonly invoiceCount: number
  readonly invoiceNetFils: bigint
  /** Credit notes in the same window, as a POSITIVE magnitude. Reported, never netted here. */
  readonly creditNoteCount: number
  readonly creditNoteNetFils: bigint
  /** Invoices whose checkout entry posted to the retail revenue account. */
  readonly invoicesCarryingRetail: number
}

/**
 * The ticket counts and the document net for a period.
 *
 * **`creditNoteNetFils` is returned separately and as a positive magnitude.** `fact_sale` (R-REP-01)
 * negates a credit note because a consumer summing its `net_fils` wants net revenue; here the two are
 * kept apart because `average_ticket`'s denominator counts TICKETS and a credit note is not one — see
 * `averageTicket`'s own note. A caller wanting net revenue subtracts, which is one operator; a caller
 * wanting the average ticket cannot un-net a figure that arrived already netted.
 *
 * `invoicesCarryingRetail` reaches the retail account through `checkout_finalisation`, which is the only
 * row tying a document to its journal entry. `invoice_line` carries no account code and no product
 * reference, so a retail line is indistinguishable from a treatment line ON THE DOCUMENT — the ledger is
 * where the distinction lives. It is zero in this build and will stay zero until a retail line kind
 * exists (`basket.ts` has four kinds: service, discount, tip, package redemption), and reading the
 * ACCOUNT rather than a product table is what makes it start answering the day one does.
 */
export async function kpiDocumentCounts(
  sql: Sql,
  args: { readonly period: KpiPeriod; readonly retailRevenueAccountCode: string },
): Promise<KpiDocumentCounts> {
  assertKpiPeriod(args.period)
  const { startsOn, endsOn } = args.period
  const [row] = await sql<
    {
      invoiceCount: string
      invoiceNetFils: string
      creditNoteCount: string
      creditNoteNetFils: string
      invoicesCarryingRetail: string
    }[]
  >`
    select (select count(*)                            from invoice i
             where i.tax_point_date between ${startsOn}::date and ${endsOn}::date)::text
             as "invoiceCount",
           (select coalesce(sum(i.net_total), 0)       from invoice i
             where i.tax_point_date between ${startsOn}::date and ${endsOn}::date)::text
             as "invoiceNetFils",
           (select count(*)                            from credit_note cn
             where cn.tax_point_date between ${startsOn}::date and ${endsOn}::date)::text
             as "creditNoteCount",
           (select coalesce(sum(cn.net_total), 0)      from credit_note cn
             where cn.tax_point_date between ${startsOn}::date and ${endsOn}::date)::text
             as "creditNoteNetFils",
           (select count(distinct i.id)
              from invoice i
              join checkout_finalisation cf on cf.invoice_id = i.id
              join journal_line l on l.entry_id = cf.journal_entry_id
             where i.tax_point_date between ${startsOn}::date and ${endsOn}::date
               and l.account_code = ${args.retailRevenueAccountCode})::text
             as "invoicesCarryingRetail"
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'the KPI document census returned no row, which it cannot',
    )
  }
  return {
    invoiceCount: Number(row.invoiceCount),
    invoiceNetFils: requiredFils(row.invoiceNetFils, 'invoiceNetFils'),
    creditNoteCount: Number(row.creditNoteCount),
    creditNoteNetFils: requiredFils(row.creditNoteNetFils, 'creditNoteNetFils'),
    invoicesCarryingRetail: Number(row.invoicesCarryingRetail),
  }
}

// --- the deliveries ----------------------------------------------------------------------------

export interface KpiDeliveryRow {
  readonly appointmentId: string
  readonly businessDay: string
  readonly serviceVariantId: string
  readonly treatmentStyle: string
  readonly employeeId: string | null
  readonly roomId: string | null
  readonly treatmentMinutes: number
  readonly turnaroundMinutes: number
  /** `appointment.gross_price_fils`: the price this delivery started at, before anything at the till. */
  readonly snapshotGrossFils: bigint
  /** Set when a `price_list` row produced the gross — a menu reduction this build cannot measure. */
  readonly priceListId: string | null
  /** Set when a promotion produced the gross — a campaign reduction this build cannot measure. */
  readonly promotionId: string | null
  /** The document line that billed it, or null for a redemption or an unbilled delivery. */
  readonly invoiceId: string | null
  readonly lineNo: number | null
  readonly invoiceLineNetFils: bigint | null
  readonly invoiceLineGrossFils: bigint | null
  /** The redemption that recognised it, or null. */
  readonly redemptionId: string | null
  readonly redemptionNetFils: bigint | null
  readonly redemptionGrossFils: bigint | null
  /** Every tender kind that settled the document, deduplicated and sorted. Empty for a redemption. */
  readonly tenderKinds: readonly string[]
}

/**
 * Every DELIVERED appointment in the period, with the row its revenue was recognised on.
 *
 * `status = 'completed'` and nothing else. `BILLABLE_APPOINTMENT_STATUSES` in `packages/core` is derived
 * from B-LIFE-01's own table and is `['completed']`; the literal here is the same claim this package
 * cannot import, and `contribution-margin.itest.ts` asserts the two agree.
 *
 * **Two revenue sources, joined separately and never merged.** A till sale carries its net on
 * `invoice_line` and a package redemption on `package_redemption.net_fils` — the gross released from
 * `2050` when that session was delivered, snapshotted at the time (0083). The acceptance line "a package
 * redemption contributes revenue at the snapshotted per-session price, not the package price current on
 * the day the report runs" is this join and nothing else: there is no path here to
 * `package_template_version`, which is where today's price lives.
 *
 * `tenderKinds` is what the payment-fee component is decided from. Aggregated in a `lateral` so a
 * document settled by three tenders is still one row, and ORDERED so two reads produce the same array.
 */
export async function kpiDeliveryRows(
  sql: Sql,
  period: KpiPeriod,
): Promise<readonly KpiDeliveryRow[]> {
  assertKpiPeriod(period)
  const rows = await sql<
    {
      appointmentId: string
      businessDay: string
      serviceVariantId: string
      treatmentStyle: string
      employeeId: string | null
      roomId: string | null
      treatmentMinutes: number
      turnaroundMinutes: number
      snapshotGrossFils: string
      priceListId: string | null
      promotionId: string | null
      invoiceId: string | null
      lineNo: number | null
      invoiceLineNetFils: string | null
      invoiceLineGrossFils: string | null
      invoiceLineQuantity: number | null
      redemptionId: string | null
      redemptionNetFils: string | null
      redemptionGrossFils: string | null
      tenderKinds: string[] | null
    }[]
  >`
    select a.id::text                                  as "appointmentId",
           a.trading_date::text                        as "businessDay",
           a.service_variant_id::text                  as "serviceVariantId",
           s.style::text                               as "treatmentStyle",
           a.therapist_id::text                        as "employeeId",
           a.room_id::text                             as "roomId",
           (extract(epoch from (upper(a.period) - lower(a.period))) / 60)::integer
                                                       as "treatmentMinutes",
           a.turnaround_minutes                        as "turnaroundMinutes",
           a.gross_price_fils::text                    as "snapshotGrossFils",
           a.price_list_id::text                       as "priceListId",
           a.promotion_id                              as "promotionId",
           ia.invoice_id::text                         as "invoiceId",
           ia.line_no                                  as "lineNo",
           il.line_net_fils::text                      as "invoiceLineNetFils",
           il.line_gross_fils::text                    as "invoiceLineGrossFils",
           il.quantity                                 as "invoiceLineQuantity",
           pr.id::text                                 as "redemptionId",
           pr.net_fils::text                           as "redemptionNetFils",
           pr.released_fils::text                      as "redemptionGrossFils",
           tenders.kinds                               as "tenderKinds"
      from appointment a
      join service_variant sv on sv.id = a.service_variant_id
      join service s on s.id = sv.service_id
      left join invoice_appointment ia on ia.appointment_id = a.id
      left join invoice_line il on il.invoice_id = ia.invoice_id and il.line_no = ia.line_no
      left join package_redemption pr on pr.appointment_id = a.id
      left join lateral (
        select array_agg(distinct p.tender_kind order by p.tender_kind) as kinds
          from payment p
         where ia.invoice_id is not null and p.invoice_id = ia.invoice_id
      ) tenders on true
     where a.status = 'completed'
       and a.trading_date between ${period.startsOn}::date and ${period.endsOn}::date
     order by a.trading_date, a.id
  `
  return rows.map((row) => {
    // A line that bills an appointment is one delivery, so its quantity is 1 by construction
    // (`ServiceLine.quantity: 1` in packages/core). Refused rather than divided: a quantity of 2 here
    // would make the line's gross twice the appointment's snapshot and read as a 100% surcharge.
    if (
      row.invoiceId !== null &&
      row.invoiceLineQuantity !== null &&
      row.invoiceLineQuantity !== 1
    ) {
      throw new AppError(
        'invariant_violated',
        `invoice line ${row.invoiceId}#${String(row.lineNo)} bills appointment ${row.appointmentId} ` +
          `with a quantity of ${row.invoiceLineQuantity}. One appointment is one delivery, so a ` +
          'quantity above one means the line and the appointment are not about the same supply.',
        { details: { appointmentId: row.appointmentId, invoiceId: row.invoiceId } },
      )
    }
    return {
      appointmentId: row.appointmentId,
      businessDay: row.businessDay,
      serviceVariantId: row.serviceVariantId,
      treatmentStyle: row.treatmentStyle,
      employeeId: row.employeeId,
      roomId: row.roomId,
      treatmentMinutes: row.treatmentMinutes,
      turnaroundMinutes: row.turnaroundMinutes,
      snapshotGrossFils: requiredFils(row.snapshotGrossFils, 'snapshotGrossFils'),
      priceListId: row.priceListId,
      promotionId: row.promotionId,
      invoiceId: row.invoiceId,
      lineNo: row.lineNo,
      invoiceLineNetFils: filsOf(row.invoiceLineNetFils),
      invoiceLineGrossFils: filsOf(row.invoiceLineGrossFils),
      redemptionId: row.redemptionId,
      redemptionNetFils: filsOf(row.redemptionNetFils),
      redemptionGrossFils: filsOf(row.redemptionGrossFils),
      tenderKinds: Object.freeze([...(row.tenderKinds ?? [])]),
    }
  })
}

// --- the no-shows -------------------------------------------------------------------------------

export interface KpiNoShowRow {
  readonly appointmentId: string
  readonly businessDay: string
  readonly netFils: bigint
  /** The treatment's minutes plus its turnaround: what the room was held for and did not earn. */
  readonly roomMinutes: number
}

/**
 * The no-show appointments in the period, with the snapshot each carries.
 *
 * `appointment.net_fils` and not a catalogue lookup: 0024 stores the split per appointment and
 * `appointment_price_split_exact` makes `net + vat = gross` a database fact, so this is the price the
 * customer was told, as it was then.
 *
 * `roomMinutes` includes the TURNAROUND, and that is the acceptance line's "lost room-hours". The room
 * was held for the treatment and for the clean-down after it; `holds_resources` is GENERATED from the
 * status (0024) so a no-show releases the room at the moment somebody marks it, but the minutes on the
 * rota were already gone. Therapist utilisation excludes turnaround and room utilisation includes it —
 * R-REP-03's third acceptance line — and this is the room figure.
 */
export async function kpiNoShowRows(sql: Sql, period: KpiPeriod): Promise<readonly KpiNoShowRow[]> {
  assertKpiPeriod(period)
  const rows = await sql<
    { appointmentId: string; businessDay: string; netFils: string; roomMinutes: number }[]
  >`
    select a.id::text             as "appointmentId",
           a.trading_date::text   as "businessDay",
           a.net_fils::text       as "netFils",
           ((extract(epoch from (upper(a.period) - lower(a.period))) / 60) + a.turnaround_minutes)::integer
                                  as "roomMinutes"
      from appointment a
     where a.status = 'no_show'
       and a.trading_date between ${period.startsOn}::date and ${period.endsOn}::date
     order by a.trading_date, a.id
  `
  return rows.map((row) => ({
    appointmentId: row.appointmentId,
    businessDay: row.businessDay,
    netFils: requiredFils(row.netFils, 'netFils'),
    roomMinutes: row.roomMinutes,
  }))
}

// --- the discounted lines -----------------------------------------------------------------------

export interface KpiInvoiceLineRow {
  readonly invoiceId: string
  readonly lineNo: number
  readonly quantity: number
  /** `line_gross_fils`: `unit_gross_fils * quantity`, generated, so nobody can disagree about it. */
  readonly chargedGrossFils: bigint
  /**
   * `appointment.gross_price_fils` through `invoice_appointment`, or `null`.
   *
   * Null is reachable and expected: `invoice_appointment.line_no` is nullable by design (a redemption
   * line bills an appointment that appears on no invoice line at all), a document may be raised outside
   * a checkout, and a line that bills no appointment has no snapshot to be compared against.
   */
  readonly listGrossFils: bigint | null
}

/**
 * Every invoice line in the period, with the gross its delivery started at where one is recorded.
 *
 * This pair of columns IS the discount leakage figure, and both are snapshots: the charged gross is
 * `invoice_line.unit_gross_fils * quantity`, generated in the database (0026), and the list gross is
 * `appointment.gross_price_fils`, which `serviceLineFromAppointment` copies "field for field" into the
 * basket line the till then discounts. So the difference is the reduction applied AT THE TILL, exact to
 * the fils, and it drills to the `invoice_line` rows the acceptance line names.
 *
 * **What it does not see, and why the caller is given the means to say so.** A price reduced by a
 * `price_list` row or a promotion is already inside `appointment.gross_price_fils`, and the catalogue
 * price it was reduced from is snapshotted nowhere — `dim_service.list_gross_fils` is the price TODAY
 * (0110). {@link kpiDiscountCoverage} counts the deliveries in that state so a report can state its
 * coverage rather than quietly mean less than its label.
 */
export async function kpiInvoiceLineRows(
  sql: Sql,
  period: KpiPeriod,
): Promise<readonly KpiInvoiceLineRow[]> {
  assertKpiPeriod(period)
  const rows = await sql<
    {
      invoiceId: string
      lineNo: number
      quantity: number
      chargedGrossFils: string
      listGrossFils: string | null
    }[]
  >`
    select il.invoice_id::text         as "invoiceId",
           il.line_no                  as "lineNo",
           il.quantity                 as "quantity",
           il.line_gross_fils::text    as "chargedGrossFils",
           a.gross_price_fils::text    as "listGrossFils"
      from invoice i
      join invoice_line il on il.invoice_id = i.id
      left join invoice_appointment ia
             on ia.invoice_id = il.invoice_id and ia.line_no = il.line_no
      left join appointment a on a.id = ia.appointment_id
     where i.tax_point_date between ${period.startsOn}::date and ${period.endsOn}::date
     order by il.invoice_id, il.line_no
  `
  return rows.map((row) => ({
    invoiceId: row.invoiceId,
    lineNo: row.lineNo,
    quantity: row.quantity,
    chargedGrossFils: requiredFils(row.chargedGrossFils, 'chargedGrossFils'),
    listGrossFils: filsOf(row.listGrossFils),
  }))
}

export interface KpiDiscountCoverage {
  readonly deliveries: number
  /** Deliveries whose gross came from a `price_list` row: a menu reduction the figure cannot see. */
  readonly pricedByPriceList: number
  /** Deliveries carrying a promotion id: a campaign reduction the figure cannot see. */
  readonly pricedByPromotion: number
}

/** How much of the period's deliveries the till-discount figure cannot speak for. */
export async function kpiDiscountCoverage(
  sql: Sql,
  period: KpiPeriod,
): Promise<KpiDiscountCoverage> {
  assertKpiPeriod(period)
  const [row] = await sql<
    { deliveries: string; pricedByPriceList: string; pricedByPromotion: string }[]
  >`
    select count(*)::text                                                      as "deliveries",
           count(*) filter (where a.price_list_id is not null)::text            as "pricedByPriceList",
           count(*) filter (where a.promotion_id is not null)::text             as "pricedByPromotion"
      from appointment a
     where a.status = 'completed'
       and a.trading_date between ${period.startsOn}::date and ${period.endsOn}::date
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'the discount coverage census returned no row')
  }
  return {
    deliveries: Number(row.deliveries),
    pricedByPriceList: Number(row.pricedByPriceList),
    pricedByPromotion: Number(row.pricedByPromotion),
  }
}

// --- rebooking ----------------------------------------------------------------------------------

export interface KpiRebooking {
  readonly deliveredAppointments: number
  readonly rebookedWithinWindow: number
  readonly windowDays: number
  /**
   * Deliveries whose booking carries no customer record, and which therefore cannot be observed to
   * rebook at all.
   *
   * A cash sale at the desk has no customer (ADR 0014), so this is not an edge case — it is the honest
   * ceiling on the figure, reported beside it rather than silently counted as a client who never came
   * back.
   */
  readonly deliveriesWithoutACustomerRecord: number
}

/**
 * How many deliveries were followed by a new booking within `windowDays`.
 *
 * `windowDays` is a required argument and this module supplies no default, for the reason
 * Y9-crm-lifecycle records about the lapse thresholds: "events supplied by the caller, not durations
 * this build has chosen". "Booked before leaving" and "booked again within a month" are two different
 * figures and they would arrive under one name.
 *
 * The window runs from the END of the treatment — `upper(appointment.period)` — and not from its trading
 * date, because a trading date is a whole session and a 01:30 delivery compared against its own date
 * would be measured from fourteen hours earlier. The new booking must be a DIFFERENT booking: the one
 * being delivered was created before the treatment, and counting it would make every delivery a
 * rebooking.
 */
export async function kpiRebooking(
  sql: Sql,
  args: { readonly period: KpiPeriod; readonly windowDays: number },
): Promise<KpiRebooking> {
  assertKpiPeriod(args.period)
  if (!Number.isInteger(args.windowDays) || args.windowDays < 1) {
    throw new AppError(
      'validation',
      `A rebooking window of ${args.windowDays} days is not a window. It is required and has no ` +
        'default because the figure means something different for every value of it ' +
        '(Y9-crm-lifecycle).',
      { details: { windowDays: args.windowDays } },
    )
  }
  const [row] = await sql<{ delivered: string; rebooked: string; withoutCustomer: string }[]>`
    with delivered as (
      select a.id, a.booking_id, b.customer_id, upper(a.period) as ended_at
        from appointment a
        join booking b on b.id = a.booking_id
       where a.status = 'completed'
         and a.trading_date between ${args.period.startsOn}::date and ${args.period.endsOn}::date
    )
    select count(*)::text                                                as "delivered",
           count(*) filter (
             where d.customer_id is not null
               and exists (
                 select 1
                   from booking nb
                  where nb.customer_id = d.customer_id
                    and nb.id <> d.booking_id
                    and nb.created_at > d.ended_at
                    and nb.created_at <= d.ended_at + make_interval(days => ${args.windowDays})
               )
           )::text                                                       as "rebooked",
           count(*) filter (where d.customer_id is null)::text            as "withoutCustomer"
      from delivered d
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'the rebooking census returned no row, which it cannot',
    )
  }
  return {
    deliveredAppointments: Number(row.delivered),
    rebookedWithinWindow: Number(row.rebooked),
    windowDays: args.windowDays,
    deliveriesWithoutACustomerRecord: Number(row.withoutCustomer),
  }
}

// --- the ledger movement ------------------------------------------------------------------------

export interface KpiAccountMovement {
  readonly accountCode: string
  /** Closing minus opening, as `debit - credit`. Positive is a debit movement. */
  readonly movementFils: bigint
}

/**
 * The movement on the named accounts across the period, from the one source of a ledger position.
 *
 * `statementLedgerFigures` and not a fresh aggregate over `journal_line`: that module's own note says
 * "`trialBalanceMovement` would be a third read of the same quantity", and this is the caller it was
 * talking about. The SUBTRACTION happens here rather than in the caller — the one departure from
 * `statement-queries.ts`'s arrangement — because the caller is `movementBetween` in `packages/core` and
 * `packages/db` may not import it (ADR 0001).
 *
 * An account with no movement is returned with `0n` rather than omitted, so a caller reading four
 * labour accounts gets four rows and cannot mistake "no wage was posted" for "the account was not read".
 * That distinction is the whole subject of ADR 0070 and it would be lost by a missing row.
 *
 * Direction is `debit - credit`, which is positive for an expense that was incurred. The caller applies
 * the sense: `./statements.ts` keeps `LineDirection` per line for exactly this reason, and a magnitude
 * here would make a credit to an expense account — a supplier credit note — indistinguishable from more
 * expense.
 */
export async function kpiLedgerMovement(
  sql: Sql,
  args: { readonly period: KpiPeriod; readonly accountCodes: readonly string[] },
): Promise<readonly KpiAccountMovement[]> {
  assertKpiPeriod(args.period)
  if (args.accountCodes.length === 0) {
    throw new AppError(
      'validation',
      'A KPI ledger movement needs at least one account code. An empty set matches no account, so it ' +
        'would agree with any figure at all.',
    )
  }
  const figures = await statementLedgerFigures(sql, args.period)
  const net = (
    position: readonly { accountCode: string; debitFils: bigint; creditFils: bigint }[],
    code: string,
  ): bigint => {
    const row = position.find((figure) => figure.accountCode === code)
    return row === undefined ? 0n : row.debitFils - row.creditFils
  }
  return Object.freeze(
    [...args.accountCodes].sort().map((accountCode) => ({
      accountCode,
      movementFils:
        net(figures.closingPosition, accountCode) - net(figures.openingPosition, accountCode),
    })),
  )
}

// --- the bag -----------------------------------------------------------------------------------

/**
 * Every figure the operational KPI set may read, for one period.
 *
 * Structurally the same as `PeriodFigures` in `packages/core/src/reporting/operational-kpis.ts`, which
 * this package may not import (ADR 0001). The two are held equal by a TYPE ANNOTATION in
 * `packages/fixtures/src/contribution-margin.itest.ts` — the one package allowed to depend on both — so
 * a field renamed or dropped on either side is a `pnpm typecheck` failure rather than a figure that
 * silently stops being read.
 *
 * **Four fields are deliberately `null` here and in every call.** `variableCostFils` and
 * `fixedCostFils` need the expense accounts split into fixed and variable, which nothing in this build
 * states (Y9-unit-cost-basis); `labour` is `null` only when the caller passes no labour accounts. A
 * `null` is a figure that was not read, and the KPI that reads it answers `no_data` naming it — which is
 * why none of these is optional: an absent property and a property nobody set are the same thing in
 * JavaScript and different claims here.
 */
export interface KpiPeriodFigures {
  readonly periodId: string
  readonly invoiceNetFils: bigint | null
  readonly invoiceCount: number | null
  readonly creditNoteNetFils: bigint | null
  readonly invoicesCarryingRetail: number | null
  readonly deliveredAppointments: number | null
  readonly rebookedWithinWindow: number | null
  readonly rebookingWindowDays: number | null
  readonly noShows: readonly KpiNoShowRow[] | null
  readonly discountedLines: readonly KpiInvoiceLineRow[] | null
  readonly labour: {
    readonly wagesFils: bigint
    readonly commissionFils: bigint
    readonly gratuityAccrualFils: bigint
    readonly leaveAccrualFils: bigint
  } | null
  readonly netRevenueFils: bigint | null
  readonly tipsCollectedFils: bigint | null
  readonly variableCostFils: bigint | null
  readonly fixedCostFils: bigint | null
}

/** The account codes the bag needs, passed in because the chart lives in `packages/core`. */
export interface KpiAccountCodes {
  readonly retailRevenue: string
  readonly therapistWages: string
  readonly staffCommission: string
  readonly gratuityExpense: string
  readonly annualLeaveExpense: string
  readonly tipsPayable: string
}

/**
 * Every figure for one period, in one round of reads.
 *
 * `netRevenueFils` is the DOCUMENTS' net — invoices less credit notes over their tax points — and
 * deliberately not the revenue accounts' movement. The two should agree, because the checkout posts
 * both from one basket, and they are bounded on different columns: a supply invoiced the morning after
 * it was delivered keeps its tax point in the old period while its journal entry is dated in the new
 * one. The document figure is the one the VAT return and `fact_sale` (R-REP-01) use, so it is the one
 * used here; reading the accounts instead would make labour cost %'s denominator disagree with every
 * other revenue figure in the build by whatever straddles the boundary.
 *
 * `tipsCollectedFils` is the movement on `2040 Tips payable`, NEGATED, because a gratuity collected is a
 * credit to a liability and `kpiLedgerMovement` returns `debit - credit`. It is read so that
 * `labourCostPercent` can report it beside the figure and show it was excluded rather than forgotten.
 */
export async function kpiPeriodFigures(
  sql: Sql,
  args: {
    readonly period: KpiPeriod
    readonly accounts: KpiAccountCodes
    readonly rebookingWindowDays: number
  },
): Promise<KpiPeriodFigures> {
  assertKpiPeriod(args.period)
  const [documents, noShows, discountedLines, rebooking, movement] = await Promise.all([
    kpiDocumentCounts(sql, {
      period: args.period,
      retailRevenueAccountCode: args.accounts.retailRevenue,
    }),
    kpiNoShowRows(sql, args.period),
    kpiInvoiceLineRows(sql, args.period),
    kpiRebooking(sql, { period: args.period, windowDays: args.rebookingWindowDays }),
    kpiLedgerMovement(sql, {
      period: args.period,
      accountCodes: [
        args.accounts.therapistWages,
        args.accounts.staffCommission,
        args.accounts.gratuityExpense,
        args.accounts.annualLeaveExpense,
        args.accounts.tipsPayable,
      ],
    }),
  ])
  const movementOf = (code: string): bigint =>
    movement.find((row) => row.accountCode === code)?.movementFils ?? 0n

  return {
    periodId: args.period.periodId,
    invoiceNetFils: documents.invoiceNetFils,
    invoiceCount: documents.invoiceCount,
    creditNoteNetFils: documents.creditNoteNetFils,
    invoicesCarryingRetail: documents.invoicesCarryingRetail,
    deliveredAppointments: rebooking.deliveredAppointments,
    rebookedWithinWindow: rebooking.rebookedWithinWindow,
    rebookingWindowDays: rebooking.windowDays,
    noShows,
    discountedLines,
    labour: {
      wagesFils: movementOf(args.accounts.therapistWages),
      commissionFils: movementOf(args.accounts.staffCommission),
      gratuityAccrualFils: movementOf(args.accounts.gratuityExpense),
      leaveAccrualFils: movementOf(args.accounts.annualLeaveExpense),
    },
    netRevenueFils: documents.invoiceNetFils - documents.creditNoteNetFils,
    // Negated: a gratuity collected is a CREDIT to the liability, and the movement is debit - credit.
    tipsCollectedFils: -movementOf(args.accounts.tipsPayable),
    // Nothing in this build classifies an expense account as fixed or variable (Y9-unit-cost-basis), so
    // these are null rather than a guess — and `contribution_margin_ratio` and `break_even_revenue`
    // answer no_data naming them, which is the state ADR 0070 requires of an unattributable figure.
    variableCostFils: null,
    fixedCostFils: null,
  }
}

// --- the therapist cost, and why it has no figure -----------------------------------------------

export interface KpiTherapistCostRow {
  readonly appointmentId: string
  /** The commission computed for this appointment by the named run, or `null` if there is none. */
  readonly commissionFils: bigint | null
  readonly commissionRunId: string | null
  /** The employee who delivered it, so the wage side can be looked for. */
  readonly employeeId: string | null
  /** True when that employee has no `basic_wage_fils` on file — which is all nineteen of them. */
  readonly employeeHasNoWageOnFile: boolean
}

export interface KpiTherapistCostCensus {
  readonly rows: readonly KpiTherapistCostRow[]
  readonly deliveries: number
  readonly deliveriesWithACommissionLine: number
  /**
   * Delivering employees with no basic wage recorded.
   *
   * The same census `rota_version.forecast_unpriced_employees` keeps, for the same measured reason: "an
   * employee with no wage contributes nothing to a sum, so a forecast over a rota where no wage is
   * recorded is 0 fils and reads as a free rota. All nineteen seeded employees are unpriced."
   */
  readonly unpricedEmployees: number
  readonly publishedCommissionRuleVersions: number
}

/**
 * Everything this build holds about what a delivery cost in labour — which is close to nothing, and the
 * census is the point.
 *
 * Two paths to a per-treatment therapist cost exist and neither has a figure today:
 *
 *   * **commission.** `commission_line` is per appointment (0097), so a run over the period produces
 *     exactly the right grain. But the module ships DISABLED with no published rule version
 *     (Y9-commission) and the engine produces zero lines rather than paying a rate this build invented,
 *     so there are none. `publishedCommissionRuleVersions` is counted so "no commission because the
 *     module is off" is never reported as "no commission is due" — which is the distinction
 *     `commission_run.module_enabled` exists for one unit along.
 *   * **wages.** `employee.basic_wage_fils` is NULL for all nineteen employment records (Y8-staff), and
 *     even with a wage, turning a MONTHLY figure into a per-treatment one needs an attribution basis
 *     nobody has stated (Y9-unit-cost-basis). `labour_cost_rule` (0081) holds a divisor for a rota
 *     FORECAST and its own comment says payroll "pays attendance (P-HR-07), never this figure".
 *
 * So the honest return is the rows plus the counts, and the caller turns an absence into
 * `unattributableCost('therapist', …)` rather than into a zero.
 */
export async function kpiTherapistCostCensus(
  sql: Sql,
  args: { readonly period: KpiPeriod; readonly commissionRunId?: string | null },
): Promise<KpiTherapistCostCensus> {
  assertKpiPeriod(args.period)
  const runId = args.commissionRunId ?? null
  const rows = await sql<
    {
      appointmentId: string
      commissionFils: string | null
      commissionRunId: string | null
      employeeId: string | null
      employeeHasNoWageOnFile: boolean
    }[]
  >`
    select a.id::text                                   as "appointmentId",
           cl.commission_fils::text                     as "commissionFils",
           cl.run_id::text                              as "commissionRunId",
           a.therapist_id::text                         as "employeeId",
           (e.basic_wage_fils is null)                  as "employeeHasNoWageOnFile"
      from appointment a
      left join employee e on e.id = a.therapist_id
      left join commission_line cl
             on cl.appointment_id = a.id
            and (${runId}::uuid is null or cl.run_id = ${runId}::uuid)
     where a.status = 'completed'
       and a.trading_date between ${args.period.startsOn}::date and ${args.period.endsOn}::date
     order by a.trading_date, a.id
  `
  const [census] = await sql<{ publishedVersions: string }[]>`
    select count(*)::text as "publishedVersions" from commission_rule
  `
  const mapped = rows.map((row) => ({
    appointmentId: row.appointmentId,
    commissionFils: filsOf(row.commissionFils),
    commissionRunId: row.commissionRunId,
    employeeId: row.employeeId,
    employeeHasNoWageOnFile: row.employeeHasNoWageOnFile,
  }))
  return {
    rows: Object.freeze(mapped),
    deliveries: mapped.length,
    deliveriesWithACommissionLine: mapped.filter((row) => row.commissionFils !== null).length,
    unpricedEmployees: new Set(
      mapped.filter((row) => row.employeeHasNoWageOnFile).map((row) => row.employeeId),
    ).size,
    publishedCommissionRuleVersions: Number(census?.publishedVersions ?? '0'),
  }
}
