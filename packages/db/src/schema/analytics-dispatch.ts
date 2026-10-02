import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { funnelStepName } from './analytics.ts'

/**
 * Drizzle mirrors of the outbound analytics dispatch queue (migration 0125, A-MEAS-02).
 *
 * SQL-first (ADR 0006); `pnpm db:drift` compares these against the live database in both directions.
 *
 * ## Why these two tables are in `public` while the consent record is in `analytics`
 *
 * `analytics_dispatch` is a QUEUE and it behaves like `outbox_event`, which is why A-MEAS-03's own title
 * calls it `analytics_dispatch`. Keeping it out of the `analytics` schema also keeps one claim honest: a
 * base table there needs a `retention_policy` row, and these rows leave with the session they are about by
 * `on delete cascade` — so a `keep_indefinitely` row would be false and a `raw_row_purge` row would
 * declare a purge that the cascade has already done.
 *
 * ## Five things the mirror cannot say
 *
 *   1. **The consent gate is a TRIGGER, and it is the acceptance line.** `assert_dispatch_consent()`
 *      raises `ZY312` on INSERT and on UPDATE when a row would reach `queued` or `sent` for a session that
 *      lacks a signal its destination requires — for every role including the owner. A `db.insert(...)`
 *      with `state: 'queued'` typechecks perfectly and is refused by the server, which is what makes "no
 *      call site can bypass the gate" a fact rather than a convention.
 *   2. **`suppressed` and `cancelled_consent_withdrawn` are deliberately NOT gated.** Those rows are the
 *      record that a dispatch did not go out; refusing to write them would make the suppression silent,
 *      which is the one outcome the table exists to prevent.
 *   3. **A withdrawal is airtight because of 1.** `withdrawAnalyticsConsent` clears the session's four
 *      consent columns and cancels everything still `queued`, so a cancelled row cannot be reinstated and
 *      transmitted afterwards — the trigger refuses it.
 *   4. **`analyticsDispatchDestination` has a CHECK that every destination requires at least one signal.**
 *      A destination requiring none would be permitted for every session including one that answered the
 *      banner with a flat no, and the natural way to add a destination is to copy a row and clear the
 *      flags.
 *   5. **`eventId`, the payload, the attempt counter, the `failed` state and the per-destination unique
 *      index arrived with their producer (migration 0137, A-MEAS-03).** 0125 left them out because a
 *      column with no producer is indistinguishable from one whose producer stopped working; the producer
 *      is `apps/worker/src/jobs/analytics-dispatch.ts`. Two more triggers the mirror cannot say either:
 *      `ZY451` freezes a sent row's event id, payload and transmission instant and refuses it leaving
 *      `sent`, and `ZY452` refuses an attempt counter that decreases.
 */

/**
 * Where a dispatch is in its life.
 *
 * Only `sent` is terminal. `failed` (0137) goes back to `queued` and is re-judged by the ZY312 trigger on
 * the way, so a dispatch that failed while consent was live is refused rather than transmitted after a
 * withdrawal.
 */
export const analyticsDispatchState = pgEnum('analytics_dispatch_state', [
  'queued',
  'sent',
  'suppressed',
  'cancelled_consent_withdrawn',
  'failed',
])

/**
 * Which Consent Mode v2 signals each server-side destination may not act without.
 *
 * Four booleans named one for one against `analytics.session`'s four consent columns, and held equal to
 * `CONSENT_GATED_TARGETS` in `packages/core/src/analytics/consent-gate.ts` in BOTH directions by
 * `packages/fixtures/src/analytics-consent.itest.ts`. It is the second statement of a mapping and it
 * arrives with the check that holds the two equal.
 *
 * A table rather than a `case` inside the trigger, and 0125's header has the reason: a `case` with no
 * `else` yields NULL for an unlisted signal, `not NULL` is NULL, and a trigger whose condition is NULL
 * lets the row through — which is the fail-open an added signal would reach. A table can also be read
 * back; a `case` cannot.
 */
export const analyticsDispatchDestination = pgTable(
  'analytics_dispatch_destination',
  {
    destination: text('destination').primaryKey(),
    requiresAdStorage: boolean('requires_ad_storage').notNull(),
    requiresAdUserData: boolean('requires_ad_user_data').notNull(),
    requiresAdPersonalization: boolean('requires_ad_personalization').notNull(),
    requiresAnalyticsStorage: boolean('requires_analytics_storage').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'analytics_dispatch_destination_requires_something',
      sql`${t.requiresAdStorage} or ${t.requiresAdUserData} or ${t.requiresAdPersonalization} or ${t.requiresAnalyticsStorage}`,
    ),
    check('analytics_dispatch_destination_reason_not_blank', sql`btrim(${t.reason}) <> ''`),
  ],
)

