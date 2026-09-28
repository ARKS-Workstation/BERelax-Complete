import {
  addMinutes,
  type FlowContactFacts,
  type FlowDefinition,
  type FlowStepPlan,
  type Instant,
  instantFromIso,
  instantToIso,
  parseFlowDefinition,
  planFlowStep,
  projectDryRun,
  resolveConsent,
} from '@berelax/core'
import {
  type Actor,
  advanceFlowRun,
  type ClaimedFlowRun,
  claimFlowRun,
  endFlowRun,
  readConsentLogs,
  readFlowContactInputs,
  recordStepLog,
  type Sql,
  startFlowRun,
  type UnitOfWork,
  withUnitOfWork,
} from '@berelax/db'
import { AppError, MAX_DRY_RUN_PROJECTED_ROWS } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'
import {
  executeMessageNode,
  executeStageNode,
  executeTagNode,
  type MessageNodeDeps,
  type NodeEffect,
  noEffect,
} from './nodes/index.ts'
import { FLOW_PROMOTIONAL_CONSENT_PURPOSE } from './nodes/message.ts'
import { asConsentLog } from './reads.ts'

/**
 * The flow interpreter on pg-boss: one tick per job, every side effect idempotent, every step logged.
 *
 * ## What one tick is, and why it is a batch rather than a single node
 *
 * A tick claims the run's row `for update`, then walks the graph until it must stop — a delay whose target
 * instant has not arrived, a message the gate held, an exit, or the execution cap. Everything it did commits
 * in ONE transaction together with the enqueue of the next tick, which is the acceptance line: *"the node
 * side effect and its idempotency row commit in the same transaction as the pg-boss job"*. `pg-boss`
 * accepts a `db` on `send`, so the next tick's job row travels on the same transaction (ADR 0008, and the
 * property locked decision 4 chose pg-boss for).
 *
 * A node per job would have been simpler and is wrong twice over: a 20-node flow would be 20 jobs and 20
 * transactions with 19 windows in which the run is committed half way, and a tight loop's execution cap
 * would take 200 round trips to reach.
 *
 * ## There is no window logic here
 *
 * The acceptance line asks for *"a source-level assertion plus a behavioural test"* that the interpreter
 * contains none. `no-window-logic.test.ts` is the source-level half and it NAMES what it scans for;
 * `packages/fixtures/src/flow-interpreter.itest.ts` is the behavioural half. What this file knows about a
 * delay is `addMinutes` inside `planFlowStep`; whether the instant it lands on is inside quiet hours is
 * answered by the gate, through the send choke point, and the release instant it hands back is carried out
 * of here untouched.
 *
 * ## Why the contact is re-resolved through the merge chain every tick
 *
 * `claimFlowRun` returns `merge_survivor_of(customer_id)` beside the customer id. They differ only when the
 * contact was merged away AND the loser's enrolment was RETAINED on the tombstone — which happens when the
 * survivor already had an active enrolment on the same flow, because
 * `flow_enrolment_one_active_per_contact` refused the re-point. Continuing then would send the survivor
 * every node twice, so the run is cancelled with `contact_merged_away`. The ordinary case needs nothing: the
 * enrolment re-points, the run follows it, and the idempotency tokens re-point with the contact.
 */

// ------------------------------------------------------------------------------------------------
// The runtime
// ------------------------------------------------------------------------------------------------

export interface InterpreterRuntime {
  readonly sql: Sql
  /** Everything the message node needs, built over a GIVEN connection so the tick's transaction is shared. */
  readonly messageDeps: MessageNodeDeps
  /**
   * Hands the next tick to the queue, inside the caller's transaction.
   *
   * Injected rather than built here for `send-scheduled-step.ts`'s reason: a `PgBoss` inside a handler is a
   * second connection pool, and a test has to be able to watch what was queued without starting one.
   */
  readonly enqueueTick: (
    uow: UnitOfWork,
    data: FlowTickData,
    options?: { readonly startAfterSeconds?: number },
  ) => Promise<string | null>
  /** Raises the alert a halted run owes somebody. Injected, so a test can read what was raised. */
  readonly alertLoopDetected: (
    uow: UnitOfWork,
    input: { readonly runId: string; readonly flowKey: string; readonly detail: string },
  ) => Promise<void>
}

