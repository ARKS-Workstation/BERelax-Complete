import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from './connection.ts'
import { createJobQueue, DEFAULT_QUEUE_OPTIONS, PGBOSS_SCHEMA } from './jobs/boss.ts'

/** Proves every F04 acceptance criterion against a real database. */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('extensions', () => {
  it('has all four required extensions INSTALLED, not merely available', async () => {
    const rows = await sql<{ extname: string }[]>`
      select extname from pg_extension
      where extname in ('btree_gist','pgcrypto','pg_trgm','unaccent')
      order by extname
    `
    expect(rows.map((r) => r.extname)).toEqual(['btree_gist', 'pg_trgm', 'pgcrypto', 'unaccent'])
  })
})

describe('uuid_generate_v7', () => {
  it('produces version-7 UUIDs', async () => {
    const [row] = await sql<{ v: string }[]>`select uuid_generate_v7()::text as v`
    expect(row?.v).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('is time-ordered at millisecond granularity, which is why it beats v4 for index locality', async () => {
    // RFC 9562 orders v7 by its leading 48-bit millisecond timestamp. Within a single millisecond
    // the remaining bits are random, so values are NOT monotonic at sub-millisecond resolution —
    // this implementation adds no monotonic counter. Assert the real guarantee: the timestamp
    // prefix never goes backwards.
    const rows = await sql<{ v: string }[]>`
      select uuid_generate_v7()::text as v from generate_series(1, 200)
    `
    const prefixes = rows.map((r) => r.v.replace(/-/g, '').slice(0, 12))
    expect([...prefixes].sort()).toEqual(prefixes)
  })

  it('encodes the current time in its prefix, within a second of now', async () => {
    const [row] = await sql<{ ms: string }[]>`
      select ('x' || substr(replace(uuid_generate_v7()::text, '-', ''), 1, 12))::bit(48)::bigint::text as ms
    `
    const [now] = await sql<{ ms: string }[]>`
      select (extract(epoch from clock_timestamp()) * 1000)::bigint::text as ms
    `
    expect(Math.abs(Number(row?.ms) - Number(now?.ms))).toBeLessThan(1000)
  })
})

describe('singletons', () => {
  for (const table of ['legal_entity', 'premises'] as const) {
    it(`${table} permits exactly one row, enforced by a check constraint`, async () => {
      const [row] = await sql<{ def: string }[]>`
        select pg_get_constraintdef(c.oid) as def
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        where t.relname = ${table} and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%id = 1%'
      `
      expect(row?.def, `${table} must constrain id to 1`).toBeDefined()
    })
  }

  it('rejects a second premises row', async () => {
    await sql`
      insert into premises (display_name, address_line_1, area)
      values ('probe', '250 Al Meena Street', 'Al Zahiyah')
      on conflict (id) do nothing
    `
    await expect(
      sql`
        insert into premises (id, display_name, address_line_1, area)
        values (2, 'second', 'nowhere', 'nowhere')
      `,
    ).rejects.toThrow()
  })
})

describe('premises_hours crosses midnight', () => {
  it('generates crosses_midnight from the times, so no caller can disagree', async () => {
    await sql`delete from premises_hours`
    // Real trading hours: 11:00–02:00, every day.
    await sql`
      insert into premises_hours (day_of_week, open_time, close_time)
      select d, time '11:00', time '02:00' from generate_series(0, 6) as d
    `
    const rows = await sql<{ crosses_midnight: boolean }[]>`
      select crosses_midnight from premises_hours order by day_of_week
    `
    expect(rows).toHaveLength(7)
    expect(rows.every((r) => r.crosses_midnight)).toBe(true)
  })

  it('does not flag an ordinary same-day range', async () => {
    await sql`delete from premises_hours`
    await sql`insert into premises_hours (day_of_week, open_time, close_time) values (1, time '09:00', time '18:00')`
    const [row] = await sql<
      { crosses_midnight: boolean }[]
    >`select crosses_midnight from premises_hours`
    expect(row?.crosses_midnight).toBe(false)
    await sql`delete from premises_hours`
  })
})

describe('regulatory_profile', () => {
  it('has exactly one profile in force', async () => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from regulatory_profile where superseded_at is null
    `
    expect(row?.n).toBe('1')
  })

  it('defaults to the STRICTER combination so a late legal answer cannot leave us non-compliant', async () => {
    const [p] = await sql<
      {
        licence_class: string
        medical_claims_permitted: boolean
        clinical_retention_years: number
        is_provisional: boolean
        banned_claim_terms: string[]
      }[]
    >`select * from regulatory_profile_current`

    expect(p?.licence_class).toBe('unconfirmed')
    // Strict: claims forbidden, healthcare-grade retention, and flagged as an assumption.
    expect(p?.medical_claims_permitted).toBe(false)
    expect(p?.clinical_retention_years).toBeGreaterThanOrEqual(25)
    expect(p?.is_provisional).toBe(true)
    // The words that are claims under a non-healthcare licence.
    expect(p?.banned_claim_terms).toContain('therapeutic')
    expect(p?.banned_claim_terms).toContain('pain relief')
  })

  it('refuses a second current profile, so "in force" is never ambiguous', async () => {
    await expect(
      sql`insert into regulatory_profile (source_note) values ('illegal second current')`,
    ).rejects.toThrow(/regulatory_profile_one_current|unique/i)
  })
})

describe('audit_event', () => {
  it('is range-partitioned by occurred_at', async () => {
    const [row] = await sql<{ strategy: string }[]>`
      select p.partstrat as strategy
      from pg_partitioned_table p join pg_class c on c.oid = p.partrelid
      where c.relname = 'audit_event'
    `
    expect(row?.strategy).toBe('r')
  })

  it('has NO default partition, so a missing partition fails loudly instead of silently pooling', async () => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n
      from pg_class c
      join pg_inherits i on i.inhrelid = c.oid
      join pg_class parent on parent.oid = i.inhparent
      where parent.relname = 'audit_event' and pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'
    `
    expect(row?.n).toBe('0')
  })

  it('ensure_audit_partitions is idempotent', async () => {
    const [first] = await sql<{ n: number }[]>`select ensure_audit_partitions() as n`
    const [second] = await sql<{ n: number }[]>`select ensure_audit_partitions() as n`
    expect(second?.n).toBe(0)
    expect(first?.n).toBeGreaterThanOrEqual(0)
  })

  it('has a partition covering now, so an insert succeeds', async () => {
    await sql`
      insert into audit_event (actor_kind, action, entity_type, operation)
      values ('system', 'f04.probe', 'test', 'create')
    `
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'f04.probe'
    `
    expect(Number(row?.n)).toBeGreaterThan(0)
  })

  it('is append-only: UPDATE and DELETE are no-ops', async () => {
    const before = await sql<
      { n: string }[]
    >`select count(*)::text as n from audit_event where action = 'f04.probe'`
    await sql`update audit_event set action = 'tampered' where action = 'f04.probe'`
    await sql`delete from audit_event where action = 'f04.probe'`
    const after = await sql<
      { n: string }[]
    >`select count(*)::text as n from audit_event where action = 'f04.probe'`
    expect(after[0]?.n).toBe(before[0]?.n)
    const [tampered] = await sql<
      { n: string }[]
    >`select count(*)::text as n from audit_event where action = 'tampered'`
    expect(tampered?.n).toBe('0')
  })
})

describe('outbox_event', () => {
  it('rejects a duplicate idempotency key, so an effect cannot fire twice', async () => {
    const key = `f04-probe-${Date.now()}`
    await sql`
      insert into outbox_event (event_type, aggregate_type, aggregate_id, payload, idempotency_key)
      values ('test.event', 'test', '1', '{}'::jsonb, ${key})
    `
    await expect(
      sql`
        insert into outbox_event (event_type, aggregate_type, aggregate_id, payload, idempotency_key)
        values ('test.event', 'test', '1', '{}'::jsonb, ${key})
      `,
    ).rejects.toThrow(/idempotency_key|unique/i)
    await sql`delete from outbox_event where idempotency_key = ${key}`
  })

  it('indexes unpublished rows partially, so the worker scan stays small as the table grows', async () => {
    const [row] = await sql<{ def: string }[]>`
      select indexdef as def from pg_indexes where indexname = 'outbox_event_unpublished_idx'
    `
    expect(row?.def).toContain('WHERE (published_at IS NULL)')
  })
})

describe('pg-boss', () => {
  it('installs its own schema and accepts a job', async () => {
    const boss = createJobQueue({ connectionString: url, max: 2 })
    try {
      await boss.start()
      const [row] = await sql<{ n: string }[]>`
        select count(*)::text as n from information_schema.schemata where schema_name = ${PGBOSS_SCHEMA}
      `
      expect(row?.n).toBe('1')

      // createQueue does not update an existing queue, so a queue left behind by a previous run
      // would silently keep pg-boss's default options. Delete first to keep the test hermetic.
      await boss.deleteQueue('f04-probe').catch(() => undefined)
      await boss.createQueue('f04-probe', { ...DEFAULT_QUEUE_OPTIONS })
      const jobId = await boss.send('f04-probe', { probe: true })
      expect(jobId).toBeTruthy()

      // Retention is per-queue in pg-boss 12; prove the policy actually landed.
      const queue = await boss.getQueue('f04-probe')
      expect(queue?.retryLimit).toBe(DEFAULT_QUEUE_OPTIONS.retryLimit)
      expect(queue?.retryBackoff).toBe(true)
    } finally {
      await boss.deleteQueue('f04-probe').catch(() => undefined)
      await boss.stop({ graceful: false })
    }
  })
})
