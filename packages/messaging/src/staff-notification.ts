import {
  AppError,
  isStaffNotificationTemplateKey,
  STAFF_NOTIFICATION_CLASS,
  STAFF_NOTIFICATION_CLASS_REFUSAL,
} from '@berelax/shared'
import {
  type DeliveryDeps,
  type DeliveryOutcome,
  deliverMessage,
  type RecordedSendRequest,
} from './lifecycle.ts'

/**
 * The staff notification route (P-HR-14): one fence, then the choke point.
 *
 * ## It is not a second send path, and that is checkable
 *
 * It calls {@link deliverMessage}, which calls `sendMessage`, which is the one module in the repository
 * that hands a message to a transport. `pnpm send-chokepoint` enumerates every `.send(` on a message and
 * this file has none — it has one `deliverMessage`, exactly as `apps/worker/src/jobs/google-reauth-notify.ts`
 * does. So every staff notice passes the template judgement, the identity resolution, the consent and
 * suppression evaluators, the frequency cap and the quiet-hours window, in that order, with nothing skipped
 * and nothing added.
 *
 * ## What the fence adds, and why it is a REFUSAL and not a correction
 *
 * {@link assertStaffNotificationClass} refuses a template whose class is not transactional. It does not
 * rewrite the class, and it could not: `message_class` is immutable on the template row (migration 0014)
 * and `SendRequest` fences the field out of the type entirely, which is `send.ts`'s `readonly messageClass?:
 * never`. So the only way a promotional template reaches a staff recipient is a call site choosing one, and
 * this is where that choice is refused.
 *
 * The refusal matters because of what the class decides. A promotional staff notice would be suppressed by
 * the marketing kill switch and held outside 07:00–21:00 — so a rota published at 22:00 would arrive at
 * breakfast, and a rota published while campaigns were paused would not arrive at all. Both are staffing
 * failures caused by a marketing control, and neither would look like a bug anywhere near the notice.
 *
 * The acceptance line asks for the refusal to be proved on "the same route", and that is what makes this a
 * function rather than a comment: `packages/messaging/src/staff-notification.test.ts` presents a
 * promotional template to this entry point and requires `staff_notification_must_be_transactional`, with
 * the transactional one succeeding beside it as the control.
 *
 * ## Why the key is checked too
 *
 * A transactional template that is not one of the four would pass the class fence and be sent to a member of
 * staff from this route — a booking confirmation, say, addressed at a therapist. The route is for the
 * declared set and refuses anything else, which is also what keeps
 * `STAFF_NOTIFICATION_TEMPLATE_KEY_LIST` load-bearing rather than documentation.
 */

/** Why the route refused. Values, so a caller branches without matching on a message. */
export const STAFF_NOTIFICATION_REFUSALS = [
  STAFF_NOTIFICATION_CLASS_REFUSAL,
  'staff_notification_key_not_declared',
] as const

export type StaffNotificationRefusal = (typeof STAFF_NOTIFICATION_REFUSALS)[number]

/**
 * Refuses a template that may not carry a staff notice.
 *
 * Throws rather than returning a refusal, and that is the one place this module differs from the gate's
 * style. A class mismatch is not an outcome of a notice — it is a call site asking for something that must
 * never happen — so it is a programming error and belongs where an `AppError` goes. The gate's returned
 * refusals are about a RECIPIENT and this is about a TEMPLATE.
 */
export function assertStaffNotificationClass(template: {
  readonly key: string
  readonly messageClass: string
}): void {
  if (!isStaffNotificationTemplateKey(template.key)) {
    throw new AppError(
      'validation',
      `staff_notification_key_not_declared: "${template.key}" is not in ` +
        'STAFF_NOTIFICATION_TEMPLATE_KEY_LIST, so it may not be sent from the staff notification route. ' +
        'A transactional template that is not one of the declared four would otherwise reach a member of ' +
        'staff from here — a booking confirmation addressed at a therapist, for instance.',
      { details: { refusal: 'staff_notification_key_not_declared', key: template.key } },
    )
  }
  if (template.messageClass !== STAFF_NOTIFICATION_CLASS) {
    throw new AppError(
      'validation',
      `${STAFF_NOTIFICATION_CLASS_REFUSAL}: "${template.key}" is ${template.messageClass}, and a staff ` +
        `notification must be ${STAFF_NOTIFICATION_CLASS}. A promotional one would leave from the AD- ` +
        'identity, would be suppressed by the marketing kill switch and would be held outside ' +
        '07:00-21:00 — so a rota published at 22:00 would arrive at breakfast and one published while ' +
        'campaigns were paused would not arrive at all.',
      {
        details: {
          refusal: STAFF_NOTIFICATION_CLASS_REFUSAL,
          key: template.key,
          messageClass: template.messageClass,
        },
      },
    )
  }
}

/** The staff notification route. The fence, then the choke point, and nothing in between. */
export async function deliverStaffNotification(
  deps: DeliveryDeps,
  request: RecordedSendRequest,
): Promise<DeliveryOutcome> {
  assertStaffNotificationClass(request.template)
  return deliverMessage(deps, request)
}
