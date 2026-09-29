import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from './connection.ts'
import {
  type ColumnRow,
  type DefinitionRow,
  describeFinding,
  type IndexRow,
  mirroredViewColumns,
  moneyColumnsThatAreNotExact,
  REPORTING_SCHEMA_RULES,
  type RegistryRow,
  reportingSchemaFindings,
  viewsWhoseMirrorDisagrees,
  viewsWithoutAUsableUniqueIndex,
} from './reporting/schema-rules.ts'

/**
 * R-REP-01 — the reporting schema against real PostgreSQL.
 *
 * Every claim here is a claim about the database: a unique index that makes `REFRESH … CONCURRENTLY`
 * legal, a lock that lets a reader through, a CHECK that refuses a lunar date presented as settled, a
 * refusal that names the rule it enforces. None of it can be tested against a mock, and the two that
 * matter most — "the refresh does not block a read" and "two refreshes agree" — are properties of
 * PostgreSQL's own machinery rather than of any code in this repository.
 *
 * ## Why almost everything happens inside a rolled-back transaction
 *
 * `invoice`, `credit_note` and `journal_line` refuse DELETE for every role including the owner, so a
 * suite that writes one cannot tidy up row by row — the only legal removal is a TRUNCATE of the whole
 * family, which is a declaration in `suite-table-declarations.ts` and would empty tables this suite does
 * not own. A transaction that is always rolled back is the alternative that leaves nothing at all: the
 * documents go, and so do the materialised views' refreshed contents, because `REFRESH MATERIALIZED
 * VIEW` — concurrently or not — is transactional. Measured rather than assumed: see the control in "the
 * probe fixture leaves nothing behind".
 *
 * ## What it deliberately does NOT do
 *
 * It does not assert a total over `reporting.refresh_run`, which is append-only and only grows (brief
 * rule 9). Every assertion over it is a delta, read as "the runs since this test started".
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The Drizzle mirror, as source.
 *
 * Read rather than imported, which is `check-schema-drift.mjs`'s own choice and for its reason: the check
 * then does not depend on the ORM's runtime internals and keeps working across Drizzle versions. A
 * materialised view's columns are only reachable through a private `Symbol(drizzle:ViewBaseConfig)`, so
 * importing would have meant reaching into exactly that.
 */
const MIRROR_PATH = 'packages/db/src/schema/reporting.ts'

/** The seven views this unit ships, in refresh order. Written out so a lost one is a failure here. */
const SHIPPED_VIEWS = [
  'dim_date',
  'dim_service',
  'dim_staff',
  'dim_customer',
  'fact_appointment',
  'fact_sale',
  'fact_shift',
] as const

/**
 * The issuer snapshot a probe invoice carries.
 *
 * The values are `packages/db/src/repositories/invoice.itest.ts`'s, reused rather than re-invented. The
 * TRN is a fixture TRN and has to be: `legal_entity.trn` holds `TRN-PENDING-Y1-TRN`, which
 * `invoice_issuer_trn_is_fifteen_digits` and `invoice_issuer_trn_not_placeholder` both refuse, so an
 * invoice cannot be written at all until `Y1-TRN` is answered. `rights.itest.ts` records the same
 * constraint from the other side.
 */
const ISSUER = {
  legalName: 'BE RELAX SPA - L.L.C - O.P.C',
  tradingName: 'BE RELAX - Massage Center and Spa',
  trn: '100123456700003',
  addressSnapshot: '250 Al Meena Street\nTower Block A/B, M-Floor\nAl Zahiyah, Abu Dhabi',
  emirate: 'Abu Dhabi',
} as const

/** One treatment at 200.00 AED: gross 20000 fils, net 19048, VAT 952. `net + vat = gross` exactly. */
const GROSS_FILS = 20_000
const NET_FILS = 19_048
const VAT_FILS = 952

let sql: Sql
/** A second and third connection, so one session can HOLD a refresh while another reads. */
let holder: Sql
let reader: Sql

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  holder = createConnection({ url, max: 1 })
  reader = createConnection({ url, max: 1 })
  /*
    One real refresh before anything is read, and it is a fact about the schema rather than a convenience.

    The migration creates the views against an EMPTY `business_day` — `pnpm seed` runs afterwards and writes
    the 149 trading days — so on a freshly migrated and seeded database every view is populated with nothing
    until a pass runs. That is the contract (a materialised view is a cache and `reporting.refresh_all()` is
    the only thing that fills it), and it is also a trap: written without this, every assertion in this file
    passed on the worktree's long-lived database, where an earlier run had already refreshed, and would have
    failed in CI against a fresh one with `0` where `149` was expected. Found by rebuilding the database.

    It writes seven `reporting.refresh_run` rows, which stay: that table is append-only by design (ZY184)
    and every assertion this file makes about it is a delta.
  */
  await sql`select * from reporting.refresh_all('nightly')`
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await holder?.end({ timeout: 5 })
  await reader?.end({ timeout: 5 })
})

/** The SQLSTATE, constraint name and message of a rejected statement, or undefined fields if it was not. */
async function stateOf(
  run: () => Promise<unknown>,
): Promise<{ code?: string; constraint?: string; message?: string }> {
  try {
    await run()
    return {}
  } catch (error) {
    const failure = error as { code?: string; constraint_name?: string; message?: string }
    return {
      ...(failure.code === undefined ? {} : { code: failure.code }),
      ...(failure.constraint_name === undefined ? {} : { constraint: failure.constraint_name }),
      ...(failure.message === undefined ? {} : { message: failure.message }),
    }
  }
}

