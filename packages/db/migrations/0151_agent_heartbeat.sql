-- 0151_agent_heartbeat.sql — A-MEAS-06
--
-- The fourth heartbeat field, the dead-letter state, and the agent A-MEAS-05 was handed no migration
-- number for.
--
-- ============================================================================================
-- `next_run_at` is the fourth field, and the CHECK is what makes "on every run" structural
-- ============================================================================================
--
-- 0021 created `agent_heartbeat` with `last_run_at`, `last_success_at`, `last_failure_at`, `last_error`,
-- `last_outcome` and `consecutive_failures`. A-MEAS-06's acceptance line names four fields, and
-- `next_run_at` is the one that was missing — the one an operator actually reads, because "last run two
-- minutes ago" says nothing without "next run in three".
--
-- It is paired to `last_run_at` by a CHECK, in both directions, and that is the point rather than tidiness:
-- *"both write all four heartbeat fields on every run, on the success and the failure path"* is a claim
-- about a writer, and a claim about a writer is a thing somebody forgets. With
-- `(last_run_at is null) = (next_run_at is null)` a writer that recorded an attempt without saying when
-- the next one is due is REFUSED, so the claim holds for the two analytics agents, for the other nine, and
-- for a psql session.
--
-- The value is `last_run_at + expected_interval_seconds` from `agent_definition` — the agent's own
-- declared interval, which is the same figure the watchdog doubles. Nothing is invented: there is no
-- second schedule here, and a cron expression is NOT consulted, because the registry's expression and the
-- declared interval are already held equal by `pnpm jobs` and a third derivation would be a third answer.
--
-- ============================================================================================
-- `dead_letter`: a permanent failure that is VISIBLE rather than a row that looks retryable
-- ============================================================================================
--
-- 0137 gave `analytics_dispatch` a `failed` state and a retry ladder, and the way a dispatch gives up is
-- that its attempt counter passes the end of the ladder — `dueAnalyticsDispatches` then never selects it
-- again. 0137's own comment calls that *"a state somebody can see"*, and it is not one: the row still says
-- `failed`, exactly like a row that will be retried in four minutes, and the only way to tell them apart
-- is to compare `attempts` against a ladder that lives in TypeScript. A console cannot do that, a `where`
-- clause cannot do that, and an operator reading the table certainly cannot.
--
-- So giving up is a STATE. `dead_letter` is terminal in the same sense `sent` is: the consumer will not
-- pick it up, the reason is on the row, and the last thing the provider said is on the row beside it.
--
-- Three constraints follow, and the first two are 0125's bijection extended rather than relaxed:
--
--   * `analytics_dispatch_reason_iff_refused` gains `dead_letter`, so a live row still has no reason and
--     every refused row still has one;
--   * `analytics_dispatch_outcome_had_an_attempt` gains it too — a dead letter with no attempt behind it
--     is a row somebody wrote by hand;
--   * `analytics_dispatch_dead_letter_carries_its_error` is a fourth narrow sibling beside 0137's three,
--     for 0137's stated reason: three narrow rules fail by name where one alternation fails by saying a
--     row is wrong. A dead letter with no provider error is indistinguishable from a consumer that
--     stopped running, which is the whole shape of failure this table set exists to remove.
--
-- **`dead_letter` is reachable only through the retry budget, and a dead letter may still be re-queued.**
-- That second half is deliberate and is not a loophole: the ZY312 consent gate fires on the UPDATE back to
-- `queued` (ADR 0091), so an operator who fixes a destination and re-opens a dead letter is re-judged
-- against the visitor's consent as it stands THEN. A terminal state that could not be re-opened would
-- make the only remedy a second row, and the unique `(event_id, destination)` index refuses that — so the
-- conversion would be unsendable for ever by a rule nobody chose.
--
-- ============================================================================================
-- Who reads the dead-letter queue, and why that question is part of the migration
-- ============================================================================================
--
-- `apps/web/app/(admin)/agents/queries.ts` — `deadLetteredDispatches` and `agentConsoleRows` — and the
-- watchdog's own pass, which counts them into the alert detail. A dead-letter queue nothing reads is the
-- same defect one level down from a watchdog nothing watches: the row exists, the failure is recorded, and
-- nobody is told. The console query is this migration's reason for existing as much as the enum label is.
--
-- ============================================================================================
-- ZY711, and the nine codes released
-- ============================================================================================
--
-- The band ZY711-ZY720 is this unit's. ONE code is raised and registered; ZY712 through ZY720 are
-- released and deliberately left UNREGISTERED, because `pnpm sqlstate` refuses an entry for a code no
-- migration raises.
--
--   * **ZY711 — a dead-lettered dispatch may not be deleted ON ITS OWN.** For every role including the
--     owner. The row IS the record that a conversion was permanently not delivered, and A-MEAS-07
--     reconciles against exactly that: a deleted dead letter makes a conversion the platform never heard
--     about indistinguishable from one nobody enqueued, and the reconciliation then reports the day as
--     agreeing. The acceptance line asks for "a test asserts the row is never deleted"; this makes it a
--     property of the schema instead, which is the stronger form of the same claim.
--
--     **A CASCADE from `analytics.session` is permitted, and the first version of this trigger did not
--     make that distinction.** 0125 keys the dispatch with `on delete cascade` so the ninety-day purge
--     takes it with the session; a row trigger fires on that cascade exactly as on a direct delete, so
--     refusing both would have stopped `analytics.run_retention` on the first dead letter it reached — a
--     privacy failure dressed as an integrity rule — and refused every integration suite's visitor
--     cleanup besides. PostgreSQL applies the parent delete before the referential action, so inside the
--     trigger the session is GONE for a cascade and PRESENT for a direct delete. That is the
--     discriminator, and it states the rule exactly: a dead letter may not be deleted by itself, and it
--     goes with its session when the session goes.
-- It is a trigger because it fires on DELETE, which a CHECK cannot see.
--
-- **A `last_success_at` monotonicity trigger was written, applied and REMOVED, and the removal is the
-- decision.** ZY712 would have refused a heartbeat whose last success moved BACKWARDS, by the same
-- argument ZY452 makes for the attempt counter: the watchdog measures silence from
-- `greatest(last_success_at, enabled_since)`, so a backwards move manufactures a silence that did not
-- happen. It was wrong here, and the existing watchdog suite said so immediately — sixteen of its cases
-- failed, because every one of them simulates silence by moving that column back.
--
-- That is not a test problem. `agent_heartbeat` is not a ledger: it is the CURRENT state of an agent, and
-- the only direction an earlier instant moves the answer is towards OVERDUE — the safe direction, and the
-- one that makes somebody look. A rule refusing it would have protected a column whose single consumer
-- already treats "earlier" as "more alarming", at the cost of the suite that proves the watchdog works at
-- all. So ZY712 through ZY720 are released UNUSED and deliberately unregistered.

