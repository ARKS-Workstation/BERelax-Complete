import {
  FORECAST_SHOW_UP_RATE_BP_SETTING_KEY,
  getDefinition,
  PROVISIONAL_SHOW_UP_RATE_BP,
  provisionalSettings,
  SEASONALITY_SUMMER_MONTHS_SETTING_KEY,
  SHOW_UP_RATE_WHOLE_BP,
} from '@berelax/config'
import {
  type CashForecast,
  cashForecast,
  EMPTY_KPI_INPUT,
  FORECAST_WEEKS,
  type ForecastCostOccurrence,
  forecastBytes,
  forecastFindings,
  localDate,
  MINIMUM_SEASONALITY_OCCURRENCES,
  OBSERVANCE_IMPACT_SIDES,
  observanceImpact,
  type PayrollCensus,
  payrollFromCensus,
  publishedIndex,
  REVPARH_REVENUE_PARTITION,
  SEASONALITY_BUCKETS,
  type SeasonalityInput,
  STANDARD_SPA_STATEMENT_LAYOUT,
  seasonalityIndex,
  seasonalityModel,
  WHOLE_IN_BASIS_POINTS,
} from '@berelax/core'
import {
  createConnection,
  FORWARD_APPOINTMENT_STATUSES,
  type ForecastWindow,
  forecastCashPosition,
  forwardBookingRows,
  payrollForecastCensus,
  recurringCostSchedule,
  type Sql,
  seasonalityPeriod,
  statementBytes,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_TODAY } from './clock.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * R-REP-06 — the 13-week cash forecast and the seasonality model against a real database.
 *
 * It lives in `@berelax/fixtures` because the arithmetic is `@berelax/core`'s and the rows are
 * `@berelax/db`'s, and fixtures is the one package allowed to depend on both: `db` must never import
 * `core` (ADR 0001). That is R-REP-02's and R-REP-04's arrangement one subject along.
 *
 * # What is proved here and nowhere else
 *
 *   1. **A Ramadan hours override changes the seasonality index with no code change.** The suite writes a
 *      `premises_hours_override` row, regenerates `business_day` over its own reserved span, refreshes
 *      `reporting.dim_date`, and reads a DIFFERENT index out of unchanged code. That is R-REP-06's third
 *      acceptance line, and it is the only claim in this unit that cannot be made by a pure test: the
 *      chain `premises_hours` → `business_day.duration_seconds` → `dim_date.open_minutes` → the RevPARH
 *      denominator exists only in the database.
 *   2. **A lunar-date holiday reports its impact twice.** Three `reporting.calendar_observance` rows the
 *      suite inserts — one Gregorian and settled, one lunar and provisional, one Ramadan range — and the
 *      two sides of `observanceImpact` are read back as different figures with no field that adds them.
 *      The database's own refusal of a lunar row presented as settled is probed as well, because the pure
 *      refusal is only safe to rely on while that constraint holds.
 *   3. **Every seasonality bucket answers `no_data` over this build's own history, MEASURED.** Not
 *      asserted: `reporting.calendar_observance` ships empty (`Y9-holiday-calendar`) and the fixture salon
 *      has 120 days of history, so no bucket has two occurrences. R-REP-04's arrangement for the
 *      contribution margin, applied to a seasonality index.
 *   4. **The payroll line refuses over this build's own data**, for two independent reasons read from the
 *      database rather than hard-coded: no column records a pay date (`Y8-payroll-date`) and every
 *      employment record's `basic_wage_fils` is NULL (`Y8-staff`).
 *   5. **Three pairs of facts that are stated twice are held equal here**, which is the only place each
 *      pair can be imported at once: `forecastBytes` against `statementBytes`, core's `PayrollCensus`
 *      against db's `PayrollForecastCensus`, and `SHOW_UP_RATE_WHOLE_BP` against `WHOLE_IN_BASIS_POINTS`.
 *
 * # Why the span is searched for rather than fixed, and what this suite does mutate
 *
 * The forward bookings are `appointment` rows, which this suite CAN delete, and its observances and hours
 * override are its own rows too. What it cannot scope is `reporting.dim_date`: it is a materialised view
 * over the whole of `business_day`, so refreshing it is the only way to make the suite's own trading dates
 * visible to the reporting schema at all, and the refresh necessarily rebuilds every row. That is safe and
 * is not a deletion — `reporting.refresh()` is the schema's only writer by construction (ADR 0060), the
 * view states no fact of its own, and `afterAll` removes the suite's `business_day` rows and refreshes
 * again, which puts the view back exactly where it was. Nothing is truncated and no `delete` here is
 * unqualified, so there is no `suite-table-declarations.ts` entry to make (ADR 0050).
 *
 * The span is a year nothing else claims, for `contribution-margin.itest.ts`' reason one subject along: a
 * fixed date would read two runs' rows as one run's figures, and the brief requires this suite to run
 * twice.
 */

/** The whole of 2081: no suite, fixture or gate anywhere in the repository uses a date in it. */
const RESERVED_FROM = '2081-01-01'
const RESERVED_TO = '2081-12-31'

/** Fourteen consecutive trading dates: ten of baseline and the two two-day Ramadan runs inside them. */
const SPAN_DAYS = 14

/** 11:00 to 02:00, which is what `premises_hours` holds: 900 minutes. */
const WEEKLY_OPEN_MINUTES = 900
/** 14:00 to 02:00, a reduced Ramadan schedule: 720 minutes. */
const RAMADAN_OPEN_MINUTES = 720