/** Thrown to abort a probe transaction, carrying whatever the body worked out. */
class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super('probe transaction rolled back on purpose')
  }
}

/**
 * Runs `body` in a transaction that is ALWAYS rolled back, and returns its value.
 *
 * The rollback is the cleanup. It is the only mechanism available for a suite that writes an invoice —
 * see the file header — and it also undoes the materialised-view refreshes the body performs, so the
 * database the next file sees is the one this file was handed.
 */
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
  /** 01:30 on the following calendar date: the instant 30 minutes before the session closes at 02:00. */
  readonly lateNightAt: string
  /** The calendar date, in the business zone, of {@link lateNightAt}. The trading date PLUS ONE. */
  readonly calendarDateOfLateNight: string
}

/**
 * A trading date from the middle of the seeded range, with the two instants that bound it.
 *
 * The middle rather than the first or last, so the date has neighbours on both sides — a probe on the
 * boundary would pass for a view that filed everything one day out in one direction.
 */
async function probeDay(handle: Sql = sql): Promise<ProbeDay> {
  const [row] = await handle<ProbeDay[]>`
    select trading_date::text                                            as "tradingDate",
           opens_at::text                                                as "opensAt",
           closes_at::text                                               as "closesAt",
           (closes_at - interval '30 minutes')::text                     as "lateNightAt",
           (((closes_at - interval '30 minutes') at time zone 'Asia/Dubai')::date)::text
                                                                         as "calendarDateOfLateNight"
      from business_day
     order by trading_date
     offset 70 limit 1
  `
  if (row === undefined) {
    throw new Error(
      'business_day holds fewer than 71 rows, so the seed has not run. `pnpm seed` writes 149 ' +
        '(docs/CONTRIBUTING-AGENT-BRIEF.md rule 24).',
    )
  }
  return row
}

interface ProbeRows {
  readonly appointmentId: string
  readonly invoiceId: string
  readonly creditNoteId: string
  readonly shiftId: string
  readonly employeeId: string
}

/**
 * One appointment, one invoice, one credit note against it and one rostered shift — all at 01:30 on the
 * trading date `day`, which is 01:30 the FOLLOWING calendar date.
 *
 * 01:30 is the whole point: it is inside the trading window that opened at 11:00 the previous morning, so
 * every one of these belongs to `day` and a derivation that truncated the instant would file all four
 * under `day + 1`.
 *
 * Only ever called inside {@link inRolledBackTransaction}.
 */
async function insertProbeRows(tx: Sql, day: ProbeDay): Promise<ProbeRows> {
  const [customer] = await tx<{ id: string }[]>`select id from customer order by id limit 1`
  const [employee] = await tx<{ id: string }[]>`select id from employee order by id limit 1`
  const [room] = await tx<
    { id: string }[]
  >`select id from rooms where is_bookable order by code limit 1`
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
  const [appointment] = await tx<{ id: string }[]>`
    insert into appointment (
      booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
      room_places, turnaround_minutes, therapist_buffer_minutes,
      gross_price_fils, net_fils, vat_fils
    ) values (
      ${booking?.id ?? ''}, ${day.tradingDate}::date, ${variant.id}, 'solo', ${employee.id},
      ${room.id},
      tstzrange(${day.lateNightAt}::timestamptz, ${day.closesAt}::timestamptz, '[)'),
      'completed', 1, 20, 10, ${GROSS_FILS}, ${NET_FILS}, ${VAT_FILS}
    ) returning id
  `

  // The invoice: issued at 01:30, supplied on `day`, and WRITTEN on the following calendar date — which is
  // 0026's own arrangement, three dates that are three different facts.
  const [invoice] = await tx<{ id: string }[]>`
    insert into invoice (
      document_kind, series_code, period_key, number, display_number,
      issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot, issuer_emirate,
      customer_id, customer_name_snapshot, issue_date, issue_trading_date, tax_point_date, issued_at,
      net_total, vat_total, gross_total
    ) values (
      'tax_invoice', 'TAX-INV', 'rrep01-probe', 1, 'TI-RREP01-PROBE-1',
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

  // The credit note, with the balanced reversal 0072 requires: dated on the note's own tax point, source
  // `reversal`, and crediting exactly the note's gross to the settlement account.
  const entryId = 'RREP01-PROBE-REVERSAL'
  await tx`
    insert into journal_entry (entry_id, entry_date, narrative, source)
    values (${entryId}, ${day.tradingDate}::date, 'R-REP-01 probe credit note', 'reversal')
  `
  await tx`
    insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
    values (${entryId}, 1, '4010', ${GROSS_FILS}, 0),
           (${entryId}, 2, ${sql`credit_note_settlement_account_code()`}, 0, ${GROSS_FILS})
  `
  const [creditNote] = await tx<{ id: string }[]>`
    insert into credit_note (
      invoice_id, series_code, period_key, number, display_number,
      issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot, issuer_emirate,
      customer_id, customer_name_snapshot, issue_date, issue_trading_date, tax_point_date, issued_at,
      net_total, vat_total, gross_total, reason, journal_entry_id
    ) values (
      ${invoice?.id ?? ''}, 'CR-NOTE', 'rrep01-probe', 1, 'CN-RREP01-PROBE-1',
      ${ISSUER.legalName}, ${ISSUER.tradingName}, ${ISSUER.trn}, ${ISSUER.addressSnapshot},
      ${ISSUER.emirate},
      ${customer.id}, 'Customer 0042',
      ${day.calendarDateOfLateNight}::date, ${day.tradingDate}::date, ${day.tradingDate}::date,
      ${day.lateNightAt}::timestamptz,
      ${NET_FILS}, ${VAT_FILS}, ${GROSS_FILS}, 'R-REP-01 probe', ${entryId}
    ) returning id
  `
  await tx`
    insert into credit_note_line (
      credit_note_id, line_no, invoice_line_no, description_en, quantity, unit_gross_fils,
      vat_rate_bp, line_net_fils, line_vat_fils
    ) values (
      ${creditNote?.id ?? ''}, 1, 1, 'Asian Normal Massage', 1, ${GROSS_FILS}, 500,
      ${NET_FILS}, ${VAT_FILS}
    )
  `

  // A shift running 23:00 to 02:00: ONE row under ONE trading date, which is the claim 0076 makes about
  // the same quantity for a cash session.
  const [shift] = await tx<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (
      ${day.tradingDate}::date,
      tstzrange(${day.closesAt}::timestamptz - interval '3 hours', ${day.closesAt}::timestamptz, '[)'),
      'r-rep-01 probe late'
    ) returning id
  `
  await tx`
    insert into shift_assignment (shift_id, employee_id) values (${shift?.id ?? ''}, ${employee.id})
  `

  return {
    appointmentId: appointment?.id ?? '',
    invoiceId: invoice?.id ?? '',
    creditNoteId: creditNote?.id ?? '',
    shiftId: shift?.id ?? '',
    employeeId: employee.id,
  }
}

