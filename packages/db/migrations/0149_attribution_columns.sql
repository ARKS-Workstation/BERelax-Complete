-- 0149_attribution_columns.sql — A-FIRST-08
--
-- First touch and last touch, denormalised out of the analytics store and onto the two records that
-- outlive it: the CUSTOMER and the BOOKING.
--
-- ============================================================================================
-- Why these are two tables and not columns on `customer` and `booking`
-- ============================================================================================
--
-- The manifest entry says "denormalised first/last-touch columns on customer and booking", and the
-- columns are here — on two child tables rather than on the parents. Three reasons, and the first is
-- decisive on its own.
--
--   1. **A NOT NULL attribution column on `customer` cannot be added without inventing one.** Those
--      tables already hold rows: `alter table customer add column first_touch_source text not null`
--      fails on a non-empty table, and a DEFAULT would write an attribution onto every customer the
--      business already has. `unknown` would be the least-wrong default and it is still a claim nobody
--      made (brief rule 15, and `customer_acquisition_source`'s own comment: "choosing walk_in for them
--      would be an invented attribution"). A CHILD ROW'S ABSENCE is the honest statement — this customer
--      has no attribution on file — and `source` is then NOT NULL for every row that does exist, which
--      is what A-FIRST-08's acceptance line asks for.
--   2. **One classification instead of fourteen.** A customer-scoped column enters C-CRM-10's erasure
--      catalogue, and an unclassified one REFUSES every customer erasure. Fourteen columns on `customer`
--      would be fourteen entries in `rights-policy.ts`; one child table with
--      `on delete cascade` is one, and the same for C-CRM-05's merge registry.
--   3. **`customer` and `booking` are both read by name all over this build.** Widening either by seven
--      columns widens every `select *`-shaped read and every DTO audience list behind it.
--
-- ============================================================================================
-- Why the first touch is the CUSTOMER's and the last touch is the BOOKING's
-- ============================================================================================
--
-- They are different claims about different subjects, and that is the shape rather than a convenience.
--
-- A person is found once. The first touch is therefore a property of the PERSON and write-once: a
-- customer with three sessions from three sources keeps the earliest, whichever order the sessions are
-- replayed in. Putting it on the booking would give one customer three first touches and make "where
-- did this client come from" a query with an ordering in it.
--
-- A person books repeatedly, and each booking has its own most-recent-touch-before-it. The last touch is
-- therefore a property of the BOOKING. Putting it on the customer would mean the second booking
-- overwriting the first booking's last touch — and that figure is the denominator of every "which
-- channel produced this sale" report, so the overwrite would silently re-attribute money that was
-- already counted.
--
-- The two may disagree, which is the whole reason there are two: a customer found through an ad in March
-- and booked through a reminder link in June is `cpc` by first touch and `email` by last touch. A build
-- that kept one column would be choosing which of those questions the business may ask.
--
-- ============================================================================================
-- There is NO foreign key to `analytics.session`, in either direction, and that is the point
-- ============================================================================================
--
-- `analytics.run_retention` purges `analytics.session` at ninety days (0096, ADR 0045). A reference from
-- here to there would either block that purge or cascade the attribution away with it, and the
-- attribution is the half that has to survive: it is what a customer's acquisition channel IS, years
-- later, and 0096 says so in its own comment on `analytics.attribution` — *"the first and last touch
-- that OUTLIVE it are denormalised onto customer and booking by A-FIRST-08"*.
--
-- So `session_reference` is a bare `uuid`. That is exactly the shape A-FIRST-07 chose for
-- `whatsapp_ref.session_reference` and for `booking_whatsapp_ref_capture.attributed_session_id`, for
-- this reason. A reference that resolves to nothing is the EXPECTED state of a row older than the
-- window, not a fault, and nothing in this build joins through it without tolerating that.
--
-- The VALUES are copied rather than joined for the same reason. A rollup that read the source through a
-- live join would report a day's traffic correctly for ninety days and then report it as unattributed,
-- and the change would arrive as a cliff in a chart nobody had deployed anything near.
--
-- ============================================================================================
-- `offline` is a fifth basis and not a reuse of `direct`
-- ============================================================================================
--
-- `direct` (0096) means a browser arrived with nothing to resolve: a real web session whose origination
-- could not be attributed. `offline` means there was no browser at all — a walk-in off Al Wasl Road, or
-- a telephone call. Folding the two would make attribution coverage unanswerable, because the
-- denominator would contain every walk-in the salon has ever had and the figure would read as a
-- marketing failure.
--
-- `attribution_origination_is_well_formed` is the ONE statement of the shape, and both tables' CHECKs
-- call it. Two hand-written copies of one rule is the defect the brief names: a second statement of a
-- fact drifts, and the drift here would be a table accepting a row the other refuses.
--
-- ============================================================================================
-- ZY691 and ZY692, and the eight codes released
-- ============================================================================================
--
-- The band ZY691-ZY700 is this unit's. Two codes are raised and registered; ZY693 through ZY700 are
-- released and deliberately left UNREGISTERED, because `pnpm sqlstate` refuses an entry for a code no
-- migration raises.
--
-- Both are triggers rather than CHECKs: the first compares NEW against OLD and the second reads another
-- table's row, and a CHECK can do neither.
--
--   * **ZY691 — a first touch may only be replaced by an EARLIER one.** "Write-once" as a rule that
--     refuses every UPDATE is not available, because a customer MERGE has to be able to carry the
--     loser's earlier first touch onto the survivor. So the rule is the one that makes both true: the
--     claim may move backwards in time and never forwards. A resolver that re-ran over a longer session
--     history converges on the same row; a writer that overwrote March with June is refused.
--   * **ZY692 — a booking's last touch may not postdate the booking.** A session that began after the
--     booking was created cannot have produced it, and the page a customer lands on next is usually the
--     confirmation — so the wrong answer here is self-reinforcing, and it re-attributes a completed sale
--     to the channel that followed it. `<=` and not `<`: a one-page quick-book takes the booking in the
--     same instant as the session that produced it.
--
-- ============================================================================================
-- The merge: a fold on `merge_record` rather than a fifth strategy
-- ============================================================================================
--
-- `customer_attribution` is a `repoint_update` participant with the key `(customer_id)`. That statement
-- MOVES the loser's row when the survivor has none, and SKIPS it when the survivor has one — which is
-- the generic executor doing exactly the right thing for an ordinary profile table and the wrong thing
-- here, because the earlier of two first touches is neither "move" nor "skip".
--
-- So the fold is a trigger on `merge_record`, which `mergeCustomers` inserts BEFORE it runs the
-- participant loop: if the loser's first touch is earlier than the survivor's, the survivor's row takes
-- the loser's values, and the participant loop then finds the survivor's key taken and retains the
-- loser's row on the tombstone with a stated reason. The survivor is left with exactly one first-touch
-- row, which is its PRIMARY KEY, and that row holds the earlier claim.
--
-- A fifth merge strategy was the alternative and is worse: it would widen `sql.unsafe`'s identifier
-- grammar and the balance constraints in `merge_record_table` for one table's arithmetic, and the rule
-- would then live in a module a reader of this schema has no reason to open. The fold is also what makes
-- the claim hold for a merge somebody runs in psql.

begin;

-- ---------------------------------------------------------------------------------------------
-- The one statement of what an origination row may look like
-- ---------------------------------------------------------------------------------------------

/*
 * IMMUTABLE and `returns boolean`, so both tables' CHECK constraints can call it. A CHECK may not
 * contain a subquery and may not call a VOLATILE function, which is why this reads only its arguments —
 * the basis vocabulary is a literal here and in the Drizzle mirror and in `ATTRIBUTION_BASES`, and gate
 * case 180f reads all three and requires the same five words. `packages/db` may not import
 * `packages/core` (ADR 0001), so there is no fourth place this could have come from.
 */
create function attribution_origination_is_well_formed(
  p_basis             text,
  p_source            text,
  p_medium            text,
  p_session_reference uuid,
  p_how_heard         text
) returns boolean
language sql
immutable
as $$
  select
    -- 0096's four bases plus `offline`. A walk-in is not a `direct` web visit.
    p_basis in ('utm', 'click_id', 'referrer', 'direct', 'offline')
    -- Never blank, for `attribution_source_not_blank`'s reason: a blank source renders as a row with no
    -- name in every traffic report and sorts to the top of it.
    and btrim(p_source) <> ''
    and btrim(p_medium) <> ''
    -- `direct` has ONE spelling, which is 0096's rule for the same value one schema over. Without it a
    -- direct visit arrives as ('direct','none'), ('(direct)','(none)') or ('direct','') from three
    -- callers and the report shows three rows for one thing.
    and (p_basis <> 'direct' or (p_source = 'direct' and p_medium = 'none'))
    -- And `offline` has one spelling too, which is the pair A-FIRST-08's acceptance line names.
    and (p_basis <> 'offline' or (p_source = 'offline' and p_medium = 'direct'))
    -- A web touch names its session and an offline touch cannot, in both directions. A row claiming
    -- `offline` with a session would be counted as unattributed while naming the session that
    -- attributes it, and a web basis with no session is a claim with no evidence behind it.
    and (p_basis = 'offline') = (p_session_reference is null)
    -- How-heard is what the front desk was TOLD. It is available only where there was nobody to ask a
    -- browser, so it belongs to an offline touch alone: on a web row it would be a second, unsourced
    -- answer to the question the session already answers.
    and (p_how_heard is null or p_basis = 'offline')
    -- A blank how-heard is a staff member who pressed Enter, and it would read as an answer in every
    -- count of how-heard responses. NULL is the absence; '' is not a second one.
    and (p_how_heard is null or btrim(p_how_heard) <> '')
$$;

comment on function attribution_origination_is_well_formed(text, text, text, uuid, text) is
  'The ONE statement of what an attribution origination may look like, called by the CHECK on both '
  'customer_attribution and booking_attribution. Two hand-written copies of this rule would drift, and '
  'the drift would be one table accepting a row the other refuses.';

-- ---------------------------------------------------------------------------------------------
-- customer_attribution — the FIRST touch, one row per customer, write-once backwards only
-- ---------------------------------------------------------------------------------------------

create table customer_attribution (
  /*
   * The PRIMARY KEY, which is what makes "exactly one first-touch row per customer" a property of the
   * schema rather than of the writer's care. A-FIRST-08's merge acceptance line asks for it after a
   * merge; a key cannot be false after one.
   */
  customer_id       uuid        not null,
  basis             text        not null,
  source            text        not null,
  medium            text        not null,
  /*
   * `''` and never null. A null never equals a null, so a nullable dimension would make the same
   * campaign-less customer upsert a second row — 0096's own argument for the same default on the three
   * rollups, and the reason the first-touch write converges instead of accumulating.
   */
  campaign          text        not null default '',
  /*
   * The session this touch came from, as an opaque uuid with NO foreign key. See the header: retention
   * purges `analytics.session` at ninety days and this claim has to outlive it, so a reference that
   * resolves to nothing is the expected state of an old row rather than a fault.
   */
  session_reference uuid,
  /** What the front desk was told, for an offline first touch. Null for every web touch. */
  how_heard         text,
  /*
   * When the touch HAPPENED — the session's `started_at`, or the customer's own first booking instant
   * for an offline touch. This is the column ZY691 orders, so it is the one that decides which of two
   * first touches survives a merge.
   */
  occurred_at       timestamptz not null,
  /** When this row was written. The WRITER's instant, which is not the touch's (0096's `resolved_at`). */
  recorded_at       timestamptz not null,
  updated_at        timestamptz not null default now(),
  primary key (customer_id),
  /*
   * ON DELETE CASCADE, unlike `booking.customer_id`'s RESTRICT. A booking is a commercial and then a
   * statutory record and deleting a customer must fail loudly rather than quietly erase the takings; an
   * attribution is a measurement ABOUT a customer and has no meaning without one. It is also what makes
   * C-CRM-10's erasure one classification rather than seven.
   */
  constraint customer_attribution_customer_fk
    foreign key (customer_id) references customer (id) on update cascade on delete cascade,
  constraint customer_attribution_origination_well_formed
    check (attribution_origination_is_well_formed(basis, source, medium, session_reference, how_heard)),
  -- The writer's instant cannot precede the touch it records. Equality is legal: a walk-in's first
  -- touch IS the booking that revealed it, recorded in the same transaction.
  constraint customer_attribution_recorded_after_touch
    check (recorded_at >= occurred_at)
);

comment on table customer_attribution is
  'One row per customer: the FIRST touch, which is a property of the PERSON and is write-once. A first '
  'touch may only be replaced by an EARLIER one (ZY691), which is what makes "replay the sessions in '
  'any order and get the same answer" true by construction and what lets a customer merge carry the '
  'loser''s earlier claim onto the survivor. Denormalised out of analytics.attribution, which is purged '
  'with its session at ninety days: there is no foreign key in either direction, deliberately.';

comment on column customer_attribution.session_reference is
  'An opaque handle, not a reference. analytics.session is purged at ninety days, so a foreign key would '
  'either block the purge or cascade this row away with it - and this row is the half that has to '
  'survive. A-FIRST-07''s whatsapp_ref.session_reference is a uuid for the same reason.';

comment on column customer_attribution.how_heard is
  'What the front desk was told, for an offline first touch; null for every web touch, enforced by '
  'attribution_origination_is_well_formed. A blank is refused rather than stored: an empty string here '
  'is a staff member who pressed Enter, and it would read as an answer in every count of the responses.';

create trigger customer_attribution_updated_at before update on customer_attribution
  for each row execute function set_updated_at();

-- The coverage read and the merge fold both ask "which customers came through this source".
create index customer_attribution_source_idx on customer_attribution (source, medium, occurred_at);

-- ---------------------------------------------------------------------------------------------
-- booking_attribution — the LAST touch, one row per booking
-- ---------------------------------------------------------------------------------------------

create table booking_attribution (
  booking_id        uuid        not null,
  basis             text        not null,
  source            text        not null,
  medium            text        not null,
  campaign          text        not null default '',
  session_reference uuid,
  how_heard         text,
  /*
   * The last touch's instant: the `started_at` of the most recent session that began AT OR BEFORE this
   * booking was created, or the booking's own `created_at` for an offline one. ZY692 holds it against
   * `booking.created_at`, because a session that began afterwards cannot have produced the booking.
   */
  occurred_at       timestamptz not null,
  recorded_at       timestamptz not null,
  updated_at        timestamptz not null default now(),
  primary key (booking_id),
  /*
   * CASCADE for `customer_attribution`'s reason, and there is no second path to worry about: a booking
   * is never deleted by this build (`booking.customer_id` is RESTRICT precisely so a customer deletion
   * cannot take one), so the cascade exists for a test fixture and for a restored dump.
   */
  constraint booking_attribution_booking_fk
    foreign key (booking_id) references booking (id) on update cascade on delete cascade,
  constraint booking_attribution_origination_well_formed
    check (attribution_origination_is_well_formed(basis, source, medium, session_reference, how_heard)),
  constraint booking_attribution_recorded_after_touch
    check (recorded_at >= occurred_at)
);

comment on table booking_attribution is
  'One row per booking: the LAST touch, which is the most recent analytics session that began at or '
  'before the booking was created (ZY692 refuses a later one), or source=offline medium=direct with the '
  'how-heard answer for a walk-in or a telephone booking. A property of the BOOKING and not of the '
  'customer: on the customer, a second booking would overwrite the first booking''s last touch, and that '
  'figure is the denominator of every "which channel produced this sale" report.';

comment on column booking_attribution.source is
  'NOT NULL, and there is no path that leaves it unwritten: createBooking writes this row inside the '
  'booking transaction for every one of the four booking sources, and a booking with no session gets '
  '`offline`. A nullable column would have made "we do not know" and "nobody wrote the row" the same '
  'value, and the coverage figure divides by exactly that distinction.';

create trigger booking_attribution_updated_at before update on booking_attribution
  for each row execute function set_updated_at();

create index booking_attribution_source_idx on booking_attribution (source, medium, occurred_at);

-- ---------------------------------------------------------------------------------------------
-- ZY691 — a first touch may only be replaced by an EARLIER one
-- ---------------------------------------------------------------------------------------------

create function assert_first_touch_only_moves_earlier() returns trigger
language plpgsql
as $$
begin
  if new.occurred_at < old.occurred_at then
    return new;
  end if;
  -- An UPDATE that changes nothing about the claim is permitted, so a writer may re-stamp `recorded_at`
  -- or re-run a converged resolver without a refusal. Compared field by field rather than by row
  -- equality, because `updated_at` changes on every UPDATE by this table's own trigger.
  if new.basis = old.basis
     and new.source = old.source
     and new.medium = old.medium
     and new.campaign = old.campaign
     and new.session_reference is not distinct from old.session_reference
     and new.how_heard is not distinct from old.how_heard
     and new.occurred_at = old.occurred_at then
    return new;
  end if;
  raise exception
    'customer_attribution for customer % holds a first touch of %/% at %, and this would replace it '
    'with %/% at % — a claim that is not EARLIER. A first touch is write-once: the person was found '
    'once, and a resolver re-run over a longer session history converges on the same row rather than '
    'moving it. The one legal replacement is an earlier claim, which is how a customer merge carries '
    'the loser''s earlier first touch onto the survivor.',
    old.customer_id, old.source, old.medium, old.occurred_at,
    new.source, new.medium, new.occurred_at
    using errcode = 'ZY691';
end $$;

comment on function assert_first_touch_only_moves_earlier() is
  'Raises ZY691 when a customer''s first touch would be replaced by one that is not earlier. For every '
  'role including the owner. "Refuse every UPDATE" was the obvious rule and is not available: a '
  'customer merge has to be able to carry the loser''s earlier claim onto the survivor, and this is the '
  'rule that makes write-once and that fold the same rule rather than two.';

create trigger customer_attribution_first_touch_is_write_once
  before update on customer_attribution
  for each row execute function assert_first_touch_only_moves_earlier();

-- ---------------------------------------------------------------------------------------------
-- ZY692 — a booking's last touch may not postdate the booking
-- ---------------------------------------------------------------------------------------------

create function assert_last_touch_precedes_its_booking() returns trigger
language plpgsql
as $$
declare
  v_created_at timestamptz;
begin
  select b.created_at into v_created_at from booking b where b.id = new.booking_id;
  if v_created_at is null then
    -- Unreachable through the foreign key, and written anyway: the FK is NOT VALID-able and a future
    -- `alter table ... drop constraint` would otherwise make this trigger silently permit everything.
    raise exception
      'booking_attribution names booking %, which does not exist, so there is no creation instant to '
      'hold its last touch against.', new.booking_id
      using errcode = 'ZY692';
  end if;
  if new.occurred_at <= v_created_at then
    return new;
  end if;
  raise exception
    'booking_attribution for booking % claims a last touch at %, which is AFTER the booking was '
    'created at %. A session that began after the booking cannot have produced it, and the page a '
    'customer lands on next is usually the confirmation - so this re-attributes a completed sale to '
    'the channel that followed it, and the error is self-reinforcing rather than random.',
    new.booking_id, new.occurred_at, v_created_at
    using errcode = 'ZY692';
end $$;

comment on function assert_last_touch_precedes_its_booking() is
  'Raises ZY692 when a booking''s last touch is dated after the booking itself. A trigger and not a '
  'CHECK, because the creation instant is a row in another table. `<=` and not `<`: a one-page '
  'quick-book takes the booking in the same instant as the session that produced it, and a strict bound '
  'would discard exactly the sessions that convert fastest.';

create trigger booking_attribution_last_touch_precedes_booking
  before insert or update on booking_attribution
  for each row execute function assert_last_touch_precedes_its_booking();

-- ---------------------------------------------------------------------------------------------
-- The merge fold, on `merge_record`
-- ---------------------------------------------------------------------------------------------

create function fold_first_touch_onto_merge_survivor() returns trigger
language plpgsql
as $$
begin
  /*
   * The survivor's row takes the loser's values when the loser's claim is EARLIER. ZY691 permits
   * exactly this UPDATE and refuses every other one, so the rule and the fold are one rule.
   *
   * Nothing happens when the survivor has no row: the participant loop in `applyMergeParticipant` then
   * MOVES the loser's row, which is the ordinary `repoint_update` statement doing the right thing. This
   * trigger exists only for the case that statement cannot express — both records holding a first
   * touch, where the answer is neither "move" nor "skip".
   */
  update customer_attribution s
     set basis             = l.basis,
         source            = l.source,
         medium            = l.medium,
         campaign          = l.campaign,
         session_reference = l.session_reference,
         how_heard         = l.how_heard,
         occurred_at       = l.occurred_at,
         recorded_at       = l.recorded_at
    from customer_attribution l
   where s.customer_id = new.survivor_customer_id
     and l.customer_id = new.loser_customer_id
     and l.occurred_at < s.occurred_at;
  return null;
end $$;

comment on function fold_first_touch_onto_merge_survivor() is
  'Carries the EARLIER of two first touches onto a merge survivor, on the merge_record insert that '
  'opens the merge. The generic repoint_update statement can only move a row or skip it, and the '
  'earlier of two claims is neither; a fifth merge strategy would have widened sql.unsafe''s identifier '
  'grammar and merge_record_table''s balance constraints for one table''s arithmetic. AFTER INSERT, so '
  'it runs before applyMergeParticipant - and it holds for a merge somebody runs in psql too.';

create trigger merge_record_folds_first_touch
  after insert on merge_record
  for each row execute function fold_first_touch_onto_merge_survivor();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 sets default privileges so a later table arrives with select/insert/update/delete for the
-- application role. Stated explicitly rather than relied upon, because a managed database restored from
-- a dump does not necessarily carry the same defaults, and a booking transaction that cannot INSERT
-- here fails in front of a customer.
--
-- DELETE is granted, unlike `flow_enrolment` and `customer_pipeline_card` (0070, 0077), and the reason is
-- C-CRM-10's engine: an erasure runs as `berelax_app` and `public.customer_attribution.customer_id` is
-- classified `delete_row`. Those two tables revoked DELETE on the understanding that removal happens by
-- cascade from `customer`, and the cascade never runs because an erasure cannot delete a customer — a
-- retained tax invoice references it — so both needed a SECURITY DEFINER route added to 0085. Granting it
-- here keeps the erasure a plain statement and keeps 0085's definer function reachable only by the two
-- branch selectors it already has: a definer DELETE should not become reachable by passing a string.
grant select, insert, update, delete on customer_attribution, booking_attribution to berelax_app;
grant execute on function attribution_origination_is_well_formed(text, text, text, uuid, text)
  to berelax_app;

commit;