let sql: Sql
let span: readonly string[]
let window: ForecastWindow
let bookingId = ''
let customerId = ''
let roomId = ''
let employeeId = ''
let variantId = ''
const appointmentIds: string[] = []
const observanceIds: string[] = []
const journalEntryIds: string[] = []
let overrideId = ''

const dayAt = (at: number): string => {
  const date = span[at]
  if (date === undefined) throw new Error(`day ${at} is outside the reserved span`)
  return date
}

/**
 * The first run of `SPAN_DAYS` consecutive dates in the reserved year with no `business_day` row.
 *
 * Searched rather than fixed for the reason this file's header gives. `::date::text` and not `::text`,
 * which cost `contribution-margin.itest.ts` a run: `generate_series` over an interval returns a
 * TIMESTAMP, so a plain cast gives `2081-02-01 00:00:00+00` and every date literal built from it is
 * malformed — with the error naming a timestamp column three statements later.
 */
async function virginSpan(): Promise<readonly string[]> {
  const rows = await sql<{ day: string }[]>`
    select d::date::text as day
      from generate_series(${RESERVED_FROM}::date, ${RESERVED_TO}::date, interval '1 day') d
     where not exists (
       select 1 from business_day bd
        where bd.trading_date between d::date and d::date + ${SPAN_DAYS - 1}::integer
     )
     order by d
     limit 1
  `
  const first = rows[0]?.day
  if (first === undefined) {
    throw new Error(
      `no run of ${SPAN_DAYS} free trading dates remains between ${RESERVED_FROM} and ${RESERVED_TO}. ` +
        'Widen the reserved span rather than reusing one: this suite removes its own business_day rows, ' +
        'so a full year means an earlier run died before its afterAll.',
    )
  }
  const dates = await sql<{ day: string }[]>`
    select d::date::text as day
      from generate_series(${first}::date, ${first}::date + ${SPAN_DAYS - 1}::integer, interval '1 day') d
     order by d
  `
  return dates.map((row) => row.day)
}

/** Materialises the suite's trading dates from the hours that govern them, as the generator would. */
async function generateSpanBusinessDays(): Promise<void> {
  // One statement, and the hours come from `premises_hours_override` where one covers the date and from
  // `premises_hours` otherwise — which is the rule `horizonRows` applies in `packages/core` and the whole
  // reason this suite can change the index by writing a row. Written in SQL here rather than through
  // `generateBusinessDays` because that function takes rows already computed and this suite's subject is
  // where the rows come FROM.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    select d::date,
           (d::date + coalesce(o.open_time, w.open_time)) at time zone 'Asia/Dubai',
           (d::date + 1 + coalesce(o.close_time, w.close_time)) at time zone 'Asia/Dubai',
           case when o.id is null then 'weekly' else 'override' end
      from generate_series(${dayAt(0)}::date, ${dayAt(SPAN_DAYS - 1)}::date, interval '1 day') d
      join premises_hours w
        on w.day_of_week = extract(dow from d::date)::smallint
      left join premises_hours_override o
        on d::date between o.starts_on and o.ends_on
       and (o.day_of_week is null or o.day_of_week = extract(dow from d::date)::smallint)
     where not w.is_closed
    on conflict (trading_date) do update
       set opens_at  = excluded.opens_at,
           closes_at = excluded.closes_at,
           source    = excluded.source
  `
  // The reporting schema's only writer (ADR 0060). `dim_date` has to be refreshed for the suite's own
  // trading dates to exist in it at all, and the refresh is CONCURRENT so no reader blocks.
  await sql`select * from reporting.refresh('dim_date', 'on_demand')`
}

const seasonalityInputFrom = (
  period: Awaited<ReturnType<typeof seasonalityPeriod>>,
  summerMonths: readonly number[] = [7, 8],
): SeasonalityInput => ({
  days: period.days.map((day) => ({ ...day, businessDay: localDate(day.businessDay) })),
  kpiInput: {
    // Five datasets R-REP-05 added and the forecast reads none of: empty, not absent.
    ...EMPTY_KPI_INPUT,
    businessDays: period.days.map((day) => ({
      businessDay: localDate(day.businessDay),
      openMinutes: day.openMinutes,
    })),
    roomDays: period.roomDays.map((row) => ({
      businessDay: localDate(row.businessDay),
      roomId: row.roomId,
    })),
    roomClosures: period.roomClosures.map((row) => ({
      businessDay: localDate(row.businessDay),
      roomId: row.roomId,
      fromMinuteAfterOpen: row.fromMinuteAfterOpen,
      toMinuteAfterOpen: row.toMinuteAfterOpen,
    })),
    appointments: [],
    rosteredShifts: [],
    revenueLines: period.revenueLines.map((row) => ({
      businessDay: localDate(row.businessDay),
      accountCode: row.accountCode as (typeof REVPARH_REVENUE_PARTITION.included)[number],
      netFils: row.netFils,
    })),
  },
  summerMonths,
  minimumOccurrences: MINIMUM_SEASONALITY_OCCURRENCES,
})

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 4 })
  span = await virginSpan()
  window = { from: dayAt(0), to: dayAt(SPAN_DAYS - 1) }

  const [customer] = await sql<{ id: string }[]>`
    select id::text as id from customer order by id limit 1
  `
  const [room] = await sql<{ id: string }[]>`select id::text as id from rooms order by id limit 1`
  const [employee] = await sql<{ id: string }[]>`
    select id::text as id from employee order by id limit 1
  `
  const [variant] = await sql<{ id: string }[]>`
    select id::text as id from service_variant order by id limit 1
  `
  customerId = customer?.id ?? ''
  roomId = room?.id ?? ''
  employeeId = employee?.id ?? ''
  variantId = variant?.id ?? ''
  if (!customerId || !roomId || !employeeId || !variantId) {
    throw new Error('the fixture salon is not seeded: run `pnpm seed` (brief rule 24)')
  }

  await generateSpanBusinessDays()

  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${customerId}::uuid, 'walk_in', 'R-REP-06 forecast itest')
    returning id::text as id
  `
  bookingId = booking?.id ?? ''

  // Two forward bookings in the first forecast week, at snapshotted grosses that make the show-up
  // arithmetic checkable by hand: 1,000,000 + 500,000 = 1,500,000 fils, so 9,000 bp is 1,350,000.
  for (const [at, gross, hour] of [
    [0, 1_000_000, 12],
    [1, 500_000, 14],
  ] as const) {
    const [row] = await sql<{ id: string }[]>`
      insert into appointment (
        booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
        delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
        gross_price_fils, net_fils, vat_fils, vat_rate_bp
      ) values (
        ${bookingId}::uuid, ${dayAt(at)}::date, ${variantId}::uuid, 'solo'::service_shape,
        ${employeeId}::uuid, ${roomId}::uuid,
        tstzrange(
          (${dayAt(at)}::date + make_time(${hour}, 0, 0)) at time zone 'Asia/Dubai',
          (${dayAt(at)}::date + make_time(${hour + 1}, 0, 0)) at time zone 'Asia/Dubai',
          '[)'
        ),
        'confirmed'::appointment_status,
        gen_random_uuid(), 1, 20, 10,
        ${gross}, ${Math.round((gross / 105) * 100)},
        ${gross - Math.round((gross / 105) * 100)}, 500
      )
      returning id::text as id
    `
    if (row?.id !== undefined) appointmentIds.push(row.id)
  }
}, 60_000)

