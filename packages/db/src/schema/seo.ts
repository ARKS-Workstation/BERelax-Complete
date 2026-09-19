import { sql } from 'drizzle-orm'
import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle mirror of the Search Console warehouse (migration 0042).
 *
 * Hand-written because migrations are SQL-first (ADR 0006); `pnpm db:drift` compares this against the
 * live database in both directions, which is what catches a column added in SQL and forgotten here.
 *
 * Three shapes here look wrong and are deliberate:
 *
 *   - **`rareQueryClicks` and `rareQueryImpressions` are GENERATED in the database.** Drizzle declares
 *     them as ordinary columns because the drift check compares names and presence; what matters is that
 *     nothing in this package ever writes them. PostgreSQL refuses an INSERT that tries (SQLSTATE
 *     428C9), which is the actual guarantee — see `seo-warehouse.ts`.
 *   - **`avgPositionCenti` is an integer**, not a float. Average position × 100. A float average read
 *     back differs in the last digit between two runs of one report, and the weekly report has to diff
 *     cleanly.
 *   - **`date` is a calendar UTC date, not a `business_day` trading date.** Every other date in this
 *     system that belongs to a trading day resolves on `business_day` (trading runs 11:00–02:00, so
 *     01:30 belongs to the previous trading date). This one is Google's own day, because it is the join
 *     key between the warehouse and the Search Console UI the owner compares it against. The 0042 header
 *     carries the full argument.
 */

export const seoGscDaily = pgTable(
  'seo_gsc_daily',
  {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    /** `sc-domain:example.com` or `https://example.com/` — two different properties, two datasets. */
    siteUrl: text('site_url').notNull(),
    /** Google's calendar date in UTC. Not a trading date. */
    date: date('date').notNull(),
    page: text('page').notNull(),
    /** Never a placeholder: a withheld rare query does not arrive at all. */
    query: text('query').notNull(),
    /** DESKTOP | MOBILE | TABLET, uncontrained on purpose — see the migration. */
    device: text('device').notNull(),
    /** ISO 3166-1 alpha-3 lower case, or Google's own `zzz` for undetermined. */
    country: text('country').notNull(),
    clicks: integer('clicks').notNull(),
    impressions: integer('impressions').notNull(),
    /** Average position × 100. Integer, so a report diffs byte for byte. */
    avgPositionCenti: integer('avg_position_centi').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('seo_gsc_daily_dimensions_unique').on(
      t.siteUrl,
      t.date,
      t.page,
      t.query,
      t.device,
      t.country,
    ),
    index('seo_gsc_daily_site_date_idx').on(t.siteUrl, t.date),
  ],
)

export const seoGscSnapshot = pgTable(
  'seo_gsc_snapshot',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    siteUrl: text('site_url').notNull(),
    /** The requested window, in Google's calendar UTC dates. `windowEnd` is `today - 3`. */
    windowStart: date('window_start').notNull(),
    windowEnd: date('window_end').notNull(),
    /** The instant the pass ran, injected — not `created_at`, which is when the row was written. */
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    pagesFetched: integer('pages_fetched').notNull(),
    rowLimit: integer('row_limit').notNull(),
    lastStartRow: integer('last_start_row').notNull(),
    rowsPersisted: integer('rows_persisted').notNull(),
    queryClicks: bigint('query_clicks', { mode: 'number' }).notNull(),
    queryImpressions: bigint('query_impressions', { mode: 'number' }).notNull(),
    pageClicks: bigint('page_clicks', { mode: 'number' }).notNull(),
    pageImpressions: bigint('page_impressions', { mode: 'number' }).notNull(),
    /** GENERATED in the database as `page_clicks - query_clicks`. Never written from here. */
    rareQueryClicks: bigint('rare_query_clicks', { mode: 'number' }).notNull(),
    /** GENERATED in the database as `page_impressions - query_impressions`. */
    rareQueryImpressions: bigint('rare_query_impressions', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('seo_gsc_snapshot_window_unique').on(t.siteUrl, t.windowStart, t.windowEnd),
    index('seo_gsc_snapshot_site_window_idx').on(t.siteUrl, t.windowEnd),
  ],
)

export const seoUrlInspection = pgTable(
  'seo_url_inspection',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    siteUrl: text('site_url').notNull(),
    url: text('url').notNull(),
    /** Lower sorts first. The tie-break after "least recently inspected". */
    priority: integer('priority').notNull(),
    /** The rotation cursor. NULL means never inspected, and NULLS FIRST is the coverage guarantee. */
    lastInspectedAt: timestamp('last_inspected_at', { withTimezone: true }),
    inspections: integer('inspections').notNull(),
    /** PASS | PARTIAL | FAIL | NEUTRAL | VERDICT_UNSPECIFIED, as the API documents it. */
    verdict: text('verdict'),
    /** Google's prose ("Crawled - currently not indexed"). Not ours to close. */
    coverageState: text('coverage_state'),
    lastCrawledAt: timestamp('last_crawled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('seo_url_inspection_url_unique').on(t.siteUrl, t.url),
    index('seo_url_inspection_rotation_idx').on(t.siteUrl, t.lastInspectedAt, t.priority, t.url),
  ],
)

export const seoUrlInspectionRun = pgTable(
  'seo_url_inspection_run',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    siteUrl: text('site_url').notNull(),
    /** Google's calendar UTC date: the day its quota resets on. */
    runDate: date('run_date').notNull(),
    dailyCap: integer('daily_cap').notNull(),
    inspected: integer('inspected').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('seo_url_inspection_run_unique').on(t.siteUrl, t.runDate)],
)
