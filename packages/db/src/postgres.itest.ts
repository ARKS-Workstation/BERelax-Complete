import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, REQUIRED_EXTENSIONS, type Sql } from './connection.ts'

/**
 * Proves the database this build depends on actually behaves as the design assumes.
 *
 * The exclusion-constraint test is the important one: the entire no-double-booking guarantee
 * in the availability engine rests on `btree_gist` over `tstzrange`. Proving it here, in F02,
 * de-risks B-AVAIL before a line of scheduling logic exists.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']

if (!url) {
  throw new Error(
    'TEST_DATABASE_URL (or DATABASE_URL) must be set. Integration tests do not skip — ' +
      'a gate that silently skips is worse than one that fails. See docs/adr/0002.',
  )
}

let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
  await sql`select 1`
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('PostgreSQL environment', () => {
  it('is PostgreSQL 16 or newer', async () => {
    const [row] = await sql<{ v: string }[]>`select current_setting('server_version_num') as v`
    expect(Number(row?.v)).toBeGreaterThanOrEqual(160000)
  })

  it('has every required extension available', async () => {
    const rows = await sql<{ name: string }[]>`
      select name from pg_available_extensions
      where name = any(${sql.array(REQUIRED_EXTENSIONS as unknown as string[])})
    `
    expect(rows.map((r) => r.name).sort()).toEqual([...REQUIRED_EXTENSIONS].sort())
  })

  it('stores timestamptz in UTC and renders it in Asia/Dubai without shifting the instant', async () => {
    // Cast in SQL: `at time zone` yields a bare timestamp that the driver would hydrate into a
    // JS Date, and comparing formatted Date strings tests the driver rather than the database.
    const [row] = await sql<{ utc: string; dubai: string }[]>`
      select
        ((timestamptz '2026-03-01 22:30:00+00') at time zone 'UTC')::text        as utc,
        ((timestamptz '2026-03-01 22:30:00+00') at time zone 'Asia/Dubai')::text as dubai
    `
    // Asia/Dubai is UTC+4 year round — no DST. 22:30Z is 02:30 the next day locally,
    // which is exactly the after-midnight case the business day must handle.
    expect(row?.utc).toBe('2026-03-01 22:30:00')
    expect(row?.dubai).toBe('2026-03-02 02:30:00')
  })
})

describe('btree_gist exclusion constraint — the no-double-booking guarantee', () => {
  beforeAll(async () => {
    await sql`create extension if not exists btree_gist`
    await sql`drop table if exists _f02_appointment_probe`
    await sql`
      create table _f02_appointment_probe (
        id           bigserial primary key,
        therapist_id uuid        not null,
        period       tstzrange   not null,
        constraint no_therapist_overlap
          exclude using gist (therapist_id with =, period with &&)
      )
    `
  })

  afterAll(async () => {
    await sql`drop table if exists _f02_appointment_probe`
  })

  const A = '11111111-1111-1111-1111-111111111111'
  const B = '22222222-2222-2222-2222-222222222222'

  it('accepts a first booking', async () => {
    await sql`
      insert into _f02_appointment_probe (therapist_id, period)
      values (${A}, tstzrange('2026-03-01 14:00+04', '2026-03-01 15:00+04', '[)'))
    `
    const [row] = await sql<{ n: string }[]>`select count(*)::text as n from _f02_appointment_probe`
    expect(row?.n).toBe('1')
  })

  it('REJECTS an overlapping booking for the same therapist', async () => {
    await expect(
      sql`
        insert into _f02_appointment_probe (therapist_id, period)
        values (${A}, tstzrange('2026-03-01 14:30+04', '2026-03-01 15:30+04', '[)'))
      `,
    ).rejects.toThrow(/no_therapist_overlap|exclusion/i)
  })

  it('accepts a back-to-back booking, because the range is half-open', async () => {
    await sql`
      insert into _f02_appointment_probe (therapist_id, period)
      values (${A}, tstzrange('2026-03-01 15:00+04', '2026-03-01 16:00+04', '[)'))
    `
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from _f02_appointment_probe where therapist_id = ${A}
    `
    expect(row?.n).toBe('2')
  })

  it('accepts the same period for a different therapist', async () => {
    await sql`
      insert into _f02_appointment_probe (therapist_id, period)
      values (${B}, tstzrange('2026-03-01 14:00+04', '2026-03-01 15:00+04', '[)'))
    `
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from _f02_appointment_probe where therapist_id = ${B}
    `
    expect(row?.n).toBe('1')
  })
})
