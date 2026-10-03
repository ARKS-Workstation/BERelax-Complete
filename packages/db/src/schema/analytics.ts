import { FUNNEL_STAGES } from '@berelax/shared'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
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
/** The wording hash. Same representation as `consent.wordingHash` and the ciphertext columns in 0008. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const analyticsSchema = pgSchema('analytics')

/**
 * The eight ordered funnel steps, ending at PAID — and NOT a list written here.
 *
 * An enum rather than a CHECK list because the ORDER is the measurement: "conversion is paid / landing,
 * never booking_created / landing" is a statement about which step is last, and `pg_enum.enumsortorder` is
 * the only place a database stores an order.
 *
 * The members come from `FUNNEL_STAGES` in `@berelax/shared`, which is the tuple A-FIRST-02 derives its
 * whole vocabulary from. Writing them out again would be a third statement of one fact with no checker over
 * it — `pnpm db:drift` compares tables and columns and has nothing to say about an enum's members. Migration
 * 0096 is the second, unavoidably, because SQL cannot import; `analytics.itest.ts` asserts `pg_enum`'s
 * ordered labels equal this tuple, which is what makes the migration a mirror rather than a second opinion.
 * It is the shape `whatsappRefCaptureOutcome` is pinned to `REF_CAPTURE_OUTCOMES` in.
 */
/**
 * The eight ordered funnel steps, ending at PAID — and NOT a list written here.
 *
 * An enum rather than a CHECK list because the ORDER is the measurement: "conversion is paid / landing,
 * never booking_created / landing" is a statement about which step is last, and `pg_enum.enumsortorder` is
 * the only place a database stores an order.
 *
 * The members come from `FUNNEL_STAGES` in `@berelax/shared`, which is the tuple A-FIRST-02 derives its
 * whole vocabulary from. Writing them out again would be a third statement of one fact with no checker over
 * it — `pnpm db:drift` compares tables and columns and has nothing to say about an enum's members. Migration
 * 0096 is the second, unavoidably, because SQL cannot import; `analytics.itest.ts` asserts `pg_enum`'s
 * ordered labels equal this tuple, which is what makes the migration a mirror rather than a second opinion.
 * It is the shape `whatsappRefCaptureOutcome` is pinned to `REF_CAPTURE_OUTCOMES` in.
 */
export const funnelStepName = analyticsSchema.enum('funnel_step_name', FUNNEL_STAGES)

