-- 0138_dispatch_reconciliation.sql — A-MEAS-07
--
-- The daily comparison between what this business says it took and what an ad platform was told: one
-- summary row per (business_day, destination), and one ITEM row per difference, named by event_id.
--
-- ============================================================================================
-- Why the items are rows and not a jsonb column on the summary
-- ============================================================================================
--
-- The acceptance line is *"reports exactly one missing item, named by event_id, per destination"*. A
-- jsonb array would satisfy a reader and nothing else: the count could not be held against the items by a
-- constraint, the classification could not be constrained to the three the unit declares, and "which
-- conversion is missing" would be a question answered by parsing rather than by a query. The counts on the
-- summary are what a panel renders, so the thing that has to be impossible is a summary that disagrees
-- with its own items — and that is ZY471, below.
--
-- ============================================================================================
-- The three classifications, and why `intentionally_not_pushed` is not a discrepancy
-- ============================================================================================
--
-- `missing`: this business has a conversion and the platform was never successfully told. `duplicate`: it
-- was told twice, and the item carries BOTH dispatch ids, because "there is a duplicate" is not actionable
-- and "these two rows are the same conversion" is. `intentionally_not_pushed`: the visitor did not grant
-- the signal the destination requires, so 0125 wrote the suppression and the push correctly never
-- happened.
--
-- That third one is the reason this table exists in the shape it does. A reconciliation that counted a
-- consent suppression as a discrepancy would report a growing number of "missing" conversions that are
-- exactly right, every day, for ever — and the first response to a number like that is to make it go away.
-- So the suppression is CLASSIFIED and counted, and it does not enter the difference.
--
-- ============================================================================================
-- ZY471 and ZY472, and the eight codes released
-- ============================================================================================
--
-- The band ZY471-ZY480 is this unit's. Two codes are raised and registered; ZY473 through ZY480 are
-- released and deliberately left UNREGISTERED, because `pnpm sqlstate` refuses an entry for a code no
-- migration raises. Both are triggers rather than CHECKs because neither claim is about one row's own
-- columns: one compares a row against the rows of another table, and the other reads the trading calendar.
--
--   * **ZY471 — a summary must agree with its own items.** A deferred constraint trigger, checked at
--     COMMIT, because the summary and its items are written in one transaction and a row-by-row check
--     would fire on the summary before any item existed. This is the rule the whole table rests on: the
--     panel renders the COUNTS, so a summary claiming zero discrepancies while its items hold three is a
--     screen reporting a number that is contradicted by the rows underneath it — and nothing would error.
--   * **ZY472 — a day that has not closed may not be reconciled.** Trading runs 11:00-02:00, so a
--     reconciliation run while the day is still open compares this business's figures against dispatches
--     the consumer has not attempted yet, and reports every one of them as `missing`. The result is not a
--     wrong number in a corner: it is a screen that says the conversions did not go out, on the busiest
--     part of the evening. A CHECK cannot state it, because the closing instant is a row in
--     `business_day`.
--
-- ============================================================================================
-- Idempotent per business day, which is a PRIMARY KEY and not a convention
-- ============================================================================================
--
-- *"two runs produce identical rows"* is the acceptance line. The summary's key is
-- `(business_day, destination)` and the item's is `(business_day, destination, event_id, classification)`,
-- so a second run cannot add a row — it replaces the items for that pair and upserts the summary. An
-- append-only history was the alternative and is wrong here for a reason worth recording: a reconciliation
-- is a QUESTION about a day, asked again whenever the answer might have changed (a failed dispatch is
-- retried, a credit note is raised), and a table of every answer ever given makes "is this day reconciled"
-- a query with an ordering in it. The dispatch rows are the append-only record; this is the current answer
-- about them.
--
-- ============================================================================================
-- The agent, and why a cron
-- ============================================================================================
--
-- `apps/worker/src/job.ts` requires an `agent_definition` on any job with a `cron`, `pnpm jobs` refuses a
-- cron without one, and 0031's convention — restated by 0110, 0122 and 0137 — is that a new agent brings
-- its own `agent_heartbeat` row. Both are below.
--
-- A cron and not a queue, because what is being watched is the ABSENCE of an answer. A reconciliation
-- nobody ran looks exactly like a reconciliation that found nothing, which is this build's defining
-- failure shape (ADR 0002) — and the heartbeat is the one thing that can tell them apart.
--
-- `expected_interval_seconds` is 86400: once a day, after the day has closed. `budget_fils_per_run` is 0
-- because the pass performs no outbound call of any kind: it reads this build's own tables and writes one
-- summary per destination.

