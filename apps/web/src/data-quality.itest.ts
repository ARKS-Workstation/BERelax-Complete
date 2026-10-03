import {
  DATA_QUALITY_CHECK_IDS,
  DATA_QUALITY_CHECKS,
  type DataQualityState,
  STALE_VIEW_AFTER_MINUTES,
} from '@berelax/core'
import {
  createConnection,
  DB_DATA_QUALITY_CHECK_IDS,
  KPI_INPUT_LOADED_DATASETS,
  kpiInputRows,
  type Sql,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DATA_QUALITY_PATH,
  DATA_QUALITY_PERMISSION,
  type DataQualityPrincipal,
  dataQualityPayload,
  handleDataQualityRead,
  revenueAccountCodes,
} from '../app/(admin)/reports/data-quality/handler.ts'
import type { AdminChrome } from './components/admin/google-reauth-banner.ts'

/**
 * R-REP-07 — the gate, over a real database, at both the API and the rendered layer.
 *
 * ## Why the handler and not the built application
 *
 * `next start` serves whatever `.next` was last built, so a suite driving `/reports/data-quality` over
 * HTTP would assert against a stale build on every commit that did not rebuild — G-REV-02 measured that
 * exactly ("four cases reported 'exited zero; nothing was rejected' against a stale build"). So this
 * drives `handleDataQualityRead`, which returns the real `Response` for both serialisations: the JSON
 * IS the API and the HTML IS the rendered layer, and they come from one computation, so a claim about
 * one is a claim about both only because nothing lets them disagree.
 *
 * ## Isolation
 *
 * Everything runs inside a transaction that is ALWAYS rolled back, which is `packages/db/src/
 * reporting.itest.ts`'s arrangement and is the only one available here: `journal_entry` refuses DELETE
 * for every role (ZL001) and `reporting.refresh_run` refuses it too (ZY184), so a committed probe would
 * double every figure on a second run. The rollback also undoes the materialised-view refreshes the
 * body performs, so the database the next file sees is the one this file was handed.
 *
 * The probe day is SEARCHED FOR rather than fixed: the integration suite runs sequentially against one
 * database and earlier files leave rows behind (brief rule 12), so the day this suite writes on is one
 * it has checked holds no appointment, no document and no journal entry. A fixed date would make the
 * ledger-versus-facts control fail on whatever another suite happened to post.
 *
 * ## What is asserted here and what is asserted in the unit suites
 *
 * Here: the readings over real relations, the one-fils injection, the staleness window read through
 * `?at=`, the `unknown` state of a pass that has never run, the 403 and its audit row, and the two
 * places where `core` and `db` each hold a second spelling of one list.
 *
 * In `packages/core/src/reporting/data-quality.test.ts`: every gate state including `unattested`, which
 * cannot be reached from this database because no KPI reads the dataset the only never-run check
 * attests — and in `packages/ui/src/reporting/kpi-tile.test.ts`: that no refusal's bytes carry a figure.
 *
 * ## No invented value
 *
 * The issuer snapshot is `packages/db/src/reporting.itest.ts`'s, reused rather than re-invented, and it
 * has to be a fixture TRN: `legal_entity.trn` holds `TRN-PENDING-Y1-TRN`, which
 * `invoice_issuer_trn_not_placeholder` refuses, so no invoice can be written until Y1-TRN is answered.
 * No customer, therapist or staff member is named: the principals are a uuid and a role.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '') {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/** The issuer snapshot, from `packages/db/src/reporting.itest.ts`. See the header. */
const ISSUER = {
  legalName: 'BE RELAX SPA - L.L.C - O.P.C',
  tradingName: 'BE RELAX - Massage Center and Spa',
  trn: '100123456700003',
  addressSnapshot: '250 Al Meena Street\nTower Block A/B, M-Floor\nAl Zahiyah, Abu Dhabi',
  emirate: 'Abu Dhabi',
} as const

/** One treatment at 200.00 AED: gross 20000 fils, net 19048, VAT 952. `net + vat = gross` exactly. */
const GROSS_FILS = 19_048 + 952
const NET_FILS = 19_048
const VAT_FILS = 952

/** The revenue account the probe's sale credits. `4010` is treatment revenue in the standard chart. */
const TREATMENT_REVENUE = '4010'

const CHROME: AdminChrome = { googleReauth: null, sendBacklog: null, returnTo: DATA_QUALITY_PATH }

