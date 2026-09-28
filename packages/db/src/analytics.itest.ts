import { FUNNEL_STAGES, FUNNEL_TERMINAL_STAGE } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from './connection.ts'
import { SCHEMA_VERSION } from './index.ts'

/**
 * Migration 0096 — the `analytics` schema, its monthly partitions and the 90-day raw retention
 * (A-FIRST-01), proved against a real database.
 *
 * ## Why almost every case here runs inside a transaction that is rolled back
 *
 * Two reasons, and the second is the one that would have cost a whole suite. This unit's subject is DDL:
 * creating partitions, detaching them, dropping them. A case that left a partition behind would change what
 * every later case in this file sees, and a case that DROPPED one of the real partitions would take the
 * schema's ability to accept rows with it — the retention simulation below advances a frozen clock 400 days
 * and drops every partition on disk on the way. PostgreSQL rolls DDL back inside a transaction, so
 * `rolledBack` gives each case a real, catalogue-visible partition that is gone when it returns.
 *
 * And the brief's rule: a suite may delete only rows it created. `analytics.event` cannot be deleted from
 * at all except as `berelax_retention`, so a rollback is not merely tidier here, it is the only cleanup the
 * table permits.
 *
 * ## What is asserted against `pg_catalog` rather than against a return value, and why
 *
 * `analytics.ensure_partitions` returns how many partitions it created. A function that returned 0 while
 * quietly creating nothing would satisfy a return-value assertion perfectly, which is the acceptance line's
 * own point — so the idempotence claim is made by comparing the SET of partitions in `pg_inherits` before
 * and after, and the return value is corroboration. The same applies to the retention pass: its report says
 * what it did, and `pg_inherits` says what is true.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

/** The private SQLSTATEs 0096 raises. ZY061-ZY066 of the ZY061-ZY070 band allocated to this unit. */
const UNCOVERED_MONTH = 'ZY061'
const NO_RETENTION_POLICY = 'ZY062'
const POLICY_FOR_A_MISSING_RELATION = 'ZY063'
const UNREADABLE_PARTITION_BOUND = 'ZY064'
const EVENT_IS_APPEND_ONLY = 'ZY065'
const NEGATIVE_LOOK_AHEAD = 'ZY066'
/** PostgreSQL's own. The grant layer answers with this one, which is why it is not one of ours. */
const INSUFFICIENT_PRIVILEGE = '42501'

/** A marker only this file throws, so a rollback cannot be mistaken for a failure. */
const ROLLBACK = 'A-FIRST-01 rolled this fixture back'

/**
 * Runs `body` inside a transaction and rolls it back, returning whatever `body` returned.
 *
 * The throw-and-catch is how `sql.begin` is made to roll back a transaction that did not fail: postgres.js
 * commits unless the callback rejects. The marker is compared exactly, so a genuine failure inside `body`
 * propagates rather than being swallowed as an intended rollback — which is the mistake that turns a suite
 * like this into one that passes whatever the database does.
 *
 * The result is collected in an array rather than a `let`, and the length is CHECKED. A body that never
 * reached its return would otherwise hand the caller `undefined`, and an assertion on `undefined.something`
 * reads as a failure in the case rather than as a fixture that did not run — which is one more way for a
 * suite to report on something it did not do.
 */