const ACTOR: Actor = { kind: 'system', label: 'automation.flow-tick' }

/** The per-tick payload. One field, for `send-scheduled-step.ts`'s reason: a body in a queue goes stale. */
export interface FlowTickData {
  readonly runId: string
}

/** What one tick did. Every arm is a durable state of the run, which is the point. */
export type TickOutcome =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'already_ended'; readonly status: string }
  | {
      readonly kind: 'advanced'
      readonly executed: number
      readonly cursorNodeId: string | null
      readonly resumeAtIso: string | null
    }
  | { readonly kind: 'finished'; readonly reason: string; readonly executed: number }
  | { readonly kind: 'halted'; readonly reason: string; readonly executed: number }
  | { readonly kind: 'paused'; readonly executed: number; readonly releaseAtIso: string | null }

/**
 * Runs one tick of one run.
 *
 * The whole body is inside one `withUnitOfWork`, and the run's row lock is held for all of it including the
 * transport call. That is `send-scheduled-step.ts`'s decision restated: a lock released before the send
 * would let something else end the run while a message was in flight, and the message would then belong to
 * no run. The consequence — a cancellation arriving mid-send WAITS — is the right answer, because an SMS
 * cannot be un-sent, and it is bounded by `expireInSeconds` on the queue below.
 */
export async function runFlowTick(
  runtime: InterpreterRuntime,
  input: { readonly runId: string; readonly atIso: string },
): Promise<TickOutcome> {
  return await withUnitOfWork(runtime.sql, ACTOR, async (uow) => {
    const run = await claimFlowRun(uow.sql, input.runId)
    if (run === null) return { kind: 'not_found' }
    if (run.status !== 'running') return { kind: 'already_ended', status: run.status }
    if (run.mode !== 'live') {
      throw new AppError(
        'invariant_violated',
        `Run ${run.runId} is a ${run.mode} run and ticks are for live runs only. A dry run is projected ` +
          'whole by `projectFlowDryRun` and never executed, which is what "zero provider calls" means.',
        { details: { runId: run.runId, mode: run.mode } },
      )
    }
    if (run.customerId === null) {
      // The ERASURE case, and the reason this is an ending rather than the `invariant_violated` it used to
      // be. `flow_run_live_run_is_an_enrolments` guarantees `enrolment_id is not null` for a live run, so
      // the column is set; what is missing is the enrolment ROW, because `enrolment_id` is deliberately not
      // a foreign key (0091: a cascade from `customer` would reach the append-only step log and raise ZY011
      // for every caller) and C-CRM-10's erasure DELETES the enrolment on purpose. So a subject who asked to
      // be forgotten mid-flow leaves exactly this: a running run with nobody to run it against.
      //
      // Ending it is the whole of the fix, and it needs nothing else: no node is executed, so no message is
      // sent and no token is claimed, and a run that has ended enqueues no further tick. Throwing instead
      // was a job that failed for ever, retried by pg-boss, and put the erased subject's run id in front of
      // whoever reads the dead letters.
      await endFlowRun(uow, {
        runId: run.runId,
        status: 'cancelled',
        reason: 'enrolment_removed',
        atIso: input.atIso,
      })
      return { kind: 'halted', reason: 'enrolment_removed', executed: run.nodeExecutions }
    }
    if (run.survivorCustomerId !== null && run.survivorCustomerId !== run.customerId) {
      // The merge case. See this file's header on when it is reachable.
      await endFlowRun(uow, {
        runId: run.runId,
        status: 'cancelled',
        reason: 'contact_merged_away',
        atIso: input.atIso,
      })
      await endEnrolmentFor(uow, run, 'contact_merged_away', input.atIso)
      return { kind: 'halted', reason: 'contact_merged_away', executed: run.nodeExecutions }
    }

    const definition = definitionOf(run)
    const facts = await factsFor(uow.sql, run.customerId, input.atIso)
    return await walk(runtime, uow, run, definition, facts, input.atIso)
  })
}