const AS = (role: DataQualityPrincipal['role']): DataQualityPrincipal => ({
  role,
  employeeId: '00000000-0000-7000-8000-000000000001',
  staffReference: `fixture-${role}`,
})

let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 2 })
  /*
    One real refresh before anything is read, for `reporting.itest.ts`'s recorded reason: the migration
    creates the views against an EMPTY `business_day` and `pnpm seed` runs afterwards, so on a freshly
    migrated database every view holds nothing until a pass runs. Written without this, every assertion
    below passes on a long-lived worktree database and fails in CI against a fresh one.
  */
  await sql`select * from reporting.refresh_all('nightly')`
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

/** Thrown to abort a probe transaction, carrying whatever the body worked out. */
class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super('probe transaction rolled back on purpose')
  }
}

/** Runs `body` in a transaction that is ALWAYS rolled back. The rollback is the cleanup. */
async function inRolledBackTransaction<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  try {
    await sql.begin(async (tx) => {
      throw new Rollback(await body(tx as unknown as Sql))
    })
  } catch (error) {
    if (error instanceof Rollback) return error.value as T
    throw error
  }
  throw new Error('the probe transaction committed, which it must never do')
}

interface ProbeDay {
  readonly tradingDate: string
  readonly opensAt: string
  readonly closesAt: string
  readonly lateNightAt: string
  readonly calendarDateOfLateNight: string
}

/**
 * A trading date holding no appointment, no document and no journal entry.
 *
 * Searched for, not fixed: see the header. The `offset 10` skips the first ten candidates so the day has
 * neighbours on both sides — a probe on the edge of the calendar would pass for a window that filed
 * everything one day out in one direction.
 */
async function quietDay(handle: Sql): Promise<ProbeDay> {
  const [row] = await handle<ProbeDay[]>`
    select d.trading_date::text                                     as "tradingDate",
           d.opens_at::text                                          as "opensAt",
           d.closes_at::text                                         as "closesAt",
           (d.closes_at - interval '30 minutes')::text               as "lateNightAt",
           (((d.closes_at - interval '30 minutes') at time zone 'Asia/Dubai')::date)::text
                                                                     as "calendarDateOfLateNight"
      from business_day d
     where not exists (select 1 from appointment a where a.trading_date = d.trading_date)
       and not exists (select 1 from invoice i where i.tax_point_date = d.trading_date)
       and not exists (select 1 from credit_note c where c.tax_point_date = d.trading_date)
       and not exists (select 1 from journal_entry e where e.entry_date = d.trading_date)
       and not exists (select 1 from shift s where s.trading_date = d.trading_date)
       and not exists (select 1 from resource_block b
                        where b.period && tstzrange(d.opens_at, d.closes_at, '[)'))
     order by d.trading_date
     offset 10 limit 1
  `
  if (row === undefined) {
    throw new Error(
      'no trading date in business_day is free of appointments, documents, journal entries, shifts and ' +
        'room blocks. `pnpm seed` writes 149 trading days (brief rule 24); if every one of them is now ' +
        'occupied this suite needs a reserved span of its own rather than a wider search.',
    )
  }
  return row
}

interface Probe {
  readonly bookingId: string
  readonly invoiceId: string
}

/**
 * One appointment, one invoice, the journal entry that recognises its revenue, one rostered shift and
 * the attribution row the booking carries — all on `day`, all at 01:30, which is inside the trading
 * window that opened at 11:00 the previous morning.
 *
 * Every one of the seven checks is satisfied by these rows, and that is the point: the control for
 * every case below is that the committed code reads the probe as sound.
 */
