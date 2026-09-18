-- 0020 — reviews: the two day-one data-model decisions from docs/10 §6, made before anything reads them.
--
-- Business Profile API access is granted by application review, not by enabling an API, and the wait is
-- measured in weeks. The business launches once. So the fallback — a pasted or forwarded review — is the
-- launch mode, and the two shapes below are what make it first-class rather than retrofitted:
--
--   1. `google_review_id` is NULLABLE. A pasted review has none, because Google's own notification email
--      does not carry it. Make the column NOT NULL and the paste form cannot exist; make it nullable and
--      plainly unique with `nulls not distinct` (which 0016 uses elsewhere) and two pasted reviews collide
--      on NULL. Hence a PARTIAL unique index: uniqueness applies to the rows that actually have an id.
--   2. `delivery_mode` is a real column, so `submitted_at`/`confirmed_at` (the reply went to the API and
--      Google acknowledged it) and `posted_manually_at` (the owner pasted the reply and clicked "Marked
--      as posted") coexist. One overloaded `posted_at` reads identically in both modes and therefore
--      cannot answer the only question anybody asks of it afterwards — did WE send this, or did a human
--      say they did. It also has no room for the API's two-step acknowledgement.
--
-- docs/10 §6: "Get either wrong and you are writing a migration in week three."
--
-- Two further decisions this file makes, both of them about a wrong shape that looks harmless:
--
--   - A star-only review stores `comment_text` NULL, never the empty string, enforced by a check. Those
--     reviews are common (docs/10 §7) and `= ''` versus `IS NULL` is two representations of one fact:
--     the linter, the router and the generator would each have to remember both, and one of them will not.
--   - Every row carries `connection_id` AND `place_id`, and a trigger refuses a `place_id` that is not a
--     registered `gbp_reviews` resource of that connection. Cross-contamination between two connections
--     managing two listings cannot be prevented by a query filter written correctly every time.

begin;

create table google_reviews (
  id                    uuid        primary key default uuid_generate_v7(),
  -- ON DELETE RESTRICT, deliberately. Disconnecting Google is a status change on the connection
  -- (`status='disconnected'`), never a row delete; a review with a drafted reply is a business record and
  -- a cascade would take the queue and its drafts with it silently. A loud refusal is the better failure.
  connection_id         uuid        not null references google_connections(id) on delete restrict,
  -- The listing the review is on, denormalised from the connection's gbp_reviews capability
  -- (resource_ref->>'placeId'). Denormalised on purpose: the deep link the owner follows, and the queue
  -- scoping, must keep working after a capability row is re-pointed, and a review is evidence about the
  -- listing it was actually left on.
  place_id              text        not null,
  -- NULLABLE. Decision 1 above. A pasted review has no id until reconciliation backfills one.
  google_review_id      text,
  -- The payload's updateTime. With google_review_id it is the at-least-once idempotency key: Pub/Sub
  -- delivery is at-least-once (docs/10 §7), so the same notification arrives twice and the second one
  -- must change nothing rather than append a second queue row and a second audit trail.
  google_update_time    timestamptz,
  -- How we learned about it. 'api' is the only one that can carry a google_review_id at insert time.
  source                text        not null check (source in ('api','email_parse','paste','manual')),
  -- Decision 2 above. NOT NULL with no default: the intake path knows which mode it is, and a default
  -- would let a future caller not decide and be read as if it had.
  delivery_mode         text        not null check (delivery_mode in ('api','manual')),
  rating                smallint    not null check (rating between 1 and 5),
  -- NULL for a star-only review, and never ''. See the header.
  comment_text          text        check (comment_text is null or length(btrim(comment_text)) > 0),
  -- Google's display name for the reviewer, verbatim — frequently 'A Google user'. Stored because
  -- reconciliation matches a pasted row to an API row on reviewer name + rating + date, and there is
  -- nothing else to match on.
  reviewer_display_name text        not null,
  -- When the reviewer left it, as opposed to when we found out. Reconciliation matches on the date part
  -- of this in a named zone, never in the server's zone.
  reviewed_at           timestamptz not null,
  -- The generated reply awaiting approval. Reconciliation must not touch it: the draft is the work.
  reply_draft           text,
  -- Delivery, api mode: submitted to the API, then acknowledged by Google.
  submitted_at          timestamptz,
  confirmed_at          timestamptz,
  -- Delivery, manual mode: the owner posted it themselves and said so.
  posted_manually_at    timestamptz,
  -- When a manual row was matched to an API id. Distinct from created_at: it records that this row's
  -- google_review_id arrived later, which is why an id can be present on a row whose source is 'paste'.
  reconciled_at         timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- Mutually exclusive per row, which is the whole point of having a mode column rather than a
  -- convention. `else false` so that adding a third mode without deciding its delivery fields fails here
  -- rather than inheriting "no rules".
  constraint google_reviews_delivery_fields_match_mode check (
    case delivery_mode
      when 'api'    then posted_manually_at is null
      when 'manual' then submitted_at is null and confirmed_at is null
      else false
    end
  ),
  -- An acknowledgement of something never submitted is not a state the system can be in.
  constraint google_reviews_confirmed_needs_submitted check (
    confirmed_at is null or submitted_at is not null
  ),
  -- An updateTime with no review id is half an idempotency key, and half a key deduplicates nothing.
  constraint google_reviews_update_time_needs_id check (
    google_update_time is null or google_review_id is not null
  ),
  -- Reconciliation is precisely the act of acquiring an id.
  constraint google_reviews_reconciled_needs_id check (
    reconciled_at is null or google_review_id is not null
  )
);

comment on table google_reviews is
  'One row per review on the Google listing, however we learned about it. google_review_id is nullable '
  'because a pasted review has none (docs/10 SS6 decision 1), and delivery_mode is a column so the API '
  'and manual delivery timestamps coexist instead of overloading one posted_at (decision 2).';
comment on column google_reviews.google_review_id is
  'Nullable. NULL until an API row arrives or reconciliation backfills it. Unique only among non-null.';
comment on column google_reviews.delivery_mode is
  'api | manual. Which delivery timestamps are meaningful on this row, enforced by a check constraint.';
comment on column google_reviews.comment_text is
  'NULL for a star-only review, never an empty string — one fact, one representation.';

-- Decision 1, the half a nullable column alone does not give you: at most one row per real Google review,
-- and no constraint at all on the rows that have no id.
create unique index google_reviews_google_review_id_key
  on google_reviews (google_review_id)
  where google_review_id is not null;

-- The queue read: one listing of one connection, newest first. Scoped by BOTH columns because that is the
-- query that must never return another connection's rows.
create index google_reviews_queue_idx
  on google_reviews (connection_id, place_id, reviewed_at desc);

-- Reconciliation reads only the rows still missing an id, and matches on rating and date. Partial, so the
-- backfill cost does not grow with the reviews already matched.
create index google_reviews_unmatched_idx
  on google_reviews (connection_id, rating, reviewed_at)
  where google_review_id is null;

create trigger google_reviews_updated_at before update on google_reviews
  for each row execute function set_updated_at();

-- A review's place_id must be a gbp_reviews resource of its own connection.
--
-- The failure this prevents: two connections exist, because the account owning the listing is not the
-- account verified on the site (docs/10 §2). A queue query that forgets one of the two scoping columns,
-- or an intake path that takes the place_id from configuration rather than from the connection, files one
-- listing's review under the other's connection — and the reply is then posted to the wrong business. A
-- filter cannot prevent that, because the row is already wrong by the time any filter runs.
--
-- This works in fallback mode: the capability row exists with health='permission_missing' and carries the
-- placeId (that is what the docs/10 §6 tripwire deep link is built from), so the trigger does not require
-- API access — only that somebody said which listing this connection manages.
create or replace function assert_review_place_belongs_to_connection() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from google_capabilities
    where connection_id = new.connection_id
      and capability = 'gbp_reviews'
      and resource_ref ->> 'placeId' = new.place_id
  ) then
    raise exception
      'place_id % is not a gbp_reviews resource of connection %', new.place_id, new.connection_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

create trigger google_reviews_place_belongs_to_connection
  before insert or update of connection_id, place_id on google_reviews
  for each row execute function assert_review_place_belongs_to_connection();

commit;
