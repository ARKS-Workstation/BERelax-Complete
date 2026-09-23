import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { SqlFragment, TherapistExclusion } from '../repositories/eligibility.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The compliance calendar: the reads, the writes, and the exclusion that takes a therapist off the floor.
 *
 * The **rule** is pure and lives in `packages/core/src/compliance/obligation.ts`: which dates a cadence
 * falls due on, what counts as overdue against a trading date, and which consequence each breach
 * carries. This package may not import it — the dependency runs core ← db — so what is here is the rows
 * and the statements, and the two are pinned to each other in
 * `packages/fixtures/src/obligation-calendar.itest.ts`, the only package that may import both.
 *
 * ## The generator takes a plan; it does not compute one
 *
 * {@link generateObligationInstances} is handed the occurrences `obligationInstancePlan` computed and
 * writes them. That split is what makes "two runs under the frozen clock produce identical rows" true
 * end to end: the plan is a pure function of the clock and the definitions, and the INSERT is idempotent
 * because `obligation_instance_one_per_due_date` is UNIQUE NULLS NOT DISTINCT. The second run inserts
 * nothing at all, so the rows it "produces" are the first run's — ids and creation instants included,
 * which is a stronger claim than a projection comparison and the reason the test can compare whole rows.
 *
 * A second implementation of the cadence arithmetic in SQL would be the tempting alternative and it is
 * the thing `recurring-cost.ts` warns about one directory over: two enumerations allow a period that is
 * forecast and never generated, or generated and never forecast, and neither is visible from either side.
 *
 * ## Blocking has no writer, and that is enforced three times over
 *
 * There is no function here that sets, clears or overrides a blocking flag, and there is no settings key
 * that reaches one — `@berelax/config`'s registry declares none, and `writeSetting` refuses an undeclared
 * key outright. Below that, `obligation.is_blocking` is GENERATED from `blocking_effect`, so no statement
 * can write it; and below that again, `refuse_obligation_shape_change()` (0052) refuses an UPDATE to any
 * column but the due date, for every role including the owner. {@link setObligationAnchorDate} is the
 * only writer this module offers for the definition, it changes the due date only, and it writes an
 * `audit_event` through the unit of work so the change has an actor and a reason attached.
 *
 * ## The availability consequence is a composable predicate, not a condition in a WHERE clause
 *
 * {@link overdueBlockingObligationExclusion} returns a {@link TherapistExclusion} — a named reason plus a
 * predicate — which the availability read composes into `therapistPoolCtes`'s `case` alongside any other
 * unit's exclusion. Written that way deliberately: C-CRM-01 is adding a second, independent exclusion to
 * the same path (a therapist/customer do-not-pair flag), and two filters inlined into one expression by
 * two branches is the merge that silently drops one of them.
 */

/**
 * The SQLSTATEs `0052_obligation.sql` raises. Matched on the code, never on the message.
 *
 * The two completion refusals carry the names the pure rule uses (`RoleNotPermitted`,
 * `EvidenceRequired`), so a caller reading `details.code` gets the same string whichever side refused.
 */
export const OBLIGATION_SQLSTATE = {
  /** A completion by a role that is neither the declared owner nor the owner. */
  roleNotPermitted: 'ZO001',
  /** A completion of an obligation that requires evidence, with none filed. */
  evidenceRequired: 'ZO002',
  /** An UPDATE to an obligation that changed anything but the due date. */
  shapeIsNotConfigurable: 'ZO003',
  /** An UPDATE or DELETE of filed evidence. */
  evidenceIsAppendOnly: 'ZO004',
} as const

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertIsoDate(what: string, value: string): void {
  if (!ISO_DATE.test(value)) {
    throw new AppError('validation', `${what} must be a YYYY-MM-DD date, received "${value}"`)
  }
}

/**
 * An obligation definition as the database holds it.
 *
 * Field for field `ObligationDefinition` in `@berelax/core`, which this package may not import. The
 * optional fields are **spread** rather than set to `undefined` by every reader below, because the core
 * type is declared under `exactOptionalPropertyTypes`: present-and-undefined and absent are different
 * types there, and only absence means "nothing on file".
 */
