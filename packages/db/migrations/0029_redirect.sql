-- 0029 — catalogue mutation guard rails: archive-never-delete, publish preconditions, and the redirect
--        map that a slug change is not allowed to skip.
--
-- Everything here exists because the person operating the admin screens is a non-technical owner and
-- the engine underneath is not forgiving. Four guard rails, and three of them are the non-obvious
-- choice.
--
-- ## Archive is a column, not a delete
--
-- A service with a future appointment cannot be deleted: `appointment.service_variant_id` is
-- ON DELETE RESTRICT (0024) and `service_variant.service_id` is ON DELETE CASCADE (0017), so a
-- `delete from service` is refused by the grandchild — the price that was quoted survives the menu
-- change. What the owner actually wants is "take it off the menu", and that is `archived_at`.
--
-- Two nullable timestamps rather than a status enum, because they are timestamps: "when did this stop
-- being sold" is the question asked afterwards, and a `status = 'archived'` column cannot answer it.
-- `published_at is not null and archived_at is null` is the one definition of bookable, and the partial
-- index below is what the public menu reads through.
--
-- ## Publishing is refused three specific ways, not one general way
--
-- A service published with no compatibility row resolves to zero bookable rooms; with no resource shape
-- the solver cannot place it; with no priced variant it is a menu item with nothing to charge for. All
-- three present identically to the owner — "the treatment is on the site and nobody can book it" — so
-- each is refused with its own name at the moment of publishing, rather than discovered later as an
-- empty availability grid. They are checked in the database rather than only in the repository because
-- the CMS, the seed and a psql session all write this table.
--
-- ## A slug change without a redirect is refused BY THE DATABASE, and the check is DEFERRED
--
-- `/treatments/asian-normal-massage` is a page that ranks; renaming the slug retires that URL. The
-- redirect is therefore not an afterthought of the rename, it is part of it, and this migration makes
-- that structural: `service_slug_change_keeps_redirects_honest` fires at COMMIT and refuses a
-- transaction that moved a slug without leaving a 301 from the old path to the path the service
-- actually answers on now.
--
-- DEFERRED for the same reason as the room-capacity trigger in 0024 (ADR 0024): the legitimate
-- transaction passes through an invalid state. Between `update service set slug = …` and
-- `insert into redirect_map …` there is no redirect, and an IMMEDIATE trigger would refuse the first
-- statement of the only correct sequence. Deferred, it judges the transaction rather than the statement.
--
-- ## A redirect that lands on a 404 is a 404 with extra steps
--
-- Two ways that happens, and both are closed here.
--
--   1. **A dead target.** A row pointing at `/treatments/<slug>` where no live service has that slug.
--      Refused on write by `assert_redirect_is_one_hop_to_a_live_page`, and refused from the other side
--      by the deferred trigger above — renaming or archiving a service whose path something still
--      points at fails unless those rows were retargeted in the same transaction.
--   2. **A chain.** A -> B written, then B -> C: the first row now points at a path that is itself a
--      redirect, so the old URL costs two hops, and one more rename makes it three. A path is therefore
--      never both a source and a target, which forces the collapse to A -> C at write time (the
--      invariant W-SITE-09's importer inherits) instead of leaving it to a crawler to discover.
--
-- The table is `redirect_map` and not `redirect`: W-SITE-09 imports the legacy WooCommerce URLs into
-- exactly this table under that name and shares this one-hop invariant, and two redirect tables would
-- be two answers to "where does this path go" — resolved, if at all, by whichever middleware ran first.
--
-- ## The lexicon is NOT here
--
-- `public_display_name` is linted against the banned-claims lexicon in
-- `packages/core/src/compliance/lexicon.ts`, reading the term list and the permitted staff titles from
-- `regulatory_profile` (0004, ADR 0020). It is deliberately not a CHECK constraint and not a trigger:
-- the list is versioned DATA that a lawyer's answer changes, and a constraint would freeze today's
-- copy of it into the schema — where a profile change could not reach it, and where the reason a term
-- is refused has nowhere to live. `packages/db/src/repositories/catalogue.ts` is the chokepoint that
-- applies it and refuses to write an unlinted public name at all.

begin;

-- ---------------------------------------------------------------------------------------------
-- service — publication and archival
-- ---------------------------------------------------------------------------------------------
alter table service
  add column published_at timestamptz,
  add column archived_at  timestamptz;

comment on column service.published_at is
  'When the service became publicly bookable. NULL is a draft. Publishing is refused unless the '
  'service has a room-type compatibility row, a resource shape and at least one priced variant — '
  'three named errors, because all three present to the owner as "nobody can book it".';
comment on column service.archived_at is
  'When the service left the menu. Archive rather than delete: a future appointment holds the variant '
  'it was quoted from (0024 ON DELETE RESTRICT), and the prose describing what was sold outlives the '
  'menu. An archived service is never published — see service_archived_is_not_published.';

-- An archived service that is still published is a menu item the site renders and the solver refuses,
-- which reads as a booking system that is broken rather than as a service that was withdrawn.
alter table service
  add constraint service_archived_is_not_published
  check (archived_at is null or published_at is null);

comment on constraint service_archived_is_not_published on service is
  'Archiving withdraws publication in the same statement. Without this, "is this on the menu?" has two '
  'answers and the site and the availability solver each pick a different one.';

-- The public menu's read, and the one definition of bookable. Partial, so an archived or draft service
-- is absent from the index rather than filtered out of it.
create index service_bookable_idx on service (display_order, id)
  where published_at is not null and archived_at is null;

-- ---------------------------------------------------------------------------------------------
-- redirect_map — one hop, to a page that exists
-- ---------------------------------------------------------------------------------------------
create table redirect_map (
  id          uuid        primary key default uuid_generate_v7(),
  -- The retired path. UNIQUE because a path with two redirects has no answer, and which one a
  -- middleware returned would depend on row order.
  source_path text        not null unique,
  target_path text        not null,
  -- 301 by default; 308 exists for a non-GET path that must keep its method. Nothing temporary: a 302
  -- on a permanent rename asks every crawler to keep the old URL, which is the opposite of the point.
  status_code smallint    not null default 301,
  -- Why this row exists, in words — 'slug change', 'WooCommerce baseline'. A redirect nobody can
  -- account for is one nobody dares delete, and the map then only ever grows.
  reason      text        not null,
  created_by  text        not null default 'system',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint redirect_map_source_path_absolute check (source_path ~ '^/[a-z0-9][a-z0-9/-]*$'),
  constraint redirect_map_target_path_absolute check (target_path ~ '^/[a-z0-9][a-z0-9/-]*$'),
  -- A row pointing at itself is an infinite redirect. The browser reports it as "too many redirects",
  -- which names the symptom and not this row.
  constraint redirect_map_not_self check (source_path <> target_path),
  constraint redirect_map_status_permanent check (status_code in (301, 308)),
  constraint redirect_map_reason_nonempty check (btrim(reason) <> '')
);

comment on table redirect_map is
  'Permanent redirects, one hop each, to a path that resolves. Owned by B-CAT-05 for slug changes and '
  'archival; W-SITE-09 imports the legacy WooCommerce URLs into the same table and inherits the '
  'one-hop invariant. Not append-only: a rename retargets existing rows, which is what keeps them '
  'one hop.';
comment on column redirect_map.source_path is
  'The retired path, e.g. /treatments/asian-normal-massage. UNIQUE: two rows for one path is two '
  'answers.';
comment on column redirect_map.target_path is
  'Where it goes now. Must not itself be a source_path (that is a second hop) and, when it names a '
  'treatment page, must name a service that exists and is not archived.';

create trigger redirect_map_updated_at before update on redirect_map
  for each row execute function set_updated_at();

-- Middleware resolves by source_path (covered by the unique index); this one answers the other
-- direction, which every retarget and every dead-target check asks: "what still points here?".
create index redirect_map_target_path_idx on redirect_map (target_path);

-- ---------------------------------------------------------------------------------------------
-- The treatment path, in one place
-- ---------------------------------------------------------------------------------------------
-- `/treatments/<slug>` is built by packages/db/src/repositories/catalogue.ts as well, because
-- packages/db has to write these rows. Two spellings of one prefix is a redirect that silently stops
-- matching, so the pair is asserted against each other in
-- packages/db/src/repositories/catalogue.itest.ts: the TypeScript helper builds a path and this
-- function is what decides whether the database accepts it.
create function treatment_path(p_slug text) returns text
language sql
immutable
as $$ select '/treatments/' || p_slug $$;

comment on function treatment_path(text) is
  'The public path of a service, from its slug. The single spelling of the prefix on the SQL side; '
  'packages/db mirrors it and the itest asserts the two agree.';

-- The slug a treatment path names, or NULL for a path that is not a treatment page.
create function treatment_path_slug(p_path text) returns text
language sql
immutable
as $$ select substring(p_path from '^/treatments/([a-z0-9]+(?:-[a-z0-9]+)*)$') $$;

comment on function treatment_path_slug(text) is
  'The slug inside a /treatments/<slug> path, or NULL. NULL is what exempts every other target — the '
  'treatments index, a landing page, a legacy WooCommerce URL — from the live-service check, since '
  'this schema cannot know what resolves outside the catalogue.';

-- ---------------------------------------------------------------------------------------------
-- A redirect is one hop, and it lands somewhere
-- ---------------------------------------------------------------------------------------------
create function assert_redirect_is_one_hop_to_a_live_page() returns trigger
language plpgsql
as $$
declare
  v_slug  text;
  v_other text;
begin
  -- Hop 2, from the target end: the destination is itself retired. `r.id <> new.id` matters on an
  -- UPDATE: retargeting a row onto its own source is a self-redirect, and the constraint that says so
  -- is `redirect_map_not_self`. Without the exclusion this branch reports it as a chain — which sent
  -- the first reader looking for a second row that was never there.
  select r.target_path into v_other
    from redirect_map r
   where r.source_path = new.target_path
     and r.id <> new.id
   limit 1;
  if v_other is not null then
    raise exception
      'redirect_chain_not_collapsed: % -> %, but % already redirects to %. Point the new row at '
      'the final destination instead: a chain costs a hop per rename and crawlers stop following.',
      new.source_path, new.target_path, new.target_path, v_other
      using errcode = 'ZC006';
  end if;

  -- Hop 2, from the source end: something already points at the path this row retires, so following
  -- it would arrive at a redirect. Retarget those rows first — that is the collapse.
  select r.source_path into v_other
    from redirect_map r
   where r.target_path = new.source_path
     and r.id <> new.id
   limit 1;
  if v_other is not null then
    raise exception
      'redirect_chain_not_collapsed: % still points at %, which this row retires. Retarget it to % '
      'in the same transaction.',
      v_other, new.source_path, new.target_path
      using errcode = 'ZC006';
  end if;

  -- A redirect FROM a page that still answers never fires: the live service wins, so the row is dead
  -- weight in a table W-SITE-09's coverage gate walks — and it becomes a loop the day anything resolves
  -- redirects before services. Renaming a service back to a slug it used to have is how this arrives,
  -- and `renameServiceSlug` releases the row rather than leaving it.
  v_slug := treatment_path_slug(new.source_path);
  if v_slug is not null
     and exists (select 1 from service s where s.slug = v_slug and s.archived_at is null) then
    raise exception
      'redirect_source_still_live: % is a live treatment page, so a redirect from it can never fire. '
      'Delete the row instead: the page answers for itself.',
      new.source_path
      using errcode = 'ZC007';
  end if;

  -- A treatment target must name a service that exists and is still on the menu. Any other target is
  -- out of this schema's knowledge and deliberately unchecked; W-SITE-09's coverage gate walks those.
  v_slug := treatment_path_slug(new.target_path);
  if v_slug is not null
     and not exists (select 1 from service s where s.slug = v_slug and s.archived_at is null) then
    raise exception
      'redirect_target_unresolved: % points at %, which no live service answers on. A redirect to a '
      '404 is a 404 with extra steps.',
      new.source_path, new.target_path
      using errcode = 'ZC005';
  end if;

  return new;
end $$;

comment on function assert_redirect_is_one_hop_to_a_live_page() is
  'Raises ZC006 for a chain, ZC007 for a redirect from a page that still answers, and ZC005 for a dead '
  'treatment target. Checked on the row being written; '
  'the mirror image — a rename or archival that kills a target other rows point at — is the deferred '
  'trigger on service.';

create trigger redirect_map_one_hop
  before insert or update on redirect_map
  for each row execute function assert_redirect_is_one_hop_to_a_live_page();

-- ---------------------------------------------------------------------------------------------
-- A slug change leaves a working redirect. Checked at COMMIT.
-- ---------------------------------------------------------------------------------------------
create function assert_slug_change_left_a_working_redirect() returns trigger
language plpgsql
as $$
declare
  v_current text;
  v_old     text;
  v_dead    text;
begin
  -- The path the service answers on AS THE TRANSACTION LEAVES IT, not the value this particular
  -- UPDATE wrote. Two renames in one transaction (A -> B -> C) must leave A -> C, not A -> B: the
  -- intermediate path never existed publicly, and a redirect to it would be a hop to nowhere.
  select treatment_path(s.slug) into v_current from service s where s.id = new.id;
  -- Deleted later in the same transaction. The delete trigger below is what judges that case.
  if v_current is null then
    return null;
  end if;
  v_old := treatment_path(old.slug);

  if old.slug is distinct from new.slug
     and not exists (
       select 1 from redirect_map r
        where r.source_path = v_old and r.target_path = v_current
     ) then
    raise exception
      'slug_change_without_redirect: % is now % with no 301 from the old path. The old URL is '
      'indexed and linked from confirmations; renaming without the redirect retires it silently.',
      v_old, v_current
      using errcode = 'ZC004';
  end if;

  -- Something still points at a path this service no longer answers on.
  if v_old <> v_current then
    select r.source_path into v_dead
      from redirect_map r where r.target_path = v_old limit 1;
    if v_dead is not null then
      raise exception
        'redirect_target_unresolved: % still points at %, which this rename retired. Retarget it to '
        '% in the same transaction.',
        v_dead, v_old, v_current
        using errcode = 'ZC005';
    end if;
  end if;

  -- Archiving retires the path just as surely as a rename does. An archived service 301s to the
  -- treatments index (W-SITE-05), so a row pointing at its path would cost two hops at best.
  if new.archived_at is not null then
    select r.source_path into v_dead
      from redirect_map r where r.target_path = v_current limit 1;
    if v_dead is not null then
      raise exception
        'redirect_target_unresolved: % points at %, which is archived. Retarget it to the treatments '
        'index in the same transaction.',
        v_dead, v_current
        using errcode = 'ZC005';
    end if;
  end if;

  return null;
end $$;

comment on function assert_slug_change_left_a_working_redirect() is
  'Raises ZC004 for a rename with no 301 and ZC005 for a redirect left pointing at a retired path. '
  'Reads the service''s CURRENT slug, so two renames in one transaction must collapse to one hop.';

-- DEFERRED, like the room-capacity trigger of 0024 and for the same reason: the correct sequence
-- (update the slug, retarget what pointed at it, insert the new 301) is invalid in the middle. An
-- IMMEDIATE version would refuse the first statement of the only transaction that gets this right.
create constraint trigger service_slug_change_keeps_redirects_honest
  after update of slug, archived_at on service
  deferrable initially deferred
  for each row execute function assert_slug_change_left_a_working_redirect();

create function assert_delete_left_no_dead_redirect() returns trigger
language plpgsql
as $$
declare
  v_dead text;
begin
  select r.source_path into v_dead
    from redirect_map r where r.target_path = treatment_path(old.slug) limit 1;
  if v_dead is not null then
    raise exception
      'redirect_target_unresolved: % points at %, which was deleted. Archive the service instead, or '
      'retarget the redirect in the same transaction.',
      v_dead, treatment_path(old.slug)
      using errcode = 'ZC005';
  end if;
  return null;
end $$;

comment on function assert_delete_left_no_dead_redirect() is
  'Raises ZC005. A deleted service takes its page with it; a row still pointing there is a 404 with '
  'extra steps. Deferred, so a transaction may delete the service and retarget the rows in any order.';

create constraint trigger service_delete_keeps_redirects_honest
  after delete on service
  deferrable initially deferred
  for each row execute function assert_delete_left_no_dead_redirect();

-- ---------------------------------------------------------------------------------------------
-- Publishing: three preconditions, three names
-- ---------------------------------------------------------------------------------------------
create function assert_service_publishable() returns trigger
language plpgsql
as $$
begin
  -- A draft is unconstrained: the three preconditions are what publishing means, not what existing
  -- means, and B-CAT-06 seeds a catalogue that is priced after it is inserted.
  if new.published_at is null then
    return new;
  end if;
  -- Only the transition, so an unrelated UPDATE of a published row — a display order, a turnaround —
  -- is not re-validated. A published service that has since lost its last variant is a different
  -- problem (and a delete of that variant is what should be refused), and re-checking here would
  -- refuse the very edit that fixes it.
  if tg_op = 'UPDATE' then
    if old.published_at is not distinct from new.published_at then
      return new;
    end if;
  end if;

  -- No compatibility row: 0012 says which room types may deliver which service, so a service with
  -- none resolves to zero bookable rooms and reads as "no availability" for ever.
  if not exists (
    select 1 from service_room_type_compat c
     where c.service_style = new.style and c.service_treatment_key = new.treatment_key
  ) then
    raise exception
      'service_publish_without_compat_row: %/% may not be delivered in any room type. Availability '
      'would be empty on every date rather than refused at publication.',
      new.style, new.treatment_key
      using errcode = 'ZC001';
  end if;

  -- No resource shape: the solver reads therapists_required, rooms_required, the minimum capacity and
  -- the therapist buffer from it. With no row it cannot place the appointment at all.
  if not exists (
    select 1 from service_resource_shape sh
     where sh.service_style = new.style and sh.service_treatment_key = new.treatment_key
  ) then
    raise exception
      'service_publish_without_resource_shape: %/% has no resource shape, so nothing states how many '
      'therapists or rooms one delivery needs.',
      new.style, new.treatment_key
      using errcode = 'ZC002';
  end if;

  -- No priced variant: a menu item with no price. `service_variant_price_positive` already refuses a
  -- zero, so the predicate is about EXISTENCE — spelled with the price anyway, because "priced" is the
  -- precondition and a later pricing model must not satisfy this by inserting a row with no figure.
  if not exists (
    select 1 from service_variant v
     where v.service_id = new.id and v.gross_price_fils > 0
  ) then
    raise exception
      'service_publish_without_priced_variant: %/% has no priced duration. It would render on the '
      'menu with nothing to charge, and a booking would snapshot no price.',
      new.style, new.treatment_key
      using errcode = 'ZC003';
  end if;

  return new;
end $$;

comment on function assert_service_publishable() is
  'Raises ZC001 (no compatibility row), ZC002 (no resource shape) or ZC003 (no priced variant) when '
  'published_at is set. Three names, because all three present to the owner as "it is on the site and '
  'nobody can book it".';

create trigger service_publishable
  before insert or update of published_at on service
  for each row execute function assert_service_publishable();

commit;
