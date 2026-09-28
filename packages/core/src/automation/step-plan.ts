/**
 * The interpreter's decisions, as a pure function of the pinned document and the run's own counters.
 *
 * Everything in this file is the half of C-AUTO-07 that has no queue, no clock and no database: given a
 * definition, where a run has got to, how many nodes it has already executed and the facts about one
 * contact, what happens next. The worker (`apps/worker/src/automation/interpreter.ts`) performs the
 * effects; this decides them, and that split is what makes the loop bound, the branch choice and the
 * dry-run projection assertable without a transaction.
 *
 * ## There is NO window logic in this file, and that is an acceptance line
 *
 * *"a source-level assertion plus a behavioural test prove the interpreter contains no window logic of its
 * own"*. The promotional window is the gate's, and `packages/messaging/src/gate/window.ts` says in as many
 * words why: *"two implementations of quiet hours ... is the failure C-AUTO-07's acceptance line is written
 * against"*. So a delay node here computes ONE thing — the instant its minutes land on, by
 * {@link addMinutes} — and knows nothing about whether that instant is inside any window. Whether the
 * message may leave then is answered later, by the gate, through the send choke point; the release instant
 * it hands back is `nextPromotionalWindowOpen`'s, which the interpreter passes through and never computes.
 *
 * `apps/worker/src/automation/no-window-logic.test.ts` scans this file and the interpreter for the
 * identifiers that would betray a second implementation, and NAMES them, because a scan whose needle list
 * is empty is a check that examines nothing (ADR 0002).
 *
 * ## Why a split's branch is chosen from a seed and not from a random number
 *
 * `Math.random` is banned in this package, and the ban is the right answer rather than an obstacle: an
 * at-least-once queue delivers the same job twice, and a split that drew a fresh number would put the same
 * contact on branch A the first time and branch B the second — two different paths through one flow for one
 * person, with an idempotency key that cannot tell they happened. {@link chooseSplitBranch} hashes the seed
 * the caller supplies (the run id and the node id), so a replay of the same node in the same run makes the
 * same choice for ever, and two runs of the same flow still divide in the declared proportions.
 */

import {
  FLOW_CONDITION_BRANCHES,
  FLOW_DEFAULT_BRANCH,
  type FlowDefinition,
  type FlowEndReason,
  type FlowNode,
  isBooleanConditionFact,
  type MessageChannel,
} from '@berelax/shared'
import { CUSTOMER_LIFECYCLE_STATES, type CustomerLifecycleState } from '../crm/lifecycle.ts'
import { addMinutes, type Instant } from '../time.ts'

/**
 * Everything a condition can test about one contact, in one object.
 *
 * Exactly the members of `FLOW_CONDITION_FACTS`, and `flow-run-vocabulary.test.ts` asserts that in both
 * directions: a fact added to the DSL with nothing here to answer it would be a condition the interpreter
 * could only guess at, which is the failure `schemas/flow.ts` chose the fact list to prevent.
 *
 * `tags` is a list rather than a `tag` string because the DSL's `tag equals <value>` asks whether the
 * contact carries one, not what the only one is.
 */
export interface FlowContactFacts {
  readonly hasFutureAppointment: boolean
  readonly hasMarketingConsent: boolean
  readonly isVip: boolean
  readonly isBlocklisted: boolean
  readonly lifecycleState: string
  readonly tags: readonly string[]
  readonly locale: string
}

/**
 * How a condition answered, or why it could not be read.
 *
 * `unreadable` exists although `validateFlowDefinition` refuses an unknown `lifecycle_state` value at
 * PUBLISH time, and the reason is that a publish-time check cannot be the guarantee for a document that
 * was published before the check existed. A condition nobody can read must HALT the run — not take the
 * false branch, which is `schemas/flow.ts`'s stated failure: *"a flow that silently took the false branch
 * for every contact is worse than one that could not be published."*
 */
export type FlowConditionVerdict =
  | { readonly kind: 'answered'; readonly branch: 'true' | 'false' }
  | { readonly kind: 'unreadable'; readonly detail: string }

