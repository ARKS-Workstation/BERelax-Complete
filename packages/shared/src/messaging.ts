/**
 * The two message classifications, and the channels they travel on.
 *
 * These live in `shared` rather than in `@berelax/messaging`, where they are used, for one structural
 * reason: `@berelax/providers` needs `MessageClass` in its SMS and email port signatures, and
 * `@berelax/messaging` needs the ports to build a transport. Declaring them in `messaging` made the two
 * packages depend on each other — pnpm links a cyclic workspace pair and warns, and any future build
 * step for either package has no valid order to run in. `shared` is the leaf every package may depend
 * on, which is exactly what a type two packages both need is for.
 */

/**
 * Channels the platform can send on.
 *
 * WhatsApp is later but the model is channel-shaped now, because retrofitting it into a flat SMS-shaped
 * type means touching every send path.
 */
export type Channel = 'sms' | 'email' | 'whatsapp'

/**
 * Transactional or promotional. This is the most consequential field in the messaging module.
 *
 * It is an immutable property of the TEMPLATE, never of the send call, so an automation cannot route
 * promotional content down a transactional path. UAE promotional SMS must carry an AD-prefixed sender id
 * and is confined to 07:00–21:00; getting it wrong risks sender-id suspension, which would stop every
 * booking confirmation. See docs/04-uae-compliance.md §5.
 */
export type MessageClass = 'transactional' | 'promotional'

/** Both classes as a value, so a test can iterate them instead of restating the union. */
export const MESSAGE_CLASSES = ['transactional', 'promotional'] as const

/** Every channel as a value, for the same reason. */
export const MESSAGE_CHANNELS = ['sms', 'email', 'whatsapp'] as const

/**
 * A template variant's approval state — `template_approval` in the database since 0014.
 *
 * Here for the reason `MessageStatus` below is here: `packages/db` writes it and may not import
 * `packages/core`, `packages/messaging` decides whether it may be sent, and the admin surface renders it.
 * `shared` is the only leaf all of them may see one copy in.
 */
export const TEMPLATE_APPROVAL_STATES = ['draft', 'pending', 'approved', 'rejected'] as const
export type TemplateApprovalState = (typeof TEMPLATE_APPROVAL_STATES)[number]

/**
 * The declared edges of the approval state machine. Everything not listed is refused.
 *
 * `template_approval_transition_allowed` in migration 0061 is the same list in SQL, and
 * `packages/fixtures/src/message-template.itest.ts` asserts the two agree on **all sixteen** ordered
 * pairs rather than on the seven that are legal — two implementations that refuse everything agree
 * perfectly, so the permitted set has to be compared as well as the refused one.
 *
 * The shape of the rule, rather than the list:
 *
 *   - nothing reaches `approved` except from `pending`, so no single UPDATE can approve something no
 *     reviewer was shown;
 *   - `rejected` goes only to `draft`, never back to `pending`, because a rejection answered by
 *     resubmitting the identical words is the reviewer being asked the same question until they agree;
 *   - `approved` can be withdrawn to `draft`, which — together with the ZM003 freeze on an approved
 *     variant's words — is the ONLY way to edit an approved body.
 */
export const TEMPLATE_APPROVAL_TRANSITIONS: readonly (readonly [
  TemplateApprovalState,
  TemplateApprovalState,
])[] = [
  ['draft', 'pending'],
  ['pending', 'approved'],
  ['pending', 'rejected'],
  ['pending', 'draft'],
  ['rejected', 'draft'],
  ['approved', 'draft'],
  ['approved', 'rejected'],
]

/** True when the state machine has an edge from `from` to `to`. A self-move is not an edge. */
export function isTemplateApprovalTransition(
  from: TemplateApprovalState,
  to: TemplateApprovalState,
): boolean {
  return TEMPLATE_APPROVAL_TRANSITIONS.some(([f, t]) => f === from && t === to)
}

/**
 * The one state a template may be sent in.
 *
 * Written as a function over the whole vocabulary rather than as `state === 'approved'` at each call
 * site, because the interesting property is that it is TOTAL: a fifth state added to
 * `TEMPLATE_APPROVAL_STATES` is not sendable until somebody says so here, where the reason can be
 * written down. A `switch` with a permissive `default` is how `pending` becomes sendable by accident.
 */
export function isSendableApproval(state: TemplateApprovalState): boolean {
  return state === 'approved'
}