/** Walks the graph until the run must stop, then writes where it got to. */
async function walk(
  runtime: InterpreterRuntime,
  uow: UnitOfWork,
  run: ClaimedFlowRun,
  definition: FlowDefinition,
  facts: FlowContactFacts,
  atIso: string,
): Promise<TickOutcome> {
  const at = instantFromIso(atIso)
  let cursor = run.cursorNodeId
  let executions = run.nodeExecutions
  let elapsedFrom = instantFromIso(run.elapsedFromIso)

  for (;;) {
    const plan: FlowStepPlan = planFlowStep({
      definition,
      cursorNodeId: cursor,
      executionsSoFar: executions,
      maxNodeExecutions: run.maxNodeExecutions,
      at,
      delayElapsedFrom: elapsedFrom,
      facts,
      splitSeedPrefix: run.runId,
    })

    if (plan.kind === 'halt') {
      await logStep(uow, run, {
        nodeId: cursor ?? 'trigger',
        nodeKind: plan.reason,
        branch: 'default',
        plannedAtIso: atIso,
        effect: { ...noEffect(), outcome: 'refused', detail: plan.detail },
        contactCustomerId: run.customerId ?? '',
      })
      const status = plan.reason === 'loop_detected' ? 'loop_detected' : 'cancelled'
      // The counter is persisted BEFORE the run ends, and it is not a detail: the acceptance line is that
      // the run halts at exactly the ceiling, and the only place that figure is readable afterwards is
      // `flow_run.node_executions`. Without this it stays at whatever the last `advanceFlowRun` wrote —
      // zero, for a loop that ran to the cap inside one tick — and the assertion would be about nothing.
      // `flow_run_executions_within_bound` also refuses a figure past the row's own ceiling, so writing it
      // is what makes the database a second opinion on the cap rather than a bystander.
      await persistCount(uow, run, cursor, executions, elapsedFrom)
      await endFlowRun(uow, { runId: run.runId, status, reason: plan.reason, atIso })
      await endEnrolmentFor(uow, run, plan.reason, atIso)
      if (plan.reason === 'loop_detected') {
        // The alert the acceptance line asks for, enqueued in the SAME transaction as the halt: an alert
        // raised afterwards is one a crash loses, and the whole point of the halt is that somebody hears
        // about the flow.
        await runtime.alertLoopDetected(uow, {
          runId: run.runId,
          flowKey: run.flowKey,
          detail: plan.detail,
        })
      }
      return { kind: 'halted', reason: plan.reason, executed: executions }
    }

    if (plan.kind === 'unroutable') {
      await logStep(uow, run, {
        nodeId: cursor ?? 'trigger',
        nodeKind: 'unroutable',
        branch: 'default',
        plannedAtIso: atIso,
        effect: { ...noEffect(), outcome: 'refused', detail: plan.detail },
        contactCustomerId: run.customerId ?? '',
      })
      await persistCount(uow, run, cursor, executions, elapsedFrom)
      await endFlowRun(uow, {
        runId: run.runId,
        status: 'cancelled',
        reason: 'not_eligible',
        atIso,
      })
      await endEnrolmentFor(uow, run, 'not_eligible', atIso)
      return { kind: 'halted', reason: 'unroutable', executed: executions }
    }

    if (plan.kind === 'finish') {
      await logStep(uow, run, {
        nodeId: plan.node.id,
        nodeKind: plan.node.kind,
        branch: 'default',
        plannedAtIso: atIso,
        effect: noEffect(),
        contactCustomerId: run.customerId ?? '',
      })
      await persistCount(uow, run, plan.node.id, executions, elapsedFrom)
      await endFlowRun(uow, {
        runId: run.runId,
        status: 'completed',
        reason: plan.reason,
        atIso,
      })
      await endEnrolmentFor(uow, run, plan.reason, atIso)
      return { kind: 'finished', reason: plan.reason, executed: executions }
    }

    if (plan.kind === 'wait') {
      const resumeAtIso = instantToIso(plan.resumeAt)
      await logStep(uow, run, {
        nodeId: plan.node.id,
        nodeKind: plan.node.kind,
        branch: 'default',
        // The instant the run WILL resume at, not the instant the wait started: the step log's
        // `planned_at` is "when this step happens", and for a delay that is its target.
        plannedAtIso: resumeAtIso,
        effect: {
          ...noEffect(),
          detail: `Waiting until ${resumeAtIso}. The next tick is queued for that instant.`,
        },
        contactCustomerId: run.customerId ?? '',
      })
      await advanceFlowRun(uow.sql, {
        runId: run.runId,
        // The cursor stays ON the delay node: the next tick asks `planFlowStep` about it again and walks
        // through it because the target has then passed. Advancing past it here would make the delay
        // unrepeatable and a lost job unrecoverable.
        cursorNodeId: plan.node.id,
        nodeExecutions: executions,
        resumeAtIso,
        elapsedFromIso: instantToIso(elapsedFrom),
      })
      await runtime.enqueueTick(
        uow,
        { runId: run.runId },
        { startAfterSeconds: Math.max(0, Math.ceil((plan.resumeAt - at) / 1000)) },
      )
      return { kind: 'advanced', executed: executions, cursorNodeId: plan.node.id, resumeAtIso }
    }

    // An execution. The effect happens, the step is logged, and the counter moves — in that order, so a
    // step log row can never describe an effect that did not commit.
    const effect = await performEffect(runtime, uow, run, plan, facts, atIso)
    await logStep(uow, run, {
      nodeId: plan.node.id,
      nodeKind: plan.node.kind,
      branch: plan.branch,
      plannedAtIso: atIso,
      effect,
      contactCustomerId: run.customerId ?? '',
    })
    executions += 1
    cursor = plan.nextNodeId

    if (plan.node.kind === 'delay') {
      // A delay the run walked THROUGH: the next leg is measured from this delay's TARGET, not from the
      // instant the tick happens to be running at. Without it a flow with two delays would measure the
      // second from the moment the first was noticed, which is later than it ended — so a worker that was
      // down for six hours would push every subsequent delay six hours out.
      elapsedFrom = addMinutes(elapsedFrom, plan.node.minutes)
    }

    if (effect.pause) {
      // The cursor stays ON the held node, and that is the whole of how a release works. The next tick asks
      // `planFlowStep` about the same node, `executeMessageNode` finds its token already claimed AND a
      // message row still `queued`, and releases that row instead of reporting a duplicate. Advancing past
      // it here would leave the held message with nothing that ever comes back to it — a promotional
      // message queued for 07:00 that no tick ever looks at again.
      await advanceFlowRun(uow.sql, {
        runId: run.runId,
        cursorNodeId: plan.node.id,
        nodeExecutions: executions,
        resumeAtIso: effect.releaseAtIso,
        elapsedFromIso: instantToIso(elapsedFrom),
      })
      if (effect.releaseAtIso !== null) {
        // The RELEASE. The instant is the gate's, computed by `nextPromotionalWindowOpen` inside the gate
        // and carried here untouched — which is the whole of "released by the gate at the next window
        // open". The interpreter's contribution is the `startAfter`.
        await runtime.enqueueTick(
          uow,
          { runId: run.runId },
          {
            startAfterSeconds: Math.max(
              0,
              Math.ceil((instantFromIso(effect.releaseAtIso) - at) / 1000),
            ),
          },
        )
      }
      return { kind: 'paused', executed: executions, releaseAtIso: effect.releaseAtIso }
    }

    if (cursor === null) {
      // A terminal node with no edge out that is not an `exit`. The analyser refuses that at publish time,
      // so this is a document an earlier build published: recorded and ended rather than left running.
      await endFlowRun(uow, {
        runId: run.runId,
        status: 'cancelled',
        reason: 'not_eligible',
        atIso,
      })
      await endEnrolmentFor(uow, run, 'not_eligible', atIso)
      return { kind: 'halted', reason: 'no_outgoing_edge', executed: executions }
    }
  }
}

