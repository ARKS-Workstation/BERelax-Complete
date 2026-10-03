-- 0137_analytics_dispatch_transport.sql — A-MEAS-03
--
-- The transport half of `analytics_dispatch`: the shared event identity, the payload that went out, the
-- action source, the instant the conversion actually happened, the attempt counter, the per-destination
-- idempotency index, the `failed` state, and the agent behind the consumer's cron.
--
-- ============================================================================================
-- Why these columns are added here and were deliberately absent from 0125
-- ============================================================================================
--
-- 0125 (A-MEAS-02) created `analytics_dispatch` and gated it, and left this half out on purpose, in its
-- own words: *"a column with no producer is indistinguishable from one whose producer stopped working"*.
-- `event_id`, the payload, an attempt counter, a per-destination idempotency index and a `failed` state
-- all have a producer from this migration onwards, which is the consumer in
-- `apps/worker/src/jobs/analytics-dispatch.ts`.
--
-- **The consent gate is NOT re-answered here.** `dispatch_consent_gap` and the ZY312 trigger are 0125's
-- and this file does not touch either. A second consent check in the consumer is the defect A-MEAS-02 was
-- built to prevent (ADR 0076), so the consumer reads the state the gate already decided — a row is
-- `queued` or it is not — and the only thing it is permitted to decide is whether the transport worked.
--
-- ============================================================================================
-- `event_id` is NOT NULL with no default, and that is safe here and nowhere later
-- ============================================================================================
--
-- `alter table ... add column ... not null` with no default fails on a non-empty table. This table is
-- always empty when this statement runs: it is created by 0125 in the same ordered run, `pnpm db:apply`
-- refuses a database whose `public` schema is not empty, and nothing between 0125 and here writes a
-- dispatch row. Stated rather than assumed, because the same statement in a migration numbered after the
-- consumer ships would be an outage.
--
-- A nullable `event_id` was the alternative and is worse for the reason 0125 gives about the columns it
-- omitted, one step on: the id is the ONLY thing that makes a delivery idempotent across a retry and
-- across the two surfaces, so a row without one is a row that can be sent twice. NULL is not excluded by
-- a unique index either — two NULLs are distinct — so the idempotency index would silently stop being
-- one.
--
-- ============================================================================================
-- `event_id` is an opaque digest, and the client tag computes the same one
-- ============================================================================================
--
-- The acceptance line is *"the same booking yields one event_id used by both the client tag and the server
-- push"*. There are two ways to make that true and only one of them works offline: either the server mints
-- an id and the page is told it, or BOTH sides derive it from facts they already hold. This build takes
-- the second — `analyticsEventId` in `@berelax/analytics` is a pure function of the aggregate's type, its
-- id and the funnel stage — because the first requires the page to be rendered by the request that minted
-- the row, and a walk-in conversion uploaded two days later (A-MEAS-05) has no page at all. A derived id
-- is also stable across a retry by construction rather than by remembering to reuse one.
--
-- The column is `text` and carries a hex digest, so it names no booking, document or customer: this table
-- is purged by cascade when its session is (0125), and an id that embedded a document number would be a
-- business identifier surviving in a payload column that leaves the building.
--
-- ============================================================================================
-- The three constraints this file RELAXES, and why relaxing beats a row that disagrees
-- ============================================================================================
--
-- 0125 wrote `analytics_dispatch_reason_known`, `analytics_dispatch_reason_iff_refused` and two
-- state-specific siblings, and said why in so many words: the pair being derivable today *"is the
-- constraint that keeps the pair in bijection WHILE it is one, so A-MEAS-03's transport failures arrive by
-- a migration that relaxes these deliberately rather than by a row that quietly disagrees with the state
-- beside it."* This is that migration.
--
--   * `analytics_dispatch_reason_known` gains `transport_failed`. It is a third reason and not a reuse of
--     `consent_denied`, for the reason 0125 separates denial from withdrawal: a dispatch nobody was
--     permitted to send and one the far end refused to accept are different facts, and one value for both
--     would make "did we send anything we should not have" unanswerable.
--   * `analytics_dispatch_reason_iff_refused` gains `failed`, so the bijection holds over four states
--     rather than three.
--   * The two siblings are KEPT as they are and a third is added beside them
--     (`analytics_dispatch_failure_is_a_transport_failure`), rather than the three being collapsed into
--     one alternation. Three narrow rules fail by name; one wide rule fails by saying a row is wrong.
--
-- ============================================================================================
-- What a failure is allowed to look like, and what it is not
-- ============================================================================================
--
-- `attempts` and `last_error` exist so that a dispatch that did not go out says what happened. Two CHECKs
-- tie them to the state:
--
--   * a `sent` or `failed` row has had at least one attempt — a transmission with no attempt behind it is
--     a row somebody wrote by hand;
--   * a `failed` row carries an error, because a failure with no message is indistinguishable from a
--     consumer that stopped running.
--
-- `failed` is deliberately NOT terminal. The retry schedule lives in `@berelax/analytics` and the consumer
-- moves a failed row back to `queued`, which the ZY312 trigger re-judges on the way — so a dispatch that
-- failed while consent was live and is retried after a withdrawal is refused on the retry rather than
-- transmitted from a state nobody re-checked.
--
-- ============================================================================================
-- The idempotency index is on (event_id, destination) and is NOT partial
-- ============================================================================================
--
-- One delivery per (event_id, destination) is the acceptance line, and it has to hold across states: a
-- `suppressed` row and a later `queued` row for the same event and destination would be two answers to
-- whether that conversion was permitted. So the index covers every state, which also makes "replaying the
-- outbox event twice writes no second dispatch" a property of the SCHEMA rather than of the consumer's
-- care — the second insert is `23505` whichever call site makes it.
--
-- A partial index `where state <> 'suppressed'` was tried first and is wrong for the reason above: the
-- suppression row IS the record that the conversion was considered, and a second consideration of it is a
-- second record of one decision.
--
-- ============================================================================================
-- ZY451 and ZY452, and the seven codes released
-- ============================================================================================
--
-- The band ZY451-ZY460 is this unit's. Two codes are raised and registered; ZY453 through ZY460 are
-- released and deliberately left UNREGISTERED, because `pnpm sqlstate` refuses an entry for a code no
-- migration raises.
--
-- Both are triggers rather than CHECKs because both compare NEW against OLD, which a CHECK cannot see.
--
--   * **ZY451 — a transmitted dispatch is frozen.** Once `transmitted_at` is set, the event id, the
--     payload and the transmission instant may not change and the row may not leave `sent`. This is the
--     rule A-MEAS-07 reconciles against: the whole point of comparing internal truth with what was pushed
--     is that what was pushed is on file, and a payload that can be rewritten to match the corrected
--     figure makes every variance zero. It is also why A-MEAS-05's corrected value is a NEW row — a
--     different `event_id`, a different statement — rather than an edit of this one.
--   * **ZY452 — the attempt counter may only increase.** A retry that reset it would make the backoff
--     start again from the first delay for ever, so a destination that is down would be hammered at the
--     shortest interval and the `failed` row would never age. The symptom is not an error: it is a
--     consumer that looks busy.
--
-- ============================================================================================
-- The agent, and why a cron rather than a queue the enqueue announces
-- ============================================================================================
--
-- `apps/worker/src/job.ts` requires an `agent_definition` on any job with a `cron`, `pnpm jobs` refuses a
-- cron without one, and 0031's convention — restated by 0110 and again by 0122 — is that a new agent
-- brings its own `agent_heartbeat` row. Migration 0107 shipped `gratuity_accrual` without one and nothing
-- caught it until an integration suite read the table, so both rows are below.
--
-- A cron and not a queue the enqueue announces, which is the opposite of what `BUILD_DERIVATIVES_JOB` and
-- `RECONCILE_DLR_JOB` chose, and the difference is what the work IS. A derivative build is announced by
-- the upload that produced the original, so the thing being watched is that request. A dispatch is a row
-- the gate left in `queued`, and the reasons it is still there include "the far end was down for an hour"
-- and "the consumer stopped" — which an announcement cannot cover, because the announcement already
-- happened. What has to be watched is the ABSENCE of a drain, and that is what an agent heartbeat
-- measures.
--
-- Five minutes, so `expected_interval_seconds` is 300 and the watchdog's "no success within twice the
-- interval" means a dispatch is at most twenty minutes late before somebody is told. `budget_fils_per_run`
-- is 0: there is no GA4 property and no Meta pixel in this build (docs/01 decision 14,
-- OPEN-QUESTIONS Y5-analytics-basis), both adapters are named fakes behind the provider port, and `real`
-- resolves to `notImplemented` — so the pass performs no outbound call of any kind and a budget above zero
-- would be a figure nobody measured.

