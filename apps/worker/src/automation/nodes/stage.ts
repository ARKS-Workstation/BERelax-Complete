import { type Actor, claimNodeEffect, moveCard, pipelineRefusalOf } from '@berelax/db'
import type { NodeContext, NodeEffect } from './effect.ts'

/**
 * `action_stage`: move the contact's card into a column.
 *
 * ## Why this calls `moveCard` and nothing was checked at publish time
 *
 * C-AUTO-06's NOTE (5) deferred "check an `action_stage` node's stage against the vocabulary" to this unit,
 * and C-AUTO-08's NOTE answered it before this unit existed: *"a publish-time check cannot be the
 * guarantee, because a stage can be archived after a flow is published and nothing re-publishes a flow when
 * the board changes. The choke point has to be the WRITE ... So what C-AUTO-07's `action_stage` step needs
 * is to call `moveCard` rather than to trust a check made days earlier."* This is that call, and it is the
 * whole of this unit's answer to that half of the deferral: `moveCard` refuses `stage_not_found` and
 * `stage_archived` by name, at the only moment either answer is final, and the refusal lands on the step
 * log where a reader will look for it.
 *
 * The other half — a `lifecycle_state` condition's value — IS checked at publish time
 * (`flow-dsl-unknown-lifecycle-state`), and the difference is exactly the one C-AUTO-08 names: a value that
 * is not a lifecycle state can never become one, so publish is the earliest moment the answer is final.
 *
 * ## Why three refusals are recorded and not raised
 *
 * `stage_not_found`, `stage_archived` and `card_already_in_stage` are all facts about the board rather than
 * faults in the run, and none of them will change in sixty seconds. Raising would burn a pg-boss retry and
 * eventually dead-letter a job whose only problem is that an operator archived a column — so each one is
 * recorded as a `refused` step with its own name and the flow carries on down the rest of the graph, which
 * is the graph the operator drew. Anything else from `moveCard` IS raised: an unexpected failure inside a
 * card move is not something this node may decide about.
 */
export async function executeStageNode(
  context: NodeContext,
  node: { readonly id: string; readonly stage: string },
): Promise<NodeEffect> {
  const claim = await claimNodeEffect(
    context.uow.sql,
    {
      runId: context.run.runId,
      nodeId: node.id,
      // `sms` for the reason `tag.ts` states in full: the token's channel column is NOT NULL because the
      // key the acceptance line names is about a message, and a nullable column would stop the unique
      // index de-duplicating anything.
      channel: 'sms',
      contactCustomerId: context.customerId,
    },
    context.atIso,
  )
  if (claim.kind === 'duplicate') {
    return refusalEffect(
      'duplicate',
      null,
      `The card move to "${node.stage}" was already performed by an earlier delivery of this node.`,
    )
  }

  const actor: Actor = { kind: 'system', label: `automation.flow:${context.run.flowKey}` }
  try {
    await moveCard(context.uow, {
      customerId: context.customerId,
      toStageKey: node.stage,
      actor,
      at: new Date(context.atIso),
    })
  } catch (error) {
    const refusal = pipelineRefusalOf(error)
    if (
      refusal === 'stage_not_found' ||
      refusal === 'stage_archived' ||
      refusal === 'card_already_in_stage'
    ) {
      return refusalEffect(
        'refused',
        refusal,
        `moveCard refused "${node.stage}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    throw error
  }
  return refusalEffect('executed', null, `Moved the card to "${node.stage}".`)
}

const refusalEffect = (
  outcome: 'executed' | 'refused' | 'duplicate',
  gateDecision: string | null,
  detail: string,
): NodeEffect => ({
  outcome,
  channel: null,
  templateKey: null,
  messageId: null,
  consentRecordId: null,
  // `gate_decision` holds the refusal's NAME for a stage node, and the column's comment says the
  // vocabulary is the messaging gate's. That is a slight stretch and the alternative is worse: a second
  // column that held "the other kind of refusal" would make "why did this step not happen" two queries.
  gateDecision,
  encoding: null,
  segments: null,
  costFils: null,
  detail,
  releaseAtIso: null,
  pause: false,
})
