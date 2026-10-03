-- 0153 — the parallel run: a paper count is a named person's CLAIM, a day outside the window has no
--        figure, and the rollback decision is a human's claim that nothing in this build makes.
--
-- H-MIG-10. Three tables, one view and six refusals, and the whole file follows from one sentence: during
-- a parallel run NOTHING in this system can see the paper day sheet, so every figure this schema holds
-- about it is somebody's assertion and has to be stored as one.
--
-- ## Why the paper count is a separate table from the reconciliation
--
-- The reconciliation is a MEASUREMENT the daily job makes: it counts what the system holds for a trading
-- date and compares it with what the paper said. The paper count is a CLAIM a person makes: they read a
-- sheet of paper and typed a number. Those are different kinds of fact with different authors, and the
-- first version of this migration had them on one row — at which point the job, which is `actor_kind =
-- 'system'`, would have had to write a column whose whole value is that a named person stood behind it.
--
-- Separating them also decides what happens on a day inside the window with no paper count recorded, and
-- that is the acceptance line's own wording: the job emits NOTHING for that day rather than a row with
-- `paper_count = 0`. A zero there is indistinguishable from "the paper and the system agreed that nothing
-- happened", and the whole point of a parallel run is the days where they disagree (ADR 0070: an
-- unattributable figure is a refusal and never a zero).
--
-- ## Why the difference and the state are in a VIEW and not on a row
--
-- `parallel_run_variance` joins the claim to the measurement and computes `difference` and `state`. There
-- is therefore exactly ONE statement of what the difference is and exactly one of when a day counts as
-- unreconciled, and nothing to hold equal — where a persisted `paper_count` on the reconciliation row
-- would have been a second copy of the claim, needing a deferred trigger to keep it in step with the
-- claim it copied. `0138_dispatch_reconciliation.sql` persisted its counts and paid for it with ZY471;
-- it had to, because its items are rows of its own, and this one does not.
--
-- ## What this file deliberately does NOT do
--
-- It does not decide the rollback. `parallel_run_decision.decision` is a free column over two values and
-- no trigger computes it, no view recommends it and no job writes one. A mechanism that decided to roll
-- back — or not to — from the variance rows would be this build deciding, on a rule nobody wrote down,
-- whether a business cuts over to it. What the schema does instead is make the decision ATTRIBUTABLE and
-- its evidence PERMANENT: ZY744 refuses a decision no named person is behind, ZY745 makes it
-- append-only, and ZY746 holds the `unreconciled_days` figure on it equal to the rows it claims to
-- summarise — so "proceeded while four days were unexplained" is a fact nobody can lose.
--
-- It also invents no date. The window is two SETTINGS with NO default
-- (`migration.parallel_run_window_start`, `migration.parallel_run_window_end`, both null, provisional
-- against Y8-parallel-run-window), and the reconciliation refuses to run at all while they are unset. A
-- plausible cutover date here would be indistinguishable from a configured one (brief rule 15), and the
-- window decides which days the comparison is about.
--
-- ## The codes
--
-- ZY741 — a reconciliation dated outside the window it names.
-- ZY742 — a paper count that no named person is behind, refused at COMMIT.
-- ZY743 — a paper count is append-only.
-- ZY744 — a rollback decision that no named person is behind, refused at COMMIT.
-- ZY745 — a rollback decision is append-only.
-- ZY746 — a decision's unreconciled-day count must equal the rows it summarises, refused at COMMIT.
--
-- ZY747 through ZY750 are released UNUSED and deliberately unregistered: `pnpm sqlstate` refuses an entry
-- for a code no migration raises.

begin;

-- ---------------------------------------------------------------------------------------------
-- The paper day sheet: a named person's claim about a trading date
-- ---------------------------------------------------------------------------------------------

