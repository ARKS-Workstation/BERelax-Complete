import { provisionalSettings } from '@berelax/config'
import { AppError } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'
import { seedSettingDefaults, unconfirmedAssumptions, writeSetting } from '../settings-store.ts'
import { withUnitOfWork } from '../tx.ts'
import {
  GENDER_MATCHING_SETTING_KEY,
  readGenderMatching,
  setGenderMatching,
} from './availability.ts'

/**
 * B-AVAIL-05 — the stored half of same-gender matching, against real PostgreSQL.
 *
 * The rule is pure and lives in `@berelax/core`; what is proved here is the thing a unit test cannot
 * prove, because it is a property of the database rather than of a function: **an `app_setting` table
 * with no row in it still enforces strict matching.** That is the failure mode the unit is designed
 * against — a compliance constraint that relaxes itself when its configuration is missing — and the only
 * honest way to assert it is against an empty table.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind.
 * `app_setting` is a small keyed table that `settings-store.itest.ts` empties and re-seeds in its own
 * `beforeEach`, so the two files must not fight over it:
 *
 *   - every read-path case runs inside `sql.begin` and **rolls back**, so the deletions and the corrupt
 *     values never outlive the assertion;
 *   - the write-path cases write for real, because `writeSetting` opens its own transaction and cannot
 *     be nested inside one, and `afterAll` restores the row by deleting it and re-seeding from the
 *     registry — with the values the registry declares, never a hand-spelled copy of them. Restoring a
 *     singleton with *nearly* the seeded values is what `opening-balances.itest.ts` recorded the cost of;
 *   - `app_setting_history` is append-only (ADR 0008), so every history assertion is a DELTA counted in
 *     SQL. `settingHistory` takes a `limit`, which is right for a panel and wrong for a count: the first
 *     time a key passed that limit both sides of a subtraction pinned at it and three recorded changes
 *     read as zero.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql
const OWNER = { kind: 'staff', id: '44444444-4444-4444-4444-444444444444', label: 'Owner' } as const
const WRITTEN_BASIS = 'ADDED confirmed in writing on 2026-09-18, ref BAVAIL05/PROBE.'

/** History rows for a key, counted in SQL. Never read through a capped reader. */
async function historyCount(key: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from app_setting_history where key = ${key}
  `
  return Number(row?.n ?? '0')
}

async function auditCount(key: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event
     where entity_id = ${key} and action like 'settings.%'
  `
  return Number(row?.n ?? '0')
}

/** Puts the value back the way the registry declares it, including the provisional metadata. */
async function restoreSeededRow(): Promise<void> {
  await sql`delete from app_setting where key = ${GENDER_MATCHING_SETTING_KEY}`
  await seedSettingDefaults(sql)
}

beforeAll(async () => {
  sql = createConnection({ url, max: 3 })
  // Delete-then-seed rather than seed alone: `seedSettingDefaults` is `on conflict do nothing`, so a row
  // an earlier suite left at `'advisory'` with `is_provisional` cleared would survive it and every
  // assertion below would be about that file's leftovers. Seeded from the registry, never from a
  // hand-spelled copy of its values.
  await restoreSeededRow()
})

afterAll(async () => {
  await restoreSeededRow()
  await sql?.end({ timeout: 5 })
})

