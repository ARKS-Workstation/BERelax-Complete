/**
 * The staff notification set, declared once (P-HR-14).
 *
 * ## Why the list is here and not in `@berelax/messaging`
 *
 * Four readers need it and they are in three packages: the template corpus (`@berelax/messaging`), the
 * class fence on the staff notification route (same package), the credential-expiry pass (`@berelax/worker`)
 * and the portal screen that tells a therapist which notices exist (`apps/web`). `@berelax/shared` is the
 * only package all three may import, which is the position `google-reauth.ts` took for the re-auth ladder's
 * two keys and for the same reason.
 *
 * ## Why every one of them is TRANSACTIONAL, stated as a rule rather than as four decisions
 *
 * Each of these is a fact about somebody's own employment — their published rota, a decision on their leave,
 * a document on their file that is about to lapse, a colleague asking to swap a shift. None of them is
 * marketing, and the two consequences of saying so are the point:
 *
 *   - **The marketing kill switch must not suppress them.** `marketingKillSwitch` stops every promotional
 *     send; a therapist who was not told their rota changed because somebody paused campaigns is a staffing
 *     failure caused by a marketing control.
 *   - **Quiet hours must not hold them.** TDRA's 07:00–21:00 window applies to promotional traffic
 *     (docs/04 §5). A rota published at 22:00 for tomorrow is useful at 22:00 and useless at 07:00.
 *
 * Both of those are properties of the CLASS, which is immutable on the template row (`message_class`,
 * migration 0014), so the enforcement is the gate's and not this file's. What this file does is name the set
 * so a test can enumerate it — and `STAFF_NOTIFICATION_CLASS` is the single value the fence on the route
 * compares against, rather than four comparisons that could disagree.
 */

/**
 * The four notices, keyed by what they are about.
 *
 * `rotaPublished` is P-HR-06's and already shipped; it is named here rather than left out because the set
 * is what the corpus test enumerates, and a set missing the one notice that already exists would prove the
 * rule about three templates while the fourth sat outside it.
 */
export const STAFF_NOTIFICATION_TEMPLATE_KEYS = {
  rotaPublished: 'hr.rota_published',
  leaveDecided: 'hr.leave_decided',
  credentialExpiring: 'hr.credential_expiring',
  shiftSwapRequested: 'hr.shift_swap_requested',
} as const satisfies Readonly<Record<string, string>>

export type StaffNotificationName = keyof typeof STAFF_NOTIFICATION_TEMPLATE_KEYS

/** Every staff notification key, for a corpus test that must not miss one. */
export const STAFF_NOTIFICATION_TEMPLATE_KEY_LIST: readonly string[] = Object.freeze(
  Object.values(STAFF_NOTIFICATION_TEMPLATE_KEYS),
)

/**
 * The one class a staff notification may carry.
 *
 * A single constant rather than the literal `'transactional'` written at each comparison: the fence on the
 * send route, the corpus test and the credential pass all ask the same question, and three literals is
 * three places to get it wrong in the direction that routes somebody's rota down the AD- identity.
 */
export const STAFF_NOTIFICATION_CLASS = 'transactional' as const

/** The refusal name, asserted by a test rather than the sentence beside it (ADR 0003). */
export const STAFF_NOTIFICATION_CLASS_REFUSAL = 'staff_notification_must_be_transactional' as const

export function isStaffNotificationTemplateKey(key: string): boolean {
  return STAFF_NOTIFICATION_TEMPLATE_KEY_LIST.includes(key)
}