create table parallel_run_paper_count (
  business_day   date        primary key references business_day (trading_date)
                   on update cascade on delete restrict,
  /*
    How many treatments the paper day sheet recorded for that trading date.

    `>= 0` and not `> 0`: a day on which the salon traded and nobody wrote anything down is a real
    reading of a real sheet, and it is exactly the day a parallel run exists to find. What is refused is
    the ABSENCE of a reading masquerading as a zero, and that is refused by there being no row.
  */
  sheet_count    integer     not null check (sheet_count >= 0),
  /*
    Who read the sheet and said so, as they identify themselves.

    Nothing in this build has seen the paper. This column is the whole reason the table exists: a row
    saying only *the paper said 37* is a figure nobody is answerable for, and the first question asked of
    it — *who counted?* — would have no answer. 0128's argument for `posted_manually_at`, in the one other
    place this build records a claim about the outside world.

    `is_placeholder_text` (0026) is refused, because a provisional marker here would be a count attributed
    to a label rather than to a person.
  */
  counted_by     text        not null
                   constraint parallel_run_paper_count_counter_is_stated
                     check (btrim(counted_by) <> '' and length(counted_by) <= 200)
                   constraint parallel_run_paper_count_counter_not_placeholder
                     check (not is_placeholder_text(counted_by)),
  /** Anything the counter wants on the record: a torn sheet, two sheets, a shift that overran. */
  note           text,
  created_at     timestamptz not null default now()
);

comment on table parallel_run_paper_count is
  'What the paper day sheet said for one trading date, and who read it. A CLAIM about the outside world: '
  'nothing in this build can see the sheet. Append-only (ZY743) and attributable to a named staff actor '
  'at COMMIT (ZY742). A day with no row has no paper figure, which is why the reconciliation emits '
  'nothing for it rather than a zero.';

-- ---------------------------------------------------------------------------------------------
-- The reconciliation: what the system holds, measured by the daily job
-- ---------------------------------------------------------------------------------------------

create table parallel_run_reconciliation (
  business_day   date        primary key
                   references parallel_run_paper_count (business_day)
                   on update cascade on delete restrict,
  /*
    What the SYSTEM holds for that trading date, counted by the job.

    Keyed to the paper count rather than to `business_day` directly, which is the FK that makes "one
    variance row per business_day comparing the paper count with the system count" true by construction:
    a reconciliation cannot exist without the claim it is a comparison against.
  */
  system_count   integer     not null check (system_count >= 0),
  /*
    The window this run was judged against, as the settings held it at the time.

    Recorded on the row rather than read back from the settings, for the reason every reproducible figure
    in this build carries the version that judged it: the window is two editable settings, and a
    reconciliation nobody can attribute to the window in force when it ran is a figure nobody can defend
    once the window moves. ZY741 refuses a row whose own day falls outside its own window.
  */
  window_start   date        not null,
  window_end     date        not null,
  /** When the job ran. Never the trading date, and never the instant a reader asks. */
  ran_at         timestamptz not null,
  created_at     timestamptz not null default now(),
  constraint parallel_run_reconciliation_window_is_ordered check (window_start <= window_end)
);

comment on table parallel_run_reconciliation is
  'What the system held for one trading date, measured by the daily job, beside the window it was judged '
  'against. The difference and the state are in parallel_run_variance and are stated nowhere else. '
  'Upsertable per day on purpose: a reconciliation is the current answer to a question about a day, '
  'asked again whenever the answer might have changed.';

comment on column parallel_run_reconciliation.system_count is
  'Counted by apps/worker/src/jobs/parallel-run-reconcile.ts from the appointments the system holds for '
  'that trading date. A measurement, not a claim — which is why it is on this table and the paper figure '
  'is on the other one.';

-- ---------------------------------------------------------------------------------------------
-- ZY741 — a reconciliation may not be dated outside the window it names
-- ---------------------------------------------------------------------------------------------

create or replace function assert_parallel_run_day_is_in_the_window()
returns trigger
language plpgsql
as $$
begin
  if new.business_day between new.window_start and new.window_end then
    return new;
  end if;
  raise exception
    'ParallelRunDayOutsideWindow: % is outside the parallel-run window % to % that this row names. A '
    'reconciliation for a day outside the window is refused rather than reported, because the figure it '
    'would carry is a misleading zero: before the window the system was not recording, after it the '
    'paper sheet was not, and in both cases "the paper and the system agree" is a statement about which '
    'of the two was switched off. The window is migration.parallel_run_window_start and '
    'migration.parallel_run_window_end, both unset until Y8-parallel-run-window is answered.',
    new.business_day, new.window_start, new.window_end
    using errcode = 'ZY741';