/** The `reporting` schema's materialised views, from `pg_catalog`. */
async function catalogueViews(handle: Sql = sql): Promise<readonly string[]> {
  const rows = await handle<{ relation: string }[]>`
    select c.relname as relation
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'reporting' and c.relkind = 'm'
     order by c.relname
  `
  return rows.map((row) => row.relation)
}

async function catalogueIndexes(handle: Sql = sql): Promise<readonly IndexRow[]> {
  return handle<IndexRow[]>`
    select c.relname                        as relation,
           i.relname                        as "indexName",
           x.indisunique                    as "isUnique",
           (x.indpred is not null)          as "isPartial",
           (x.indexprs is not null)         as "isExpression"
      from pg_catalog.pg_index x
      join pg_catalog.pg_class c on c.oid = x.indrelid
      join pg_catalog.pg_class i on i.oid = x.indexrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'reporting' and c.relkind = 'm'
     order by c.relname, i.relname
  `
}

async function catalogueColumns(handle: Sql = sql): Promise<readonly ColumnRow[]> {
  return handle<ColumnRow[]>`
    select c.relname                                    as relation,
           a.attname                                    as column,
           format_type(a.atttypid, a.atttypmod)         as type
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where n.nspname = 'reporting' and c.relkind in ('m', 'r')
     order by c.relname, a.attnum
  `
}

async function catalogueDefinitions(handle: Sql = sql): Promise<readonly DefinitionRow[]> {
  return handle<DefinitionRow[]>`
    select matviewname as relation, definition
      from pg_catalog.pg_matviews
     where schemaname = 'reporting'
     order by matviewname
  `
}

async function registry(handle: Sql = sql): Promise<readonly RegistryRow[]> {
  return handle<RegistryRow[]>`
    select view_name as "viewName", kind, business_day_column as "businessDayColumn"
      from reporting.materialised_view
     order by refresh_rank
  `
}

describe('acceptance — every materialised view carries a unique index, so CONCURRENTLY succeeds', () => {
  it('enumerates the views from pg_catalog and finds every one of the seven', async () => {
    // Enumerated from the catalogue and compared against a written list, in that order. A test that only
    // enumerated would pass on a schema that had lost a view; a test that only read the list would pass
    // on a schema that never had one.
    expect(await catalogueViews()).toEqual([...SHIPPED_VIEWS].sort())
  })

  it('fails naming any view with no usable unique index', async () => {
    const findings = viewsWithoutAUsableUniqueIndex(
      await catalogueViews(),
      await catalogueIndexes(),
    )
    expect(findings.map(describeFinding)).toEqual([])
  })

  it('the control: the same predicate over the same catalogue DOES report a view stripped of its index', async () => {
    // Without this, a rule whose `indisunique` join had stopped matching would report no findings for
    // ever and the case above would pass over a schema no refresh could touch (ADR 0003).
    const indexes = await catalogueIndexes()
    const withoutDimDate = indexes.filter((index) => index.relation !== 'dim_date')
    const findings = viewsWithoutAUsableUniqueIndex(await catalogueViews(), withoutDimDate)
    expect(findings.map((finding) => finding.relation)).toEqual(['dim_date'])
    expect(findings[0]?.rule).toBe(REPORTING_SCHEMA_RULES.uniqueIndex)
  })

  it('and the database agrees: a CONCURRENT refresh of every registered view succeeds', async () => {
    // The index assertion is structural. This is the thing it is FOR — and it runs against all seven,
    // because a unique index over the wrong columns satisfies the catalogue check and fails here.
    const rows = await inRolledBackTransaction(
      (tx) => tx<{ viewName: string; ranConcurrently: boolean }[]>`
        select view_name as "viewName", ran_concurrently as "ranConcurrently"
          from reporting.refresh_all('nightly')
      `,
    )
    expect(rows.map((row) => row.viewName)).toEqual([...SHIPPED_VIEWS])
    expect(rows.every((row) => row.ranConcurrently)).toBe(true)
  })
})