/** True for a value the customer lifecycle vocabulary holds. The vocabulary is read, never restated. */
export const isCustomerLifecycleState = (value: string): value is CustomerLifecycleState =>
  (CUSTOMER_LIFECYCLE_STATES as readonly string[]).includes(value)

/**
 * Answers one condition against one contact's facts.
 *
 * Total over `FLOW_CONDITION_FACTS` — there is no `default` arm that silently answers `false`, because the
 * day a ninth fact is added that arm would answer it wrongly for every contact and nothing would say so.
 */
export function answerFlowCondition(
  test: { readonly fact: string; readonly operator: string; readonly value?: string | undefined },
  facts: FlowContactFacts,
): FlowConditionVerdict {
  if (isBooleanConditionFact(test.fact)) {
    // `is_false` is the negation of the fact and not a second question: the schema already refuses any
    // other operator on a boolean fact (`flow-dsl-condition-operator-does-not-fit-fact`).
    const held = booleanFact(test.fact, facts)
    return answeredWith(test.operator === 'is_true' ? held : !held)
  }
  const { value } = test
  if (value === undefined) {
    return {
      kind: 'unreadable',
      detail:
        `The "${test.fact}" condition has no value to compare against. The schema requires one for ` +
        'a valued fact, so a document reaching here without one was not validated by this build.',
    }
  }
  return valuedFact(test.fact, test.operator, value, facts)
}

const answeredWith = (value: boolean): FlowConditionVerdict => ({
  kind: 'answered',
  branch: value ? 'true' : 'false',
})

/** The four facts that are true or false. Exhaustive over `FLOW_BOOLEAN_CONDITION_FACTS`. */
function booleanFact(fact: string, facts: FlowContactFacts): boolean {
  if (fact === 'has_future_appointment') return facts.hasFutureAppointment
  if (fact === 'has_marketing_consent') return facts.hasMarketingConsent
  if (fact === 'is_vip') return facts.isVip
  return facts.isBlocklisted
}

/** The three facts that hold a value, and the one of them with a vocabulary behind it. */
function valuedFact(
  fact: string,
  operator: string,
  value: string,
  facts: FlowContactFacts,
): FlowConditionVerdict {
  const equals = operator === 'equals'
  if (fact === 'lifecycle_state') {
    if (!isCustomerLifecycleState(value)) {
      return {
        kind: 'unreadable',
        detail:
          `"${value}" is not one of the customer lifecycle states ` +
          `(${CUSTOMER_LIFECYCLE_STATES.join(', ')}). Taking the false branch would silence this ` +
          'condition for every contact, so the run halts instead.',
      }
    }
    const matches = facts.lifecycleState === value
    return answeredWith(equals ? matches : !matches)
  }
  if (fact === 'tag') {
    const carries = facts.tags.includes(value)
    return answeredWith(equals ? carries : !carries)
  }
  if (fact === 'locale') {
    const matches = facts.locale === value
    return answeredWith(equals ? matches : !matches)
  }
  return {
    kind: 'unreadable',
    detail:
      `"${fact}" is not a fact this interpreter answers. FLOW_CONDITION_FACTS and this function ` +
      'are held equal in both directions by flow-run-vocabulary.test.ts, so this is reachable only for a ' +
      'document published by a build that knew a fact this one does not.',
  }
}

/**
 * The branch a split sends this run down, decided from a seed rather than from chance.
 *
 * FNV-1a over the seed, then a per-mille bucket walked in the declared branch order. Three properties,
 * each of which a random draw would lose: the same (run, node) always answers the same branch, so a
 * replayed job cannot take the other path; two runs differ, because the run id is in the seed; and the
 * distribution over many runs is the declared one, which `step-plan.property.test.ts` measures.
 */
export function chooseSplitBranch(
  branches: readonly { readonly label: string; readonly weightPerMille: number }[],
  seed: string,
): string {
  const bucket = fnv1a32(seed) % 1000
  let cumulative = 0
  for (const branch of branches) {
    cumulative += branch.weightPerMille
    if (bucket < cumulative) return branch.label
  }
  // Unreachable while the weights sum to 1000, which `flow-dsl-split-weights-do-not-sum` enforces at
  // publish time. The LAST branch rather than a throw: a run that reached a split whose weights had been
  // corrupted still has to go somewhere, and the last declared branch is the only answer that cannot be
  // mistaken for a deliberate one.
  return branches[branches.length - 1]?.label ?? FLOW_DEFAULT_BRANCH
}