-- ---------------------------------------------------------------------------------------------
-- The new enum label — OUTSIDE the transaction, 0137's convention
-- ---------------------------------------------------------------------------------------------
-- `alter type ... add value` is legal inside a transaction block, but the new label may not be USED until
-- that transaction commits, and the block below writes `dead_letter` into three CHECK constraints.
-- `psql -f` sends statements in autocommit, so this one commits on its own. `if not exists` because this
-- is the statement a re-run reaches.
alter type analytics_dispatch_state add value if not exists 'dead_letter';

begin;

comment on type analytics_dispatch_state is
  'Where a dispatch is in its life. `suppressed` was never enqueued - the row exists so the refusal is '
  'VISIBLE rather than silent - `cancelled_consent_withdrawn` was queued when the visitor changed their '
  'mind, `failed` (0137) is one the transport did not accept and will be retried, and `dead_letter` '
  '(0151) is one whose retry budget is exhausted. `sent` and `dead_letter` are the two states the '
  'consumer will not pick up; `dead_letter` can still be re-queued by an operator, and the ZY312 gate '
  're-judges consent on the way, which is why it is terminal without being a dead end.';

-- ---------------------------------------------------------------------------------------------
-- next_run_at
-- ---------------------------------------------------------------------------------------------

alter table agent_heartbeat add column next_run_at timestamptz;