/**
 * Writes the cursor and the counter before a run reaches a terminal state.
 *
 * `advanceFlowRun` refuses a run that is not `running`, so this has to come before `endFlowRun` rather than
 * after it. Separated into its own function because it is called from three places and forgetting it in one
 * of them is a run whose reported execution count is whatever the previous tick wrote.
 */
async function persistCount(
  uow: UnitOfWork,
  run: ClaimedFlowRun,
  cursorNodeId: string | null,
  executions: number,
  elapsedFrom: Instant,
): Promise<void> {
  await advanceFlowRun(uow.sql, {
    runId: run.runId,
    cursorNodeId,
    nodeExecutions: executions,
    resumeAtIso: null,
    elapsedFromIso: instantToIso(elapsedFrom),
  })
}

/** The side effect one executable node asks for. */
async function performEffect(
  runtime: InterpreterRuntime,
  uow: UnitOfWork,
  run: ClaimedFlowRun,
  plan: Extract<FlowStepPlan, { kind: 'execute' }>,
  facts: FlowContactFacts,
  atIso: string,
): Promise<NodeEffect> {
  const context = {
    uow,
    run,
    customerId: run.customerId ?? '',
    atIso,
    facts,
  }
  if (plan.action.kind === 'send_message' && plan.node.kind === 'action_message') {
    return await executeMessageNode(
      context,
      {
        id: plan.node.id,
        templateKey: plan.node.templateKey,
        channel: plan.node.channel,
        messageClass: plan.node.messageClass,
      },
      runtime.messageDeps,
    )
  }
  if (plan.action.kind === 'apply_tag' && plan.node.kind === 'action_tag') {
    return await executeTagNode(context, { id: plan.node.id, tag: plan.node.tag })
  }
  if (plan.action.kind === 'move_stage' && plan.node.kind === 'action_stage') {
    return await executeStageNode(context, { id: plan.node.id, stage: plan.node.stage })
  }
  return noEffect()
}

