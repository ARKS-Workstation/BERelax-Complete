-- 0002 — conventions shared by every later migration.
--
-- These exist so the rules in docs/01-scope-and-decisions.md are enforced by the database rather
-- than remembered by whoever writes the next migration.

-- UUIDv7 is time-ordered, so it indexes like a sequence while remaining unguessable. Postgres 16
-- has no built-in generator, so this builds one: 48-bit big-endian millisecond timestamp, version
-- 7, variant bits, remainder random.
create or replace function uuid_generate_v7()
returns uuid
language plpgsql
volatile
as $$
declare
  unix_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  bytes   bytea  := gen_random_bytes(16);
begin
  -- bytes 0..5: timestamp, big endian
  bytes := set_byte(bytes, 0, ((unix_ms >> 40) & 255)::int);
  bytes := set_byte(bytes, 1, ((unix_ms >> 32) & 255)::int);
  bytes := set_byte(bytes, 2, ((unix_ms >> 24) & 255)::int);
  bytes := set_byte(bytes, 3, ((unix_ms >> 16) & 255)::int);
  bytes := set_byte(bytes, 4, ((unix_ms >>  8) & 255)::int);
  bytes := set_byte(bytes, 5, ( unix_ms        & 255)::int);
  -- byte 6 high nibble: version 7
  bytes := set_byte(bytes, 6, ((get_byte(bytes, 6) & 15) | 112));
  -- byte 8 high bits: RFC 4122 variant
  bytes := set_byte(bytes, 8, ((get_byte(bytes, 8) & 63) | 128));
  return encode(bytes, 'hex')::uuid;
end $$;

comment on function uuid_generate_v7() is
  'Time-ordered UUIDv7. Preferred over v4 for primary keys: same unguessability, far better index locality.';

-- Money. Stored as integer minor units (fils) and VAT-INCLUSIVE GROSS, per docs/01 decision 7.
-- A domain is used rather than plain bigint so the intent is visible in every table definition and
-- a negative amount cannot be stored where it is meaningless.
create domain fils as bigint;
comment on domain fils is
  'AED minor units (1 AED = 100 fils). Integer only — never a float. Gross, VAT-inclusive, per docs/01 decision 7.';

create domain fils_nonneg as bigint check (value >= 0);
comment on domain fils_nonneg is 'Non-negative AED minor units. Use where a negative amount is meaningless.';

-- Standard mutation-tracking trigger, so updated_at cannot be forgotten or faked by the caller.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Singletons (legal_entity, premises) are enforced declaratively with a fixed primary key:
--   id smallint primary key generated always as identity check (id = 1)
-- A check constraint cannot be bypassed, needs no trigger, and states the intent in the schema.
-- See 0003_identity.sql.