export interface ObligationDefinitionRow {
  readonly key: string
  readonly title: string
  readonly obligationClass: 'licence' | 'credential' | 'hygiene' | 'tax' | 'labour'
  readonly cadence: 'monthly' | 'quarterly' | 'annual' | 'event_driven'
  readonly subjectScope: 'business' | 'therapist'
  readonly ownerRole: string
  readonly blockingEffect: 'none' | 'therapist_unbookable' | 'publishing_blocked'
  readonly evidenceRequired: boolean
  readonly isUnverified: boolean
  /** Absent when no due date is on file. Generation then produces nothing for this obligation. */
  readonly anchorOn?: string
  readonly openQuestionId?: string
  /** Not part of the core shape: the panel and the dashboard show it, the rule does not read it. */
  readonly isBlocking: boolean
  readonly authority: string | null
  readonly unverifiedNote: string | null
  readonly sourceReference: string
}

interface DefinitionQueryRow {
  key: string
  title: string
  obligation_class: ObligationDefinitionRow['obligationClass']
  cadence: ObligationDefinitionRow['cadence']
  subject_scope: ObligationDefinitionRow['subjectScope']
  owner_role: string
  blocking_effect: ObligationDefinitionRow['blockingEffect']
  is_blocking: boolean
  evidence_required: boolean
  is_unverified: boolean
  unverified_note: string | null
  open_question_id: string | null
  source_reference: string
  authority: string | null
  anchor_on: string | null
}

/**
 * Every obligation definition, ordered by key.
 *
 * Ordered so a caller that enumerates them — the calendar UI, the unverified dashboard, the generator —
 * reads them in one order whatever the physical row order is. `anchor_on` comes back as text rather than
 * as a `Date`: it is a calendar date, and a driver that turned it into an instant would give it a
 * timezone it does not have and move it for anybody east of London.
 */
export async function readObligationDefinitions(
  sql: Sql,
): Promise<readonly ObligationDefinitionRow[]> {
  const rows = await sql<DefinitionQueryRow[]>`
    select key, title, obligation_class, cadence, subject_scope, owner_role, blocking_effect,
           is_blocking, evidence_required, is_unverified, unverified_note, open_question_id,
           source_reference, authority, anchor_on::text as anchor_on
      from obligation
     order by key
  `
  return rows.map((row) => ({
    key: row.key,
    title: row.title,
    obligationClass: row.obligation_class,
    cadence: row.cadence,
    subjectScope: row.subject_scope,
    ownerRole: row.owner_role,
    blockingEffect: row.blocking_effect,
    isBlocking: row.is_blocking,
    evidenceRequired: row.evidence_required,
    isUnverified: row.is_unverified,
    unverifiedNote: row.unverified_note,
    authority: row.authority,
    sourceReference: row.source_reference,
    ...(row.anchor_on === null ? {} : { anchorOn: row.anchor_on }),
    ...(row.open_question_id === null ? {} : { openQuestionId: row.open_question_id }),
  }))
}

/** One dated occurrence. Field for field `ObligationInstanceFacts` in `@berelax/core`. */
export interface ObligationInstanceRow {
  readonly instanceId: string
  readonly obligationKey: string
  readonly title: string
  readonly obligationClass: ObligationDefinitionRow['obligationClass']
  readonly blockingEffect: ObligationDefinitionRow['blockingEffect']
  readonly dueOn: string
  readonly status: 'open' | 'completed'
  readonly subjectEmployeeId?: string
}

/**
 * The occurrences, narrowable.
 *
 * `blockingOnly` is the publish guard's read: the CMS hook runs on every save and has no use for the
 * whole calendar. `keys` and `subjectEmployeeIds` narrow what a test can SEE rather than deleting rows —
 * the integration suite runs sequentially against one database and earlier files leave rows behind, and
 * `obligation_evidence.obligation_instance_id` is ON DELETE RESTRICT.
 */