afterAll(async () => {
  if (sql === undefined) return
  // Only rows this suite created. `appointment` and `booking` permit DELETE; the observances, the hours
  // override and the `business_day` rows are the suite's own. `reporting.refresh_run` is append-only
  // (ZY184) and is NOT touched: its rows are evidence that a refresh happened, and this suite asserts
  // deltas rather than totals over it (brief rule 9).
  for (const id of appointmentIds) {
    await sql`delete from appointment where id = ${id}::uuid`.catch(() => undefined)
  }
  if (bookingId) {
    await sql`delete from booking where id = ${bookingId}::uuid`.catch(() => undefined)
  }
  for (const id of observanceIds) {
    await sql`delete from reporting.calendar_observance where id = ${id}::uuid`.catch(
      () => undefined,
    )
  }
  // The journal refuses DELETE for every role (ZL001, ADR 0017), so the attempt is expected to fail and
  // is made anyway rather than silently skipped: the entries are dated in a reserved year nothing else
  // reads, and the `catch` is what records that the refusal is the reason they stay. The suite's figures
  // are scoped to its own span, so a second run reads its own rows and not two runs' added together.
  for (const entryId of journalEntryIds) {
    await sql`delete from journal_line where entry_id = ${entryId}`.catch(() => undefined)
    await sql`delete from journal_entry where entry_id = ${entryId}`.catch(() => undefined)
  }
  if (overrideId) {
    await sql`delete from premises_hours_override where id = ${overrideId}::uuid`.catch(
      () => undefined,
    )
  }
  if (span !== undefined && span.length > 0) {
    await sql`
      delete from business_day
       where trading_date between ${dayAt(0)}::date and ${dayAt(SPAN_DAYS - 1)}::date
    `.catch(() => undefined)
    // And the view back to what it was. A refresh here is what makes the suite re-runnable: without it
    // `dim_date` would hold rows for trading dates that no longer exist, and the next run's
    // `assert_business_day_keys` would refuse the refresh naming them.
    await sql`select * from reporting.refresh('dim_date', 'on_demand')`.catch(() => undefined)
  }
  await sql.end({ timeout: 5 })
}, 60_000)

// --- the two facts that are stated twice ---------------------------------------------------------

describe('the pairs this file is the only place that can be held equal', () => {
  it('holds forecastBytes equal to statementBytes, over a real forecast', () => {
    // A second statement of one canonical form, unavoidable because `statementBytes` is in `packages/db`
    // and `packages/core` may not import it (ADR 0001). Held equal here, which is the one package that
    // can import both.
    const forecast = cashForecast({
      asOf: FIXTURE_TODAY,
      openingCashFils: 1_234_567n,
      cashAccountCodes: STANDARD_SPA_STATEMENT_LAYOUT.cashAccountCodes,
      recurringCosts: [],
      forwardBookings: [],
      showUpRate: {
        rateBp: PROVISIONAL_SHOW_UP_RATE_BP,
        settingKey: FORECAST_SHOW_UP_RATE_BP_SETTING_KEY,
        provisional: { openQuestionId: 'Y9-windows', note: 'held-equal fixture' },
      },
      payroll: { state: 'scheduled', occurrences: [] },
    })
    expect(forecastBytes(forecast)).toBe(statementBytes(forecast))
    // And the control: a canonicaliser that returned a constant would also satisfy the equality, so the
    // bytes have to carry the figures.
    expect(forecastBytes(forecast)).toContain('1234567')
  })

  it('holds the registry bound equal to the whole in basis points', () => {
    // `@berelax/config` depends on `@berelax/shared` alone, so it cannot reach either of core's two
    // statements of 10,000. A third statement arrives with this assertion in the same commit.
    expect(SHOW_UP_RATE_WHOLE_BP).toBe(Number(WHOLE_IN_BASIS_POINTS))
  })

  it('holds core PayrollCensus equal to the db census, in both directions', async () => {
    const census = await payrollForecastCensus(sql, window)
    // The type annotation is half of it: a field renamed in `packages/db` is a `pnpm typecheck` failure
    // here. The field-set comparison is the other half, because a field the db returns and `core` never
    // looks at would typecheck.
    const asCore: PayrollCensus = census
    expect(asCore.activeEmploymentRecords).toBe(census.activeEmploymentRecords)
    const coreFields = [
      'activeEmploymentRecords',
      'aPayDateIsRecordedAnywhere',
      'payrollRunsOverlappingTheWindow',
      'pricedEmployees',
      'unpricedEmployeeIds',
    ]
    expect(Object.keys(census).sort()).toEqual([...coreFields, 'window'].sort())
  })
})

