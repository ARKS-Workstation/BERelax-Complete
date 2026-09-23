import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The compliance calendar's notices: the reads, the writes, and the settlement of one notice.
 *
 * The **rule** is pure and lives in `packages/core/src/compliance/obligation-notice.ts`: which dates a
 * ladder falls due on, which role an unacknowledged duty escalates to, and what refuses a notice whose
 * deadline has moved. This package may not import it — the dependency runs core ← db — so what is here is
 * the rows and the statements, and the two are pinned to each other in `apps/worker`'s integration suite,
 * the one place that may import both and drive the job.
 *
 * ## The writer takes a plan; it does not compute one
 *
 * {@link planObligationNotices} is handed the notices `obligationNoticePlanFor` computed and writes them.
 * That split is what makes "each declared offset fires exactly one message per instance and never twice"
 * true end to end: the plan is a pure function of the occurrence and the two ladders, and the INSERT is
 * idempotent because `obligation_notice_one_pending_per_step` is a partial unique index. A second
 * implementation of the ladder arithmetic in SQL would be the defect `obligation.ts` warns about one file
 * over — two enumerations allow a notice that is planned and never written, or written and never planned,
 * and neither is visible from either side.
 *
 * ## The drain is 0051's, deliberately
 *
 * `claimObligationNotice` locks the row, re-reads the occurrence through it and returns everything the
 * verdict needs; the caller decides; {@link recordNoticeSent} and {@link recordNoticeSkipped} settle it.
 * Every outcome is a row state, which is the point: 0060's `obligation_notice_terminal_is_settled` makes
 * a row that left `pending` without a `settled_at` unstorable, so a silently-dropped notice is refused by
 * the database rather than looked for by a test.
 */

/** Why a notice write was refused. Named, so a caller branches without matching on a message. */
export const OBLIGATION_NOTICE_REFUSALS = [
  'notice_plan_not_derived',
  'notice_not_settled',
  'notice_role_not_accountable',
] as const
export type ObligationNoticeRefusal = (typeof OBLIGATION_NOTICE_REFUSALS)[number]

/** The SQLSTATEs 0060 raises. Matched on the code, never on the message. */
export const OBLIGATION_NOTICE_SQLSTATE = {
  /** A reminder addressed to anybody but the declared owner, or an escalation to the same role. */
  roleNotAccountable: 'ZN001',
  /** An UPDATE re-opening a settled notice. */
  noticeIsSettled: 'ZN002',
} as const

const refusal = (
  kind: 'conflict' | 'validation' | 'invariant_violated' | 'not_found',
  name: ObligationNoticeRefusal,
  message: string,
  extra: Record<string, unknown> = {},
): AppError =>
  new AppError(kind, `${name}: ${message}`, {
    userFacing: true,
    details: { refusal: name, ...extra },
  })

export function obligationNoticeRefusalOf(err: unknown): ObligationNoticeRefusal | null {
  const name = err instanceof AppError ? err.details['refusal'] : undefined
  return OBLIGATION_NOTICE_REFUSALS.includes(name as ObligationNoticeRefusal)
    ? (name as ObligationNoticeRefusal)
    : null
}

const sqlStateOf = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** One occurrence the planner needs to plan notices for. */
export interface NoticeSubjectRow {
  readonly instanceId: string
  readonly obligationKey: string
  readonly ownerRole: string
  readonly dueOn: string
  readonly status: 'open' | 'completed'
  readonly subjectEmployeeId?: string
}

/**
 * The open occurrences a notice plan is built over, in a stable order.
 *
 * `from`/`to` bracket the DUE DATE rather than the notify date, because the notify date is derived from
 * it by the ladder: bracketing what the ladder produces would make the work list depend on the setting,
 * and a change to the setting would then silently drop the occurrences whose old notices fell outside the
 * new window. Completed occurrences are excluded: a filed renewal has nothing left to chase, and the
 * notices already planned against it are settled by the drain with `obligation_completed` rather than by
 * being deleted.
 */
