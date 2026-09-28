import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle mirrors of the `analytics` schema (migration 0096, A-FIRST-01).
 *
 * SQL-first (ADR 0006); `pnpm db:drift` compares these against the live database in both directions. That
 * gate had to be taught about this schema: it mapped one mirror DIRECTORY to one Postgres schema, so a
 * second schema mirrored from `packages/db/src/schema` would have been attributed to `public` and every
 * table here would have read as drift. It now derives the schema from the `pgSchema(...)` call each table
 * is built on, which is why `analyticsSchema` below is what makes these tables findable rather than
 * decoration.
 *
 * ## Six things the mirror cannot say, and each of them will bite a caller who writes from these
 * definitions instead of reading 0096
 *
 *   1. **`event` and `funnelStep` are RANGE partitioned by month on `occurredAt`,** and the partitions are
 *      created by the `analytics.ensure-partitions` cron. Drizzle has no notion of a partition, so these
 *      read here exactly like ordinary tables.
 *   2. **There is a guarded DEFAULT partition on each of them, and it is permanently empty.** A row whose
 *      month has no partition routes there and is refused with `ZY061` naming the month and the remedy.
 *      This is the only way the refusal could be named: a row is ROUTED before any row-level trigger
 *      fires, so a guard on the parent never runs — tuple routing raises `23514` first. 0096's header has
 *      the measurement.
 *   3. **`event` is append-only.** UPDATE and DELETE raise `ZY065` for every role but `berelax_retention`,
 *      by two BEFORE triggers declared on the partitioned parent and cloned by PostgreSQL onto every
 *      partition — so `delete from analytics.event_2026_09` is refused too. A `db.update(event)` typechecks
 *      perfectly and is refused by the server. `funnelStep` is deliberately NOT append-only: it is
 *      derived, and a corrected derivation has to be able to replace it.
 *   4. **Rows leave this schema through `analytics.run_retention` and nothing else.** The application role
 *      holds no DELETE anywhere here. The pass drops whole partitions of the `raw_partitioned` tables and
 *      deletes rows past the same cutoff from the `raw_row_purge` ones, in `purgeOrder`.
 *   5. **`retentionPolicy` is load-bearing, not documentation.** A base table in this schema with no row
 *      in it stops the retention pass with `ZY062`; a row naming a relation that is not there stops it with
 *      `ZY063`. The three rollups are exempt BY A ROW, and the pass reports the exemption rather than
 *      passing over them in silence.
 *   6. **No customer or booking reference exists here, in any table.** A-FIRST-08 owns attribution onto
 *      `customer` and `booking`, including repointing it to the survivor of a merge. A `customerId` here
 *      would enter C-CRM-05's merge registry and C-CRM-10's erasure catalogue with no unit owning either
 *      decision — and an unclassified column there refuses every customer erasure.
 *
 * Nothing in this build writes a row into any of these tables yet. A-FIRST-05 is the ingest route,
 * A-FIRST-08 the attribution writer and A-FIRST-09 the rollup job; the schema exists first because the
 * partitions and the retention are what make the rest of A-FIRST safe to build.
 */
export const analyticsSchema = pgSchema('analytics')

/**
 * The eight ordered funnel steps, ending at PAID.
 *
 * An enum rather than a CHECK list because the ORDER is the measurement — "conversion is paid / landing,
 * never booking_created / landing" is a statement about which step is last — and `pg_enum.enumsortorder`
 * is the only place a database stores it. A-FIRST-02 pins its own ordered enum against this catalogue
 * rather than restating the list, which is how `whatsappRefCaptureOutcome` is pinned to
 * `REF_CAPTURE_OUTCOMES`.
 */
export const funnelStepName = analyticsSchema.enum('funnel_step_name', [
  'landing',
  'service_viewed',
  'price_viewed',
  'cta_click',
  'booking_created',
  'confirmed',
  'attended',
  'paid',
])