/** Writes one step log row from the run and the effect. Every column comes from one of the two. */
async function logStep(
  uow: UnitOfWork,
  run: ClaimedFlowRun,
  input: {
    readonly nodeId: string
    readonly nodeKind: string
    readonly branch: string
    readonly plannedAtIso: string
    readonly effect: NodeEffect
    readonly contactCustomerId: string
  },
): Promise<void> {
  await recordStepLog(uow.sql, {
    runId: run.runId,
    flowId: run.flowId,
    definitionVersion: run.definitionVersion,
    nodeId: input.nodeId,
    nodeKind: input.nodeKind,
    branch: input.branch,
    outcome: input.effect.outcome,
    contactCustomerId: input.contactCustomerId,
    channel: input.effect.channel,
    templateKey: input.effect.templateKey,
    messageId: input.effect.messageId,
    consentRecordId: input.effect.consentRecordId,
    gateDecision: input.effect.gateDecision,
    plannedAtIso: input.plannedAtIso,
    encoding: input.effect.encoding,
    segments: input.effect.segments,
    costFils: input.effect.costFils,
    detail: input.effect.detail,
  })
}

/** Ends the enrolment beside the run, when there is one. A dry run has none. */
async function endEnrolmentFor(
  uow: UnitOfWork,
  run: ClaimedFlowRun,
  reason: string,
  atIso: string,
): Promise<void> {
  if (run.enrolmentId === null) return
  const status = reason === 'completed' || reason === 'goal_met' ? 'completed' : 'cancelled'
  await uow.sql`
    update flow_enrolment
       set status = ${status}::flow_enrolment_status,
           ended_at = ${atIso}::timestamptz,
           ended_reason = ${reason}
     where id = ${run.enrolmentId}::uuid and status = 'active'
  `
}