end $$;

comment on function assert_parallel_run_day_is_in_the_window() is
  'Raises ZY741 for a parallel_run_reconciliation row whose business_day is outside the window on the '
  'row. A TRIGGER and not a CHECK so the message can name the two setting keys and the open question, '
  'which is what a reader at 02:00 needs and what a CHECK violation cannot carry.';

create trigger parallel_run_reconciliation_day_is_in_the_window
  before insert or update on parallel_run_reconciliation
  for each row execute function assert_parallel_run_day_is_in_the_window();

-- ---------------------------------------------------------------------------------------------
-- ZY742 — a paper count is a named human's claim, audited in the same transaction
-- ---------------------------------------------------------------------------------------------

create or replace function assert_paper_count_is_a_claim()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from audit_event
              where entity_type = 'parallel_run_paper_count'
                and entity_id = new.business_day::text
                and action = 'migration.parallel_run.paper_count_recorded'
                and actor_kind = 'staff'
                and actor_id is not null) then
    return null;
  end if;
  raise exception
    'PaperCountIsNotAttributed: the paper count for % reached COMMIT with no '
    'audit_event(action=migration.parallel_run.paper_count_recorded, '
    'entity_type=parallel_run_paper_count, entity_id=%, actor_kind=staff, actor_id not null) in the same '
    'transaction. Nothing in this build can see the paper day sheet, so this row records that a NAMED '
    'PERSON read it — and without the actor it records that somebody did.',
    new.business_day, new.business_day
    using errcode = 'ZY742';
end $$;

comment on function assert_paper_count_is_a_claim() is
  'Raises ZY742 at COMMIT when a paper count has no audit_event in the same transaction attributing it to '
  'a named staff actor. A deferrable constraint trigger, so the audit row may be written either side of '
  'the insert and neither in a later transaction (ZZ004''s and ZY341''s shape).';

create constraint trigger parallel_run_paper_count_is_a_claim
  after insert on parallel_run_paper_count
  deferrable initially deferred
  for each row execute function assert_paper_count_is_a_claim();

-- ---------------------------------------------------------------------------------------------
-- ZY743 — a paper count is append-only
-- ---------------------------------------------------------------------------------------------

create or replace function refuse_paper_count_change()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'PaperCountIsAppendOnly: the paper count for % may not be %d. It is the record of what a named person '
    'said a sheet of paper held, and a claim that can be rewritten is not a record of what was claimed. A '
    'correction is a new count for a new window, with whoever made it.',
    coalesce(old.business_day, new.business_day), lower(tg_op)
    using errcode = 'ZY743';
end $$;

comment on function refuse_paper_count_change() is
  'Raises ZY743 on any UPDATE or DELETE of parallel_run_paper_count. The privilege is not the rule: a '
  'migration, a psql session or a role added later is outside a REVOKE, and ZY742 fires on INSERT only.';

create trigger parallel_run_paper_count_no_update before update on parallel_run_paper_count
  for each row execute function refuse_paper_count_change();
create trigger parallel_run_paper_count_no_delete before delete on parallel_run_paper_count
  for each row execute function refuse_paper_count_change();

-- ---------------------------------------------------------------------------------------------
-- The one statement of the difference and of what "unreconciled" means
-- ---------------------------------------------------------------------------------------------

create view parallel_run_variance as
  select p.business_day                                 as business_day,
         p.sheet_count                                  as paper_count,
         p.counted_by                                   as counted_by,
         r.system_count                                 as system_count,
         -- SIGNED, and the two directions are different incidents: positive means treatments the paper
         -- recorded that the system does not hold, which is work this business did and cannot bill or
         -- report on; negative means the system holds a treatment no sheet recorded. An absolute figure
         -- would make the second indistinguishable from the first, and the first is the one that loses
         -- money. 0138's argument about difference_fils, one grain up.
         (p.sheet_count - r.system_count)               as difference,
         case when p.sheet_count = r.system_count then 'reconciled' else 'unreconciled' end as state,
         r.window_start                                 as window_start,
         r.window_end                                   as window_end,
         r.ran_at                                       as ran_at
    from parallel_run_paper_count p
    join parallel_run_reconciliation r on r.business_day = p.business_day;