begin;

create table analytics_dispatch_reconciliation (
  business_day                  date not null references business_day (trading_date)
                                  on update cascade on delete restrict,
  destination                   text not null references analytics_dispatch_destination (destination),
  /*
   * The four counts a panel renders. `internal_count` is what this business says it took; `pushed_count`
   * is what a platform was successfully told. The three classification counts are DERIVED from the items
   * by the writer and held equal to them by ZY471 — a second statement of a fact, arriving with the check
   * that keeps the two equal, which is the only form in which this build permits one.
   */
  internal_count                integer not null,
  pushed_count                  integer not null,
  missing_count                 integer not null,
  duplicate_count               integer not null,
  intentionally_not_pushed_count integer not null,
  /*
   * The money difference, signed, in fils: what this business took minus what the platform was told.
   *
   * Signed and not an absolute value, because the two directions are different incidents: positive means
   * conversions this business took that a platform does not know about, and negative means a platform was
   * told about revenue the journal cannot produce. An absolute figure would make the second
   * indistinguishable from the first, and the second is the one somebody has to answer for.
   */
  difference_fils               bigint not null,
  /*
   * The state a panel must honour. `unreconciled` exactly when there is something to answer for, which is
   * the CHECK below rather than a field a writer sets independently.
   */
  state                         text not null,
  ran_at                        timestamptz not null,
  created_at                    timestamptz not null default now(),
  primary key (business_day, destination),
  constraint analytics_dispatch_reconciliation_counts_nonneg
    check (internal_count >= 0 and pushed_count >= 0 and missing_count >= 0
           and duplicate_count >= 0 and intentionally_not_pushed_count >= 0),
  constraint analytics_dispatch_reconciliation_state_known
    check (state in ('reconciled', 'unreconciled')),
  /*
   * `unreconciled` exactly when there is a difference or a classified discrepancy.
   *
   * A bijection and not two independent fields, because the state is what a panel branches on and the
   * counts are what it renders: a row saying `reconciled` beside three missing items is a screen that
   * shows a number while the rows underneath it say the number is wrong. `intentionally_not_pushed` is
   * deliberately NOT in this condition — a consent suppression is the system working.
   */
  constraint analytics_dispatch_reconciliation_state_follows_the_figures
    check ((state = 'unreconciled')
           = (difference_fils <> 0 or missing_count > 0 or duplicate_count > 0))
);

comment on table analytics_dispatch_reconciliation is
  'The daily comparison between internal paid conversions and what each destination was actually told '
  '(A-MEAS-07). One row per (business_day, destination), REPLACED on a re-run rather than appended, '
  'because a reconciliation is the current answer to a question about a day and not an event: a table of '
  'every answer ever given makes "is this day reconciled" a query with an ordering in it. The dispatch '
  'rows are the append-only record; this is the answer about them.';
comment on column analytics_dispatch_reconciliation.state is
  'What a downstream panel must honour. `unreconciled` exactly when the difference is non-zero or an item '
  'is classified missing or duplicate - a consent suppression is the system working and does not make a '
  'day unreconciled. The revenue-by-source panel renders an explicit unreconciled state rather than a '
  'number, which is the acceptance line and is why this is a STATE and not a nullable figure.';

create type analytics_dispatch_difference_kind as enum
  ('missing', 'duplicate', 'intentionally_not_pushed');

comment on type analytics_dispatch_difference_kind is
  'How one conversion differs between internal truth and what was pushed. `intentionally_not_pushed` is '
  'not a discrepancy: 0125 wrote a suppression because the visitor did not grant the signal the '
  'destination requires, and counting it as missing would report a growing number of correct refusals as '
  'a fault - and the first response to a number like that is to make it go away.';

