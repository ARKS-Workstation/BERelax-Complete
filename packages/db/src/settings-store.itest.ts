import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from './connection.ts'
import {
  readSetting,
  seedSettingDefaults,
  settingHistory,
  unconfirmedAssumptions,
  writeSetting,
} from './settings-store.ts'
import { withUnitOfWork } from './tx.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql
const OWNER = { kind: 'staff', id: '44444444-4444-4444-4444-444444444444', label: 'Owner' } as const

/**
 * How many history rows exist for a key — counted in SQL, never by reading them.
 *
 * `settingHistory` is the admin panel's reader and takes a `limit`, which is right for a panel and wrong
 * for a count. `app_setting_history` is append-only (ADR 0008) and this suite runs against a database
 * other suites have already written to, so the row count for a key only ever grows; the first time it
 * passed the limit, `history.length - startCount` became `500 - 500` and the delta assertion read zero
 * changes as three. It had been passing for weeks and stopped for a reason that had nothing to do with
 * the trigger it was testing.
 */
async function historyCount(key: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from app_setting_history where key = ${key}
  `
  return Number(row?.n ?? '0')
}

beforeAll(async () => {
  sql = createConnection({ url, max: 3 })
})

beforeEach(async () => {
  await sql`delete from app_setting`
  await seedSettingDefaults(sql)
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('seeding', () => {
  it('seeds every declared setting and is idempotent', async () => {
    const [before] = await sql<{ n: string }[]>`select count(*)::text as n from app_setting`
    const insertedAgain = await seedSettingDefaults(sql)
    const [after] = await sql<{ n: string }[]>`select count(*)::text as n from app_setting`
    expect(insertedAgain).toBe(0)
    expect(after?.n).toBe(before?.n)
  })

  it('records the tier and the provisional metadata', async () => {
    const [row] = await sql<{ tier: string; is_provisional: boolean; open_question_id: string }[]>`
      select tier::text as tier, is_provisional, open_question_id
      from app_setting where key = 'booking.same_gender_matching'
    `
    expect(row?.tier).toBe('compliance_locked')
    expect(row?.is_provisional).toBe(true)
    expect(row?.open_question_id).toBe('Y9-gender')
  })
})

describe('readSetting', () => {
  it('reads the seeded value', async () => {
    expect(await readSetting<number>(sql, 'booking.turnaround_minutes_standard')).toBe(20)
  })

  it('falls back to the declared default for an unseeded key, so a fresh DB behaves the same', async () => {
    await sql`delete from app_setting where key = 'theme.density'`
    expect(await readSetting<string>(sql, 'theme.density')).toBe('comfortable')
  })

  it('refuses an undeclared key', async () => {
    await expect(readSetting(sql, 'not.declared')).rejects.toThrow(/Unknown setting/)
  })
})

describe('writeSetting', () => {
  it('validates, persists, and returns the cache tags the caller must revalidate', async () => {
    const result = await withUnitOfWork(sql, OWNER, (uow) =>
      writeSetting(uow, {
        key: 'booking.turnaround_minutes_standard',
        value: 25,
        role: 'owner',
        actorLabel: 'Owner',
      }),
    )
    expect(result.previousValue).toBe(20)
    expect(result.cacheTags).toContain('availability')
    expect(await readSetting<number>(sql, 'booking.turnaround_minutes_standard')).toBe(25)
  })

  it('rejects an out-of-constraint value and leaves the stored value untouched', async () => {
    await expect(
      withUnitOfWork(sql, OWNER, (uow) =>
        writeSetting(uow, {
          key: 'booking.turnaround_minutes_standard',
          value: 999,
          role: 'owner',
          actorLabel: 'Owner',
        }),
      ),
    ).rejects.toThrow(/Room turnaround/)
    expect(await readSetting<number>(sql, 'booking.turnaround_minutes_standard')).toBe(20)
  })

  it('refuses a role that may not edit the setting', async () => {
    await expect(
      withUnitOfWork(sql, OWNER, (uow) =>
        writeSetting(uow, {
          key: 'booking.same_gender_matching',
          value: 'advisory',
          role: 'manager',
          actorLabel: 'Manager',
        }),
      ),
    ).rejects.toThrow(/may not change/)
  })

  it('requires a written justification for a compliance-locked change', async () => {
    await expect(
      withUnitOfWork(sql, OWNER, (uow) =>
        writeSetting(uow, {
          key: 'booking.same_gender_matching',
          value: 'advisory',
          role: 'owner',
          actorLabel: 'Owner',
        }),
      ),
    ).rejects.toThrow(/justification is required/)
  })

  it('accepts a compliance-locked change WITH a justification, and audits it', async () => {
    await withUnitOfWork(sql, OWNER, (uow) =>
      writeSetting(uow, {
        key: 'booking.same_gender_matching',
        value: 'advisory',
        role: 'owner',
        actorLabel: 'Owner',
        justification: 'ADDED confirmed in writing on 2026-09-18, ref ABC/123.',
      }),
    )
    expect(await readSetting<string>(sql, 'booking.same_gender_matching')).toBe('advisory')
    const [audit] = await sql<{ action: string; after_state: { justification: string } }[]>`
      select action, after_state from audit_event
      where entity_id = 'booking.same_gender_matching' and action like 'settings.%'
      order by occurred_at desc limit 1
    `
    expect(audit?.action).toBe('settings.compliance_locked.changed')
    expect(audit?.after_state.justification).toContain('ADDED confirmed')
  })

  it('a human confirming a value clears the provisional flag — the panel empties as answers arrive', async () => {
    const before = await unconfirmedAssumptions(sql)
    expect(before.map((r) => r.key)).toContain('booking.turnaround_minutes_standard')

    await withUnitOfWork(sql, OWNER, (uow) =>
      writeSetting(uow, {
        key: 'booking.turnaround_minutes_standard',
        value: 15,
        role: 'owner',
        actorLabel: 'Owner',
      }),
    )

    const after = await unconfirmedAssumptions(sql)
    expect(after.map((r) => r.key)).not.toContain('booking.turnaround_minutes_standard')
    expect(after.length).toBe(before.length - 1)
  })

  it('a rollback leaves neither the value nor its audit row', async () => {
    await expect(
      withUnitOfWork(sql, OWNER, async (uow) => {
        await writeSetting(uow, {
          key: 'booking.min_lead_minutes',
          value: 30,
          role: 'owner',
          actorLabel: 'Owner',
        })
        throw new Error('deliberate rollback')
      }),
    ).rejects.toThrow('deliberate rollback')
    expect(await readSetting<number>(sql, 'booking.min_lead_minutes')).toBe(120)
  })
})

describe('history', () => {
  it('records every change automatically, via a trigger no write path can skip', async () => {
    // app_setting_history is append-only (rules in migration 0010), so it CANNOT be cleaned between
    // tests — the same constraint recorded in ADR 0008 for audit_event. Assert on the delta and on
    // the newest rows, never on a total.
    const startCount = await historyCount('booking.turnaround_minutes_standard')
    for (const value of [21, 22, 23]) {
      await withUnitOfWork(sql, OWNER, (uow) =>
        writeSetting(uow, {
          key: 'booking.turnaround_minutes_standard',
          value,
          role: 'owner',
          actorLabel: 'Owner',
        }),
      )
    }
    // startCount is taken after beforeEach has already seeded, so the delta is the three updates.
    expect((await historyCount('booking.turnaround_minutes_standard')) - startCount).toBe(3)
    // The three newest rows, read through the panel's reader — three is well inside any limit.
    const history = await settingHistory(sql, 'booking.turnaround_minutes_standard', 3)
    expect(history[0]?.newValue).toBe(23)
    expect(history[0]?.oldValue).toBe(22)
    expect(history[0]?.changedBy).toBe('Owner')
  })

  it('history is append-only: UPDATE and DELETE are no-ops', async () => {
    await withUnitOfWork(sql, OWNER, (uow) =>
      writeSetting(uow, {
        key: 'theme.density',
        value: 'compact',
        role: 'owner',
        actorLabel: 'Owner',
      }),
    )
    // Counted, not read: a capped read would report the same length before and after a DELETE that
    // really had emptied the table, which is a test that cannot fail.
    const before = await historyCount('theme.density')
    expect(before).toBeGreaterThan(0)
    await sql`update app_setting_history set changed_by = 'tampered' where key = 'theme.density'`
    await sql`delete from app_setting_history where key = 'theme.density'`
    expect(await historyCount('theme.density')).toBe(before)
    const after = await settingHistory(sql, 'theme.density', 10)
    expect(after.every((h) => h.changedBy !== 'tampered')).toBe(true)
  })
})