export async function readObligationNoticeSubjects(
  sql: Sql,
  filter: {
    readonly fromDueOn?: string
    readonly toDueOn?: string
    readonly keys?: readonly string[]
    readonly instanceIds?: readonly string[]
  } = {},
): Promise<readonly NoticeSubjectRow[]> {
  const keys = filter.keys === undefined ? null : [...filter.keys]
  const ids = filter.instanceIds === undefined ? null : [...filter.instanceIds]
  const rows = await sql<
    {
      id: string
      key: string
      owner_role: string
      due_on: string
      status: 'open' | 'completed'
      subject_employee_id: string | null
    }[]
  >`
    select i.id::text as id, o.key, o.owner_role, i.due_on::text as due_on, i.status,
           i.subject_employee_id::text as subject_employee_id
      from obligation_instance i
      join obligation o on o.id = i.obligation_id
     where i.status = 'open'
       and (${filter.fromDueOn ?? null}::date is null or i.due_on >= ${filter.fromDueOn ?? null}::date)
       and (${filter.toDueOn ?? null}::date is null or i.due_on <= ${filter.toDueOn ?? null}::date)
       and (${keys}::text[] is null or o.key = any(${keys}::text[]))
       and (${ids}::uuid[] is null or i.id = any(${ids}::uuid[]))
     order by i.due_on, o.key, i.subject_employee_id nulls first
  `
  return rows.map((row) => ({
    instanceId: row.id,
    obligationKey: row.key,
    ownerRole: row.owner_role,
    dueOn: row.due_on,
    status: row.status,
    ...(row.subject_employee_id === null ? {} : { subjectEmployeeId: row.subject_employee_id }),
  }))
}

/**
 * Which of these occurrences somebody has acknowledged.
 *
 * Its own read rather than a column added to `readObligationInstances`, which is M-VAT-10's: that reader
 * returns the shape `ObligationInstanceFacts` in `@berelax/core` is pinned to, and widening it would put
 * a field the blocking rule does not read into the type the blocking rule is checked against. The calendar
 * needs the flag and the availability exclusion does not.
 */
export async function readObligationAcknowledgements(
  sql: Sql,
  instanceIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (instanceIds.length === 0) return new Set()
  const rows = await sql<{ id: string }[]>`
    select id::text as id
      from obligation_instance
     where id = any(${[...instanceIds]}::uuid[])
       and acknowledged_at is not null
  `
  return new Set(rows.map((row) => row.id))
}

/** One notice to write. The shape `obligationNoticePlanFor` in `@berelax/core` returns. */
export interface PlannedObligationNoticeRow {
  readonly obligationInstanceId: string
  readonly step: string
  readonly kind: 'reminder' | 'escalation'
  readonly toRole: string
  readonly notifyOn: string
  readonly invalidationKey: string
}

export interface NoticePlanResult {
  readonly planned: number
  /** How many rows this run actually wrote. Zero on a second run over the same occurrences. */
  readonly inserted: number
}

/**
 * How a plan treats a (occurrence, step) pair that already has a notice.
 *
 * `new_only` is the DAILY PASS, and it is the mode that makes a repeated run a true no-op: a pair with any
 * notice against it — pending, sent, skipped or superseded — is left alone. Without it the pass would
 * re-create a pending row over every SKIPPED notice on every run, which in the shipped state (no staff
 * contact detail on file, so every notice is skipped as `no_recipient_on_file`) is one new row per notice
 * per day for ever.
 *
 * `rebuild` is the explicit recovery act announced by a settings change, and it is allowed to plan over a
 * terminal row — which is how a whole ladder skipped for a reason since fixed is recovered, exactly as
 * B-MSG-03's rebuild recovers a forward book of skipped steps. It still refuses to plan over a PENDING or
 * SENT one: the pending row is the live notice, and a second notice for a step already sent is the thing
 * `obligation_notice_one_send_per_step` exists to make impossible.
 */
export type NoticePlanMode = 'new_only' | 'rebuild'

/**
 * Writes a plan. Idempotent, and that is an acceptance criterion rather than a nicety.
 *
 * One statement whatever the size of the plan, for the reason `generateObligationInstances` gives: a loop
 * of inserts would be N round trips and N chances to partially apply, so a pass interrupted half way
 * would leave a calendar with a hole in it and no way to tell which half ran.
 *
 * Two layers stop a second notice for one (occurrence, step), and they answer different questions. The
 * `not exists` guard in the SELECT is the one that decides WHETHER this pass should plan the pair at all,
 * and it reads the modes above. The `on conflict` clause below it is the concurrency backstop: its arbiter
 * names the columns AND the index predicate — `(obligation_instance_id, step) where state = 'pending'` —
 * rather than a constraint name, because 0060's uniqueness is a partial INDEX and `on conflict on
 * constraint` accepts only a real constraint. The predicate is not decoration: it selects the PENDING
 * index and leaves the other one alone, so a conflict on `obligation_notice_one_send_per_step` is NOT
 * swallowed. An insert that would produce a second SENT notice therefore raises rather than being
 * discarded, and raising is right — silently discarding it would make a defect in the planner look like a
 * no-op.
 */