/** One row per first-party visitor cookie, created at consent and never before it (A-FIRST-05). */
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
    /**
     * Why `tradingDate` is that date (migration 0116, A-FIRST-05).
     *
     * `trading` when `startedAt` fell inside that business day's open window, and otherwise one of
     * `resolveTradingDate`'s three named reasons for an instant that belonged to no trading date at all —
     * filed under the next date the calendar opens. The words come from `TRADING_DATE_BASES` in
     * `@berelax/shared`, which `packages/core/src/analytics/ingest.ts` holds equal to the resolver's own
     * union by a compile-time assertion; this CHECK is the third statement and gate case 144 holds all
     * three equal.
     *
     * A seventh thing the mirror cannot say: `analytics.assert_session_trading_basis` is an AFTER INSERT
     * OR UPDATE trigger that raises `ZY222` when this column disagrees with `public.business_day`'s own
     * `opens_at`/`closes_at`. So `trading` on a session that began at 09:00 is refused by the server even
     * though it typechecks perfectly here.
     */
    tradingDateBasis: text('trading_date_basis').notNull(),
    /**
     * The four Consent Mode v2 signals this session's consent cookie claimed (migration 0125, A-MEAS-02).
     *
     * The column names ARE the external vocabulary, prefixed: the signal names are Google's and not ours,
     * so a different spelling here would produce a store whose consent state could not be handed to the
     * thing it gates. `SESSION_CONSENT_COLUMNS` in `packages/core/src/analytics/consent-gate.ts` is the
     * one place a signal meets a column, and `packages/fixtures/src/analytics-consent.itest.ts` holds
     * those four names against the columns the database actually has.
     *
     * An eighth thing the mirror cannot say: every one of them is `default false` in the migration, and
     * that default is the fail-closed direction. A writer that forgets them suppresses every outbound
     * dispatch and writes a visible suppression row; a default of true would permit one for a visitor who
     * never answered. `.notNull()` without `.default()` here is deliberate — a Drizzle default would
     * invite an insert that omits them, and nothing in this build inserts a session through Drizzle.
     */
    consentAdStorage: boolean('consent_ad_storage').notNull(),
    consentAdUserData: boolean('consent_ad_user_data').notNull(),
    consentAdPersonalization: boolean('consent_ad_personalization').notNull(),
    consentAnalyticsStorage: boolean('consent_analytics_storage').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('session_last_event_not_before_start', sql`${t.lastEventAt} >= ${t.startedAt}`),
    check(
      'session_trading_date_basis_known',
      sql`${t.tradingDateBasis} in ('trading', 'before_opening', 'after_closing', 'premises_closed')`,
    ),
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
    /**
     * Sessions filed under this trading date out of the 02:00-11:00 gap (0150, A-FIRST-09).
     *
     * Read off `analytics.session.trading_date_basis`, which ZY222 holds against `business_day`'s own
     * instants, so this count and the session rows cannot disagree. `Y5-funnel-gap-bucket` is still
     * open; this is what makes the answer re-bucketable instead of lost.
     */
    gapSessions: integer('gap_sessions').notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'daily_traffic_counts_nonneg',
      sql`${t.sessions} >= 0 and ${t.visitors} >= 0 and ${t.botSessions} >= 0 and ${t.events} >= 0`,
    ),
    /** The bot-filtered share is a percentage OF these sessions; more crawlers than sessions is not one. */
    check('daily_traffic_bots_within_sessions', sql`${t.botSessions} <= ${t.sessions}`),
    check(
      'daily_traffic_gap_within_sessions',
      sql`${t.gapSessions} >= 0 and ${t.gapSessions} <= ${t.sessions}`,
    ),
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
    /** `dailyTraffic.gapSessions`' column, per funnel step (0150, A-FIRST-09). */
    gapEntered: integer('gap_entered').notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('daily_funnel_counts_nonneg', sql`${t.entered} >= 0 and ${t.excluded} >= 0`),
    check('daily_funnel_excluded_within_entered', sql`${t.excluded} <= ${t.entered}`),
    check(
      'daily_funnel_gap_within_entered',
      sql`${t.gapEntered} >= 0 and ${t.gapEntered} <= ${t.entered}`,
    ),
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

/**
 * The identifier-free pre-consent landing counter (migration 0116, A-FIRST-05, ADR 0066).
 *
 * The internal store is treated as consent-gated while `Y5-analytics-basis` is open, so `visitor` and
 * `session` are created AT consent and never before it. A visitor who arrives, reads and leaves without
 * answering the banner has still LANDED, and `landing` is the funnel's denominator — so the visit is
 * reduced at the boundary to `+1` against a bucket carrying a business day and a route, and nothing else
 * is written: no visitor, no session, no event row and no `Set-Cookie`.
 *
 * Three things the mirror cannot say, and that a caller writing from these definitions would get wrong:
 *
 *   1. **The reduction is irreversible, deliberately.** There is no key to promote a staged landing by,
 *      because a key before consent is the identifier the position withholds. So nothing here is ever
 *      turned into a session, and consent never arriving needs no purge.
 *   2. **It is monotonic, not append-only.** The increment is the write that has to keep working;
 *      `analytics.refuse_pre_consent_landing_loss` raises `ZY221` for a DELETE, for an UPDATE that lowers
 *      `landings`, and for one that moves a count onto another key. A delete built from these definitions
 *      typechecks perfectly and is refused by the server.
 *   3. **`bucketDate` carries NO foreign key to `public.business_day`,** which is the one place this table
 *      differs from the three rollups. An instant in the daytime gap belongs to no trading date, and the
 *      whole point of this row is that such a visit is counted rather than refused — so the basis says
 *      which kind of date it is instead, and it is IN THE KEY, so the two kinds can never be summed.
 *
 * There is no `createdAt` and no `computedAt`, and their absence is the claim: an instant on a row whose
 * count is 1 is a timestamp of one person's visit, which would make "identifier-free" false. The coarsest
 * thing here is a date, and it is also the finest.
 */
