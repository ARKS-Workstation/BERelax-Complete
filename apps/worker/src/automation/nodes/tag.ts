import { applyCustomerTag, claimNodeEffect } from '@berelax/db'
import type { NodeContext, NodeEffect } from './effect.ts'

/**
 * The grammar `customer_tag.tag` accepts: kebab-case, 2 to 40 characters (`customer_tag_tag_check`, 0053).
 *
 * Restated here because `packages/db` does not export it and this is the one caller that can be handed a
 * tag it did not choose. It is a copy, and the copy is asserted against the live CHECK by
 * `interpreter.itest.ts` so it cannot drift silently.
 *
 * ## The disagreement this exists because of, and who owns it
 *
 * The DSL's `action_tag.tag` is lower SNAKE case (`schemas/flow.ts`, `VOCABULARY_VALUE`), and no string
 * satisfies both grammars: one requires `_` to be legal, the other requires `-`. So a flow an operator
 * draws with `nurture_touch` validates, publishes, and then cannot write its tag. Two of the committed
 * corpus documents are in that state, which is how this was found — by running the interpreter, which is
 * the first thing in this build that writes a tag from a flow.
 *
 * This unit does NOT reconcile the two vocabularies, and the reason is that reconciling them changes what a
 * published document may contain: the DSL field is `.strict()`, its round-trip property is over the
 * committed corpus, and `flow-corpus.test.ts` asserts twelve valid documents byte for byte. Changing the
 * grammar is a change to what an operator may draw, and the unit that owns the picker an operator draws it
 * in is C-AUTO-09. A NOTE in the manifest says so.
 *
 * What this unit does is refuse LOUDLY and in a row a reader will find: `refused` with
 * `tag_not_storable`, the grammar in the detail, and the flow carrying on down the rest of the graph.
 * Raising instead would burn a pg-boss retry on a condition that cannot change in sixty seconds and would
 * dead-letter a job whose only problem is a document somebody was allowed to publish.
 */
export const STORABLE_TAG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const STORABLE_TAG_LENGTH = { min: 2, max: 40 } as const

/** True for a tag `customer_tag` will accept. */
export const isStorableTag = (tag: string): boolean =>
  STORABLE_TAG.test(tag) &&
  tag.length >= STORABLE_TAG_LENGTH.min &&
  tag.length <= STORABLE_TAG_LENGTH.max

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
  if (!isStorableTag(node.tag)) {
    return {
      outcome: 'refused',
      channel: null,
      templateKey: null,
      messageId: null,
      consentRecordId: null,
      gateDecision: 'tag_not_storable',
      encoding: null,
      segments: null,
      costFils: null,
      detail:
        `"${node.tag}" is not a tag customer_tag will store: the column accepts ` +
        `${String(STORABLE_TAG)} between ${STORABLE_TAG_LENGTH.min} and ${STORABLE_TAG_LENGTH.max} ` +
        'characters (customer_tag_tag_check, 0053), and the flow DSL accepts lower snake_case. No string ' +
        'satisfies both. Recorded rather than raised: the document cannot fix itself in sixty seconds, and ' +
        'a dead-lettered job would hide a flow that publishes and then does nothing.',
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