comment on column agent_heartbeat.next_run_at is
  'When the next run is expected: `last_run_at` plus the agent''s own declared '
  '`expected_interval_seconds`, which is the same figure the watchdog doubles. The field an operator '
  'actually reads - "last run two minutes ago" says nothing without "next run in three" - and the one a '
  'console needs to tell a slow agent from a stopped one before the watchdog''s 2x window has passed.';

/*
 * Paired to `last_run_at` in BOTH directions.
 *
 * "Every agent writes all four fields on every run" is a claim about a writer, and a claim about a writer
 * is a thing somebody forgets — so this makes it unrepresentable instead: an attempt recorded without the
 * next run's instant is refused, for every role, and a `next_run_at` on an agent that has never run is a
 * schedule for a thing that has not started.
 *
 * It holds for the rows 0021 seeded, which have both columns null.
 */
alter table agent_heartbeat
  add constraint agent_heartbeat_next_run_accompanies_a_run
  check ((last_run_at is null) = (next_run_at is null));

-- ---------------------------------------------------------------------------------------------
-- The dead-letter state
-- ---------------------------------------------------------------------------------------------

alter table analytics_dispatch drop constraint analytics_dispatch_reason_iff_refused;
alter table analytics_dispatch add constraint analytics_dispatch_reason_iff_refused
  check ((state in ('suppressed', 'cancelled_consent_withdrawn', 'failed', 'dead_letter'))
         = (reason is not null));

alter table analytics_dispatch drop constraint analytics_dispatch_outcome_had_an_attempt;
alter table analytics_dispatch add constraint analytics_dispatch_outcome_had_an_attempt
  check (state not in ('sent', 'failed', 'dead_letter') or attempts > 0);

-- The fourth narrow sibling beside 0137's three. A dead letter with no provider error is
-- indistinguishable from a consumer that stopped running.
alter table analytics_dispatch add constraint analytics_dispatch_dead_letter_carries_its_error
  check ((state = 'dead_letter') <= (last_error is not null));

alter table analytics_dispatch add constraint analytics_dispatch_dead_letter_is_a_transport_failure
  check (state <> 'dead_letter' or reason = 'transport_failed');

comment on column analytics_dispatch.last_error is
  'What the transport said the last time it refused. NOT NULL for `failed` and for `dead_letter` by '
  'CHECK, because a failure with no message is indistinguishable from a consumer that stopped running - '
  'and for a dead letter it is the only record of WHY the conversion will never go out.';

-- The console's own read: what has given up, newest first. A partial index, because a dead letter is rare
-- and the question "what has given up" is asked on every console render.
create index analytics_dispatch_dead_letter_idx on analytics_dispatch (decided_at desc)
  where state = 'dead_letter';

comment on index analytics_dispatch_dead_letter_idx is
  'The agent console''s read (apps/web/app/(admin)/agents/queries.ts). A dead-letter queue nothing reads '
  'is the same defect one level down from a watchdog nothing watches, so the reader is named here.';

-- ---------------------------------------------------------------------------------------------
-- ZY711 — a dead-lettered dispatch may not be deleted
-- ---------------------------------------------------------------------------------------------

create function refuse_dead_letter_delete() returns trigger
language plpgsql
as $$
declare
  v_session_survives boolean;
