import {
  horizonDates,
  horizonRows,
  hoursFromSchedule,
  localDate,
  localTime,
  type TradingHours,
} from '@berelax/core'
import {
  type BusinessDayInput,
  businessDayFingerprint,
  createConnection,
  generateBusinessDays,
  type Sql,
} from '@berelax/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * B-CAT-01 — the trading calendar, materialised.
 *
 * It lives in `@berelax/fixtures` because it exercises `core` computing the horizon and `db` writing
 * it, and fixtures is the package allowed to depend on both — `db` must never import `core`. Putting
 * the test beside the job would have meant the job's own package importing the thing it is forbidden
 * to import, which is how a boundary gets relaxed for the sake of a test.
 *
 * The properties that matter are idempotence and the database's own refusal to hold an impossible
 * day. Both are asserted against a real PostgreSQL, because a CHECK constraint cannot be tested
 * against a mock and a generator's idempotence is a property of the SQL, not of the TypeScript.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const HOURS: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const START = localDate('2026-01-01')
const HORIZON = 400

let sql: Sql

const scheduleFor = (closedDates: string[] = []) =>
  hoursFromSchedule({
    weekly: Array.from({ length: 7 }, () => HOURS),
    closedDates: closedDates.map((date) => localDate(date)),
  })

function inputs(closedDates: string[] = []): BusinessDayInput[] {
  return horizonRows({ from: START, days: HORIZON, hoursFor: scheduleFor(closedDates) }).map(
    (row) => ({
      tradingDate: row.tradingDate,
      opensAt: row.opensAt,
      closesAt: row.closesAt,
      source: row.source,
    }),
  )
}

const WINDOW = {
  from: START,
  to: horizonDates(START, HORIZON).at(-1) ?? START,
}