export async function planObligationNotices(
  uow: UnitOfWork,
  plan: readonly PlannedObligationNoticeRow[],
  mode: NoticePlanMode = 'new_only',
): Promise<NoticePlanResult> {
  if (plan.length === 0) return { planned: 0, inserted: 0 }

  const ids = plan.map((row) => row.obligationInstanceId)
  const steps = plan.map((row) => row.step)
  const kinds = plan.map((row) => row.kind)
  const roles = plan.map((row) => row.toRole)
  const notifyOn = plan.map((row) => row.notifyOn)
  const keys = plan.map((row) => row.invalidationKey)

  try {
    const inserted = await uow.sql<{ id: string }[]>`
      insert into obligation_notice
        (obligation_instance_id, step, kind, to_role, notify_on, invalidation_key)
      select p.instance_id::uuid, p.step, p.kind::obligation_notice_kind, p.to_role,
             p.notify_on::date, p.invalidation_key
        from unnest(${ids}::text[], ${steps}::text[], ${kinds}::text[], ${roles}::text[],
                    ${notifyOn}::text[], ${keys}::text[])
               as p(instance_id, step, kind, to_role, notify_on, invalidation_key)
       where not exists (
               select 1 from obligation_notice existing
                where existing.obligation_instance_id = p.instance_id::uuid
                  and existing.step = p.step
                  and (${mode} = 'new_only' or existing.state in ('pending', 'sent'))
             )
      on conflict (obligation_instance_id, step) where state = 'pending' do nothing
      returning id::text as id
    `
    return { planned: plan.length, inserted: inserted.length }
  } catch (error) {
    if (sqlStateOf(error) === OBLIGATION_NOTICE_SQLSTATE.roleNotAccountable) {
      throw refusal(
        'validation',
        'notice_role_not_accountable',
        'the plan addressed a reminder to a role that does not owe the obligation, or an escalation to ' +
          'the role that already receives the reminders. An escalation nobody new is accountable for is ' +
          'decoration, and 0060 refuses it for every role.',
        { cause: (error as Error).message },
      )
    }
    throw error
  }
}

/**
 * Supersedes every pending notice of one occurrence, and returns how many.
 *
 * `superseded` rather than deleted, for 0051's reason: the row is the record that the system intended to
 * send something and then did not, and the count of them is how "what did changing the ladder cost us"
 * is answerable. A DELETE would make a rebuild indistinguishable from a calendar that was never planned.
 */
export async function supersedePendingNotices(
  uow: UnitOfWork,
  input: { readonly instanceId: string; readonly atIso: string },
): Promise<number> {
  const rows = await uow.sql<{ id: string }[]>`
    update obligation_notice
       set state = 'superseded', settled_at = ${input.atIso}::timestamptz
     where obligation_instance_id = ${input.instanceId}::uuid
       and state = 'pending'
    returning id
  `
  return rows.length
}

/** Everything the verdict needs about one notice and the occurrence beneath it, under a row lock. */
export interface ClaimedNotice {
  readonly id: string
  readonly instanceId: string
  readonly obligationKey: string
  readonly obligationTitle: string
  readonly authority: string | null
  readonly ownerRole: string
  readonly step: string
  readonly kind: 'reminder' | 'escalation'
  readonly toRole: string
  readonly invalidationKey: string
  readonly notifyOn: string
  readonly state: string
  readonly dueOn: string
  readonly status: 'open' | 'completed'
  readonly acknowledged: boolean
  readonly subjectEmployeeId: string | null
}

/**
 * Locks one notice and re-reads the occurrence through it.
 *
 * `for no key update of n` and not a plain read, for the reason `claimScheduledStep` gives: the row is
 * held for the length of the send, so a completion or an acknowledgement arriving mid-send waits rather
 * than settling a notice whose message is already with a vendor. `for no key update` rather than
 * `for update` leaves the foreign keys referencing this row unblocked.
 */
