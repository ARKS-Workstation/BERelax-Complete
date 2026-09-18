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

/** One unanswered assumption, wherever in the database it is recorded. */
export interface UnconfirmedAssumptionRow {
  /** The table it came from, so the panel can group and a reader can go and look at it. */
  readonly source: string
  /** Which row: a setting key, a service natural key, a menu label. Human-readable, not an id. */
  readonly reference: string
  readonly openQuestionId: string | null
  readonly note: string | null
}

/**
 * Every unanswered assumption in the database, settings and data alike.
 *
 * ## Why this exists alongside `unconfirmedAssumptions`
 *
 * `app_setting` (0010), `service` and `service_variant` (0017), `service_room_type_compat` (0012),
 * `price_list` (0025) and `price_on_request` (0032) all carry the same provenance trio —
 * `is_provisional`, `provisional_note`, `open_question_id` — and four of those migrations say in so many
 * words that the Unconfirmed Assumptions panel reads their rows "the same way it reads app_setting".
 * Until B-CAT-06 nothing did: the only reader was {@link unconfirmedAssumptions}, which reads
 * `app_setting` alone. So the turnaround assumptions on all 8 services, the Y9-shaving-room room
 * restriction and every derived price were flagged, in the right columns, and invisible on the one
 * screen built to show them.
 *
 * {@link unconfirmedAssumptions} stays as it is and is the settings screen's reader: it returns the
 * value and the `tier`, both of which mean something for a setting and nothing for a catalogue row —
 * there is no tier at which a customer may edit a price-on-request label. This function is the panel's,
 * and returns the four fields every source really has.
 *
 * ## The two singletons are matched on the placeholder, not on a flag
 *
 * `premises` and `legal_entity` carry no provenance trio, and adding one would be a row-level flag on a
 * row that is mostly confirmed: the address is a fact, the canonical WhatsApp number is not. So those
 * two sources are matched per COLUMN, by `is_placeholder_text()` — the same function
 * `invoice_issuer_trn_not_placeholder` uses — against a small literal mapping from the column to its
 * open question. The mapping is spelled in the query rather than derived, because there is nothing to
 * derive it from: that `phone_whatsapp` is Y1-nap and `trn` is Y1-trn is knowledge, not structure.
 */
export async function unconfirmedAssumptionRows(
  sql: Sql,
): Promise<readonly UnconfirmedAssumptionRow[]> {
  return sql<UnconfirmedAssumptionRow[]>`
    with singleton as (
      -- (table, column, value, question). One row per column that may stand in for an answer.
      select 'premises' as source, 'phone_whatsapp' as column_name,
             p.phone_whatsapp as value, 'Y1-nap' as question
        from premises p
      union all
      select 'legal_entity', 'trn', e.trn, 'Y1-trn' from legal_entity e
      union all
      select 'legal_entity', 'trade_licence_number', e.trade_licence_number, 'Y1-trn'
        from legal_entity e
    )
    select source, reference, "openQuestionId", note from (
      select 'app_setting' as source, key as reference,
             open_question_id as "openQuestionId", provisional_note as note
        from app_setting where is_provisional
      union all
      select 'service', style::text || '/' || treatment_key,
             open_question_id, provisional_note
        from service where is_provisional
      union all
      select 'service_variant',
             s.style::text || '/' || s.treatment_key || ' ' || v.duration_minutes::text || 'min',
             v.open_question_id, v.provisional_note
        from service_variant v join service s on s.id = v.service_id where v.is_provisional
      union all
      select 'service_room_type_compat',
             service_style::text || '/' || service_treatment_key || ' -> ' || room_type::text,
             open_question_id, null
        from service_room_type_compat where is_provisional
      union all
      select 'service_resource_shape',
             service_style::text || '/' || service_treatment_key || ' ' || shape::text,
             open_question_id, provisional_note
        from service_resource_shape where is_provisional
      union all
      select 'price_list', label, open_question_id, provisional_note
        from price_list where is_provisional
      union all
      select 'price_on_request', menu_label, open_question_id, provisional_note
        from price_on_request where is_provisional
      union all
      select source, column_name, question,
             -- The value itself is the note: 'WHATSAPP-PENDING-Y1-NAP' says what it is, and a NULL
             -- licence number says it by being absent.
             coalesce(value, '(not set)')
        from singleton where is_placeholder_text(value)
    ) as rows
    order by source, reference
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