/** The queue itself. See the header for the five things these definitions cannot tell a caller. */
export const analyticsDispatch = pgTable(
  'analytics_dispatch',
  {
    dispatchId: uuid('dispatch_id').primaryKey().default(sql`uuid_generate_v7()`),
    /**
     * The session whose consent state governs this dispatch.
     *
     * `analytics.session (session_id) on delete cascade` in the migration — a real foreign key, and not
     * the plain uuid the append-only logs in 0024 and 0056 use: those records have to OUTLIVE their
     * parent, and a dispatch record about a purged session is a record about nothing, with no state left
     * to say whether it should have gone out.
     *
     * Declared here without `.references()`, which is the arrangement `analytics.session.tradingDate`
     * records for `public.business_day`: the referenced table is mirrored in another module, and
     * importing it for a constraint neither file enforces in TypeScript would couple the two. The same
     * goes for `destination`, whose key is to `analyticsDispatchDestination` one definition up — stated
     * in prose rather than as a `.references()` so the two columns read alike.
     */
    sessionId: uuid('session_id').notNull(),
    destination: text('destination').notNull(),
    /**
     * Which funnel stage this dispatch is about, as 0096's own `analytics.funnel_step_name`.
     *
     * The enum whose ORDER is the measurement and which A-FIRST-02 pins against `FUNNEL_STAGES` in
     * `@berelax/shared`. A second vocabulary of dispatchable events would be a third statement of the
     * funnel, and A-MEAS-01's rule 7 already refuses an event type not derived from it.
     */
    funnelStage: funnelStepName('funnel_stage').notNull(),
    state: analyticsDispatchState('state').notNull(),
    /** `consent_denied` or `consent_withdrawn`. Null exactly when the row is live or sent. */
    reason: text('reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    transmittedAt: timestamp('transmitted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    /**
     * The deduplication identity, shared by the on-page tag and the server push (0137).
     *
     * `analyticsEventId` in `@berelax/analytics` is a pure function of the aggregate kind, the aggregate
     * id and the funnel stage, so both surfaces DERIVE the same value rather than one minting it and
     * telling the other. An offline conversion uploaded two days later has no page to tell.
     */
    eventId: text('event_id').notNull(),
    /** The serialised egress payload that went out, frozen once transmitted (ZY451). */
    payload: jsonb('payload').notNull(),
    /**
     * Where the conversion happened, in the receiving platform's vocabulary (0137).
     *
     * STORED and not derived, because nothing in this schema links an analytics session to the booking it
     * produced — A-FIRST-08 owns attribution and A-FIRST-09 the funnel materialisation — so a consumer
     * that joined the two through anything available today would be joining on nothing. The enqueuer
     * knows: it is the booking or the payment path, and `BOOKING_SOURCE_ACTION_SOURCE` in
     * `@berelax/analytics` maps `booking.source` onto it, total by compilation.
     */
    actionSource: text('action_source').notNull(),
    /**
     * When the conversion HAPPENED, which is not when the gate judged it (`decidedAt`).
     *
     * Two columns and not one, because a platform dates the conversion on this value and every
     * attribution window is measured from it: an offline conversion stamped with the enqueue instant is
     * credited to whatever campaign was running on the night the worker ran.
     */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** Transport attempts so far. Monotonic (ZY452): a reset restarts the backoff for ever. */
    attempts: smallint('attempts').notNull().default(0),
    /** What the transport said last. NOT NULL for `failed`, by CHECK. */
    lastError: text('last_error'),
  },
  (t) => [
    check(
      'analytics_dispatch_reason_known',
      sql`${t.reason} is null or ${t.reason} in ('consent_denied', 'consent_withdrawn', 'transport_failed')`,
    ),
    check(
      'analytics_dispatch_transmitted_iff_sent',
      sql`(${t.state} = 'sent') = (${t.transmittedAt} is not null)`,
    ),
    check(
      'analytics_dispatch_reason_iff_refused',
      sql`(${t.state} in ('suppressed', 'cancelled_consent_withdrawn', 'failed')) = (${t.reason} is not null)`,
    ),
    check(
      'analytics_dispatch_suppression_is_a_denial',
      sql`${t.state} <> 'suppressed' or ${t.reason} = 'consent_denied'`,
    ),
    check(
      'analytics_dispatch_cancellation_is_a_withdrawal',
      sql`${t.state} <> 'cancelled_consent_withdrawn' or ${t.reason} = 'consent_withdrawn'`,
    ),
    // 0137's third sibling, beside the two above rather than folded into them: three narrow rules fail by
    // name, where one alternation fails by saying a row is wrong.
    check(
      'analytics_dispatch_failure_is_a_transport_failure',
      sql`${t.state} <> 'failed' or ${t.reason} = 'transport_failed'`,
    ),
    // A CHECK and not an enum, for the reason 0125 gives about `reason`: the vocabulary is the receiving
    // platform's and this build does not own it, so a fourth value is an ALTER of one constraint rather
    // than a type the whole schema depends on.
    check(
      'analytics_dispatch_action_source_known',
      sql`${t.actionSource} in ('website', 'phone_call', 'physical_store')`,
    ),
    check('analytics_dispatch_occurred_before_decided', sql`${t.occurredAt} <= ${t.decidedAt}`),
    check(
      'analytics_dispatch_outcome_had_an_attempt',
      sql`${t.state} not in ('sent', 'failed') or ${t.attempts} > 0`,
    ),
    check(
      'analytics_dispatch_failure_carries_its_error',
      sql`(${t.state} = 'failed') <= (${t.lastError} is not null)`,
    ),
    index('analytics_dispatch_queued_idx').on(t.sessionId),
    index('analytics_dispatch_state_idx').on(t.state, t.decidedAt.desc()),
    index('analytics_dispatch_due_idx').on(t.decidedAt),
    uniqueIndex('analytics_dispatch_event_destination_unique').on(t.eventId, t.destination),
  ],
)