create table analytics_dispatch_reconciliation_item (
  business_day   date not null,
  destination    text not null,
  /*
   * The conversion, by the id both surfaces derive (0137). Named by event_id and not by a document number,
   * which is the acceptance line's own wording and also the only identifier that exists on both sides of
   * this comparison.
   */
  event_id       text not null,
  classification analytics_dispatch_difference_kind not null,
  /** The dispatch row this item is about, where there is one. A `missing` item has none, by CHECK. */
  dispatch_id    uuid references analytics_dispatch (dispatch_id) on delete cascade,
  /**
   * The SECOND dispatch row, for a duplicate. Both ids, because "there is a duplicate" is not actionable
   * and "these two rows are the same conversion" is.
   */
  other_dispatch_id uuid references analytics_dispatch (dispatch_id) on delete cascade,
  /** The conversion value this item accounts for, integer fils, signed. Zero for a suppression. */
  value_fils     bigint not null,
  created_at     timestamptz not null default now(),
  primary key (business_day, destination, event_id, classification),
  foreign key (business_day, destination)
    references analytics_dispatch_reconciliation (business_day, destination) on delete cascade,
  -- A missing conversion has no dispatch row to point at; that is what makes it missing.
  constraint analytics_dispatch_reconciliation_item_missing_has_no_row
    check (classification <> 'missing' or (dispatch_id is null and other_dispatch_id is null)),
  -- A duplicate carries two DISTINCT rows. One id twice is one row reported as two.
  constraint analytics_dispatch_reconciliation_item_duplicate_has_two_rows
    check (classification <> 'duplicate'
           or (dispatch_id is not null and other_dispatch_id is not null
               and dispatch_id <> other_dispatch_id)),
  -- A suppression names the row that records it, which is the whole reason 0125 writes one.
  constraint analytics_dispatch_recon_item_suppression_names_its_row
    check (classification <> 'intentionally_not_pushed'
           or (dispatch_id is not null and other_dispatch_id is null))
);

comment on table analytics_dispatch_reconciliation_item is
  'One difference, named by event_id (A-MEAS-07). Rows and not a jsonb array on the summary: a count that '
  'cannot be held against its items by a constraint is a number nobody can check, and ZY471 is what holds '
  'them equal. Keyed on (business_day, destination, event_id, classification) so a second run of the pass '
  'cannot add a row - the acceptance line "two runs produce identical rows" is a PRIMARY KEY here rather '
  'than a convention.';

create index analytics_dispatch_reconciliation_item_event_idx
  on analytics_dispatch_reconciliation_item (event_id);

-- ---------------------------------------------------------------------------------------------
-- ZY471 — a summary must agree with its own items
-- ---------------------------------------------------------------------------------------------

create function assert_reconciliation_agrees_with_its_items() returns trigger
language plpgsql
as $$
declare
  v_missing     integer;
  v_duplicate   integer;
  v_suppressed  integer;
  v_business_day date;
  v_destination  text;
begin
  -- The row this check is about, whichever end of the write it arrived from. A DELETE of the summary takes
  -- its items with it by cascade, so there is nothing left to disagree with.
  if tg_op = 'DELETE' then
    v_business_day := old.business_day;
    v_destination := old.destination;
    if not exists (select 1 from analytics_dispatch_reconciliation r
                    where r.business_day = v_business_day and r.destination = v_destination) then
      return null;
    end if;
  else
    v_business_day := new.business_day;
    v_destination := new.destination;
  end if;

  select count(*) filter (where classification = 'missing'),
         count(*) filter (where classification = 'duplicate'),
         count(*) filter (where classification = 'intentionally_not_pushed')
    into v_missing, v_duplicate, v_suppressed
    from analytics_dispatch_reconciliation_item i
   where i.business_day = v_business_day and i.destination = v_destination;

  if exists (
    select 1
      from analytics_dispatch_reconciliation r
     where r.business_day = v_business_day
       and r.destination = v_destination
       and (r.missing_count <> v_missing
            or r.duplicate_count <> v_duplicate
            or r.intentionally_not_pushed_count <> v_suppressed)
  ) then
    raise exception
      'The reconciliation for % / % does not agree with its own items: the items hold % missing, % '
      'duplicate and % intentionally-not-pushed. The panel renders the COUNTS, so a summary that '
      'disagrees with the rows underneath it is a screen showing a number those rows contradict - and '
      'nothing else would error.',
      v_business_day, v_destination, v_missing, v_duplicate, v_suppressed
      using errcode = 'ZY471';
  end if;
  return null;