/**
 * The identifier-free pre-consent landing counter (migration 0116, A-FIRST-05, ADR 0066).
 *
 * The internal store is treated as consent-gated while `Y5-analytics-basis` is open, so `visitor` and
 * `session` are created AT consent and never before it. A visitor who arrives, reads and leaves without
 * answering the banner has still LANDED, and `landing` is the funnel's denominator — so the visit is
 * reduced at the boundary to `+1` against a bucket carrying a business day and a route, and nothing else
 * is written: no visitor, no session, no event row and no `Set-Cookie`.
 *
 * Three things the mirror cannot say, and that a caller writing from these definitions would get wrong:
 *
 *   1. **The reduction is irreversible, deliberately.** There is no key to promote a staged landing by,
 *      because a key before consent is the identifier the position withholds. So nothing here is ever
 *      turned into a session, and consent never arriving needs no purge.
 *   2. **It is monotonic, not append-only.** The increment is the write that has to keep working;
 *      `analytics.refuse_pre_consent_landing_loss` raises `ZY221` for a DELETE, for an UPDATE that lowers
 *      `landings`, and for one that moves a count onto another key. A delete built from these definitions
 *      typechecks perfectly and is refused by the server.
 *   3. **`bucketDate` carries NO foreign key to `public.business_day`,** which is the one place this table
 *      differs from the three rollups. An instant in the daytime gap belongs to no trading date, and the
 *      whole point of this row is that such a visit is counted rather than refused — so the basis says
 *      which kind of date it is instead, and it is IN THE KEY, so the two kinds can never be summed.
 *
 * There is no `createdAt` and no `computedAt`, and their absence is the claim: an instant on a row whose
 * count is 1 is a timestamp of one person's visit, which would make "identifier-free" false. The coarsest
 * thing here is a date, and it is also the finest.
 */
