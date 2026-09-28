import { AppError, isFlowEndReason, type MessageChannel } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The interpreter's durable state: starting a run, claiming a node, logging a step, ending a run — and the
 * one query that answers "why did this contact get this message" (C-AUTO-07).
 *
 * `packages/db` may not import `@berelax/core`, so nothing here decides anything. What is here is exactly
 * the set of statements the worker's tick issues, each one shaped so the guarantee is the DATABASE's:
 *
 *   - **{@link claimNodeEffect} is the idempotency key, not a check.** It INSERTS with `on conflict on
 *     constraint flow_node_effect_once_per_contact do nothing returning id` and reports `duplicate` when no
 *     row comes back. That is the acceptance line's mechanism: *"Idempotency is a unique constraint on
 *     (flow_run, node, channel, contact)"*, and the typed outcome is derived from the constraint rather
 *     than from a caught exception whose message happened to mention uniqueness. A caller that read a
 *     `select` first would be trusting a read; a caller that caught 23505 would be reading prose.
 *   - **{@link claimFlowRun} locks the run.** `for update` on `flow_run`, so two deliveries of the same job
 *     serialise rather than racing each other through the same node — and the lock is held for the whole
 *     tick including the transport call, which is `send-scheduled-step.ts`'s decision and for its reason: a
 *     lock released before the send would let something else settle the run while a message was in flight.
 *   - **{@link endFlowRun} refuses a reason outside the vocabulary.** `flow_enrolment.ended_reason` and
 *     `flow_run.ended_reason` are `text` (0070's decision, and 0091 keeps it) because FLOW_END_REASONS is
 *     DERIVED from the DSL's exit reasons; `isFlowEndReason` at this one writer is what holds the column to
 *     the list instead of an enum that would be a third statement of it.
 *
 * ## Why the run reads the PINNED document and re-reads nothing
 *
 * {@link claimFlowRun} joins `flow_definition` on `(flow_id, definition_version)` — the composite key — and
 * never on `max(version)`. 0070's whole point is that an edit publishes N+1 and changes nothing about the
 * enrolments already running, and an interpreter that resolved the live version per tick would undo it in
 * one join.
 */

// ------------------------------------------------------------------------------------------------
// Refusals and the private SQLSTATEs
// ------------------------------------------------------------------------------------------------

/** Every reason a run write is refused, as a value. Callers branch on these, never on prose. */
export const FLOW_RUN_REFUSALS = [
  'flow_run_not_found',
  /** Advancing or ending a run that has already ended. A second ending overwrites the first's reason. */
  'flow_run_not_running',
  /** An `ended_reason` that is not in FLOW_END_REASONS. Fail closed rather than store free text. */
  'flow_run_end_reason_unknown',
  /** Starting a second live run for one enrolment. `flow_run_one_per_enrolment` is the backstop. */
  'flow_run_already_started',
] as const
export type FlowRunRefusal = (typeof FLOW_RUN_REFUSALS)[number]

/**
 * The private SQLSTATEs 0091 raises.
 *
 * `ZY011`-`ZY014`, which is a subclass RANGE and not a class. 0091's header sets out why at length; the
 * short of it is that this file first took `ZY001`-`ZY004` under the convention that a private class
 * identifies a migration, and by the merge FOUR migrations claimed `ZY001` — each having reasoned correctly
 * from what it could see. Every translator in this package matches on the code ALONE, so a shared code makes
 * a probe pass when the statement bounced off something else entirely. The rule now is W-SYS-12's: a refusal
 * is identified by all five characters, and two unrelated rules may share a class as long as they never
 * share a code. `ZY001`-`ZY008` are 0085's.
 */
export const FLOW_RUN_SQLSTATE = {
  stepLogAppendOnly: 'ZY011',
  nodeEffectImmutable: 'ZY012',
  dryRunSideEffect: 'ZY013',
  runIdentityImmutable: 'ZY014',
} as const

/** The audit actions this module writes. Named, so a coverage test can enumerate them. */
export const FLOW_RUN_AUDIT_ACTIONS = {
  started: 'flow_run.started',
  halted: 'flow_run.halted',
  ended: 'flow_run.ended',
} as const

function refuse(
  refusal: FlowRunRefusal,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new AppError(refusal === 'flow_run_not_found' ? 'not_found' : 'conflict', message, {
    details: { ...details, refusal },
  })
}

/** The named refusal carried on an error this module raised, or null. */
export function flowRunRefusalOf(err: unknown): FlowRunRefusal | null {
  if (!(err instanceof AppError)) return null
  const refusal = (err.details as { refusal?: unknown } | undefined)?.refusal
  return typeof refusal === 'string' && (FLOW_RUN_REFUSALS as readonly string[]).includes(refusal)
    ? (refusal as FlowRunRefusal)
    : null
}

// ------------------------------------------------------------------------------------------------
// Starting a run
// ------------------------------------------------------------------------------------------------

export interface StartFlowRunInput {
  /** NULL for a dry run: nobody is enrolled on a projection. */
  readonly enrolmentId: string | null
  readonly flowId: string
  readonly definitionVersion: number
  readonly mode: 'live' | 'dry_run'
  /** `MAX_FLOW_NODE_EXECUTIONS`, supplied so the ceiling a run was judged by is on its own row. */
  readonly maxNodeExecutions: number
  readonly startedAtIso: string
  /** A dry run's audience, whole. Required for a dry run and refused for a live one by a CHECK. */
  readonly projectedAudienceSize?: number
  /** Rows the cap stopped the projection producing. Reported, never trimmed in silence. */
  readonly projectedRowsOmitted?: number
}

export async function startFlowRun(uow: UnitOfWork, input: StartFlowRunInput): Promise<string> {
  const { sql } = uow
  const [row] = await sql<{ id: string }[]>`
    insert into flow_run (
      enrolment_id, flow_id, definition_version, mode, max_node_executions,
      elapsed_from, started_at, projected_audience_size, projected_rows_omitted
    ) values (
      ${input.enrolmentId}, ${input.flowId}::uuid, ${input.definitionVersion},
      ${input.mode}::flow_run_mode, ${input.maxNodeExecutions},
      ${input.startedAtIso}::timestamptz, ${input.startedAtIso}::timestamptz,
      ${input.projectedAudienceSize ?? null}, ${input.projectedRowsOmitted ?? null}
    )
    -- The unique index on enrolment_id is the backstop for a trigger delivered twice before the first
    -- tick committed. ON CONFLICT DO NOTHING rather than letting 23505 out, so the caller gets the named
    -- refusal below instead of a constraint name.
    on conflict on constraint flow_run_one_per_enrolment do nothing
    returning id
  `
  if (row === undefined) {
    refuse(
      'flow_run_already_started',
      `Enrolment ${String(input.enrolmentId)} already has a run. One enrolment is one run: a second ` +
        'would hold its own cursor and its own execution count, and the contact would be walked through ' +
        'the graph twice with two sets of idempotency tokens that cannot see each other.',
      { enrolmentId: input.enrolmentId },
    )
  }
  await uow.audit.record({
    action: FLOW_RUN_AUDIT_ACTIONS.started,
    entityType: 'flow_run',
    entityId: row.id,
    operation: 'create',
    after: {
      mode: input.mode,
      flowId: input.flowId,
      definitionVersion: input.definitionVersion,
      maxNodeExecutions: input.maxNodeExecutions,
      enrolmentId: input.enrolmentId,
    },
  })
  return row.id
}

// ------------------------------------------------------------------------------------------------
// Claiming the run for one tick
// ------------------------------------------------------------------------------------------------

export interface ClaimedFlowRun {
  readonly runId: string
  readonly enrolmentId: string | null
  readonly flowId: string
  readonly flowKey: string
  readonly definitionVersion: number
  readonly mode: 'live' | 'dry_run'
  readonly status: string
  readonly nodeExecutions: number
  readonly maxNodeExecutions: number
  readonly cursorNodeId: string | null
  readonly resumeAtIso: string | null
  readonly elapsedFromIso: string
  /** The PINNED document, reached through the composite key and never through `max(version)`. */
  readonly definition: unknown
  /** The contact the enrolment is about, or null for a dry run. */
  readonly customerId: string | null
  /**
   * Who the contact IS now, following the merge chain — `merge_survivor_of(customer_id)`.
   *
   * Equal to `customerId` for a live contact. When it differs, the contact was merged away while this run
   * was in flight AND the survivor already held an active enrolment on this flow (or the re-point would
   * have moved this row), so continuing would send the survivor the same node twice. The worker cancels
   * with `contact_merged_away`; resolving it HERE rather than in the worker is what keeps the chain
   * following logic in the one SQL function 0069 built for it.
   */
  readonly survivorCustomerId: string | null
}

/**
 * Locks one run and reads everything a tick needs, in one statement.
 *
 * `for update` on the run row and on nothing else: the enrolment's own lock belongs to
 * `endFlowEnrolment`, and taking both here in this order would be a second lock ordering for the same two
 * tables.
 */
export async function claimFlowRun(sql: Sql, runId: string): Promise<ClaimedFlowRun | null> {
  const [locked] = await sql<{ id: string }[]>`
    select id from flow_run where id = ${runId}::uuid for update
  `
  if (locked === undefined) return null
  const [row] = await sql<
    {
      id: string
      enrolmentId: string | null
      flowId: string
      flowKey: string
      definitionVersion: number
      mode: 'live' | 'dry_run'
      status: string
      nodeExecutions: number
      maxNodeExecutions: number
      cursorNodeId: string | null
      resumeAt: Date | null
      elapsedFrom: Date
      definition: unknown
      customerId: string | null
      survivorCustomerId: string | null
    }[]
  >`
    select r.id,
           r.enrolment_id                      as "enrolmentId",
           r.flow_id                           as "flowId",
           f.flow_key                          as "flowKey",
           r.definition_version                as "definitionVersion",
           r.mode::text                        as mode,
           r.status::text                      as status,
           r.node_executions                   as "nodeExecutions",
           r.max_node_executions               as "maxNodeExecutions",
           r.cursor_node_id                    as "cursorNodeId",
           r.resume_at                         as "resumeAt",
           r.elapsed_from                      as "elapsedFrom",
           d.definition,
           e.customer_id                       as "customerId",
           merge_survivor_of(e.customer_id)    as "survivorCustomerId"
      from flow_run r
      join flow f on f.id = r.flow_id
      -- THE pin. On (flow_id, definition_version) and never on max(version): an interpreter that
      -- resolved the live version per tick would undo 0070 in one join.
      join flow_definition d
        on d.flow_id = r.flow_id and d.version = r.definition_version
      left join flow_enrolment e on e.id = r.enrolment_id
     where r.id = ${runId}::uuid
  `
  if (row === undefined) return null
  return {
    runId: row.id,
    enrolmentId: row.enrolmentId,
    flowId: row.flowId,
    flowKey: row.flowKey,
    definitionVersion: row.definitionVersion,
    mode: row.mode,
    status: row.status,
    nodeExecutions: row.nodeExecutions,
    maxNodeExecutions: row.maxNodeExecutions,
    cursorNodeId: row.cursorNodeId,
    resumeAtIso: row.resumeAt === null ? null : row.resumeAt.toISOString(),
    elapsedFromIso: row.elapsedFrom.toISOString(),
    definition: row.definition,
    customerId: row.customerId,
    survivorCustomerId: row.survivorCustomerId,
  }
}

// ------------------------------------------------------------------------------------------------
// The idempotency token
// ------------------------------------------------------------------------------------------------

export interface NodeEffectKey {
  readonly runId: string
  readonly nodeId: string
  readonly channel: MessageChannel
  readonly contactCustomerId: string
}

/**
 * What a claim produced. `duplicate` is the acceptance line's typed outcome.
 *
 * A VALUE and not an exception, which is the difference the line insists on: *"`duplicate` must be a typed
 * outcome the caller can read — not a swallowed generic error whose message happens to mention
 * uniqueness"*. The caller branches on `kind` and never reads a message.
 */
export type NodeEffectClaim =
  | { readonly kind: 'claimed'; readonly effectId: string }
  | { readonly kind: 'duplicate' }

/**
 * Claims one (run, node, channel, contact), or reports that it is already taken.
 *
 * Called BEFORE the transport, so a replayed job asks no vendor anything. The absence of a returned row is
 * the whole mechanism: `on conflict ... do nothing` makes the unique constraint answer the question, and
 * the statement is the same one whether this is the first delivery or the fiftieth.
 */
export async function claimNodeEffect(
  sql: Sql,
  key: NodeEffectKey,
  claimedAtIso: string,
): Promise<NodeEffectClaim> {
  const [row] = await sql<{ id: string }[]>`
    insert into flow_node_effect (flow_run_id, node_id, channel, contact_customer_id, claimed_at)
    values (
      ${key.runId}::uuid, ${key.nodeId}, ${key.channel}::message_channel,
      ${key.contactCustomerId}::uuid, ${claimedAtIso}::timestamptz
    )
    on conflict on constraint flow_node_effect_once_per_contact do nothing
    returning id
  `
  return row === undefined ? { kind: 'duplicate' } : { kind: 'claimed', effectId: row.id }
}

/**
 * The message this node HELD for the promotional window, if it is still waiting.
 *
 * The one read that makes a release possible, and it is why the token alone is not enough: a replayed job
 * and a scheduled RELEASE arrive at the same node with the same token already claimed, and the two must not
 * do the same thing. A replay has nothing to release and answers `duplicate`; a release finds a message row
 * that is still `queued` and moves it.
 *
 * `m.status = 'queued'` is the whole discriminator, and it cannot go stale: a message that was sent, failed
 * or expired has left `queued` for ever (`refuse_message_status_regression`, 0035), so a second release of
 * one message finds nothing and falls back to `duplicate`. Newest first, because a hold that was released
 * into another hold — the window narrowed under it — has two `held` rows and the later one is the live one.
 */
export interface HeldStepRead {
  readonly stepLogId: string
  readonly messageId: string
  /** When the message was first queued. The gate measures the hold's age from it. */
  readonly queuedAtIso: string
}

export async function readHeldStepForNode(
  sql: Sql,
  key: {
    readonly runId: string
    readonly nodeId: string
    readonly channel: MessageChannel
    readonly contactCustomerId: string
  },
): Promise<HeldStepRead | null> {
  const [row] = await sql<{ stepLogId: string; messageId: string; queuedAt: Date }[]>`
    select s.id as "stepLogId", s.message_id as "messageId", m.queued_at as "queuedAt"
      from flow_step_log s
      join message m on m.id = s.message_id
     where s.flow_run_id = ${key.runId}::uuid
       and s.node_id = ${key.nodeId}
       and s.channel = ${key.channel}::message_channel
       and s.contact_customer_id = ${key.contactCustomerId}::uuid
       and s.outcome = 'held'
       and m.status = 'queued'
     order by s.recorded_at desc, s.id desc
     limit 1
  `
  return row === undefined
    ? null
    : {
        stepLogId: row.stepLogId,
        messageId: row.messageId,
        queuedAtIso: row.queuedAt.toISOString(),
      }
}

/** How many tokens a run holds. The count the 50-delivery case reads to prove one execution. */
export async function countNodeEffects(sql: Sql, runId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from flow_node_effect where flow_run_id = ${runId}::uuid
  `
  return Number(row?.n ?? '0')
}

// ------------------------------------------------------------------------------------------------
// The step log
// ------------------------------------------------------------------------------------------------

export interface StepLogRow {
  readonly runId: string
  readonly flowId: string
  readonly definitionVersion: number
  readonly nodeId: string
  readonly nodeKind: string
  readonly branch: string
  readonly outcome: 'executed' | 'duplicate' | 'held' | 'refused' | 'no_effect'
  readonly contactCustomerId: string
  readonly channel: MessageChannel | null
  readonly templateKey: string | null
  readonly messageId: string | null
  /** From `resolveConsent(...).recordId`. The id the gate's boolean actually rested on. */
  readonly consentRecordId: string | null
  readonly gateDecision: string | null
  readonly plannedAtIso: string
  readonly encoding: string | null
  readonly segments: number | null
  readonly costFils: number | null
  readonly detail: string | null
}

/**
 * Appends one step. Never updated: a step that was wrong is corrected by the next run's rows (ZY011).
 *
 * Takes the caller's `sql` so the row commits with the side effect it describes. A store bound to the pool
 * would write the log in its own transaction, and a tick that rolled back afterwards would leave a step log
 * claiming a message that does not exist — which is the failure `frequency-ledger.ts` states about its own
 * ledger row, one table along.
 */
export async function recordStepLog(sql: Sql, row: StepLogRow): Promise<string> {
  const [inserted] = await sql<{ id: string }[]>`
    insert into flow_step_log (
      flow_run_id, flow_id, definition_version, node_id, node_kind, branch, outcome,
      contact_customer_id, channel, template_key, message_id, consent_record_id, gate_decision,
      planned_at, encoding, segments, cost_fils, detail
    ) values (
      ${row.runId}::uuid, ${row.flowId}::uuid, ${row.definitionVersion}, ${row.nodeId},
      ${row.nodeKind}, ${row.branch}, ${row.outcome}::flow_node_outcome,
      ${row.contactCustomerId}::uuid,
      ${row.channel}::message_channel, ${row.templateKey}, ${row.messageId}, ${row.consentRecordId},
      ${row.gateDecision}, ${row.plannedAtIso}::timestamptz,
      ${row.encoding}, ${row.segments}, ${row.costFils}, ${row.detail}
    )
    returning id
  `
  if (inserted === undefined) {
    throw new AppError(
      'invariant_violated',
      'The flow step log insert returned no row. A step with no log row is a message nobody can explain, ' +
        'which is the one outcome this table exists to make impossible.',
      { details: { runId: row.runId, nodeId: row.nodeId } },
    )
  }
  return inserted.id
}

/** One step, as the "why did this contact get this message" read returns it. */
export interface ContactStepLogEntry {
  readonly id: string
  readonly flowRunId: string
  readonly flowKey: string
  readonly definitionVersion: number
  readonly nodeId: string
  readonly nodeKind: string
  readonly branch: string
  readonly outcome: string
  readonly channel: string | null
  readonly templateKey: string | null
  readonly messageId: string | null
  readonly consentRecordId: string | null
  readonly gateDecision: string | null
  readonly plannedAtIso: string
  readonly detail: string | null
}

/**
 * THE read: why did this contact get this message.
 *
 * ## One statement, and the `flow_key` join is the one thing that is not free
 *
 * The acceptance line is *"'why did this contact get this message' is one query"*, and the four facts it
 * names — definition version, node id, resolved consent record id, gate decision — are all columns on
 * `flow_step_log`, denormalised for exactly this reason. `flow_key` is joined because a human reads a key
 * and not a uuid, and one join to a one-row-per-flow table is still one query; the acceptance's four facts
 * need none.
 *
 * `messageId` narrows it to a single message. Omitted, it is the contact's whole automation history newest
 * first, which is the panel version of the same question.
 */
export async function readContactStepLog(
  sql: Sql,
  args: { readonly contactCustomerId: string; readonly messageId?: string },
): Promise<readonly ContactStepLogEntry[]> {
  const rows = await sql<
    {
      id: string
      flowRunId: string
      flowKey: string
      definitionVersion: number
      nodeId: string
      nodeKind: string
      branch: string
      outcome: string
      channel: string | null
      templateKey: string | null
      messageId: string | null
      consentRecordId: string | null
      gateDecision: string | null
      plannedAt: Date
      detail: string | null
    }[]
  >`
    select s.id,
           s.flow_run_id        as "flowRunId",
           f.flow_key           as "flowKey",
           s.definition_version as "definitionVersion",
           s.node_id            as "nodeId",
           s.node_kind          as "nodeKind",
           s.branch,
           s.outcome::text      as outcome,
           s.channel::text      as channel,
           s.template_key       as "templateKey",
           s.message_id         as "messageId",
           s.consent_record_id  as "consentRecordId",
           s.gate_decision      as "gateDecision",
           s.planned_at         as "plannedAt",
           s.detail
      from flow_step_log s
      join flow f on f.id = s.flow_id
     where s.contact_customer_id = ${args.contactCustomerId}::uuid
       and (${args.messageId ?? null}::uuid is null or s.message_id = ${args.messageId ?? null}::uuid)
     order by s.planned_at desc, s.id desc
  `
  return rows.map((row) => ({
    id: row.id,
    flowRunId: row.flowRunId,
    flowKey: row.flowKey,
    definitionVersion: row.definitionVersion,
    nodeId: row.nodeId,
    nodeKind: row.nodeKind,
    branch: row.branch,
    outcome: row.outcome,
    channel: row.channel,
    templateKey: row.templateKey,
    messageId: row.messageId,
    consentRecordId: row.consentRecordId,
    gateDecision: row.gateDecision,
    plannedAtIso: row.plannedAt.toISOString(),
    detail: row.detail,
  }))
}

/**
 * Every row of one run, oldest first. The dry run's plan as an operator reads it.
 *
 * A wider row than {@link ContactStepLogEntry}: the contact is on it, because a dry run's rows are ABOUT
 * many contacts, and so is the costing, because a projection is a quotation and a quotation with no figures
 * is a list of nodes.
 */
export interface RunStepLogEntry extends ContactStepLogEntry {
  readonly contactCustomerId: string
  readonly encoding: string | null
  readonly segments: number | null
  readonly costFils: number | null
}

export async function readRunStepLog(sql: Sql, runId: string): Promise<readonly RunStepLogEntry[]> {
  const rows = await sql<
    {
      id: string
      flowKey: string
      definitionVersion: number
      nodeId: string
      nodeKind: string
      branch: string
      outcome: string
      contactCustomerId: string
      channel: string | null
      templateKey: string | null
      messageId: string | null
      consentRecordId: string | null
      gateDecision: string | null
      plannedAt: Date
      detail: string | null
      encoding: string | null
      segments: number | string | null
      costFils: number | string | null
    }[]
  >`
    select s.id, f.flow_key as "flowKey", s.definition_version as "definitionVersion",
           s.node_id as "nodeId", s.node_kind as "nodeKind", s.branch, s.outcome::text as outcome,
           s.contact_customer_id as "contactCustomerId", s.channel::text as channel,
           s.template_key as "templateKey", s.message_id as "messageId",
           s.consent_record_id as "consentRecordId", s.gate_decision as "gateDecision",
           s.planned_at as "plannedAt", s.detail, s.encoding, s.segments, s.cost_fils as "costFils"
      from flow_step_log s
      join flow f on f.id = s.flow_id
     where s.flow_run_id = ${runId}::uuid
     order by s.planned_at, s.id
  `
  return rows.map((row) => ({
    ...row,
    flowRunId: runId,
    plannedAtIso: row.plannedAt.toISOString(),
    // `fils` is a domain over bigint, which postgres.js hands over as a STRING rather than a number — the
    // same reason every money read in this package converts explicitly. A caller comparing it numerically
    // against a budget would otherwise be comparing a string.
    costFils: row.costFils === null ? null : Number(row.costFils),
    segments: row.segments === null ? null : Number(row.segments),
  }))
}

// ------------------------------------------------------------------------------------------------
// Advancing and ending a run
// ------------------------------------------------------------------------------------------------

export interface AdvanceFlowRunInput {
  readonly runId: string
  readonly cursorNodeId: string | null
  readonly nodeExecutions: number
  /** When the run should resume, or null when it is continuing immediately. */
  readonly resumeAtIso: string | null
  /** The instant the next leg's delays are measured from. */
  readonly elapsedFromIso: string
}

/**
 * Moves the cursor and the counter.
 *
 * `node_executions` is written as an absolute figure rather than incremented, because the worker's plan
 * already knows how many it performed and two sources for one counter is how a cap comes to be off by one.
 * `flow_run_executions_within_bound` refuses a figure past the row's own ceiling whatever this passes.
 */
export async function advanceFlowRun(sql: Sql, input: AdvanceFlowRunInput): Promise<void> {
  const [row] = await sql<{ id: string }[]>`
    update flow_run
       set cursor_node_id  = ${input.cursorNodeId},
           node_executions = ${input.nodeExecutions},
           resume_at       = ${input.resumeAtIso},
           elapsed_from    = ${input.elapsedFromIso}::timestamptz
     where id = ${input.runId}::uuid and status = 'running'
    returning id
  `
  if (row === undefined) {
    refuse(
      'flow_run_not_running',
      `Run ${input.runId} is not running, so its cursor was not moved. A run that has ended stays ` +
        'ended: advancing one would resume a flow somebody stopped.',
      { runId: input.runId },
    )
  }
}

export interface EndFlowRunInput {
  readonly runId: string
  readonly status: 'completed' | 'loop_detected' | 'cancelled'
  /** From FLOW_END_REASONS. Refused by name otherwise. */
  readonly reason: string
  readonly atIso: string
}

/**
 * Ends a run and says why, refusing a reason nobody declared.
 *
 * The vocabulary guard is here rather than in the schema because `FLOW_END_REASONS` is DERIVED from the
 * DSL's exit reasons plus the interpreter's halts (`@berelax/shared`), so an enum in SQL would be a third
 * statement of an already-computed list — and the first thing to break would be the ninth exit reason
 * somebody draws. One writer, one guard.
 */
export async function endFlowRun(uow: UnitOfWork, input: EndFlowRunInput): Promise<void> {
  if (!isFlowEndReason(input.reason)) {
    refuse(
      'flow_run_end_reason_unknown',
      `"${input.reason}" is not one of FLOW_END_REASONS. The column is text because the vocabulary is ` +
        "derived from the DSL's own exit reasons, so this guard is what holds it to the list — free text " +
        'here would make "why did this run stop" a report with a category of one.',
      { runId: input.runId, reason: input.reason },
    )
  }
  const { sql } = uow
  const [row] = await sql<{ id: string }[]>`
    update flow_run
       set status       = ${input.status}::flow_run_status,
           ended_at     = ${input.atIso}::timestamptz,
           ended_reason = ${input.reason},
           resume_at    = null
     where id = ${input.runId}::uuid and status = 'running'
    returning id
  `
  if (row === undefined) {
    refuse(
      'flow_run_not_running',
      `Run ${input.runId} has already ended. A second ending would overwrite the first one's reason, ` +
        'and the first one is the record of why it stopped.',
      { runId: input.runId, status: input.status },
    )
  }
  await uow.audit.record({
    action:
      input.status === 'loop_detected'
        ? FLOW_RUN_AUDIT_ACTIONS.halted
        : FLOW_RUN_AUDIT_ACTIONS.ended,
    entityType: 'flow_run',
    entityId: input.runId,
    operation: 'update',
    after: { status: input.status, reason: input.reason },
  })
}