describe('acceptance — the strict default needs no row, and no argument', () => {
  it('resolves to strict in a database with NO app_setting row at all', async () => {
    await expect(
      sql.begin(async (tx) => {
        const scoped = tx as unknown as Sql
        await scoped`delete from app_setting`
        const [row] = await scoped<{ n: string }[]>`select count(*)::text as n from app_setting`
        // The premise, asserted rather than assumed: an empty table, not merely a missing key.
        expect(Number(row?.n)).toBe(0)
        expect(await readGenderMatching(scoped)).toBe('strict')
        // Rolled back, so `settings-store.itest.ts` and every later suite see the table they expect.
        throw new AppError('conflict', 'rollback: the empty-table probe is read-only')
      }),
    ).rejects.toThrow(/rollback: the empty-table probe/)
    // And the rollback really happened: the row is back, which is also what makes the probe repeatable.
    const [after] = await sql<{ n: string }[]>`select count(*)::text as n from app_setting`
    expect(Number(after?.n)).toBeGreaterThan(0)
  })

  it('resolves to strict when the row for this key alone is deleted', async () => {
    await sql
      .begin(async (tx) => {
        const scoped = tx as unknown as Sql
        await scoped`delete from app_setting where key = ${GENDER_MATCHING_SETTING_KEY}`
        expect(await readGenderMatching(scoped)).toBe('strict')
        throw new AppError('conflict', 'rollback: the deleted-row probe is read-only')
      })
      .catch((error: unknown) => {
        if (!(error instanceof AppError)) throw error
      })
    expect(await readGenderMatching(sql)).toBe('strict')
  })

  it('resolves to strict for a row corrupted to a value that is not a mode', async () => {
    // Written with raw SQL on purpose: `writeSetting` validates, so these values cannot arrive through
    // the write path. They arrive from an older build, a hand-run `update`, or a migration that stopped
    // half way — and `'off'` is the mode the registry's own schema accepted until this unit.
    const corrupt: readonly unknown[] = ['off', 'maybe', 'Advisory', 'advisory ', 123, {}, []]
    for (const value of corrupt) {
      await sql
        .begin(async (tx) => {
          const scoped = tx as unknown as Sql
          // `sql.json`, the way `writeSetting` writes a value: `${value}::jsonb` would send the string
          // through a text parameter and store `"\"off\""`, so the probe would be about a doubly encoded
          // value nothing can produce rather than about the one an older build left behind.
          await scoped`
            update app_setting set value = ${scoped.json(value as never)}
             where key = ${GENDER_MATCHING_SETTING_KEY}
          `
          // The stored value really is the corrupt one, read straight out of the column: `readSetting`
          // would fold a jsonb `null` into the registry default on its own, and then this assertion
          // would be about the fall-back rather than about the normaliser under test.
          const [stored] = await scoped<{ value: string }[]>`
            select value::text as value from app_setting where key = ${GENDER_MATCHING_SETTING_KEY}
          `
          expect(stored?.value).toBe(JSON.stringify(value))
          expect(await readGenderMatching(scoped), `stored ${JSON.stringify(value)}`).toBe('strict')
          throw new AppError('conflict', 'rollback: the corrupt-value probe is read-only')
        })
        .catch((error: unknown) => {
          if (!(error instanceof AppError)) throw error
        })
    }
    expect(await readGenderMatching(sql)).toBe('strict')
  })

  it('resolves to strict for a jsonb null, which the column permits and the mode does not', async () => {
    // `app_setting.value` is `jsonb not null`, so a SQL NULL is impossible — but a jsonb `null` is a
    // perfectly storable value and `readSetting`'s `??` folds it into the registry default. A literal in
    // the statement rather than a parameter: `sql.json(null)` sends SQL NULL, which the column refuses,
    // and that refusal would read as "this cannot happen" when what cannot happen is the other one.
    await sql
      .begin(async (tx) => {
        const scoped = tx as unknown as Sql
        await scoped`
          update app_setting set value = 'null'::jsonb where key = ${GENDER_MATCHING_SETTING_KEY}
        `
        const [stored] = await scoped<{ value: string }[]>`
          select value::text as value from app_setting where key = ${GENDER_MATCHING_SETTING_KEY}
        `
        expect(stored?.value).toBe('null')
        expect(await readGenderMatching(scoped)).toBe('strict')
        throw new AppError('conflict', 'rollback: the jsonb-null probe is read-only')
      })
      .catch((error: unknown) => {
        if (!(error instanceof AppError)) throw error
      })
    expect(await readGenderMatching(sql)).toBe('strict')
  })

  it('reads the seeded row as strict, with the compliance metadata the registry declares', async () => {
    const [row] = await sql<{ tier: string; is_provisional: boolean; open_question_id: string }[]>`
      select tier::text as tier, is_provisional, open_question_id
        from app_setting where key = ${GENDER_MATCHING_SETTING_KEY}
    `
    expect(row?.tier).toBe('compliance_locked')
    // The rule is in force and the regulatory basis is unconfirmed. Both facts, on one row.
    expect(row?.is_provisional).toBe(true)
    expect(row?.open_question_id).toBe('Y9-gender')
    expect(await readGenderMatching(sql)).toBe('strict')
  })
})