/** FNV-1a, 32-bit, over UTF-16 code units. Deterministic, dependency-free and not a security hash. */
function fnv1a32(value: string): number {
  let hash = 0x811c_9dc5
  for (let at = 0; at < value.length; at += 1) {
    hash ^= value.charCodeAt(at)
    hash = Math.imul(hash, 0x0100_0193) >>> 0
  }
  return hash >>> 0
}

// ------------------------------------------------------------------------------------------------
// The step plan
// ------------------------------------------------------------------------------------------------

/** What one node of the graph asks the worker to do. */
export type FlowStepAction =
  /** Send the template this node names. The only action with an external side effect. */
  | {
      readonly kind: 'send_message'
      readonly templateKey: string
      readonly channel: MessageChannel
      readonly messageClass: 'transactional' | 'promotional'
    }
  | { readonly kind: 'apply_tag'; readonly tag: string }
  | { readonly kind: 'move_stage'; readonly stage: string }
  /** A trigger, a condition or a split: the graph moves on and nothing outside the run changes. */
  | { readonly kind: 'no_effect' }

/**
 * What the interpreter does next.
 *
 * Five outcomes and no sixth, because every one of them is a row somebody reads afterwards: an execution,
 * a wait, a finish, a halt, or a document this build cannot interpret. An implicit "do nothing" would be a
 * run stuck at a cursor with no record of why.
 */
export type FlowStepPlan =
  | {
      readonly kind: 'execute'
      readonly node: FlowNode
      readonly action: FlowStepAction
      /** The node the run moves to once the action is done, or null when this node is terminal. */
      readonly nextNodeId: string | null
      /** The branch label the edge to `nextNodeId` carries. Recorded on the step log row. */
      readonly branch: string
    }
  /** A delay whose target instant has not arrived. The run resumes at `resumeAt`, and nothing is sent. */
  | {
      readonly kind: 'wait'
      readonly node: FlowNode
      readonly resumeAt: Instant
      readonly nextNodeId: string | null
    }
  /** An exit node. The enrolment ends with the reason the operator drew. */
  | { readonly kind: 'finish'; readonly node: FlowNode; readonly reason: FlowEndReason }
  /** The execution cap fired, or a condition could not be read. Either way the run stops and says so. */
  | {
      readonly kind: 'halt'
      readonly reason: Extract<FlowEndReason, 'loop_detected' | 'condition_unreadable'>
      readonly detail: string
    }
  /** The cursor names a node the document does not contain, or an edge leads nowhere. */
  | { readonly kind: 'unroutable'; readonly detail: string }

export interface FlowStepQuestion {
  readonly definition: FlowDefinition
  /** The node to decide about. `null` means "the trigger", which is where a run starts. */
  readonly cursorNodeId: string | null
  /** How many nodes this run has already executed. The loop bound is asked about the NEXT one. */
  readonly executionsSoFar: number
  /** The ceiling this run was started under, stored on its own row. Never a constant read here. */
  readonly maxNodeExecutions: number
  /** The instant the tick is running at, injected. Only a delay node reads it. */
  readonly at: Instant
  /** When the run last resumed from a delay, so a delay already waited is not waited twice. */
  readonly delayElapsedFrom: Instant
  readonly facts: FlowContactFacts
  /** The seed a split's branch is chosen from. `${runId}:${nodeId}` at the call site. */
  readonly splitSeedPrefix: string
}

