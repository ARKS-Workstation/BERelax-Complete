import { AppError } from '@berelax/shared'

/**
 * What may happen to a treatment narrative whose service is still being delivered.
 *
 * The failure this exists to prevent is small and expensive. A guest books a treatment on Tuesday; the
 * confirmation carries a link to the page describing it. On Monday the page is unpublished — a tidy-up,
 * or a rename, or somebody removing a treatment the salon no longer sells. The link 404s, the guest
 * cannot check what they booked, and the front desk gets a call. Deleting it is worse: the prose that
 * described what was sold is gone, and with it the answer to "what was I promised?".
 *
 * Archiving does the job the editor actually wanted — off the menu, out of the index, 301 to the
 * treatments page — while keeping the document and its versions. So archiving is always allowed, and
 * unpublishing or deleting is refused while a future booking exists.
 *
 * ## Why the count is injected
 *
 * Bookings live in the catalogue's schema under its own migration chain (B-CAT-03, B-AVAIL-*). This
 * module is in a package that may not do I/O, and the CMS must not grow a query against a table it does
 * not own. The caller supplies the count; `apps/web/src/payload/future-bookings.ts` is the probe that
 * produces it, and it is the only place that knows the catalogue's table names.
 */

export const RETIRE_ACTIONS = ['unpublish', 'delete', 'archive'] as const
export type RetireAction = (typeof RETIRE_ACTIONS)[number]

/**
 * What the probe found.
 *
 * `unknowable` is not a synonym for zero and it is the reason this is a union rather than a number. A
 * probe that cannot see the bookings table — because the catalogue has not been migrated into this
 * database yet, or because a rename broke the query — must not be able to report "no future bookings".
 * Returning `-1` or `0` on failure is how a fail-open default arrives dressed as a value.
 */
export type FutureBookingReport =
  | { readonly kind: 'counted'; readonly count: number }
  | { readonly kind: 'unknowable'; readonly reason: string }

/** The named refusals. Asserted by name, so a rewording of the message cannot pass for a rewording of the rule. */
export const SERVICE_NARRATIVE_HAS_FUTURE_BOOKINGS =
  'service_narrative_has_future_bookings' as const
export const SERVICE_NARRATIVE_BOOKINGS_UNKNOWABLE =
  'service_narrative_bookings_unknowable' as const

export type RetireRefusal =
  | typeof SERVICE_NARRATIVE_HAS_FUTURE_BOOKINGS
  | typeof SERVICE_NARRATIVE_BOOKINGS_UNKNOWABLE

export interface RetireRequest {
  readonly action: RetireAction
  /** Null for a narrative that references no catalogue service — nothing can be booked against it. */
  readonly catalogueServiceId: string | null
  readonly bookings: FutureBookingReport
}

/**
 * The decision. `null` means proceed.
 *
 * Returned rather than thrown so the Payload hook can decide how to surface it, and so the reason is a
 * value a test can compare rather than a string it has to match.
 */
export function retireRefusal(request: RetireRequest): RetireRefusal | null {
  // Archiving is the safe action and is always available. It is what the editor wanted.
  if (request.action === 'archive') return null
  // A narrative that references no service cannot have a booking against it. Refusing this case would
  // make an unused draft undeletable, which is how a fail-closed rule gets switched off by whoever
  // meets it first.
  if (request.catalogueServiceId === null) return null
  if (request.bookings.kind === 'unknowable') return SERVICE_NARRATIVE_BOOKINGS_UNKNOWABLE
  return request.bookings.count > 0 ? SERVICE_NARRATIVE_HAS_FUTURE_BOOKINGS : null
}

const MESSAGES: Readonly<Record<RetireRefusal, string>> = {
  [SERVICE_NARRATIVE_HAS_FUTURE_BOOKINGS]:
    'this treatment still has future bookings, and a guest who already booked it follows the link in ' +
    'their confirmation. Archive it instead: it leaves the menu and the index, and the page stays ' +
    'readable and redirects.',
  [SERVICE_NARRATIVE_BOOKINGS_UNKNOWABLE]:
    'the booking records for this treatment cannot be read, so it is not possible to say whether a ' +
    'guest has one. Archive it instead; unpublishing would be a guess.',
}

export function assertMayRetire(request: RetireRequest): void {
  const refusal = retireRefusal(request)
  if (refusal === null) return
  throw new AppError('conflict', `${refusal}: ${MESSAGES[refusal]}`, {
    userFacing: true,
    details: {
      reason: refusal,
      action: request.action,
      catalogueServiceId: request.catalogueServiceId,
      bookings: request.bookings,
    },
  })
}

/** The refusal an error carries, or null. Lets a caller branch without matching on the message. */
export function refusalOf(error: unknown): RetireRefusal | null {
  if (!(error instanceof AppError)) return null
  const reason = error.details['reason']
  return reason === SERVICE_NARRATIVE_HAS_FUTURE_BOOKINGS ||
    reason === SERVICE_NARRATIVE_BOOKINGS_UNKNOWABLE
    ? reason
    : null
}