/**
 * The status lifecycle of one outbound message, and the order it may move in.
 *
 * ## Why this is here rather than in `@berelax/core`
 *
 * It is a calculation, and calculations belong in `core` — except that `packages/db` needs it (the
 * repository's guarded UPDATE, and the Drizzle mirror of the `message_status` enum) and `packages/db`
 * must never import `packages/core`; the dependency direction is `core <- db`. `shared` is the leaf
 * every package may depend on, which is exactly the reason `Channel` and `MessageClass` are above:
 * four packages need this vocabulary — db writes it, messaging maps onto it, the worker advances it and
 * the admin inbox renders it — and `shared` is the only place all four can see one copy.
 *
 * ## Why the vocabulary is ours
 *
 * SMSala reports `accepted / delivered / failed / expired / rejected`; Resend reports
 * `delivered / bounced / complained / opened`. Neither set is this list, and a third vendor would bring
 * a fourth. The mapping from a vendor's word onto one of these lives beside that vendor's transport
 * (`packages/messaging/src/transports`), so changing vendor is a change to a mapping and not to every
 * badge, report and query in the system. A vendor word we do not recognise maps to nothing at all — see
 * `advanceMessageStatus`, and `message_delivery_receipt.ignored_reason` in migration 0035.
 */
export const MESSAGE_STATUSES = ['queued', 'sent', 'delivered', 'failed'] as const

export type MessageStatus = (typeof MESSAGE_STATUSES)[number]

/**
 * The lifecycle order. Higher is later.
 *
 * `delivered` and `failed` share the top rank deliberately, so neither can displace the other: the
 * first terminal receipt wins and a later one is recorded and ignored. A handset that acknowledged a
 * message cannot be un-acknowledged by an expiry notice queued behind it, and a vendor that rejected a
 * message cannot be talked into having delivered it.
 *
 * `message_status_rank` in migration 0035 is the same function in SQL, and the trigger that uses it is
 * what makes the rule hold for a writer that never came through this module.
 */
export const MESSAGE_STATUS_RANK: Readonly<Record<MessageStatus, number>> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  failed: 2,
}

/** True when no further transition is possible. */
export function isTerminalMessageStatus(status: MessageStatus): boolean {
  return MESSAGE_STATUS_RANK[status] === MESSAGE_STATUS_RANK.delivered
}

/** Why a receipt did not change the status. The values of `message_delivery_receipt.ignored_reason`. */
export type ReceiptIgnoredReason =
  /** The vendor sent a status word this system does not map. It must not become `delivered`. */
  | 'vendor_status_unrecognised'
  /** Out of order, a duplicate, or a second terminal state. The stored value already wins. */
  | 'status_would_not_advance'
  /** Recognised, and not about delivery: Resend's `opened`, and its `complained`. */
  | 'vendor_status_carries_no_lifecycle_change'

/** The outcome of applying one receipt to one message. */
export type StatusAdvance =
  | { readonly applied: true; readonly status: MessageStatus }
  | {
      readonly applied: false
      readonly status: MessageStatus
      readonly reason: ReceiptIgnoredReason
    }

/**
 * What a receipt does to a stored status.
 *
 * `next` is `null` for a vendor word this system does not recognise, which is the case that must not
 * default to anything: a receipt whose meaning is unknown leaves the status alone and says why.
 */
export function advanceMessageStatus(
  current: MessageStatus,
  next: MessageStatus | null,
): StatusAdvance {
  if (next === null) {
    return { applied: false, status: current, reason: 'vendor_status_unrecognised' }
  }
  if (MESSAGE_STATUS_RANK[next] <= MESSAGE_STATUS_RANK[current]) {
    return { applied: false, status: current, reason: 'status_would_not_advance' }
  }
  return { applied: true, status: next }
}

/**
 * Why a send did not leave, in this system's words.
 *
 * Declared here rather than in `@berelax/messaging` — where `TransportFailure` aliases it — for the
 * same reason as `MessageStatus`: these four values are the value set of the
 * `message.last_failure_reason` CHECK in migration 0035, so `packages/db` needs them, and the retry
 * policy in `packages/core` is keyed by them. One list, three packages, no copy to keep in step.
 */
export const MESSAGE_FAILURE_REASONS = [
  'provider_rejected',
  'provider_rate_limited',
  'provider_unavailable',
  'provider_error',
] as const

export type MessageFailureReason = (typeof MESSAGE_FAILURE_REASONS)[number]

/**
 * The fifth reason a message row can carry, and why it is not one of the four above.
 *
 * The four are transport failures: the message did **not leave**. This one is a delivery failure: it
 * left, a vendor accepted it, and the network later said it did not arrive — SMSala's `expired` or
 * `rejected`, Resend's `bounced`. Conflating the two would make the cost report and the failure
 * breakdown unable to tell a rate limit from an absent subscriber, which are the two things an operator
 * does completely different work about.
 *
 * It is deliberately absent from `MESSAGE_FAILURE_REASONS`, which keys the retry policy: a message the
 * network has already rejected is terminal, so there is no policy for it to have. The vendor's own word
 * survives on the receipt row.
 */
export const DELIVERY_REPORTED_FAILED = 'delivery_reported_failed'

/** Every value `message.last_failure_reason` may hold. The four transport failures plus the fifth. */
export const MESSAGE_ROW_FAILURE_REASONS = [
  ...MESSAGE_FAILURE_REASONS,
  DELIVERY_REPORTED_FAILED,
] as const

export type MessageRowFailureReason = (typeof MESSAGE_ROW_FAILURE_REASONS)[number]