/** The pinned document, parsed. Shape only: it was validated whole before it was published. */
function definitionOf(run: ClaimedFlowRun): FlowDefinition {
  const parsed = parseFlowDefinition(run.definition)
  if (!parsed.ok) {
    throw new AppError(
      'invariant_violated',
      `The pinned definition of run ${run.runId} (${run.flowKey} v${run.definitionVersion}) does not ` +
        `parse: ${parsed.refusals.map((refusal) => refusal.rule).join(', ')}. flow_definition is ` +
        'append-only (ZF001), so a document that validated at publish time cannot have changed — this is ' +
        'a DSL version this build does not implement.',
      { details: { runId: run.runId, rules: parsed.refusals.map((refusal) => refusal.rule) } },
    )
  }
  return parsed.definition
}

/**
 * The facts a condition is answered from, for one contact at one instant.
 *
 * The consent fact comes from `resolveConsent` over the log — the same fold the gate's evaluator reads
 * through — rather than from a second query, because "is this contact opted in" answered twice is answered
 * differently the first time either answer changes (`resolve.ts`'s own header).
 */
async function factsFor(sql: Sql, customerId: string, atIso: string): Promise<FlowContactFacts> {
  const inputs = await readFlowContactInputs(sql, { customerId, atIso })
  if (inputs === null) {
    throw new AppError(
      'not_found',
      `No customer ${customerId} to answer a flow condition about. flow_enrolment.customer_id cascades ` +
        'from `customer`, so a run whose contact is gone should have gone with it.',
      { details: { customerId } },
    )
  }
  const logs = await readConsentLogs(sql, [customerId])
  const log = logs.get(customerId)
  const resolution =
    log === undefined
      ? null
      : resolveConsent(
          asConsentLog(log),
          'sms',
          FLOW_PROMOTIONAL_CONSENT_PURPOSE,
          instantFromIso(atIso),
        )
  return {
    ...inputs,
    // `granted` and nothing else. `unknown` is not a variant of granted (C-CRM-03), so a contact nobody has
    // asked answers the condition FALSE — which routes them down the branch the operator drew for "we may
    // not market to this person" rather than the one they drew for "we may".
    hasMarketingConsent: resolution?.state === 'granted',
  }
}

// ------------------------------------------------------------------------------------------------
// Starting a live run
// ------------------------------------------------------------------------------------------------

export interface StartRunInput {
  readonly enrolmentId: string
  readonly flowId: string
  readonly definitionVersion: number
  readonly maxNodeExecutions: number
  readonly atIso: string
}

/**
 * Starts the run for an enrolment and queues its first tick, in one transaction.
 *
 * The enqueue is inside the transaction for the reason `enqueue.ts` gives about every other job: enqueue
 * before commit and a rolled-back enrolment leaves a tick for a run that does not exist; enqueue after and
 * a process that dies in between loses the flow silently, with a committed enrolment as the only evidence.
 */
export async function startRunAndQueueFirstTick(
  runtime: InterpreterRuntime,
  uow: UnitOfWork,
  input: StartRunInput,
): Promise<string> {
  const runId = await startFlowRun(uow, {
    enrolmentId: input.enrolmentId,
    flowId: input.flowId,
    definitionVersion: input.definitionVersion,
    mode: 'live',
    maxNodeExecutions: input.maxNodeExecutions,
    startedAtIso: input.atIso,
  })
  await runtime.enqueueTick(uow, { runId })
  return runId
}

