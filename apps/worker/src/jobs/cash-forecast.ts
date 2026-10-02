import {
  FORECAST_SHOW_UP_RATE_BP_SETTING_KEY,
  getDefinition,
  SEASONALITY_SUMMER_MONTHS_SETTING_KEY,
  validateSetting,
} from '@berelax/config'
import {
  type CashForecast,
  type CashForecastInput,
  cashForecast,
  FORECAST_WEEKS,
  forecastFindings,
  localDate,
  MINIMUM_SEASONALITY_OCCURRENCES,
  type ObservanceImpact,
  observanceImpact,
  payrollFromCensus,
  publishedIndex,
  publishForecastFigure,
  REVPARH_REVENUE_PARTITION,
  type SeasonalityBucket,
  type SeasonalityInput,
  STANDARD_SPA_STATEMENT_LAYOUT,
  seasonalityModel,
} from '@berelax/core'
import {
  forecastCashPosition,
  forwardBookingRows,
  payrollForecastCensus,
  readSetting,
  recurringCostSchedule,
  type Sql,
  seasonalityPeriod,
  tradingDateAt,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/**
 * The weekly 13-week cash-flow forecast and seasonality report (R-REP-06, ADR 0073).
 *
 * ## What this pass is for, given that it writes nothing
 *
 * A forecast is a number nobody can check until it is too late, so the one thing a scheduled pass can add
 * is that the refusals are SEEN. Three of the figures this build can produce today are refusals — payroll
 * for want of a pay date and a wage, and every seasonality bucket for want of two occurrences — and a
 * refusal nobody reads is indistinguishable from a figure. So the pass computes the forecast, runs
 * `forecastFindings` over it, and says out loud what it found, including the empty parts.
 *
 * That is `reporting-refresh.ts`' argument about a pass that logged only what changed, applied to a report
 * rather than to a refresh: "a pass that logged only what changed would be indistinguishable from a pass
 * that had stopped".
 *
 * ## Why it stores nothing
 *
 * ADR 0064 settled this for the statements and the argument reaches here unchanged: the forecast is
 * recomputed from `journal_line`, the recurring cost definitions and the diary at read time, and a stored
 * snapshot would be a second statement of a figure that the two would disagree about the first time a
 * booking was cancelled. If a later unit needs a signed pack — "the forecast as it was on the day the
 * owner decided" — that is a stored artefact with a content hash (ADR 0044's shape, and
 * `forecastBytes` is already the canonical form it would be hashed over), and not a table this unit
 * invents on the off-chance.
 *
 * ## The two settings, read here and nowhere in the arithmetic
 *
 * `reporting.forecast_show_up_rate_bp` and `reporting.seasonality_summer_months` are both
 * `provisional: true` and both on the Unconfirmed Assumptions panel. They are read through `readSetting`,
 * which is the one read path and falls back to the registry default so a freshly migrated database behaves
 * like a seeded one — and then VALIDATED through `validateSetting` before it reaches the arithmetic,
 * because a stored row that has gone out of range would otherwise become a rate above the whole, and a
 * show-up rate above 10,000 basis points forecasts more revenue than was booked.
 *
 * ## The date is the business day, and it is refused rather than guessed
 *
 * `tradingDateAt`, for `recurring-cost-check.ts`' reason: trading runs 11:00-02:00, so a pass at 03:30
 * belongs to the session that opened the previous morning. If the calendar holds nothing this job THROWS
 * — a forecast dated by truncating a timestamp is a day out, and at a week boundary that moves a whole
 * night of bookings between two of the thirteen figures.
 */

export const CASH_FORECAST_JOB = 'reporting.cash-forecast'

/** The `agent_definition` row migration 0122 inserts. Spelled here once and read by the registry. */
export const CASH_FORECAST_AGENT = 'cash_forecast'

/** Seven days to a forecast week, so the horizon is this many trading dates wide. */
const HORIZON_DAYS = FORECAST_WEEKS * 7

/** How many whole months of recurring-cost occurrences cover a 13-week horizon. */
const HORIZON_MONTHS = 4

export interface CashForecastReport {
  readonly asOf: string
  readonly forecast: CashForecast
  readonly seasonality: readonly {
    readonly bucket: SeasonalityBucket
    readonly outcome: ReturnType<typeof seasonalityModel>[number]['outcome']
  }[]
  readonly observance: ObservanceImpact
  /** Revenue postings in the horizon that no trading date holds. See `seasonalityPeriod`. */
  readonly revenueOffTheTradingCalendarFils: bigint
  /** Cash accounts the caller asked for that the ledger holds no posting on. */
  readonly cashAccountsWithNoPostings: readonly string[]
}

/** The show-up rate, validated against its own registry definition before it reaches the arithmetic. */
async function showUpRate(sql: Sql): Promise<CashForecastInput['showUpRate']> {
  const stored = await readSetting<unknown>(sql, FORECAST_SHOW_UP_RATE_BP_SETTING_KEY)
  const rateBp = validateSetting(FORECAST_SHOW_UP_RATE_BP_SETTING_KEY, stored)
  const definition = getDefinition(FORECAST_SHOW_UP_RATE_BP_SETTING_KEY)
  if (definition.provisional === undefined) {
    // The marker is what puts the assumption on every figure the rate touches, so a definition that lost
    // it would silently turn a projection into a committed figure. Refused here rather than defaulted,
    // because the default would be "not provisional" — the wrong direction.
    throw new AppError(
      'invariant_violated',
      `${FORECAST_SHOW_UP_RATE_BP_SETTING_KEY} is no longer flagged provisional in the settings ` +
        'registry. Every forecast figure it touches names it as an assumption, so without the marker ' +
        'the forward-booking line would read as a committed amount.',
    )
  }
  return {
    rateBp: rateBp as number,
    settingKey: FORECAST_SHOW_UP_RATE_BP_SETTING_KEY,
    provisional: definition.provisional,
  }
}

/** The whole report for a business day. Pure of the clock: `asOf` is an argument. */
export async function buildCashForecastReport(sql: Sql, asOf: string): Promise<CashForecastReport> {
  const [horizon] = await sql<{ from: string; to: string }[]>`
    select ${asOf}::text                                                as from,
           (${asOf}::date + ${HORIZON_DAYS - 1}::integer)::text          as to
  `
  if (horizon === undefined) {
    throw new AppError('invariant_violated', `the horizon query returned no row for ${asOf}`)
  }

  // The balance sheet's own cash line, read from the layout rather than restated: ADR 0064 states the
  // set ONCE and `cash-flow-cash-accounts-are-the-balance-sheet-cash-line` holds its two readers equal,
  // so a fourth reader spelling the three codes again is exactly what that rule exists to prevent.
  const cashAccounts = STANDARD_SPA_STATEMENT_LAYOUT.cashAccountCodes
  const revenueAccounts = [...REVPARH_REVENUE_PARTITION.included]

  const [cash, bookings, census, costs, period] = await Promise.all([
    forecastCashPosition(sql, asOf, cashAccounts),
    forwardBookingRows(sql, horizon),
    payrollForecastCensus(sql, horizon),
    recurringCostSchedule(sql, asOf, HORIZON_MONTHS),
    seasonalityPeriod(sql, horizon, revenueAccounts),
  ])

  const forecast = cashForecast({
    asOf: localDate(asOf),
    openingCashFils: cash.fils,
    cashAccountCodes: cashAccounts,
    recurringCosts: costs.map((row) => ({
      code: row.code,
      dueDate: localDate(row.dueDate),
      expectedFils: row.expectedFils,
      // The register's own word, not a re-derivation: `recurring_cost.cost_kind` is CHECKed to these two
      // and `validateRecurringCost` refuses a variable cost with no band, so a kind this does not
      // recognise is a schema change and not a row to guess at.
      costKind: row.costKind === 'variable' ? 'variable' : 'fixed',
    })),
    forwardBookings: bookings.rows.map((row) => ({
      appointmentId: row.appointmentId,
      tradingDate: localDate(row.tradingDate),
      snapshotGrossFils: row.snapshotGrossFils,
    })),
    showUpRate: await showUpRate(sql),
    payroll: payrollFromCensus(census),
  })

  const storedMonths = await readSetting<unknown>(sql, SEASONALITY_SUMMER_MONTHS_SETTING_KEY)
  const summerMonths = validateSetting(
    SEASONALITY_SUMMER_MONTHS_SETTING_KEY,
    storedMonths,
  ) as number[]
  const seasonalityInput: SeasonalityInput = {
    days: period.days.map((day) => ({ ...day, businessDay: localDate(day.businessDay) })),
    kpiInput: {
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
        accountCode: row.accountCode as (typeof revenueAccounts)[number],
        netFils: row.netFils,
      })),
    },
    summerMonths,
    minimumOccurrences: MINIMUM_SEASONALITY_OCCURRENCES,
  }

  return {
    asOf,
    forecast,
    seasonality: seasonalityModel(seasonalityInput),
    observance: observanceImpact(seasonalityInput),
    revenueOffTheTradingCalendarFils: period.revenueOffTheTradingCalendarFils,
    cashAccountsWithNoPostings: cash.accountsWithNoPostings,
  }
}