async function rolledBack<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  const captured: T[] = []
  try {
    await sql.begin(async (tx) => {
      captured.push(await body(tx as unknown as Sql))
      throw new Error(ROLLBACK)
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error
  }
  if (captured.length !== 1) {
    throw new Error(
      `rolledBack captured ${captured.length} results and expected exactly 1, so the fixture body did ` +
        'not run to completion and whatever asserts next would be asserting on nothing.',
    )
  }
  return captured[0] as T
}

/** The SQLSTATE and message of a rejected promise, or a marker that it was not rejected at all. */
async function stateOf(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await promise
    return { code: undefined, message: 'the statement succeeded' }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return {
      code: typeof code === 'string' ? code : undefined,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Every partition of an analytics parent, by name, from the catalogue. */
async function partitionsOf(tx: Sql, parent: string): Promise<readonly string[]> {
  const rows = await tx<{ name: string }[]>`
    select c.relname as name
      from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
     where i.inhparent = ${`analytics.${parent}`}::regclass
     order by c.relname
  `
  return rows.map((row) => row.name)
}

interface RetentionAction {
  relation: string
  action: string
  detail: string
}

async function runRetention(tx: Sql, asOf: string): Promise<readonly RetentionAction[]> {
  const rows = await tx<RetentionAction[]>`
    select relation, action, detail from analytics.run_retention(${asOf}::timestamptz)
  `
  return rows
}

/** A trading date the seed's `business_day` table actually holds, so the session FK can be exercised. */
async function seededTradingDate(tx: Sql): Promise<string> {
  const [row] = await tx<{ trading_date: string }[]>`
    select to_char(max(trading_date), 'YYYY-MM-DD') as trading_date from business_day
  `
  const date = row?.trading_date
  if (date === undefined || date === null) {
    throw new Error(
      'business_day is empty, so nothing in this file that writes a session could be about the ' +
        'trading-date key. Run `pnpm seed` — the seeder writes 149 trading days.',
    )
  }
  return date
}

// ------------------------------------------------------------------------------------------------
// Acceptance 1: the schema exists, and its column types are what money and time require
// ------------------------------------------------------------------------------------------------

interface ColumnRow {
  table_name: string
  column_name: string
  type_name: string
  domain_name: string | null
  base_type: string
}

/**
 * Every column of every base table in `analytics`, with its type, its domain if it has one, and the type
 * underneath the domain.
 *
 * pg_catalog rather than `information_schema.columns`, for the reason `privacy-coverage.ts` records paying
 * for: information_schema is filtered to what the current role holds a privilege on, so a privilege change
 * would silently shrink the corpus and every assertion below would pass over a smaller schema. Partitions
 * are excluded because a partition cannot have a column type its parent does not; what is asserted here is
 * the declaration.
 */
async function analyticsColumns(tx: Sql = sql): Promise<readonly ColumnRow[]> {
  return await tx<ColumnRow[]>`
    select c.relname                                        as table_name,
           a.attname                                        as column_name,
           t.typname                                        as type_name,
           case when t.typtype = 'd' then t.typname end     as domain_name,
           coalesce(base.typname, t.typname)                as base_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      join pg_type t on t.oid = a.atttypid
      left join pg_type base on base.oid = t.typbasetype
     where n.nspname = 'analytics'
       and c.relkind in ('r', 'p')
       and not c.relispartition
     order by c.relname, a.attnum
  `
}

describe('the analytics schema', () => {
  it('exists, and SCHEMA_VERSION names the migration that created it', async () => {
    const [row] = await sql<{ present: boolean }[]>`
      select exists (select 1 from pg_namespace where nspname = 'analytics') as present
    `
    expect(row?.present).toBe(true)
    // The ledger and the migration cannot disagree about which number this schema arrived under, and gate
    // case 90c holds SCHEMA_VERSION equal to the newest migration on disk from the other side.
    expect(SCHEMA_VERSION).toBe(96)
  })

  it('holds the nine tables this unit creates, and a retention policy for every one of them', async () => {
    const rows = await sql<{ name: string; policy: string | null }[]>`
      select c.relname as name, p.policy
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        left join analytics.retention_policy p on p.relation_name = c.relname
       where n.nspname = 'analytics' and c.relkind in ('r', 'p') and not c.relispartition
       order by c.relname
    `
    expect(rows.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'attribution',
        'daily_funnel',
        'daily_source_revenue',
        'daily_traffic',
        'event',
        'funnel_step',
        'retention_policy',
        'session',
        'visitor',
      ]),
    )
    /*
     * `arrayContaining` and not equality, with the closed claim made the other way round: every base table
     * in the schema has a policy row. A-FIRST-08 and A-FIRST-09 add to this schema, and a strict list here
     * would make their work red for adding what they are supposed to add — while an exact-list assertion
     * would say nothing about whether the new table was CLASSIFIED, which is the thing that matters and the
     * thing the retention pass refuses on. So this asserts both directions of the real invariant instead.
     */
    const unpolicied = rows.filter((r) => r.policy === null).map((r) => r.name)
    expect(
      unpolicied,
      'every base table in the analytics schema needs a row in analytics.retention_policy — ' +
        'analytics.run_retention refuses the whole pass (ZY062) rather than retaining it by omission',
    ).toEqual([])
    expect(rows.length).toBeGreaterThanOrEqual(9)
    // `whatsapp_ref` is deliberately absent although the unit summary lists it: 0079 already created
    // `public.whatsapp_ref`, and a second one would be a second statement of one fact. Asserted so the
    // absence reads as a decision rather than as something forgotten.
    const [elsewhere] = await sql<{ nspname: string }[]>`
      select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relname = 'whatsapp_ref' and c.relkind = 'r'
    `
    expect(elsewhere?.nspname).toBe('public')
  })

  it('has no naive timestamp anywhere in it, and every _at column is timestamptz', async () => {
    const columns = await analyticsColumns()
    const naive = columns.filter((c) => c.base_type === 'timestamp')
    expect(
      naive.map((c) => `${c.table_name}.${c.column_name}`),
      'a naive timestamp stores whatever the session timezone was, which for a business day running ' +
        '11:00-02:00 moves a measurement between trading dates',
    ).toEqual([])

    const instants = columns.filter((c) => c.column_name.endsWith('_at'))
    const wrong = instants.filter((c) => c.base_type !== 'timestamptz')
    expect(wrong.map((c) => `${c.table_name}.${c.column_name} is ${c.base_type}`)).toEqual([])
    // The control. An empty corpus would satisfy both assertions above, which is ADR 0002's whole subject:
    // these floors are well under the real figures and far above zero, so a query that stopped matching
    // fails here rather than reporting that all is well.
    expect(columns.length).toBeGreaterThan(50)
    expect(instants.length).toBeGreaterThan(10)
  })

  it('holds money as bigint fils and nothing as numeric, float or money', async () => {
    const columns = await analyticsColumns()
    const money = columns.filter((c) => c.column_name.endsWith('_fils'))
    // The three columns on daily_source_revenue, and the assertion is by NAME so a fourth added without a
    // domain fails rather than being averaged into a count. Sorted, because the query is ordered by
    // `attnum` — declaration order — and pinning the expectation to that would make a reordered CREATE
    // TABLE a failing test about nothing.
    expect(money.map((c) => `${c.table_name}.${c.column_name}`).sort()).toEqual([
      'daily_source_revenue.gross_fils',
      'daily_source_revenue.net_fils',
      'daily_source_revenue.vat_fils',
    ])
    for (const column of money) {
      expect(column.domain_name, `${column.column_name} must be the fils domain`).toBe('fils')
      expect(column.base_type, `${column.column_name} must be bigint underneath`).toBe('int8')
    }
    const inexact = columns.filter((c) =>
      ['numeric', 'float4', 'float8', 'money'].includes(c.base_type),
    )
    expect(
      inexact.map((c) => `${c.table_name}.${c.column_name} is ${c.base_type}`),
      'ADR 0007: amounts are integer fils. A float or a numeric on a money column is the float-money ' +
        'mistake in a different costume, and `money` carries a locale-dependent scale',
    ).toEqual([])
  })

  it('the type scan DOES see a bad column — the known-bad fixture', async () => {
    // Without this the three cases above are satisfied by a query that returns nothing. A real table, in
    // the real schema, inside a transaction that is rolled back — so the scan is shown to be able to fail
    // on exactly the two things it claims to refuse.
    const found = await rolledBack(async (tx) => {
      await tx`
        create table analytics.__gate_fixture_types (
          bad_at timestamp not null,
          amount_fils numeric(12, 2) not null,
          ratio double precision not null
        )
      `
      const columns = await analyticsColumns(tx)
      return {
        naive: columns.filter((c) => c.base_type === 'timestamp').map((c) => c.column_name),
        inexact: columns
          .filter((c) => ['numeric', 'float4', 'float8', 'money'].includes(c.base_type))
          .map((c) => c.column_name),
        money: columns
          .filter((c) => c.column_name.endsWith('_fils') && c.domain_name !== 'fils')
          .map((c) => c.column_name),
      }
    })
    expect(found.naive).toContain('bad_at')
    expect(found.inexact).toEqual(expect.arrayContaining(['amount_fils', 'ratio']))
    expect(found.money).toEqual(['amount_fils'])
    // And the fixture is gone, so the case left nothing behind for the next one to trip over.
    const after = await analyticsColumns()
    expect(after.some((c) => c.table_name === '__gate_fixture_types')).toBe(false)
  })

  it('keys the session and all three rollups on business_day rather than on a calendar date', async () => {
    // The 11:00-02:00 window crosses midnight, so 01:30 belongs to the PREVIOUS trading date and
    // `date(occurred_at)` is the wrong answer. A real foreign key is what makes that a property of the
    // database: a date the trading calendar does not hold is refused rather than rolled up on the wrong day.
    const rows = await sql<{ table_name: string; definition: string }[]>`
      select c.relname as table_name, pg_get_constraintdef(k.oid) as definition
        from pg_constraint k
        join pg_class c on c.oid = k.conrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'analytics' and k.contype = 'f'
         and k.confrelid = 'public.business_day'::regclass
       order by c.relname
    `
    expect(rows.map((r) => r.table_name)).toEqual([
      'daily_funnel',
      'daily_source_revenue',
      'daily_traffic',
      'session',
    ])
    for (const row of rows)
      expect(row.definition).toContain('REFERENCES business_day(trading_date)')

    // And the key BITES: a session on a date business_day does not hold is refused.
    const refused = await rolledBack(async (tx) => {
      const [visitor] = await tx<{ visitor_id: string }[]>`
        insert into analytics.visitor (first_seen_at, last_seen_at)
        values (now(), now()) returning visitor_id
      `
      return await stateOf(tx`
        insert into analytics.session
          (visitor_id, started_at, last_event_at, trading_date, landing_path, device_kind, breakpoint, bot)
        values (${visitor?.visitor_id as string}, now(), now(), '1999-01-01', '/', 'mobile', 'sm', false)
      `)
    })
    expect(refused.code).toBe('23503')
    expect(refused.message).toContain('session_trading_date_fk')

    // The control: the same insert on a date the seed DOES hold succeeds, so the refusal above is about
    // the date and not about the statement being wrong in some other way.
    const accepted = await rolledBack(async (tx) => {
      const date = await seededTradingDate(tx)
      const [visitor] = await tx<{ visitor_id: string }[]>`
        insert into analytics.visitor (first_seen_at, last_seen_at)
        values (now(), now()) returning visitor_id
      `
      return await stateOf(tx`
        insert into analytics.session
          (visitor_id, started_at, last_event_at, trading_date, landing_path, device_kind, breakpoint, bot)
        values (${visitor?.visitor_id as string}, now(), now(), ${date}, '/', 'mobile', 'sm', false)
      `)
    })
    expect(accepted.code).toBeUndefined()
  })

  it('carries no customer or booking reference in any column, which is A-FIRST-08s to add', async () => {
    // Not a style preference. A `customer_id` here enters C-CRM-05's merge participant registry and
    // C-CRM-10's erasure catalogue on the same commit, and an unclassified column in the latter REFUSES
    // every customer erasure. A-FIRST-08's acceptance line is what names attribution onto customer and
    // booking, so the column arrives with the unit that owns the decision.
    const columns = await analyticsColumns()
    const subjectish = columns.filter((c) =>
      /^(.*_)?(customer|contact|booking|invoice)_id$/.test(c.column_name),
    )
    expect(subjectish.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([])
    // The control: the pattern DOES match the shape it is looking for, so an empty result means the schema
    // is clean rather than that the regex is.
    expect(/^(.*_)?(customer|contact|booking|invoice)_id$/.test('contact_customer_id')).toBe(true)
    expect(columns.length).toBeGreaterThan(50)
  })

  it('stores the funnel steps in A-FIRST-02s order, pinned against FUNNEL_STAGES', async () => {
    const rows = await sql<{ label: string }[]>`
      select e.enumlabel as label
        from pg_enum e
        join pg_type t on t.oid = e.enumtypid
        join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'analytics' and t.typname = 'funnel_step_name'
       order by e.enumsortorder
    `
    /*
     * Against `FUNNEL_STAGES` and not against a list written here, which is the whole point of putting the
     * funnel in the database as an ENUM rather than as a CHECK.
     *
     * A-FIRST-02 landed its taxonomy while this unit was in flight, so for one commit the eight members
     * existed twice — once in `packages/shared/src/analytics/taxonomy.ts` as the tuple everything else is
     * derived from, and once in migration 0096. This assertion is what makes the second one a MIRROR rather
     * than a second opinion: a member added, renamed or reordered on either side alone is a red test. It is
     * the shape `whatsappRefCaptureOutcome` is pinned to `REF_CAPTURE_OUTCOMES` in, and it is available to
     * `packages/db` because the tuple is in `@berelax/shared`, which is the one package this one may import.
     */
    expect(rows.map((r) => r.label)).toEqual([...FUNNEL_STAGES])
    // The order is the measurement — "conversion is paid / landing, never booking_created / landing" is a
    // statement about which step is LAST — so the terminal member is asserted separately and is also
    // derived, because `FUNNEL_TERMINAL_STAGE` is the tuple's last element rather than a second opinion
    // about which stage ends the funnel.
    expect(rows.at(-1)?.label).toBe(FUNNEL_TERMINAL_STAGE)
    // The control: the tuple this compared against is not empty, so an upstream module that stopped
    // exporting its members fails here rather than making the equality above pass over two empty lists.
    expect(rows).toHaveLength(8)
  })
})

// ------------------------------------------------------------------------------------------------
// Acceptance 2: RANGE partitioned on occurred_at, and the job that keeps a month ahead
// ------------------------------------------------------------------------------------------------

describe('the monthly partitions', () => {
  it('range-partitions event and funnel_step on occurred_at, and nothing else', async () => {
    const rows = await sql<{ name: string; key: string }[]>`
      select c.relname as name, pg_get_partkeydef(c.oid) as key
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'analytics' and c.relkind = 'p'
       order by c.relname
    `
    expect(rows.map((r) => `${r.name}: ${r.key}`)).toEqual([
      'event: RANGE (occurred_at)',
      'funnel_step: RANGE (occurred_at)',
    ])
  })

  it('creates next months partition and is idempotent, asserted against pg_catalog', async () => {
    const outcome = await rolledBack(async (tx) => {
      // A month far enough out that no earlier case and no cron run can have created it, so "it appeared"
      // is unambiguous.
      const month = '2031-07-01'
      const before = await partitionsOf(tx, 'event')
      const [first] = await tx<{ created: number }[]>`
        select analytics.ensure_partitions(${month}::date, 0) as created
      `
      const afterFirst = await partitionsOf(tx, 'event')
      const [second] = await tx<{ created: number }[]>`
        select analytics.ensure_partitions(${month}::date, 0) as created
      `
      const afterSecond = await partitionsOf(tx, 'event')
      return {
        before,
        afterFirst,
        afterSecond,
        firstCount: first?.created,
        secondCount: second?.created,
        funnel: await partitionsOf(tx, 'funnel_step'),
      }
    })

    // The catalogue, not the return value: a function that returned 0 while creating nothing would satisfy
    // a return-value assertion perfectly, which is what the acceptance line is guarding against.
    expect(outcome.before).not.toContain('event_2031_07')
    expect(outcome.afterFirst).toContain('event_2031_07')
    // Idempotent: the SET of partitions is unchanged by the second run.
    expect(outcome.afterSecond).toEqual(outcome.afterFirst)
    // The return values corroborate, and the first one is the control that makes the second mean something:
    // without it, `secondCount === 0` is satisfied by a function that never creates anything. TWO and not
    // one, because the pass reads its parents from `pg_class` — `event` and `funnel_step` each got the
    // month, which is the half of the design a list in the function would have got wrong.
    expect(outcome.firstCount).toBe(2)
    expect(outcome.secondCount).toBe(0)
    // Every partitioned table in the schema, from pg_class, and not a list: funnel_step got its month too.
    expect(outcome.funnel).toContain('funnel_step_2031_07')
  })

  it('creates the month it is asked for and the three after it, with month-wide bounds', async () => {
    const bounds = await rolledBack(async (tx) => {
      await tx`select analytics.ensure_partitions('2032-01-01'::date, 3)`
      return await tx<{ name: string; bound: string }[]>`
        select c.relname as name, pg_get_expr(c.relpartbound, c.oid) as bound
          from pg_inherits i
          join pg_class c on c.oid = i.inhrelid
         where i.inhparent = 'analytics.event'::regclass and c.relname like 'event_2032%'
         order by c.relname
      `
    })
    expect(bounds.map((b) => b.name)).toEqual([
      'event_2032_01',
      'event_2032_02',
      'event_2032_03',
      'event_2032_04',
    ])
    // [first of the month, first of the next) — half-open, which is what makes the retention pass's upper
    // bound a value no row in the partition can reach.
    expect(bounds[0]?.bound).toBe(
      "FOR VALUES FROM ('2032-01-01 00:00:00+00') TO ('2032-02-01 00:00:00+00')",
    )
  })

  it('refuses a negative look-ahead rather than creating nothing and reporting success', async () => {
    const refused = await stateOf(sql`select analytics.ensure_partitions('2033-01-01'::date, -1)`)
    expect(refused.code).toBe(NEGATIVE_LOOK_AHEAD)
    expect(refused.message).toContain('reporting success')
  })
})

// ------------------------------------------------------------------------------------------------
// The trap: the first day of a month nobody created a partition for
// ------------------------------------------------------------------------------------------------

describe('a month with no partition', () => {
  /**
   * The answer is a NAMED refusal, and the mechanism is the one thing in 0096 worth knowing.
   *
   * Measured rather than assumed: a row inserted into a partitioned parent is ROUTED FIRST and the trigger
   * then fires on the partition it landed in, so tuple routing raises `23514 no partition of relation
   * "event" found for row` before any BEFORE INSERT trigger on the parent has run. A guard on the parent is
   * unreachable code on exactly the day it is needed. Each raw parent therefore has a DEFAULT partition —
   * against 0005's advice and for 0005's reason — whose trigger raises ZY061 and stores nothing.
   */
  it('refuses the insert with ZY061, naming the month and the function to run', async () => {
    for (const table of ['event', 'funnel_step']) {
      const refused = await rolledBack(async (tx) =>
        table === 'event'
          ? await stateOf(tx`
              insert into analytics.event (session_id, occurred_at, event_name, path, client_event_id)
              values (gen_random_uuid(), '2034-05-15T09:00:00Z', 'landing', '/', 'c-2034-05')
            `)
          : await stateOf(tx`
              insert into analytics.funnel_step (session_id, step, occurred_at)
              values (gen_random_uuid(), 'landing', '2034-05-15T09:00:00Z')
            `),
      )
      expect(refused.code, `${table} must refuse with ZY061`).toBe(UNCOVERED_MONTH)
      // The message has to be actionable, which is the whole difference from 23514: the month, the parent
      // and the remedy. Asserted by content rather than by code alone, because a code with an unreadable
      // message is an error nobody reads by a different route.
      expect(refused.message).toContain('2034-05-15')
      expect(refused.message).toContain(`analytics.${table}`)
      expect(refused.message).toContain('analytics.ensure_partitions()')
    }
  })

  it('accepts the same insert once the partition exists, and routes it there', async () => {
    // The control, and it is not a formality: without it the refusal above is satisfied by a table that
    // refuses every insert, which would pass the ZY061 assertion and mean nothing.
    const landed = await rolledBack(async (tx) => {
      await tx`select analytics.ensure_partitions('2034-05-01'::date, 0)`
      const [row] = await tx<{ partition: string }[]>`
        insert into analytics.event (session_id, occurred_at, event_name, path, client_event_id)
        values (gen_random_uuid(), '2034-05-15T09:00:00Z', 'landing', '/', 'c-2034-05')
        returning tableoid::regclass::text as partition
      `
      return row?.partition
    })
    expect(landed).toBe('analytics.event_2034_05')
  })

  it('keeps the default partitions permanently empty, which is what makes 0005s objection inapplicable', async () => {
    for (const parent of ['event', 'funnel_step']) {
      // The relation name is not a parameter in SQL, and these two are literals in this file rather than
      // anything a caller supplies — so `unsafe` here is the only spelling available and carries no input.
      const [row] = await sql.unsafe<{ rows: string }[]>(
        `select count(*)::text as rows from analytics.${parent}_default`,
      )
      expect(row?.rows, `analytics.${parent}_default must hold nothing`).toBe('0')
      // And it is empty because something refuses every row, not because nothing has been inserted yet.
      const [trigger] = await sql<{ tgname: string }[]>`
        select t.tgname from pg_trigger t
         where t.tgrelid = ${`analytics.${parent}_default`}::regclass and not t.tgisinternal
           and t.tgname like '%refuse_uncovered_insert'
      `
      expect(trigger?.tgname).toBe(`${parent}_default_refuse_uncovered_insert`)
    }
  })
})

// ------------------------------------------------------------------------------------------------
// Acceptance 3: retention drops only the partitions past the window
// ------------------------------------------------------------------------------------------------

describe('the 90-day raw retention', () => {
  it('states the window once, and it is 90 days', async () => {
    const [row] = await sql<{ days: number }[]>`select analytics.raw_retention_days() as days`
    expect(row?.days).toBe(90)
  })

  it('drops exactly one of a 91-day-old and an 89-day-old partition', async () => {
    /*
     * The fixture's instants are relative to the real clock, and that is a correctness requirement rather
     * than convenience. The live partitions run from the first of the current month to three months after
     * it, so an `as_of` placed at a fixed future date would put every one of them past the window and the
     * pass would — correctly — drop them all, which is what this case first asserted against and is why it
     * read as "dropped six" instead of "dropped one".
     *
     * Anchored on `now()`, the arithmetic can never collide: `as_of - 89 days` is at least 58 days before
     * the first of the current month whatever the date, so neither fixture partition can overlap a live one
     * and no live one can fall due.
     */
    const asOfMs = Date.now()
    const at = (daysAgo: number) => new Date(asOfMs - daysAgo * 86_400_000).toISOString()
    const asOf = new Date(asOfMs).toISOString()
    const outcome = await rolledBack(async (tx) => {
      // Upper bounds exactly 91 and 89 days before the instant. Deliberately day-wide rather than
      // month-wide: 91 and 89 days before one instant can fall inside one calendar month, so a fixture
      // built out of monthly partitions could not put one on each side of the cutoff at all. It is also
      // why the pass reads bounds from the catalogue instead of parsing the partition's NAME.
      await tx.unsafe(`
        create table analytics.event_old_91 partition of analytics.event
          for values from ('${at(92)}') to ('${at(91)}')
      `)
      await tx.unsafe(`
        create table analytics.event_old_89 partition of analytics.event
          for values from ('${at(90)}') to ('${at(89)}')
      `)
      await tx`
        insert into analytics.event (session_id, occurred_at, event_name, path, client_event_id)
        values (gen_random_uuid(), ${at(91.5)}::timestamptz, 'landing', '/', 'old-91')
      `
      await tx`
        insert into analytics.event (session_id, occurred_at, event_name, path, client_event_id)
        values (gen_random_uuid(), ${at(89.5)}::timestamptz, 'landing', '/', 'old-89')
      `
      const before = await partitionsOf(tx, 'event')
      const report = await runRetention(tx, asOf)
      const after = await partitionsOf(tx, 'event')
      const [survivor] = await tx<{ ids: string }[]>`
        select count(*)::text as ids from analytics.event where client_event_id = 'old-89'
      `
      return { before, after, report, survivingRows: survivor?.ids }
    })

    // The catalogue is the assertion. Exactly one of the two went, and it is the older one.
    expect(outcome.before).toContain('event_old_91')
    expect(outcome.before).toContain('event_old_89')
    expect(outcome.after).not.toContain('event_old_91')
    expect(outcome.after).toContain('event_old_89')
    // And ONLY that one: every other partition on the parent survived, so "drops exactly one" is a claim
    // about the whole table rather than about the two the fixture named.
    expect(outcome.after).toEqual(outcome.before.filter((name) => name !== 'event_old_91'))
    // The 89-day-old partition's row is still readable through the parent, which is the half of "kept" that
    // a catalogue check alone does not cover: a detached-but-undropped partition would pass the assertion
    // above and answer nothing.
    expect(outcome.survivingRows).toBe('1')

    const dropped = outcome.report.filter((r) => r.action === 'dropped_partition')
    expect(dropped.map((r) => r.detail.split(',')[0])).toEqual(['event_old_91'])
    /*
     * The report names the partition, its bound and the cutoff it was judged against — the three figures a
     * person asking "why did that go" needs, and the reason the detail is a sentence rather than a count.
     *
     * The NAME is asserted because it was wrong: `regclass::text` resolves an oid through the catalogue
     * every time it is rendered, so a detail string built after the DROP printed the bare oid — `3828561,
     * upper bound …` — and the one line in the report that says which partition went named nothing a person
     * could read. Found by running the pass and reading its output, which is the only way a defect in a log
     * line is ever found.
     */
    expect(dropped[0]?.detail).toMatch(/^event_old_91, upper bound \d{4}-\d{2}-\d{2} /)
    expect(dropped[0]?.detail).toContain('cutoff ')
    // The one that stayed is REPORTED as kept rather than omitted: a pass that listed only what it removed
    // would be indistinguishable from a pass that had stopped running.
    const kept = outcome.report.filter(
      (r) => r.action === 'kept_partition' && r.detail.startsWith('event_old_89'),
    )
    expect(kept).toHaveLength(1)
  })

  it('drops a partition whose upper bound IS the cutoff, because every row in it is past the window', async () => {
    // The boundary the `<=` in the pass is about, and the one day a month it can matter. A partition ending
    // exactly 90 days back holds nothing later than an instant just before that bound, so it is entirely
    // outside the window; `<` would keep it for another month and nothing would say why.
    const asOfMs = Date.now()
    const at = (daysAgo: number) => new Date(asOfMs - daysAgo * 86_400_000).toISOString()
    const outcome = await rolledBack(async (tx) => {
      await tx.unsafe(`
        create table analytics.event_exactly_90 partition of analytics.event
          for values from ('${at(91)}') to ('${at(90)}')
      `)
      await runRetention(tx, new Date(asOfMs).toISOString())
      return await partitionsOf(tx, 'event')
    })
    expect(outcome).not.toContain('event_exactly_90')
    // The control: the live partitions are all still there, so "dropped" above is about the boundary rather
    // than about a pass that removes everything it is shown.
    expect(outcome.length).toBeGreaterThan(1)
  })

  it('never drops the guarded default partition, and says so in its report', async () => {
    const report = await rolledBack(async (tx) => await runRetention(tx, new Date().toISOString()))
    const guarded = report.filter((r) => r.action === 'guarded_default_partition')
    expect(guarded.map((r) => r.relation).sort()).toEqual(['event', 'funnel_step'])
    // Dropping it would turn the named ZY061 refusal back into 23514, so it is reported rather than
    // silently skipped — the pass is seen to have looked at it.
    const after = await partitionsOf(sql, 'event')
    expect(after).toContain('event_default')
  })

  it('purges the unpartitioned raw rows past the window, oldest table first', async () => {
    /*
     * Asserted on the ids this case created and never on a total, which is brief rule 12's lesson: a test
     * that assumes it holds the only rows in a table passes until another unit lands and then fails on
     * somebody else's branch. Nothing writes to this schema today, and that is exactly when the assumption
     * is cheapest to bake in and hardest to find later.
     */
    const asOfMs = Date.now()
    const at = (daysAgo: number) => new Date(asOfMs - daysAgo * 86_400_000).toISOString()
    const outcome = await rolledBack(async (tx) => {
      const date = await seededTradingDate(tx)
      const newSession = async (daysAgo: number): Promise<{ visitor: string; session: string }> => {
        const [visitor] = await tx<{ visitor_id: string }[]>`
          insert into analytics.visitor (first_seen_at, last_seen_at)
          values (${at(daysAgo)}::timestamptz, ${at(daysAgo)}::timestamptz) returning visitor_id
        `
        const [session] = await tx<{ session_id: string }[]>`
          insert into analytics.session
            (visitor_id, started_at, last_event_at, trading_date, landing_path, device_kind, breakpoint,
             bot)
          values (${visitor?.visitor_id as string}, ${at(daysAgo)}::timestamptz,
                  ${at(daysAgo)}::timestamptz, ${date}, '/', 'mobile', 'sm', false)
          returning session_id
        `
        return { visitor: visitor?.visitor_id as string, session: session?.session_id as string }
      }

      const old = await newSession(120)
      await tx`
        insert into analytics.attribution
          (session_id, basis, source, medium, resolver_version, resolved_at)
        values (${old.session}, 'direct', 'direct', 'none', 'v1', ${at(120)}::timestamptz)
      `
      // A second, RECENT visitor and session, so the purge is shown to be about the age rather than about
      // the tables being emptied.
      const recent = await newSession(1)
      await tx`
        insert into analytics.attribution
          (session_id, basis, source, medium, resolver_version, resolved_at)
        values (${recent.session}, 'utm', 'google', 'cpc', 'v1', ${at(1)}::timestamptz)
      `

      const report = await runRetention(tx, new Date(asOfMs).toISOString())
      const [survivors] = await tx<
        {
          old_visitor: string
          old_session: string
          old_attribution: string
          new_visitor: string
          new_session: string
          new_attribution: string
        }[]
      >`
        select
          (select count(*)::text from analytics.visitor where visitor_id = ${old.visitor})
            as old_visitor,
          (select count(*)::text from analytics.session where session_id = ${old.session})
            as old_session,
          (select count(*)::text from analytics.attribution where session_id = ${old.session})
            as old_attribution,
          (select count(*)::text from analytics.visitor where visitor_id = ${recent.visitor})
            as new_visitor,
          (select count(*)::text from analytics.session where session_id = ${recent.session})
            as new_session,
          (select count(*)::text from analytics.attribution where session_id = ${recent.session})
            as new_attribution
      `
      return { report, survivors }
    })

    const purged = outcome.report.filter((r) => r.action === 'purged_rows')
    // The declared order: a child before its parent, read from `purge_order` rather than written into the
    // function, so a table added to the policy is purged without a new branch.
    expect(purged.map((r) => r.relation)).toEqual(['attribution', 'session', 'visitor'])
    // The 120-day-old rows are gone and the one-day-old rows are not — both halves, because "purged" on its
    // own is satisfied by a pass that emptied the table.
    expect(outcome.survivors).toEqual({
      old_visitor: '0',
      old_session: '0',
      old_attribution: '0',
      new_visitor: '1',
      new_session: '1',
      new_attribution: '1',
    })
    // And the pass said it had removed at least the three rows this case made, rather than reporting zero
    // while something else did the deleting.
    for (const row of purged) expect(Number(row.detail.split(' ')[0])).toBeGreaterThanOrEqual(1)
  })

  it('refuses the whole pass when an analytics table has no retention policy', async () => {
    // The trap this unit exists to close from the other side. A table added by a later unit with no policy
    // row would be retained for ever by omission, and nothing would say so — so the pass stops, naming it.
    const asOf = new Date().toISOString()
    const refused = await rolledBack(async (tx) => {
      await tx`create table analytics.__gate_fixture_unpolicied (id uuid primary key)`
      return await stateOf(runRetention(tx, asOf))
    })
    expect(refused.code).toBe(NO_RETENTION_POLICY)
    expect(refused.message).toContain('__gate_fixture_unpolicied')
    expect(refused.message).toContain('keep for ever by omission')
    // And the committed schema passes, so the refusal above is about the fixture rather than about a
    // policy list that is already incomplete.
    const clean = await rolledBack(async (tx) => await stateOf(runRetention(tx, asOf)))
    expect(clean.code).toBeUndefined()
  })

  it('refuses the whole pass when a policy names a relation that is not there', async () => {
    // The other direction, and the one that makes the list safe to read: a policy for a table nobody has
    // makes the exemption list look broader than it is, which is the same defect as a stale erasure rule.
    const refused = await rolledBack(async (tx) => {
      await tx`
        insert into analytics.retention_policy (relation_name, policy, reason)
        values ('__gate_fixture_ghost', 'keep_indefinitely', 'a relation that does not exist')
      `
      return await stateOf(runRetention(tx, new Date().toISOString()))
    })
    expect(refused.code).toBe(POLICY_FOR_A_MISSING_RELATION)
    expect(refused.message).toContain('__gate_fixture_ghost')
  })

  it('refuses a partition bound it cannot read rather than exempting the partition', async () => {
    // The dominant defect class, guarded: a parser that stopped matching would make every partition look
    // un-droppable and the pass would report success having dropped nothing. The DEFAULT partition is a
    // real bound expression with no range in it, so it is the honest fixture for this.
    const refused = await stateOf(
      sql`select * from analytics.partition_bounds('analytics.event_default')`,
    )
    expect(refused.code).toBe(UNREADABLE_PARTITION_BOUND)
    expect(refused.message).toContain('DEFAULT')
    expect(refused.message).toContain('report success having removed nothing')
    // The control: a real monthly partition's bounds ARE read, so the refusal is about the bound it cannot
    // parse and not about a function that refuses everything.
    const [row] = await sql<{ lower_bound: string; upper_bound: string }[]>`
      select to_char(lower_bound, 'YYYY-MM-DD') as lower_bound,
             to_char(upper_bound, 'YYYY-MM-DD') as upper_bound
        from analytics.partition_bounds(
          (select c.oid::regclass from pg_inherits i join pg_class c on c.oid = i.inhrelid
            where i.inhparent = 'analytics.event'::regclass
              and pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'
            order by c.relname limit 1)
        )
    `
    expect(row?.lower_bound).toMatch(/^\d{4}-\d{2}-01$/)
    expect(row?.upper_bound).toMatch(/^\d{4}-\d{2}-01$/)
  })
})

// ------------------------------------------------------------------------------------------------
// Acceptance 4: the rollups are exempt, and 400 days of retention cannot touch them
// ------------------------------------------------------------------------------------------------

describe('the rollups, kept indefinitely', () => {
  it('has an explicit exemption row for each of the three, plus the list itself', async () => {
    const rows = await sql<{ relation_name: string; policy: string; reason: string }[]>`
      select relation_name, policy, reason from analytics.retention_policy order by relation_name
    `
    const exempt = rows.filter((r) => r.policy === 'keep_indefinitely').map((r) => r.relation_name)
    expect(exempt).toEqual([
      'daily_funnel',
      'daily_source_revenue',
      'daily_traffic',
      'retention_policy',
    ])
    // Every row says WHY, which is what makes the list readable rather than a set of table names. The
    // CHECK refuses a blank one; this is the assertion that none of them is a single word either.
    for (const row of rows) expect(row.reason.length).toBeGreaterThan(40)
  })

  it('leaves their rows byte-identical across 400 simulated days of retention runs', async () => {
    const outcome = await rolledBack(async (tx) => {
      const date = await seededTradingDate(tx)
      await tx`
        insert into analytics.daily_traffic
          (trading_date, source, medium, campaign, device_kind, sessions, visitors, bot_sessions,
           events, computed_at)
        values (${date}, 'google', 'cpc', 'ramadan', 'mobile', 40, 31, 4, 260, now())
      `
      await tx`
        insert into analytics.daily_funnel
          (trading_date, step, source, medium, campaign, entered, excluded, computed_at)
        values (${date}, 'paid', 'google', 'cpc', 'ramadan', 7, 2, now())
      `
      // Integer fils, gross authoritative, vat = gross - net (ADR 0007). 31_500 + 1_500 = 33_000.
      await tx`
        insert into analytics.daily_source_revenue
          (trading_date, source, medium, campaign, paid_invoices, gross_fils, vat_fils, net_fils,
           computed_at)
        values (${date}, 'google', 'cpc', 'ramadan', 7, 33000, 1500, 31500, now())
      `
      const fingerprint = async (): Promise<string> => {
        const [row] = await tx<{ digest: string }[]>`
          select md5(
            coalesce((select string_agg(t::text, '|' order by t::text) from analytics.daily_traffic t), '') ||
            coalesce((select string_agg(f::text, '|' order by f::text) from analytics.daily_funnel f), '') ||
            coalesce((select string_agg(r::text, '|' order by r::text) from analytics.daily_source_revenue r), '')
          ) as digest
        `
        return row?.digest as string
      }

      const before = await fingerprint()
      let exemptions = 0
      let dropped = 0
      // 400 consecutive daily as-of instants from today. The clock is an argument precisely so this
      // question can be asked: a pass reading `new Date()` could only ever be run once.
      const startMs = Date.now()
      for (let day = 0; day < 400; day += 1) {
        const asOf = new Date(startMs + day * 86_400_000).toISOString()
        const report = await runRetention(tx, asOf)
        exemptions += report.filter((r) => r.action === 'exempt').length
        dropped += report.filter((r) => r.action === 'dropped_partition').length
      }
      const after = await fingerprint()

      // The control for the fingerprint itself: it has to be able to notice a change, or "byte-identical"
      // is a claim about a function that returns a constant.
      await tx`update analytics.daily_traffic set sessions = sessions + 1`
      const mutated = await fingerprint()
      return { before, after, mutated, exemptions, dropped }
    })

    expect(outcome.after).toBe(outcome.before)
    expect(outcome.mutated).not.toBe(outcome.before)
    // The pass ran 400 times and reported the four exempt relations on every one of them. Without this the
    // equality above is satisfied by 400 runs that all refused, or by a loop that never ran.
    expect(outcome.exemptions).toBe(400 * 4)
    // And it was really doing work: advancing the clock 400 days past today drops every raw partition on
    // disk. The rollups survived a pass that was demonstrably removing things.
    expect(outcome.dropped).toBeGreaterThan(0)
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// Acceptance 5: analytics.event rejects UPDATE and DELETE outside the retention role
// ------------------------------------------------------------------------------------------------

describe('a collected event cannot be edited after the fact', () => {
  /** An event in the current month's partition, inside the caller's transaction. */
  async function anEvent(tx: Sql): Promise<void> {
    await tx`
      insert into analytics.event (session_id, occurred_at, event_name, path, client_event_id)
      values (gen_random_uuid(), now(), 'landing', '/', 'append-only-fixture')
    `
  }

  it('the RULE: refuses UPDATE and DELETE for the owner, who holds every privilege', async () => {
    // The suite connects as `berelax`, which is a superuser — so this case is the one that proves the
    // refusal is a RULE and not a privilege check. `pg_has_role` would answer true for a superuser, which
    // is why the trigger tests `current_user` by name.
    for (const operation of ['update', 'delete'] as const) {
      const refused = await rolledBack(async (tx) => {
        await anEvent(tx)
        return operation === 'update'
          ? await stateOf(tx`update analytics.event set event_name = 'tampered'`)
          : await stateOf(tx`delete from analytics.event`)
      })
      expect(refused.code, `${operation} must raise ZY065`).toBe(EVENT_IS_APPEND_ONLY)
      expect(refused.message).toContain('append-only')
      expect(refused.message).toContain(operation.toUpperCase())
      expect(refused.message).toContain('berelax')
    }
  })

  it('the RULE reaches a partition addressed directly, because the triggers are cloned', async () => {
    // A grant on the parent would not cover this. PostgreSQL clones a row trigger declared on a
    // partitioned table onto every partition, which is why the triggers are declared there and not on
    // each partition — and it is what makes `delete from analytics.event_2026_09` refused too.
    const refused = await rolledBack(async (tx) => {
      const [row] = await tx<{ partition: string }[]>`
        insert into analytics.event (session_id, occurred_at, event_name, path, client_event_id)
        values (gen_random_uuid(), now(), 'landing', '/', 'append-only-partition')
        returning tableoid::regclass::text as partition
      `
      return await stateOf(tx.unsafe(`delete from ${row?.partition as string}`))
    })
    expect(refused.code).toBe(EVENT_IS_APPEND_ONLY)
  })

  it('the GRANT: the application role is refused at the privilege layer, before any trigger', async () => {
    // A different guarantee from the rule, and the one that still answers when triggers are disabled — a
    // restore, a bulk load, a `session_replication_role`. 42501 rather than ZY065 is the evidence that it
    // is the privilege layer answering.
    for (const operation of ['update', 'delete'] as const) {
      const refused = await rolledBack(async (tx) => {
        await tx`set local role berelax_app`
        return operation === 'update'
          ? await stateOf(tx`update analytics.event set event_name = 'tampered'`)
          : await stateOf(tx`delete from analytics.event`)
      })
      expect(refused.code, `${operation} as berelax_app`).toBe(INSUFFICIENT_PRIVILEGE)
    }
  })

  it('the application role CAN insert and read, so the refusals above are about mutation alone', async () => {
    // Without this control, the two cases above are satisfied by a role that cannot touch the table at all,
    // which would make the ingest route (A-FIRST-05) impossible and the grants wrong in the other
    // direction.
    const outcome = await rolledBack(async (tx) => {
      await tx`set local role berelax_app`
      const insert = await stateOf(tx`
        insert into analytics.event (session_id, occurred_at, event_name, path, client_event_id)
        values (gen_random_uuid(), now(), 'landing', '/', 'app-role-insert')
      `)
      const read = await stateOf(tx`select count(*) from analytics.event`)
      return { insert, read }
    })
    expect(outcome.insert.code).toBeUndefined()
    expect(outcome.read.code).toBeUndefined()
  })

  it('the retention role may mutate, which is the exception the rule names', async () => {
    const outcome = await rolledBack(async (tx) => {
      await anEvent(tx)
      await tx`set local role berelax_retention`
      const updated = await stateOf(tx`
        update analytics.event set event_name = 'corrected' where client_event_id = 'append-only-fixture'
      `)
      const deleted = await stateOf(tx`
        delete from analytics.event where client_event_id = 'append-only-fixture'
      `)
      return { updated, deleted }
    })
    expect(outcome.updated.code).toBeUndefined()
    expect(outcome.deleted.code).toBeUndefined()
  })

  it('funnel_step is deliberately NOT append-only, and the contrast is the point', async () => {
    // An event is evidence of something a browser did and may never be rewritten. A funnel step is DERIVED
    // (A-FIRST-09 materialises it), and a corrected derivation has to be able to replace it — so a rule
    // copied from `event` to here would make a re-materialisation impossible. Asserted so the difference
    // reads as a decision rather than as a trigger somebody forgot.
    const outcome = await rolledBack(async (tx) => {
      await tx`
        insert into analytics.funnel_step (session_id, step, occurred_at)
        values (gen_random_uuid(), 'landing', now())
      `
      const updated = await stateOf(tx`update analytics.funnel_step set step = 'paid'`)
      const deleted = await stateOf(tx`delete from analytics.funnel_step`)
      return { updated, deleted }
    })
    expect(outcome.updated.code).toBeUndefined()
    expect(outcome.deleted.code).toBeUndefined()
  })
})

// ------------------------------------------------------------------------------------------------
// The two agents, so neither cron is one nobody watches
// ------------------------------------------------------------------------------------------------

describe('the scheduled passes', () => {
  it('has an agent_definition AND an agent_heartbeat row for each pass', async () => {
    const rows = await sql<
      {
        agent_key: string
        expected_interval_seconds: number
        budget: string
        heartbeats: string
      }[]
    >`
      select d.agent_key,
             d.expected_interval_seconds,
             d.budget_fils_per_run::text as budget,
             count(h.agent_key)::text    as heartbeats
        from agent_definition d
        left join agent_heartbeat h on h.agent_key = d.agent_key
       where d.agent_key in ('analytics_partitions', 'analytics_retention')
       group by d.agent_key, d.expected_interval_seconds, d.budget_fils_per_run
       order by d.agent_key
    `
    expect(rows.map((r) => r.agent_key)).toEqual(['analytics_partitions', 'analytics_retention'])
    for (const row of rows) {
      // 24 hours, which is what makes the watchdog's "no success within twice the interval" alert mean
      // something: a pass that has not run for two days raises.
      expect(row.expected_interval_seconds).toBe(60 * 60 * 24)
      // Neither pass makes an external call, and a non-zero budget would make the spend report wrong.
      expect(row.budget).toBe('0')
      // 0031's trap: `agentsWithHeartbeat` INNER joins, so an agent with no heartbeat row is one the
      // watchdog silently never checks.
      expect(row.heartbeats, `${row.agent_key} needs a heartbeat row`).toBe('1')
    }
  })
})