// ------------------------------------------------------------------------------------------------
// The dry run
// ------------------------------------------------------------------------------------------------

export interface DryRunInput {
  readonly flowId: string
  readonly definitionVersion: number
  readonly definition: unknown
  /** The audience, resolved by the caller. The projection reports its size whole. */
  readonly audience: readonly { readonly customerId: string }[]
  readonly maxNodeExecutions: number
  readonly atIso: string
  readonly maxProjectedRows?: number
}

export interface DryRunResult {
  readonly runId: string
  readonly projectedRows: number
  readonly audienceSize: number
  readonly projectedRowsOmitted: number
}

/**
 * Projects a whole flow over an audience and writes the plan, sending nothing.
 *
 * ## Why this is not the tick with a flag
 *
 * Because it walks the SAME planner (`projectDryRun` drives `planFlowStep`) and performs none of the
 * effects — so there is no branch inside a node handler that a later edit could get the wrong way round.
 * The guarantee is not this function's care either: `flow_run.mode = 'dry_run'` makes an idempotency token
 * unstorable and a step log row naming a message unstorable (ZY013), for every role including the owner. The
 * suite asserts zero message rows AND spies on the transport, and both of those measure a rule rather than
 * a habit.
 *
 * ## The cap reports, and never truncates in silence
 *
 * `MAX_DRY_RUN_PROJECTED_ROWS` is provisional (1,000). `projected_audience_size` and
 * `projected_rows_omitted` are written on the run, together — 0091's
 * `flow_run_audience_and_omission_travel_together` refuses one without the other — so an operator reading a
 * plan can always tell whether it is the whole plan.
 */
export async function projectFlowDryRun(
  runtime: InterpreterRuntime,
  input: DryRunInput,
): Promise<DryRunResult> {
  const parsed = parseFlowDefinition(input.definition)
  if (!parsed.ok) {
    throw new AppError(
      'validation',
      `The definition to project does not parse: ${parsed.refusals
        .map((refusal) => refusal.rule)
        .join(', ')}.`,
      { details: { rules: parsed.refusals.map((refusal) => refusal.rule) } },
    )
  }
  const at = instantFromIso(input.atIso)
  const cap = input.maxProjectedRows ?? MAX_DRY_RUN_PROJECTED_ROWS

  // Read OUTSIDE the projection's transaction, deliberately: a dry run over a thousand contacts issues a
  // thousand fact reads, and holding a transaction open for them would keep a connection for the whole
  // projection while writing nothing that has to be atomic with them.
  const audience: { customerId: string; facts: FlowContactFacts }[] = []
  for (const member of input.audience) {
    audience.push({
      customerId: member.customerId,
      facts: await factsFor(runtime.sql, member.customerId, input.atIso),
    })
  }

  const projection = projectDryRun({
    definition: parsed.definition,
    audience,
    startAt: at,
    maxProjectedRows: cap,
    maxNodeExecutions: input.maxNodeExecutions,
    splitSeedPrefix: 'dry-run',
  })

  const priced = await pricedNodes(runtime, parsed.definition)

  return await withUnitOfWork(runtime.sql, ACTOR, async (uow) => {
    const runId = await startFlowRun(uow, {
      enrolmentId: null,
      flowId: input.flowId,
      definitionVersion: input.definitionVersion,
      mode: 'dry_run',
      maxNodeExecutions: input.maxNodeExecutions,
      startedAtIso: input.atIso,
      projectedAudienceSize: projection.audienceSize,
      projectedRowsOmitted: projection.projectedRowsOmitted,
    })
    for (const row of projection.rows) {
      const costing = row.templateKey === null ? null : (priced.get(row.templateKey) ?? null)
      await recordStepLog(uow.sql, {
        runId,
        flowId: input.flowId,
        definitionVersion: input.definitionVersion,
        nodeId: row.nodeId,
        nodeKind: row.nodeKind,
        branch: row.branch,
        // Every projected row is `no_effect`, and that is the honest label: nothing happened. The run's
        // `mode` is what says these rows are a plan, which is one fact in one place.
        outcome: 'no_effect',
        contactCustomerId: row.customerId,
        channel: row.channel,
        templateKey: row.templateKey,
        messageId: null,
        consentRecordId: null,
        gateDecision: null,
        plannedAtIso: instantToIso(row.plannedAt),
        encoding: costing?.encoding ?? null,
        segments: costing?.segments ?? null,
        costFils: costing?.costFils ?? null,
        detail: null,
      })
    }
    // A projection is finished the moment it is written: there is nothing to tick.
    await endFlowRun(uow, {
      runId,
      status: 'completed',
      reason: 'completed',
      atIso: input.atIso,
    })
    return {
      runId,
      projectedRows: projection.rows.length,
      audienceSize: projection.audienceSize,
      projectedRowsOmitted: projection.projectedRowsOmitted,
    }
  })
}

