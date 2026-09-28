import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { consent } from './consent.ts'
import { flowDefinition } from './flow.ts'
import { message } from './message.ts'

/**
 * Drizzle mirror of 0091_flow_run.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * Five things the mirror cannot say, and each one will bite somebody who builds a write from these
 * definitions instead of calling `packages/db/src/repositories/flow-run.ts`:
 *
 *   - **`flowStepLog` is append-only.** UPDATE and DELETE are revoked from `berelax_app` AND refused by a
 *     BEFORE trigger for every role including the owner (ZY001). `db.update(flowStepLog)` typechecks
 *     perfectly and raises at run time, which is the right outcome: a step that was wrong is corrected by
 *     the next run's rows.
 *   - **`flowNodeEffect` may only ever have its `contactCustomerId` changed.** DELETE raises ZY002 and so
 *     does an UPDATE of anything else; the application role holds `update (contact_customer_id)` and
 *     nothing more. The one legitimate caller is a customer merge re-pointing the token onto the survivor.
 *   - **A DRY RUN may leave nothing behind.** Inserting a `flowNodeEffect` for a dry run raises ZY003, and
 *     so does a `flowStepLog` row naming a message. That is how "zero message rows and zero provider
 *     calls" holds for a `psql` session as well as for the worker.
 *   - **`flowRun.mode` and `flowRun.enrolmentId` are immutable** (ZY004) while everything else on the row
 *     moves, because the interpreter has to be able to advance a run.
 *   - **`maxNodeExecutions` has no default.** The writer supplies `MAX_FLOW_NODE_EXECUTIONS`, so the
 *     ceiling a run was judged by is stored on its own row and is not a number written twice.
 */

/** Whether a run performs its side effects or only projects them. */
export const flowRunMode = pgEnum('flow_run_mode', ['live', 'dry_run'])

/** Where a run got to. `loop_detected` is a status rather than a reason, so halting runs can be counted. */
export const flowRunStatus = pgEnum('flow_run_status', [
  'running',
  'completed',
  'loop_detected',
  'cancelled',
])

/** What one attempt at one node produced. `FLOW_NODE_OUTCOMES` in `@berelax/shared` is the same list. */
export const flowNodeOutcome = pgEnum('flow_node_outcome', [
  'executed',
  'duplicate',
  'held',
  'refused',
  'no_effect',
])