/**
 * Decides one step.
 *
 * ## Why the cap is checked here and not in the worker's loop
 *
 * Because the claim is *"asserted to halt inside the bound rather than run away"*, and the only way to
 * assert that without a queue is for the bound to be a pure function of a counter. The check is
 * `executionsSoFar >= maxNodeExecutions`, so execution number `maxNodeExecutions` is performed and the
 * next one is refused: a run halts having executed exactly the ceiling, never one more. Migration 0091's
 * `flow_run_executions_within_bound` CHECK is the same statement in the database, between two columns of
 * the row, so a worker that ignored this could not store the result.
 *
 * A `wait` does NOT count as an execution, deliberately. A delay that counted would let a flow with a
 * hundred short delays exhaust the cap without doing anything, and the cap is a runaway detector rather
 * than a budget for how long a flow may take — `flow-analysis-accumulated-delay-exceeds-maximum` is what
 * bounds the elapsed time.
 */
export function planFlowStep(question: FlowStepQuestion): FlowStepPlan {
  const nodes = new Map(question.definition.nodes.map((node) => [node.id, node]))
  const node =
    question.cursorNodeId === null
      ? question.definition.nodes.find((candidate) => candidate.kind === 'trigger')
      : nodes.get(question.cursorNodeId)

  if (node === undefined) {
    return {
      kind: 'unroutable',
      detail:
        question.cursorNodeId === null
          ? 'The pinned definition has no trigger node, so the run has no way in. ' +
            '`flow-dsl-missing-trigger` refuses that at publish time.'
          : `The pinned definition has no node called "${question.cursorNodeId}". A cursor that names a ` +
            'node the document does not contain cannot be advanced; the definition is immutable ' +
            '(ZF001), so this is the cursor and not the graph.',
    }
  }

  if (node.kind === 'exit') return { kind: 'finish', node, reason: node.reason }

  if (node.kind === 'delay') {
    // Measured from when the run last resumed, not from when the enrolment started: a flow with three
    // delays waits the sum of them, and measuring every one from the enrolment would make the second one
    // already elapsed.
    const resumeAt = addMinutes(question.delayElapsedFrom, node.minutes)
    const next = edgeFrom(question.definition, node.id, FLOW_DEFAULT_BRANCH)
    if (question.at < resumeAt) return { kind: 'wait', node, resumeAt, nextNodeId: next }
    // The delay has already elapsed, so the run walks through it. Not an execution: see the header.
    if (next === null) return unroutableEdge(node, FLOW_DEFAULT_BRANCH)
    return {
      kind: 'execute',
      node,
      action: { kind: 'no_effect' },
      nextNodeId: next,
      branch: FLOW_DEFAULT_BRANCH,
    }
  }

  if (question.executionsSoFar >= question.maxNodeExecutions) {
    return {
      kind: 'halt',
      reason: 'loop_detected',
      detail:
        `This run has executed ${question.executionsSoFar} nodes, which is the ceiling it was started ` +
        `under (${question.maxNodeExecutions}), and the graph is asking for another at "${node.id}". ` +
        'The static analyser refuses a cycle with no delay and a cycle with no bounded exit, so a run ' +
        'that reaches the ceiling is one whose facts keep sending it round a loop the analyser passed.',
    }
  }

  if (node.kind === 'condition') {
    const verdict = answerFlowCondition(node.test, question.facts)
    if (verdict.kind === 'unreadable') {
      return { kind: 'halt', reason: 'condition_unreadable', detail: verdict.detail }
    }
    const next = edgeFrom(question.definition, node.id, verdict.branch)
    if (next === null) return unroutableEdge(node, verdict.branch)
    return {
      kind: 'execute',
      node,
      action: { kind: 'no_effect' },
      nextNodeId: next,
      branch: verdict.branch,
    }
  }

  if (node.kind === 'split') {
    const branch = chooseSplitBranch(node.branches, `${question.splitSeedPrefix}:${node.id}`)
    const next = edgeFrom(question.definition, node.id, branch)
    if (next === null) return unroutableEdge(node, branch)
    return { kind: 'execute', node, action: { kind: 'no_effect' }, nextNodeId: next, branch }
  }

  const next = edgeFrom(question.definition, node.id, FLOW_DEFAULT_BRANCH)
  if (next === null) return unroutableEdge(node, FLOW_DEFAULT_BRANCH)
  return {
    kind: 'execute',
    node,
    action: actionFor(node),
    nextNodeId: next,
    branch: FLOW_DEFAULT_BRANCH,
  }
}