export async function readObligationInstances(
  sql: Sql,
  filter: {
    readonly keys?: readonly string[]
    readonly subjectEmployeeIds?: readonly string[]
    readonly blockingOnly?: boolean
  } = {},
): Promise<readonly ObligationInstanceRow[]> {
  const keys = filter.keys === undefined ? null : [...filter.keys]
  const subjects = filter.subjectEmployeeIds === undefined ? null : [...filter.subjectEmployeeIds]
  const rows = await sql<
    {
      id: string
      key: string
      title: string
      obligation_class: ObligationDefinitionRow['obligationClass']
      blocking_effect: ObligationDefinitionRow['blockingEffect']
      due_on: string
      status: 'open' | 'completed'
      subject_employee_id: string | null
    }[]
  >`
    select i.id::text as id,
           o.key,
           o.title,
           o.obligation_class,
           o.blocking_effect,
           i.due_on::text as due_on,
           i.status,
           i.subject_employee_id::text as subject_employee_id
      from obligation_instance i
      join obligation o on o.id = i.obligation_id
     where (${keys}::text[] is null or o.key = any(${keys}::text[]))
       and (${subjects}::uuid[] is null or i.subject_employee_id = any(${subjects}::uuid[]))
       and (not ${filter.blockingOnly ?? false}::boolean or o.is_blocking)
     order by i.due_on, o.key, i.subject_employee_id nulls first
  `
  return rows.map((row) => ({
    instanceId: row.id,
    obligationKey: row.key,
    title: row.title,
    obligationClass: row.obligation_class,
    blockingEffect: row.blocking_effect,
    dueOn: row.due_on,
    status: row.status,
    ...(row.subject_employee_id === null ? {} : { subjectEmployeeId: row.subject_employee_id }),
  }))
}

/** One occurrence to write. The shape `obligationInstancePlan` in `@berelax/core` returns. */
export interface PlannedObligationInstanceRow {
  readonly obligationKey: string
  readonly dueOn: string
  readonly subjectEmployeeId?: string
}

export interface ObligationGenerationResult {
  /** How many occurrences the plan held. */
  readonly planned: number
  /** How many rows this run actually wrote. Zero on a second run over the same horizon. */
  readonly inserted: number
}

/**
 * Writes a plan. Idempotent, and that is the acceptance criterion rather than a nicety.
 *
 * One statement, whatever the size of the plan: the occurrences arrive as three parallel arrays and are
 * `unnest`ed into a join against `obligation`. A loop of inserts would be N round trips and — worse — N
 * chances to partially apply, so a generator interrupted half way would leave a calendar with a hole in
 * it and no way to tell which half ran.
 *
 * An unknown obligation key **throws** rather than being dropped by the join. The permissive version is
 * the dangerous one: a plan naming an obligation this database does not have would silently generate
 * nothing for it, and a blocking obligation that generates no occurrence never blocks — a compliance
 * control that is missing rather than failing.
 */
export async function generateObligationInstances(
  sql: Sql,
  plan: readonly PlannedObligationInstanceRow[],
): Promise<ObligationGenerationResult> {
  if (plan.length === 0) return { planned: 0, inserted: 0 }

  for (const row of plan) assertIsoDate(`obligation "${row.obligationKey}" due date`, row.dueOn)

  const keys = plan.map((row) => row.obligationKey)
  const known = await sql<{ key: string }[]>`
    select key from obligation where key = any(${[...new Set(keys)]}::text[])
  `
  const knownKeys = new Set(known.map((row) => row.key))
  const unknown = [...new Set(keys)].filter((key) => !knownKeys.has(key)).sort()
  if (unknown.length > 0) {
    throw new AppError(
      'not_found',
      `No obligation is defined for ${unknown.join(', ')}. A plan naming an obligation this database ` +
        'does not have would generate nothing for it, and a blocking obligation with no occurrence ' +
        'never blocks.',
      { details: { unknown } },
    )
  }

  const subjects = plan.map((row) => row.subjectEmployeeId ?? null)
  const dueDates = plan.map((row) => row.dueOn)

  const inserted = await sql<{ id: string }[]>`
    insert into obligation_instance (obligation_id, subject_employee_id, due_on)
    select o.id, p.subject_employee_id::uuid, p.due_on::date
      from unnest(${keys}::text[], ${subjects}::text[], ${dueDates}::text[])
             as p(obligation_key, subject_employee_id, due_on)
      join obligation o on o.key = p.obligation_key
    -- Named rather than inferred from the column list, because the constraint is NULLS NOT DISTINCT: it
    -- is what makes a business-wide occurrence (subject NULL) collide with itself on a second run
    -- instead of being inserted again.
    on conflict on constraint obligation_instance_one_per_due_date do nothing
    returning id::text as id
  `
  return { planned: plan.length, inserted: inserted.length }
}