-- ---------------------------------------------------------------------------------------------
-- The new enum label — OUTSIDE the transaction, 0054's convention and 0127's wording
-- ---------------------------------------------------------------------------------------------
-- `alter type ... add value` is legal inside a transaction block on PostgreSQL 12+, but the new label may
-- not be USED until that transaction commits, and the block below writes `failed` into two CHECK
-- constraints. `psql -f` sends statements in autocommit, so this one commits on its own. `if not exists`
-- because this is the statement a re-run reaches: the transaction below commits whole or rolls back whole,
-- and a half-applied migration must not be a half-applied enum as well.
alter type analytics_dispatch_state add value if not exists 'failed';

begin;

comment on type analytics_dispatch_state is
  'Where a dispatch is in its life. `suppressed` is a dispatch that was never enqueued - the row exists '
  'so the refusal is VISIBLE rather than silent - `cancelled_consent_withdrawn` is one that was queued '
  'when the visitor changed their mind, and `failed` (0137) is one the transport did not accept. Only '
  '`sent` is terminal: a failed row goes back to `queued` and is re-judged by the ZY312 trigger on the '
  'way, so a dispatch that failed while consent was live is refused rather than transmitted after a '
  'withdrawal.';

-- ---------------------------------------------------------------------------------------------
-- The columns
-- ---------------------------------------------------------------------------------------------

