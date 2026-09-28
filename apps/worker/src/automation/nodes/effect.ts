import type { FlowContactFacts } from '@berelax/core'
import type { ClaimedFlowRun, UnitOfWork } from '@berelax/db'
import type { FlowNodeOutcome, MessageChannel } from '@berelax/shared'

/**
 * What one node's side effect produced, in exactly the shape a `flow_step_log` row holds.
 *
 * The correspondence is deliberate rather than convenient. A node that could produce something the step
 * log has no column for would be an effect nobody can explain afterwards, and "why did this contact get
 * this message" is the one question this unit exists to be able to answer. So the type IS the row, minus
 * the four fields the tick supplies from the run itself (the run id, the flow, the version and the node).
 */
export interface NodeEffect {
  readonly outcome: FlowNodeOutcome
  readonly channel: MessageChannel | null
  readonly templateKey: string | null
  readonly messageId: string | null
  /** From `resolveConsent(...).recordId` — the record the gate's boolean actually rested on. */
  readonly consentRecordId: string | null
  /** The gate's own word, or the refusal that stood in for it. */
  readonly gateDecision: string | null
  readonly encoding: string | null
  readonly segments: number | null
  readonly costFils: number | null
  readonly detail: string | null
  /**
   * The instant the GATE said this message may leave at, for a hold.
   *
   * Passed straight through and never computed here: the interpreter contains no window logic of its own,
   * so the only instant it knows about a hold is the one the gate handed back.
   */
  readonly releaseAtIso: string | null
  /**
   * True when the run must stop after this node rather than walking on to the next one.
   *
   * Only a HELD message sets it. Everything else either happened or was refused, and both of those are
   * facts the flow carries on from — a contact who could not be sent a message still goes down the rest
   * of the graph, because the operator drew the rest of the graph.
   */
  readonly pause: boolean
}

/** A node that changed nothing outside the run: a trigger, a delay, a condition, a split. */
export const noEffect = (): NodeEffect => ({
  outcome: 'no_effect',
  channel: null,
  templateKey: null,
  messageId: null,
  consentRecordId: null,
  gateDecision: null,
  encoding: null,
  segments: null,
  costFils: null,
  detail: null,
  releaseAtIso: null,
  pause: false,
})

/** Everything a node effect is given. One object, so a fourth node kind needs no new plumbing. */
export interface NodeContext {
  /**
   * The tick's own unit of work.
   *
   * Every node effect writes into THIS transaction — the message row, the idempotency token, the frequency
   * ledger row, the tag, the card move and the step log all commit together or not at all. That is the
   * acceptance line's *"the node side effect and its idempotency row commit in the same transaction as the
   * pg-boss job"*, and it is why no node opens a connection of its own.
   */
  readonly uow: UnitOfWork
  readonly run: ClaimedFlowRun
  /** The contact, resolved through the merge chain by `claimFlowRun`. */
  readonly customerId: string
  /** The instant the tick is running at, from the job context. Nothing here reads a clock. */
  readonly atIso: string
  readonly facts: FlowContactFacts
}