async function insertProbe(tx: Sql, day: ProbeDay): Promise<Probe> {
  const [customer] = await tx<{ id: string }[]>`select id from customer order by id limit 1`
  const [employee] = await tx<{ id: string }[]>`select id from employee order by id limit 1`
  const [room] = await tx<{ id: string }[]>`
    select id from rooms where is_bookable order by display_order, code limit 1
  `
  const [variant] = await tx<{ id: string }[]>`
    select id from service_variant order by service_id, duration_minutes limit 1
  `
  if (
    customer === undefined ||
    employee === undefined ||
    room === undefined ||
    variant === undefined
  ) {
    throw new Error('the seeded salon is missing a customer, employee, room or service variant')
  }

  const [booking] = await tx<{ id: string }[]>`
    insert into booking (customer_id, source) values (${customer.id}, 'front_desk') returning id
  `
  const bookingId = booking?.id ?? ''
  // An OFFLINE first touch: a walk-in the front desk recorded. `offline` is the one basis that names no
  // session, which is what 0096's own constraint requires and what a front-desk booking really is.
  await tx`
    insert into booking_attribution
      (booking_id, basis, source, medium, campaign, occurred_at, recorded_at)
    values
      (${bookingId}, 'offline', 'offline', 'direct', '',
       ${day.lateNightAt}::timestamptz, ${day.lateNightAt}::timestamptz)
  `
  await tx`
    insert into appointment (
      booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
      room_places, turnaround_minutes, therapist_buffer_minutes,
      gross_price_fils, net_fils, vat_fils
    ) values (
      ${bookingId}, ${day.tradingDate}::date, ${variant.id}, 'solo', ${employee.id}, ${room.id},
      tstzrange(${day.lateNightAt}::timestamptz, ${day.closesAt}::timestamptz, '[)'),
      'completed', 1, 20, 10, ${GROSS_FILS}, ${NET_FILS}, ${VAT_FILS}
    )
  `
  const [invoice] = await tx<{ id: string }[]>`
    insert into invoice (
      document_kind, series_code, period_key, number, display_number,
      issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot, issuer_emirate,
      customer_id, customer_name_snapshot, issue_date, issue_trading_date, tax_point_date, issued_at,
      net_total, vat_total, gross_total
    ) values (
      'tax_invoice', 'TAX-INV', 'rrep07-probe', 1, 'TI-RREP07-PROBE-1',
      ${ISSUER.legalName}, ${ISSUER.tradingName}, ${ISSUER.trn}, ${ISSUER.addressSnapshot},
      ${ISSUER.emirate},
      ${customer.id}, 'Customer 0042',
      ${day.calendarDateOfLateNight}::date, ${day.tradingDate}::date, ${day.tradingDate}::date,
      ${day.lateNightAt}::timestamptz,
      ${NET_FILS}, ${VAT_FILS}, ${GROSS_FILS}
    ) returning id
  `
  await tx`
    insert into invoice_line (
      invoice_id, line_no, description_en, quantity, unit_gross_fils, vat_rate_bp,
      line_net_fils, line_vat_fils
    ) values (
      ${invoice?.id ?? ''}, 1, 'Asian Normal Massage', 1, ${GROSS_FILS}, 500,
      ${NET_FILS}, ${VAT_FILS}
    )
  `
  // The sale's own entry: cash in, revenue and VAT out. This is the side the facts are reconciled
  // against, so the credit to 4010 is exactly the invoice's net.
  await tx`
    insert into journal_entry (entry_id, entry_date, narrative, source)
    values ('RREP07-PROBE-SALE', ${day.tradingDate}::date, 'R-REP-07 probe sale', 'sale')
  `
  await tx`
    insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
    values ('RREP07-PROBE-SALE', 1, '1010', ${GROSS_FILS}, 0),
           ('RREP07-PROBE-SALE', 2, ${TREATMENT_REVENUE}, 0, ${NET_FILS}),
           ('RREP07-PROBE-SALE', 3, '2030', 0, ${VAT_FILS})
  `
  const [shift] = await tx<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (
      ${day.tradingDate}::date,
      tstzrange(${day.closesAt}::timestamptz - interval '3 hours', ${day.closesAt}::timestamptz, '[)'),
      'r-rep-07 probe late'
    ) returning id
  `
  await tx`
    insert into shift_assignment (shift_id, employee_id) values (${shift?.id ?? ''}, ${employee.id})
  `
  await tx`select * from reporting.refresh_all('on_demand')`
  return { bookingId, invoiceId: invoice?.id ?? '' }
}

const windowOf = (day: ProbeDay) => ({
  fromInclusive: day.tradingDate,
  toInclusive: day.tradingDate,
})

/** The handler's own arguments for one window and one instant. */
const requestFor = (
  day: ProbeDay,
  options: {
    readonly format?: 'json'
    readonly at?: string
    readonly principal?: DataQualityPrincipal
  } = {},
) => ({
  searchParams: new URLSearchParams({
    from: day.tradingDate,
    to: day.tradingDate,
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.at === undefined ? {} : { at: options.at }),
  }),
  chrome: CHROME,
  principal: options.principal ?? AS('owner'),
  requestId: 'rrep07-itest',
})

/**
 * The instant the readings are taken at: now.
 *
 * Now, and not the probe day, which is the one piece of arithmetic in this file worth stating. The
 * refresh the probe performs happens NOW, so a reading taken "as at the probe day" would compute the
 * views' age as a negative number of minutes against a refresh in its own future — and `greatest(0, …)`
 * in the query would clamp it to zero, so the staleness case below would pass for a reason that has
 * nothing to do with the window.
 */
const freshInstant = (): string => new Date().toISOString()

/** `asOf` far enough past the refresh that every view is beyond the staleness window. */
const staleInstant = (): string =>
  new Date(Date.now() + (STALE_VIEW_AFTER_MINUTES + 60) * 60_000).toISOString()

const argsFor = (day: ProbeDay, asOfIso: string) => ({
  window: windowOf(day),
  asOfIso,
  staleAfterMinutes: STALE_VIEW_AFTER_MINUTES,
  revenueAccountCodes: revenueAccountCodes(),
})

const stateOf = (
  payload: Awaited<ReturnType<typeof dataQualityPayload>>,
  checkId: string,
): DataQualityState => {
  const found = payload.checks.find((check) => check.checkId === checkId)
  if (found === undefined) throw new Error(`the payload carries no check "${checkId}"`)
  return found.state
}

const tileState = (
  payload: Awaited<ReturnType<typeof dataQualityPayload>>,
  kpiId: string,
): string => {
  const found = payload.tiles.find((tile) => tile.kpiId === kpiId)
  if (found === undefined) {
    throw new Error(
      `no tile for "${kpiId}": the dashboard offers ${payload.tiles
        .map((tile) => tile.kpiId)
        .join(', ')}`,
    )
  }
  return found.figure.state
}

describe('the two lists each spelled twice are equal', () => {
  it('holds core’s check ids against the db module’s, as sequences', () => {
    // As sequences and not as sets: the readings are keyed on the ids and the screen lists them in
    // registry order, so an id in the wrong place is a row rendered under the wrong heading.
    expect([...DB_DATA_QUALITY_CHECK_IDS]).toEqual([...DATA_QUALITY_CHECK_IDS])
    expect(DATA_QUALITY_CHECKS.map((check) => check.id)).toEqual([...DATA_QUALITY_CHECK_IDS])
  })

  it('holds the loader’s declared datasets against what it returns', async () => {
    const day = await quietDay(sql)
    const rows = await kpiInputRows(sql, {
      window: windowOf(day),
      revenueAccountCodes: revenueAccountCodes(),
    })
    const returned = Object.keys(rows).filter((key) => key !== 'provenance')
    // Both directions. A dataset added to the loader and left out of the list makes its KPIs quietly
    // unavailable; one removed from the loader and left in the list makes them quietly WRONG, because
    // an empty dataset is a figure of zero in a sum.
    expect([...KPI_INPUT_LOADED_DATASETS].sort()).toEqual(returned.sort())
  })
})

describe('the probe reads as sound, which is the control for everything below', () => {
  it('holds every check that has a reading, and renders a figure', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      await insertProbe(tx, day)
      const payload = await dataQualityPayload(tx, argsFor(day, freshInstant()))

      for (const checkId of [
        'ledger_vs_facts',
        'rollup_vs_raw',
        'attribution_coverage',
        'ref_capture',
        'bot_share',
        'view_freshness',
      ]) {
        expect(stateOf(payload, checkId), `${checkId} did not hold over the probe`).toBe('pass')
      }
      // Every registered check is listed, including the one with no reading.
      expect(payload.checks.map((check) => check.checkId)).toEqual([...DATA_QUALITY_CHECK_IDS])
      // And the facts really did carry the probe's sale: a control over a window with nothing in it
      // would also report no variance.
      const ledger = payload.checks.find((check) => check.checkId === 'ledger_vs_facts')
      expect(ledger?.observed?.leftValue).toBe(String(NET_FILS))
      expect(ledger?.observed?.rightValue).toBe(String(NET_FILS))
      expect(tileState(payload, 'revenue_per_available_room_hour')).toBe('value')
      expect(tileState(payload, 'room_utilisation')).toBe('value')
    })
  })

  it('offers only the KPIs whose datasets the loader loads', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      await insertProbe(tx, day)
      const payload = await dataQualityPayload(tx, argsFor(day, freshInstant()))
      const offered = payload.tiles.map((tile) => tile.kpiId)
      // Not a cohort KPI among them: those are a cohort-month grain and this window is trading dates,
      // so the loader does not load their datasets and `kpisComputableFrom` drops them. A tile reading
      // an unloaded dataset would report a figure over an empty array, which is a figure of zero.
      expect(offered).not.toContain('cohort_ltv_per_customer')
      expect(offered.length).toBeGreaterThan(0)
      expect(new Set(offered).size).toBe(offered.length)
    })
  })
})

describe('one fils between the facts and the journal', () => {
  it('makes every dependent tile unreconciled, at the API and at the rendered layer', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      await insertProbe(tx, day)

      // ONE fils of revenue with no document behind it. Balanced, so the ledger is still a ledger and
      // nothing else in the build refuses it — which is the point: the discrepancy is invisible to
      // every other check in the repository and visible to this one.
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values ('RREP07-PROBE-DRIFT', ${day.tradingDate}::date, 'R-REP-07 probe drift', 'adjustment')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values ('RREP07-PROBE-DRIFT', 1, '1010', 1, 0),
               ('RREP07-PROBE-DRIFT', 2, ${TREATMENT_REVENUE}, 0, 1)
      `

      const payload = await dataQualityPayload(tx, argsFor(day, freshInstant()))
      expect(stateOf(payload, 'ledger_vs_facts')).toBe('fail')
      const ledger = payload.checks.find((check) => check.checkId === 'ledger_vs_facts')
      expect(ledger?.observed?.variance).toBe('-1')
      expect(ledger?.observed?.offendingRows).toBe(1)
      // The drill-down names the day, so the failure is actionable rather than a red row.
      expect(ledger?.drillDown.map((row) => row.subject)).toEqual([day.tradingDate])

      // THE acceptance line: the dependent tile is unreconciled and the independent one is not.
      expect(tileState(payload, 'revenue_per_available_room_hour')).toBe('unreconciled')
      expect(tileState(payload, 'room_utilisation')).toBe('value')

      // The API.
      const api = await handleDataQualityRead(requestFor(day, { format: 'json' }), {
        sql: tx,
        now: () => Date.parse(freshInstant()),
      })
      expect(api.status).toBe(200)
      expect(api.headers.get('content-type')).toBe('application/json; charset=utf-8')
      const body = (await api.json()) as {
        tiles: { kpiId: string; figure: { state: string } }[]
      }
      const served = body.tiles.find((tile) => tile.kpiId === 'revenue_per_available_room_hour')
      expect(served?.figure.state).toBe('unreconciled')
      // No numeric field on the refusal at all — not a zero, not a null, nothing to read.
      expect(Object.keys(served?.figure ?? {})).not.toContain('value')

      // The rendered layer.
      const page = await handleDataQualityRead(requestFor(day), {
        sql: tx,
        now: () => Date.parse(freshInstant()),
      })
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(page.headers.get('cache-control')).toBe('no-store')
      const html = await page.text()
      expect(html).toContain('data-kpi-state="unreconciled"')
      expect(html).toContain('data-dq-state="fail"')
      expect(html).toContain('Unreconciled')
      // And the control on the rendered layer: the independent tile still carries a figure, so the
      // page is not simply refusing everything.
      expect(html).toContain('data-kpi-state="value"')
    })
  })
})