begin
  if old.state <> 'dead_letter' then
    return old;
  end if;
  /*
   * The one distinction that makes this rule correct rather than merely strict: is this dispatch being
   * deleted ON ITS OWN, or is it going WITH its session?
   *
   * 0125 keys `analytics_dispatch.session_id` with `on delete cascade` so that the ninety-day purge of a
   * session takes its dispatches with it. A row trigger fires on that cascade exactly as it fires on a
   * direct `delete`, so a rule that refused both would break `analytics.run_retention` — the pass would
   * raise on the first dead letter it reached and the whole window would stop being purged, which is a
   * privacy failure dressed as an integrity rule. It would also refuse every integration suite's visitor
   * cleanup, for the same reason and with the same shape.
   *
   * PostgreSQL applies the parent's delete before the referential action runs, so inside this trigger the
   * session is GONE for a cascade and PRESENT for a direct delete. That is the discriminator, and it is
   * the semantics the rule wants stated exactly: a dead letter may not be deleted by itself, and it goes
   * with its session when the session goes.
   */
  select exists (select 1 from analytics.session s where s.session_id = old.session_id)
    into v_session_survives;
  if not v_session_survives then
    return old;
  end if;
  raise exception
    'analytics_dispatch % is in dead_letter and may not be deleted on its own. The row IS the record that '
    'this conversion was permanently not delivered: A-MEAS-07 reconciles internal truth against what was '
    'pushed, and a deleted dead letter makes a conversion the platform never heard about '
    'indistinguishable from one nobody enqueued - so the day would reconcile while the money was short. '
    'Re-queue it if the destination has been fixed; the ZY312 gate re-judges consent on the way. It is '
    'removed WITH its session when retention purges the visitor, which is 0125''s cascade and is '
    'permitted.',
    old.dispatch_id
    using errcode = 'ZY711';
end $$;

comment on function refuse_dead_letter_delete() is
  'Raises ZY711 when a dead-lettered dispatch would be deleted ON ITS OWN, for every role including the '
  'owner. A-MEAS-06''s acceptance line asks that "a test asserts the row is never deleted"; this makes it '
  'a property of the schema instead, which is the same claim in the form a test cannot go stale against. '
  'A CASCADE from analytics.session is permitted and is told apart by the session being GONE inside the '
  'trigger - PostgreSQL applies the parent delete before the referential action - because refusing that '
  'too would stop analytics.run_retention on the first dead letter it reached.';

create trigger analytics_dispatch_dead_letter_is_not_deletable
  before delete on analytics_dispatch
  for each row execute function refuse_dead_letter_delete();

-- ---------------------------------------------------------------------------------------------
-- The agent A-MEAS-05 was handed no migration number for
-- ---------------------------------------------------------------------------------------------

/*
 * A-MEAS-05's NOTE, in its own words: *"the pass shares `analytics_dispatch`' agent rather than declaring
 * its own — the two passes are one pipeline, but the consumer writes a heartbeat every five minutes, so
 * this pass failing for a week is invisible to a per-agent watchdog. A second agent needs an
 * `agent_definition` and an `agent_heartbeat` row in a migration this unit was allocated none of, and it
 * is handed to A-MEAS-06."*
 *
 * That is 0033's argument, which 0110 and the two analytics partition jobs each restated: a shared
 * heartbeat stays fresh while one of the two passes is dead, and the one that is dead is invisible behind
 * the one that is healthy. The offline upload runs ONCE A DAY and the consumer every five minutes, so the
 * shared heartbeat is never more than five minutes old however long the upload has been broken.
 *
 * 86400 seconds, which is the pass's own cron (`17 3 * * *`) and not a figure chosen here — `pnpm jobs`
 * holds the registry's expression and this interval together. `budget_fils_per_run` is 0 for 0137's
 * measured reason: both adapters are named fakes, `real` resolves to `notImplemented`, and the pass makes
 * no outbound call of any kind.
 */
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('offline_conversions', 'Offline conversion upload',
   'Uploads the closed trading day''s till conversions as an append-only ledger of value statements, '
   'each with its own revision, instant and signed delta (A-MEAS-05, ADR 0092). Its own agent and not '
   'the consumer''s: the consumer writes a heartbeat every five minutes, so a shared one would never be '
   'more than five minutes old however long this daily pass had been broken - 0033''s reason, restated '
   'by 0110 and by the two analytics partition jobs.',
   86400, 0)
on conflict (agent_key) do nothing;

-- And its heartbeat row, because `agentsWithHeartbeat` INNER JOINS the two: an `agent_definition` with no
-- heartbeat row is an agent the watchdog cannot see at all, which is the state a watchdog exists to make
-- impossible. 0107 shipped `gratuity_accrual` without one and nothing caught it until a suite read the
-- table; `pnpm jobs` now does.
insert into agent_heartbeat (agent_key)
values ('offline_conversions')
on conflict (agent_key) do nothing;

commit;
