-- 0094 — the fallback intake: the forwarded email that could not be read, and the Places aggregate the
-- count tripwire compares against. Plus the two `agent_definition` rows its crons report to.
--
-- ## Why a migration at all, when G-REV-01 already gave reviews a table
--
-- Because neither of the two things this unit has to remember is a review.
--
--   1. **A forwarded notification that could not be parsed is not a review.** It has no rating, so it could
--      not satisfy `google_reviews.rating` (NOT NULL, 1-5), and inventing one to make it fit is precisely
--      the guess docs/12 §1 forbids — a review filed at four stars that was actually one star is auto-send
--      eligible under docs/07 §4 row 1. It is a **job for a person**: ninety seconds with the paste form
--      (docs/10 §6). The row that holds it therefore holds the bytes and nothing interpreted.
--   2. **An aggregate reading is not a review either.** It is two numbers about the listing, and the whole
--      value of it is that yesterday's numbers are still there to compare against. A column on
--      `google_capabilities` would hold today's and lose the comparison, which is the only thing the
--      reading is for.
--
-- G-REV-02's manifest `files` list names no migration, and this file is the answer to the question that
-- list invites: G-REV-01's tables were checked first, and `google_reviews` cannot hold either shape.
--
-- ## What this file deliberately does NOT add
--
-- **No private SQLSTATE.** The convention that a private class identifies one file has one class left
-- (`ZZ`), and W-SYS-12 owns replacing the convention with an allocator. So the refusals here are ordinary
-- `check_violation`s and the ones that need a name are raised in application code as named errors —
-- `PLACES_ANSWERED_ABOUT_ANOTHER_PLACE` in packages/google, and the parse refusals in
-- packages/core/src/reviews/email-parse.ts, both of which a test asserts by name. A private code taken here
-- would be the last one, spent on a rule that reads perfectly well as a CHECK.
--
-- **No column for review CONTENT from Places.** docs/10 §6 marks it [UNVERIFIED] whether the Places terms
-- permit caching review content, docs/10 §8 lists it unanswered, and the strictest safe reading is that they
-- do not (ADR 0043). `google_place_aggregate` has no text column at all, which is what makes the acceptance
-- line's scan — *none of those body strings is present in any table* — a property of the schema rather than
-- of the adapter remembering. A `review_text` column here would be the change that has to be argued for.

begin;