/**
 * One line per pass, and the refusals are named rather than counted.
 *
 * Named, because a refusal is a thing to go and fix and a count is not — `describeRefresh`' argument. The
 * seasonality buckets are listed with their observation counts whether they produced an index or not, so
 * a bucket that stopped being measured is visible beside one that never was.
 */
export function describeCashForecast(report: CashForecastReport): string {
  const findings = forecastFindings(report.forecast)
  const refused = report.forecast.weeks.filter(
    (week) => week.closingCash.state === 'unattributable',
  ).length
  const buckets = report.seasonality.map((entry) => {
    const outcome = entry.outcome
    if (outcome.state === 'value') return `${entry.bucket}=${publishedIndex(outcome.value)}`
    return `${entry.bucket}=${outcome.state}`
  })
  // Narrowed through `publishForecastFigure`, which is the only way to a printable number and hands the
  // qualifier back with it — so even a log line cannot state the figure without saying what kind of
  // claim it is. The two states that carry no number are printed as themselves.
  const total = report.forecast.total.closingCash
  const closing =
    total.state === 'unattributable'
      ? 'closing cash UNATTRIBUTABLE'
      : total.state === 'none_by_construction'
        ? 'closing cash nil by construction'
        : (() => {
            const published = publishForecastFigure(total)
            return `closing cash ${published.fils} fils (${published.state})`
          })()
  return (
    `${report.asOf}: ${report.forecast.weeks.length} week(s), ${closing}; ` +
    `${refused} week(s) refuse a closing figure; ` +
    `assumptions: ${report.forecast.assumptions.map((a) => a.assumptionId).join(', ') || '(none)'}; ` +
    `seasonality: ${buckets.join(', ')}; ` +
    `observance impact confirmed ${report.observance.confirmed.tradingDays} day(s) / provisional ` +
    `${report.observance.provisional.tradingDays} day(s)` +
    (report.revenueOffTheTradingCalendarFils === 0n
      ? ''
      : `; ${report.revenueOffTheTradingCalendarFils} fils of revenue is dated off the trading calendar`) +
    (report.cashAccountsWithNoPostings.length === 0
      ? ''
      : `; no postings on ${report.cashAccountsWithNoPostings.join(', ')}`) +
    (findings.length === 0
      ? ''
      : `; FORECAST DOES NOT ARTICULATE: ${findings.map((f) => f.rule).join(', ')}`)
  )
}

