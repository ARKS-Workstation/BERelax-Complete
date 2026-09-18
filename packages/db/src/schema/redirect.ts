import { sql } from 'drizzle-orm'
import { check, index, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Drizzle mirror of `packages/db/migrations/0029_redirect.sql`.
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`.
 */

/**
 * Permanent redirects: one hop each, to a path that resolves.
 *
 * Written by B-CAT-05 whenever a slug changes or a service is archived, and imported into by
 * W-SITE-09 for the legacy WooCommerce URLs — which is why it is `redirect_map` rather than
 * `redirect`. Two redirect tables would be two answers to "where does this path go", settled by
 * whichever middleware happened to run first.
 *
 * ## The three guarantees that are not expressible here
 *
 * All three live in the migration as triggers, because all three are questions about *other rows*:
 *
 *   - `redirect_map_one_hop` (ZC006) refuses a chain. A path is never both a `source_path` and a
 *     `target_path`: A → B followed by B → C must be collapsed to A → C at write time, or the first
 *     URL costs two hops and the next rename makes it three.
 *   - the same trigger (ZC005) refuses a dead `/treatments/<slug>` target — no service, or an archived
 *     one. A redirect to a 404 is a 404 with extra steps.
 *   - `service_slug_change_keeps_redirects_honest` (ZC004/ZC005) closes it from the other side: a
 *     rename with no 301, or a rename that leaves a row pointing at the retired path, is refused at
 *     COMMIT. Deferred, because the correct sequence is invalid in the middle.
 *
 * `packages/db/src/repositories/catalogue.itest.ts` bounces a fixture off each of them by SQLSTATE,
 * and `scripts/test-gates.mjs` does it again by constraint and rule name.
 */
export const redirectMap = pgTable(
  'redirect_map',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** The retired path, e.g. `/treatments/asian-normal-massage`. Unique: two rows is two answers. */
    sourcePath: text('source_path').notNull().unique(),
    targetPath: text('target_path').notNull(),
    /** 301, or 308 where a non-GET must keep its method. Never a 302 on a permanent rename. */
    statusCode: smallint('status_code').notNull(),
    /** 'slug change', 'archived', 'WooCommerce baseline'. A redirect nobody can account for is one nobody dares delete. */
    reason: text('reason').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    /** Not append-only: a later rename retargets this row, which is exactly what keeps it one hop. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // Middleware resolves by source_path through the unique index; this answers the other direction,
    // which every retarget and every dead-target check asks: what still points here?
    index('redirect_map_target_path_idx').on(t.targetPath),
    check('redirect_map_source_path_absolute', sql`${t.sourcePath} ~ '^/[a-z0-9][a-z0-9/-]*$'`),
    check('redirect_map_target_path_absolute', sql`${t.targetPath} ~ '^/[a-z0-9][a-z0-9/-]*$'`),
    // A row pointing at itself is an infinite redirect, reported by the browser as "too many
    // redirects" — which names the symptom and not the row.
    check('redirect_map_not_self', sql`${t.sourcePath} <> ${t.targetPath}`),
    check('redirect_map_status_permanent', sql`${t.statusCode} in (301, 308)`),
    check('redirect_map_reason_nonempty', sql`btrim(${t.reason}) <> ''`),
  ],
)
