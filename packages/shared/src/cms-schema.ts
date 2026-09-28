/**
 * The PostgreSQL schema Payload CMS owns.
 *
 * Three places have to agree about this string and none of them can be the source for the other two:
 *
 *   - `apps/web/payload.config.ts` sets it as the adapter's `schemaName`, so that Payload's tables land
 *     outside `public` and `pnpm db:drift` does not compare them against a hand-written Drizzle mirror —
 *     Payload migrates them on its own release cycle.
 *   - `packages/db/src/merge-participants.ts` EXCLUDES it from the catalogue probes the merge registry and
 *     the erasure engine enumerate, because a strategy or an erasure rule cannot be registered on a table
 *     this build does not own.
 *   - `packages/db/migrations/0023_payload_schema.sql` creates the schema and deliberately nothing in it.
 *
 * It lives in `@berelax/shared` rather than in `packages/db` for a reason that is not architectural and is
 * worth writing down so nobody moves it back: `scripts/check-cms-boundary.mjs` imports
 * `apps/web/payload.config.ts` with **Node's strip-only TypeScript loader**, which refuses a TypeScript
 * parameter property — and `packages/db/src/audit.ts` has one (`constructor(private readonly sql: Sql, …)`).
 * So the config importing `@berelax/db` makes that gate fail with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` from a
 * file it has no interest in. `@berelax/shared` has no such syntax anywhere and is already on that import
 * path, so it is the one package both ends can reach.
 */
export const CMS_SCHEMA = 'payload' as const