describe('acceptance — switching to advisory is owner-only, audited and justified', () => {
  it('refuses the change for manager and for receptionist', async () => {
    for (const role of ['manager', 'receptionist', 'therapist', 'anonymous']) {
      await expect(
        withUnitOfWork(sql, OWNER, (uow) =>
          setGenderMatching(uow, {
            mode: 'advisory',
            role,
            actorLabel: role,
            reason: WRITTEN_BASIS,
          }),
        ),
        role,
      ).rejects.toThrow(/may not change/)
    }
    // Refused, and nothing moved: the rollback of a refused write is the half that is easy to lose.
    expect(await readGenderMatching(sql)).toBe('strict')
  })

  it('refuses a reason that is blank or only whitespace', async () => {
    // `writeSetting` tests the justification for truthiness, and `'   '` is truthy. A space bar is not
    // the licensing authority's answer in writing.
    for (const reason of ['', '   ', '\n\t']) {
      await expect(
        withUnitOfWork(sql, OWNER, (uow) =>
          setGenderMatching(uow, {
            mode: 'advisory',
            role: 'owner',
            actorLabel: 'Owner',
            reason,
          }),
        ),
        JSON.stringify(reason),
      ).rejects.toThrow(/justification|written basis/i)
    }
    expect(await readGenderMatching(sql)).toBe('strict')
  })

  it('refuses the mode the registry no longer accepts, so off cannot be re-introduced', async () => {
    await expect(
      withUnitOfWork(sql, OWNER, (uow) =>
        writeSetting(uow, {
          key: GENDER_MATCHING_SETTING_KEY,
          value: 'off',
          role: 'owner',
          actorLabel: 'Owner',
          justification: WRITTEN_BASIS,
        }),
      ),
    ).rejects.toThrow(/Same-gender therapist matching/)
    expect(await readGenderMatching(sql)).toBe('strict')
  })

  it('accepts the owner change, audits it with before and after, and records one history row', async () => {
    const historyBefore = await historyCount(GENDER_MATCHING_SETTING_KEY)
    const auditBefore = await auditCount(GENDER_MATCHING_SETTING_KEY)
    const listedBefore = await unconfirmedAssumptions(sql)
    expect(listedBefore.map((each) => each.key)).toContain(GENDER_MATCHING_SETTING_KEY)
    expect(
      listedBefore.find((each) => each.key === GENDER_MATCHING_SETTING_KEY)?.openQuestionId,
    ).toBe('Y9-gender')

    const result = await withUnitOfWork(sql, OWNER, (uow) =>
      setGenderMatching(uow, {
        mode: 'advisory',
        role: 'owner',
        actorLabel: 'Owner',
        reason: WRITTEN_BASIS,
      }),
    )
    // The caller is told what to revalidate. Availability is computed on demand and cached briefly, so a
    // mode change that did not invalidate it would keep offering the old day.
    expect(result.previousValue).toBe('strict')
    expect(result.cacheTags).toContain('availability')
    expect(await readGenderMatching(sql)).toBe('advisory')

    const [audit] = await sql<
      {
        action: string
        before_state: { value: string } | null
        after_state: { value: string; justification: string | null }
      }[]
    >`
      select action, before_state, after_state from audit_event
       where entity_id = ${GENDER_MATCHING_SETTING_KEY} and action like 'settings.%'
       order by occurred_at desc limit 1
    `
    expect(audit?.action).toBe('settings.compliance_locked.changed')
    expect(audit?.before_state?.value).toBe('strict')
    expect(audit?.after_state.value).toBe('advisory')
    expect(audit?.after_state.justification).toContain('ADDED confirmed in writing')

    // Deltas, never totals: both tables are append-only and this suite is not the only writer.
    expect(await historyCount(GENDER_MATCHING_SETTING_KEY)).toBe(historyBefore + 1)
    expect(await auditCount(GENDER_MATCHING_SETTING_KEY)).toBe(auditBefore + 1)
    const [history] = await sql<{ old_value: string; new_value: string }[]>`
      select old_value::text as old_value, new_value::text as new_value
        from app_setting_history where key = ${GENDER_MATCHING_SETTING_KEY}
       order by id desc limit 1
    `
    expect(history?.old_value).toBe('"strict"')
    expect(history?.new_value).toBe('"advisory"')

    // The registry still records that the build assumed this value against Y9-gender — the assumption is
    // a property of the declaration and does not disappear because a row changed. The DATABASE panel is
    // the one that empties, because a human has now taken the decision the panel was asking for.
    expect(provisionalSettings().map((each) => each.key)).toContain(GENDER_MATCHING_SETTING_KEY)
    expect(
      provisionalSettings().find((each) => each.key === GENDER_MATCHING_SETTING_KEY)
        ?.openQuestionId,
    ).toBe('Y9-gender')
    const listedAfter = await unconfirmedAssumptions(sql)
    expect(listedAfter.map((each) => each.key)).not.toContain(GENDER_MATCHING_SETTING_KEY)

    // Back to strict, by the same audited path — and the reader follows the row in both directions,
    // which is what stops "it always says strict" from passing every assertion in this file.
    await withUnitOfWork(sql, OWNER, (uow) =>
      setGenderMatching(uow, {
        mode: 'strict',
        role: 'owner',
        actorLabel: 'Owner',
        reason: 'B-AVAIL-05 probe: restoring the strict default.',
      }),
    )
    expect(await readGenderMatching(sql)).toBe('strict')
    expect(await historyCount(GENDER_MATCHING_SETTING_KEY)).toBe(historyBefore + 2)
    await restoreSeededRow()
  })

  it('a rollback leaves neither the value nor its audit row', async () => {
    const auditBefore = await auditCount(GENDER_MATCHING_SETTING_KEY)
    await expect(
      withUnitOfWork(sql, OWNER, async (uow) => {
        await setGenderMatching(uow, {
          mode: 'advisory',
          role: 'owner',
          actorLabel: 'Owner',
          reason: WRITTEN_BASIS,
        })
        throw new Error('deliberate rollback')
      }),
    ).rejects.toThrow('deliberate rollback')
    expect(await readGenderMatching(sql)).toBe('strict')
    expect(await auditCount(GENDER_MATCHING_SETTING_KEY)).toBe(auditBefore)
  })
})