alter table analytics_dispatch
  add column event_id      text        not null,
  add column payload       jsonb       not null,
  add column action_source text        not null,
  add column occurred_at   timestamptz not null,
  add column attempts      smallint    not null default 0,
  add column last_error    text;

comment on column analytics_dispatch.event_id is
  'The deduplication identity, shared by the on-page tag and the server push. A hex digest derived by '
  '`analyticsEventId` in @berelax/analytics from the aggregate kind, the aggregate id and the funnel '
  'stage - DERIVED on both sides rather than minted here and handed to the page, because an offline '
  'conversion uploaded two days later has no page to hand it to, and because a derived id is stable '
  'across a retry by construction. Opaque: it names no booking, document or customer, since this value '
  'travels in an outbound payload.';

comment on column analytics_dispatch.payload is
  'The serialised egress payload this dispatch carries, exactly as `serialiseEgressPayload` produced it. '
  'Stored so that A-MEAS-07 has BOTH sides of its comparison: a reconciliation that reads only our own '
  'invoices proves nothing about what an ad platform was told. Frozen once transmitted (ZY451), which is '
  'what stops a corrected figure being written over the wrong one that went out.';

comment on column analytics_dispatch.action_source is
  'Where the conversion happened, in the receiving platform''s vocabulary: website, phone_call or '
  'physical_store. A STORED column written by whoever enqueues the dispatch, and not derived by the '
  'consumer, because nothing in this schema links an analytics session to the booking it produced - '
  'A-FIRST-08 owns attribution and A-FIRST-09 the funnel materialisation, and a consumer that joined '
  'booking to session through anything available today would be joining on nothing. The enqueuer DOES '
  'know: it is the booking or the payment path. Mapped from booking.source by '
  'BOOKING_SOURCE_ACTION_SOURCE in @berelax/analytics, which is total by compilation over the four '
  'values booking_source_known admits.';

