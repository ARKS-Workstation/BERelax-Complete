import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * First-touch and last-touch attribution: the writes, the resolution and the coverage read (A-FIRST-08),
 * over migration 0149.
 *
 * ## What this module is for
 *
 * `analytics.attribution` (0096) answers "what originated THIS session" and is purged with the session
 * at ninety days. This module answers the two questions that have to outlive it — where did this
 * CUSTOMER come from, and what produced THIS BOOKING — by copying the values out of the analytics store
 * onto `customer_attribution` and `booking_attribution`.
 *
 * ## The selection is in SQL and the RULE is in `@berelax/core`
 *
 * `packages/db` may not import `packages/core` (ADR 0001), so the ordering that picks the first and the
 * last touch is written here as `order by … limit 1` and stated again as `firstTouchOf` and
 * `lastTouchBeforeOf` in `packages/core/src/analytics/attribution.ts`. That is a fact said twice, which
 * the brief says drifts — so the check that holds the two equal ships in the same commit:
 * `packages/fixtures/src/attribution-rule.itest.ts` reads the candidate touches out of a real database,
 * applies the pure rule to them in TypeScript, and asserts the answer equals the row these statements
 * wrote. `packages/fixtures` may depend on both, which is what makes it the right home for it.
 *
 * The ordering is TOTAL in both places — the instant, then the session's own id — because two sessions
 * of one visitor can share a `started_at` to the millisecond, and without a tie-break the answer would
 * depend on the order PostgreSQL happened to return the rows in. A-FIRST-08's acceptance line replays
 * the same sessions shuffled and asserts one answer.
 *
 * ## A bot-flagged session is NOT excluded here, and that is deliberate
 *
 * ADR 0062's rule is that the classifier's verdict is STORED and never acted on, and the one unit the
 * exclusion was deferred to is A-FIRST-09's funnel, which counts traffic. Attribution is about a
 * session that produced a BOOKING. `analytics.visitor` exists only at consent (ADR 0066) and a crawler
 * does not answer a consent banner, so a `bot` flag under a consented visitor is a classifier false
 * positive — and dropping that session would silently move the customer's first touch. Acting on the
 * verdict here would make this the first place in the build that did.
 *
 * ## There is no consent branch here either
 *
 * A session exists only because a visitor consented (ADR 0066), so reading one is reading a decision
 * that has already been made. `dispatch_consent_gap` (0125) is what decides whether a conversion may be
 * PUSHED to an ad platform, and a second gate here would be the defect A-MEAS-02 was built to prevent
 * (ADR 0076, ADR 0091): an internal attribution row and an outbound push are different permissions.
 */

/**
 * The two refusals migration 0149 adds, so a caller can branch on the RULE rather than on prose.
 *
 * Spelled here and nowhere else: a code is an identity (ADR 0043), and a second literal of one in
 * another module makes the registry entry's translator list wrong.
 */
export const ATTRIBUTION_SQLSTATE = {
  firstTouchIsWriteOnce: 'ZY691',
  lastTouchPrecedesBooking: 'ZY692',
} as const

export const ATTRIBUTION_REFUSALS = [
  'first_touch_is_write_once',
  'last_touch_postdates_its_booking',
] as const
export type AttributionRefusal = (typeof ATTRIBUTION_REFUSALS)[number]

/** The refusal a thrown error carries, or `null` when it is not one of this schema's. */
export function attributionRefusalOf(error: unknown): AttributionRefusal | null {
  const code = (error as { code?: unknown } | null)?.code
  if (code === ATTRIBUTION_SQLSTATE.firstTouchIsWriteOnce) return 'first_touch_is_write_once'
  if (code === ATTRIBUTION_SQLSTATE.lastTouchPrecedesBooking) {
    return 'last_touch_postdates_its_booking'
  }
  return null
}

/** One stored attribution row, in either table. */
export interface AttributionRow {
  readonly basis: string
  readonly source: string
  readonly medium: string
  readonly campaign: string
  readonly sessionReference: string | null
  readonly howHeard: string | null
  readonly occurredAtIso: string
  readonly recordedAtIso: string
}

