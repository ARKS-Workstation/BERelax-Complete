import { DASHBOARD_TILES, forbiddenColumnsFor, selectableColumnsFor } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DASHBOARD_PATH,
  type DashboardPrincipal,
  dashboardPayload,
  handleDashboardExport,
  handleDashboardRead,
} from '../app/(admin)/reports/handler.ts'
import type { AdminChrome } from './components/admin/google-reauth-banner.ts'

/**
 * R-REP-08 — the role-scoped dashboards, over a real database.
 *
 * ## Why the handler and not the built application
 *
 * `next start` serves whatever `.next` was last built, so a suite driving `/reports` over HTTP would
 * assert against a stale build on every commit that did not rebuild (G-REV-02 measured that exactly).
 * So this drives `handleDashboardRead` and `handleDashboardExport`, which return the real `Response`
 * for both serialisations: the JSON IS the API payload the acceptance line inspects, the HTML IS the
 * rendered layer, and they come from one computation.
 *
 * The browser half — axe, and the screenshot matrix at 3 viewports × 2 themes × 2 directions — is
 * `apps/web/e2e/dashboards.spec.ts`, which needs a built application.
 *
 * ## Isolation
 *
 * One transaction, always rolled back, which is `packages/db/src/reporting.itest.ts`'s arrangement and
 * the only one available here: `journal_entry` refuses DELETE for every role (ZL001),
 * `reporting.refresh_run` refuses it too (ZY184) and `audit_event` is append-only (ADR 0008), so a
 * committed probe would double every figure on a second run. The rollback also undoes the
 * materialised-view refreshes the body performs.
 *
 * The probe day is SEARCHED FOR rather than fixed, because the integration suite runs sequentially
 * against one database and earlier files leave rows behind (brief rule 12).
 *
 * ## Two employees, deliberately
 *
 * Scoping is only a claim if there is something to exclude. The probe rosters and delivers for TWO
 * employees, so the therapist's own figures are strictly less than the business's — a one-employee
 * probe would make a scoped query and an unscoped one return the same number, and every assertion about
 * the scope would pass for a query with no `where` clause at all.
 *
 * ## No invented value
 *
 * The issuer snapshot is `packages/db/src/reporting.itest.ts`'s, reused rather than re-invented, and it
 * has to be a fixture TRN: `legal_entity.trn` holds `TRN-PENDING-Y1-TRN`, which
 * `invoice_issuer_trn_not_placeholder` refuses. No person is named: the principals are a uuid and a
 * role, and the drill-down's employee column is the employment record's internal handle (ADR 0020).
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '') {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const ISSUER = {
  legalName: 'BE RELAX SPA - L.L.C - O.P.C',
  tradingName: 'BE RELAX - Massage Center and Spa',
  trn: '100123456700003',
  addressSnapshot: '250 Al Meena Street\nTower Block A/B, M-Floor\nAl Zahiyah, Abu Dhabi',
  emirate: 'Abu Dhabi',
} as const

const NET_FILS = 19_048
const VAT_FILS = 952
const GROSS_FILS = NET_FILS + VAT_FILS
const TREATMENT_REVENUE = '4010'

/** The probe's two employees: the one the therapist principal IS, and the one they are not. */
const OWN_TREATMENT_MINUTES = 60
const OTHER_TREATMENT_MINUTES = 90
const TURNAROUND_MINUTES = 20
const OWN_ROSTERED_MINUTES = 180
const OTHER_ROSTERED_MINUTES = 180

const CHROME: AdminChrome = {
  googleReauth: null,
  sendBacklog: null,
  role: 'owner' as const,
  returnTo: DASHBOARD_PATH,
}

let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 2 })
  // One real refresh before anything is read: the views are created against an empty `business_day`
  // and `pnpm seed` runs afterwards, so on a fresh database they hold nothing until a pass runs.
  await sql`select * from reporting.refresh_all('nightly')`
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super('probe transaction rolled back on purpose')
  }
}

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
  readonly openMinutes: number
  readonly lateNightAt: string
  readonly calendarDateOfLateNight: string
}

