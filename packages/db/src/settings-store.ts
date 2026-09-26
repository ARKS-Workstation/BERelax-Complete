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

  /**
   * The justification, handed to the history trigger through a transaction-local setting.
   *
   * It cannot be annotated onto the history row afterwards: `app_setting_history` is append-only (ADR
   * 0008) and 0010's `do instead nothing` rule silently swallows the UPDATE. That is what this code used
   * to do, with a `.catch` that never fired because nothing ever failed — 8,202 history rows, not one
   * justification, including every compliance-locked change where a written reason is *required*. 0036
   * moves the read into the trigger; this is the write that feeds it.
   *
   * `true` makes it local to the transaction, so a reason cannot leak onto the next statement that shares
   * this pooled connection. `set_config` cannot store NULL, so absent becomes '' and the trigger
   * normalises it back.
   */
  await uow.sql`select set_config('berelax.justification', ${args.justification ?? ''}, true)`

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
      -- The nineteen therapist employment records (0050). Keyed by staff_reference, which is the
      -- internal handle and never a person's name: the panel says "Therapist 07 is an assumption", and
      -- the assumption IS that nothing but the headcount is known. P-HR-01 added the provenance trio to
      -- the employee table rather than reading the seed, so a row an admin confirms leaves the panel by
      -- having its flag cleared - the same way a confirmed setting does.
      union all
      select 'employee', staff_reference, open_question_id, provisional_note
        from employee where is_provisional
      -- The provisional style-skill split. A separate source from the employee row on purpose: an admin
      -- may confirm the person and not yet the skills, and one flag covering both would clear the panel
      -- for an answer nobody gave.
      union all
      select 'employee_skill', e.staff_reference || ' -> ' || s.skill::text,
             s.open_question_id, null
        from employee_skill s join employee e on e.id = s.employee_id where s.is_provisional
      union all
      select 'employee_language', e.staff_reference || ' -> ' || l.language::text,
             l.open_question_id, null
        from employee_language l join employee e on e.id = l.employee_id where l.is_provisional
      -- The working-hours rules (0059). Every figure in version 1 is the build's strictest reading of
      -- Federal Decree-Law 33 of 2021 and none is confirmed, so the whole row is one assumption keyed by
      -- the trading date it takes effect on. Per VERSION and not per figure: the multipliers, the caps,
      -- the night window and the week boundary are one decision somebody makes in one sitting, and a
      -- separate flag per column would let the panel clear for a rate change that answered nothing. The
      -- table is versioned rather than held in app_setting because payroll is asked about the past;
      -- answering Y9-overtime therefore publishes a NEW version and the panel row leaves by that version
      -- being confirmed, the way consent_wording's does.
      union all
      select 'working_hours_rule', 'rules effective ' || effective_from::text,
             open_question_id, provisional_note
        from working_hours_rule where is_provisional
      -- The leave policy (0066), for exactly the same reasons one subject along: every figure in version 1
      -- is the build's strictest reading of Federal Decree-Law 33 of 2021 and none is confirmed, so the
      -- whole row is one assumption keyed by the date it takes effect on. Per VERSION and not per figure,
      -- because the entitlement, the probation length, the carry-over cap, its expiry and the three
      -- sick-leave bands are one decision somebody makes in one sitting. Answering Y9-leave-detail
      -- publishes a NEW version and the panel row leaves by that version being confirmed.
      union all
      select 'leave_entitlement_rule', 'leave policy effective ' || effective_from::text,
             open_question_id, provisional_note
        from leave_entitlement_rule where is_provisional
      -- An IMPORTED leave opening balance that is itself an assumption (0066). Keyed by staff_reference,
      -- which is the internal handle and never a person's name. Only the imported ones can appear: an
      -- employee nobody has imported a balance for has no row to flag, and that absence is reported by
      -- readLeaveOpeningBalances() as a provisional zero naming Y8-leave rather than written into the
      -- table as a zero for everybody - which would make "nobody has told us" and "they had none" the
      -- same row.
      union all
      select 'leave_movement', e.staff_reference || ' opening balance',
             m.open_question_id, m.provisional_note
        from leave_movement m join employee e on e.id = m.employee_id
       where m.kind = 'opening_balance' and m.is_provisional
      -- The two CRM vocabularies (0053). They are TABLES rather than Postgres enums precisely so that
      -- each label can carry the provenance trio and reach this panel: an enum label has nowhere to put
      -- is_provisional, an OPEN-QUESTIONS id or a note, and a provisional value that cannot be marked
      -- provisional is indistinguishable from a configured one. Per LABEL and not per table, because the
      -- business can confirm one state or one channel without confirming the rest.
      union all
      select 'customer_lifecycle_state', state, open_question_id, provisional_note
        from customer_lifecycle_state where is_provisional
      union all
      select 'customer_acquisition_source', source, open_question_id, provisional_note
        from customer_acquisition_source where is_provisional
      -- The pipeline stages (0077). A third vocabulary, here for the two above's reason and one of its
      -- own: a board column is the most VISIBLE assumption in this system - the front desk reads six of
      -- them every day and drags people between them - and a column nobody has agreed to is a claim being
      -- made about every person on the board. Per LABEL, because the business can confirm one column
      -- without confirming the rest. No backtick appears in this comment, deliberately: it lives inside a
      -- JS template literal and one would end it early, which is how this paragraph first broke the build.
      -- Archived stages are included deliberately: a column taken off the board is
      -- still an unanswered question until somebody says the stage was wrong, and its row is what a
      -- reorder puts back.
      union all
      select 'pipeline_stage', stage_key, open_question_id, provisional_note
        from pipeline_stage where is_provisional
      -- The consent purposes and the consent wording (0056). The vocabulary is here for the same reason
      -- the two above are: a TABLE rather than an enum precisely so each label can carry the provenance
      -- trio and reach this panel. The WORDING is the one that matters most, and it is the reason the
      -- table carries the trio at all: a consent statement is legal copy, the build has drafted it
      -- (Y9-consent-wording), and a drafted statement that did not appear on this screen would be
      -- indistinguishable from one somebody's lawyer had approved. Keyed by purpose and version, because
      -- consent_wording is append-only: answering the question publishes version 2 and version 1 stays,
      -- so the panel row leaves by the NEW row being confirmed rather than by the old one being edited.
      -- The rota coverage and fatigue thresholds (0081). Here for working_hours_rule's reason exactly:
      -- a rota is asked about the PAST, so the thresholds are VERSIONED rows rather than app_setting
      -- values, and answering Y9-coverage publishes a NEW version whose confirmation is what clears the
      -- panel row. Per VERSION and not per figure, because the floor minimum, the wet-room minimum, the
      -- segment grid and the two daily caps are one decision somebody makes in one sitting. No backtick
      -- appears in this comment, for the reason the pipeline paragraph above states: it lives inside a JS
      -- template literal and one would end it early. The figure worth knowing while reading the note is
      -- that high_intensity_treatment_codes is EMPTY: no service in the catalogue is recorded as heavy
      -- work, so the 240-minute sub-cap is inert, and this row is where that is said out loud rather than
      -- discovered by a therapist who was never protected by it.
      union all
      select 'rota_coverage_rule', 'coverage effective ' || effective_from::text,
             open_question_id, provisional_note
        from rota_coverage_rule where is_provisional
      -- The monthly-wage divisors the labour-cost forecast needs (0081). A separate row from
      -- working_hours_rule's although both are flagged against Y9-overtime, and separate for the reason
      -- 0081 gives for the separate table: what an hour of a monthly salary is worth is a different
      -- question from what an uplift is, and one flag covering both would clear the panel for an answer
      -- nobody gave. P-HR-05's NOTE records that nobody has answered the monthly-to-hourly question at
      -- all, so this row is the first place the question is visible rather than deferred.
      union all
      select 'labour_cost_rule', 'wage divisors effective ' || effective_from::text,
             open_question_id, provisional_note
        from labour_cost_rule where is_provisional
      -- The attendance figures (0086). Here for working_hours_rule's reason and the sharpest instance of it:
      -- attendance is asked about the PAST more insistently than anything else in this build, so the grace
      -- windows are VERSIONED rows rather than app_setting values and answering Y9-attendance publishes a NEW
      -- version whose confirmation clears this row. Per VERSION and not per figure, because the two grace
      -- windows, the span above which a presence is not believed, the punch tolerance and how a punch is
      -- captured are one decision somebody makes in one sitting. No backtick appears in this comment, for the
      -- reason the pipeline paragraph above states: it lives inside a JS template literal and one would end
      -- it early. Two figures worth knowing while reading the note. CAPTURE IS MANUAL - there is no biometric
      -- reader and no device integration, which is a fact about what the business has rather than a decision
      -- this build made, and it is on the panel so the day a reader is bought it is a new version instead of
      -- a silent change in what every historical row meant. And a presence longer than twelve hours is NOT
      -- BELIEVED, so a forgotten clock-out closed the next morning pays nothing until somebody corrects it -
      -- which is the figure a therapist would want to know had been chosen on their behalf.
      union all
      select 'attendance_grace_rule', 'attendance effective ' || effective_from::text,
             open_question_id, provisional_note
        from attendance_grace_rule where is_provisional
      union all
      select 'consent_purpose', purpose, open_question_id, provisional_note
        from consent_purpose where is_provisional
      union all
      select 'consent_wording', purpose || ' v' || version::text, open_question_id, provisional_note
        from consent_wording where is_provisional
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