// --- the settings ---------------------------------------------------------------------------------

describe('the show-up rate is a settings-registry value and is flagged provisional', () => {
  it('appears on the Unconfirmed Assumptions query with its open question', () => {
    const panel = provisionalSettings()
    const entry = panel.find((row) => row.key === FORECAST_SHOW_UP_RATE_BP_SETTING_KEY)
    expect(entry).toBeDefined()
    expect(entry?.openQuestionId).toBe('Y9-windows')
    expect(entry?.defaultValue).toBe(PROVISIONAL_SHOW_UP_RATE_BP)
    // And the summer window, which is the other figure this unit had to assume.
    const summer = panel.find((row) => row.key === SEASONALITY_SUMMER_MONTHS_SETTING_KEY)
    expect(summer?.openQuestionId).toBe('Y9-summer-window')
    expect(summer?.defaultValue).toEqual([7, 8])
  })

  it('is stored in app_setting with its provisional marker, as the seed writes it', async () => {
    const rows = await sql<{ isProvisional: boolean; openQuestionId: string | null }[]>`
      select is_provisional as "isProvisional", open_question_id as "openQuestionId"
        from app_setting
       where key = ${FORECAST_SHOW_UP_RATE_BP_SETTING_KEY}
    `
    // A freshly migrated database has no row and `readSetting` falls back to the registry default, which
    // is why the absence is tolerated and the presence is checked. Either way the figure a forecast uses
    // carries the marker, because the marker comes from the DEFINITION and not from the row.
    if (rows.length > 0) {
      expect(rows[0]?.isProvisional).toBe(true)
      expect(rows[0]?.openQuestionId).toBe('Y9-windows')
    }
    expect(getDefinition(FORECAST_SHOW_UP_RATE_BP_SETTING_KEY).provisional?.openQuestionId).toBe(
      'Y9-windows',
    )
  })
})

// --- the forward bookings ------------------------------------------------------------------------

describe('forward bookings contribute their snapshotted gross times the show-up rate', () => {
  it('reads the two bookings at the gross each was taken at, and nothing else in the window', async () => {
    const bookings = await forwardBookingRows(sql, window)
    expect(bookings.rows.map((row) => row.appointmentId).sort()).toEqual([...appointmentIds].sort())
    expect(bookings.grossFils).toBe(1_500_000n)
    expect(bookings.bookingsOffTheTradingCalendar).toBe(0)
    // Every status read is a FORWARD one: a status counted as both a delivery and a forecast would be
    // revenue reported twice, and R-REP-04 reads `completed`.
    for (const row of bookings.rows) expect(FORWARD_APPOINTMENT_STATUSES).toContain(row.status)
    expect(FORWARD_APPOINTMENT_STATUSES).not.toContain('completed')
  })

  /**
   * Hand-computed: (1,000,000 + 500,000) × 9,000 ÷ 10,000 = 1,350,000 fils, rounded once for the week.
   *
   * And the control, which is what makes the assertion about the RATE rather than about the sum: the same
   * bookings at 10,000 basis points give the whole 1,500,000, and at 0 they give nothing — so a figure
   * that ignored the rate would pass one of the three and fail the other two.
   */
  it('applies the rate once per week, against hand-computed figures', async () => {
    const bookings = await forwardBookingRows(sql, window)
    const build = (rateBp: number): CashForecast =>
      cashForecast({
        asOf: localDate(dayAt(0)),
        openingCashFils: 0n,
        cashAccountCodes: STANDARD_SPA_STATEMENT_LAYOUT.cashAccountCodes,
        recurringCosts: [],
        forwardBookings: bookings.rows.map((row) => ({
          appointmentId: row.appointmentId,
          tradingDate: localDate(row.tradingDate),
          snapshotGrossFils: row.snapshotGrossFils,
        })),
        showUpRate: {
          rateBp,
          settingKey: FORECAST_SHOW_UP_RATE_BP_SETTING_KEY,
          provisional: { openQuestionId: 'Y9-windows', note: 'itest' },
        },
        payroll: { state: 'scheduled', occurrences: [] },
      })
    const week1 = (forecast: CashForecast) =>
      forecast.weeks[0]?.lines.find((line) => line.lineId === 'forward_bookings')?.figure
    const provisional = week1(build(PROVISIONAL_SHOW_UP_RATE_BP))
    expect(provisional?.state).toBe('projected')
    expect(provisional && 'fils' in provisional ? provisional.fils : null).toBe(1_350_000n)
    const whole = week1(build(SHOW_UP_RATE_WHOLE_BP))
    expect(whole && 'fils' in whole ? whole.fils : null).toBe(1_500_000n)
    const none = week1(build(0))
    expect(none && 'fils' in none ? none.fils : null).toBe(0n)
    // Both bookings drill from the line, so the figure is checkable against the rows it came from.
    const line = build(PROVISIONAL_SHOW_UP_RATE_BP).weeks[0]?.lines.find(
      (entry) => entry.lineId === 'forward_bookings',
    )
    expect([...(line?.drillsTo ?? [])].sort()).toEqual([...appointmentIds].sort())
  })
})