/**
 * The connection the handler uses.
 *
 * Set by `run.ts` before `startWorkers`, for `setReportingRefreshSql`'s reason: a handler that attached
 * first would take a job off the queue and fail on a missing dependency, burning a retry on nothing.
 */
let configured: Sql | undefined

export function setCashForecastSql(sql: Sql): void {
  configured = sql
}

async function cashForecastHandler(_data: never, context: JobContext): Promise<void> {
  if (configured === undefined) {
    throw new AppError(
      'invariant_violated',
      `${CASH_FORECAST_JOB} ran before setCashForecastSql() supplied a connection. run.ts calls it ` +
        'before startWorkers().',
    )
  }
  const asOf = await tradingDateAt(configured, context.now())
  if (asOf === null) {
    throw new AppError(
      'invariant_violated',
      `${CASH_FORECAST_JOB} ran at ${context.now()}, which falls in no trading date the calendar holds. ` +
        'A forecast dated by truncating a timestamp would be a day out, and at a week boundary that ' +
        'moves a whole night of bookings between two of the thirteen figures.',
    )
  }
  const report = await buildCashForecastReport(configured, asOf)
  console.log(`${CASH_FORECAST_JOB} ${context.now()}: ${describeCashForecast(report)}`)
}

/**
 * The weekly pass's definition.
 *
 * 04:37 Asia/Dubai on a Sunday. After the nightly reporting refresh at 03:55 — the seasonality half reads
 * `reporting.dim_date`, which is a materialised view, so running before the refresh would report on
 * yesterday's calendar — and after 04:15's reverse-charge report, which a person reads and should not be
 * queued behind this.
 *
 * Weekly rather than nightly because the artefact is a WEEKLY horizon: thirteen windows that only move on
 * the day the first one does, so a nightly pass would re-log almost the same thing six times and bury the
 * one that changed. Sunday because the trading week here starts on one, and a forecast cut mid-week has a
 * first window that straddles the week somebody is already in.
 *
 * Off the quarter hour, and off :55 as well, for `reporting-refresh.ts`' reason: the watchdog and the
 * scheduled-step sweep run every fifteen minutes and there is nothing to gain from sharing a minute.
 *
 * Its declared interval in 0122 is seven days, which is what makes the watchdog's "no success within twice
 * the interval" alert mean something for it.
 */
export const CASH_FORECAST_JOB_DEFINITION: JobDefinition<never> = {
  name: CASH_FORECAST_JOB,
  purpose:
    'Computes the 13-week cash-flow forecast and the seasonality report once a week and says out loud ' +
    'what it found, including every figure it REFUSED to produce (R-REP-06, ADR 0073). It stores ' +
    "nothing: the forecast is recomputed at read time for ADR 0064's reason, and the point of a " +
    'scheduled pass over an artefact nobody can check until it is too late is that its refusals — ' +
    'payroll for want of a pay date and a wage, every seasonality bucket for want of two occurrences — ' +
    'are seen rather than silently rendered as zero.',
  cron: '37 4 * * 0',
  agent: CASH_FORECAST_AGENT,
  retryLimit: 3,
  retryDelaySeconds: 120,
  retryBackoff: true,
  // Four aggregates over `journal_line`, three reads of the diary and four of the reporting schema, over
  // a quarter of trading. Five minutes is generous at this size, and a pass still going after it is
  // blocked rather than slow — nothing here writes, so reclaiming it is safe.
  expireInSeconds: 300,
  handler: cashForecastHandler,
}
