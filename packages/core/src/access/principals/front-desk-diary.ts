import type { Permission } from '../permissions.ts'
import type { DeniedLinkCapability } from './customer-link.ts'

/**
 * The `system:front_desk_diary` principal: who the admin calendar is, in the policy layer.
 *
 * B-UI-03's diary is the first admin surface in this application that WRITES. Every other one — the
 * credentials screen, the reassignment queue, the compliance calendar, the Messages inbox, the template
 * editor — is read-only and records that it is not authenticated until W-SYS-01 builds the admin shell and
 * the session behind it. A read with no session is a screen anybody who can reach the origin can look at. A
 * write with no session needs an answer to "who moved this", and `appointment_status_history` and
 * `audit_event` are going to hold that answer for as long as the business keeps its books.
 *
 * ## Why a principal, and not the role the screen is named after
 *
 * `role: 'receptionist'` is the shortest spelling and it is the wrong one, for the reason
 * `./customer-link.ts` sets out at length: it would put a job title on the row when nothing proved one. A
 * receptionist is a person who signed in. Until W-SYS-01 exists, what actually reached this route is a
 * BROWSER pointed at a URL, and the truthful record of the move is "it was made from the diary screen,
 * which has no login yet" — not "Sara did it". Brief rule 15 is the general form of this: a plausible value
 * is worse than a blank one, because plausible is indistinguishable from configured. `receptionist` would
 * also carry `till:operate`, `invoice:issue`, `customer:write` and fourteen others into a surface that
 * needs one capability.
 *
 * `role: 'system'` is the other short spelling and it fails closed rather than quietly: `system` does not
 * hold `booking:reschedule`, so every drag would be refused with `transition_forbidden`. That refusal is
 * the mechanism working, and the fix is not to widen the role — every background worker in the product is
 * `system`, so granting it the reschedule would hand the campaign sender the ability to move appointments.
 *
 * So this is the third agent principal, and the registry's own comment predicted the shape of the danger:
 * *"the way an agent comes to hold a capability nobody granted it is by joining a role whose list was
 * written for somebody else"*.
 *
 * ## What it may do, and what W-SYS-01 replaces
 *
 * Exactly one write: move an appointment to another time or another room. That is the acceptance criterion
 * this unit exists for, and it is safe without a session for the reason a magic link's reschedule is — it
 * goes through `rescheduleAppointmentTx`, which takes the room `FOR UPDATE` lock, re-applies B-AVAIL-06's
 * slot re-check and re-resolves the trading date, so the worst a stranger with the URL can do is what the
 * front desk can do, and never something the constraints forbid.
 *
 * When W-SYS-01 lands, the diary's actor becomes the signed-in member of staff and this principal should
 * stop being used by it. It is deliberately NOT deleted at that point without a thought: rows written
 * before the session existed will still carry it, and a reader of the audit trail needs to be able to look
 * it up and find out what it meant.
 */

/** The principal id. Namespaced `system:` because there is no interactive login behind it. */
export const FRONT_DESK_DIARY_PRINCIPAL = 'system:front_desk_diary' as const

/**
 * Everything the diary may do. Three entries, and the third is the whole unit.
 *
 * `calendar:read` and `booking:read` are the grid. `booking:reschedule` is the drag, the keyboard move and
 * the no-JavaScript form — one capability, three ways of asking for it, because they all call the same
 * exported transaction.
 *
 * `booking:cancel` is absent, and that is the interesting absence: a diary makes cancellation look like
 * dragging a card off the grid, and a cancellation is not a move — it is a commitment being broken, with a
 * late-cancellation classification and a customer who has to be told. B-LIFE-03 owns it and W-SYS-01's
 * authenticated screen is where it belongs.
 */
export const FRONT_DESK_DIARY_GRANTS: readonly Permission[] = Object.freeze([
  'booking:read',
  'booking:reschedule',
  'calendar:read',
])

/**
 * The capabilities this surface must not carry, each with what it would let a stranger with the URL do.
 *
 * Deny-by-default already refuses everything not in {@link FRONT_DESK_DIARY_GRANTS}, so this grants nothing
 * and forbids nothing. It exists because an absence cannot be reviewed: a reader of a three-line allow list
 * cannot tell whether `booking:cancel` is missing because somebody decided it must be or because nobody
 * thought of it, and those two are the same bytes.
 */
export const FRONT_DESK_DIARY_DENIED_CAPABILITIES: readonly DeniedLinkCapability[] = Object.freeze([
  {
    permission: 'booking:cancel',
    why:
      'A cancellation is not a move. It classifies the notice against the cancellation window, releases ' +
      'the slot for good and leaves a customer who has to be told — and on an unauthenticated screen it ' +
      'would be one drag away from a reschedule. B-LIFE-03 owns the transaction; W-SYS-01 owns the screen.',
  },
  {
    permission: 'booking:cancel_as_salon',
    why:
      'The salon breaking its own commitment, which the front-desk role itself does not hold: ' +
      'ROLE_DEFINITIONS.receptionist has neither this nor the no-show. A surface with no login may not ' +
      'hold what the signed-in job title may not hold.',
  },
  {
    permission: 'booking:mark_no_show',
    why:
      'A judgement written against the customer, and the row a future fee policy attaches money to ' +
      '(Y9-windows). It is reachable only after the appointment has started, and deciding that somebody ' +
      'did not arrive is not something a diary drag should be able to say.',
  },
  {
    permission: 'booking:override_constraints',
    why:
      'The constraints are what make a write from an unauthenticated screen safe at all: the room FOR ' +
      'UPDATE lock, the therapist exclusion constraint and B-AVAIL-06s slot re-check. A caller that ' +
      'could override them could put two people in one room by dragging a card onto another.',
  },
  {
    permission: 'customer:read',
    why:
      'The grid names no customer and reads none. A diary answers "what is in which room when", and it ' +
      'is the screen most likely to be left open on a desk where anybody in the reception area can read ' +
      'it — so the client list must not be reachable from it.',
  },
  {
    permission: 'clinical_flags:read',
    why:
      'ADR 0010s boundary. A receptionist may see THAT a flag exists; this surface has no login to hang ' +
      'that judgement on, and a contraindication marker on a public-facing desk screen is the disclosure ' +
      'that boundary exists to prevent.',
  },
  {
    permission: 'till:operate',
    why:
      'The realistic accident, because it is in the receptionist list this was nearly copied from. Money ' +
      'taken by a screen nobody signed into is money nobody can be shown to have taken.',
  },
])
