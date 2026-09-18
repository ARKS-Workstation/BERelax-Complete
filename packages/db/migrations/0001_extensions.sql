-- 0001 — required extensions.
--
-- btree_gist is load-bearing: the no-double-booking guarantee is an EXCLUDE USING gist
-- constraint combining equality on therapist_id with overlap on a tstzrange, and gist cannot
-- index the scalar equality without it. Proven in packages/db/src/postgres.itest.ts.

create extension if not exists btree_gist;   -- exclusion constraints over (scalar, range)
create extension if not exists pgcrypto;     -- gen_random_uuid, digest
create extension if not exists pg_trgm;      -- fuzzy customer search / duplicate detection
create extension if not exists unaccent;     -- accent-insensitive search

-- Guard rail: fail the migration loudly if any extension is missing rather than discovering it
-- when a constraint cannot be created three migrations later.
do $$
declare missing text;
begin
  select string_agg(e, ', ')
    into missing
  from unnest(array['btree_gist','pgcrypto','pg_trgm','unaccent']) as e
  where not exists (select 1 from pg_extension where extname = e);

  if missing is not null then
    raise exception 'Required extensions not installed: %', missing;
  end if;
end $$;