end $$;

comment on function assert_reconciliation_agrees_with_its_items() is
  'Raises ZY471 at COMMIT when a reconciliation summary''s counts disagree with its own item rows. '
  'DEFERRED, because the summary and its items are written in one transaction and a row-by-row check '
  'would fire on the summary before any item existed. For every role including the owner: the counts are '
  'what a panel renders.';

create constraint trigger analytics_dispatch_reconciliation_agrees
  after insert or update or delete on analytics_dispatch_reconciliation
  deferrable initially deferred
  for each row execute function assert_reconciliation_agrees_with_its_items();

create constraint trigger analytics_dispatch_reconciliation_item_agrees
  after insert or update or delete on analytics_dispatch_reconciliation_item
  deferrable initially deferred
  for each row execute function assert_reconciliation_agrees_with_its_items();

-- ---------------------------------------------------------------------------------------------
-- ZY472 — a day that has not closed may not be reconciled
-- ---------------------------------------------------------------------------------------------

create function assert_reconciled_day_has_closed() returns trigger
language plpgsql
as $$
declare
  v_closes_at timestamptz;
begin
  select closes_at into v_closes_at
    from business_day
   where trading_date = new.business_day;
  if not found then
    -- Unreachable while the foreign key stands, and written anyway: a BEFORE trigger runs before the row's
    -- foreign keys are checked, which 0125 recorded as the branch that actually fires.
    raise exception
      'A reconciliation names trading date %, which the trading calendar does not hold, so there is no '
      'closing instant against which to judge whether the day is over.', new.business_day
      using errcode = 'ZY472';
  end if;
  if new.ran_at >= v_closes_at then
    return new;
  end if;
  raise exception
    'The reconciliation for % was run at %, before the day closed at %. Trading runs 11:00-02:00, so a '
    'run while the day is still open compares this business''s figures against dispatches the consumer '
    'has not attempted yet and reports every one of them as missing - a screen saying the conversions did '
    'not go out, on the busiest part of the evening.',
    new.business_day, new.ran_at, v_closes_at
    using errcode = 'ZY472';
end $$;

comment on function assert_reconciled_day_has_closed() is
  'Raises ZY472 when a reconciliation is written for a trading day that had not closed at the instant it '
  'claims to have run. A CHECK cannot state it: the closing instant is a row in business_day.';

create trigger analytics_dispatch_reconciliation_day_has_closed
  before insert or update on analytics_dispatch_reconciliation
  for each row execute function assert_reconciled_day_has_closed();

-- ---------------------------------------------------------------------------------------------
-- The pass's agent, and its heartbeat row
-- ---------------------------------------------------------------------------------------------

insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('dispatch_reconciliation', 'Dispatch reconciliation',
   'Compares each closed trading day''s internal paid conversions against what each destination was '
   'actually told, classifying every difference as missing, duplicate or intentionally not pushed by '
   'consent, and writing one summary per destination that downstream panels must honour. It performs no '
   'outbound call: it reads this build''s own tables, so the budget is 0 (A-MEAS-07, ADR 0093).',
   86400, 0)
on conflict (agent_key) do nothing;

-- Its heartbeat row, because `agentsWithHeartbeat` INNER JOINS the two: a definition with no heartbeat row
-- is an agent the watchdog cannot see at all. 0031's convention; 0107 shipped one without it and nothing
-- caught it until a suite read the table.
insert into agent_heartbeat (agent_key)
values ('dispatch_reconciliation')
on conflict (agent_key) do nothing;

commit;