comment on view parallel_run_variance is
  'One variance row per business_day of the parallel run: the paper count, who counted it, the system '
  'count, the SIGNED difference and the state. The only statement of the difference and of what '
  'unreconciled means, so nothing can disagree with it. A day with a paper count and no reconciliation, '
  'or a reconciliation and no paper count, is ABSENT rather than shown with a zero.';

-- ---------------------------------------------------------------------------------------------
-- The rollback decision: a named human's claim, and nothing here makes it
-- ---------------------------------------------------------------------------------------------

create table parallel_run_decision (
  id                  uuid        primary key default uuid_generate_v7(),
  /*
    What was decided, and there are exactly two answers.

    A free column over two values. NOTHING in this build computes it: no trigger derives it from the
    variance rows, no view recommends one, and no job writes a row. Deciding whether a business cuts over
    to this system — or goes back to paper — from a rule nobody wrote down is the one thing this schema
    must not do, and the absence of that mechanism is the decision this table records.
  */
  decision            text        not null
                        constraint parallel_run_decision_is_one_of_two
                          check (decision in ('proceed', 'roll_back')),
  /** The instant the person decided. Never the instant a row was written by something else. */
  decided_at          timestamptz not null,
  /** Who decided, as they identify themselves. The reason this is a claim and not an observation. */
  decided_by          text        not null
                        constraint parallel_run_decision_decider_is_stated
                          check (btrim(decided_by) <> '' and length(decided_by) <= 200)
                        constraint parallel_run_decision_decider_not_placeholder
                          check (not is_placeholder_text(decided_by)),
  /** Why, in their words. `not null` because a decision with no reason cannot be reviewed. */
  rationale           text        not null
                        constraint parallel_run_decision_rationale_is_stated
                          check (btrim(rationale) <> ''),
  /** The last trading date the decision was taken in the light of. */
  as_of_business_day  date        not null references business_day (trading_date)
                        on update cascade on delete restrict,
  /*
    How many days up to and including `as_of_business_day` were unreconciled when the decision was made.

    The EVIDENCE, held equal to the rows by ZY746 rather than taken on trust. A count that nothing can
    check is a number nobody can act on, and the reason to carry it at all is that the variance rows are
    upsertable: a day corrected after the fact would otherwise silently change what the decision looks
    like it was taken in the light of. Recording it here makes "proceeded while four days were
    unexplained" permanent.
  */
  unreconciled_days   integer     not null check (unreconciled_days >= 0),
  created_at          timestamptz not null default now()
);

comment on table parallel_run_decision is
  'The cutover-or-roll-back decision, as a named person''s CLAIM with when they made it, why, and how '
  'many days were unreconciled at the time. Nothing in this build decides it: `decision` is a free '
  'column, no trigger computes it and no job writes a row. Append-only (ZY745), attributable at COMMIT '
  '(ZY744), and its evidence held to the rows (ZY746).';

create index parallel_run_decision_decided on parallel_run_decision (decided_at desc);

-- ---------------------------------------------------------------------------------------------
-- ZY744 — a rollback decision is a named human's claim, audited in the same transaction
-- ---------------------------------------------------------------------------------------------

create or replace function assert_parallel_run_decision_is_a_claim()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from audit_event
              where entity_type = 'parallel_run_decision'
                and entity_id = new.id::text
                and action = 'migration.parallel_run.decision_recorded'
                and actor_kind = 'staff'
                and actor_id is not null) then
    return null;
  end if;
  raise exception
    'ParallelRunDecisionIsNotAttributed: decision % reached COMMIT with no '
    'audit_event(action=migration.parallel_run.decision_recorded, entity_type=parallel_run_decision, '
    'entity_id=%, actor_kind=staff, actor_id not null) in the same transaction. Whether this business '
    'cuts over or goes back to paper is a person''s decision, and a row that records the decision '
    'without the person records that it was taken by the system.',
    new.id, new.id
    using errcode = 'ZY744';
end $$;

comment on function assert_parallel_run_decision_is_a_claim() is
  'Raises ZY744 at COMMIT when a parallel_run_decision has no audit_event in the same transaction '
  'attributing it to a named staff actor. An agent or the system claiming to have decided a cutover '
  'would be a machine''s claim about a human act (ZY341''s wording, one subject along).';