describe('a view older than the staleness window', () => {
  it('marks its dependent tiles stale rather than rendering silently old numbers', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      await insertProbe(tx, day)

      // `reporting.refresh_run` is append-only (ZY184), so the refresh cannot be backdated — and it
      // must not be: the whole value of that table is that a stale view cannot be made to look fresh.
      // So the AGE is moved instead, by reading as at an instant past the window. That is the same
      // arithmetic the nightly pass failing for a day would produce.
      const payload = await dataQualityPayload(tx, argsFor(day, staleInstant()))
      expect(stateOf(payload, 'view_freshness')).toBe('stale')
      const freshness = payload.checks.find((check) => check.checkId === 'view_freshness')
      expect(Number(freshness?.observed?.leftValue)).toBeGreaterThan(STALE_VIEW_AFTER_MINUTES)
      expect(freshness?.observed?.rightValue).toBe(String(STALE_VIEW_AFTER_MINUTES))
      // Every view is listed in the drill-down, oldest first, so an operator can see which pass stopped.
      expect(freshness?.drillDown.length).toBeGreaterThan(0)

      // `view_freshness` attests every subject, so every offered tile is stale — which is correct: every
      // figure in the reporting estate is read from one of these views.
      for (const tile of payload.tiles) {
        expect(tile.figure.state, `${tile.kpiId} rendered a figure from a stale view`).toBe('stale')
      }

      // The control: the same probe read at an instant inside the window renders figures.
      const fresh = await dataQualityPayload(tx, argsFor(day, freshInstant()))
      expect(stateOf(fresh, 'view_freshness')).toBe('pass')
      expect(fresh.tiles.every((tile) => tile.figure.state === 'value')).toBe(true)
    })
  })
})