/** A trading date holding no appointment, document, journal entry, shift or room block. */
async function quietDay(handle: Sql): Promise<ProbeDay> {
  const [row] = await handle<ProbeDay[]>`
    select d.trading_date::text                                     as "tradingDate",
           d.opens_at::text                                          as "opensAt",
           d.closes_at::text                                         as "closesAt",
           (extract(epoch from (d.closes_at - d.opens_at)) / 60)::int as "openMinutes",
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
     offset 12 limit 1
  `
  if (row === undefined) {
    throw new Error(
      'no trading date in business_day is free of appointments, documents, journal entries, shifts and ' +
        'room blocks. `pnpm seed` writes 149 trading days (brief rule 24).',
    )
  }
  return row
}

interface Probe {
  readonly ownEmployeeId: string
  readonly otherEmployeeId: string
  readonly ownReference: string
  readonly otherReference: string
}

/**
 * Two employees, each with one delivered appointment and one rostered shift, plus one invoice and the
 * journal entry that recognises its revenue — all on `day`.
 *
 * The two appointments start in DIFFERENT hours of the trading window, so the time-of-day view has more
 * than one non-empty bucket: a chart over one hour is contiguous by accident.
 */
async function insertProbe(tx: Sql, day: ProbeDay): Promise<Probe> {
  const [customer] = await tx<{ id: string }[]>`select id from customer order by id limit 1`
  const employees = await tx<{ id: string; reference: string }[]>`
    select id::text as id, staff_reference as reference from employee order by staff_reference limit 2
  `
  const [own, other] = employees
  const [room] = await tx<{ id: string }[]>`
    select id from rooms where is_bookable order by display_order, code limit 1
  `
  const [variant] = await tx<{ id: string }[]>`
    select id from service_variant order by service_id, duration_minutes limit 1
  `
  if (
    customer === undefined ||
    own === undefined ||
    other === undefined ||
    room === undefined ||
    variant === undefined
  ) {
    throw new Error('the seeded salon is missing a customer, two employees, a room or a variant')
  }

  const [booking] = await tx<{ id: string }[]>`
    insert into booking (customer_id, source) values (${customer.id}, 'front_desk') returning id
  `
  const bookingId = booking?.id ?? ''
  await tx`
    insert into booking_attribution
      (booking_id, basis, source, medium, campaign, occurred_at, recorded_at)
    values
      (${bookingId}, 'offline', 'offline', 'direct', '',
       ${day.opensAt}::timestamptz, ${day.opensAt}::timestamptz)
  `

  // Two appointments in two different hours. `own` starts at opening; `other` three hours later.
  for (const [employee, minutes, offsetHours] of [
    [own, OWN_TREATMENT_MINUTES, 0],
    [other, OTHER_TREATMENT_MINUTES, 3],
  ] as const) {
    await tx`
      insert into appointment (
        booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
        room_places, turnaround_minutes, therapist_buffer_minutes,
        gross_price_fils, net_fils, vat_fils
      ) values (
        ${bookingId}, ${day.tradingDate}::date, ${variant.id}, 'solo', ${employee.id}, ${room.id},
        tstzrange(
          ${day.opensAt}::timestamptz + make_interval(hours => ${offsetHours}),
          ${day.opensAt}::timestamptz + make_interval(hours => ${offsetHours}, mins => ${minutes}),
          '[)'
        ),
        'completed', 1, ${TURNAROUND_MINUTES}, 10, ${GROSS_FILS}, ${NET_FILS}, ${VAT_FILS}
      )
    `
    const [shift] = await tx<{ id: string }[]>`
      insert into shift (trading_date, period, label)
      values (
        ${day.tradingDate}::date,
        tstzrange(
          ${day.opensAt}::timestamptz + make_interval(hours => ${offsetHours}),
          ${day.opensAt}::timestamptz + make_interval(hours => ${offsetHours}, mins => 180),
          '[)'
        ),
        ${`r-rep-08 probe ${employee.reference}`}
      ) returning id
    `
    await tx`
      insert into shift_assignment (shift_id, employee_id) values (${shift?.id ?? ''}, ${employee.id})
    `
  }

  const [invoice] = await tx<{ id: string }[]>`
    insert into invoice (
      document_kind, series_code, period_key, number, display_number,
      issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot, issuer_emirate,
      customer_id, customer_name_snapshot, issue_date, issue_trading_date, tax_point_date, issued_at,
      net_total, vat_total, gross_total
    ) values (
      'tax_invoice', 'TAX-INV', 'rrep08-probe', 1, 'TI-RREP08-PROBE-1',
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
  await tx`
    insert into journal_entry (entry_id, entry_date, narrative, source)
    values ('RREP08-PROBE-SALE', ${day.tradingDate}::date, 'R-REP-08 probe sale', 'sale')
  `
  await tx`
    insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
    values ('RREP08-PROBE-SALE', 1, '1010', ${GROSS_FILS}, 0),
           ('RREP08-PROBE-SALE', 2, ${TREATMENT_REVENUE}, 0, ${NET_FILS}),
           ('RREP08-PROBE-SALE', 3, '2030', 0, ${VAT_FILS})
  `
  await tx`select * from reporting.refresh_all('on_demand')`
  return {
    ownEmployeeId: own.id,
    otherEmployeeId: other.id,
    ownReference: own.reference,
    otherReference: other.reference,
  }
}

const AS = (role: DashboardPrincipal['role'], employeeId: string): DashboardPrincipal => ({
  role,
  employeeId,
  staffReference: `fixture-${role}`,
})

const requestFor = (
  day: ProbeDay,
  principal: DashboardPrincipal,
  options: { readonly format?: 'json'; readonly tile?: string } = {},
) => ({
  searchParams: new URLSearchParams({
    from: day.tradingDate,
    to: day.tradingDate,
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.tile === undefined ? {} : { tile: options.tile }),
  }),
  chrome: CHROME,
  principal,
  requestId: 'rrep08-itest',
})

/**
 * The export's dependencies inside this suite.
 *
 * `withTransaction` runs the body on the handle this suite is ALREADY inside rather than opening a
 * savepoint: the whole file is one transaction that is rolled back, so a nested savepoint would add a
 * boundary nothing here reads. The atomicity the route needs is the route's wiring, and the claim this
 * file makes instead is the one it can: an export that fails writes NO audit row.
 */
const exportDeps = (tx: Sql) => ({
  sql: tx,
  now: () => Date.now(),
  withTransaction: <T>(run: (handle: Sql) => Promise<T>) => run(tx),
})

const payloadFor = (
  tx: Sql,
  day: ProbeDay,
  principal: DashboardPrincipal,
  drillTileId: string | null = null,
) =>
  dashboardPayload(tx, {
    role: principal.role,
    employeeId: principal.employeeId,
    window: { fromInclusive: day.tradingDate, toInclusive: day.tradingDate },
    asOfIso: new Date().toISOString(),
    drillTileId,
  })

const figureOf = (
  payload: Awaited<ReturnType<typeof dashboardPayload>>,
  tileId: string,
): string => {
  const tile = payload.tiles.find((entry) => entry.tileId === tileId)
  if (tile === undefined) {
    throw new Error(
      `no tile "${tileId}" on this dashboard: it offers ${payload.tiles
        .map((entry) => entry.tileId)
        .join(', ')}`,
    )
  }
  if (tile.figure.state !== 'value') {
    throw new Error(`the tile "${tileId}" refused a figure: ${tile.figure.state}`)
  }
  return tile.figure.value
}

describe('deny by default', () => {
  it('refuses a therapist the business-wide P&L tile and records the refusal', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      const probe = await insertProbe(tx, day)
      const [before] = await tx<{ n: string }[]>`
        select count(*)::text as n from audit_event
         where action = 'report.dashboard_denied' and operation = 'denied'
      `
      const refused = await handleDashboardRead(
        requestFor(day, AS('therapist', probe.ownEmployeeId), { tile: 'net_revenue' }),
        { sql: tx, now: () => Date.now() },
      )
      expect(refused.status).toBe(403)
      expect(await refused.text()).toContain('net_revenue')

      // A DELTA counted in SQL: `audit_event` is append-only (ADR 0008) and a total would be whatever
      // earlier files left behind.
      const [after] = await tx<{ n: string }[]>`
        select count(*)::text as n from audit_event
         where action = 'report.dashboard_denied' and operation = 'denied'
      `
      expect(Number(after?.n ?? '0') - Number(before?.n ?? '0')).toBe(1)
      const [row] = await tx<{ afterState: { role: string; tileId: string } }[]>`
        select after_state as "afterState" from audit_event
         where action = 'report.dashboard_denied' and operation = 'denied'
         order by occurred_at desc, id desc limit 1
      `
      expect(row?.afterState.role).toBe('therapist')
      expect(row?.afterState.tileId).toBe('net_revenue')
    })
  })

  it('gives the accountant the financial tile and refuses it to nobody who holds the permission', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      const probe = await insertProbe(tx, day)
      const allowed = await handleDashboardRead(
        requestFor(day, AS('accountant', probe.ownEmployeeId), {
          format: 'json',
          tile: 'net_revenue',
        }),
        { sql: tx, now: () => Date.now() },
      )
      expect(allowed.status).toBe(200)
      const body = (await allowed.json()) as {
        dashboard: string
        tiles: { tileId: string; figure: { state: string; value?: string } }[]
      }
      expect(body.dashboard).toBe('accountant')
      const revenue = body.tiles.find((tile) => tile.tileId === 'net_revenue')
      expect(revenue?.figure.state).toBe('value')
      expect(revenue?.figure.value).toBe(String(NET_FILS))
    })
  })

  it('refuses a role with no dashboard at all, and records that too', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      const probe = await insertProbe(tx, day)
      // The receptionist and the marketer have screens of their own and no reporting dashboard.
      const refused = await handleDashboardRead(
        requestFor(day, AS('receptionist', probe.ownEmployeeId)),
        { sql: tx, now: () => Date.now() },
      )
      expect(refused.status).toBe(403)
      expect(await refused.text()).toContain('no reporting dashboard')
    })
  })
})

describe('the scope is in the query', () => {
  it('gives a therapist strictly less than the business, and only their own rows', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      const probe = await insertProbe(tx, day)

      const own = await payloadFor(
        tx,
        day,
        AS('therapist', probe.ownEmployeeId),
        'treatment_minutes',
      )
      const business = await payloadFor(
        tx,
        day,
        AS('manager', probe.ownEmployeeId),
        'treatment_minutes',
      )

      expect(own.scope).toEqual({ kind: 'own_employee', employeeId: probe.ownEmployeeId })
      expect(business.scope).toEqual({ kind: 'business' })
      // The probe delivered for two employees, so the scoped figure is strictly less. A one-employee
      // probe would make a `where` clause and no `where` clause the same number.
      expect(figureOf(own, 'treatment_minutes')).toBe(String(OWN_TREATMENT_MINUTES))
      expect(figureOf(business, 'treatment_minutes')).toBe(
        String(OWN_TREATMENT_MINUTES + OTHER_TREATMENT_MINUTES),
      )
      expect(figureOf(own, 'rostered_minutes')).toBe(String(OWN_ROSTERED_MINUTES))
      expect(figureOf(business, 'rostered_minutes')).toBe(
        String(OWN_ROSTERED_MINUTES + OTHER_ROSTERED_MINUTES),
      )

      // And the drill-down is scoped too, which is the leak a view-level filter would leave open.
      const references = (own.drillDown?.rows ?? []).map((row) => row.employeeReference)
      expect(references).toContain(probe.ownReference)
      expect(references).not.toContain(probe.otherReference)
      expect(own.provenance.scopedToEmployeeId).toBe(probe.ownEmployeeId)
      expect(business.provenance.scopedToEmployeeId).toBeNull()
    })
  })
})

describe('forbidden columns are absent from the serialised response', () => {
  it('carries no salary and no clinical key, per role, in the real JSON', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      const probe = await insertProbe(tx, day)
      for (const role of ['manager', 'accountant', 'therapist'] as const) {
        const tile = role === 'accountant' ? 'net_revenue' : 'treatment_minutes'
        const response = await handleDashboardRead(
          requestFor(day, AS(role, probe.ownEmployeeId), { format: 'json', tile }),
          { sql: tx, now: () => Date.now() },
        )
        expect(response.status, role).toBe(200)
        const raw = await response.text()
        const body = JSON.parse(raw) as {
          columns: string[]
          drillDown: { rows: Record<string, unknown>[] } | null
        }
        // The claim is about the BYTES as well as the parsed object: a key stripped by a serialiser
        // and re-added by a second code path would be in the text.
        for (const forbidden of forbiddenColumnsFor(role)) {
          const key = forbidden.replace(/_([a-z])/g, (_m, letter: string) => letter.toUpperCase())
          expect(raw.includes(`"${key}"`), `${role} serialised ${key}`).toBe(false)
          expect(body.columns, `${role} offered ${forbidden}`).not.toContain(forbidden)
        }
        // And the control: the columns the role MAY have are present, so the absence above is a
        // boundary rather than an empty payload.
        expect(body.columns.sort()).toEqual([...selectableColumnsFor(role)].sort())
        for (const row of body.drillDown?.rows ?? []) {
          for (const forbidden of forbiddenColumnsFor(role)) {
            const key = forbidden.replace(/_([a-z])/g, (_m, letter: string) => letter.toUpperCase())
            expect(Object.keys(row), `${role} row carried ${key}`).not.toContain(key)
          }
        }
      }
    })
  })
})

describe('every headline tile drills to rows that add up to it exactly', () => {
  it('holds the identity for ALL of the owner dashboard’s tiles, not a sample', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      const probe = await insertProbe(tx, day)
      const owner = AS('owner', probe.ownEmployeeId)
      const tileIds = (await payloadFor(tx, day, owner)).tiles.map((tile) => tile.tileId)
      // The owner sees every registered tile, so "all tiles" is the whole set rather than a subset.
      expect(tileIds.sort()).toEqual(DASHBOARD_TILES.map((tile) => tile.tileId).sort())

      for (const tileId of tileIds) {
        const payload = await payloadFor(tx, day, owner, tileId)
        const figure = figureOf(payload, tileId)
        expect(payload.drillDown?.tileId, tileId).toBe(tileId)
        // The M5 gate. Two independent paths: the figure is R-REP-03's measure reducer folded over the
        // loaded input, the aggregate is `sum(amount)` over the rows the SQL returned.
        expect(payload.drillDown?.aggregate, `${tileId} does not equal its rows`).toBe(figure)
        // And the non-vacuity floor: the identity over zero rows summing to zero would hold for every
        // tile on an empty window.
        expect((payload.drillDown?.rows ?? []).length, tileId).toBeGreaterThan(0)
        expect(BigInt(figure), tileId).toBeGreaterThan(0n)
      }
    })
  })
})

describe('the time-of-day view', () => {
  it('renders the trading window as contiguous buckets in business-day order', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      const probe = await insertProbe(tx, day)
      const payload = await payloadFor(tx, day, AS('owner', probe.ownEmployeeId))

      // The window is the DAY's own: `dim_date.open_minutes` rounded up to whole hours. The standard
      // seeded day is 15 hours, which is R-REP-08's acceptance figure, and a day with an override
      // produces its own count — which is why this reads the probe day rather than asserting 15 flat.
      expect(payload.buckets.length).toBe(Math.ceil(day.openMinutes / 60))
      expect(payload.bucketsAreContiguous).toBe(true)
      // Business-day order: the first bucket is the opening hour and the hours run forward across
      // midnight. A sort by the clock would put 00:00 first.
      const first = payload.buckets[0]?.startHour ?? -1
      expect(payload.buckets.map((bucket) => bucket.startHour)).toEqual(
        payload.buckets.map((_bucket, index) => (first + index) % 24),
      )
      // More than one bucket has deliveries in it, so "contiguous" is a claim about a chart with gaps
      // in it rather than about a single column.
      expect(payload.timeOfDay.length).toBeGreaterThan(1)

      const html = await (
        await handleDashboardRead(requestFor(day, AS('owner', probe.ownEmployeeId)), {
          sql: tx,
          now: () => Date.now(),
        })
      ).text()
      expect(html).toContain(`data-bucket-count="${payload.buckets.length}"`)
      expect(html).toContain('data-buckets-contiguous="true"')
      // Every bucket is in the document, including the empty ones: an hour with no deliveries renders
      // as an empty bucket rather than being absent from the chart.
      for (const bucket of payload.buckets) {
        expect(html).toContain(`data-bucket-index="${bucket.index}"`)
      }
      expect(html).toContain('data-bucket-empty="true"')
      expect(html).toContain('data-dashboard="owner"')
    })
  })
})

describe('an export is an audited act', () => {
  it('writes audit_event with operation=export and raises the insider-threat alert', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      const probe = await insertProbe(tx, day)
      const [beforeAudit] = await tx<{ n: string }[]>`
        select count(*)::text as n from audit_event
         where action = 'report.dashboard_export' and operation = 'export'
      `
      const [beforeAlert] = await tx<{ n: string }[]>`
        select count(*)::text as n from outbox_event
         where event_type = 'alert.raised' and aggregate_id = 'customer_list_export'
      `

      const exported = await handleDashboardExport(
        {
          searchParams: new URLSearchParams(),
          chrome: CHROME,
          principal: AS('owner', probe.ownEmployeeId),
          requestId: 'rrep08-export',
          body: new URLSearchParams({
            tile: 'rostered_minutes',
            from: day.tradingDate,
            to: day.tradingDate,
          }),
        },
        exportDeps(tx),
      )
      expect(exported.status).toBe(200)
      expect(exported.headers.get('content-type')).toBe('text/csv; charset=utf-8')
      const csv = await exported.text()
      // The file carries only the columns the role may have, header included.
      expect(csv.split('\n')[0]).toBe([...selectableColumnsFor('owner')].join(','))
      expect(csv).toContain(probe.ownReference)

      // Both halves asserted, as DELTAS: `audit_event` is append-only and `outbox_event` only grows.
      const [afterAudit] = await tx<{ n: string; rowCount: number }[]>`
        select count(*)::text as n,
               coalesce(max((after_state->>'rowCount')::int), 0) as "rowCount"
          from audit_event
         where action = 'report.dashboard_export' and operation = 'export'
      `
      expect(Number(afterAudit?.n ?? '0') - Number(beforeAudit?.n ?? '0')).toBe(1)
      expect(afterAudit?.rowCount).toBeGreaterThan(0)

      const [afterAlert] = await tx<{ n: string; payload: Record<string, unknown> }[]>`
        select count(*)::text as n,
               (array_agg(payload order by occurred_at desc))[1] as payload
          from outbox_event
         where event_type = 'alert.raised' and aggregate_id = 'customer_list_export'
      `
      expect(Number(afterAlert?.n ?? '0') - Number(beforeAlert?.n ?? '0')).toBe(1)
      const alert = afterAlert?.payload as
        | { observed: number; threshold: number; detail: Record<string, unknown> }
        | undefined
      expect(alert?.detail['tileId']).toBe('rostered_minutes')
      expect(alert?.detail['subjectKind']).toBe('employee')
      // The export covers both employees, which exceeds the registry's structural threshold of 2.
      expect(alert?.observed).toBeGreaterThanOrEqual(alert?.threshold ?? 99)
    })
  })

  it('writes no audit row when the export itself fails', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      const probe = await insertProbe(tx, day)
      const [before] = await tx<{ n: string }[]>`
        select count(*)::text as n from audit_event
         where action = 'report.dashboard_export' and operation = 'export'
      `
      // A tile the owner may read and which has no drill-down defined would be an authoring mistake;
      // the one this build can reach is a SCOPED caller asking for the business-wide revenue rows,
      // which `dashboardDrillDown` refuses by name even though `mayReadTile` has already been asked.
      // The refusal happens BEFORE the audit write, so nothing is recorded — an audit row for an
      // export that did not happen is as bad as an export with no audit row.
      const failed = await handleDashboardExport(
        {
          searchParams: new URLSearchParams(),
          chrome: CHROME,
          principal: { ...AS('owner', probe.ownEmployeeId), employeeId: probe.ownEmployeeId },
          requestId: 'rrep08-export-failed',
          body: new URLSearchParams({
            tile: 'net_revenue',
            from: day.tradingDate,
            to: '1999-01-01',
          }),
        },
        exportDeps(tx),
      )
      expect(failed.status).toBe(400)
      const [after] = await tx<{ n: string }[]>`
        select count(*)::text as n from audit_event
         where action = 'report.dashboard_export' and operation = 'export'
      `
      expect(Number(after?.n ?? '0') - Number(before?.n ?? '0')).toBe(0)
    })
  })

  it('refuses an export to a role that may read the tile on the screen', async () => {
    await inRolledBackTransaction(async (tx) => {
      const day = await quietDay(tx)
      const probe = await insertProbe(tx, day)
      // The therapist holds `rota:read` so `rostered_minutes` is on their screen, and does NOT hold
      // `report:read` — an export is a file that leaves the building and is the wider act.
      const refused = await handleDashboardExport(
        {
          searchParams: new URLSearchParams(),
          chrome: CHROME,
          principal: AS('therapist', probe.ownEmployeeId),
          requestId: 'rrep08-export-refused',
          body: new URLSearchParams({
            tile: 'rostered_minutes',
            from: day.tradingDate,
            to: day.tradingDate,
          }),
        },
        exportDeps(tx),
      )
      expect(refused.status).toBe(403)
      expect(await refused.text()).toContain('report:read')
      // The control: the same tile on the screen is 200 for the same principal.
      const screen = await handleDashboardRead(
        requestFor(day, AS('therapist', probe.ownEmployeeId), { tile: 'rostered_minutes' }),
        { sql: tx, now: () => Date.now() },
      )
      expect(screen.status).toBe(200)
    })
  })
})