// --- the opening position -------------------------------------------------------------------------

describe('the opening cash position', () => {
  it('is the balance sheet cash line, read from the ledger and never clamped', async () => {
    const cash = await forecastCashPosition(
      sql,
      FIXTURE_TODAY,
      STANDARD_SPA_STATEMENT_LAYOUT.cashAccountCodes,
    )
    // The seeded ledger's cash position is whatever the fixture's trading produced; what is asserted is
    // that the figure is the sum of its own per-account parts, which is what makes it drillable.
    expect(cash.fils).toBe(cash.byAccount.reduce((total, row) => total + row.fils, 0n))
    expect(cash.asOf).toBe(FIXTURE_TODAY)
    // An account the cash set names with no posting is REPORTED rather than silently matched: a set of
    // three that matched one would give a plausible figure over a third of the business's money.
    for (const code of cash.accountsWithNoPostings) {
      expect(STANDARD_SPA_STATEMENT_LAYOUT.cashAccountCodes as readonly string[]).toContain(code)
    }
  })

  it('refuses a cash position over no accounts, which would be an empty bank account', async () => {
    await expect(forecastCashPosition(sql, FIXTURE_TODAY, [])).rejects.toThrow(
      /cash position over no/,
    )
  })
})

// --- the payroll refusal, MEASURED ----------------------------------------------------------------

describe("payroll over this build's own data", () => {
  it('refuses, for two independent reasons both read from the database', async () => {
    const census = await payrollForecastCensus(sql, window)
    // The seed creates employment records with `basic_wage_fils` NULL (Y8-staff), and nothing in the
    // schema records a pay date (Y8-payroll-date). Both are MEASURED here rather than asserted as
    // constants, so the day either is answered this case changes rather than lies.
    //
    // `pricedEmployees` is NOT required to be nought, and the reason is the one `pnpm verify` taught this
    // case: every suite runs against one database, so an HR suite that records a wage for its own
    // employee makes a `toBe(0)` here fail while nothing about this unit changed — it read 13 on the
    // integrating run and 0 in a worktree. What the refusal actually rests on is that SOMEBODY is
    // unpriced: one employee nobody has priced makes the wage bill unknowable, which is ADR 0070's whole
    // argument, and a `0` for the rest would be the free rota it refuses. So the claim is the partition
    // identity — every active record is priced or named as unpriced, with at least one of the latter.
    expect(census.activeEmploymentRecords).toBeGreaterThan(0)
    expect(census.aPayDateIsRecordedAnywhere).toBe(false)
    expect(census.unpricedEmployeeIds.length).toBeGreaterThan(0)
    expect(census.pricedEmployees + census.unpricedEmployeeIds.length).toBe(
      census.activeEmploymentRecords,
    )
    expect(new Set(census.unpricedEmployeeIds).size).toBe(census.unpricedEmployeeIds.length)

    const payroll = payrollFromCensus(census)
    expect(payroll.state).toBe('unattributable')
    if (payroll.state !== 'unattributable') throw new Error('expected a refusal')
    expect(payroll.openQuestionIds).toEqual(['Y8-payroll-date', 'Y8-staff'])
    expect(payroll.missing[0]).toBe('a column recording the date payroll cash leaves the bank')
  })

  it('makes every weekly closing figure a refusal and not a smaller number', async () => {
    const census = await payrollForecastCensus(sql, window)
    const bookings = await forwardBookingRows(sql, window)
    const forecast = cashForecast({
      asOf: localDate(dayAt(0)),
      openingCashFils: 500_000n,
      cashAccountCodes: STANDARD_SPA_STATEMENT_LAYOUT.cashAccountCodes,
      recurringCosts: [],
      forwardBookings: bookings.rows.map((row) => ({
        appointmentId: row.appointmentId,
        tradingDate: localDate(row.tradingDate),
        snapshotGrossFils: row.snapshotGrossFils,
      })),
      showUpRate: {
        rateBp: PROVISIONAL_SHOW_UP_RATE_BP,
        settingKey: FORECAST_SHOW_UP_RATE_BP_SETTING_KEY,
        provisional: { openQuestionId: 'Y9-windows', note: 'itest' },
      },
      payroll: payrollFromCensus(census),
    })
    expect(forecast.weeks).toHaveLength(FORECAST_WEEKS)
    for (const week of forecast.weeks) {
      expect(week.closingCash.state).toBe('unattributable')
      expect('fils' in week.closingCash).toBe(false)
    }
    // The inflow side still reports, so the artefact says what it does know.
    const inflows = forecast.total.totalInflows
    expect(inflows.state).toBe('projected')
    expect('fils' in inflows ? inflows.fils : null).toBe(1_350_000n)
    // And the artefact still articulates: every identity holds over the figures it has.
    expect(forecastFindings(forecast)).toEqual([])
  })
})

// --- the recurring costs --------------------------------------------------------------------------