export const preConsentLanding = analyticsSchema.table(
  'pre_consent_landing',
  {
    bucketDate: date('bucket_date').notNull(),
    bucketBasis: text('bucket_basis').notNull(),
    path: text('path').notNull(),
    /** `bigint({ mode: 'bigint' })`: a denominator kept indefinitely must not lose precision. */
    landings: bigint('landings', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    primaryKey({
      name: 'pre_consent_landing_pkey',
      columns: [t.bucketDate, t.bucketBasis, t.path],
    }),
    check(
      'pre_consent_landing_basis_known',
      sql`${t.bucketBasis} in ('trading', 'before_opening', 'after_closing', 'premises_closed')`,
    ),
    check('pre_consent_landing_path_is_a_path', sql`${t.path} like '/%'`),
    check('pre_consent_landing_counted_at_least_one', sql`${t.landings} >= 1`),
  ],
)

/**
 * The ref loop per day (0127, A-FIRST-07): codes issued into conversations, and how many came back.
 *
 * A fourth rollup beside `dailyTraffic`, `dailyFunnel` and `dailySourceRevenue`, and NOT rows in
 * `dailyFunnel`, because a code issue is not one of the eight funnel steps, carries no origination tuple
 * and "claimed" is not an `excluded` — A-FIRST-01 deferred the shape to the unit that built the loop.
 *
 * Two things the mirror cannot say:
 *
 *   - **It is RECOMPUTED, never incremented.** `rollUpDailyRefCapture` counts both figures out of
 *     `whatsapp_ref` and `booking_whatsapp_ref_capture` in one statement and upserts the row, so two runs
 *     over the same day produce identical rows and the rollup cannot disagree with the tables it is
 *     derived from. That is the opposite of `preConsentLanding` above, which is a counter with a trigger
 *     refusing a decrease — because there the raw rows are never written at all and the count is the only
 *     evidence, while here both sides are still on disk.
 *   - **`codesClaimed` is paired with the day the CODE was issued**, not the day the booking was taken.
 *     The other pairing mixes cohorts and can exceed the denominator, which is what the
 *     `claimed_within_issued` CHECK refuses.
 */
/**
 * The ref loop per day (0127, A-FIRST-07): codes issued into conversations, and how many came back.
 *
 * A fourth rollup beside `dailyTraffic`, `dailyFunnel` and `dailySourceRevenue`, and NOT rows in
 * `dailyFunnel`, because a code issue is not one of the eight funnel steps, carries no origination tuple
 * and "claimed" is not an `excluded` — A-FIRST-01 deferred the shape to the unit that built the loop.
 *
 * Two things the mirror cannot say:
 *
 *   - **It is RECOMPUTED, never incremented.** `rollUpDailyRefCapture` counts both figures out of
 *     `whatsapp_ref` and `booking_whatsapp_ref_capture` in one statement and upserts the row, so two runs
 *     over the same day produce identical rows and the rollup cannot disagree with the tables it is
 *     derived from. That is the opposite of `preConsentLanding` above, which is a counter with a trigger
 *     refusing a decrease — because there the raw rows are never written at all and the count is the only
 *     evidence, while here both sides are still on disk.
 *   - **`codesClaimed` is paired with the day the CODE was issued**, not the day the booking was taken.
 *     The other pairing mixes cohorts and can exceed the denominator, which is what the
 *     `claimed_within_issued` CHECK refuses.
 */
export const dailyRefCapture = analyticsSchema.table(
  'daily_ref_capture',
  {
    /** Always a date `public.business_day` holds — `fileUnderTradingDate`'s answer. */
    tradingDate: date('trading_date').notNull(),
    /** `analytics.session`'s own column, label for label. In the key (Y5-funnel-gap-bucket). */
    tradingDateBasis: text('trading_date_basis').notNull(),
    /** `bigint({ mode: 'bigint' })`: a denominator kept indefinitely must not lose precision. */
    codesIssued: bigint('codes_issued', { mode: 'bigint' }).notNull(),
    codesClaimed: bigint('codes_claimed', { mode: 'bigint' }).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({
      name: 'daily_ref_capture_pkey',
      columns: [t.tradingDate, t.tradingDateBasis],
    }),
    check(
      'daily_ref_capture_basis_known',
      sql`${t.tradingDateBasis} in ('trading', 'before_opening', 'after_closing', 'premises_closed')`,
    ),
    check('daily_ref_capture_counts_nonneg', sql`${t.codesIssued} >= 0 and ${t.codesClaimed} >= 0`),
    check('daily_ref_capture_claimed_within_issued', sql`${t.codesClaimed} <= ${t.codesIssued}`),
  ],
)
/**
 * The three kinds of analytics consent record (migration 0125, A-MEAS-02).
 *
 * `withdrawn` is a kind rather than an edit, for 0056's reason: a column that could be cleared is a column
 * an UPDATE can un-clear. "Never asked" is the ABSENCE of a row and is never stored — the gate treats it
 * exactly like a denial, which is the same instruction and not the same fact.
 */
export const consentDecision = analyticsSchema.enum('consent_decision', [
  'granted',
  'denied',
  'withdrawn',
])

/**
 * The analytics consent record (migration 0125, A-MEAS-02; docs/04 §8).
 *
 * Four things the mirror cannot say, and each of them will mislead a caller who writes from these
 * definitions rather than reading 0125:
 *
 *   1. **It holds no identifier and names no visitor, deliberately.** There is no `visitorId` column to
 *      forget: the visitor row is created AT consent by `ingestCollectBatch` — "the ONE place the server
 *      decides who owns an identifier" — and does not exist yet when the banner is answered, so a column
 *      here would be a second identifier-minting site. The consequence is stated out loud in 0125's
 *      header: nothing says which visitor made which decision, and the operative state the gate reads is
 *      on `session` instead.
 *   2. **It is append-only.** UPDATE and DELETE raise `ZY311` for every role, the owner and
 *      `berelax_retention` included. A `db.update(consentRecord)` typechecks perfectly and is refused by
 *      the server.
 *   3. **The wording snapshot is checked by 0056's own trigger**, attached to this table rather than
 *      copied: `assert_consent_wording_hash()` raises `ZP002` when `wordingHash` disagrees with the
 *      referenced version's generated `contentHash`.
 *   4. **Its `retention_policy` row says `keep_indefinitely`**, which is honest because the row holds no
 *      identifier — and load-bearing, because `analytics.run_retention` raises `ZY062` for a base table in
 *      this schema with no row at all.
 */
/**
 * The analytics consent record (migration 0125, A-MEAS-02; docs/04 §8).
 *
 * Four things the mirror cannot say, and each of them will mislead a caller who writes from these
 * definitions rather than reading 0125:
 *
 *   1. **It holds no identifier and names no visitor, deliberately.** There is no `visitorId` column to
 *      forget: the visitor row is created AT consent by `ingestCollectBatch` — "the ONE place the server
 *      decides who owns an identifier" — and does not exist yet when the banner is answered, so a column
 *      here would be a second identifier-minting site. The consequence is stated out loud in 0125's
 *      header: nothing says which visitor made which decision, and the operative state the gate reads is
 *      on `session` instead.
 *   2. **It is append-only.** UPDATE and DELETE raise `ZY311` for every role, the owner and
 *      `berelax_retention` included. A `db.update(consentRecord)` typechecks perfectly and is refused by
 *      the server.
 *   3. **The wording snapshot is checked by 0056's own trigger**, attached to this table rather than
 *      copied: `assert_consent_wording_hash()` raises `ZP002` when `wordingHash` disagrees with the
 *      referenced version's generated `contentHash`.
 *   4. **Its `retention_policy` row says `keep_indefinitely`**, which is honest because the row holds no
 *      identifier — and load-bearing, because `analytics.run_retention` raises `ZY062` for a base table in
 *      this schema with no row at all.
 */
export const consentRecord = analyticsSchema.table(
  'consent_record',
  {
    consentRecordId: uuid('consent_record_id').primaryKey().default(sql`public.uuid_generate_v7()`),
    decision: consentDecision('decision').notNull(),
    consentAdStorage: boolean('consent_ad_storage').notNull(),
    consentAdUserData: boolean('consent_ad_user_data').notNull(),
    consentAdPersonalization: boolean('consent_ad_personalization').notNull(),
    consentAnalyticsStorage: boolean('consent_analytics_storage').notNull(),
    /**
     * NOT NULL on both, which is where this table is STRICTER than `public.consent`. That one lets a
     * withdrawal carry no wording, because the realistic withdrawal is somebody telling the receptionist
     * to stop texting them. Every decision here is made by clicking a control on a page that was rendering
     * specific words, so there is always a version.
     */
    consentWordingId: uuid('consent_wording_id').notNull(),
    wordingHash: bytea('wording_hash').notNull(),
    /** When the visitor decided. Supplied, never defaulted; `createdAt` is when the row landed. */
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    captureLocale: text('capture_locale').notNull(),
    captureSurface: text('capture_surface').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'consent_record_grant_grants_something',
      sql`${t.decision} <> 'granted' or ${t.consentAdStorage} or ${t.consentAdUserData} or ${t.consentAdPersonalization} or ${t.consentAnalyticsStorage}`,
    ),
    check(
      'consent_record_refusal_grants_nothing',
      sql`${t.decision} = 'granted' or not (${t.consentAdStorage} or ${t.consentAdUserData} or ${t.consentAdPersonalization} or ${t.consentAnalyticsStorage})`,
    ),
    check('consent_record_locale_known', sql`${t.captureLocale} in ('en', 'ar')`),
    check('consent_record_surface_known', sql`${t.captureSurface} in ('consent_banner')`),
    index('consent_record_decided_idx').on(t.decidedAt.desc()),
  ],
)
