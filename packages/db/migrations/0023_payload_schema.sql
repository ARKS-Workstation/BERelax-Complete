-- 0023 — the schema Payload owns.
--
-- This migration creates a schema and deliberately creates nothing in it.
--
-- Payload CMS v3 runs inside the same Next.js application on the same PostgreSQL (ADR 0019), and it
-- brings its own migration tooling on its own release cycle: an upgrade from 3.x to 3.y can add a
-- column to `payload_locked_documents` without asking us. Our migrations are SQL-first and hand-written
-- (ADR 0006) and their Drizzle mirrors are compared against the live database in BOTH directions by
-- `pnpm db:drift`. Those two facts are incompatible in one schema: a table Payload created in `public`
-- has no mirror, so drift reports it as `Database has table "public.pages" with no Drizzle mirror` and
-- the build fails looking like a forgotten migration on somebody else's branch.
--
-- pg-boss has exactly this shape and is handled exactly this way — it owns `pgboss`, migrates itself,
-- and `apps/worker/src/worker.itest.ts` asserts that the drift checker's schema list excludes it. The
-- equivalent assertion for this schema is in `apps/web/src/payload.itest.ts`, alongside one that
-- Payload actually put its tables here and none in `public`.
--
-- So why create the schema at all, rather than letting Payload's adapter do it on first boot?
--
--   * A deployment whose database role cannot create a schema fails HERE, in the migration step, with
--     a clear error — rather than at first admin request, which is a 500 on a page with no logs the
--     owner can read.
--   * The comment below is the only place the ownership boundary is written down in the database
--     itself, and `psql \dn+` is where somebody looks when they are wondering what `payload` is.
--   * It makes the schema part of the numbered chain, so `pnpm db:migrate:dry` proves it can be
--     created on a clean database before a deploy rather than after.

begin;

create schema if not exists payload;

comment on schema payload is
  'Owned and migrated by Payload CMS v3, not by this migration chain (ADR 0019). No table here has a '
  'Drizzle mirror and pnpm db:drift deliberately does not compare this schema — see 0023 and '
  'apps/web/src/payload.itest.ts. Nothing outside apps/web may write to these tables: the CMS is '
  'reached through Payload''s Local API so its hooks, access control, versioning and audit trail run.';

-- The CMS references the catalogue (`public.service`, B-CAT-03) and the employee record by UUID, in a
-- plain text column, with NO foreign key. That is a decision and not an oversight, and this is the
-- place a DBA will look for the reason:
--
--   * the two schemas are migrated on separate cycles, so a foreign key makes each deployable only
--     with the other;
--   * a catalogue migration that rewrites `service` would be blocked by CMS rows, at 23:00, by a
--     constraint nobody was thinking about;
--   * the rule that actually matters — a treatment narrative with future bookings cannot be
--     unpublished or deleted — is not expressible as a foreign key in either direction. It needs a
--     count of future bookings and a message an editor can act on, which is
--     `packages/cms/src/lifecycle.ts`.
--
-- `apps/web/src/payload.itest.ts` asserts that no foreign key crosses from `payload` into `public`, so
-- the absence is checked rather than merely intended.

commit;
