import { applyCustomerTag, claimNodeEffect } from '@berelax/db'
import type { NodeContext, NodeEffect } from './effect.ts'

/**
 * `action_tag`: put a tag on the contact.
 *
 * ## Why it claims a token at all, when the insert is already idempotent
 *
 * `customer_tag`'s primary key is `(customer_id, tag)`, so `on conflict do nothing` makes a second apply
 * a no-op whatever anybody does. The token is claimed anyway, and for a reason that has nothing to do
 * with the tag: the STEP LOG has to be able to say which delivery of the job did the work. Without a
 * token, fifty deliveries write fifty `executed` rows about one tag, and "why does this contact carry
 * `nurture_touch`" is answered fifty times — which is the same defect as fifty messages, one table along.
 *
 * The channel in the key is `sms`, which is a lie about a tag and is the least bad of the three options.
 * The key is `(flow_run, node, channel, contact)` and `message_channel` is NOT NULL, because the constraint
 * the acceptance line names is about a MESSAGE. Making the column nullable would make the unique index
 * treat two NULLs as distinct — which is exactly the property that would stop it de-duplicating anything —
 * and adding a `none` member to `message_channel` would put a value in the messaging vocabulary that no
 * transport can serve. So a non-message node claims its token on `sms`, and this comment is why; the step
 * log's own `channel` column is NULL for these nodes, which is the honest answer to "what channel was
 * this" and is what a reader sees.
 */
export async function executeTagNode(
  context: NodeContext,
  node: { readonly id: string; readonly tag: string },
): Promise<NodeEffect> {
  const claim = await claimNodeEffect(
    context.uow.sql,
    {
      runId: context.run.runId,
      nodeId: node.id,
      channel: 'sms',
      contactCustomerId: context.customerId,
    },
    context.atIso,
  )
  if (claim.kind === 'duplicate') {
    return {
      outcome: 'duplicate',
      channel: null,
      templateKey: null,
      messageId: null,
      consentRecordId: null,
      gateDecision: null,
      encoding: null,
      segments: null,
      costFils: null,
      detail: `The tag "${node.tag}" was already applied by an earlier delivery of this node.`,
      releaseAtIso: null,
      pause: false,
    }
  }
  const applied = await applyCustomerTag(context.uow.sql, {
    customerId: context.customerId,
    tag: node.tag,
  })
  return {
    outcome: 'executed',
    channel: null,
    templateKey: null,
    messageId: null,
    consentRecordId: null,
    gateDecision: null,
    encoding: null,
    segments: null,
    costFils: null,
    // The distinction is worth recording: a tag the contact already carried is not a fault and is not a
    // duplicate DELIVERY either — somebody may have applied it by hand, or an earlier run may have.
    detail: applied
      ? `Tagged "${node.tag}".`
      : `The contact already carried "${node.tag}", so the tag is unchanged.`,
    releaseAtIso: null,
    pause: false,
  }
}