comment on column analytics_dispatch.occurred_at is
  'When the conversion HAPPENED, which is not when the gate judged it. `decided_at` is the enqueue '
  'instant; this is the treatment, the payment or the visit, and for an offline upload (A-MEAS-05) it is '
  'days earlier. Two columns and not one, because a platform dates the conversion on this value and '
  'every attribution window is measured from it - an offline conversion stamped with the enqueue instant '
  'is credited to whatever campaign was running on the night the worker ran.';

comment on column analytics_dispatch.attempts is
  'How many transport attempts this dispatch has had. Monotonic (ZY452): a retry that reset it would '
  'restart the backoff at its shortest delay for ever, which presents as a consumer that looks busy '
  'rather than as an error.';

comment on column analytics_dispatch.last_error is
  'What the transport said the last time it refused, for a `failed` row. NOT NULL for that state by '
  'CHECK, because a failure with no message is indistinguishable from a consumer that stopped running.';

-- ---------------------------------------------------------------------------------------------
-- The relaxations 0125 asked for by name
-- ---------------------------------------------------------------------------------------------

alter table analytics_dispatch drop constraint analytics_dispatch_reason_known;
alter table analytics_dispatch add constraint analytics_dispatch_reason_known
  check (reason is null
         or reason in ('consent_denied', 'consent_withdrawn', 'transport_failed'));

alter table analytics_dispatch drop constraint analytics_dispatch_reason_iff_refused;
alter table analytics_dispatch add constraint analytics_dispatch_reason_iff_refused
  check ((state in ('suppressed', 'cancelled_consent_withdrawn', 'failed'))
         = (reason is not null));

-- The third sibling, beside 0125's two rather than folded into them: three narrow rules fail by name,
-- where one alternation fails by saying a row is wrong.
alter table analytics_dispatch add constraint analytics_dispatch_failure_is_a_transport_failure
  check (state <> 'failed' or reason = 'transport_failed');

-- The action source is one of the three the platforms accept. A CHECK and not an enum, for the reason
-- 0125 gives about `reason`: the vocabulary is the receiving platform's and this build does not own it, so
-- a fourth value arrives as an ALTER of one constraint rather than as a type the whole schema depends on.
alter table analytics_dispatch add constraint analytics_dispatch_action_source_known
  check (action_source in ('website', 'phone_call', 'physical_store'));

-- A conversion cannot have been judged before it happened. This is also what refuses a FUTURE event
-- instant, which is the one value Meta rejects outright and the shape a clock read in the wrong place
-- produces: `occurred_at = now()` on a row whose `decided_at` is the frozen instant of a backfill.
alter table analytics_dispatch add constraint analytics_dispatch_occurred_before_decided
  check (occurred_at <= decided_at);

-- A transmission or a failure has had an attempt behind it, and a failure says what happened.
alter table analytics_dispatch add constraint analytics_dispatch_outcome_had_an_attempt
  check (state not in ('sent', 'failed') or attempts > 0);
alter table analytics_dispatch add constraint analytics_dispatch_failure_carries_its_error
  check ((state = 'failed') <= (last_error is not null));

-- ---------------------------------------------------------------------------------------------
-- The idempotency index
-- ---------------------------------------------------------------------------------------------

create unique index analytics_dispatch_event_destination_unique
  on analytics_dispatch (event_id, destination);

comment on index analytics_dispatch_event_destination_unique is
  'One dispatch per (event_id, destination), across EVERY state. Not partial: a suppressed row and a '
  'later queued row for the same event and destination would be two answers to whether that conversion '
  'was permitted. This is what makes "replaying the outbox event twice writes no second dispatch" a '
  'property of the schema rather than of a consumer''s care - the second insert is 23505 whichever call '
  'site makes it.';

-- The consumer's own read: what is due, oldest first, with the failed rows that are ready to retry.
create index analytics_dispatch_due_idx on analytics_dispatch (decided_at)
  where state in ('queued', 'failed');