/** One run, read back. The evidence a test reads about a halt. */
export interface FlowRunRow {
  readonly id: string
  readonly mode: string
  readonly status: string
  readonly nodeExecutions: number
  readonly maxNodeExecutions: number
  readonly cursorNodeId: string | null
  readonly resumeAtIso: string | null
  readonly endedReason: string | null
  readonly projectedAudienceSize: number | null
  readonly projectedRowsOmitted: number | null
}

export async function readFlowRun(sql: Sql, runId: string): Promise<FlowRunRow | null> {
  const [row] = await sql<
    {
      id: string
      mode: string
      status: string
      nodeExecutions: number
      maxNodeExecutions: number
      cursorNodeId: string | null
      resumeAt: Date | null
      endedReason: string | null
      projectedAudienceSize: number | null
      projectedRowsOmitted: number | null
    }[]
  >`
    select id, mode::text as mode, status::text as status, node_executions as "nodeExecutions",
           max_node_executions as "maxNodeExecutions", cursor_node_id as "cursorNodeId",
           resume_at as "resumeAt", ended_reason as "endedReason",
           projected_audience_size as "projectedAudienceSize",
           projected_rows_omitted as "projectedRowsOmitted"
      from flow_run where id = ${runId}::uuid
  `
  return row === undefined
    ? null
    : { ...row, resumeAtIso: row.resumeAt === null ? null : row.resumeAt.toISOString() }
}