/** The authoring-time cost of each message node's body, priced once per template rather than per row. */
async function pricedNodes(
  runtime: InterpreterRuntime,
  definition: FlowDefinition,
): Promise<ReadonlyMap<string, { encoding: string; segments: number; costFils: number }>> {
  const out = new Map<string, { encoding: string; segments: number; costFils: number }>()
  for (const node of definition.nodes) {
    if (node.kind !== 'action_message') continue
    if (out.has(node.templateKey)) continue
    const priced = await runtime.messageDeps.priceTemplate({
      templateKey: node.templateKey,
      channel: node.channel,
    })
    if (priced !== null) out.set(node.templateKey, priced)
  }
  return out
}

// ------------------------------------------------------------------------------------------------
// The jobs
// ------------------------------------------------------------------------------------------------

let configured: InterpreterRuntime | undefined

export function setInterpreterRuntime(runtime: InterpreterRuntime): void {
  configured = runtime
}

export function interpreterRuntime(job: string): InterpreterRuntime {
  if (configured === undefined) {
    throw new AppError(
      'invariant_violated',
      `${job} ran before setInterpreterRuntime() supplied the connection, the send context and the ` +
        'queue. run.ts calls it before startWorkers().',
    )
  }
  return configured
}

async function tickHandler(data: FlowTickData, context: JobContext): Promise<void> {
  const runtime = interpreterRuntime('automation.flow-tick')
  const outcome = await runFlowTick(runtime, { runId: data.runId, atIso: context.now() })
  // Logged for every outcome including the quiet ones, because "nothing happened" from a tick that found
  // no run reads exactly like a tick that sent three messages.
  console.log(
    `automation.flow-tick ${context.now()}: run ${data.runId} -> ${outcome.kind}` +
      ('reason' in outcome ? ` (${outcome.reason})` : '') +
      ('executed' in outcome ? ` after ${outcome.executed} execution(s)` : ''),
  )
}

export const FLOW_TICK_JOB: JobDefinition<FlowTickData> = {
  name: 'automation.flow-tick',
  purpose:
    'Runs one tick of one flow run: claims the run row, walks the pinned graph until it must wait, and ' +
    'commits every side effect, its idempotency token, its step log row and the next tick in ONE ' +
    'transaction. The payload is a run id and nothing else: a body in a queue is a message about a world ' +
    'that may have changed.',
  // No cron. A tick is ANNOUNCED — by the enrolment that started the run, by the previous tick's delay, or
  // by the gate's own release instant — so a poller here would be looking for work an enqueue already
  // named. No cron therefore no agent: what is watched is the caller.
  retryLimit: 3,
  retryDelaySeconds: 60,
  retryBackoff: true,
  // One transaction plus at most a few transport calls. Five minutes is generous; a tick still running
  // past it is blocked on the run's row lock, and reclaiming it is safe — the second attempt finds the
  // idempotency tokens already claimed and sends nothing.
  expireInSeconds: 300,
  handler: tickHandler,
}