-- ---------------------------------------------------------------------------------------------
-- review_intake_email — every forwarded notification, and the bytes of the ones nothing could read
-- ---------------------------------------------------------------------------------------------
--
-- One row per inbound forward, whatever became of it. Both outcomes are recorded because an inbound email
-- that produced nothing and left no trace is the failure mode the whole fallback exists to remove: the owner
-- forwarded a review, nothing appeared, and there is nothing to look at.
create table review_intake_email (
  id            uuid        primary key default uuid_generate_v7(),

  -- The connection and listing the forward is about. RESTRICT for the reason 0020 gives on
  -- `google_reviews.connection_id`: disconnecting Google is a status change on the connection, never a row
  -- delete, and an intake queue that vanished with it would take the operator's to-do list with it.
  connection_id uuid        not null references google_connections (id) on delete restrict,
  place_id      text        not null,

  -- `parsed` or `needs_paste`. Two outcomes, and the vocabulary is closed because a third would be a state
  -- nothing decides: `parseReviewNotificationEmail` returns one of two shapes.
  status        text        not null
                  constraint review_intake_email_status_known
                  check (status in ('parsed', 'needs_paste')),

  -- Which template shape read it, on the parsed path. The closed set lives in
  -- packages/core/src/reviews/email-parse.ts and is deliberately NOT copied into a CHECK here, for the
  -- reason 0037 gives about `routing_rule_id`: packages/db may not import packages/core (ADR 0001), so a
  -- copy would be a second list that a migration has to rewrite and that disagrees in the meantime.
  template_id   text
                  constraint review_intake_email_template_not_blank
                  check (template_id is null or length(btrim(template_id)) > 0),

  -- Why nothing could be read, on the refusal path. Same argument as `template_id` for the absent CHECK.
  refusal       text
                  constraint review_intake_email_refusal_not_blank
                  check (refusal is null or length(btrim(refusal)) > 0),

  -- THE COLUMN THIS TABLE EXISTS FOR. The forwarded body, byte for byte.
  --
  -- NOT trimmed, normalised or re-encoded anywhere on the path here: a needs_paste item is read by a human
  -- who has to retype what a machine could not, and the acceptance line asserts the stored bytes equal the
  -- fixture's bytes precisely so that a helpful normalisation upstream fails the test rather than passing it.
  --
  -- NULL on the parsed path, and that is a decision rather than an omission. On that path the review row IS
  -- the record, and a second copy of the reviewer's words here would be a second copy that drifts the moment
  -- somebody corrects the review — the same argument 0048 makes for storing a fingerprint of the review text
  -- instead of a second copy of it.
  raw_body      text
                  constraint review_intake_email_raw_body_not_blank
                  check (raw_body is null or length(btrim(raw_body)) > 0),

  -- The digest of the body on BOTH paths, so a parsed row can still be tied to the bytes it came from
  -- without holding them. sha256, lower-case hex, computed by the caller: `packages/db` has no digest of its
  -- own and a `pgcrypto` call here would be a second implementation of the one in the application.
  raw_body_sha256 text      not null
                  constraint review_intake_email_sha256_shape
                  check (raw_body_sha256 ~ '^[0-9a-f]{64}$'),

  -- Bytes rather than characters. A template change often arrives as an encoding change, and
  -- `length(raw_body)` counts code points — so two bodies that differ only in encoding would report the same
  -- size and the difference would be invisible in the queue.
  raw_body_bytes integer    not null check (raw_body_bytes > 0),

  -- The review this forward produced, on the parsed path, or the review somebody later pasted for it.
  -- RESTRICT: the review is the outcome, and a queue row pointing at a deleted review would claim a
  -- resolution that no longer exists.
  review_id     uuid        references google_reviews (id) on delete restrict,

  -- When the forward arrived, injected by the caller. NOT `default now()`: the pass that records it is
  -- tested on a frozen clock, and a default would make the one instant every assertion turns on unfreezable.
  received_at   timestamptz not null,

  -- When a person closed a needs_paste item by pasting the review. NULL while it is still somebody's job.
  resolved_at   timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- The two shapes, stated exactly. `parsed` carries a template and a review and no body; `needs_paste`
  -- carries a refusal and the body and no template. Written as one constraint over `status` rather than as
  -- four independent ones so that a third status cannot inherit "no rules" — the `else false` is 0020's
  -- argument for `google_reviews_delivery_fields_match_mode`, one table along.
  constraint review_intake_email_fields_match_status check (
    case status
      when 'parsed' then
        template_id is not null and refusal is null and raw_body is null and review_id is not null
      when 'needs_paste' then
        template_id is null and refusal is not null and raw_body is not null
      else false
    end
  ),

  -- A resolution IS a review. A resolved item with no review is a closed job with nothing to show for it,
  -- and an unresolved item that names one is a review nobody linked.
  constraint review_intake_email_resolution_needs_a_review check (
    (resolved_at is null) or (review_id is not null)
  ),

  -- A parsed row is never "resolved": it was never anybody's job. Keeping the two apart is what makes the
  -- needs_paste queue's open count a count of work rather than a count of rows.
  constraint review_intake_email_only_a_paste_request_resolves check (
    status = 'needs_paste' or resolved_at is null
  ),

  constraint review_intake_email_resolved_after_received check (
    resolved_at is null or resolved_at >= received_at
  )
);

comment on table review_intake_email is
  'One row per forwarded Google notification email (docs/10 SS6). A body no template could read is stored '
  'verbatim in raw_body and becomes a job for a person; a body that parsed stores only its digest, because '
  'the google_reviews row is the record and a second copy of the words would drift.';
comment on column review_intake_email.raw_body is
  'The forwarded body byte for byte, on the needs_paste path only. Never normalised: a person has to read '
  'what no machine could.';
comment on column review_intake_email.raw_body_sha256 is
  'sha256 of the body, lower-case hex, on both paths. Ties a parsed row to its bytes without holding them.';
comment on column review_intake_email.received_at is
  'When the forward arrived, injected by the caller rather than defaulted, so the pass is testable on a '
  'frozen clock.';

create trigger review_intake_email_updated_at before update on review_intake_email
  for each row execute function set_updated_at();