describe('the recurring cost side comes from the definitions and not the generated instances', () => {
  it('reads the register through the one SQL function and classifies each occurrence by its own kind', async () => {
    const rows = await recurringCostSchedule(sql, dayAt(0), 4)
    const occurrences: ForecastCostOccurrence[] = rows.map((row) => ({
      code: row.code,
      dueDate: localDate(row.dueDate),
      expectedFils: row.expectedFils,
      costKind: row.costKind === 'variable' ? 'variable' : 'fixed',
    }))
    // The seeded register's contents are B-FIN's, so what is asserted is the SHAPE: every occurrence
    // carries a positive expectation and a kind the forecast recognises, which is what stops a zero
    // reaching a cash figure as a free contract.
    for (const occurrence of occurrences) {
      expect(occurrence.expectedFils > 0n).toBe(true)
      expect(['fixed', 'variable']).toContain(occurrence.costKind)
    }
    expect(rows.every((row) => row.dueDate >= dayAt(0))).toBe(true)
  })
})

// --- the seasonality model over this build's own history ------------------------------------------

describe("the seasonality model over this build's own history", () => {
  it('answers no_data for every bucket, measured rather than asserted', async () => {
    // The fixture salon has about 120 days of history and `reporting.calendar_observance` ships EMPTY
    // (Y9-holiday-calendar), so no bucket can have two separated occurrences. This case MEASURES that,
    // which is the difference between "the mechanism refuses" and "we decided it refuses".
    const [historyFrom] = await sql<{ day: string }[]>`
      select min(business_day)::text as day from reporting.dim_date
       where business_day <= ${FIXTURE_TODAY}::date
    `
    const period = await seasonalityPeriod(
      sql,
      { from: historyFrom?.day ?? FIXTURE_TODAY, to: FIXTURE_TODAY },
      [...REVPARH_REVENUE_PARTITION.included],
    )
    // The control for "measured": the trading days and the room-days ARE there, so the refusal below is
    // about the occurrence count and not about a read that returned nothing.
    expect(period.days.length).toBeGreaterThan(30)
    expect(period.roomDays.length).toBeGreaterThan(period.days.length)
    // And the measured reason: `reporting.calendar_observance` ships EMPTY (Y9-holiday-calendar), so not
    // one of the fixture's trading days carries an observance flag. That is the fact the refusal rests
    // on, read rather than assumed.
    expect(period.days.filter((day) => day.isRamadan || day.isPublicHoliday)).toEqual([])
    const [observances] = await sql<{ rows: string }[]>`
      select count(*)::text as rows from reporting.calendar_observance
       where starts_on <= ${FIXTURE_TODAY}::date
    `
    expect(observances?.rows).toBe('0')

    const model = seasonalityModel(seasonalityInputFrom(period))
    expect(model.map((entry) => entry.bucket)).toEqual([...SEASONALITY_BUCKETS])
    for (const entry of model) {
      expect(entry.outcome.state).toBe('no_data')
      if (entry.outcome.state !== 'no_data') continue
      expect(entry.outcome.missingFigures[0]).toMatch(
        new RegExp(`^${entry.bucket}: \\d+ of ${MINIMUM_SEASONALITY_OCCURRENCES} occurrences`),
      )
    }
    // A second measured fact, worth recording because it would otherwise be mistaken for this unit's
    // doing: the SEED posts no journal entry at all — it creates appointments and invoices and posts
    // nothing — so on a freshly seeded database the numerator here is empty for any observance the
    // fixture could have. It is reported rather than required to be empty, because `pnpm verify` runs
    // every suite against ONE database and a till suite's six revenue lines are not this model changing
    // its answer: the refusal above rests on the OCCURRENCE count, which the loop measures, and not on an
    // empty numerator. What is held instead is that the read is about the right rows — every line it
    // returned is on an included account and inside the window — which an empty-set assertion could
    // never have said.
    const [lines] = await sql<{ rows: string }[]>`
      select count(*)::text as rows from journal_line l
        join journal_entry e on e.entry_id = l.entry_id
       where e.entry_date <= ${FIXTURE_TODAY}::date
    `
    expect(Number(lines?.rows)).toBeGreaterThanOrEqual(period.revenueLines.length)
    for (const line of period.revenueLines) {
      expect(REVPARH_REVENUE_PARTITION.included as readonly string[]).toContain(line.accountCode)
      expect(line.businessDay <= FIXTURE_TODAY).toBe(true)
      expect(line.businessDay >= (historyFrom?.day ?? FIXTURE_TODAY)).toBe(true)
    }
  }, 30_000)
})

// --- the acceptance line the database alone can prove --------------------------------------------

