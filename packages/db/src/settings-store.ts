import {
  assertRoleMayEdit,
  type CacheTag,
  defaultsForSeeding,
  getDefinition,
  invalidationsFor,
  validateSetting,
} from '@berelax/config'
import { AppError } from '@berelax/shared'
import type { Sql } from './connection.ts'
import type { UnitOfWork } from './tx.ts'

/**
 * Persistence for the settings registry.
 *
 * Every write goes through `writeSetting`, which validates against the declared schema, checks the
 * role, records the change in the append-only history (via a database trigger, so no path can skip
 * it), writes an audit row, and returns the cache tags the caller must revalidate.
 *
 * Returning the tags rather than firing them here is deliberate: revalidation is a Next.js concern
 * and belongs in the app, but *knowing what to revalidate* is a property of the setting and belongs
 * with its declaration. A caller that ignores the return value is a bug a test can catch.
 */

export interface WriteResult {
  readonly key: string
  readonly cacheTags: readonly CacheTag[]
  readonly jobs: readonly string[]
  readonly previousValue: unknown
}

export async function seedSettingDefaults(sql: Sql): Promise<number> {
  const rows = defaultsForSeeding()
  let inserted = 0
  for (const row of rows) {
    const result = await sql`
      insert into app_setting (key, value, tier, is_provisional, provisional_note, open_question_id)
      values (${row.key}, ${sql.json(row.value as never)}, ${row.tier}, ${row.isProvisional},
              ${row.provisionalNote}, ${row.openQuestionId})
      on conflict (key) do nothing
      returning key
    `
    inserted += result.length
  }
  return inserted
}

export async function readSetting<T = unknown>(sql: Sql, key: string): Promise<T> {
  const def = getDefinition(key) // throws on an undeclared key
  const rows = await sql<{ value: T }[]>`select value from app_setting where key = ${key}`
  // An unseeded key falls back to its declared default rather than to undefined, so a fresh
  // database behaves identically to a seeded one.
  return rows[0]?.value ?? (def.defaultValue as T)
}

export async function writeSetting(
  uow: UnitOfWork,
  args: {
    readonly key: string
    readonly value: unknown
    readonly role: string
    readonly actorLabel: string
    readonly justification?: string
  },
): Promise<WriteResult> {
  const def = getDefinition(args.key)
  assertRoleMayEdit(args.key, args.role)
  const validated = validateSetting(args.key, args.value)

  if (def.tier === 'compliance_locked' && !args.justification) {
    throw new AppError(
      'validation',
      `"${def.label}" is compliance-locked: a written justification is required to change it.`,
      { userFacing: true },
    )
  }

  const before = await sql_readRaw(uow.sql, args.key)

  await uow.sql`
    insert into app_setting (key, value, tier, updated_by, updated_at)
    values (${args.key}, ${uow.sql.json(validated as never)}, ${def.tier}, ${args.actorLabel}, now())
    on conflict (key) do update
      set value = excluded.value,
          updated_by = excluded.updated_by,
          updated_at = now(),
          -- A human confirming a value clears the provisional flag: that is the whole point of the
          -- Unconfirmed Assumptions panel.
          is_provisional = false
  `

  if (args.justification) {
    await uow.sql`
      update app_setting_history
         set justification = ${args.justification}
       where key = ${args.key}
         and id = (select max(id) from app_setting_history where key = ${args.key})
    `.catch(() => undefined) // history is append-only; a failed annotation must not fail the change
  }

  await uow.audit.record({
    action: `settings.${def.tier}.changed`,
    entityType: 'app_setting',
    entityId: args.key,
    operation: 'update',
    before: { value: before },
    after: { value: validated, justification: args.justification ?? null },
  })

  const { cacheTags, jobs } = invalidationsFor(args.key)
  return { key: args.key, cacheTags, jobs, previousValue: before }
}

async function sql_readRaw(sql: Sql, key: string): Promise<unknown> {
  const rows = await sql<{ value: unknown }[]>`select value from app_setting where key = ${key}`
  return rows[0]?.value ?? null
}

/** The Unconfirmed Assumptions panel, read from the database rather than the registry, so a value
 *  a human has confirmed disappears from the list. */
export async function unconfirmedAssumptions(sql: Sql): Promise<
  readonly {
    key: string
    value: unknown
    openQuestionId: string | null
    note: string | null
    tier: string
  }[]
> {
  return sql<
    {
      key: string
      value: unknown
      openQuestionId: string | null
      note: string | null
      tier: string
    }[]
  >`
    select key, value, open_question_id as "openQuestionId", provisional_note as note, tier::text as tier
    from app_setting
    where is_provisional
    order by tier, key
  `
}

export async function settingHistory(
  sql: Sql,
  key: string,
  limit = 20,
): Promise<
  readonly { oldValue: unknown; newValue: unknown; changedAt: Date; changedBy: string }[]
> {
  return sql<{ oldValue: unknown; newValue: unknown; changedAt: Date; changedBy: string }[]>`
    select old_value as "oldValue", new_value as "newValue",
           changed_at as "changedAt", changed_by as "changedBy"
    from app_setting_history
    where key = ${key}
    order by changed_at desc
    limit ${limit}
  `
}
