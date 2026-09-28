/**
 * The interpreter's vocabularies and its three bounds, written once (C-AUTO-07).
 *
 * `schemas/flow.ts` holds what a DEFINITION is. This file holds what a RUN of one is, and it lives beside
 * it in `shared` for the same structural reason: `@berelax/core` plans a step, `@berelax/db` stores the
 * run, the step log and the idempotency row, `@berelax/messaging` never sees any of it, and no two of
 * those may import each other.
 *
 * ## Why the exit-reason vocabulary is here and not an enum in SQL
 *
 * Migration 0070 left `flow_enrolment.ended_reason` as `text` and said why in the column comment: *"the
 * interpreter that writes it is C-AUTO-07's and a vocabulary guessed at here would be one somebody has to
 * migrate."* This is that unit, and the vocabulary is now written — in code, ONCE, as
 * {@link FLOW_END_REASONS}, derived from `FLOW_EXIT_REASONS` rather than restating it.
 *
 * It is deliberately still not a Postgres enum, and the reason is the derivation. An enum would be a
 * second statement of a list this file already computes from the DSL's own exit reasons, so the day a
 * ninth exit reason is added to the DSL the two would disagree and the disagreement would present as an
 * enrolment that cannot be ended. What holds the vocabulary instead is {@link isFlowEndReason} at the one
 * writer, plus `flow-run-vocabulary.test.ts`, which asserts the derived set equals the DSL's exit reasons
 * plus exactly the interpreter's own halts — in both directions, so a member added to either list without
 * a decision fails the build.
 *
 * ## The three bounds are provisional and are the strictest safe reading
 *
 * `build/manifest.yaml`'s C-AUTO-07 `provisional` line: *"Max node executions per run 200; max active
 * enrolments per flow 5,000; dry-run audience capped at 1,000 projected rows with the overflow reported
 * rather than truncated silently."* Nobody has stated any of the three (docs/12 §1: a provisional value
 * marked as such never stalls the build), and each one here is a CEILING — the direction in which being
 * wrong stops work rather than sends something. A missing bound is the runaway flow, the flow that
 * enrols the whole list, and the dry run that projects until the process dies.
 */
import { FLOW_EXIT_REASONS } from './flow.ts'

/**
 * The most node executions one run may perform before it halts as a loop.
 *
 * Provisional (manifest, C-AUTO-07). A backstop for a bug and not a schedule: `analyseFlowGraph` already
 * refuses to PUBLISH a cycle with no delay or no bounded exit, so a run that reaches this number is
 * running a graph whose loop the analyser passed and whose facts keep sending it round — a condition that
 * never flips, or a delay of one minute in a loop nothing leaves.
 *
 * The bound is INCLUSIVE and the run halts INSIDE it: execution number 200 is performed, number 201 is
 * refused, and `flow_run.node_executions` therefore never exceeds `max_node_executions`. That is stated
 * as a CHECK between the two columns in migration 0091 rather than as this number written into SQL, so
 * the ceiling a run was judged by is the one stored on its own row.
 */
export const MAX_FLOW_NODE_EXECUTIONS = 200

/**
 * The most ACTIVE enrolments one flow may hold. Provisional (manifest, C-AUTO-07).
 *
 * Active and not total, which is the whole meaning of the figure: a flow that has run for a year has
 * millions of completed enrolments and none of them is going anywhere, so a cap counting those would
 * refuse a flow that is doing nothing. `flow_enrolment_active_idx` is partial on `status = 'active'` and
 * is the index the count runs on.
 */
export const MAX_ACTIVE_ENROLMENTS_PER_FLOW = 5_000

/**
 * The most rows one dry run may project. Provisional (manifest, C-AUTO-07).
 *
 * ROWS and not contacts, because the projection is per (contact, node): a 60-node flow over 1,000
 * contacts is 60,000 rows, and a cap on the audience would be a cap whose real size depends on the
 * graph. The overflow is REPORTED (`projectedRowsOmitted`) and never truncated silently — a dry run that
 * quietly showed the first thousand of forty thousand would be an operator reading a plan of a campaign
 * they are not about to send.
 */
export const MAX_DRY_RUN_PROJECTED_ROWS = 1_000

/**
 * What a run is doing. `flow_run_mode` in migration 0091.
 *
 * Two members, and the distinction is enforced by the database rather than by the interpreter's care: a
 * `dry_run` row may not carry a node effect or a message id at all (ZY013), so "a dry run sends nothing"
 * is a statement `psql` cannot get round either.
 */
export const FLOW_RUN_MODES = ['live', 'dry_run'] as const
export type FlowRunMode = (typeof FLOW_RUN_MODES)[number]

