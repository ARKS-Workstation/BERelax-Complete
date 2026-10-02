import {
  decideRefCapture,
  type Instant,
  instantFromIso,
  type RefCaptureDecision,
} from '@berelax/core'
import {
  type Actor,
  matchWhatsappRef,
  type RecordedRefCapture,
  recordRefCapture,
  rollUpDailyRefCapture,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { AppError, normaliseWhatsappRefCode } from '@berelax/shared'

/**
 * The ref claim, as ONE named thing: look the code up, decide, record, and move the day's figures.
 *
 * ## Why this is its own module rather than three steps inside the handler
 *
 * It was three steps inside the handler, twice — once on the check and once on the confirm — and the two
 * copies are what makes a drift possible: the check previews an outcome and the confirm records one, and if
 * they ask the database different questions the screen warns about one thing and the row says another.
 * There is one lookup and one rule here, and both paths call it.
 *
 * It lives in `apps/web` rather than in `@berelax/core` or `@berelax/db` because it needs BOTH: the rule is
 * core's (`decideRefCapture`) and the writes are db's, and `packages/db` may never import `packages/core`
 * (ADR 0001) — the dependency runs the other way. `apps/web` is where the two meet, which is why the
 * booking handler and the till handler have the same shape.
 *
 * ## What the division of labour is, exactly
 *
 * - **The lookup** is `matchWhatsappRef`, which answers a ROW or null and never a boolean. That is what
 *   makes "an attribution is only ever a row that exists" structural: there is no input to the rule from
 *   which a match could be inferred.
 * - **The rule** is `decideRefCapture`, which is pure and takes the instant and the customer as arguments.
 *   It decides between matched, expired, already-claimed, unknown and not-offered, and it is the only
 *   place that order is written down.
 * - **The writes** are `recordRefCapture` (idempotent per booking) and `rollUpDailyRefCapture` (recomputed
 *   from the tables), in one transaction, after the booking is already durable.
 * - **The database** refuses what the rule would never construct anyway: 0127's ZY331 and ZY332 reject a
 *   `matched` row naming an expired code or a session the code was not issued into. Those are not this
 *   module's belt-and-braces; they are the guarantee for every OTHER writer.
 */

/** A decision, plus the one fact the day-level rollup needs that the decision does not carry. */
export interface RefClaimDecision extends RefCaptureDecision {
  /**
   * The matched code's own issue instant, or null when nothing resolved.
   *
   * The rollup is keyed on the day the CODE was issued — so the numerator and the denominator are the same
   * cohort — which means a booking with no code belongs to no issue cohort and must not touch a day's row.
   */
  readonly issuedAtIso: string | null
}

/**
 * What the desk typed, decided against the table, without writing anything.
 *
 * The CHECK path's answer, and the confirm path's first half. `customerId` is what makes a prior claim a
 * conflict rather than a repeat; an empty string means "we do not know who this is yet", which is the
 * strict direction — an unknown customer against a code somebody has already claimed previews
 * `ref_conflict`, which is the warning the desk needs.
 */
export async function decideRefClaim(
  sql: Sql,
  input: { readonly entered: string; readonly at: Instant; readonly customerId: string },
): Promise<RefClaimDecision> {
  const normalised = normaliseWhatsappRefCode(input.entered)
  const matched = normalised === null ? null : await matchWhatsappRef(sql, normalised)
  const decision = decideRefCapture({
    entered: input.entered,
    at: input.at,
    customerId: input.customerId,
    matched:
      matched === null
        ? null
        : {
            refCode: matched.refCode,
            // The CODE's session, copied across. The rule has no other session in scope, which is the
            // whole of "an attribution nobody can have chosen".
            sessionId: matched.sessionReference,
            expiresAt: instantFromIso(matched.expiresAtIso),
            claimedByCustomerId: matched.claimedByCustomerId,
          },
  })
  return { ...decision, issuedAtIso: matched?.issuedAtIso ?? null }
}

/**
 * Records the claim for a booking that already exists, and moves that code's day.
 *
 * Called AFTER the booking is durable, deliberately: the ref field may never block a booking, and making
 * the capture write a separate transaction after the commit is that acceptance line made structural rather
 * than remembered. `recordRefCapture` is idempotent per booking, so a replayed booking — the endpoint
 * answers with the ORIGINAL on a retry — records nothing new and cannot count one booking twice.
 */
export async function claimRefForBooking(
  sql: Sql,
  actor: Actor,
  input: {
    readonly bookingId: string
    readonly entered: string
    readonly at: Instant
    readonly requestId?: string | null
  },
): Promise<{ readonly capture: RecordedRefCapture; readonly decision: RefClaimDecision }> {
  const customerId = await customerIdForBooking(sql, input.bookingId)
  const decision = await decideRefClaim(sql, {
    entered: input.entered,
    at: input.at,
    customerId,
  })
  const capture = await withUnitOfWork(
    sql,
    actor,
    async (uow) => {
      const recorded = await recordRefCapture(uow, {
        bookingId: input.bookingId,
        outcome: decision.outcome,
        refCode: decision.refCode,
        enteredCode: decision.enteredCode,
        attributedSessionId: decision.attributedSessionId,
      })
      if (decision.issuedAtIso !== null) {
        await rollUpDailyRefCapture(uow, { atIso: decision.issuedAtIso })
      }
      return recorded
    },
    input.requestId === null || input.requestId === undefined ? {} : { requestId: input.requestId },
  )
  return { capture, decision }
}

/**
 * Who this phone number already is, or null for a number the business has never seen.
 *
 * The CHECK path's preview only. `normalisePhone` has already produced the E.164 the column stores (ADR
 * 0014), so this is a key-shaped lookup and not a search.
 */
export async function customerIdForPhone(sql: Sql, phoneE164: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    select id::text as id from customer where phone_e164 = ${phoneE164}
  `
  return row?.id ?? null
}

/**
 * The customer the booking was actually filed against.
 *
 * Read back from the row rather than taken from the form, because the booking endpoint may have matched an
 * existing record under the phone-first identity rule (ADR 0014): deciding a ref conflict against a
 * different id from the one the booking carries would report the same person as a stranger, which is the
 * one answer `ref_conflict` must never produce.
 */
export async function customerIdForBooking(sql: Sql, bookingId: string): Promise<string> {
  const [row] = await sql<{ customer_id: string }[]>`
    select customer_id::text as customer_id from booking where id = ${bookingId}::uuid
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      `Booking ${bookingId} cannot be read back, so a ref capture for it has no customer to decide a ` +
        'conflict against. The caller was handed an id for a row that is not there.',
      { details: { bookingId } },
    )
  }
  return row.customer_id
}
