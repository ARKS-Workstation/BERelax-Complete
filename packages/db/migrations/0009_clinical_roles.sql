-- 0009 — database roles, least privilege.
--
-- Volume encryption on DO Managed Postgres protects a stolen disk. It does nothing against an
-- attacker holding a valid application credential, which is the realistic case: an SQL injection or
-- a leaked connection string. Separate roles are what make the clinical schema unreadable to the
-- application role, so the blast radius of an application compromise excludes health data.
--
-- Roles are created idempotently because a managed database may already have them and a migration
-- must never fail on a re-run.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'berelax_app') then
    create role berelax_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'berelax_clinical') then
    create role berelax_clinical nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'berelax_readonly') then
    create role berelax_readonly nologin;
  end if;
end $$;

-- The application role: everything EXCEPT the clinical schema.
grant usage on schema public to berelax_app;
grant select, insert, update, delete on all tables in schema public to berelax_app;
grant usage, select on all sequences in schema public to berelax_app;
alter default privileges in schema public
  grant select, insert, update, delete on tables to berelax_app;
alter default privileges in schema public grant usage, select on sequences to berelax_app;

-- Explicit and load-bearing: the application role cannot even enter the clinical schema.
revoke all on schema clinical from berelax_app;

-- The clinical role: the clinical schema, plus read on public so it can resolve a customer id.
grant usage on schema clinical to berelax_clinical;
grant select, insert, update on all tables in schema clinical to berelax_clinical;
grant usage, select on all sequences in schema clinical to berelax_clinical;
alter default privileges in schema clinical
  grant select, insert, update on tables to berelax_clinical;
grant usage on schema public to berelax_clinical;
grant select on all tables in schema public to berelax_clinical;

-- No DELETE on treatment_note: a clinical record is corrected by superseding it, never erased.
revoke delete on all tables in schema clinical from berelax_clinical;

-- Reporting: public only, read only, and never the clinical schema.
grant usage on schema public to berelax_readonly;
grant select on all tables in schema public to berelax_readonly;
alter default privileges in schema public grant select on tables to berelax_readonly;
revoke all on schema clinical from berelax_readonly;

/**
 * The bridge.
 *
 * The booking layer needs contraindication booleans and must never touch the clinical schema. A
 * SECURITY DEFINER view owned by a privileged role exposes exactly those columns — no free text, no
 * diagnosis, no submission payload — so the application role gets what it needs and nothing else.
 */
create or replace view public.customer_contraindication_flags
  with (security_invoker = false) as
  select customer_id,
         pregnancy,
         recent_surgery,
         cardiovascular,
         skin_condition,
         requires_consultation,
         updated_at
  from clinical.contraindication_flag;

comment on view public.customer_contraindication_flags is
  'The ONLY path from the application to clinical data. Booleans only. security_invoker = false so '
  'the application role reads it without holding any privilege on the clinical schema.';

grant select on public.customer_contraindication_flags to berelax_app;