describe('a Ramadan hours override changes the index with no code change', () => {
  /**
   * Hand-computed, with two Ramadan runs of two trading days each inside a span of fourteen.
   *
   * Revenue is posted by this suite's own journal entries so the figures are its own: 300,000 fils net on
   * each baseline day and 120,000 on each Ramadan day.
   *
   * At the seeded weekly hours (900 minutes everywhere):
   *   baseline 10 days × R rooms × 900; Ramadan 4 days × R rooms × 900. The room count cancels, so
   *   RevPARH(ramadan)/RevPARH(baseline) = (480,000/3,600) / (3,000,000/9,000) = 0.4000.
   * With a 720-minute override on the Ramadan dates:
   *   RevPARH(ramadan) = 480,000 / (4 × R × 720 / 60) and the index becomes 0.5000 — exactly 900/720
   *   times the first figure.
   *
   * Nothing between the two readings changes except one row in `premises_hours_override`, a regeneration
   * of `business_day` and a refresh of `dim_date`. That is R-REP-06's third acceptance line and ADR
   * 0068's "fifteen hours is correct today" hazard closed from the database side.
   */
  it('reads a different index out of unchanged code after an hours override is written', async () => {
    // Two separated Ramadan runs: days 2-3 and days 8-9 of the span.
    const ramadanDates = [dayAt(2), dayAt(3), dayAt(8), dayAt(9)]
    for (const range of [
      [dayAt(2), dayAt(3)],
      [dayAt(8), dayAt(9)],
    ] as const) {
      const [row] = await sql<{ id: string }[]>`
        insert into reporting.calendar_observance
          (kind, name, date_basis, starts_on, ends_on, is_provisional, open_question_id, source)
        values (
          'ramadan', 'Ramadan (R-REP-06 itest range)', 'lunar',
          ${range[0]}::date, ${range[1]}::date, true, 'Y9-holiday-calendar',
          'Inserted by packages/fixtures/src/cash-forecast.itest.ts over a reserved year; not a real date'
        )
        returning id::text as id
      `
      if (row?.id !== undefined) observanceIds.push(row.id)
    }

    // Revenue the suite posts itself, so the index is over its own figures. The counterpart is the
    // drawer, which keeps the entry balanced.
    //
    // **The entry and its lines go in ONE transaction, and that is not tidiness.** `0018_ledger.sql`
    // enforces the double entry with a DEFERRED constraint trigger, and `postgres.js` gives each
    // template call its own transaction — so inserting the header alone commits an entry with no lines
    // and the trigger fires at that commit: `UnbalancedEntry: entry "..." has 0 line(s)`. The first
    // version of this suite did exactly that, and the failure named the journal rather than the missing
    // `begin`.
    for (const date of span) {
      const net = ramadanDates.includes(date) ? 120_000 : 300_000
      const entryId = `rrep06-${date}`
      await sql.begin(async (tx) => {
        await tx`
          insert into journal_entry (entry_id, entry_date, narrative, source)
          values (${entryId}, ${date}::date, 'R-REP-06 itest revenue', 'adjustment')
          on conflict (entry_id) do nothing
        `
        await tx`
          insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
          values
            (${entryId}, 1, ${STANDARD_SPA_STATEMENT_LAYOUT.cashAccountCodes[0] as string}, ${net}, 0),
            (${entryId}, 2, ${REVPARH_REVENUE_PARTITION.included[0] as string}, 0, ${net})
          on conflict do nothing
        `
      })
      journalEntryIds.push(entryId)
    }
    await sql`select * from reporting.refresh('dim_date', 'on_demand')`

    const before = await seasonalityPeriod(sql, window, [...REVPARH_REVENUE_PARTITION.included])
    expect(before.days).toHaveLength(SPAN_DAYS)
    for (const day of before.days) expect(day.openMinutes).toBe(WEEKLY_OPEN_MINUTES)
    expect(before.days.filter((day) => day.isRamadan)).toHaveLength(4)
    const weekly = seasonalityIndex('ramadan', seasonalityInputFrom(before))
    expect(weekly.state).toBe('value')
    if (weekly.state !== 'value') throw new Error('expected an index at the weekly hours')
    expect(publishedIndex(weekly.value)).toBe('0.4000')
    expect(weekly.value.bucketOccurrences).toBe(2)

    // The one change: a `premises_hours_override` row over the Ramadan dates, 14:00-02:00.
    const [override] = await sql<{ id: string }[]>`
      insert into premises_hours_override (starts_on, ends_on, open_time, close_time, reason)
      values (
        ${dayAt(2)}::date, ${dayAt(3)}::date, time '14:00', time '02:00',
        'R-REP-06 itest: reduced Ramadan hours over a reserved year'
      )
      returning id::text as id
    `
    overrideId = override?.id ?? ''
    const [override2] = await sql<{ id: string }[]>`
      insert into premises_hours_override (starts_on, ends_on, open_time, close_time, reason)
      values (
        ${dayAt(8)}::date, ${dayAt(9)}::date, time '14:00', time '02:00',
        'R-REP-06 itest: reduced Ramadan hours over a reserved year'
      )
      returning id::text as id
    `
    const secondOverrideId = override2?.id ?? ''
    try {
      await generateSpanBusinessDays()

      const after = await seasonalityPeriod(sql, window, [...REVPARH_REVENUE_PARTITION.included])
      // The hours chain, visible: `premises_hours_override` → `business_day.duration_seconds` (generated)
      // → `dim_date.open_minutes`. Nothing in `packages/core` was touched between the two readings.
      for (const day of after.days) {
        expect(day.openMinutes).toBe(day.isRamadan ? RAMADAN_OPEN_MINUTES : WEEKLY_OPEN_MINUTES)
      }
      const reduced = seasonalityIndex('ramadan', seasonalityInputFrom(after))
      expect(reduced.state).toBe('value')
      if (reduced.state !== 'value') throw new Error('expected an index at the override hours')
      expect(publishedIndex(reduced.value)).toBe('0.5000')
      // And the revenue did not move: only the denominator did. That is what makes this case about the
      // hours rather than about the index having changed for any reason at all.
      expect(reduced.value.baselineRevparh).toEqual(weekly.value.baselineRevparh)
      expect(reduced.value.bucketRevparh).not.toEqual(weekly.value.bucketRevparh)
      expect(reduced.value.bucketTradingDays).toBe(weekly.value.bucketTradingDays)
    } finally {
      if (secondOverrideId) {
        await sql`delete from premises_hours_override where id = ${secondOverrideId}::uuid`.catch(
          () => undefined,
        )
      }
    }
  }, 60_000)
})

// --- the lunar holiday, reported twice -----------------------------------------------------------