-- The same guarantee 0020 gives `google_reviews`: a place_id must be a gbp_reviews resource of its own
-- connection. Reusing that function rather than writing a second one — the failure is identical (an intake
-- item filed against the wrong listing sends the owner to the wrong business's reviews) and two copies of
-- one predicate is how they come to disagree.
create trigger review_intake_email_place_belongs_to_connection
  before insert or update of connection_id, place_id on review_intake_email
  for each row execute function assert_review_place_belongs_to_connection();

-- The queue read: the items still waiting for somebody, oldest first, because the oldest forward is the
-- review that has been unanswered longest. Partial, so the cost does not grow with the items already dealt
-- with — the same argument 0037's and 0048's partial indexes make.
create index review_intake_email_awaiting_paste_idx
  on review_intake_email (connection_id, received_at)
  where status = 'needs_paste' and resolved_at is null;

-- ---------------------------------------------------------------------------------------------
-- google_place_aggregate — the daily Places reading, and what the tripwire said about it
-- ---------------------------------------------------------------------------------------------
--
-- One row per listing per trading date. History rather than a single current value, because the tripwire's
-- question is *did the count go up*, and that question needs two readings.
create table google_place_aggregate (
  id             uuid        primary key default uuid_generate_v7(),

  connection_id  uuid        not null references google_connections (id) on delete restrict,
  place_id       text        not null,

  -- The trading date the reading belongs to, resolved by the caller on `business_day`. Trading runs
  -- 11:00-02:00 Asia/Dubai and crosses midnight, so a reading taken at 01:30 belongs to the PREVIOUS trading
  -- date — and the calendar date of the instant is a different number for nine hours either side of
  -- midnight. A plain `date` column with the resolution done here would be that wrong number.
  --
  -- It is a plain column rather than a reference into `business_day` for the reason 0086 records: the check
  -- happens at INSERT, where the row is still fixable, and a RESTRICT reference from a row nobody deletes
  -- would pin every date it names for ever.
  observed_on    date        not null,

  -- When the call was actually made. Distinct from `observed_on`, which is the trading date it counts
  -- against: an 01:30 reading has yesterday's trading date and its own instant, and a support question about
  -- "when did we last look" is about the instant.
  observed_at    timestamptz not null,

  -- The average rating in INTEGER TENTHS, or NULL for a listing nobody has rated.
  --
  -- Tenths because Google reports one decimal place and this column is compared for equality to decide
  -- whether the rating moved: a float stored, read back and compared is a comparison that reports a change
  -- on a value that did not change. Not money, so ADR 0007 does not apply — but the reason ADR 0007 exists
  -- does. 10..50, because 0.0 is not a rating Google can report and 0 would be indistinguishable from
  -- "unrated" once it was read back.
  rating_tenths  smallint    check (rating_tenths is null or rating_tenths between 10 and 50),

  -- How many ratings the listing has, or NULL for a listing with none. NULL and 0 are different facts and
  -- both are reachable: a brand-new listing has no count, and a listing whose only review was deleted has 0.
  review_count   integer     check (review_count is null or review_count >= 0),

  -- How many curated review bodies the call returned and the adapter discarded (ADR 0043). A COUNT, and
  -- there is deliberately no column that could hold one of the bodies. It is here because a silent discard
  -- is indistinguishable from an API that returned nothing, and the difference is the evidence that the
  -- unverified terms question was ever a real constraint.
  curated_reviews_discarded integer not null default 0
                   check (curated_reviews_discarded >= 0),

  -- What the tripwire DID about this reading, not a derivation of it.
  --
  -- `reported_new_reviews` is the number the email said, which is why it is stored rather than computed from
  -- this row and the previous one: an email that went out claiming 2 is evidence about what the owner was
  -- told, and a derivation would silently change its answer if a reading were ever backfilled between the
  -- two. It is NULL when nothing was sent, which is the ordinary case.
  reported_new_reviews integer
                   check (reported_new_reviews is null or reported_new_reviews > 0),

  -- The message the notification produced, when one was produced. NULLABLE even when
  -- `reported_new_reviews` is set, deliberately, and 0075 had to make the same allowance: F03's staging
  -- guard diverts every send to the local outbox outside production and writes no `message` row, and on a
  -- staging worker that is the ORDINARY outcome. RESTRICT because a sent message is the evidence somebody
  -- was told.
  notified_message_id uuid     references message (id) on delete restrict,

  created_at     timestamptz not null default now(),

  -- One reading per listing per trading date. This is the tripwire's idempotency: a pass that runs twice on
  -- one trading date conflicts here, does nothing and sends nothing — so a reclaimed job cannot email the
  -- owner about the same reviews twice. An outbox row is keyed on the row id and never on a display number
  -- (`packages/db/src/outbox-keys.test.ts`), and the same discipline applies here: the key is the pair, not
  -- the count.
  constraint google_place_aggregate_one_reading_per_trading_date
    unique (connection_id, place_id, observed_on),

  -- A message without the number it reported is a notification nobody can explain.
  constraint google_place_aggregate_message_needs_a_number check (
    notified_message_id is null or reported_new_reviews is not null
  ),

  -- A notification about a count this build never read. The tripwire compares two readings, so the row that
  -- reports an increase must itself carry a count.
  constraint google_place_aggregate_report_needs_a_count check (
    reported_new_reviews is null or review_count is not null
  )
);

comment on table google_place_aggregate is
  'One Places API (New) aggregate reading per listing per trading date, and what the count tripwire said '
  'about it (docs/10 SS6). Aggregate ONLY: there is no column for review content, because docs/10 SS8 '
  'records the caching terms as unverified and the strictest safe reading is that nothing may be cached '
  '(ADR 0043).';
comment on column google_place_aggregate.rating_tenths is
  'The average rating in integer tenths, 10-50, or NULL for an unrated listing. Tenths so the comparison '
  'that decides whether the rating moved is never a float compare.';
comment on column google_place_aggregate.reported_new_reviews is
  'The number the notification email SAID, stored rather than derived: it is evidence of what the owner was '
  'told. NULL when nothing was sent, which is the ordinary case.';
comment on column google_place_aggregate.curated_reviews_discarded is
  'How many curated review bodies the call returned and the adapter dropped. A count, never a body.';

-- The tripwire's own read: the previous reading for this listing. Descending on the trading date, so
-- "the newest reading strictly before today" is one index step rather than a sort of the history.
create index google_place_aggregate_latest_idx
  on google_place_aggregate (connection_id, place_id, observed_on desc);

-- ---------------------------------------------------------------------------------------------
-- The two agent rows. 0021's contract: a cron with no agent_definition row has no declared interval and no
-- budget, so nothing is watching it and nothing is capping it — and `assertRegistry` refuses one.
-- ---------------------------------------------------------------------------------------------
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run, enabled)
values
  (
    'review_count_tripwire',
    'Review count tripwire',
    'Reads the Places API (New) aggregate for the listing once a day, compares the review count with '
    'yesterday''s reading, and emails the owner "you have N new reviews" with a deep link built from the '
    'stored placeId when it has gone up. The cheapest honest trigger available while the Business Profile '
    'application is unapproved (docs/10 SS6, Y3-gbp-api). Stores the aggregate only: the caching terms for '
    'review content are unverified (ADR 0043).',
    -- 24 hours. The declared interval is what makes the watchdog's "no success within twice the interval"
    -- alert mean something; a figure picked for tidiness would make the alert arbitrary.
    86400,
    -- One Places call and one email per pass. Places is billed per call and this is one of them; 50 fils is
    -- far above the real figure and far below anything that could run away, and a cap of zero would stop the
    -- pass rather than cap it.
    50,
    true
  ),
  (
    'review_monday_nudge',
    'Monday review nudge',
    'At 09:00 Asia/Dubai on a Monday, emails the owner a direct link to their reviews if nothing has been '
    'reported in the preceding seven days. Low tech, and it turns an invisible task into a habit '
    '(docs/10 SS6). Writes its heartbeat whether or not it sends, because a pass that decided to stay quiet '
    'and a pass that did not run are different facts.',
    -- 7 days. The cron fires weekly, so the watchdog's window has to be the week: a 24-hour interval here
    -- would alert every Tuesday about a pass that is not due until the following Monday.
    604800,
    -- One email. No provider read at all, so the only cost is the send.
    20,
    true
  )
on conflict (agent_key) do nothing;

insert into agent_heartbeat (agent_key)
  select agent_key from agent_definition
  where agent_key in ('review_count_tripwire', 'review_monday_nudge')
on conflict (agent_key) do nothing;

commit;
