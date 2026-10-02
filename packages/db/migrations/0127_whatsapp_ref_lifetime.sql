-- 0127_whatsapp_ref_lifetime.sql — A-FIRST-07
--
-- The ref loop closed: a code that EXPIRES, a handle that cannot carry a person, an attribution that
-- names the session it was proved against, and the day-level counts a capture RATE is read off.
--
-- 0079 (B-UI-04) built the booking side of this join and said so: the codes A-FIRST would generate, and
-- what the front desk did with one. It left three things to the unit that owns the conversation, and this
-- is that unit.
--
-- ============================================================================================
-- 1. The code's LIFETIME, and why an expired code still books
-- ============================================================================================
--
-- A code with no expiry is a join key for ever: the four characters sitting in a two-week-old WhatsApp
-- message would go on attributing bookings to a conversation nobody can remember, and the row would go on
-- naming an analytics session that the 90-day purge (0096) has already removed. So `expires_at` is NOT
-- NULL and is stamped at issue.
--
-- Three decisions inside that, each of which the obvious alternative gets wrong:
--
--   * **The expiry is STORED and not recomputed.** `issued_at + ttl` evaluated at claim time would mean
--     that answering the TTL question (`booking.whatsapp_ref_ttl_days`, Y12-ref-ttl) retroactively moved
--     the status of codes already claimed: a booking recorded as `ref_expired` in March would read as
--     `matched` in April with no row having changed. The expiry is a property of the code AS ISSUED,
--     because the artefact it governs — the message in the customer's chat — was composed once.
--   * **An expired code is NOT recycled.** The obvious next step from a TTL is to let the alphabet be
--     reused once a code dies, and it is the one thing this schema must refuse. The code lives in the
--     customer's chat history, not in our database: handing `7K2Q` to a second conversation makes a
--     two-week-old message attribute a booking to a stranger's session, which is exactly the confident,
--     wrong join that the alphabet's exclusions exist to prevent (section 5 below). `ref_code` stays the
--     PRIMARY KEY with no expiry in it, so the unique index refuses a collision inside the TTL window and
--     outside it alike, and `issueWhatsappRef` redraws.
--   * **An expired code still takes the booking.** It records `ref_expired` and the customer is seated.
--     The field may never block a booking (0079's acceptance line, made structural there by writing the
--     capture row after the booking is durable), and "the desk pasted a code we issued three weeks ago"
--     is a finding about the TTL rather than about the desk — which is why the row KEEPS the code it
--     could not claim.
--
-- ============================================================================================
-- 2. What the handle may CARRY: `session_reference` becomes a uuid
-- ============================================================================================
--
-- 0079 made it `text` and opaque, and said why: "The handle is whatever the unit that owns the
-- conversation says it is." This is that unit, and it says it is `analytics.session.session_id`.
--
-- The type change is the PII decision, not a tidy-up. A ref code is handed out in a message and typed
-- back in at a counter, so every column on this row is one step from a person; a `text` handle is a column
-- a later unit can put a phone number, an email address or a name in, and nothing would notice. A
-- blacklist CHECK cannot close that — `session_reference !~ '[0-9]{6}'` refuses most uuids as well,
-- because a hex string is decimal digits about four fifths of the time — so the guard is POSITIVE: the
-- only value this column accepts is a uuid, and a uuid cannot be a contact detail. The code itself is
-- already structurally incapable of leaking one, because `mintWhatsappRefCode` takes no input at all.
--
-- It is still called `session_reference` and not `session_id`, deliberately, because there is still NO
-- foreign key to `analytics.session` and there must not be one. Retention purges a session at 90 days
-- (0096) and an attribution has to outlive the session it is about — 0096's own comment on
-- `analytics.attribution` says the surviving first and last touch are denormalised precisely for that.
-- `on delete cascade` would delete the code (and then be refused by the capture row's own RESTRICT), and
-- `on delete restrict` would stop the retention pass. A name that promised a key would be a lie about
-- which of the two tables is allowed to disappear.
--
-- ============================================================================================
-- 3. The attribution: `attributed_session_id`, and the two refusals that make it unfakeable
-- ============================================================================================
--
-- The acceptance line asks that the booking name the originating session. It is a column on
-- `booking_whatsapp_ref_capture` and NOT on `booking`, for the reason 0079 rejected a `whatsapp_ref`
-- column there: an attribution is a property of the booking rather than of the person, the capture table
-- is already 1:1 with the booking and carries no customer id, and a nullable column on `booking` would
-- read as both "no session" and "a session we could not prove". The first/last-touch columns on `booking`
-- and `customer` are A-FIRST-08's, whose own acceptance lines name them and whose migration is named for
-- them; this column is what that unit joins from for a desk booking.
--
-- 0079's two CHECK constraints made an invented attribution unrepresentable for the CODE. Widening the
-- outcome vocabulary reopens that, so they are rewritten rather than extended:
--
--   * `..._resolved_names_its_ref` — the ref code is present for exactly the three outcomes in which the
--     code RESOLVED to a row (`matched`, `ref_expired`, `ref_conflict`) and absent for the two in which
--     nothing was found. The old name said `matched_names_its_ref` and would have been a lie the moment
--     `ref_expired` carried a code.
--   * `..._attribution_only_when_matched` — `attributed_session_id` is present for `matched` and for
--     nothing else. This is the half a CHECK can state: an attribution exists only where the claim
--     succeeded.
--
-- What a CHECK cannot state is whether the session named is the one the CODE was issued into, or whether
-- the code was still alive when the row was written — both are facts about another table. Those are the
-- two triggers below, ZY331 and ZY332, and they are why this migration takes a private SQLSTATE at all:
-- an attribution the application could construct from a session id it was handed is an attribution nobody
-- proved, and the quick-book handler is not the only thing that can write this row.
--
-- ============================================================================================
-- 4. Why the capture rate is a table of its own and not a `daily_funnel` row
-- ============================================================================================
--
-- A-FIRST-01 deferred the shape here in so many words: the ref-capture numerator and denominator "are
-- day-level rather than step-level figures". `analytics.daily_funnel` is keyed on
-- (trading_date, step, source, medium, campaign) and holds `entered` and `excluded`. A code ISSUE is not
-- one of the eight funnel steps, it has no origination tuple of its own, and "claimed" is not an
-- exclusion — writing it there needs either a ninth enum member that no funnel draws or a second meaning
-- for two columns that A-FIRST-09 and A-FIRST-10 read. So `analytics.daily_ref_capture` is a sibling
-- rollup beside `daily_traffic`, `daily_funnel` and `daily_source_revenue`, on the same
-- keep-indefinitely policy, and the funnel page joins it on the day.
--
-- It is keyed on (trading_date, trading_date_basis), which is `analytics.session`'s pair and not 0116's
-- (bucket_date, bucket_basis). The difference is worth stating because the two tables look alike and are
-- answering different questions. `pre_consent_landing` counts a visit that may have happened on a calendar
-- date the trading calendar has no row for at all, so it can hold no foreign key. A code issue is filed by
-- `fileUnderTradingDate`, which always returns a date `public.business_day` HOLDS — the day containing the
-- instant, or the next day the calendar opens when it fell in the 02:00-11:00 gap — so the foreign key is
-- available and is taken, exactly as every rollup in 0096 takes it. The basis stays in the KEY because
-- Y5-funnel-gap-bucket is open: a day's trading issues and the issues that fell in its daytime gap have to
-- stay separately countable, and a figure that had already added them could not be taken apart again.
--
-- And the claimed count is paired with the day the CODE WAS ISSUED, not the day the booking was taken.
-- Dividing today's claims by today's issues mixes cohorts and can exceed 1 — a capture rate of 140% is
-- arithmetic nobody can act on. `claimed <= issued` is a CHECK precisely because the pairing is what
-- makes it true.

-- ============================================================================================
-- 5. The alphabet loses two characters, and one of them is the whole reason
-- ============================================================================================
--
-- 0079 excluded I, O, 0 and 1. With those gone, a misread of `L` as `1` or `I` produces a value that is
-- not a code at all, so it fails this column's CHECK and resolves to `unknown_code` — a visible warning
-- and an honestly unknown attribution. `U` misread as `V` is the ONLY remaining pair in which the wrong
-- character is itself in the alphabet, so that misread produces a different VALID code and the booking is
-- credited to somebody else's conversation. The statement below is where that last hole closes; the full
-- argument, and why it is safe to narrow now and would not be later, is beside the statement.
--
-- ---------------------------------------------------------------------------------------------
-- New enum labels — OUTSIDE the transaction, 0054's convention
-- ---------------------------------------------------------------------------------------------
-- `alter type ... add value` is legal inside a transaction block on PostgreSQL 12+, but the new label may
-- not be USED until that transaction commits, and the block below writes both into a CHECK constraint.
-- `psql -f` sends statements in autocommit, so each of these commits on its own. `if not exists` because
-- these are the statements a re-run reaches: the transaction below commits whole or rolls back whole, and
-- a half-applied migration must not be a half-applied enum as well.
--
-- Two labels and not three. There is no `ref_withdrawn` beside them: a code is never deleted and never
-- edited (UPDATE and DELETE are revoked from `berelax_app` on both tables), so there is no state in which
-- a code the desk typed existed and then stopped existing.
alter type whatsapp_ref_capture_outcome add value if not exists 'ref_expired';
alter type whatsapp_ref_capture_outcome add value if not exists 'ref_conflict';

begin;

comment on type whatsapp_ref_capture_outcome is
  'The exhaustive result of comparing what the desk typed against whatsapp_ref AND against the code''s own '
  'lifetime. An ENUM and not a table, unlike the 0053 CRM vocabularies: there is no fourth answer for the '
  'owner to supply and no label to correct, so nothing here needs is_provisional. Five labels since 0127: '
  'three of them mean the code RESOLVED (matched, ref_expired, ref_conflict) and only `matched` carries an '
  'attribution. Pinned to REF_CAPTURE_OUTCOMES in @berelax/core.';

-- ---------------------------------------------------------------------------------------------
-- The code's lifetime
-- ---------------------------------------------------------------------------------------------

-- Nullable, then filled, then NOT NULL — 0116's shape, and for its reason. `whatsapp_ref` ships EMPTY in
-- this build, so a bare `add column ... not null` would succeed here and fail against any database that
-- has rows: a migration that passes only in the tree that wrote it. The backfill is stated even though it
-- is expected to touch nothing.
--
-- No DEFAULT afterwards, deliberately. A default would let a writer that has never heard of the TTL issue
-- a code with a lifetime nobody chose, which is the one thing this column exists to stop.
alter table whatsapp_ref add column expires_at timestamptz;

-- The provisional 7 days of Y12-ref-ttl, spelled here ONCE for the backfill and nowhere else: the live
-- figure is `booking.whatsapp_ref_ttl_days` in the settings registry, read by the issue path. A constant
-- in this file is the value a replayed migration needs and not a second statement of the setting — the
-- setting governs codes issued after it is answered, and a row already in the table was issued under
-- whatever the figure was that day.
update whatsapp_ref set expires_at = issued_at + interval '7 days' where expires_at is null;

alter table whatsapp_ref alter column expires_at set not null;

alter table whatsapp_ref
  add constraint whatsapp_ref_expires_after_it_was_issued check (expires_at > issued_at);

comment on column whatsapp_ref.expires_at is
  'When the code stops being claimable. Stamped at issue from booking.whatsapp_ref_ttl_days and never '
  'recomputed: answering Y12-ref-ttl would otherwise move the recorded outcome of bookings already taken. '
  'The code is NOT recycled afterwards — it still exists in the customer''s chat history, and reissuing it '
  'would attribute a booking to a stranger''s conversation.';

-- The claim path reads the primary key, so this index is not for it. It is for the question the lifetime
-- creates: "which codes are dead and unclaimed", which is the purge A-FIRST-09 is handed (see the ledger).
create index whatsapp_ref_expires_at_idx on whatsapp_ref (expires_at);

-- ---------------------------------------------------------------------------------------------
-- The alphabet, narrowed by two characters
-- ---------------------------------------------------------------------------------------------

-- 0079 excluded I, O, 0 and 1 — "the four characters a person reading a code off a phone screen confuses".
-- The exclusion is narrowed to Crockford's set, I L O U 0 1, and the argument is 0079's own taken one step
-- further rather than a different taste.
--
-- With I, O, 0 and 1 already gone, a misread of `L` as `1` or `I` produces a value that is not a code at
-- all: it fails this CHECK, fails the field's pattern, and resolves to `unknown_code` — a visible warning
-- and an honestly unknown attribution. `U` misread as `V` is the ONLY remaining pair in which the wrong
-- character is itself in the alphabet, so the misread produces a different VALID code and the booking is
-- attributed to somebody else's conversation. That is the failure 0079's whole paragraph is about, and it
-- was still reachable. `L` goes with `U` because they are one convention and because an attempt wasted on
-- `L`/`1` is an attempt the customer does not get back.
--
-- The code space falls from 32^4 = 1,048,576 to 30^4 = 810,000, which is orders of magnitude more codes
-- than this business will issue; `issueWhatsappRef` redraws on a collision and gives up after eight.
--
-- Safe to tighten HERE and not later, and that is the reason it is in this migration rather than deferred:
-- `whatsapp_ref` is still empty, so there is no issued code that this CHECK would retrospectively refuse.
-- Narrowing it after a code containing `U` had been handed to a customer would leave a row the column no
-- longer admits and a message whose code can never be claimed.
--
-- Dropped and re-added under the SAME name, so the Drizzle mirror and `pnpm db:drift` compare the same
-- constraint rather than reporting one gone and one arrived.
alter table whatsapp_ref drop constraint whatsapp_ref_ref_code_check;
alter table whatsapp_ref
  add constraint whatsapp_ref_ref_code_check check (ref_code ~ '^[A-HJKM-NP-TV-Z2-9]{4}$');

comment on column whatsapp_ref.ref_code is
  'Four characters from A-Z and 2-9, less I, L, O, U, 0 and 1 — Crockford''s exclusion set, narrowed from '
  '0079''s I/O/0/1 by 0127. The same rule as WHATSAPP_REF_CODE_CLASS in @berelax/shared, which is what the '
  'page''s input pattern is built from. U is the one that matters: with the others already excluded, a '
  'misread of U as V was the last way a typo could produce ANOTHER VALID CODE and attribute a booking to '
  'somebody else''s conversation.';

-- ---------------------------------------------------------------------------------------------
-- What the handle may carry
-- ---------------------------------------------------------------------------------------------

-- The blank check goes FIRST, and the order is load-bearing rather than tidy: PostgreSQL re-checks every
-- constraint on the column against its new type, and `btrim(uuid)` is not a function that exists — the
-- type change fails with `function btrim(uuid) does not exist`, which names neither this constraint nor
-- the column. It is dropped rather than rewritten because it has stopped meaning anything: a uuid cannot
-- be blank, so `btrim(…) <> ''` is true for every value the column can now hold, and a constraint that
-- cannot fail is a constraint that says nothing (ADR 0002).
alter table whatsapp_ref drop constraint whatsapp_ref_session_reference_check;

-- `using session_reference::uuid`, which FAILS loudly on a row that is not one rather than dropping it.
-- That is the correct behaviour and not an oversight: a handle that is not a session id is either a bug
-- in whatever wrote it or a contact detail somebody stored, and both have to be looked at by a person.
alter table whatsapp_ref
  alter column session_reference type uuid using session_reference::uuid;

comment on column whatsapp_ref.session_reference is
  'The analytics session the code was issued into: analytics.session.session_id, as a uuid since 0127. '
  'A uuid and not text because every other column on this row is one step from a person — the code is read '
  'off a phone and typed in at a counter — and a text handle is a column a later unit could put a phone '
  'number in. Deliberately NOT a foreign key: retention purges a session at 90 days and an attribution has '
  'to outlive the session it is about, so neither CASCADE nor RESTRICT is available. Still not unique: a '
  'conversation may be issued a second code and both attribute to it.';

-- ---------------------------------------------------------------------------------------------
-- The attribution
-- ---------------------------------------------------------------------------------------------

alter table booking_whatsapp_ref_capture add column attributed_session_id uuid;

-- The backfill, from the code's own row and from nowhere else. A `matched` row cannot exist in this build
-- (whatsapp_ref ships empty, so nothing could match), and the statement is written anyway because the
-- NOT-NULL-by-CHECK below is what a database with rows would be held to.
update booking_whatsapp_ref_capture c
   set attributed_session_id = r.session_reference
  from whatsapp_ref r
 where r.ref_code = c.ref_code
   and c.outcome = 'matched'
   and c.attributed_session_id is null;

-- 0079's two constraints, rewritten rather than extended. Both are EQUALITIES, which is what closes the
-- hole in each direction at once, and both are dropped by their old names because `matched_names_its_ref`
-- would be false the moment `ref_expired` carried a code — a constraint whose name misdescribes it is
-- worse than one that is missing, because a reader stops looking.
alter table booking_whatsapp_ref_capture
  drop constraint booking_whatsapp_ref_capture_matched_names_its_ref;

alter table booking_whatsapp_ref_capture
  add constraint booking_whatsapp_ref_capture_resolved_names_its_ref
    check ((outcome in ('matched', 'ref_expired', 'ref_conflict')) = (ref_code is not null));

alter table booking_whatsapp_ref_capture
  add constraint booking_whatsapp_ref_capture_attribution_only_when_matched
    check ((outcome = 'matched') = (attributed_session_id is not null));

comment on column booking_whatsapp_ref_capture.attributed_session_id is
  'The analytics session this booking is attributed to, for the `matched` outcome and for nothing else. '
  'Not a foreign key, for the reason whatsapp_ref.session_reference is not one: the session is purged at 90 '
  'days and this row outlives it, which is the whole point of denormalising. A-FIRST-08 joins from here for '
  'a desk booking''s first and last touch.';

comment on column booking_whatsapp_ref_capture.ref_code is
  'The code the desk typed, for the three outcomes in which it resolved to a row - matched, ref_expired and '
  'ref_conflict - and null for the two in which nothing was found. Only `matched` carries an attribution; '
  'the other two keep the code because "the desk pasted a code we issued three weeks ago" and "the desk '
  'pasted a code another customer already claimed" are findings, and the code is the evidence for both. '
  'ON DELETE RESTRICT: a code a booking names cannot be removed from under it.';

comment on table booking_whatsapp_ref_capture is
  'One row per booking taken at the front desk, recording what happened to the WhatsApp ref field - '
  'matched, expired, already claimed by somebody else, matched nothing, or not offered. The denominator of '
  'the booking-side capture rate is therefore a count of THIS table and not a guess at how many bookings '
  'there were. Three CHECK constraints and two triggers make an invented attribution unrepresentable: the '
  'code and the resolving outcomes imply each other exactly, an attribution exists only for `matched`, and '
  '0127''s ZY331/ZY332 refuse one that names an expired code or a session the code was not issued into. '
  'UPDATE, DELETE and TRUNCATE are revoked from berelax_app rather than refused by a trigger - see 0079''s '
  'header for why a trigger pair would break the booking cascade. Y12-ref-loop.';

-- ---------------------------------------------------------------------------------------------
-- The two refusals a CHECK cannot make
-- ---------------------------------------------------------------------------------------------

/*
 * Why these are at the database boundary at all.
 *
 * `decideRefCapture` in `@berelax/core` already refuses both: it takes the matched ROW rather than a
 * predicate, so a match cannot be inferred, and 0127 gives it the code's expiry and the prior claim as
 * inputs. That is the rule, and it holds for the quick-book handler.
 *
 * It does not hold for anything else that can write this row — a later unit, a backfill, an import, a psql
 * session — and the failure is the invisible kind: a booking attributed to a conversation nobody proved it
 * came from reads exactly like one that was. 0079 put the code/outcome implication in a CHECK for that
 * reason and said so ("a property of the column rather than of whichever handler wrote the row"). An
 * attribution that names a session is the same claim one table further away, so it needs a trigger: a
 * CHECK may not read another row.
 *
 * ONE function and two codes, because a caller branches on the code and the two remedies are different
 * ("issue a new code and ask the customer to resend" against "this attribution is wrong; find out which
 * session the conversation really was"). A BEFORE INSERT trigger and not a constraint trigger: the row must
 * never land, and `recordRefCapture` runs inside the booking's own unit of work.
 */
create function refuse_unproved_ref_attribution() returns trigger
language plpgsql
as $$
declare
  v_session uuid;
  v_expires timestamptz;
begin
  -- A null `ref_code` on a `matched` row is left to `..._resolved_names_its_ref`, and that is deliberate
  -- rather than an omission: a CHECK violation names the CONSTRAINT, which tells a reader exactly which
  -- rule they broke, and this function could only say the same thing less precisely. A BEFORE trigger runs
  -- before every CHECK on the row, so raising here would REPLACE that message with this one — which is
  -- what it did on the first run of this migration, turning 0079's own assertion on the constraint name
  -- into a failure about a trigger.
  if new.outcome <> 'matched' or new.ref_code is null then
    return new;
  end if;

  select r.session_reference, r.expires_at into v_session, v_expires
    from whatsapp_ref r
   where r.ref_code = new.ref_code;

  -- The foreign key refuses an absent code too, but it is checked at the END of the statement while this
  -- runs before it — so this branch is reachable, and it must not fall through to `return new`, which
  -- would compare a null session against a null and accept the row.
  if v_session is null then
    raise exception
      'booking % claims ref code % and no such code exists, so there is nothing that proved the '
      'attribution. A matched capture row is only ever a code the table holds (0079).',
      new.booking_id, coalesce(new.ref_code, '(null)')
      using errcode = 'ZY332';
  end if;

  if new.attributed_session_id <> v_session then
    raise exception
      'booking % would be attributed to session % while ref code % was issued into session %. An '
      'attribution is the CODE''S session and never one the caller supplied: a booking credited to a '
      'conversation nobody proved it came from is indistinguishable from one credited correctly, which is '
      'why this is refused here and not only in the handler.',
      new.booking_id, new.attributed_session_id, new.ref_code, v_session
      using errcode = 'ZY332';
  end if;

  if v_expires <= new.recorded_at then
    raise exception
      'ref code % expired at % and booking % was recorded at %, so the code may not be claimed. Record '
      'the booking with outcome `ref_expired`, which keeps the code as evidence and takes the booking: '
      'the ref field never blocks one. The lifetime is booking.whatsapp_ref_ttl_days (Y12-ref-ttl).',
      new.ref_code, v_expires, new.booking_id, new.recorded_at
      using errcode = 'ZY331';
  end if;

  return new;
end $$;

comment on function refuse_unproved_ref_attribution() is
  'Refuses a `matched` capture row whose code has expired (ZY331) or whose attributed_session_id is not the '
  'session that code was issued into (ZY332). The half of "an invented attribution is unrepresentable" that '
  'a CHECK cannot state, because both facts live on another row.';

create trigger booking_whatsapp_ref_capture_attribution_is_proved
  before insert on booking_whatsapp_ref_capture
  for each row execute function refuse_unproved_ref_attribution();

-- ---------------------------------------------------------------------------------------------
-- The day-level counts the rate is read off
-- ---------------------------------------------------------------------------------------------

create table analytics.daily_ref_capture (
  /*
   * The trading date the issue is FILED under, from `fileUnderTradingDate` — the day whose
   * [opens_at, closes_at) window contains the instant, or the next day the calendar opens when it fell in
   * the 02:00-11:00 gap. Always a date `public.business_day` holds, which is what makes the foreign key
   * below available and is why this is `trading_date` and not 0116's `bucket_date`.
   */
  trading_date       date not null,
  /*
   * Which of those two happened, and for a gap instant which reason applied. `analytics.session`'s own
   * column, label for label (0116), and in the PRIMARY KEY for its reason: Y5-funnel-gap-bucket is open,
   * so a day's trading issues and the issues that fell in that day's daytime gap must be countable
   * separately rather than silently added together. A funnel that wants them together sums two rows; one
   * that wants them apart cannot be given a figure that already mixed them.
   */
  trading_date_basis text not null,
  /*
   * How many codes were issued into conversations that day, and how many of those came back. `bigint`
   * beside 0116's reasoning: this row is kept indefinitely and a counter that can overflow is a
   * denominator that silently stops being one.
   *
   * `codes_claimed` is paired with the day the CODE was issued and not the day the booking was taken. The
   * other pairing mixes cohorts and can exceed 1 — which is why the CHECK below is available at all.
   */
  codes_issued  bigint  not null,
  codes_claimed bigint  not null,
  computed_at   timestamptz not null,
  primary key (trading_date, trading_date_basis),
  constraint daily_ref_capture_trading_date_fk
    foreign key (trading_date) references public.business_day (trading_date),
  constraint daily_ref_capture_basis_known
    check (trading_date_basis in ('trading', 'before_opening', 'after_closing', 'premises_closed')),
  constraint daily_ref_capture_counts_nonneg
    check (codes_issued >= 0 and codes_claimed >= 0),
  -- The pairing, as a property of the table. A claim is a code coming back, so it was issued first: a row
  -- claiming more than it issued is a rate above 100% and there is no reading of it anybody can act on.
  constraint daily_ref_capture_claimed_within_issued
    check (codes_claimed <= codes_issued)
);

comment on table analytics.daily_ref_capture is
  'The ref loop per day: codes issued into WhatsApp conversations, and how many of those were claimed at '
  'the desk (A-FIRST-07). Kept INDEFINITELY beside the three 0096 rollups, and a sibling of them rather '
  'than rows in analytics.daily_funnel because these are DAY-level figures - a code issue is not one of the '
  'eight funnel steps, carries no origination tuple and "claimed" is not an `excluded`. A-FIRST-01 deferred '
  'the shape here. Upserted and RECOMPUTED from whatsapp_ref and booking_whatsapp_ref_capture on every '
  'write, so two runs over the same day produce identical rows and the figure cannot drift from the tables '
  'it is derived from. Holds no identifier of any kind - a date, a basis and two counts. Y12-ref-loop.';
comment on column analytics.daily_ref_capture.trading_date_basis is
  'Whether the trading date CONTAINS the issue instant (`trading`) or the issue fell in the daytime gap and '
  'was filed under the next day the calendar opens, naming which reason applied. analytics.session''s own '
  'column. In the KEY, so the two kinds of day can never be added together (Y5-funnel-gap-bucket).';
comment on column analytics.daily_ref_capture.codes_claimed is
  'Codes ISSUED that day which a booking later matched. Keyed on the issue day and not the booking day, so '
  'the numerator and the denominator are the same cohort.';

/*
 * Its retention policy row, which is not paperwork: `analytics.run_retention` raises ZY062 for a base table
 * in this schema with no row here, so the whole pass stops rather than retaining a new table for ever by
 * omission.
 */
insert into analytics.retention_policy (relation_name, policy, age_column, purge_order, reason)
values
  ('daily_ref_capture', 'keep_indefinitely', null, null,
   'The day-level ref-loop rollup (A-FIRST-07). Exempt for the reason the other three rollups are: it is '
   'the figure the funnel is read off years later, and it holds nothing for retention to protect anybody '
   'from — a date, a bucket basis and two counts, with no visitor, no session, no code and no identifier of '
   'any kind.');

-- The rollup is an upsert, so the application role needs UPDATE. Explicit rather than inherited from
-- 0009's default privileges, and named beside the four rollups it behaves like.
grant update on analytics.daily_ref_capture to berelax_app;

commit;