describe('a lunar-date holiday reports its impact twice', () => {
  it('splits the period into a confirmed side and a provisional side with no field that adds them', async () => {
    const [gregorian] = await sql<{ id: string }[]>`
      insert into reporting.calendar_observance
        (kind, name, date_basis, starts_on, ends_on, is_provisional, open_question_id, source)
      values (
        'public_holiday', 'New Year''s Day', 'gregorian', ${dayAt(5)}::date, ${dayAt(5)}::date,
        false, null,
        'Fixed in the Gregorian calendar; inserted by cash-forecast.itest.ts over a reserved year'
      )
      returning id::text as id
    `
    if (gregorian?.id !== undefined) observanceIds.push(gregorian.id)
    const [lunar] = await sql<{ id: string }[]>`
      insert into reporting.calendar_observance
        (kind, name, date_basis, starts_on, ends_on, is_provisional, open_question_id, source)
      values (
        'public_holiday', 'Eid al Fitr', 'lunar', ${dayAt(6)}::date, ${dayAt(7)}::date,
        true, 'Y9-holiday-calendar',
        'Announced against the lunar calendar at short notice; a reserved-year test range, not a real date'
      )
      returning id::text as id
    `
    if (lunar?.id !== undefined) observanceIds.push(lunar.id)
    await sql`select * from reporting.refresh('dim_date', 'on_demand')`

    const period = await seasonalityPeriod(sql, window, [...REVPARH_REVENUE_PARTITION.included])
    const impact = observanceImpact(seasonalityInputFrom(period))

    // The acceptance line, as a key-set assertion: there is no blended number to read.
    expect(Object.keys(impact).sort()).toEqual([...OBSERVANCE_IMPACT_SIDES].sort())

    expect(impact.confirmed.tradingDays).toBe(1)
    expect(impact.confirmed.observanceNames).toEqual(["New Year's Day"])
    expect(impact.confirmed.lunarDatedDays).toBe(0)
    expect(impact.confirmed.ramadanDays).toBe(0)

    // Two lunar holiday days plus the four Ramadan days inserted by the case above.
    expect(impact.provisional.tradingDays).toBe(6)
    expect(impact.provisional.observanceNames).toEqual(['Eid al Fitr'])
    expect(impact.provisional.lunarDatedDays).toBe(2)
    expect(impact.provisional.ramadanDays).toBe(4)

    // Two different figures, and the suite reads them separately rather than adding them. 6 of 14
    // trading days is 4,286 basis points; 1 of 14 is 714.
    expect(impact.confirmed.shareOfPeriodBp).toBe(714)
    expect(impact.provisional.shareOfPeriodBp).toBe(4_286)
    expect(impact.confirmed.openMinutes).not.toBe(impact.provisional.openMinutes)
  }, 30_000)

  it('is safe to rely on, because the DATABASE refuses a lunar date presented as settled', async () => {
    // The pure refusal (`LunarDatePresentedAsSettled`) is only a sound guarantee while this constraint
    // holds, so the suite probes it: a lunar observance that is not provisional cannot be stored, which
    // is why `dim_date` can never report one on the confirmed side.
    await expect(
      sql`
        insert into reporting.calendar_observance
          (kind, name, date_basis, starts_on, ends_on, is_provisional, open_question_id, source)
        values (
          'public_holiday', 'Eid al Adha', 'lunar', ${dayAt(10)}::date, ${dayAt(10)}::date,
          false, null, 'A lunar date presented as settled, which this constraint refuses'
        )
      `,
    ).rejects.toThrow(/calendar_observance_lunar_is_provisional/)
  })
})

// --- determinism under the frozen clock -----------------------------------------------------------

describe('two runs under the frozen clock produce byte-identical forecast output', () => {
  it('is byte-identical across two independent reads of the same database', async () => {
    const build = async (): Promise<CashForecast> => {
      const [cash, bookings, census, costs] = await Promise.all([
        forecastCashPosition(sql, FIXTURE_TODAY, STANDARD_SPA_STATEMENT_LAYOUT.cashAccountCodes),
        forwardBookingRows(sql, { from: FIXTURE_TODAY, to: dayAt(SPAN_DAYS - 1) }),
        payrollForecastCensus(sql, { from: FIXTURE_TODAY, to: dayAt(SPAN_DAYS - 1) }),
        recurringCostSchedule(sql, FIXTURE_TODAY, 4),
      ])
      return cashForecast({
        asOf: FIXTURE_TODAY,
        openingCashFils: cash.fils,
        cashAccountCodes: STANDARD_SPA_STATEMENT_LAYOUT.cashAccountCodes,
        recurringCosts: costs.map((row) => ({
          code: row.code,
          dueDate: localDate(row.dueDate),
          expectedFils: row.expectedFils,
          costKind: row.costKind === 'variable' ? 'variable' : 'fixed',
        })),
        forwardBookings: bookings.rows.map((row) => ({
          appointmentId: row.appointmentId,
          tradingDate: localDate(row.tradingDate),
          snapshotGrossFils: row.snapshotGrossFils,
        })),
        showUpRate: {
          rateBp: PROVISIONAL_SHOW_UP_RATE_BP,
          settingKey: FORECAST_SHOW_UP_RATE_BP_SETTING_KEY,
          provisional: { openQuestionId: 'Y9-windows', note: 'itest' },
        },
        payroll: payrollFromCensus(census),
      })
    }
    const first = forecastBytes(await build())
    const second = forecastBytes(await build())
    expect(second).toBe(first)
    // The control: the bytes carry the figures, so the equality is not an equality of two empty strings.
    expect(first).toContain(`"asOf":"${FIXTURE_TODAY}"`)
    expect(first.length).toBeGreaterThan(1_000)
  }, 30_000)
})
