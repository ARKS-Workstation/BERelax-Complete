import {
  ACCOUNTS,
  type ContributionMarginInput,
  type CostComponent,
  contributionMarginUnit,
  type DiscountedInvoiceLine,
  discountLeakage,
  entryId,
  filsFrom,
  instantFromIso,
  localDate,
  measuredCost,
  money,
  type NoShowAppointment,
  noShowCost,
  type PeriodFigures,
  paymentFeeComponent,
  serviceContributionMargin,
  type TenderKind,
  unattributableCost,
} from '@berelax/core'
import {
  createConnection,
  currentPackageTemplateVersion,
  issueInvoice,
  type KpiPeriod,
  kpiDeliveryRows,
  kpiDiscountCoverage,
  kpiDocumentCounts,
  kpiInvoiceLineRows,
  kpiNoShowRows,
  kpiPeriodFigures,
  kpiRebooking,
  kpiTherapistCostCensus,
  redeemPackage,
  type Sql,
  savePackageTemplateVersion,
  sellPackage,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { invoiceFixture } from './invoice.ts'
import { packageSaleMapping } from './package.ts'
import {
  assertPackageRedemptionMappingReconciles,
  packageRedemptionMapping,
} from './package-redemption.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * R-REP-04 — the contribution margin and the operational KPIs against a real database.
 *
 * It lives in `@berelax/fixtures` because the arithmetic is `@berelax/core`'s and the rows are
 * `@berelax/db`'s, and fixtures is the one package allowed to depend on both: `db` must never import
 * `core` (ADR 0001). That is R-REP-02's arrangement for the same reason one subject along.
 *
 * # What is proved here and nowhere else
 *
 *   1. **The two revenue sources are two different rows.** A till sale's net comes from `invoice_line`
 *      and a redemption's from `package_redemption.net_fils`, and the redemption figure is UNCHANGED by
 *      publishing a new template version at a different price afterwards. That is the acceptance line
 *      "at the snapshotted per-session price, not the package price current on the day the report runs",
 *      and it can only be proved by moving the catalogue price under a redemption that already happened.
 *   2. **Discount leakage ties exactly to `invoice_line` rows.** The figure is computed from the rows the
 *      query returns, and the rows are compared against the appointment snapshots they came from.
 *   3. **No-show cost drills to the no-show appointments** and reports room minutes separately.
 *   4. **The margin over this build's own data is `not_attributable`, measured rather than asserted.**
 *      `kpiTherapistCostCensus` reads zero published commission rule versions and every delivering
 *      employee unpriced, which is what ADR 0070 is about — and the figure a zero would have produced is
 *      named, so the refusal is visible as a choice.
 *   5. **The db bag and core's `PeriodFigures` are the same shape**, held equal by a type annotation in
 *      this file, which is the only place the two may meet.
 *
 * # Why the window is searched for rather than fixed
 *
 * `invoice`, `invoice_line`, `journal_entry` and `package_redemption` all refuse DELETE for every role,
 * so this suite cannot clean up after itself and a FIXED window would double every figure on a second
 * run — and the brief requires the suite to run twice. So it reserves a span of trading dates no other
 * suite uses and takes the first day in it that has no `business_day` row, which is a day no earlier run
 * can have written to. R-REP-02's suites do the same over 2250-2299 and 2300-2349 for the journal.
 *
 * Nothing here truncates: every figure is read over the suite's OWN trading date, so earlier files'
 * rows cannot reach it (brief rule 12) and nothing has to be removed (ADR 0050).
 */

/**
 * The whole of 2075: no suite, fixture or gate anywhere in the repository uses a date in it.
 *
 * **The YEAR matters more than the days, and the first version of this file had it wrong.** `TAX-INV`
 * has `reset_policy = 'annual'`, so a tax invoice issued here consumes a number inside its own
 * `period_key` — and `packages/db/src/services/issue-credit-note.itest.ts` asserts
 * `displayNumber === 'TI-2097-00001'`. Four runs of this suite against a 2097 trading date took
 * TI-2097-00001 through 00004 and would have failed that file on the integrator's shared database, with
 * a symptom naming a credit note and not this suite. So the span is a year nothing claims, and it is a
 * WHOLE year because the suite needs a fresh day per run and cannot delete the one it used.
 */
const RESERVED_FROM = '2075-01-01'
const RESERVED_TO = '2075-12-31'

const ACTOR = { kind: 'staff' as const, role: 'owner' as const, label: 'R-REP-04 pair itest' }

/** 21,000 gross: net 20,000, VAT 1,000. The Asian variant, sold at the till. */
const ASIAN_GROSS = 21_000
const ASIAN_NET = 20_000
/** 30,000 gross: net 28,571, VAT 1,429 (VAT is the remainder, ADR 0007). The Arabic variant. */
const ARABIC_GROSS = 30_000
const ARABIC_NET = 28_571
/** What the till actually charged for the Asian treatment, so the leakage is 2,000 fils of gross. */
const ASIAN_CHARGED_GROSS = 19_000
const ASIAN_CHARGED_NET = 18_095
const TILL_LEAKAGE_GROSS = BigInt(ASIAN_GROSS - ASIAN_CHARGED_GROSS)

let sql: Sql
let tradingDate: string
let period: KpiPeriod
let customerId: string
let bookingId: string
let asianVariantId: string
let arabicVariantId: string
let roomId: string
let employeeId: string
let asianAppointmentId: string
let arabicAppointmentId: string
let noShowAppointmentId: string
let invoiceId: string
let redemptionNetFils: bigint
let templateKey: string

const dubai = (date: string, hhmm: string): string => `${date} ${hhmm}:00+04`

/** A distinct slot inside the trading day, as a `[)` tstzrange literal. */
const slotAt = (startHour: number, minutes: number): string =>
  `[${dubai(tradingDate, `${String(startHour).padStart(2, '0')}:00`)},` +
  `${dubai(tradingDate, `${String(startHour + Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`)})`

/**
 * The first trading date in the reserved span with no `business_day` row.
 *
 * A day with a row is a day an earlier run of this suite already used, and its invoices and redemptions
 * cannot be removed. Searching rather than fixing the date is what makes the second run of this file
 * read its own figures rather than two runs' added together.
 *
 * The cast is `::date::text` and not `::text`, which cost a run: `generate_series` over an interval
 * returns a TIMESTAMP, so the plain cast gives `2097-02-01 00:00:00+00` and every date literal built
 * from it is malformed — and the error names a timestamp column three statements later.
 */
async function virginTradingDate(): Promise<string> {
  const rows = await sql<{ day: string }[]>`
    select d::date::text as day
      from generate_series(${RESERVED_FROM}::date, ${RESERVED_TO}::date, interval '1 day') d
     where not exists (select 1 from business_day bd where bd.trading_date = d::date)
     order by d
     limit 1
  `
  const day = rows[0]?.day
  if (day === undefined) {
    throw new Error(
      `every trading date from ${RESERVED_FROM} to ${RESERVED_TO} is already used. This suite cannot ` +
        'delete an invoice, a journal entry or a redemption, so it needs a fresh day each run — widen ' +
        'the reserved span rather than reusing one.',
    )
  }
  return day
}

async function insertAppointment(args: {
  readonly variantId: string
  readonly status: string
  readonly slot: string
  readonly grossFils: number
  readonly netFils: number
  readonly turnaround: number
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into appointment (
      booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
      delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
      gross_price_fils, net_fils, vat_fils, vat_rate_bp
    ) values (
      ${bookingId}::uuid, ${tradingDate}::date, ${args.variantId}::uuid, 'solo'::service_shape,
      ${employeeId}::uuid, ${roomId}::uuid, ${args.slot}::tstzrange, ${args.status}::appointment_status,
      gen_random_uuid(), 1, ${args.turnaround}, 10,
      ${args.grossFils}, ${args.netFils}, ${args.grossFils - args.netFils}, 500
    )
    returning id::text as id
  `
  const id = row?.id
  if (id === undefined) throw new Error('the appointment insert returned no row')
  return id
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 4 })
  tradingDate = await virginTradingDate()
  period = { periodId: `rrep04-${tradingDate}`, startsOn: tradingDate, endsOn: tradingDate }
  templateKey = `rrep04_${tradingDate.replace(/-/g, '')}`

  // Trading runs 11:00-02:00 Asia/Dubai, so `closes_at` is on the NEXT calendar day and
  // `crosses_midnight` is GENERATED from that (0011). The next date is computed by PostgreSQL rather
  // than in JavaScript: the end of a month is date arithmetic with one correct implementation.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (
      ${tradingDate}::date,
      (${tradingDate}::date + time '11:00') at time zone 'Asia/Dubai',
      (${tradingDate}::date + 1 + time '02:00') at time zone 'Asia/Dubai',
      'weekly'
    )
    on conflict (trading_date) do nothing
  `

  // Seeded reference rows, read rather than created: the fixture salon has 8 services x 4 durations,
  // 5 rooms, 19 employees and 4 customers (P-HR-01, B-CAT seeding).
  const [asian] = await sql<{ id: string }[]>`
    select sv.id::text as id from service_variant sv join service s on s.id = sv.service_id
     where s.style = 'asian' order by sv.id limit 1
  `
  const [arabic] = await sql<{ id: string }[]>`
    select sv.id::text as id from service_variant sv join service s on s.id = sv.service_id
     where s.style = 'arabic' order by sv.id limit 1
  `
  const [room] = await sql<{ id: string }[]>`select id::text as id from rooms order by id limit 1`
  const [employee] = await sql<{ id: string }[]>`
    select id::text as id from employee order by id limit 1
  `
  const [customer] = await sql<{ id: string }[]>`
    select id::text as id from customer order by id limit 1
  `
  asianVariantId = asian?.id ?? ''
  arabicVariantId = arabic?.id ?? ''
  roomId = room?.id ?? ''
  employeeId = employee?.id ?? ''
  customerId = customer?.id ?? ''
  if (!asianVariantId || !arabicVariantId || !roomId || !employeeId || !customerId) {
    throw new Error('the fixture salon is not seeded: run `pnpm seed` (brief rule 24)')
  }

  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${customerId}::uuid, 'walk_in', 'R-REP-04 pair itest')
    returning id::text as id
  `
  bookingId = booking?.id ?? ''

  asianAppointmentId = await insertAppointment({
    variantId: asianVariantId,
    status: 'completed',
    slot: slotAt(11, 60),
    grossFils: ASIAN_GROSS,
    netFils: ASIAN_NET,
    turnaround: 20,
  })
  arabicAppointmentId = await insertAppointment({
    variantId: arabicVariantId,
    status: 'completed',
    slot: slotAt(13, 90),
    grossFils: ARABIC_GROSS,
    netFils: ARABIC_NET,
    turnaround: 20,
  })
  noShowAppointmentId = await insertAppointment({
    variantId: asianVariantId,
    status: 'no_show',
    slot: slotAt(16, 60),
    grossFils: ASIAN_GROSS,
    netFils: ASIAN_NET,
    turnaround: 20,
  })

  // The numbering counter is aligned to this suite's own period BEFORE a number is allocated, and it is
  // not fastidiousness — it is the only thing that makes this file re-runnable in any order.
  //
  // `TAX-INV` resets annually, and `allocate_document_number` sets `next_number = 2` whenever the
  // period_key CHANGES (0013). So: run once in 2075, then let any other suite issue a document in its
  // own probe year, then run again — the counter resets to 1, `TI-2075-00001` already exists, and the
  // second run dies on `invoice_display_number_unique` with a message about a display number and
  // nothing about ordering. Setting the counter one past the highest number this series has actually
  // issued in this period is idempotent, is what `issue-credit-note.itest.ts` does in its own
  // `beforeEach`, and leaves the row in a state every later suite already handles.
  await sql`
    update document_series s
       set period_key = ${tradingDate.slice(0, 4)},
           next_number = coalesce(
             (select max(i.number) from invoice i
               where i.series_code = s.code and i.period_key = ${tradingDate.slice(0, 4)}),
             0
           ) + 1
     where s.code = 'TAX-INV'
  `

  // The till sale: ONE line, charged below the appointment's snapshot, which is the discount reaching
  // the document as a reduced line price (`unit_gross_fils` is a fils_nonneg domain, so a negative
  // discount line is impossible).
  const fixture = invoiceFixture({
    supplyAt: instantFromIso(`${tradingDate}T12:00:00+04:00`),
    issuedAt: instantFromIso(`${tradingDate}T12:30:00+04:00`),
    customerId,
    lines: [
      {
        descriptionEn: 'Asian massage, 60 minutes',
        quantity: 1,
        unitGrossFils: ASIAN_CHARGED_GROSS,
      },
    ],
  })
  const issued = await withUnitOfWork(sql, ACTOR, (uow) => issueInvoice(uow, fixture.input))
  invoiceId = issued.id
  await sql`
    insert into invoice_appointment (invoice_id, appointment_id, line_no)
    values (${invoiceId}::uuid, ${asianAppointmentId}::uuid, 1)
  `
  await sql`
    insert into payment (
      invoice_id, tender_no, tender_kind, posting_account_code, amount_fils, trading_date
    ) values (
      ${invoiceId}::uuid, 1, 'cash', ${ACCOUNTS.cashInDrawer as string},
      ${ASIAN_CHARGED_GROSS}, ${tradingDate}::date
    )
  `

  // The package: two sessions of the Arabic variant at 60,000 gross, one redeemed against the Arabic
  // appointment. The release is 30,000 gross, whose net is the figure every report must use.
  const saved = await withUnitOfWork(sql, ACTOR, (uow) =>
    savePackageTemplateVersion(uow, {
      templateKey,
      internalName: 'R-REP-04 margin course',
      publicDisplayName: 'R-REP-04 margin course',
      priceFils: 60_000,
      lines: [{ serviceVariantId: arabicVariantId, sessionCount: 2 }],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    }),
  )
  const version = await currentPackageTemplateVersion(sql, templateKey)
  if (version === null) throw new Error('the template version just saved cannot be read back')
  const saleMapping = packageSaleMapping({
    entryId: entryId(`je-rrep04-sale-${templateKey}`),
    tradingDate: localDate(tradingDate),
    customerId,
    templateVersionId: saved.versionId,
    priceGross: money(filsFrom(60_000)),
    lines: version.lines.map((line) => ({
      lineNo: line.lineNo,
      serviceVariantId: line.serviceVariantId,
      sessionCount: line.sessionCount,
      listGrossFils: line.listGrossFils,
    })),
    tenders: [{ kind: 'cash' as TenderKind, amount: money(filsFrom(60_000)) }],
    validityMonths: version.validityMonths,
    transferable: version.transferable,
    unredeemedBalancePolicy: version.unredeemedBalancePolicy,
    packageLabel: version.internalName,
  })
  const sold = await withUnitOfWork(sql, ACTOR, (uow) => sellPackage(uow, saleMapping.input))
  const [balance] = await sql<
    {
      id: string
      sessionsTotal: number
      sessionsRedeemed: number
      valueFils: string
      releasedFils: string
    }[]
  >`
    select id::text as id, sessions_total as "sessionsTotal", sessions_redeemed as "sessionsRedeemed",
           value_fils::text as "valueFils", released_fils::text as "releasedFils"
      from package_balance where package_sale_id = ${sold.saleId}::uuid
  `
  if (balance === undefined) throw new Error('the sale opened no balance')
  const redemption = assertPackageRedemptionMappingReconciles(
    packageRedemptionMapping({
      entryId: entryId(`je-rrep04-red-${templateKey}`),
      tradingDate: localDate(tradingDate),
      balance: {
        balanceId: balance.id,
        sessionsTotal: balance.sessionsTotal,
        sessionsRedeemed: balance.sessionsRedeemed,
        valueGross: money(filsFrom(Number(balance.valueFils))),
        releasedGross: money(filsFrom(Number(balance.releasedFils))),
      },
      appointmentId: arabicAppointmentId,
      units: 1,
      packageLabel: version.internalName,
    }),
  )
  await withUnitOfWork(sql, ACTOR, (uow) => redeemPackage(uow, redemption.input))
  redemptionNetFils = BigInt(redemption.input.releasedFils - redemption.input.vatFils)

  // **The catalogue price moves AFTER the redemption.** A new published version at a different price is
  // what makes the snapshot assertion a real one: a report reading the catalogue would now answer
  // 45,000 gross a session instead of 30,000.
  await withUnitOfWork(sql, ACTOR, (uow) =>
    savePackageTemplateVersion(uow, {
      templateKey,
      internalName: 'R-REP-04 margin course',
      publicDisplayName: 'R-REP-04 margin course',
      priceFils: 90_000,
      lines: [{ serviceVariantId: arabicVariantId, sessionCount: 2 }],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    }),
  )
}, 60_000)

afterAll(async () => {
  // Only rows this suite created, and only the ones a trigger permits removing (ADR 0050). The
  // invoice, its lines, the journal entries, the package sale and the redemption all refuse DELETE for
  // every role, which is why the trading date is searched for rather than fixed.
  if (sql !== undefined) {
    await sql`delete from appointment where booking_id = ${bookingId}::uuid`.catch(() => undefined)
    await sql`delete from booking where id = ${bookingId}::uuid`.catch(() => undefined)
    await sql.end({ timeout: 5 })
  }
})

// -------------------------------------------------------------------------------------------------
// 1. The two revenue sources
// -------------------------------------------------------------------------------------------------

describe('the row a delivery’s revenue is read from', () => {
  it('is invoice_line for a till sale and package_redemption for a redemption', async () => {
    const rows = await kpiDeliveryRows(sql, period)
    expect(rows.map((row) => row.appointmentId).sort()).toEqual(
      [asianAppointmentId, arabicAppointmentId].sort(),
    )

    const asian = rows.find((row) => row.appointmentId === asianAppointmentId)
    const arabic = rows.find((row) => row.appointmentId === arabicAppointmentId)
    if (asian === undefined || arabic === undefined) throw new Error('both deliveries must be read')

    // The till sale: the net CHARGED, from the document line, not the appointment's snapshot.
    expect(asian.invoiceId).toBe(invoiceId)
    expect(asian.lineNo).toBe(1)
    expect(asian.invoiceLineNetFils).toBe(BigInt(ASIAN_CHARGED_NET))
    expect(asian.invoiceLineGrossFils).toBe(BigInt(ASIAN_CHARGED_GROSS))
    expect(asian.snapshotGrossFils).toBe(BigInt(ASIAN_GROSS))
    expect(asian.redemptionId).toBeNull()
    expect(asian.tenderKinds).toEqual(['cash'])

    // The redemption: the gross released from 2050 when the session was delivered, and its net.
    expect(arabic.redemptionId).not.toBeNull()
    expect(arabic.redemptionGrossFils).toBe(30_000n)
    expect(arabic.redemptionNetFils).toBe(redemptionNetFils)
    expect(arabic.invoiceId).toBeNull()
    // A redemption settles no tender on this delivery: the money arrived with the package sale.
    expect(arabic.tenderKinds).toEqual([])
  })

  it('reports the snapshot even though the catalogue price has since moved', async () => {
    // The control: the catalogue now says something else, and it says it loudly.
    const version = await currentPackageTemplateVersion(sql, templateKey)
    expect(version?.priceFils).toBe(90_000)

    const rows = await kpiDeliveryRows(sql, period)
    const arabic = rows.find((row) => row.appointmentId === arabicAppointmentId)
    // 30,000 and not 45,000: the figure is the redemption's own, which is the acceptance line.
    expect(arabic?.redemptionGrossFils).toBe(30_000n)
    expect(arabic?.redemptionNetFils).toBe(redemptionNetFils)
  })

  it('a package redemption carries its price through the margin as the redemption basis', async () => {
    const rows = await kpiDeliveryRows(sql, period)
    const arabic = rows.find((row) => row.appointmentId === arabicAppointmentId)
    if (arabic?.redemptionId == null || arabic.redemptionNetFils === null) {
      throw new Error('the redemption must be read')
    }
    const unit = contributionMarginUnit({
      appointmentId: arabic.appointmentId,
      serviceVariantId: arabic.serviceVariantId,
      treatmentStyle: arabic.treatmentStyle,
      netPriceFils: arabic.redemptionNetFils,
      source: { basis: 'package_redemption', redemptionId: arabic.redemptionId },
      costs: [
        measuredCost('therapist', 9_000n, 'fixture: stated for this suite only'),
        measuredCost('consumables', 2_100n, 'fixture: stated for this suite only'),
        measuredCost('room_consumables', 600n, 'fixture: stated for this suite only'),
        paymentFeeComponent(arabic.tenderKinds as readonly TenderKind[]),
      ],
    })
    expect(unit.state).toBe('margin')
    if (unit.state !== 'margin') return
    expect(unit.netPriceBasis).toBe(`package_redemption ${arabic.redemptionId}`)
    // 28,571 - (9,000 + 2,100 + 600 + 0) = 16,871
    expect(unit.marginFils).toBe(16_871n)
  })
})

// -------------------------------------------------------------------------------------------------
// 2. Discount leakage, tied to invoice_line
// -------------------------------------------------------------------------------------------------

describe('discount leakage', () => {
  it('ties exactly to the invoice_line rows of the period', async () => {
    const rows = await kpiInvoiceLineRows(sql, period)
    const mine = rows.filter((row) => row.invoiceId === invoiceId)
    expect(mine).toHaveLength(1)
    const line = mine[0]
    if (line === undefined) throw new Error('the invoice line must be read')
    expect(line.chargedGrossFils).toBe(BigInt(ASIAN_CHARGED_GROSS))
    expect(line.listGrossFils).toBe(BigInt(ASIAN_GROSS))

    const outcome = discountLeakage(mine as readonly DiscountedInvoiceLine[])
    expect(outcome.state).toBe('value')
    if (outcome.state !== 'value') return
    expect(outcome.value.leakageGrossFils).toBe(TILL_LEAKAGE_GROSS)
    expect(outcome.value.drillsTo).toEqual([{ invoiceId, lineNo: 1 }])

    // And the figure IS the difference of the two snapshots, read back independently of the query.
    const [snapshot] = await sql<{ delta: string }[]>`
      select (a.gross_price_fils - il.line_gross_fils)::text as delta
        from invoice_line il
        join invoice_appointment ia
             on ia.invoice_id = il.invoice_id and ia.line_no = il.line_no
        join appointment a on a.id = ia.appointment_id
       where il.invoice_id = ${invoiceId}::uuid and il.line_no = 1
    `
    expect(BigInt(snapshot?.delta ?? '0')).toBe(outcome.value.leakageGrossFils)
  })

  it('states the coverage the figure cannot speak for', async () => {
    const coverage = await kpiDiscountCoverage(sql, period)
    expect(coverage.deliveries).toBe(2)
    // Neither fixture delivery was priced by a price list or a promotion, so the till figure covers all
    // of this period — which is the only state in which it is the whole discount given.
    expect(coverage.pricedByPriceList).toBe(0)
    expect(coverage.pricedByPromotion).toBe(0)
  })
})

// -------------------------------------------------------------------------------------------------
// 3. No-show cost
// -------------------------------------------------------------------------------------------------

describe('no-show cost', () => {
  it('drills to the no-show appointments and reports room minutes beside the money', async () => {
    const rows = await kpiNoShowRows(sql, period)
    expect(rows.map((row) => row.appointmentId)).toEqual([noShowAppointmentId])
    const outcome = noShowCost(rows as readonly NoShowAppointment[])
    expect(outcome.state).toBe('value')
    if (outcome.state !== 'value') return
    expect(outcome.value.costFils).toBe(BigInt(ASIAN_NET))
    // 60 minutes of treatment plus 20 of turnaround: the ROOM figure, which includes the clean-down.
    expect(outcome.value.lostRoomMinutes).toBe(80)
    expect(outcome.value.appointmentIds).toEqual([noShowAppointmentId])

    // The control: the delivered appointments are NOT in it, so the query reads the status and not the
    // day. Without this a `where` clause that had lost its status predicate would still pass.
    expect(outcome.value.appointmentIds).not.toContain(asianAppointmentId)
  })
})

// -------------------------------------------------------------------------------------------------
// 4. The therapist cost that does not exist, measured
// -------------------------------------------------------------------------------------------------

describe('the attributable therapist cost', () => {
  it('has no figure in this build, and the census says why rather than returning zero', async () => {
    const census = await kpiTherapistCostCensus(sql, { period })
    expect(census.deliveries).toBe(2)
    // Measured, not asserted: the commission module ships with no published version (Y9-commission),
    // so there are no lines to attribute — and "no commission because the module is off" must never be
    // reported as "no commission is due".
    expect(census.publishedCommissionRuleVersions).toBe(0)
    expect(census.deliveriesWithACommissionLine).toBe(0)
    // And the wage path: every delivering employee has basic_wage_fils null (Y8-staff).
    expect(census.unpricedEmployees).toBeGreaterThan(0)
    expect(census.rows.every((row) => row.employeeHasNoWageOnFile)).toBe(true)
  })

  it('makes the margin over real data not_attributable, and names what a zero would have claimed', async () => {
    const rows = await kpiDeliveryRows(sql, period)
    const units: ContributionMarginInput[] = rows
      .filter((row) => row.appointmentId === asianAppointmentId)
      .map((row) => {
        const netPriceFils = row.invoiceLineNetFils ?? 0n
        const costs: readonly CostComponent[] = [
          unattributableCost(
            'therapist',
            'no commission rule version is published and basic_wage_fils is null for every employee',
          ),
          unattributableCost(
            'consumables',
            'no per-treatment consumable usage is recorded anywhere',
          ),
          unattributableCost('room_consumables', 'no room cost is recorded anywhere'),
          paymentFeeComponent(row.tenderKinds as readonly TenderKind[]),
        ]
        return {
          appointmentId: row.appointmentId,
          serviceVariantId: row.serviceVariantId,
          treatmentStyle: row.treatmentStyle,
          netPriceFils,
          source: {
            basis: 'invoice_line' as const,
            invoiceId: row.invoiceId ?? '',
            lineNo: row.lineNo ?? 1,
          },
          costs,
        }
      })
    const result = serviceContributionMargin({
      serviceVariantId: asianVariantId,
      periodId: period.periodId,
      units,
    })
    expect(result.state).toBe('not_attributable')
    if (result.state !== 'not_attributable') return
    expect(result.missing).toEqual(['therapist', 'consumables', 'room_consumables'])
    expect(result.openQuestionIds).toContain('Y9-unit-cost-basis')
    // The payment fee IS known for this delivery, and it is known to be nil: cash, no acquirer.
    expect(result.openQuestionIds).not.toContain('Y7-card-fee')
    // What a zero for the three unknowns would have reported: the whole of net revenue as margin, on
    // the screen somebody prices from.
    expect(result.netRevenueFils - result.attributedCostFils).toBe(BigInt(ASIAN_CHARGED_NET))
  })
})

// -------------------------------------------------------------------------------------------------
// 5. The bag, and the two statements of its shape
// -------------------------------------------------------------------------------------------------

describe('the period figures bag', () => {
  it('is the same shape as core’s PeriodFigures, and the annotation is what holds it', async () => {
    // The check that holds a second statement of a type equal to the first. `packages/db` may not
    // import `packages/core` (ADR 0001), so the two interfaces are written twice — and this annotation
    // is a `pnpm typecheck` failure the moment either side renames or drops a field.
    const figures: PeriodFigures = await kpiPeriodFigures(sql, {
      period,
      accounts: {
        retailRevenue: ACCOUNTS.retailRevenue as string,
        therapistWages: ACCOUNTS.therapistWages as string,
        staffCommission: ACCOUNTS.commissionExpense as string,
        gratuityExpense: ACCOUNTS.gratuityExpense as string,
        annualLeaveExpense: ACCOUNTS.leaveExpense as string,
        tipsPayable: ACCOUNTS.tipsPayable as string,
      },
      rebookingWindowDays: 30,
    })
    expect(figures.periodId).toBe(period.periodId)
    expect(figures.invoiceCount).toBe(1)
    expect(figures.invoiceNetFils).toBe(BigInt(ASIAN_CHARGED_NET))
    expect(figures.creditNoteNetFils).toBe(0n)
    expect(figures.netRevenueFils).toBe(BigInt(ASIAN_CHARGED_NET))
    // Nothing in this build can sell a retail product, so the mechanism reads a true zero.
    expect(figures.invoicesCarryingRetail).toBe(0)
    expect(figures.noShows).toHaveLength(1)
    // The two figures nothing in this build can supply, null rather than zero (ADR 0070).
    expect(figures.variableCostFils).toBeNull()
    expect(figures.fixedCostFils).toBeNull()
    // And the field set is the same in both directions: a figure db reads and core never looks at is a
    // query nobody needs, which this catches.
    const coreFields = [
      'periodId',
      'invoiceNetFils',
      'invoiceCount',
      'creditNoteNetFils',
      'invoicesCarryingRetail',
      'deliveredAppointments',
      'rebookedWithinWindow',
      'rebookingWindowDays',
      'noShows',
      'discountedLines',
      'labour',
      'netRevenueFils',
      'tipsCollectedFils',
      'variableCostFils',
      'fixedCostFils',
    ]
    expect(Object.keys(figures).sort()).toEqual([...coreFields].sort())
  })

  it('refuses a rebooking window it was not given, and reads the window it was', async () => {
    await expect(kpiRebooking(sql, { period, windowDays: 0 })).rejects.toThrow(
      /required and has no default/,
    )
    const rebooking = await kpiRebooking(sql, { period, windowDays: 30 })
    expect(rebooking.deliveredAppointments).toBe(2)
    expect(rebooking.windowDays).toBe(30)
    // The booking being delivered was created before the treatment, so it is not a rebooking of itself.
    expect(rebooking.rebookedWithinWindow).toBe(0)
  })

  it('counts the documents of the period and nothing else', async () => {
    const counts = await kpiDocumentCounts(sql, {
      period,
      retailRevenueAccountCode: ACCOUNTS.retailRevenue as string,
    })
    expect(counts.invoiceCount).toBe(1)
    expect(counts.creditNoteCount).toBe(0)

    // The control, and it is what makes the count above a statement about the WINDOW rather than about
    // the database holding exactly one invoice: the day after this suite's own is inside the reserved
    // span, is written to by nothing (the search takes the FIRST free day, so later days are untouched
    // until the next run claims one), and must hold none of it. The next date is computed by PostgreSQL
    // because the end of a month is date arithmetic with one correct implementation.
    const [next] = await sql<{ day: string }[]>`
      select (${tradingDate}::date + 1)::text as day
    `
    const neighbourDay = next?.day ?? ''
    expect(neighbourDay).not.toBe(tradingDate)
    const neighbour = await kpiDocumentCounts(sql, {
      period: { periodId: 'the day after', startsOn: neighbourDay, endsOn: neighbourDay },
      retailRevenueAccountCode: ACCOUNTS.retailRevenue as string,
    })
    expect(neighbour.invoiceCount).toBe(0)
    expect(
      await kpiNoShowRows(sql, { ...period, startsOn: neighbourDay, endsOn: neighbourDay }),
    ).toEqual([])
  })
})