/** One run of the interpreter: a live run of one enrolment, or a dry run over an audience. */
export const flowRun = pgTable(
  'flow_run',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /**
     * NULL for a dry run, which nobody is enrolled on. UNIQUE, so one live run per enrolment.
     *
     * Deliberately NOT a foreign key (0056's decision, restated in 0091's own comment): the append-only
     * step log hangs off this run, and a cascade from `customer` reaching it would raise ZY001 and make
     * `delete from customer` fail for every caller.
     */
    enrolmentId: uuid('enrolment_id'),
    flowId: uuid('flow_id').notNull(),
    /** The version the run interprets: the one the enrolment pinned, never `max(version)`. */
    definitionVersion: integer('definition_version').notNull(),
    mode: flowRunMode('mode').notNull(),
    status: flowRunStatus('status').notNull().default('running'),
    nodeExecutions: integer('node_executions').notNull().default(0),
    /** The ceiling this run was judged by. No default: see the note above. */
    maxNodeExecutions: integer('max_node_executions').notNull(),
    /** The node to decide about next. NULL means "at the trigger". */
    cursorNodeId: text('cursor_node_id'),
    /** When a wait ends — the durable record of the resume, so a lost queue row is recoverable. */
    resumeAt: timestamp('resume_at', { withTimezone: true }),
    /** The instant the next leg's delays are measured from: when this run last resumed. */
    elapsedFrom: timestamp('elapsed_from', { withTimezone: true }).notNull(),
    /** A dry run's audience, whole. Present exactly when `mode = 'dry_run'`. */
    projectedAudienceSize: integer('projected_audience_size'),
    /** Rows the cap stopped the projection producing. Reported, never trimmed in silence. */
    projectedRowsOmitted: integer('projected_rows_omitted'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** From `FLOW_END_REASONS`. Text, because that list is DERIVED from the DSL's own exit reasons. */
    endedReason: text('ended_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('flow_run_one_per_enrolment').on(t.enrolmentId),
    foreignKey({
      columns: [t.flowId, t.definitionVersion],
      foreignColumns: [flowDefinition.flowId, flowDefinition.version],
      name: 'flow_run_pins_a_definition_version',
    })
      .onUpdate('restrict')
      .onDelete('restrict'),
    index('flow_run_active_idx').on(t.flowId),
    index('flow_run_resume_idx').on(t.resumeAt),
    /** THE cap, as a relation between two columns of the row rather than as a number written here. */
    check(
      'flow_run_executions_within_bound',
      sql`${t.nodeExecutions} between 0 and ${t.maxNodeExecutions}`,
    ),
    check(
      'flow_run_live_run_is_an_enrolments',
      sql`(${t.mode} = 'live') = (${t.enrolmentId} is not null)`,
    ),
    check('flow_run_ended_matches_status', sql`(${t.status} = 'running') = (${t.endedAt} is null)`),
  ],
)

/** The idempotency token: (flow_run, node, channel, contact), and nothing else. */
export const flowNodeEffect = pgTable(
  'flow_node_effect',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    flowRunId: uuid('flow_run_id')
      .notNull()
      .references(() => flowRun.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    /** `message_channel`. Part of the key, so one node reaching two channels is two executions. */
    channel: text('channel').notNull(),
    /**
     * Re-pointed by a customer merge and by nothing else. That is what makes "exactly once" survive one.
     *
     * Not a foreign key: DELETE here raises ZY002, so a cascade from `customer` would fail.
     */
    contactCustomerId: uuid('contact_customer_id').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    /** The acceptance line's constraint. Named, because the handler's `on conflict` names it. */
    unique('flow_node_effect_once_per_contact').on(
      t.flowRunId,
      t.nodeId,
      t.channel,
      t.contactCustomerId,
    ),
  ],
)

/** One row per node one run took, live or projected. Append-only: see the note above. */
export const flowStepLog = pgTable(
  'flow_step_log',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    flowRunId: uuid('flow_run_id')
      .notNull()
      .references(() => flowRun.id, { onDelete: 'cascade' }),
    flowId: uuid('flow_id').notNull(),
    /** Denormalised so "why did this contact get this message" is ONE query with no join. */
    definitionVersion: integer('definition_version').notNull(),
    nodeId: text('node_id').notNull(),
    nodeKind: text('node_kind').notNull(),
    /** The branch this run took out of the node: a split's choice is a fact about this run. */
    branch: text('branch').notNull(),
    outcome: flowNodeOutcome('outcome').notNull(),
    /** Not a foreign key: this table refuses DELETE (ZY001), so a cascade from `customer` would fail. */
    contactCustomerId: uuid('contact_customer_id').notNull(),
    /** `message_channel`, or NULL for a node that sends nothing. */
    channel: text('channel'),
    templateKey: text('template_key'),
    /** NULL for a refusal (a refused send writes no message row) and for every dry-run row. */
    messageId: uuid('message_id').references(() => message.id, { onDelete: 'restrict' }),
    /** The consent row the gate's answer rested on, as `resolveConsent` named it. */
    consentRecordId: uuid('consent_record_id').references(() => consent.id, {
      onDelete: 'restrict',
    }),
    /** The gate's own word. Text, because the vocabulary is `@berelax/messaging`'s, not this schema's. */
    gateDecision: text('gate_decision'),
    /** When the node ran, or — for a dry run — when it WOULD run. One column, so the two compare. */
    plannedAt: timestamp('planned_at', { withTimezone: true }).notNull(),
    encoding: text('encoding'),
    segments: smallint('segments'),
    /** `fils`: integer money, VAT-inclusive gross authoritative (ADR 0007). */
    costFils: integer('cost_fils'),
    detail: text('detail'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.flowId, t.definitionVersion],
      foreignColumns: [flowDefinition.flowId, flowDefinition.version],
      name: 'flow_step_log_pins_a_definition_version',
    })
      .onUpdate('restrict')
      .onDelete('restrict'),
    index('flow_step_log_contact_idx').on(t.contactCustomerId, t.plannedAt.desc()),
    index('flow_step_log_message_idx').on(t.messageId),
    index('flow_step_log_run_idx').on(t.flowRunId, t.plannedAt),
    check(
      'flow_step_log_message_belongs_to_a_send',
      sql`${t.messageId} is null or ${t.outcome} in ('executed', 'held')`,
    ),
    check(
      'flow_step_log_costing_is_whole',
      sql`(${t.encoding} is null) = (${t.segments} is null) and (${t.segments} is null) = (${t.costFils} is null)`,
    ),
  ],
)