/**
 * Files an attachment against an occurrence.
 *
 * Its own function rather than an argument to the completion, because the evidence is what makes the
 * completion permitted: the trigger in 0052 looks for a row here, so uploading and completing in one
 * call would hide the order they have to happen in. Append-only (ZO004), so a corrected attachment is a
 * new row and the one that was filed at the time stays readable.
 */
export async function fileObligationEvidence(
  uow: UnitOfWork,
  args: {
    readonly instanceId: string
    readonly storageKey: string
    readonly contentHash: string
    readonly uploadedByLabel: string
  },
): Promise<{ readonly evidenceId: string }> {
  const [row] = await uow.sql<{ id: string }[]>`
    insert into obligation_evidence
      (obligation_instance_id, storage_key, content_hash, uploaded_by_label)
    values (${args.instanceId}::uuid, ${args.storageKey}, ${args.contentHash},
            ${args.uploadedByLabel})
    returning id::text as id
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'The evidence row was not written and did not raise.')
  }
  await uow.audit.record({
    action: 'compliance.obligation_evidence.filed',
    entityType: 'obligation_evidence',
    entityId: row.id,
    operation: 'create',
    after: { instanceId: args.instanceId, contentHash: args.contentHash },
  })
  return { evidenceId: row.id }
}

/**
 * Completes an occurrence, or is refused by name.
 *
 * The refusals come from the database (0052) rather than from a check here, and the reason is the one
 * `recurring-cost.ts` gives for its own triggers: this service is one caller, and a `psql` session, a
 * later admin screen, a migration and a background job are four more. What this function adds is the
 * translation — SQLSTATE to a named `AppError` whose `details.code` is the same string the pure rule
 * reports — so no caller anywhere matches on a message.
 */
export async function completeObligationInstance(
  uow: UnitOfWork,
  args: {
    readonly instanceId: string
    readonly role: string
    readonly actorLabel: string
  },
): Promise<{ readonly completedAt: Date }> {
  try {
    const [row] = await uow.sql<{ completed_at: Date; key: string }[]>`
      update obligation_instance i
         set status = 'completed',
             completed_at = now(),
             completed_by_role = ${args.role},
             completed_by_label = ${args.actorLabel}
       where i.id = ${args.instanceId}::uuid
         and i.status = 'open'
      returning i.completed_at,
                (select o.key from obligation o where o.id = i.obligation_id) as key
    `
    if (row === undefined) {
      throw new AppError(
        'not_found',
        `No open obligation occurrence ${args.instanceId}. An already-completed occurrence is not ` +
          'completed again: the row records who signed it off and when, and a second completion would ' +
          'overwrite that.',
        { details: { instanceId: args.instanceId } },
      )
    }
    await uow.audit.record({
      action: 'compliance.obligation_instance.completed',
      entityType: 'obligation_instance',
      entityId: args.instanceId,
      operation: 'update',
      before: { status: 'open' },
      after: { status: 'completed', obligation: row.key, role: args.role },
    })
    return { completedAt: row.completed_at }
  } catch (error) {
    const state = sqlState(error)
    if (state === OBLIGATION_SQLSTATE.roleNotPermitted) {
      throw new AppError(
        'forbidden',
        `RoleNotPermitted: obligation occurrence ${args.instanceId} is not owed by the ${args.role}.`,
        {
          userFacing: true,
          details: { code: 'RoleNotPermitted', instanceId: args.instanceId, role: args.role },
          cause: error,
        },
      )
    }
    if (state === OBLIGATION_SQLSTATE.evidenceRequired) {
      throw new AppError(
        'validation',
        `EvidenceRequired: obligation occurrence ${args.instanceId} requires an attachment and none ` +
          'is filed against it.',
        {
          userFacing: true,
          details: { code: 'EvidenceRequired', instanceId: args.instanceId },
          cause: error,
        },
      )
    }
    throw error
  }
}

/**
 * Changes an obligation's due date. The only writer this module offers for a definition.
 *
 * Deliberately narrow, and the narrowness is the unit's value: everything else about an obligation —
 * whether it blocks, what it blocks, who owes it, whether evidence is required — is refused by
 * `refuse_obligation_shape_change()` for every role. So there is nothing for a settings key to write
 * even if somebody declared one, and `writeSetting` would refuse an undeclared key anyway.
 *
 * The audit row is not optional and not a convenience. A due date is the one thing about a compliance
 * control that a person may move, so moving it is exactly the act an inspection would ask about: who
 * changed the licence renewal date, when, and to what.
 */
export async function setObligationAnchorDate(
  uow: UnitOfWork,
  args: {
    readonly key: string
    /** The new first due date, or null to take a wrongly-entered one back off the calendar. */
    readonly anchorOn: string | null
    readonly reason: string
  },
): Promise<{ readonly previousAnchorOn: string | null }> {
  if (args.anchorOn !== null) assertIsoDate('An obligation anchor date', args.anchorOn)
  if (args.reason.trim() === '') {
    throw new AppError(
      'validation',
      'A due-date change needs a reason: the audit row exists so an inspection can be answered, and ' +
        '"updated" answers nothing.',
      { userFacing: true },
    )
  }

  const [row] = await uow.sql<{ previous: string | null; next: string | null }[]>`
    update obligation o
       set anchor_on = ${args.anchorOn}::date
     from (select key, anchor_on from obligation where key = ${args.key}) as was
     where o.key = was.key
    returning was.anchor_on::text as previous, o.anchor_on::text as next
  `
  if (row === undefined) {
    throw new AppError('not_found', `No obligation "${args.key}".`, {
      details: { key: args.key },
    })
  }

  await uow.audit.record({
    action: 'compliance.obligation.due_date_changed',
    entityType: 'obligation',
    entityId: args.key,
    operation: 'update',
    before: { anchorOn: row.previous },
    after: { anchorOn: row.next, reason: args.reason },
  })
  return { previousAnchorOn: row.previous }
}

/** Moves one occurrence's due date, with the same audit obligation. */
export async function rescheduleObligationInstance(
  uow: UnitOfWork,
  args: { readonly instanceId: string; readonly dueOn: string; readonly reason: string },
): Promise<{ readonly previousDueOn: string }> {
  assertIsoDate('An obligation due date', args.dueOn)
  if (args.reason.trim() === '') {
    throw new AppError('validation', 'A due-date change needs a reason.', { userFacing: true })
  }
  const [row] = await uow.sql<{ previous: string }[]>`
    update obligation_instance i
       set due_on = ${args.dueOn}::date
     from (select id, due_on from obligation_instance where id = ${args.instanceId}::uuid) as was
     where i.id = was.id
    returning was.due_on::text as previous
  `
  if (row === undefined) {
    throw new AppError('not_found', `No obligation occurrence ${args.instanceId}.`, {
      details: { instanceId: args.instanceId },
    })
  }
  await uow.audit.record({
    action: 'compliance.obligation_instance.due_date_changed',
    entityType: 'obligation_instance',
    entityId: args.instanceId,
    operation: 'update',
    before: { dueOn: row.previous },
    after: { dueOn: args.dueOn, reason: args.reason },
  })
  return { previousDueOn: row.previous }
}

/**
 * The reason a therapist excluded by this rule carries.
 *
 * Its own string and deliberately **not** one of the port's seven: `credential_expired` is a renewal of a
 * document on file, and this is an obligation in the calendar that nobody has completed. Sending the
 * front desk to the wrong screen is the cost of reusing the nearer-sounding reason.
 */
export const OVERDUE_BLOCKING_OBLIGATION_REASON = 'blocking_obligation_overdue' as const

/** The `name` the composed exclusion carries, so a collision names this unit. */
export const OVERDUE_BLOCKING_OBLIGATION_EXCLUSION = 'overdue_blocking_obligation' as const

/**
 * The availability consequence, as a **composable predicate** over the candidate row.
 *
 * Spliced into `therapistPoolCtes`'s `case` by the availability read, alongside any other unit's
 * exclusion — C-CRM-01's do-not-pair flag is the other one in flight. Returning a value rather than
 * editing the availability query is the whole point: two units inlining a condition into one WHERE
 * clause is the merge that keeps one of the two, and the lost one is invisible because the query still
 * compiles and still returns therapists.
 *
 * The predicate is `exists (…)` over the occurrences of a `therapist_unbookable` obligation that are
 * open and whose due date is **before the trading date being solved**:
 *
 *   - `o.blocking_effect = 'therapist_unbookable'` and not `o.is_blocking`, because a publishing block
 *     is a different consequence and must not take a therapist off the floor;
 *   - `i.status = 'open'`, so a renewal that has been completed and filed restores the therapist without
 *     anything having to be deleted;
 *   - `i.due_on < trading_date`, strictly. An obligation due today is due today and not late today, and
 *     the inclusive comparison would empty the rota on every renewal date;
 *   - the **trading date**, never `current_date`. Trading runs 11:00–02:00, so at 01:30 the business is
 *     still working the previous trading date and a therapist must not vanish mid-shift; and a read of
 *     the clock inside the query would also make the availability memo (0045's epoch) unverifiable,
 *     because the same statement would answer differently at 02:01 with nothing having been written.
 */
export function overdueBlockingObligationExclusion(
  sql: Sql,
  args: { readonly tradingDate: string },
): TherapistExclusion {
  assertIsoDate('A trading date', args.tradingDate)
  const when: SqlFragment = sql`
    exists (
      select 1
        from obligation_instance oi
        join obligation ob on ob.id = oi.obligation_id
       where oi.subject_employee_id = c.id
         and oi.status = 'open'
         and ob.blocking_effect = 'therapist_unbookable'
         and oi.due_on < ${args.tradingDate}::date
    )
  `
  return {
    name: OVERDUE_BLOCKING_OBLIGATION_EXCLUSION,
    reason: OVERDUE_BLOCKING_OBLIGATION_REASON,
    when,
  }
}

/**
 * Trading hours for one TRADING DATE, as the compliance calendar's as-of resolution needs them.
 *
 * Not `TradingHoursRow`, which `queries/premises-facts.ts` already uses for the WEEKLY pattern
 * (`day_of_week`, `open_time`). Two row types with one name, one meaning a weekday and the other a
 * date, would be confused at the first call site that held both.
 */
export interface TradingDateHoursRow {
  readonly tradingDate: string
  /** `HH:MM` in Asia/Dubai. */
  readonly open: string
  readonly close: string
}

/**
 * The `business_day` rows that could contain an instant, bracketed by calendar date.
 *
 * A SUPERSET on purpose, and the same bracket `reschedule.ts` reads for the same reason: WHICH of them
 * contains the instant is `resolveTradingDate`'s rule, and this package may not own it. ±1 calendar date
 * around the instant's own Dubai date is every row the resolver consults plus one, and the conversion is
 * `at time zone 'Asia/Dubai'` in SQL rather than a second timezone calculation here.
 *
 * Here rather than in a trading module because the publish gate is its only caller: the CMS hook has to
 * turn "now" into the date the calendar compares a due date against, and `complianceAsOfDate` in
 * `@berelax/core` is the one implementation of that rule.
 */
export async function readTradingHoursAround(
  sql: Sql,
  atMs: number,
): Promise<readonly TradingDateHoursRow[]> {
  const iso = new Date(atMs).toISOString()
  const rows = await sql<{ trading_date: string; open_time: string; close_time: string }[]>`
    select trading_date::text as trading_date,
           to_char(opens_at  at time zone 'Asia/Dubai', 'HH24:MI') as open_time,
           to_char(closes_at at time zone 'Asia/Dubai', 'HH24:MI') as close_time
      from business_day
     where trading_date between
             ((${iso}::timestamptz at time zone 'Asia/Dubai')::date - 1)
         and ((${iso}::timestamptz at time zone 'Asia/Dubai')::date + 1)
     order by trading_date
  `
  return rows.map((row) => ({
    tradingDate: row.trading_date,
    open: row.open_time,
    close: row.close_time,
  }))
}