create constraint trigger parallel_run_decision_is_a_claim
  after insert on parallel_run_decision
  deferrable initially deferred
  for each row execute function assert_parallel_run_decision_is_a_claim();

-- ---------------------------------------------------------------------------------------------
-- ZY745 — a rollback decision is append-only
-- ---------------------------------------------------------------------------------------------

create or replace function refuse_parallel_run_decision_change()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'ParallelRunDecisionIsAppendOnly: decision % may not be %d. Changing one''s mind is a NEW decision '
    'with its own instant, its own decider and its own evidence — editing this row would leave no record '
    'that the first decision was ever taken, which is the only thing a reviewer will want to know.',
    coalesce(old.id, new.id), lower(tg_op)
    using errcode = 'ZY745';
end $$;

comment on function refuse_parallel_run_decision_change() is
  'Raises ZY745 on any UPDATE or DELETE of parallel_run_decision. ZY744 is DEFERRED and fires on INSERT, '
  'so an UPDATE afterwards would change what was decided with nothing re-attributing it.';

create trigger parallel_run_decision_no_update before update on parallel_run_decision
  for each row execute function refuse_parallel_run_decision_change();
create trigger parallel_run_decision_no_delete before delete on parallel_run_decision
  for each row execute function refuse_parallel_run_decision_change();

-- ---------------------------------------------------------------------------------------------
-- ZY746 — the decision's evidence must equal the rows it claims to summarise
-- ---------------------------------------------------------------------------------------------

create or replace function assert_parallel_run_decision_evidence()
returns trigger
language plpgsql
as $$
declare
  actual integer;
begin
  select count(*)::integer into actual
    from parallel_run_variance
   where state = 'unreconciled'
     and business_day <= new.as_of_business_day;
  if actual = new.unreconciled_days then
    return null;
  end if;
  raise exception
    'ParallelRunDecisionEvidenceDisagrees: decision % records % unreconciled day(s) up to % and the '
    'variance rows hold %. The figure is the evidence the decision was taken in the light of, and a '
    'count nothing can check is a number nobody can act on.',
    new.id, new.unreconciled_days, new.as_of_business_day, actual
    using errcode = 'ZY746';
end $$;

comment on function assert_parallel_run_decision_evidence() is
  'Raises ZY746 at COMMIT when parallel_run_decision.unreconciled_days disagrees with the variance rows '
  'up to as_of_business_day. DEFERRED, because the writer may record the decision and the last day''s '
  'reconciliation in one transaction and a row-by-row check would let the ORDER decide whether the rule '
  'held (ZY471''s reason).';

create constraint trigger parallel_run_decision_evidence_ties_to_the_rows
  after insert on parallel_run_decision
  deferrable initially deferred
  for each row execute function assert_parallel_run_decision_evidence();

-- ---------------------------------------------------------------------------------------------
-- The agent the daily pass reports to
-- ---------------------------------------------------------------------------------------------
--
-- `apps/worker/src/job.ts` requires an `agent_definition` on any job with a `cron`, `pnpm jobs` refuses a
-- cron without one, and 0031's convention is that a new agent brings its own `agent_heartbeat` row.
--
-- A cron and not a queue, for 0138's reason in the sharpest form this build has: what is being watched is
-- the ABSENCE of an answer. A parallel-run reconciliation nobody ran looks exactly like a parallel run in
-- which the paper and the system agreed every day — and that is the figure a cutover decision rests on.

insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('parallel_run_reconciliation', 'Parallel-run reconciliation',
   'Compares each closed trading day of the parallel-run window against the paper day-sheet count a '
   'named person recorded for it, writing one variance row per day and flagging any non-zero '
   'difference. It emits NOTHING for a day nobody has counted and refuses a day outside the window, '
   'because a zero there is indistinguishable from agreement. It performs no outbound call: it reads '
   'this build''s own tables, so the budget is 0 (H-MIG-10, ADR 0107).',
   86400, 0)
on conflict (agent_key) do nothing;

insert into agent_heartbeat (agent_key)
values ('parallel_run_reconciliation')
on conflict (agent_key) do nothing;

commit;