describe('acceptance — all money in the reporting schema is bigint fils', () => {
  it('finds no float, double precision or scaled numeric column anywhere in the schema', async () => {
    const findings = moneyColumnsThatAreNotExact(await catalogueColumns())
    expect(findings.map(describeFinding)).toEqual([])
  })

  it('examined the money columns rather than an empty set', async () => {
    const columns = await catalogueColumns()
    const fils = columns.filter((column) => column.column.endsWith('_fils'))
    // Seven: list_gross_fils, and gross/net/vat on each of the two facts that carry money.
    expect(fils.length).toBeGreaterThanOrEqual(7)
    expect(fils.every((column) => column.type === 'bigint')).toBe(true)
    expect(columns.length).toBeGreaterThan(80)
  })

  it('the control: the same predicate reports a fils column the database returned as numeric', async () => {
    const columns = await catalogueColumns()
    const money = columns.find((column) => column.column.endsWith('_fils'))
    expect(money).toBeDefined()
    const findings = moneyColumnsThatAreNotExact([
      ...columns.filter((column) => column !== money),
      { ...(money as ColumnRow), type: 'numeric' },
    ])
    expect(findings.map((finding) => finding.rule)).toEqual([
      REPORTING_SCHEMA_RULES.moneyIsBigintFils,
    ])
  })
})

describe('acceptance — no view reads the clock and no fact truncates an instant', () => {
  it('reports nothing across all four rules over the live catalogue', async () => {
    const findings = reportingSchemaFindings({
      views: await catalogueViews(),
      indexes: await catalogueIndexes(),
      columns: await catalogueColumns(),
      definitions: await catalogueDefinitions(),
      registry: await registry(),
      mirrorSource: readFileSync(MIRROR_PATH, 'utf8'),
    })
    expect(findings.map(describeFinding)).toEqual([])
  })

  it('read seven real definitions, so the clock and truncation rules had something to scan', async () => {
    const definitions = await catalogueDefinitions()
    expect(definitions.map((row) => row.relation)).toEqual([...SHIPPED_VIEWS].sort())
    expect(definitions.every((row) => row.definition.includes('SELECT'))).toBe(true)
  })
})

describe('acceptance — dim_date covers the seeded trading range', () => {
  it('holds exactly one row per business_day and nothing else', async () => {
    const [row] = await sql<{ dimRows: string; days: string; min: string; max: string }[]>`
      select (select count(*)::text from reporting.dim_date)       as "dimRows",
             (select count(*)::text from business_day)             as days,
             (select min(business_day)::text from reporting.dim_date) as min,
             (select max(business_day)::text from reporting.dim_date) as max
    `
    expect(row?.dimRows).toBe(row?.days)
    expect(Number(row?.dimRows)).toBeGreaterThan(100)
    const [bounds] = await sql<{ min: string; max: string }[]>`
      select min(trading_date)::text as min, max(trading_date)::text as max from business_day
    `
    expect(row?.min).toBe(bounds?.min)
    expect(row?.max).toBe(bounds?.max)
  })

  it('carries the trading window as minutes, from business_day rather than from a constant', async () => {
    // 11:00-02:00 is 900 minutes. Asserted against `business_day.duration_seconds` rather than against
    // 900, because the figure is Y8-hours and a constant here would have to be edited when it is answered.
    const [row] = await sql<{ mismatched: string; distinct: string }[]>`
      select count(*) filter (
               where d.open_minutes <> (bd.duration_seconds / 60)
             )::text                                        as mismatched,
             count(distinct d.open_minutes)::text           as distinct
        from reporting.dim_date d
        join business_day bd on bd.trading_date = d.business_day
    `
    expect(row?.mismatched).toBe('0')
    // And the column is not uniformly null, which a broken expression would also make "not mismatched".
    expect(Number(row?.distinct)).toBeGreaterThan(0)
  })
})