export async function claimObligationNotice(
  sql: Sql,
  noticeId: string,
): Promise<ClaimedNotice | undefined> {
  const [row] = await sql<
    {
      id: string
      instance_id: string
      key: string
      title: string
      authority: string | null
      owner_role: string
      step: string
      kind: 'reminder' | 'escalation'
      to_role: string
      invalidation_key: string
      notify_on: string
      state: string
      due_on: string
      status: 'open' | 'completed'
      acknowledged: boolean
      subject_employee_id: string | null
    }[]
  >`
    select n.id::text as id, n.obligation_instance_id::text as instance_id,
           o.key, o.title, o.authority, o.owner_role,
           n.step, n.kind, n.to_role, n.invalidation_key, n.notify_on::text as notify_on,
           n.state::text as state, i.due_on::text as due_on, i.status,
           (i.acknowledged_at is not null) as acknowledged,
           i.subject_employee_id::text as subject_employee_id
      from obligation_notice n
      join obligation_instance i on i.id = n.obligation_instance_id
      join obligation o on o.id = i.obligation_id
     where n.id = ${noticeId}::uuid
       for no key update of n
  `
  if (row === undefined) return undefined
  return {
    id: row.id,
    instanceId: row.instance_id,
    obligationKey: row.key,
    obligationTitle: row.title,
    authority: row.authority,
    ownerRole: row.owner_role,
    step: row.step,
    kind: row.kind,
    toRole: row.to_role,
    invalidationKey: row.invalidation_key,
    notifyOn: row.notify_on,
    state: row.state,
    dueOn: row.due_on,
    status: row.status,
    acknowledged: row.acknowledged,
    subjectEmployeeId: row.subject_employee_id,
  }
}

/** Records the send. The message id is the evidence, and 0060 refuses `sent` without one. */
export async function recordNoticeSent(
  uow: UnitOfWork,
  input: {
    readonly noticeId: string
    readonly messageId: string
    readonly stalenessNote: string | null
    readonly atIso: string
  },
): Promise<void> {
  const rows = await uow.sql<{ id: string }[]>`
    update obligation_notice
       set state = 'sent', message_id = ${input.messageId},
           staleness_note = ${input.stalenessNote}, settled_at = ${input.atIso}::timestamptz
     where id = ${input.noticeId}::uuid and state = 'pending'
    returning id
  `
  if (rows.length !== 1) {
    throw refusal(
      'conflict',
      'notice_not_settled',
      `notice ${input.noticeId} was not pending when the send came back, so the message it produced has ` +
        'no notice to belong to. The row is locked for the length of the drain, so this means it was ' +
        'settled outside it.',
      { noticeId: input.noticeId, messageId: input.messageId },
    )
  }
}

/** Records the skip, with its reason code. Never a silent no-op: see 0060's `settled_at`. */
export async function recordNoticeSkipped(
  uow: UnitOfWork,
  input: { readonly noticeId: string; readonly reason: string; readonly atIso: string },
): Promise<void> {
  const rows = await uow.sql<{ id: string }[]>`
    update obligation_notice
       set state = 'skipped', skipped_reason = ${input.reason},
           settled_at = ${input.atIso}::timestamptz
     where id = ${input.noticeId}::uuid and state = 'pending'
    returning id
  `
  if (rows.length !== 1) {
    throw refusal(
      'conflict',
      'notice_not_settled',
      `notice ${input.noticeId} was not pending when the drain tried to skip it as '${input.reason}'.`,
      { noticeId: input.noticeId, reason: input.reason },
    )
  }
}

/**
 * Every pending notice whose date has arrived, oldest first. The sweep's work list.
 *
 * The comparison is against a DATE the caller resolved — {@link complianceAsOfDate} of the clock in
 * `@berelax/core` — and never `current_date`. Trading runs 11:00–02:00, so at 01:30 the business is still
 * working the previous trading date, and a read of the clock inside this statement would make the same
 * query answer differently at 02:01 with nothing having been written.
 */
export async function dueObligationNotices(
  sql: Sql,
  input: {
    readonly asOf: string
    readonly limit?: number
    /** Narrows the work list to named obligations, for the isolation reason the readers above give. */
    readonly keys?: readonly string[]
  },
): Promise<readonly { readonly id: string; readonly notifyOn: string }[]> {
  const keys = input.keys === undefined ? null : [...input.keys]
  const rows = await sql<{ id: string; notify_on: string }[]>`
    select n.id::text as id, n.notify_on::text as notify_on
      from obligation_notice n
      join obligation_instance i on i.id = n.obligation_instance_id
      join obligation o on o.id = i.obligation_id
     where n.state = 'pending' and n.notify_on <= ${input.asOf}::date
       and (${keys}::text[] is null or o.key = any(${keys}::text[]))
     -- A TOTAL order that does not depend on the ids. uuid_generate_v7() is time-ordered to the
     -- millisecond and random within it, and the planner writes a whole ladder in ONE statement -- so
     -- ordering by (notify_on, id) shuffles the notices of one pass between runs. The work list is then
     -- non-deterministic, which is a defect in its own right, and it also makes any test that reads the
     -- first item of it flake about once in two.
     order by n.notify_on, o.key, n.step, n.id
     limit ${input.limit ?? 500}
  `
  return rows.map((row) => ({ id: row.id, notifyOn: row.notify_on }))
}