/** One row per first-party visitor cookie, created at consent and never before it (A-FIRST-05). */
export const visitor = analyticsSchema.table(
  'visitor',
  {
    visitorId: uuid('visitor_id').primaryKey().default(sql`public.uuid_generate_v7()`),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    /** Advanced by ingest, and the age retention measures a visitor by. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [check('visitor_last_seen_not_before_first', sql`${t.lastSeenAt} >= ${t.firstSeenAt}`)],
)

/** One row per 30-minute-inactivity session, holding the origination signals AS RECEIVED. */
export const session = analyticsSchema.table(
  'session',
  {
    sessionId: uuid('session_id').primaryKey().default(sql`public.uuid_generate_v7()`),
    /** `on delete cascade` to `visitor`, so the purge never has to decide an order. */
    visitorId: uuid('visitor_id')
      .notNull()
      .references(() => visitor.visitorId, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull(),
    /**
     * The TRADING date, with a real foreign key to `public.business_day`.
     *
     * `business_day` runs 11:00-02:00 Asia/Dubai and crosses midnight, so 01:30 belongs to the PREVIOUS
     * trading date. Resolved by the caller through `resolveTradingDate` from `@berelax/core`; the key is
     * what makes a date the calendar would give but the trading window would not a refused insert rather
     * than a rollup on the wrong day. Declared with raw SQL rather than `.references()` because the
     * referenced table is mirrored in another module and importing it here would couple the two files for
     * a constraint neither of them enforces in TypeScript.
     */
    tradingDate: date('trading_date').notNull(),
    landingPath: text('landing_path').notNull(),
    referrerUrl: text('referrer_url'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmTerm: text('utm_term'),
    utmContent: text('utm_content'),
    /** gclid, fbclid, wbraid, msclkid — verbatim, never case-folded, kept even when a UTM set won. */
    clickIds: jsonb('click_ids').notNull().default({}),
    deviceKind: text('device_kind').notNull(),
    breakpoint: text('breakpoint').notNull(),
    bot: boolean('bot').notNull(),
    /** The classifier's verdict (A-FIRST-04), null exactly when `bot` is false. Never the user agent. */
    botKind: text('bot_kind'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('session_last_event_not_before_start', sql`${t.lastEventAt} >= ${t.startedAt}`),
    check(
      'session_device_kind_known',
      sql`${t.deviceKind} in ('mobile', 'tablet', 'desktop', 'unknown')`,
    ),
    check('session_landing_path_is_a_path', sql`${t.landingPath} like '/%'`),
    check('session_bot_kind_implies_bot', sql`(${t.botKind} is not null) = ${t.bot}`),
    check('session_click_ids_is_an_object', sql`jsonb_typeof(${t.clickIds}) = 'object'`),
    index('session_visitor_idx').on(t.visitorId, t.startedAt.desc()),
    index('session_trading_date_idx').on(t.tradingDate),
    index('session_last_event_idx').on(t.lastEventAt),
  ],
)

/**
 * Raw collected events. Partitioned by month on `occurredAt` and append-only (ZY065).
 *
 * `sessionId` carries NO foreign key and must not: retention drops a partition here and purges a session
 * row on the same window but not in lockstep, and `on delete cascade` from `session` would turn a session
 * purge into a DELETE the ZY065 trigger refuses — two rules that cannot both be satisfied.
 */
export const event = analyticsSchema.table(
  'event',
  {
    eventId: uuid('event_id').notNull().default(sql`public.uuid_generate_v7()`),
    sessionId: uuid('session_id').notNull(),
    /** The partition key. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** When ingest stored it, which a batched beacon flushed on `visibilitychange` makes different. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    /** A-FIRST-02 owns the closed taxonomy; a CHECK list here would be a second copy of it. */
    eventName: text('event_name').notNull(),
    path: text('path').notNull(),
    properties: jsonb('properties').notNull().default({}),
    /** The collector's idempotency key, unique WITH the partition key because PostgreSQL requires it. */
    clientEventId: text('client_event_id').notNull(),
  },
  (t) => [
    unique('event_client_event_id_unique').on(t.clientEventId, t.occurredAt),
    check('event_path_is_a_path', sql`${t.path} like '/%'`),
    check('event_name_not_blank', sql`btrim(${t.eventName}) <> ''`),
    check('event_properties_is_an_object', sql`jsonb_typeof(${t.properties}) = 'object'`),
    index('event_session_idx').on(t.sessionId, t.occurredAt),
    index('event_name_idx').on(t.eventName, t.occurredAt),
  ],
)

/** The materialised funnel (A-FIRST-09). Partitioned by month, and deliberately NOT append-only. */
export const funnelStep = analyticsSchema.table(
  'funnel_step',
  {
    funnelStepId: uuid('funnel_step_id').notNull().default(sql`public.uuid_generate_v7()`),
    sessionId: uuid('session_id').notNull(),
    step: funnelStepName('step').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** Why a step that was reached does not count. A no-show carries one; null means it counts. */
    excludedReason: text('excluded_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'funnel_step_excluded_reason_not_blank',
      sql`${t.excludedReason} is null or btrim(${t.excludedReason}) <> ''`,
    ),
    index('funnel_step_session_idx').on(t.sessionId, t.occurredAt),
    index('funnel_step_step_idx').on(t.step, t.occurredAt),
  ],
)

/** What A-FIRST-03's resolver made of a session's raw signals, with the basis and the version beside it. */
export const attribution = analyticsSchema.table(
  'attribution',
  {
    sessionId: uuid('session_id')
      .primaryKey()
      .references(() => session.sessionId, { onDelete: 'cascade' }),
    /** WHICH precedence rule won: the same tuple reached two ways is different evidence. */
    basis: text('basis').notNull(),
    source: text('source').notNull(),
    medium: text('medium').notNull(),
    campaign: text('campaign').notNull().default(''),
    /** `utm_term`, resolved. Named `term_value` so no hand-written query has to quote it. */
    termValue: text('term_value').notNull().default(''),
    contentValue: text('content_value').notNull().default(''),
    resolverVersion: text('resolver_version').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('attribution_basis_known', sql`${t.basis} in ('utm', 'click_id', 'referrer', 'direct')`),
    check('attribution_source_not_blank', sql`btrim(${t.source}) <> ''`),
    check('attribution_medium_not_blank', sql`btrim(${t.medium}) <> ''`),
    check('attribution_resolver_version_not_blank', sql`btrim(${t.resolverVersion}) <> ''`),
    check(
      'attribution_direct_has_one_spelling',
      sql`${t.basis} <> 'direct' or (${t.source} = 'direct' and ${t.medium} = 'none')`,
    ),
  ],
)

/**
 * The three nightly rollups, kept INDEFINITELY (docs/03, Volume discipline).
 *
 * Every dimension in a primary key is NOT NULL with an empty-string default rather than nullable, and that
 * is a correctness decision: a null never equals a null, so a nullable dimension would let the same
 * campaign-less day upsert a second row every night, and A-FIRST-09's "two runs produce byte-identical
 * rows" depends on it.
 */
export const dailyTraffic = analyticsSchema.table(
  'daily_traffic',
  {
    tradingDate: date('trading_date').notNull(),
    source: text('source').notNull(),
    medium: text('medium').notNull(),
    campaign: text('campaign').notNull().default(''),
    deviceKind: text('device_kind').notNull(),
    sessions: integer('sessions').notNull(),
    visitors: integer('visitors').notNull(),
    botSessions: integer('bot_sessions').notNull(),
    events: integer('events').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'daily_traffic_counts_nonneg',
      sql`${t.sessions} >= 0 and ${t.visitors} >= 0 and ${t.botSessions} >= 0 and ${t.events} >= 0`,
    ),
    /** The bot-filtered share is a percentage OF these sessions; more crawlers than sessions is not one. */
    check('daily_traffic_bots_within_sessions', sql`${t.botSessions} <= ${t.sessions}`),
  ],
)

export const dailyFunnel = analyticsSchema.table(
  'daily_funnel',
  {
    tradingDate: date('trading_date').notNull(),
    step: funnelStepName('step').notNull(),
    source: text('source').notNull(),
    medium: text('medium').notNull(),
    campaign: text('campaign').notNull().default(''),
    entered: integer('entered').notNull(),
    /** Removed from both sides of the show-adjusted rate, and carried beside `entered` rather than
     * subtracted from it so both figures the page shows are readable. */
    excluded: integer('excluded').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('daily_funnel_counts_nonneg', sql`${t.entered} >= 0 and ${t.excluded} >= 0`),
    check('daily_funnel_excluded_within_entered', sql`${t.excluded} <= ${t.entered}`),
  ],
)

export const dailySourceRevenue = analyticsSchema.table(
  'daily_source_revenue',
  {
    tradingDate: date('trading_date').notNull(),
    source: text('source').notNull(),
    medium: text('medium').notNull(),
    campaign: text('campaign').notNull().default(''),
    paidInvoices: integer('paid_invoices').notNull(),
    /**
     * Integer fils, gross VAT-inclusive and authoritative, VAT derived as gross - net (ADR 0007). The
     * `fils` domain and NOT `fils_nonneg`: a day whose credit notes exceed its sales has negative revenue,
     * and refusing that row would be an invented business rule dressed as a type.
     *
     * `bigint({ mode: 'bigint' })` so a figure past 2^53 fils cannot silently lose precision on the way
     * through JavaScript — which is the same reason every other money column in this schema is read as a
     * bigint rather than a number.
     */
    grossFils: bigint('gross_fils', { mode: 'bigint' }).notNull(),
    vatFils: bigint('vat_fils', { mode: 'bigint' }).notNull(),
    netFils: bigint('net_fils', { mode: 'bigint' }).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('daily_source_revenue_paid_invoices_nonneg', sql`${t.paidInvoices} >= 0`),
    /** `net + vat = gross` exactly, as a property of the table rather than of the rollup job. */
    check('daily_source_revenue_vat_reconciles', sql`${t.netFils} + ${t.vatFils} = ${t.grossFils}`),
  ],
)

/**
 * One row per base table in this schema, saying what retention does to it and why.
 *
 * The explicit exemption list, and the list `analytics.run_retention` READS: a table here with no row
 * stops the pass with ZY062 rather than being retained for ever by omission, and a row naming a relation
 * that is not in this schema stops it with ZY063. `ageColumn` and `purgeOrder` are what make the row purge
 * one generic statement rather than a `case` in the function — a branch a new table would not be in, which
 * is a policy row that looks enforced and is a no-op.
 */
export const retentionPolicy = analyticsSchema.table(
  'retention_policy',
  {
    relationName: text('relation_name').primaryKey(),
    policy: text('policy').notNull(),
    ageColumn: text('age_column'),
    purgeOrder: integer('purge_order'),
    reason: text('reason').notNull(),
  },
  (t) => [
    unique('retention_policy_purge_order_unique').on(t.purgeOrder),
    check(
      'retention_policy_known',
      sql`${t.policy} in ('raw_partitioned', 'raw_row_purge', 'keep_indefinitely')`,
    ),
    check(
      'retention_policy_age_column_iff_row_purge',
      sql`(${t.policy} = 'raw_row_purge') = (${t.ageColumn} is not null)`,
    ),
    check(
      'retention_policy_purge_order_iff_row_purge',
      sql`(${t.policy} = 'raw_row_purge') = (${t.purgeOrder} is not null)`,
    ),
    check('retention_policy_reason_not_blank', sql`btrim(${t.reason}) <> ''`),
  ],
)