describe('acceptance — the ramadan and public-holiday flags, and a lunar holiday is provisional', () => {
  it('raises the flags for the dates an observance covers, and only those', async () => {
    const result = await inRolledBackTransaction(async (tx) => {
      const [days] = await tx<{ gregorian: string; lunar: string; ramadan: string }[]>`
        select (select trading_date::text from business_day order by trading_date offset 10 limit 1)
                 as gregorian,
               (select trading_date::text from business_day order by trading_date offset 20 limit 1)
                 as lunar,
               (select trading_date::text from business_day order by trading_date offset 30 limit 1)
                 as ramadan
      `
      // A CONFIRMED, Gregorian-dated holiday. It is what makes the lunar assertion below non-vacuous:
      // without it, "every lunar holiday is provisional" is also true of a schema where every holiday is.
      await tx`
        insert into reporting.calendar_observance
          (kind, name, date_basis, starts_on, ends_on, is_provisional, source)
        values ('public_holiday', 'R-REP-01 probe fixed-date holiday', 'gregorian',
                ${days?.gregorian ?? ''}::date, ${days?.gregorian ?? ''}::date, false,
                'r-rep-01 probe')
      `
      await tx`
        insert into reporting.calendar_observance
          (kind, name, date_basis, starts_on, ends_on, is_provisional, open_question_id, source)
        values ('public_holiday', 'R-REP-01 probe lunar holiday', 'lunar',
                ${days?.lunar ?? ''}::date, ${days?.lunar ?? ''}::date, true, 'Y9-holiday-calendar',
                'r-rep-01 probe')
      `
      await tx`
        insert into reporting.calendar_observance
          (kind, name, date_basis, starts_on, ends_on, is_provisional, open_question_id, source)
        values ('ramadan', 'R-REP-01 probe Ramadan', 'lunar',
                ${days?.ramadan ?? ''}::date, ${days?.ramadan ?? ''}::date, true,
                'Y9-holiday-calendar', 'r-rep-01 probe')
      `
      await tx`select reporting.refresh('dim_date', 'on_demand')`

      const flags = await tx<
        {
          businessDay: string
          isPublicHoliday: boolean
          names: string | null
          provisional: boolean
          lunar: boolean
          isRamadan: boolean
          ramadanProvisional: boolean
        }[]
      >`
        select business_day::text                as "businessDay",
               is_public_holiday                 as "isPublicHoliday",
               public_holiday_names              as names,
               public_holiday_is_provisional     as provisional,
               public_holiday_is_lunar_dated     as lunar,
               is_ramadan                        as "isRamadan",
               ramadan_is_provisional            as "ramadanProvisional"
          from reporting.dim_date
         where business_day in (
                 ${days?.gregorian ?? ''}::date, ${days?.lunar ?? ''}::date,
                 ${days?.ramadan ?? ''}::date
               )
         order by business_day
      `
      const [counts] = await tx<{ flagged: string; lunarNotProvisional: string; total: string }[]>`
        select count(*) filter (where is_public_holiday)::text                     as flagged,
               count(*) filter (
                 where public_holiday_is_lunar_dated and not public_holiday_is_provisional
               )::text                                                             as "lunarNotProvisional",
               count(*)::text                                                      as total
          from reporting.dim_date
      `
      return { days, flags, counts }
    })

    const byDay = new Map(result.flags.map((row) => [row.businessDay, row]))
    const gregorian = byDay.get(result.days?.gregorian ?? '')
    const lunar = byDay.get(result.days?.lunar ?? '')
    const ramadan = byDay.get(result.days?.ramadan ?? '')

    expect(gregorian?.isPublicHoliday).toBe(true)
    expect(gregorian?.lunar).toBe(false)
    // The control that makes "every lunar holiday is provisional" a claim rather than a tautology.
    expect(gregorian?.provisional).toBe(false)

    expect(lunar?.isPublicHoliday).toBe(true)
    expect(lunar?.lunar).toBe(true)
    expect(lunar?.provisional).toBe(true)
    expect(lunar?.names).toContain('lunar holiday')

    expect(ramadan?.isRamadan).toBe(true)
    expect(ramadan?.ramadanProvisional).toBe(true)
    // Ramadan is not a public holiday: two separate observances, two separate flags.
    expect(ramadan?.isPublicHoliday).toBe(false)

    // Over the WHOLE dimension, not only the three probe dates: no lunar-dated holiday reads as settled.
    expect(result.counts?.lunarNotProvisional).toBe('0')
    expect(Number(result.counts?.flagged)).toBe(2)
    expect(Number(result.counts?.total)).toBeGreaterThan(100)
  })

  it('the database refuses a lunar-dated observance that is not provisional, by name', async () => {
    const failure = await stateOf(
      () => sql`
        insert into reporting.calendar_observance
          (kind, name, date_basis, starts_on, ends_on, is_provisional, source)
        values ('public_holiday', 'R-REP-01 probe settled lunar date', 'lunar',
                '2026-06-01'::date, '2026-06-01'::date, false, 'r-rep-01 probe')
      `,
    )
    expect(failure.constraint).toBe('calendar_observance_lunar_is_provisional')
  })

  it('the control: the same row as a GREGORIAN date is accepted', async () => {
    // Without this the refusal above is satisfied by a table that refuses every insert.
    const accepted = await inRolledBackTransaction(
      (tx) => tx<{ id: string }[]>`
        insert into reporting.calendar_observance
          (kind, name, date_basis, starts_on, ends_on, is_provisional, source)
        values ('public_holiday', 'R-REP-01 probe settled fixed date', 'gregorian',
                '2026-06-01'::date, '2026-06-01'::date, false, 'r-rep-01 probe')
        returning id
      `,
    )
    expect(accepted).toHaveLength(1)
  })

  it('ships with no observance row at all, because every date is Y9-holiday-calendar', async () => {
    // The mechanism is this unit's; the dates are not. A seeded lunar date would be indistinguishable
    // from a confirmed one (brief rule 15), which is why this assertion is here rather than a fixture.
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from reporting.calendar_observance
    `
    expect(row?.n).toBe('0')
  })
})

describe('acceptance — a 01:30 sale and a 01:30 appointment land on the PREVIOUS business_day', () => {
  it('files all three facts under the trading date, not the calendar date of the instant', async () => {
    const day = await probeDay()
    const result = await inRolledBackTransaction(async (tx) => {
      const probe = await insertProbeRows(tx, day)
      await tx`select * from reporting.refresh_all('on_demand')`

      const [appointment] = await tx<
        { businessDay: string; calendarDate: string; minutes: number }[]
      >`
        select business_day::text                                          as "businessDay",
               ((starts_at at time zone 'Asia/Dubai')::date)::text         as "calendarDate",
               treatment_minutes                                           as minutes
          from reporting.fact_appointment
         where appointment_id = ${probe.appointmentId}::uuid
      `
      const [sale] = await tx<{ businessDay: string; calendarDate: string; netFils: string }[]>`
        select business_day::text                                          as "businessDay",
               ((issued_at at time zone 'Asia/Dubai')::date)::text         as "calendarDate",
               net_fils::text                                              as "netFils"
          from reporting.fact_sale
         where document_id = ${probe.invoiceId}::uuid
      `
      const [credit] = await tx<
        { businessDay: string; netFils: string; corrects: string | null }[]
      >`
        select business_day::text            as "businessDay",
               net_fils::text                as "netFils",
               corrects_document_id::text    as corrects
          from reporting.fact_sale
         where document_id = ${probe.creditNoteId}::uuid
      `
      const [shift] = await tx<{ businessDay: string; minutes: number }[]>`
        select business_day::text as "businessDay", rostered_minutes as minutes
          from reporting.fact_shift
         where shift_id = ${probe.shiftId}::uuid
      `
      const [netRevenue] = await tx<{ net: string }[]>`
        select coalesce(sum(net_fils), 0)::text as net
          from reporting.fact_sale
         where business_day = ${day.tradingDate}::date
      `
      return { appointment, sale, credit, shift, netRevenue, probe }
    })

    // The appointment: filed under the trading date, and the calendar date of its own start is the NEXT
    // one. Asserting both is what makes this the business-day rule rather than a coincidence.
    expect(result.appointment?.businessDay).toBe(day.tradingDate)
    expect(result.appointment?.calendarDate).toBe(day.calendarDateOfLateNight)
    expect(result.appointment?.calendarDate).not.toBe(day.tradingDate)
    expect(result.appointment?.minutes).toBe(30)

    // The sale: the same two assertions over the same instant.
    expect(result.sale?.businessDay).toBe(day.tradingDate)
    expect(result.sale?.calendarDate).toBe(day.calendarDateOfLateNight)
    expect(result.sale?.calendarDate).not.toBe(day.tradingDate)
    expect(result.sale?.netFils).toBe(String(NET_FILS))

    // The credit note is on the same trading date, negated, and names the invoice it corrects.
    expect(result.credit?.businessDay).toBe(day.tradingDate)
    expect(result.credit?.netFils).toBe(String(-NET_FILS))
    expect(result.credit?.corrects).toBe(result.probe.invoiceId)

    // So net revenue for the day is zero: the sale and its credit note cancel. An invoices-only fact
    // would answer 19,048 fils, which is the figure this shape exists to stop.
    expect(result.netRevenue?.net).toBe('0')

    // The shift ran 23:00 to 02:00 — one row, one trading date, 180 minutes.
    expect(result.shift?.businessDay).toBe(day.tradingDate)
    expect(result.shift?.minutes).toBe(180)
  })

  it('the probe fixture leaves nothing behind — the rollback undoes the refresh too', async () => {
    // Not a formality. If a rolled-back `REFRESH MATERIALIZED VIEW CONCURRENTLY` left its rows, this
    // suite would hand every later file three facts containing a probe invoice, and the failure would
    // surface in a file that had done nothing wrong (brief rule 12).
    const [row] = await sql<{ appointments: string; sales: string; shifts: string; obs: string }[]>`
      select (select count(*)::text from reporting.fact_appointment)       as appointments,
             (select count(*)::text from reporting.fact_sale)              as sales,
             (select count(*)::text from reporting.fact_shift)             as shifts,
             (select count(*)::text from reporting.calendar_observance)    as obs
    `
    expect(row).toEqual({ appointments: '0', sales: '0', shifts: '0', obs: '0' })
    const [documents] = await sql<{ invoices: string; notes: string }[]>`
      select (select count(*)::text from invoice where display_number like 'TI-RREP01%')  as invoices,
             (select count(*)::text from credit_note where display_number like 'CN-RREP01%') as notes
    `
    expect(documents).toEqual({ invoices: '0', notes: '0' })
  })
})

describe('acceptance — refresh is idempotent', () => {
  it('produces identical row checksums for every view across two consecutive refreshes', async () => {
    const day = await probeDay()
    const result = await inRolledBackTransaction(async (tx) => {
      // With the probe rows in place, so the three facts are NON-EMPTY: two refreshes of an empty view
      // agree trivially, and three of the seven are empty on a seeded database.
      await insertProbeRows(tx, day)
      const first = await tx<{ viewName: string; rowCount: number; checksum: string }[]>`
        select view_name as "viewName", row_count as "rowCount", checksum
          from reporting.refresh_all('nightly')
      `
      const second = await tx<{ viewName: string; rowCount: number; checksum: string }[]>`
        select view_name as "viewName", row_count as "rowCount", checksum
          from reporting.refresh_all('nightly')
      `
      return { first, second }
    })

    expect(result.second).toEqual(result.first)
    expect(result.first.map((row) => row.viewName)).toEqual([...SHIPPED_VIEWS])
    // Every view has rows, so no checksum is the empty sentinel and none of the comparisons is vacuous.
    expect(result.first.every((row) => row.rowCount > 0)).toBe(true)
    expect(result.first.every((row) => row.checksum !== 'empty')).toBe(true)
    expect(new Set(result.first.map((row) => row.checksum)).size).toBe(SHIPPED_VIEWS.length)
  })

  it('the control: a changed base row DOES change the checksum', async () => {
    // Without this, "two refreshes agree" is satisfied by a checksum that is the same constant for
    // everything, which is exactly what a broken `string_agg` would produce.
    const day = await probeDay()
    const result = await inRolledBackTransaction(async (tx) => {
      const before = await tx<{ checksum: string }[]>`
        select checksum from reporting.refresh('fact_appointment', 'on_demand')
      `
      await insertProbeRows(tx, day)
      const after = await tx<{ checksum: string }[]>`
        select checksum from reporting.refresh('fact_appointment', 'on_demand')
      `
      return { before: before[0]?.checksum, after: after[0]?.checksum }
    })
    expect(result.before).toBe('empty')
    expect(result.after).not.toBe(result.before)
    expect(result.after).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('acceptance — an on-demand refresh does not block reads', () => {
  it('lets a concurrent SELECT through while a CONCURRENT refresh is in flight', async () => {
    // Proved by the LOCK rather than by a race. The holder starts a concurrent refresh and does not
    // commit, so it is still holding whatever lock that form takes when the reader arrives; a timing
    // test on a 149-row view would measure the machine (brief rule 23).
    await holder`begin`
    try {
      await holder`select * from reporting.refresh('dim_date', 'on_demand')`
      await reader`set statement_timeout = '2000ms'`
      const [row] = await reader<{ n: string }[]>`
        select count(*)::text as n from reporting.dim_date
      `
      expect(Number(row?.n)).toBeGreaterThan(100)
    } finally {
      await holder`rollback`
      await reader`set statement_timeout = 0`
    }
  })

  it('the control: a NON-concurrent refresh blocks the same reader, so the case above is the CONCURRENTLY', async () => {
    // The whole acceptance line rests on `CONCURRENTLY` being what lets the reader through. If a plain
    // refresh let it through too, the case above would be true of a schema with no unique index at all
    // and the rule would be worth nothing.
    await holder`begin`
    try {
      await holder.unsafe('refresh materialized view reporting.dim_date')
      await reader`set statement_timeout = '600ms'`
      const failure = await stateOf(() => reader`select count(*) from reporting.dim_date`)
      // 57014: canceling statement due to statement timeout — the reader was still waiting on the lock.
      expect(failure.code).toBe('57014')
    } finally {
      await holder`rollback`
      await reader`set statement_timeout = 0`
    }
  })
})

describe('the five refusals', () => {
  it('ZY181: a materialised view the registry does not declare', async () => {
    const failure = await stateOf(() =>
      inRolledBackTransaction(async (tx) => {
        await tx.unsafe(
          'create materialized view reporting.rrep01_probe_unregistered as select 1 as x',
        )
        await tx`select reporting.assert_views_are_refreshable()`
      }),
    )
    expect(failure.code).toBe('ZY181')
    expect(failure.message).toContain('rrep01_probe_unregistered')
  })

  it('ZY181, the other direction: a registry row naming no view', async () => {
    const failure = await stateOf(() =>
      inRolledBackTransaction(async (tx) => {
        await tx`
          insert into reporting.materialised_view (view_name, kind, grain, refresh_rank)
          values ('rrep01_probe_missing', 'fact', 'a view that does not exist', 99)
        `
        await tx`select reporting.assert_views_are_refreshable()`
      }),
    )
    expect(failure.code).toBe('ZY181')
    expect(failure.message).toContain('rrep01_probe_missing')
  })

  it('ZY182: a registered materialised view with no unique index', async () => {
    const failure = await stateOf(() =>
      inRolledBackTransaction(async (tx) => {
        await tx.unsafe(
          'create materialized view reporting.rrep01_probe_unindexed as select 1 as x',
        )
        await tx`
          insert into reporting.materialised_view
            (view_name, kind, grain, refresh_rank, business_day_column)
          values ('rrep01_probe_unindexed', 'dimension', 'one probe row', 98, null)
        `
        await tx`select reporting.assert_views_are_refreshable()`
      }),
    )
    expect(failure.code).toBe('ZY182')
    expect(failure.message).toContain('rrep01_probe_unindexed')
    expect(failure.message).toContain('ACCESS EXCLUSIVE')
  })

  it('ZY183: a refresh of a name that is not a registered view', async () => {
    const failure = await stateOf(() => sql`select reporting.refresh('drop table invoice')`)
    expect(failure.code).toBe('ZY183')
    // The message lists what IS registered, because "no such view" with no list is a dead end.
    expect(failure.message).toContain('dim_date')
  })

  it('ZY184: refresh_run refuses UPDATE and DELETE', async () => {
    // ONE transaction per refusal, and that is not tidiness: a refused statement aborts its transaction,
    // so the second probe in a shared one comes back `25P02 in_failed_sql_transaction` — which is a
    // non-ZY184 failure that reads exactly like a missing trigger. Found by writing it the other way.
    const refused = async (statement: (tx: Sql) => Promise<unknown>) =>
      stateOf(() =>
        inRolledBackTransaction(async (tx) => {
          await tx`select * from reporting.refresh('dim_staff', 'on_demand')`
          await statement(tx)
        }),
      )

    // Both, separately. The conventions gate refuses a table documented as raising on both that only
    // carries one trigger, and the reason it exists is that the pair is where the defect hides.
    const update = await refused(
      (tx) => tx`update reporting.refresh_run set row_count = 0 where view_name = 'dim_staff'`,
    )
    const remove = await refused(
      (tx) => tx`delete from reporting.refresh_run where view_name = 'dim_staff'`,
    )
    expect(update.code).toBe('ZY184')
    expect(remove.code).toBe('ZY184')
    expect(update.message).toContain('UPDATE')
    expect(remove.message).toContain('DELETE')
  })

  it('ZY185: a sale keyed on a date the trading calendar does not hold', async () => {
    const failure = await stateOf(() =>
      inRolledBackTransaction(async (tx) => {
        const [customer] = await tx<{ id: string }[]>`select id from customer order by id limit 1`
        // 1970 is outside the seeded range by decades, so `business_day` cannot hold it. `tax_point_date`
        // has no foreign key — which is the whole reason ZY185 exists.
        await tx`
          insert into invoice (
            document_kind, series_code, period_key, number, display_number,
            issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot,
            issuer_emirate, customer_id, customer_name_snapshot, issue_date, tax_point_date,
            net_total, vat_total, gross_total
          ) values (
            'tax_invoice', 'TAX-INV', 'rrep01-offcal', 1, 'TI-RREP01-OFFCAL-1',
            ${ISSUER.legalName}, ${ISSUER.tradingName}, ${ISSUER.trn}, ${ISSUER.addressSnapshot},
            ${ISSUER.emirate}, ${customer?.id ?? null}, 'Customer 0042',
            '1970-01-02'::date, '1970-01-01'::date, ${NET_FILS}, ${VAT_FILS}, ${GROSS_FILS}
          )
        `
        await tx`
          insert into invoice_line (
            invoice_id, line_no, description_en, quantity, unit_gross_fils, vat_rate_bp,
            line_net_fils, line_vat_fils
          )
          select id, 1, 'Asian Normal Massage', 1, ${GROSS_FILS}, 500, ${NET_FILS}, ${VAT_FILS}
            from invoice where display_number = 'TI-RREP01-OFFCAL-1'
        `
        await tx`select * from reporting.refresh('fact_sale', 'on_demand')`
      }),
    )
    expect(failure.code).toBe('ZY185')
    expect(failure.message).toContain('1970-01-01')
    expect(failure.message).toContain('fact_sale')
  })

  it('the control: the same invoice on a real trading date refreshes cleanly', async () => {
    // Without this, ZY185 above is satisfied by a refresh that refuses every sale.
    const day = await probeDay()
    const rows = await inRolledBackTransaction(async (tx) => {
      await insertProbeRows(tx, day)
      return tx<{ rowCount: number }[]>`
        select row_count as "rowCount" from reporting.refresh('fact_sale', 'on_demand')
      `
    })
    expect(rows[0]?.rowCount).toBe(2)
  })
})

describe('the registry is the thing the refresh walks', () => {
  it('declares every shipped view exactly once, with a grain sentence and a rank', async () => {
    const rows = await registry()
    expect(rows.map((row) => row.viewName)).toEqual([...SHIPPED_VIEWS])
    const detail = await sql<{ viewName: string; grain: string; rank: number; kind: string }[]>`
      select view_name as "viewName", grain, refresh_rank as rank, kind
        from reporting.materialised_view order by refresh_rank
    `
    expect(detail.every((row) => row.grain.length > 30)).toBe(true)
    expect(detail.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(detail.filter((row) => row.kind === 'fact').map((row) => row.viewName)).toEqual([
      'fact_appointment',
      'fact_sale',
      'fact_shift',
    ])
  })

  it('names a business_day column for every fact and for dim_date', async () => {
    const rows = await registry()
    const dated = rows.filter((row) => row.businessDayColumn !== null)
    expect(dated.map((row) => row.viewName)).toEqual([
      'dim_date',
      'fact_appointment',
      'fact_sale',
      'fact_shift',
    ])
    expect(dated.every((row) => row.businessDayColumn === 'business_day')).toBe(true)
  })

  it('records a refresh_run row per view, as a DELTA over an append-only table', async () => {
    // `refresh_run` only grows (brief rule 9), so the bar is "runs since this test started" and never a
    // total — the same subtraction `settings-store.itest.ts` got wrong through a capped reader.
    const [before] = await sql<
      { n: string }[]
    >`select count(*)::text as n from reporting.refresh_run`
    const runs = await inRolledBackTransaction(async (tx) => {
      await tx`select * from reporting.refresh_all('nightly')`
      const [after] = await tx<{ n: string }[]>`
        select count(*)::text as n from reporting.refresh_run
      `
      return Number(after?.n) - Number(before?.n)
    })
    expect(runs).toBe(SHIPPED_VIEWS.length)
  })
})

describe('acceptance — the seven views are outside db:drift, so the suite compares them itself', () => {
  it('holds the Drizzle mirror equal to pg_attribute for every materialised view, both ways', async () => {
    // `pnpm db:drift` enumerates `relkind in ('r','p')`, so a materialised view is invisible to it in both
    // directions and only the two BASE tables in this schema are drift-checked. Without this case the seven
    // views would be the only relations in the repository whose shape nothing compares to anything, and a
    // caller writing from the mirror would compile against columns the database does not have.
    const findings = viewsWhoseMirrorDisagrees(
      mirroredViewColumns(readFileSync(MIRROR_PATH, 'utf8')),
      await catalogueViews(),
      await catalogueColumns(),
    )
    expect(findings.map(describeFinding)).toEqual([])
  })

  it('read a mirror block per view, so the comparison was not against an empty parse', async () => {
    const mirror = mirroredViewColumns(readFileSync(MIRROR_PATH, 'utf8'))
    expect([...mirror.keys()].sort()).toEqual([...SHIPPED_VIEWS].sort())
    const columns = await catalogueColumns()
    for (const view of SHIPPED_VIEWS) {
      const mirrored = mirror.get(view) ?? []
      expect(mirrored.length, `${view} has mirrored columns`).toBe(
        columns.filter((column) => column.relation === view).length,
      )
    }
  })

  it('the control: a renamed mirror column IS reported', async () => {
    const renamed = readFileSync(MIRROR_PATH, 'utf8').replace(
      "openMinutes: integer('open_minutes')",
      "openMinutes: integer('open_minute')",
    )
    const findings = viewsWhoseMirrorDisagrees(
      mirroredViewColumns(renamed),
      await catalogueViews(),
      await catalogueColumns(),
    )
    expect(findings.map((finding) => finding.rule)).toEqual([
      REPORTING_SCHEMA_RULES.mirrorMatchesCatalogue,
      REPORTING_SCHEMA_RULES.mirrorMatchesCatalogue,
    ])
  })
})
