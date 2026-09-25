import type { Permission } from '../permissions.ts'

/**
 * The `system:customer_booking_link` principal: who a magic link is, in the policy layer.
 *
 * B-UI-05's acceptance criterion is that *"customer-initiated reschedule calls the same exported function
 * as staff reschedule"* and *"obeys the cancellation window identically"*. Both of those are about the
 * WRITE path, and the write path is `transitionAppointment`, which asks this policy layer whether the
 * caller may perform the move. So a self-service surface needs an answer to "who is asking", and F07's
 * matrix has none: `ROLES` is eight job titles plus `system`, and a customer holding a link is none of
 * them.
 *
 * ## Why this is a principal and NOT a role
 *
 * Three spellings were available and two of them are wrong in ways that are worth writing down, because
 * each is the shortest change and each would have been invisible afterwards.
 *
 * **`role: 'receptionist'`.** The front desk holds `booking:reschedule` and `booking:cancel`, so it would
 * work on the first day. It also holds `customer:write`, `till:operate`, `invoice:issue`,
 * `clinical_flags:read` and eleven others — so the moment anything else consults the role of the caller
 * that reached it through a link, the link holder is a member of staff. That is not a hypothetical
 * slippage: it is `ROLE_DEFINITIONS.system` and `content:write` again, which `./seo-agent.ts` records as
 * the exact reason an agent does not resolve through a role.
 *
 * **Adding `customer` to `ROLES`.** Honest-looking, and it reaches further than the matrix. `ROLES` is
 * restated as a CHECK constraint on `obligation_definition.owner_role` (0052) and pinned to it in both
 * directions by `packages/fixtures/src/obligation-calendar.itest.ts`, so a ninth role means a migration
 * widening that constraint — and then a statutory obligation may be owned by "customer", which is
 * nonsense the schema would from then on permit. `permittedRolesFor` would also start naming it, so every
 * refusal message in the lifecycle would offer a customer as somebody who could have done it.
 *
 * **A principal.** G-SEO-02 built exactly this mechanism for exactly this reason, and its registry's own
 * comment says the second principal is the dangerous one — *"the way an agent comes to hold a capability
 * nobody granted it is by joining a role whose list was written for somebody else"*. This is the second
 * principal. It carries its own closed grant list, `resolvedPermissionsOf` reads that list and nothing
 * else, and `decideAppointmentTransition` resolves a role OR a declared principal through the one
 * `principalCan` rather than growing a second matrix.
 *
 * ## Why the capability is not the authorisation
 *
 * Holding a valid token is what proves WHICH booking is being managed; it is not what decides whether the
 * move is legal. Those are two questions and the reason to keep them apart is the reschedule: a link
 * holder may move their own appointment and may not mark it a no-show, and the second refusal has to come
 * from the policy layer rather than from the absence of a form field. `booking:mark_no_show` and
 * `booking:cancel_as_salon` are therefore absent below and the cage is closed by deny-by-default, exactly
 * as it is for the SEO agent.
 *
 * ## What the STATE records, and what the ROW records
 *
 * `cancelled_by_customer` names who *requested* the cancellation; the actor columns on the history row name
 * who *recorded* it. `packages/core/src/lifecycle/transitions.ts` states that distinction for the
 * receptionist taking a telephone call, and this principal is the same shape with no human in the middle:
 * the state is the customer's decision, and the actor is `kind: 'customer'` with no id, because a link
 * proves possession of a link and not an identity (ADR 0014).
 *
 * The row's `actor_role` is **`system`**, not this principal, and that is a constraint rather than a
 * preference: `appointment_status_history_actor_role_known` (0046) accepts exactly the eight F07 roles and
 * `packages/fixtures/src/appointment-lifecycle.itest.ts` pins the accepted set to `ROLES` in both
 * directions. Sending this id through the role was the first draft and the CHECK refused it — correctly: a
 * history row is read by somebody asking which of the eight roles did this. So `TransitionActor` carries
 * both, the role is recorded and the principal is authorised, and the principal appears in the row's
 * `actor_label` and in the `audit_event` the same transaction writes. `system` is the honest role for it
 * for the reason `ROLE_DEFINITIONS.system` gives — "no interactive login exists for this role" — and the
 * whole point of a principal is that it does not inherit that role's grants.
 */