/**
 * Where a run got to. `flow_run_status` in migration 0091.
 *
 * `loop_detected` is a status of its own rather than a `cancelled` row with a reason, and that is the
 * acceptance line: *"halts at the configured max node executions with status 'loop_detected', marks the
 * enrolment and enqueues an alert"*. A reason column can be read; a status can be COUNTED, and the
 * question an operator asks is "how many runs are halting", which a reason folded into `cancelled` cannot
 * answer without parsing text.
 */
export const FLOW_RUN_STATUSES = ['running', 'completed', 'loop_detected', 'cancelled'] as const
export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number]

/** A run that is finished, whatever it finished as. The complement of `running`, derived not restated. */
export const isTerminalFlowRunStatus = (status: FlowRunStatus): boolean => status !== 'running'

/**
 * The interpreter's own reasons for ending an enrolment, as opposed to the DSL's exit reasons.
 *
 * Each one is a fact about the RUN rather than about the flow, which is why none of them could have been
 * an `exit` node's reason: nobody draws a loop-detection node.
 */
export const FLOW_INTERPRETER_END_REASONS = [
  /** The execution cap fired. The run halted inside the bound; the graph is what is wrong. */
  'loop_detected',
  /**
   * The contact was merged into another record while the run was in flight, and the survivor already had
   * an active enrolment on this flow — so this run's enrolment was retained on the tombstone rather than
   * re-pointed, and continuing it would send the survivor the same node twice.
   */
  'contact_merged_away',
  /**
   * A condition named a value this build cannot read — a `lifecycle_state` outside
   * `CUSTOMER_LIFECYCLE_STATES` on a document published before the publish-time check existed.
   *
   * A halt rather than the false branch, which is `schemas/flow.ts`'s stated failure: a condition that
   * silently answered `false` for every contact is a flow doing nothing that looks like a flow working.
   */
  'condition_unreadable',
  /** A person ended it: the operator surface, or the marketing kill switch. */
  'cancelled_by_operator',
] as const
export type FlowInterpreterEndReason = (typeof FLOW_INTERPRETER_END_REASONS)[number]

/**
 * Every value `flow_enrolment.ended_reason` may hold, derived from the two lists above.
 *
 * DERIVED, and that is the point of the file. The alternative — a third literal list — is the defect
 * class this build has already paid for twice: a second statement of a fact drifts, and the drift here
 * would be an enrolment the interpreter cannot end.
 */
export const FLOW_END_REASONS = [...FLOW_EXIT_REASONS, ...FLOW_INTERPRETER_END_REASONS] as const
export type FlowEndReason = (typeof FLOW_END_REASONS)[number]

export const isFlowEndReason = (value: string): value is FlowEndReason =>
  (FLOW_END_REASONS as readonly string[]).includes(value)

/**
 * What one attempt at one node produced, as a value the caller reads.
 *
 * `duplicate` is the acceptance line's: *"delivering the same job 50 times produces exactly one message
 * row and 49 typed 'duplicate' outcomes"*. It is a typed outcome and NEVER a swallowed error whose
 * message happens to mention uniqueness — the mechanism is `on conflict do nothing` on
 * `flow_node_effect_once_per_contact` returning no row, so the second delivery learns it is a duplicate
 * from the absence of an insert rather than from a caught exception whose text it had to read.
 */
export const FLOW_NODE_OUTCOMES = [
  /** The node's side effect happened, in this transaction, for the first time. */
  'executed',
  /** The idempotency row was already there: this job has been delivered before. Nothing was sent. */
  'duplicate',
  /** The gate held the message for the promotional window. A release is queued for the instant it named. */
  'held',
  /** The gate refused, the template was unusable, or the staging guard diverted it. Nothing left. */
  'refused',
  /** A node with no side effect: a delay, a condition, a split, a trigger, an exit. */
  'no_effect',
] as const
export type FlowNodeOutcome = (typeof FLOW_NODE_OUTCOMES)[number]

/**
 * Why an enrolment attempt did not create a new enrolment, as a value on the result rather than a throw.
 *
 * `already_enrolled` is an OUTCOME and not a refusal, which is the acceptance line's wording and also the
 * only reading that makes a trigger safe to deliver twice: an at-least-once queue will deliver an
 * `appointment.completed` event again, and a second enrolment attempt that threw would burn a retry and
 * dead-letter a job whose work was already done.
 */
export const FLOW_ENROLMENT_OUTCOMES = ['enrolled', 'already_enrolled'] as const
export type FlowEnrolmentOutcome = (typeof FLOW_ENROLMENT_OUTCOMES)[number]