beforeAll(() => {
  sql = createConnection({ url, max: 2 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql`delete from business_day`
})

describe('acceptance — the seeded row is exactly 15 hours', () => {
  it('stores instants and derives the duration in the database', async () => {
    await generateBusinessDays(sql, inputs(), WINDOW)
    const [row] = await sql<{ duration_seconds: number; crosses_midnight: boolean }[]>`
      select duration_seconds, crosses_midnight from business_day where trading_date = '2026-01-01'
    `
    // 11:00 to 02:00 is 15 hours. Asserted arithmetically rather than by eye, because an off-by-one
    // in the timezone handling gives 14 or 16 and both look plausible in a table.
    expect(row?.duration_seconds).toBe(54_000)
    expect(row?.crosses_midnight).toBe(true)
  })

  it('refuses a day that closes before it opens', async () => {
    await expect(
      sql`
        insert into business_day (trading_date, opens_at, closes_at, source)
        values ('2026-06-01', '2026-06-01T18:00:00Z', '2026-06-01T06:00:00Z', 'weekly')
      `,
    ).rejects.toThrow(/business_day_closes_after_opens/)
  })

  it('refuses a day longer than 24 hours, which is a timezone slip rather than unusual hours', async () => {
    await expect(
      sql`
        insert into business_day (trading_date, opens_at, closes_at, source)
        values ('2026-06-01', '2026-06-01T07:00:00Z', '2026-06-03T07:00:00Z', 'weekly')
      `,
    ).rejects.toThrow(/business_day_plausible_length/)
  })
})

describe('acceptance — the generator is idempotent', () => {
  it('changes nothing on a second run over the same horizon', async () => {
    const rows = inputs()
    const first = await generateBusinessDays(sql, rows, WINDOW)
    expect(first.inserted).toBe(HORIZON)
    const before = await businessDayFingerprint(sql)

    const second = await generateBusinessDays(sql, rows, WINDOW)
    expect(second).toEqual({ inserted: 0, updated: 0, deleted: 0 })
    // The fingerprint includes generated_at on purpose: if it moved, the generator rewrote a row it
    // should have left alone, which is exactly the failure this catches.
    expect(await businessDayFingerprint(sql)).toBe(before)
  }, 60_000)

  it('is idempotent a third time, so the property is not an artefact of the first pair', async () => {
    const rows = inputs()
    await generateBusinessDays(sql, rows, WINDOW)
    await generateBusinessDays(sql, rows, WINDOW)
    const before = await businessDayFingerprint(sql)
    await generateBusinessDays(sql, rows, WINDOW)
    expect(await businessDayFingerprint(sql)).toBe(before)
  }, 60_000)
})

describe('a closed date is absent, never flagged', () => {
  it('removes the row when a date stops trading', async () => {
    await generateBusinessDays(sql, inputs(), WINDOW)
    const result = await generateBusinessDays(sql, inputs(['2026-03-15']), WINDOW)
    expect(result.deleted).toBe(1)
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from business_day where trading_date = '2026-03-15'
    `
    expect(row?.n).toBe('0')
  }, 60_000)

  it('restores it when the closure is withdrawn', async () => {
    await generateBusinessDays(sql, inputs(['2026-03-15']), WINDOW)
    const result = await generateBusinessDays(sql, inputs(), WINDOW)
    expect(result.inserted).toBe(1)
  }, 60_000)

  it('leaves rows outside the horizon alone', async () => {
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values ('2025-01-01', '2025-01-01T07:00:00Z', '2025-01-01T22:00:00Z', 'weekly')
    `
    await generateBusinessDays(sql, inputs(), WINDOW)
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from business_day where trading_date = '2025-01-01'
    `
    expect(row?.n).toBe('1')
  }, 60_000)
})

describe('changed hours update rather than duplicate', () => {
  it('rewrites the instants and stamps generated_at only for the dates that moved', async () => {
    await generateBusinessDays(sql, inputs(), WINDOW)
    const [before] = await sql<{ generated_at: string }[]>`
      select generated_at::text from business_day where trading_date = '2026-01-02'
    `

    const ramadan = { open: localTime('20:00'), close: localTime('01:00') }
    const changed = inputs().map((row) =>
      row.tradingDate === '2026-01-01'
        ? {
            ...row,
            opensAt: Date.parse('2026-01-01T16:00:00Z'),
            closesAt: Date.parse('2026-01-01T21:00:00Z'),
            source: 'override' as const,
          }
        : row,
    )
    void ramadan

    const result = await generateBusinessDays(sql, changed, WINDOW)
    expect(result).toMatchObject({ inserted: 0, updated: 1, deleted: 0 })

    const [after] = await sql<{ generated_at: string }[]>`
      select generated_at::text from business_day where trading_date = '2026-01-02'
    `
    // An untouched day keeps its original stamp. Otherwise every run looks like a change.
    expect(after?.generated_at).toBe(before?.generated_at)

    const [moved] = await sql<{ source: string; duration_seconds: number }[]>`
      select source, duration_seconds from business_day where trading_date = '2026-01-01'
    `
    expect(moved?.source).toBe('override')
    expect(moved?.duration_seconds).toBe(18_000)
  }, 60_000)
})

describe('the horizon is the full 400 days', () => {
  it('materialises every trading date in it', async () => {
    await generateBusinessDays(sql, inputs(), WINDOW)
    const [row] = await sql<{ n: string }[]>`select count(*)::text as n from business_day`
    expect(row?.n).toBe(String(HORIZON))
  }, 60_000)

  it('has no gap and no duplicate, so a report joining to it cannot lose a day', async () => {
    await generateBusinessDays(sql, inputs(), WINDOW)
    const [row] = await sql<{ gaps: string }[]>`
      select count(*)::text as gaps from (
        select trading_date, lag(trading_date) over (order by trading_date) as previous
        from business_day
      ) as ordered
      where previous is not null and trading_date <> previous + 1
    `
    expect(row?.gaps).toBe('0')
  }, 60_000)
})