describe('a check that has never run', () => {
  it('reads unknown and never pass, and reads pass once a pass has run', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      await insertProbe(tx, day)

      const before = await dataQualityPayload(tx, argsFor(day, freshInstant()))
      const dispatch = before.checks.find((check) => check.checkId === 'dispatch_reconciliation')
      // No reconciliation pass has covered this day, so there is nothing to compare — and the row says
      // so rather than reporting two sides that agreed at zero.
      expect(dispatch?.state).toBe('unknown')
      expect(dispatch?.observed).toBeNull()
      expect(dispatch?.lastRanAtIso).toBeNull()
      expect(dispatch?.drillDown).toEqual([])

      // And the other direction, which is what stops "unknown" from being a state nothing can leave.
      await tx`
        insert into analytics_dispatch_reconciliation (
          business_day, destination, internal_count, pushed_count, missing_count, duplicate_count,
          intentionally_not_pushed_count, difference_fils, state, ran_at
        ) values (
          ${day.tradingDate}::date, 'analytics_measurement_push', 1, 1, 0, 0, 0, 0, 'reconciled',
          -- AFTER the day closed. 0128 refuses a pass run while the trading day is still open, because
          -- a run at 21:30 on a day that closes at 02:00 compares this business's conversions against
          -- dispatches the consumer has not attempted yet and calls every one of them missing.
          ${day.closesAt}::timestamptz + interval '1 hour'
        )
      `
      const after = await dataQualityPayload(tx, argsFor(day, freshInstant()))
      expect(stateOf(after, 'dispatch_reconciliation')).toBe('pass')
      const html = await (
        await handleDataQualityRead(requestFor(day), {
          sql: tx,
          now: () => Date.parse(freshInstant()),
        })
      ).text()
      expect(html).toContain('data-dq-check="dispatch_reconciliation"')
    })
  })
})