/** A candidate touch read out of the analytics store, before anything has chosen between them. */
export interface SessionTouch {
  readonly sessionReference: string
  readonly basis: string
  readonly source: string
  readonly medium: string
  readonly campaign: string
  readonly startedAtIso: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertTradingDate(tradingDate: string): void {
  if (ISO_DATE.test(tradingDate)) return
  throw new AppError(
    'validation',
    `An attribution read was asked for trading date ${JSON.stringify(tradingDate)}, which is not a ` +
      'YYYY-MM-DD date. Trading runs 11:00-02:00, so an instant cast to a date here moves every late ' +
      'sale onto the wrong day and its attribution with it.',
    { details: { tradingDate } },
  )
}

/**
 * Every session of the VISITOR that owns the named session, with the origination each was resolved to.
 *
 * The visitor and not the customer, because `analytics` holds no customer id — deliberately, and
 * A-FIRST-01, A-FIRST-05 and A-FIRST-07 each recorded the same decision. The one link from a booking
 * into the analytics store is the session reference the booking path carries, and the visitor behind it
 * is what turns one session into the person's whole history.
 *
 * An INNER join to `analytics.attribution`: a session with no resolved origination contributes no touch,
 * because nothing decided one. Writing `direct` for it here would be the absence of an origination
 * recorded as an origination, which is `OriginationDecision`'s own distinction one layer down.
 */
export async function sessionTouchesForVisitorOf(
  sql: Sql,
  sessionReference: string,
): Promise<readonly SessionTouch[]> {
  const rows = await sql<
    {
      session_id: string
      basis: string
      source: string
      medium: string
      campaign: string
      started_at: Date
    }[]
  >`
    select s.session_id::text as session_id,
           a.basis,
           a.source,
           a.medium,
           a.campaign,
           s.started_at
      from analytics.session s
      join analytics.attribution a on a.session_id = s.session_id
     where s.visitor_id = (
             select v.visitor_id from analytics.session v where v.session_id = ${sessionReference}::uuid
           )
     order by s.started_at, s.session_id
  `
  return rows.map((row) => ({
    sessionReference: row.session_id,
    basis: row.basis,
    source: row.source,
    medium: row.medium,
    campaign: row.campaign,
    startedAtIso: row.started_at.toISOString(),
  }))
}

/**
 * The session a desk booking was attributed to through its WhatsApp ref code, or null.
 *
 * `booking_whatsapp_ref_capture.attributed_session_id` (0127) is non-null for `matched` alone and is
 * refused by ZY332 when it is not the code's own session — so this is the one join in the build that
 * attributes a booking nobody saw a browser make, and it is unfakeable rather than conventional.
 * A-FIRST-07 built it for exactly this reader.
 */
export async function refCaptureSessionForBooking(
  sql: Sql,
  bookingId: string,
): Promise<string | null> {
  const rows = await sql<{ attributed_session_id: string }[]>`
    select attributed_session_id::text as attributed_session_id
      from booking_whatsapp_ref_capture
     where booking_id = ${bookingId}::uuid
       and attributed_session_id is not null
     limit 1
  `
  return rows[0]?.attributed_session_id ?? null
}

export interface RecordAttributionInput {
  readonly bookingId: string
  readonly customerId: string
  /**
   * The analytics session this booking came through, when the booking path knows one.
   *
   * Absent for a walk-in, a telephone booking and a front-desk booking, which is the case the offline
   * fallback exists for. Supplied by an online booking, and resolved from
   * `booking_whatsapp_ref_capture` when a desk booking carried a ref code.
   */
  readonly sessionReference?: string | null
  /** What the front desk was told. Stored only for an offline touch, and a blank is not an answer. */
  readonly howHeard?: string | null
  /**
   * The writer's instant, injected — every ordering assertion in this area is made under a frozen
   * clock.
   *
   * Absent means "this transaction's own instant", read by the DATABASE as `now()` and not by a clock
   * in TypeScript. That is what `createBooking` passes, and it is not a loophole in the injection
   * discipline: `now()` inside a transaction is the transaction's start instant, which is the same
   * instant `booking.created_at` defaulted to, so ZY692 cannot refuse the row for a skew nobody can
   * see in the code.
   */
  readonly recordedAtIso?: string
}

export interface RecordedAttribution {
  readonly booking: AttributionRow
  readonly firstTouch: AttributionRow
  /** How many of the visitor's sessions were candidates. Zero for an offline booking. */
  readonly candidates: number
}

/**
 * Writes both claims for one booking, inside whatever transaction the caller is in.
 *
 * Called from `createBooking` in the booking transaction, so a booking cannot exist without its
 * attribution — which is what makes `booking_attribution.source` NOT NULL a statement about the build
 * rather than about one table. The alternative was an outbox handler, and it is worse here for the
 * reason 0137 gives about a cron: a handler that had not run yet is indistinguishable from a booking
 * nobody could attribute, and the figure that reads is attribution coverage.
 *
 * The first touch is an UPSERT whose `do update` fires only for an EARLIER claim, so it converges: three
 * sessions replayed in any order leave the earliest on the row, and a re-run writes nothing. ZY691
 * refuses the other direction for every role, so the convergence is the schema's and not this
 * statement's.
 */
export async function recordBookingAttribution(
  sql: Sql,
  input: RecordAttributionInput,
): Promise<RecordedAttribution> {
  const named =
    input.sessionReference ?? (await refCaptureSessionForBooking(sql, input.bookingId)) ?? null
  const candidates = named === null ? [] : await sessionTouchesForVisitorOf(sql, named)

  const booking = await writeBookingAttribution(sql, input, named, candidates.length > 0)
  const firstTouch = await writeFirstTouch(sql, input, named, candidates.length > 0)
  return { booking, firstTouch, candidates: candidates.length }
}

/**
 * The booking's LAST touch, or the offline fallback.
 *
 * `started_at <= b.created_at` is the whole claim and it is in the statement rather than in a parameter:
 * a session that began after the booking cannot have produced it, and the page a customer lands on next
 * is usually the confirmation — so the wrong answer is self-reinforcing. ZY692 refuses a row that
 * breaks it whichever call site writes it.
 *
 * The offline branch takes `occurred_at` from `booking.created_at` in the statement rather than from the
 * caller's instant. A caller's clock and the row's own `created_at` can differ by the length of the
 * transaction, and ZY692 compares against the row — so a caller-supplied instant would be refused for a
 * reason nobody could see in the code.
 */
async function writeBookingAttribution(
  sql: Sql,
  input: RecordAttributionInput,
  named: string | null,
  hasCandidates: boolean,
): Promise<AttributionRow> {
  const howHeard = (input.howHeard ?? '').trim()
  const rows = await sql<
    {
      basis: string
      source: string
      medium: string
      campaign: string
      session_reference: string | null
      how_heard: string | null
      occurred_at: Date
      recorded_at: Date
    }[]
  >`
    insert into booking_attribution
      (booking_id, basis, source, medium, campaign, session_reference, how_heard,
       occurred_at, recorded_at)
    select b.id,
           coalesce(t.basis, 'offline'),
           coalesce(t.source, 'offline'),
           coalesce(t.medium, 'direct'),
           coalesce(t.campaign, ''),
           t.session_id,
           case when t.session_id is null and ${howHeard} <> '' then ${howHeard} end,
           coalesce(t.started_at, b.created_at),
           coalesce(${input.recordedAtIso ?? null}::timestamptz, now())
      from booking b
      left join lateral (
        select s.session_id, a.basis, a.source, a.medium, a.campaign, s.started_at
          from analytics.session s
          join analytics.attribution a on a.session_id = s.session_id
         where ${hasCandidates}::boolean
           and s.visitor_id = (
                 select v.visitor_id from analytics.session v
                  where v.session_id = ${named}::uuid
               )
           -- The bound. A later session never overwrites the touch that produced the booking.
           and s.started_at <= b.created_at
         -- Total, for the reason the pure rule's comparator is: two sessions of one visitor can share a
         -- started_at to the millisecond, and without the tie-break the answer depends on row order.
         order by s.started_at desc, s.session_id desc
         limit 1
      ) t on true
     where b.id = ${input.bookingId}::uuid
    on conflict (booking_id) do update
       set basis             = excluded.basis,
           source            = excluded.source,
           medium            = excluded.medium,
           campaign          = excluded.campaign,
           session_reference = excluded.session_reference,
           how_heard         = excluded.how_heard,
           occurred_at       = excluded.occurred_at,
           recorded_at       = excluded.recorded_at
    returning basis, source, medium, campaign, session_reference::text as session_reference,
              how_heard, occurred_at, recorded_at
  `
  const row = rows[0]
  if (row === undefined) {
    throw new AppError(
      'not_found',
      `Booking ${input.bookingId} does not exist, so no attribution row was written. A caller that ` +
        'swallowed this would leave a booking with no source, and a booking with no source is counted ' +
        'as unattributed by every coverage figure rather than as an error.',
      { details: { bookingId: input.bookingId } },
    )
  }
  return rowToAttribution(row)
}

/**
 * The customer's FIRST touch.
 *
 * The earliest of the visitor's sessions, or the booking's own instant for an offline customer. The
 * `where` on the `do update` is what makes this write-once: a later claim changes nothing, which is why
 * replaying sessions in any order converges, and an EARLIER one replaces the row, which is the only
 * replacement ZY691 permits.
 */
async function writeFirstTouch(
  sql: Sql,
  input: RecordAttributionInput,
  named: string | null,
  hasCandidates: boolean,
): Promise<AttributionRow> {
  const howHeard = (input.howHeard ?? '').trim()
  const rows = await sql<
    {
      basis: string
      source: string
      medium: string
      campaign: string
      session_reference: string | null
      how_heard: string | null
      occurred_at: Date
      recorded_at: Date
    }[]
  >`
    insert into customer_attribution
      (customer_id, basis, source, medium, campaign, session_reference, how_heard,
       occurred_at, recorded_at)
    select b.customer_id,
           coalesce(t.basis, 'offline'),
           coalesce(t.source, 'offline'),
           coalesce(t.medium, 'direct'),
           coalesce(t.campaign, ''),
           t.session_id,
           case when t.session_id is null and ${howHeard} <> '' then ${howHeard} end,
           coalesce(t.started_at, b.created_at),
           coalesce(${input.recordedAtIso ?? null}::timestamptz, now())
      from booking b
      left join lateral (
        select s.session_id, a.basis, a.source, a.medium, a.campaign, s.started_at
          from analytics.session s
          join analytics.attribution a on a.session_id = s.session_id
         where ${hasCandidates}::boolean
           and s.visitor_id = (
                 select v.visitor_id from analytics.session v
                  where v.session_id = ${named}::uuid
               )
         -- EARLIEST, and total on the session id for the tie-break's reason.
         order by s.started_at, s.session_id
         limit 1
      ) t on true
     where b.id = ${input.bookingId}::uuid
    on conflict (customer_id) do update
       set basis             = excluded.basis,
           source            = excluded.source,
           medium            = excluded.medium,
           campaign          = excluded.campaign,
           session_reference = excluded.session_reference,
           how_heard         = excluded.how_heard,
           occurred_at       = excluded.occurred_at,
           recorded_at       = excluded.recorded_at
     where excluded.occurred_at < customer_attribution.occurred_at
    returning basis, source, medium, campaign, session_reference::text as session_reference,
              how_heard, occurred_at, recorded_at
  `
  const written = rows[0]
  if (written !== undefined) return rowToAttribution(written)
  // The `do update … where` discarded the write because the stored claim is earlier or equal. That is
  // the ordinary case for a returning customer and not a failure, so the stored row is read back and
  // returned — a caller that received `undefined` here would read it as "no first touch on file".
  const stored = await readFirstTouch(sql, input.customerId)
  if (stored === null) {
    throw new AppError(
      'invariant_violated',
      `The first touch for customer ${input.customerId} was neither written nor already on file. The ` +
        'upsert above has no other outcome, so this is an ON CONFLICT arbiter that no longer matches ' +
        "customer_attribution's primary key.",
      { details: { customerId: input.customerId } },
    )
  }
  return stored
}

function rowToAttribution(row: {
  basis: string
  source: string
  medium: string
  campaign: string
  session_reference: string | null
  how_heard: string | null
  occurred_at: Date
  recorded_at: Date
}): AttributionRow {
  return {
    basis: row.basis,
    source: row.source,
    medium: row.medium,
    campaign: row.campaign,
    sessionReference: row.session_reference,
    howHeard: row.how_heard,
    occurredAtIso: row.occurred_at.toISOString(),
    recordedAtIso: row.recorded_at.toISOString(),
  }
}

export async function readFirstTouch(sql: Sql, customerId: string): Promise<AttributionRow | null> {
  const rows = await sql<
    {
      basis: string
      source: string
      medium: string
      campaign: string
      session_reference: string | null
      how_heard: string | null
      occurred_at: Date
      recorded_at: Date
    }[]
  >`
    select basis, source, medium, campaign, session_reference::text as session_reference,
           how_heard, occurred_at, recorded_at
      from customer_attribution
     where customer_id = ${customerId}::uuid
  `
  const row = rows[0]
  return row === undefined ? null : rowToAttribution(row)
}

export async function readBookingAttribution(
  sql: Sql,
  bookingId: string,
): Promise<AttributionRow | null> {
  const rows = await sql<
    {
      basis: string
      source: string
      medium: string
      campaign: string
      session_reference: string | null
      how_heard: string | null
      occurred_at: Date
      recorded_at: Date
    }[]
  >`
    select basis, source, medium, campaign, session_reference::text as session_reference,
           how_heard, occurred_at, recorded_at
      from booking_attribution
     where booking_id = ${bookingId}::uuid
  `
  const row = rows[0]
  return row === undefined ? null : rowToAttribution(row)
}

/**
 * The analytics session a till conversion belongs to — the resolver A-MEAS-03 and A-MEAS-05 were given
 * as an injected seam, now that there is something behind it.
 *
 * ADR 0091 and ADR 0092 both record why neither of those units chose one: *"a session picked here would
 * push a conversion under somebody else's consent decision, which the ZY312 gate cannot catch because
 * the session it was handed really did grant everything."* This answer is not a choice — it is the
 * session the booking's own last touch names, written by the booking transaction that produced it.
 *
 * `null` for a booking with no attributed session, which is every walk-in and every telephone booking.
 * That is the honest answer and the pass counts it, exactly as it counted the shipped resolver's
 * refusals: "no conversions were uploaded" has to read as *these conversions had no session* rather
 * than as *there were none*.
 */
export async function attributedSessionForBooking(
  sql: Sql,
  bookingId: string,
): Promise<string | null> {
  const rows = await sql<{ session_reference: string }[]>`
    select session_reference::text as session_reference
      from booking_attribution
     where booking_id = ${bookingId}::uuid
       and session_reference is not null
  `
  return rows[0]?.session_reference ?? null
}

/**
 * The source of every PAID booking on a trading date, for the coverage figure.
 *
 * "Paid" is a fact in the LEDGER and not in analytics: a booking counts here when an invoice covering one
 * of its appointments is settled in full — `invoice_settlement.outstanding_fils <= 0`, which is exactly
 * the quantity ZT001 refuses to let go negative, so this read and the till cannot disagree about whether
 * a document is paid. A funnel that counted its own idea of paid would disagree with the invoice the
 * moment a refund landed.
 *
 * The grain is the BOOKING, reached through `appointment.booking_id` rather than through
 * `invoice.booking_id` — the column is nullable (a document may be raised with no booking behind it) and
 * the appointment's is not, so the nullable one would silently drop exactly the documents somebody
 * raised by hand.
 *
 * A paid booking with NO attribution row contributes `unknown`, not nothing. Dropping it would shrink
 * the denominator by exactly the bookings nobody attributed, and the coverage figure would then rise
 * towards 100% as the attribution got worse.
 */
export async function paidBookingAttributionSources(
  sql: Sql,
  query: { readonly tradingDate: string },
): Promise<readonly string[]> {
  assertTradingDate(query.tradingDate)
  const rows = await sql<{ source: string }[]>`
    select coalesce(ba.source, 'unknown') as source
      from appointment a
      join invoice_appointment ia on ia.appointment_id = a.id
      join invoice i             on i.id = ia.invoice_id
      join invoice_settlement st on st.invoice_id = i.id
      left join booking_attribution ba on ba.booking_id = a.booking_id
     where a.trading_date = ${query.tradingDate}::date
       and st.outstanding_fils <= 0
     group by a.booking_id, ba.source
     order by a.booking_id
  `
  return rows.map((row) => row.source)
}