/** The live run of one enrolment, if it has started. */
export async function readRunForEnrolment(sql: Sql, enrolmentId: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    select id from flow_run where enrolment_id = ${enrolmentId}::uuid
  `
  return row?.id ?? null
}

// ------------------------------------------------------------------------------------------------
// The facts a condition is answered from
// ------------------------------------------------------------------------------------------------

/**
 * Everything a condition needs about one contact EXCEPT marketing consent.
 *
 * Consent is deliberately absent, and the absence is the design. `resolveConsent` is `@berelax/core`'s and
 * is a fold over an append-only log at an instant; this package may not import it, and a second answer to
 * "is this contact opted in" computed in SQL would be exactly the drift `resolveConsent`'s own header is
 * about. So the worker reads the consent LOG (`readConsentLogs`) once — the same read the gate's evaluators
 * are built over — resolves it once, and supplies the boolean and the record id from that single answer.
 *
 * `hasFutureAppointment` is asked as at the instant the tick is running at, not `now()`: every other
 * instant in a run comes from the job context, and a fact read off the server clock would make a frozen
 * clock in a test disagree with the rest of the tick.
 */
export interface FlowContactInputs {
  readonly hasFutureAppointment: boolean
  readonly isVip: boolean
  readonly isBlocklisted: boolean
  readonly lifecycleState: string
  readonly tags: readonly string[]
  readonly locale: string
}

export async function readFlowContactInputs(
  sql: Sql,
  args: { readonly customerId: string; readonly atIso: string },
): Promise<FlowContactInputs | null> {
  const [row] = await sql<
    {
      isVip: boolean
      isBlocklisted: boolean
      lifecycleState: string
      locale: string
      hasFutureAppointment: boolean
      tags: readonly string[]
    }[]
  >`
    select c.is_vip         as "isVip",
           c.lifecycle_state as "lifecycleState",
           c.locale,
           exists (
             select 1 from customer_blocklist b
              where b.customer_id = c.id and b.lifted_at is null
           )              as "isBlocklisted",
           exists (
             select 1
               from appointment a
               join booking bk on bk.id = a.booking_id
              where bk.customer_id = c.id
                and lower(a.period) > ${args.atIso}::timestamptz
                and a.status in ('confirmed', 'checked_in')
           )              as "hasFutureAppointment",
           coalesce(
             (select array_agg(t.tag order by t.tag) from customer_tag t where t.customer_id = c.id),
             '{}'::text[]
           )              as tags
      from customer c
     where c.id = ${args.customerId}::uuid
  `
  return row === undefined
    ? null
    : {
        hasFutureAppointment: row.hasFutureAppointment,
        isVip: row.isVip,
        isBlocklisted: row.isBlocklisted,
        lifecycleState: row.lifecycleState,
        tags: [...row.tags],
        locale: row.locale,
      }
}

/** Applies a tag, idempotently. The `action_tag` node's whole side effect. */
export async function applyCustomerTag(
  sql: Sql,
  args: { readonly customerId: string; readonly tag: string },
): Promise<boolean> {
  const [row] = await sql<{ customer_id: string }[]>`
    insert into customer_tag (customer_id, tag)
    values (${args.customerId}::uuid, ${args.tag})
    on conflict (customer_id, tag) do nothing
    returning customer_id
  `
  return row !== undefined
}