-- ---------------------------------------------------------------------------------------------
-- ZY451 — a transmitted dispatch is frozen
-- ---------------------------------------------------------------------------------------------

create function refuse_transmitted_dispatch_change() returns trigger
language plpgsql
as $$
begin
  if old.state <> 'sent' then
    return new;
  end if;
  if new.state <> 'sent' then
    raise exception
      'analytics_dispatch % is sent and may not become %. A transmission that happened cannot be '
      'un-happened, and a row rewritten to claim otherwise is a false record of what an ad platform was '
      'told. A corrected figure is a NEW dispatch with its own event_id (A-MEAS-05).',
      old.dispatch_id, new.state
      using errcode = 'ZY451';
  end if;
  if new.event_id <> old.event_id
     or new.payload <> old.payload
     or new.transmitted_at <> old.transmitted_at then
    raise exception
      'analytics_dispatch % is sent, so its event_id, payload and transmission instant are frozen. '
      'A-MEAS-07 compares internal truth against what was PUSHED, and a payload that can be rewritten to '
      'match the corrected figure makes every variance zero.',
      old.dispatch_id
      using errcode = 'ZY451';
  end if;
  return new;
end $$;

comment on function refuse_transmitted_dispatch_change() is
  'Raises ZY451 when a sent dispatch would leave `sent` or have its event_id, payload or transmission '
  'instant edited. For every role including the owner: what was pushed is one half of A-MEAS-07''s '
  'comparison, and a half that can be edited to agree with the other half is not a comparison.';

create trigger analytics_dispatch_transmission_is_frozen
  before update on analytics_dispatch
  for each row execute function refuse_transmitted_dispatch_change();

-- ---------------------------------------------------------------------------------------------
-- ZY452 — the attempt counter may only increase
-- ---------------------------------------------------------------------------------------------

create function assert_dispatch_attempts_monotonic() returns trigger
language plpgsql
as $$
begin
  if new.attempts >= old.attempts then
    return new;
  end if;
  raise exception
    'analytics_dispatch % would move its attempt counter from % back to %. The backoff schedule is a '
    'function of the attempt number, so a reset restarts it at its shortest delay for ever - a '
    'destination that is down is then retried at the shortest interval and the failed row never ages. '
    'The symptom is not an error: it is a consumer that looks busy.',
    old.dispatch_id, old.attempts, new.attempts
    using errcode = 'ZY452';
end $$;

comment on function assert_dispatch_attempts_monotonic() is
  'Raises ZY452 when a dispatch''s attempt counter would decrease. Separate from ZY451 because it applies '
  'to a row that has NOT been transmitted, which is every row a retry touches.';

create trigger analytics_dispatch_attempts_only_increase
  before update on analytics_dispatch
  for each row execute function assert_dispatch_attempts_monotonic();

-- ---------------------------------------------------------------------------------------------
-- The consumer's agent, and its heartbeat row
-- ---------------------------------------------------------------------------------------------

insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('analytics_dispatch', 'Analytics dispatch consumer',
   'Drains analytics_dispatch: transmits every queued row through the destination''s adapter, retries a '
   'failed one on an exponential schedule, and records the attempt and the error on the row. It does NOT '
   're-decide consent - the ZY312 gate already did, and a second check is the defect A-MEAS-02 was built '
   'to prevent (ADR 0076). Both adapters are named fakes behind the provider port and `real` resolves to '
   'notImplemented, so no request leaves the building and the budget is 0 (A-MEAS-03, ADR 0005/0022).',
   300, 0)
on conflict (agent_key) do nothing;

-- And its heartbeat row, because `agentsWithHeartbeat` INNER JOINS the two: an `agent_definition` with no
-- heartbeat row is an agent the watchdog cannot see at all, which is the state a watchdog exists to make
-- impossible. 0107 shipped one without and nothing static caught it; `pnpm jobs` now does.
insert into agent_heartbeat (agent_key)
values ('analytics_dispatch')
on conflict (agent_key) do nothing;

commit;