/** Every notice of one occurrence, for a caller that wants to assert on the set. */
export async function obligationNoticesFor(
  sql: Sql,
  instanceId: string,
): Promise<
  readonly {
    readonly id: string
    readonly step: string
    readonly kind: string
    readonly toRole: string
    readonly state: string
    readonly notifyOn: string
    readonly invalidationKey: string
    readonly messageId: string | null
    readonly skippedReason: string | null
    readonly stalenessNote: string | null
  }[]
> {
  const rows = await sql<
    {
      id: string
      step: string
      kind: string
      to_role: string
      state: string
      notify_on: string
      invalidation_key: string
      message_id: string | null
      skipped_reason: string | null
      staleness_note: string | null
    }[]
  >`
    select id::text as id, step, kind::text as kind, to_role, state::text as state,
           notify_on::text as notify_on, invalidation_key, message_id::text as message_id,
           skipped_reason, staleness_note
      from obligation_notice
     where obligation_instance_id = ${instanceId}::uuid
     order by notify_on, step, id
  `
  return rows.map((row) => ({
    id: row.id,
    step: row.step,
    kind: row.kind,
    toRole: row.to_role,
    state: row.state,
    notifyOn: row.notify_on,
    invalidationKey: row.invalidation_key,
    messageId: row.message_id,
    skippedReason: row.skipped_reason,
    stalenessNote: row.staleness_note,
  }))
}

/**
 * Records that somebody has taken responsibility for an occurrence. What stops escalation.
 *
 * Audited, and the audit row is not a convenience. An acknowledgement is the one act that silences a
 * compliance notice, so it is exactly the act an inspection would ask about: who said they were dealing
 * with the licence renewal, and when. Without the row it is an off switch with no fingerprints.
 *
 * Idempotent in the direction that matters: acknowledging an already-acknowledged occurrence is refused
 * rather than overwriting the first actor, because the first actor is the one who took responsibility and
 * a second write would erase that.
 */
export async function acknowledgeObligationInstance(
  uow: UnitOfWork,
  args: {
    readonly instanceId: string
    readonly role: string
    readonly actorLabel: string
  },
): Promise<{ readonly acknowledgedAt: Date }> {
  const [row] = await uow.sql<{ acknowledged_at: Date; key: string }[]>`
    update obligation_instance i
       set acknowledged_at = now(),
           acknowledged_by_role = ${args.role},
           acknowledged_by_label = ${args.actorLabel}
     where i.id = ${args.instanceId}::uuid
       and i.acknowledged_at is null
    returning i.acknowledged_at,
              (select o.key from obligation o where o.id = i.obligation_id) as key
  `
  if (row === undefined) {
    throw new AppError(
      'not_found',
      `No unacknowledged obligation occurrence ${args.instanceId}. An acknowledgement is not recorded ` +
        'twice: the row names who took responsibility, and a second write would replace that with ' +
        'whoever clicked last.',
      { userFacing: true, details: { instanceId: args.instanceId } },
    )
  }
  await uow.audit.record({
    action: 'compliance.obligation_instance.acknowledged',
    entityType: 'obligation_instance',
    entityId: args.instanceId,
    operation: 'update',
    before: { acknowledged: false },
    after: { acknowledged: true, obligation: row.key, role: args.role },
  })
  return { acknowledgedAt: row.acknowledged_at }
}

/** The counts the compliance calendar prints, per obligation. Never a total over another unit's rows. */
export interface NoticeStateCount {
  readonly obligationKey: string
  readonly state: string
  readonly count: number
}

export async function obligationNoticeStateCounts(
  sql: Sql,
  filter: { readonly keys?: readonly string[] } = {},
): Promise<readonly NoticeStateCount[]> {
  const keys = filter.keys === undefined ? null : [...filter.keys]
  const rows = await sql<{ key: string; state: string; count: string }[]>`
    select o.key, n.state::text as state, count(*)::text as count
      from obligation_notice n
      join obligation_instance i on i.id = n.obligation_instance_id
      join obligation o on o.id = i.obligation_id
     where (${keys}::text[] is null or o.key = any(${keys}::text[]))
     group by o.key, n.state
     order by o.key, n.state
  `
  return rows.map((row) => ({
    obligationKey: row.key,
    state: row.state,
    // Counted in SQL and returned as text, then parsed: the driver returns a bigint as a string so a
    // count cannot silently lose precision, and a `limit`ed read would be the capped-reader defect
    // `settings-store.itest.ts` records — a limit is right for a panel and wrong for a count.
    count: Number(row.count),
  }))
}