/** The side effect a node asks for. Total over the kinds that have one. */
function actionFor(node: FlowNode): FlowStepAction {
  if (node.kind === 'action_message') {
    return {
      kind: 'send_message',
      templateKey: node.templateKey,
      channel: node.channel,
      messageClass: node.messageClass,
    }
  }
  if (node.kind === 'action_tag') return { kind: 'apply_tag', tag: node.tag }
  if (node.kind === 'action_stage') return { kind: 'move_stage', stage: node.stage }
  return { kind: 'no_effect' }
}

const unroutableEdge = (node: FlowNode, branch: string): FlowStepPlan => ({
  kind: 'unroutable',
  detail:
    `The "${branch}" branch of "${node.id}" leads nowhere. ` +
    '`flow-analysis-non-terminal-node-has-no-outgoing-edge` and the per-branch rules refuse that at ' +
    'publish time, so a run reaching it is running a document an earlier build published.',
})

/** The node one branch of one node leads to, or null. */
export function edgeFrom(definition: FlowDefinition, from: string, branch: string): string | null {
  const edge = definition.edges.find(
    (candidate) => candidate.from === from && candidate.branch === branch,
  )
  return edge?.to ?? null
}

/** Every branch label a condition can answer. Exported so a projection can walk both sides. */
export const CONDITION_BRANCHES: readonly string[] = FLOW_CONDITION_BRANCHES

// ------------------------------------------------------------------------------------------------
// The dry run's projection
// ------------------------------------------------------------------------------------------------

/** One projected step: what WOULD happen, for one contact at one node. */
export interface ProjectedStep {
  readonly customerId: string
  readonly nodeId: string
  readonly nodeKind: string
  /** The channel this node would send on, or null for a node that sends nothing. */
  readonly channel: MessageChannel | null
  readonly templateKey: string | null
  /** The instant the node would be reached, accumulated over the delays on the path. */
  readonly plannedAt: Instant
  readonly branch: string
}

export interface DryRunProjection {
  readonly rows: readonly ProjectedStep[]
  /** How many contacts the audience held. Reported whether or not every one was projected. */
  readonly audienceSize: number
  /**
   * Rows the cap stopped this projection from producing.
   *
   * REPORTED and never silently dropped: a dry run that showed the first thousand rows of forty thousand
   * without saying so is an operator reading the plan of a different campaign. Zero means the projection
   * is complete, which is the only state in which the plan may be read as the whole plan.
   */
  readonly projectedRowsOmitted: number
  /** How many contacts were left out entirely once the cap was reached. */
  readonly contactsOmitted: number
}

export interface DryRunQuestion {
  readonly definition: FlowDefinition
  /** The resolved audience, in a stable order. The caller resolves it; this projects it. */
  readonly audience: readonly { readonly customerId: string; readonly facts: FlowContactFacts }[]
  readonly startAt: Instant
  readonly maxProjectedRows: number
  readonly maxNodeExecutions: number
  readonly splitSeedPrefix: string
}

/**
 * Walks every contact through the graph WITHOUT doing anything, and reports what would have happened.
 *
 * The same `planFlowStep` the live interpreter uses, driven with the clock pushed forward past each delay
 * rather than waiting at it — so a projection reaches the end of a flow that takes ninety days. That is
 * the whole reason it is this function and not a second traversal: a projection written separately would
 * be a second interpreter, and the first branch either of them got wrong would be a dry run that showed
 * an operator a plan the live run does not follow.
 *
 * The cap stops the projection between rows and reports the remainder. It does not stop mid-contact
 * silently: `contactsOmitted` counts the contacts never started, and `projectedRowsOmitted` counts the
 * rows of the contact that was cut short plus every row of the ones that were not started — which is an
 * ESTIMATE for the latter and is stated as one, because projecting them to count them is the work the cap
 * exists to refuse.
 */