describe('the report is deny-by-default', () => {
  it('refuses a role without report:read and records the refusal', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      const [before] = await tx<{ n: string }[]>`
        select count(*)::text as n from audit_event
         where action = 'report.data_quality_denied' and operation = 'denied'
      `
      // The therapist holds `calendar:read` and the clinical permissions and not `report:read`.
      const refused = await handleDataQualityRead(requestFor(day, { principal: AS('therapist') }), {
        sql: tx,
        now: () => Date.now(),
      })
      expect(refused.status).toBe(403)
      expect(await refused.text()).toContain(DATA_QUALITY_PERMISSION)

      // A DELTA counted in SQL, because `audit_event` is append-only (ADR 0008) and a total would be
      // whatever earlier files left behind.
      const [after] = await tx<{ n: string }[]>`
        select count(*)::text as n from audit_event
         where action = 'report.data_quality_denied' and operation = 'denied'
      `
      expect(Number(after?.n ?? '0') - Number(before?.n ?? '0')).toBe(1)

      // The control: the same window, a role that holds the permission, 200.
      const allowed = await handleDataQualityRead(
        requestFor(day, { principal: AS('accountant') }),
        {
          sql: tx,
          now: () => Date.now(),
        },
      )
      expect(allowed.status).toBe(200)
    })
  })

  it('refuses a window it was not given, in both serialisations', async () => {
    await inRolledBackTransaction(async (tx) => {
      const bare = {
        searchParams: new URLSearchParams(),
        chrome: CHROME,
        principal: AS('owner'),
        requestId: null,
      }
      const plain = await handleDataQualityRead(bare, { sql: tx, now: () => Date.now() })
      expect(plain.status).toBe(400)
      expect(await plain.text()).toContain('from=YYYY-MM-DD')
      const asJson = await handleDataQualityRead(
        { ...bare, searchParams: new URLSearchParams({ format: 'json' }) },
        { sql: tx, now: () => Date.now() },
      )
      expect(asJson.status).toBe(400)
      expect(((await asJson.json()) as { error: string }).error).toBe('window_required')
    })
  })
})