/** The principal id. Namespaced `system:` because there is no interactive login behind it. */
export const CUSTOMER_LINK_PRINCIPAL = 'system:customer_booking_link' as const

/**
 * Everything a magic-link holder may do. Three entries, and the third is the one that needs defending.
 *
 * `booking:read` is the page. `booking:reschedule` and `booking:cancel` are the two things docs/09 §1 says
 * this route exists for — *"Magic-link self-service manage-booking"* — and they are the customer's own
 * moves, the same two the front desk makes on a telephone call.
 *
 * `booking:cancel_as_salon` is absent because it is the salon breaking its own commitment, which carries a
 * goodwill and refund consequence; `booking:mark_no_show` is absent because it is a judgement written
 * against the customer, and a customer marking themselves absent would produce the one record a fee policy
 * will later attach money to. `booking:override_constraints` is absent because the constraints are the
 * reason a self-service reschedule is safe at all: it goes through the same locks, the same exclusion
 * constraint and the same slot re-check as a booking, and a caller that could override them could put two
 * people in one room.
 */
export const CUSTOMER_LINK_GRANTS: readonly Permission[] = Object.freeze([
  'booking:read',
  'booking:reschedule',
  'booking:cancel',
])

/** One capability the link holder must not hold, and the specific loss it would allow. */
export interface DeniedLinkCapability {
  readonly permission: Permission
  /** Why. Read by nothing — this is the review artefact, and it is the point of the record. */
  readonly why: string
}

/**
 * The capabilities a link must not carry, each with what it would let a stranger with a URL do.
 *
 * Deny-by-default already refuses everything not in {@link CUSTOMER_LINK_GRANTS}, so this grants nothing
 * and forbids nothing. It exists for `SEO_AGENT_DENIED_CAPABILITIES`'s reason: an absence cannot be
 * reviewed. A reader of a three-line allow list cannot tell whether `clinical_flags:read` is missing
 * because somebody decided it must be or because nobody thought of it, and those two are the same bytes.
 */
export const CUSTOMER_LINK_DENIED_CAPABILITIES: readonly DeniedLinkCapability[] = Object.freeze([
  {
    permission: 'booking:cancel_as_salon',
    why:
      'The salon breaking its own commitment. It carries a refund and a goodwill consequence the front ' +
      'desk may not take alone (ROLE_DEFINITIONS.receptionist does not hold it), so a URL certainly may ' +
      'not — and the state it writes would make the salon look as though it had cancelled the customer.',
  },
  {
    permission: 'booking:mark_no_show',
    why:
      'A judgement written against the customer, and the row a fee policy will one day attach money to ' +
      '(B-LIFE-03, Y9-windows). A link holder marking themselves absent is the one lifecycle move whose ' +
      'own subject must not be able to make it.',
  },
  {
    permission: 'booking:override_constraints',
    why:
      'The constraints are what make an unauthenticated reschedule safe: the room FOR UPDATE lock, the ' +
      'therapist exclusion constraint and B-AVAIL-06s slot re-check. A caller that could override them ' +
      'could put two people in one room from a URL in an SMS.',
  },
  {
    permission: 'clinical_flags:read',
    why:
      'ADR 0010s boundary, from the other side. A receptionist may see THAT a flag exists and not the ' +
      'note behind it; this page is read off a phone on a café table, so it sees neither. The field ' +
      'allowlist in packages/core/src/identity/booking-token.ts is the second layer of the same rule.',
  },
  {
    permission: 'customer:read',
    why:
      'A link proves possession of a link, not an identity (ADR 0014). The page is built from ONE booking ' +
      'the grant names; a caller that could read the customer record could read the history, the ' +
      'preferences and the spend of whoever the booking belongs to.',
  },
  {
    permission: 'customer:write',
    why:
      'The realistic accident, because the front-desk list this was nearly copied from holds it. A link ' +
      'that could write the customer row could change the phone number the OTP is sent to, which is the ' +
      'one field that turns a stolen link into a stolen identity.',
  },
])