export function projectDryRun(question: DryRunQuestion): DryRunProjection {
  const rows: ProjectedStep[] = []
  let contactsOmitted = 0
  let omitted = 0

  for (const [index, member] of question.audience.entries()) {
    const remaining = question.maxProjectedRows - rows.length
    if (remaining <= 0) {
      contactsOmitted = question.audience.length - index
      break
    }
    const walked = projectOneContact(question, member, remaining)
    rows.push(...walked.rows)
    if (walked.cut) {
      // This contact was cut short, and so is every contact after it. The honest figure for what is
      // missing is an UPPER bound on the rows not produced — the node count per contact — because
      // projecting them in order to count them exactly is the work the cap exists to refuse. It is
      // reported rather than the projection being trimmed in silence, which is the defect this line was
      // written against.
      contactsOmitted = question.audience.length - index - 1
      omitted = (contactsOmitted + 1) * question.definition.nodes.length
      break
    }
  }
  if (contactsOmitted > 0 && omitted === 0) {
    omitted = contactsOmitted * question.definition.nodes.length
  }

  return {
    rows,
    audienceSize: question.audience.length,
    projectedRowsOmitted: omitted,
    contactsOmitted,
  }
}

/**
 * One contact's whole path, or as much of it as `budget` rows allow.
 *
 * `cut` is the honest half: true means this contact's path was not finished, which is what makes the
 * overflow reportable rather than invisible.
 */
function projectOneContact(
  question: DryRunQuestion,
  member: { readonly customerId: string; readonly facts: FlowContactFacts },
  budget: number,
): { readonly rows: readonly ProjectedStep[]; readonly cut: boolean } {
  const rows: ProjectedStep[] = []
  let cursor: string | null = null
  let at = question.startAt
  let elapsedFrom = question.startAt
  let executions = 0

  for (;;) {
    if (rows.length >= budget) return { rows, cut: true }
    const plan = planFlowStep({
      definition: question.definition,
      cursorNodeId: cursor,
      executionsSoFar: executions,
      maxNodeExecutions: question.maxNodeExecutions,
      at,
      delayElapsedFrom: elapsedFrom,
      facts: member.facts,
      splitSeedPrefix: `${question.splitSeedPrefix}:${member.customerId}`,
    })
    if (plan.kind === 'wait') {
      // The projection does not wait: it moves the clock to the instant the run would resume at and
      // carries on, which is what makes a plan for a 90-day nurture sequence readable in one screen.
      rows.push(projected(member.customerId, plan.node, null, null, plan.resumeAt, 'default'))
      at = plan.resumeAt
      elapsedFrom = plan.resumeAt
      cursor = plan.nextNodeId
      if (cursor === null) return { rows, cut: false }
      continue
    }
    if (plan.kind !== 'execute') {
      // finish, halt and unroutable are each recorded as this contact's LAST projected row, so a plan
      // that ends in a halt says so rather than simply stopping.
      const node = plan.kind === 'finish' ? plan.node : pseudoNode(cursor, plan.kind)
      rows.push(projected(member.customerId, node, null, null, at, plan.kind))
      return { rows, cut: false }
    }
    const send = plan.action.kind === 'send_message' ? plan.action : null
    rows.push(
      projected(
        member.customerId,
        plan.node,
        send?.channel ?? null,
        send?.templateKey ?? null,
        at,
        plan.branch,
      ),
    )
    executions += 1
    cursor = plan.nextNodeId
    if (cursor === null) return { rows, cut: false }
  }
}

const projected = (
  customerId: string,
  node: FlowNode | { readonly id: string; readonly kind: string },
  channel: MessageChannel | null,
  templateKey: string | null,
  plannedAt: Instant,
  branch: string,
): ProjectedStep => ({
  customerId,
  nodeId: node.id,
  nodeKind: node.kind,
  channel,
  templateKey,
  plannedAt,
  branch,
})

/**
 * The row a halt or an unroutable cursor is recorded as.
 *
 * A pseudo node rather than nothing, because the projection still has to name WHERE the plan stopped: a
 * dry run whose last row is missing reads as a flow that ends, and a flow that halts is not one.
 */
const pseudoNode = (cursor: string | null, kind: string) => ({
  id: cursor ?? 'trigger',
  kind,
})
