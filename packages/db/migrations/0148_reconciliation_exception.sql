-- 0148 — the missed-event reconciliation: BOTH sides on file, each with its own instant.
--
-- Y-PAY-05. ADR 0101 is the decision, `packages/payments/src/reconcile.ts` is the diff and
-- `apps/worker/src/jobs/payment-reconciliation.ts` is the pass. What this file is for is the half that
-- makes a repair auditable a month later, and the half that stops a repair being a quiet correction.
--
-- ## Why there are THREE tables and not one
--
-- Y-PAY-04 makes a delivered event land exactly once. It can do nothing about an event that was never
-- delivered, and from inside this system a lost webhook is indistinguishable from an event that never
-- happened: the money is at the acquirer, the invoice reads unpaid, and nothing anywhere is wrong.
--
-- So a job that read only `payment_intent` would be comparing our records with our records, and the one
-- thing it could never find is the event that never arrived. `gateway_state_observation` is the
-- GATEWAY's side, stored with the instant we asked at — which is what makes "the figures were repaired
-- from a snapshot taken at 04:15" a fact rather than a reconstruction. `reconciliation_exception`
-- carries BOTH sides of every divergence plus the missed event ids, so a repair can be re-derived from
-- the rows rather than taken on trust. `payment_reconciliation_run` is the durable watermark.
--
-- ## Why a repair is an APPLIED EVENT and never an overwrite
--
-- `payment_intent`'s three figures are a projection of the append-only `payment_intent_transaction` rows,
-- held equal to them at commit by `ZY163` (ADR 0056). There is therefore no UPDATE that could write them
-- without also fabricating a transaction row — a lie about what a third party did, in the one table a
-- dispute is answered from. So a repair applies the EVENTS the gateway's own stream contains and this
-- build is missing, and `ZY682` is what makes a recorded repair say which: an exception of kind
-- `repaired` with no missed event id would be a figure that changed overnight with nothing behind it.
--
-- A divergence NOTHING explains is quarantined, never corrected. That is ADR 0070's rule arriving in a
-- third subject, and `ZY683` is the half of it a database can hold: a quarantine must have written its
-- `audit_event` in the SAME transaction (0093 `ZZ004`'s argument), so a quarantine nobody was told about
-- cannot commit. An intent the gateway does not recognise at all is the same refusal and the same row —
-- it is never deleted, which `payment_intent_transaction`'s own `ZY161` already makes impossible and
-- this makes VISIBLE.
--
-- ## Why the watermark is a row per RUN and not a single mutable row
--
-- "Killed mid-run and restarted, the job reaches the same end state as an uninterrupted run." The
-- obvious implementation is one row with a cursor somebody UPDATEs, and it fails in exactly the
-- interrupted case: the cursor advances, the process dies before the repairs commit, and the events
-- between the old cursor and the new one are never read again. They are lost for good, and nothing says
-- so.
--
-- So each pass is an append-only row and `ZY684` refuses a watermark that goes backwards. A run that
-- died leaves `finished_at` null, its cursor is NOT the watermark — `payment_reconciliation_watermark`
-- reads only finished runs — and the next pass therefore re-reads from the last COMPLETED cursor. The
-- repairs it already made are idempotent by construction: the events are keyed on
-- `unique (payment_intent_id, gateway_event_id)`, so re-applying one is a no-op and the second pass
-- records no exception for it.
--
-- ## The agent, because every cron has one
--
-- `payment_reconciliation` is a new `agent_definition` and brings its own `agent_heartbeat` row, because
-- `agentsWithHeartbeat` INNER JOINs the two and an agent the watchdog cannot see at all is the exact
-- state a watchdog exists to make impossible (0031's convention, 0110's and 0122's restatement). What
-- the watchdog watches here is the ABSENCE of a success: a reconciliation that stopped running is
-- invisible in every other way, because its output in the healthy case is nothing.
--
-- Four codes of the band ZY681-ZY690. `ZY685`-`ZY690` are unused and are NOT registered: an entry for a
-- code no migration raises is what direction 3 of ADR 0043's gate refuses.
--
--   ZY681  an observation, an exception and a run are append-only
--   ZY682  a repair must name the events it applied and carry both sides of the divergence
--   ZY683  a quarantine must have written its audit_event in the same transaction
--   ZY684  a finished run's watermark may not go backwards

begin;

-- ------------------------------------------------------------------------------------------------
-- gateway_state_observation — the gateway's side, with the instant we asked
-- ------------------------------------------------------------------------------------------------

create table gateway_state_observation (
  id                 uuid        primary key default uuid_generate_v7(),

  gateway            text        not null
                       constraint gateway_state_observation_gateway_nonempty
                       check (btrim(gateway) <> ''),
  gateway_intent_id  text        not null
                       constraint gateway_state_observation_intent_nonempty
                       check (btrim(gateway_intent_id) <> ''),

  -- What the gateway said. The same six states `payment_intent` admits, because a state it does not
  -- admit cannot be compared with ours — and an observation we cannot compare is a row with no use.
  state              text        not null
                       constraint gateway_state_observation_state_known
                       check (state in ('requires_authorisation', 'requires_customer_action',
                                        'authorised', 'captured', 'voided', 'failed')),

  authorised_fils    fils_nonneg not null,
  captured_fils      fils_nonneg not null,
  refunded_fils      fils_nonneg not null,

  -- The instant WE asked. Not an instant the gateway minted: the port's snapshot carries its own
  -- `observedAt`, and the two are kept apart because one says when the gateway believes its answer was
  -- true and this says when we were told. A reconciliation holding only the first cannot answer "how
  -- stale was the figure we repaired from".
  observed_at        timestamptz not null,
  created_at         timestamptz not null default now(),

  -- `recognised` is false when the gateway does not know this intent at all. A ROW rather than an
  -- absence, because "we asked and it said no" and "we never asked" are different facts and only the
  -- first is a reason to quarantine. The figures are nought in that case, and they are nought as a
  -- MEASURED answer rather than as a stand-in: the gateway holds nothing for it.
  recognised         boolean     not null default true,

  constraint gateway_state_observation_unrecognised_holds_nothing
    check (recognised or (authorised_fils = 0 and captured_fils = 0 and refunded_fils = 0))
);

comment on table gateway_state_observation is
  'What the GATEWAY said about an intent, with the instant we asked. The other side of the diff, and the '
  'reason this unit is not a job that reads payment_intent twice: a job comparing our records with our '
  'records can never find the event that never arrived. Append-only (ZY681): an observation is evidence '
  'of what a third party told us, and a repair is justified by it.';
comment on column gateway_state_observation.recognised is
  'False when the gateway does not know this intent at all. A ROW rather than an absence: "we asked and '
  'it said no" and "we never asked" are different facts, and only the first is a reason to quarantine.';

create index gateway_state_observation_intent_idx
  on gateway_state_observation (gateway, gateway_intent_id, observed_at desc);

revoke update, delete, truncate on gateway_state_observation from berelax_app;

-- ------------------------------------------------------------------------------------------------
-- payment_reconciliation_run — the durable watermark, one row per pass
-- ------------------------------------------------------------------------------------------------

create table payment_reconciliation_run (
  id                 uuid        primary key default uuid_generate_v7(),
  gateway            text        not null
                       constraint payment_reconciliation_run_gateway_nonempty
                       check (btrim(gateway) <> ''),

  started_at         timestamptz not null default now(),
  -- Null while the pass is in flight, and that is the whole mechanism: an unfinished run's cursor is NOT
  -- the watermark, so a pass that died re-reads from the last COMPLETED cursor rather than skipping the
  -- events it had read and not yet repaired.
  finished_at        timestamptz,

  -- Where the pass resumed FROM, and where it got to. Opaque: a cursor is the gateway's own bookmark and
  -- a consumer that parsed it would break the day the gateway changed its shape (the port says so).
  cursor_from        text,
  cursor_to          text,

  intents_examined   integer     not null default 0
                       constraint payment_reconciliation_run_examined_nonneg
                       check (intents_examined >= 0),
  repairs            integer     not null default 0
                       constraint payment_reconciliation_run_repairs_nonneg
                       check (repairs >= 0),
  quarantines        integer     not null default 0
                       constraint payment_reconciliation_run_quarantines_nonneg
                       check (quarantines >= 0),

  -- A finished run never reports a cursor BEHIND where it resumed from, and that is the whole claim a
  -- CHECK can make here. It deliberately does NOT require a finished run to have a cursor at all: a pass
  -- over a window with no events in it has no bookmark to report, and the first version of this
  -- constraint — `finished_at is null or cursor_to is not null` — refused exactly that run. Requiring one
  -- would have made the pass INVENT a cursor for an empty window, which is a bookmark the gateway never
  -- issued.
  constraint payment_reconciliation_run_cursor_does_not_retreat
    check (cursor_to is null or cursor_from is null or cursor_to >= cursor_from)
);

comment on table payment_reconciliation_run is
  'One reconciliation pass. The watermark is the cursor of the last FINISHED run, which is what makes '
  '"killed mid-run and restarted reaches the same end state" true: a single mutable cursor row fails in '
  'exactly the interrupted case - it advances, the process dies before the repairs commit, and the '
  'events in between are never read again and nothing says so. Append-only (ZY681), and ZY684 refuses a '
  'finished watermark that goes backwards.';

create index payment_reconciliation_run_watermark_idx
  on payment_reconciliation_run (gateway, finished_at desc nulls last);

revoke delete, truncate on payment_reconciliation_run from berelax_app;

-- ------------------------------------------------------------------------------------------------
-- reconciliation_exception — every repair and every quarantine, with both sides
-- ------------------------------------------------------------------------------------------------

create table reconciliation_exception (
  id                 uuid        primary key default uuid_generate_v7(),
  run_id             uuid        not null references payment_reconciliation_run (id),

  -- A real key. An exception about an intent this build does not hold would be an exception nobody can
  -- open, and the quarantine case still has an intent — it is the GATEWAY that does not recognise it.
  payment_intent_id  uuid        not null references payment_intent (id),
  gateway_intent_id  text        not null
                       constraint reconciliation_exception_intent_nonempty
                       check (btrim(gateway_intent_id) <> ''),

  -- The observation this exception was judged against, so a reader can see the figure that justified it.
  observation_id     uuid        not null references gateway_state_observation (id),

  kind               text        not null
                       constraint reconciliation_exception_kind_known
                       check (kind in ('repaired', 'quarantined')),

  -- BOTH sides, as they stood before anything was applied. jsonb rather than columns, because the shape
  -- is `IntentDivergence` in @berelax/payments and a column per figure per side would be eight columns
  -- that can disagree with it. Null for a repair of an intent whose FIGURES already agreed - the events
  -- were missing and the rows had to be on file anyway.
  before_state       jsonb,
  after_state        jsonb,

  -- The events the gateway had and this build did not. ZY682 requires at least one for a repair: an
  -- exception of kind `repaired` naming no event is a figure that changed overnight with nothing behind
  -- it, and nobody could re-derive it.
  missed_event_ids   text[]      not null default '{}',

  -- What an operator reads. A blank one is a blank row, which is the same lie as a missing one.
  detail             text        not null
                       constraint reconciliation_exception_detail_nonempty
                       check (btrim(detail) <> ''),

  created_at         timestamptz not null default now()
);

comment on table reconciliation_exception is
  'Every repair and every quarantine, with BOTH sides of the divergence and the ids of the events that '
  'explained it. A repair is an APPLIED EVENT and never an overwrite - payment_intent''s figures are a '
  'projection of append-only rows (ZY163), so writing them would mean fabricating a gateway event - and '
  'a divergence nothing explains is QUARANTINED rather than corrected (ADR 0070). An intent in step is '
  'NOT recorded: a row per intent examined would make this a log of runs rather than a register of '
  'divergences, and "a second consecutive run produces zero repairs" would be unassertable.';
comment on column reconciliation_exception.missed_event_ids is
  'The events the gateway had and this build did not. ZY682 requires at least one for a `repaired` row: '
  'a repair naming no event is a figure that changed overnight with nothing behind it.';

create index reconciliation_exception_run_idx on reconciliation_exception (run_id, kind);
create index reconciliation_exception_intent_idx
  on reconciliation_exception (payment_intent_id, created_at desc);

revoke update, delete, truncate on reconciliation_exception from berelax_app;

-- ------------------------------------------------------------------------------------------------
-- payment_reconciliation_watermark — the cursor the next pass resumes from
-- ------------------------------------------------------------------------------------------------

-- A VIEW and not a stored figure, for ADR 0057's reason one subject along: the live answer is a
-- derivation over rows nobody has edited. Only FINISHED runs count, which is the whole of the
-- interrupted-run property.
create view payment_reconciliation_watermark as
select r.gateway,
       max(r.cursor_to) as cursor_to,
       max(r.finished_at) as last_finished_at,
       count(*)::int as finished_runs
  from payment_reconciliation_run r
 where r.finished_at is not null
 group by r.gateway;

comment on view payment_reconciliation_watermark is
  'Where the next pass resumes from: the cursor of the last FINISHED run. A run still in flight is '
  'excluded, which is what makes an interrupted pass re-read its own window instead of skipping it. '
  'max() over a zero-padded cursor is the sequence comparison the port guarantees - no consumer parses '
  'a cursor.';

grant select on payment_reconciliation_watermark to berelax_app;

-- ------------------------------------------------------------------------------------------------
-- ZY681 — the three tables are append-only
-- ------------------------------------------------------------------------------------------------

-- `payment_reconciliation_run` is the one exception to "no UPDATE", and narrowly: `finished_at`,
-- `cursor_to` and the three counters are written once, when the pass completes. Everything else is
-- refused, so a run cannot be re-attributed to another gateway or re-dated, and nothing may be deleted.
create function refuse_reconciliation_change() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and tg_table_name = 'payment_reconciliation_run' then
    if new.id = old.id
       and new.gateway = old.gateway
       and new.started_at = old.started_at
       and old.finished_at is null
       and old.cursor_from is not distinct from new.cursor_from then
      return new;
    end if;
    raise exception
      'ReconciliationRunIsAppendOnly: a reconciliation run may only be CLOSED - its finished_at, '
      'cursor_to and counters written once while finished_at was null. This UPDATE changes its identity, '
      'its gateway, its start, its resume point, or closes a run that is already closed. A run is '
      'evidence of a window that was read; re-dating one would make the watermark unreadable.'
      using errcode = 'ZY681';
  end if;

  raise exception
    'ReconciliationIsAppendOnly: % on %.% is refused. An observation is evidence of what a third party '
    'told us, an exception is the justification for a repair, and a run is the record of a window that '
    'was read. Editing any of them would restate the reason a figure moved; deleting one would leave a '
    'repaired intent with nothing explaining it - and deleting a run would take the watermark with it, '
    'so the events in its window would be read twice or never.',
    tg_op, tg_table_schema, tg_table_name
    using errcode = 'ZY681';
end $$;

comment on function refuse_reconciliation_change() is
  'Raises ZY681 for every UPDATE and DELETE on gateway_state_observation and '
  'reconciliation_exception, and for every UPDATE of payment_reconciliation_run except the single '
  'CLOSE - finished_at, cursor_to and the counters, written once while finished_at was null. For every '
  'role including the owner.';

create trigger gateway_state_observation_no_update before update on gateway_state_observation
  for each row execute function refuse_reconciliation_change();
create trigger gateway_state_observation_no_delete before delete on gateway_state_observation
  for each row execute function refuse_reconciliation_change();
create trigger reconciliation_exception_no_update before update on reconciliation_exception
  for each row execute function refuse_reconciliation_change();
create trigger reconciliation_exception_no_delete before delete on reconciliation_exception
  for each row execute function refuse_reconciliation_change();
create trigger payment_reconciliation_run_close_only before update on payment_reconciliation_run
  for each row execute function refuse_reconciliation_change();
create trigger payment_reconciliation_run_no_delete before delete on payment_reconciliation_run
  for each row execute function refuse_reconciliation_change();

-- ------------------------------------------------------------------------------------------------
-- ZY682 — a repair names the events it applied and carries both sides
-- ------------------------------------------------------------------------------------------------

create function assert_reconciliation_exception_is_justified() returns trigger
language plpgsql
as $$
begin
  if new.kind = 'repaired' then
    if coalesce(array_length(new.missed_event_ids, 1), 0) = 0 then
      raise exception
        'ReconciliationRepairNamesNoEvent: a repair of intent % names no missed event. A repair in this '
        'system IS an applied event - payment_intent''s figures are a projection of append-only rows '
        '(ZY163), so there is no UPDATE that could write them without fabricating a transaction row. An '
        'exception of kind "repaired" with no event behind it is a figure that changed overnight and '
        'nobody can re-derive.',
        new.gateway_intent_id
        using errcode = 'ZY682';
    end if;
    if new.after_state is null then
      raise exception
        'ReconciliationRepairHasNoAfter: a repair of intent % records no after-state. Both sides are the '
        'whole point of the row: a repair nobody can compare with its before is a change of mind, not a '
        'reconciliation.',
        new.gateway_intent_id
        using errcode = 'ZY682';
    end if;
  end if;

  if new.kind = 'quarantined' and new.before_state is null then
    raise exception
      'ReconciliationQuarantineHasNoBefore: intent % is quarantined and the row records no divergence. '
      'A quarantine with nothing to look at is the force-match with an extra step: the intent sits in a '
      'table and the money sits unexplained (ADR 0070).',
      new.gateway_intent_id
      using errcode = 'ZY682';
  end if;

  return new;
end $$;

comment on function assert_reconciliation_exception_is_justified() is
  'Raises ZY682 for a `repaired` row naming no missed event or recording no after-state, and for a '
  '`quarantined` row recording no divergence. A repair is an applied EVENT, so the events are the '
  'justification; a quarantine is a thing somebody has to look at, so the divergence is.';

create trigger reconciliation_exception_is_justified
  before insert on reconciliation_exception
  for each row execute function assert_reconciliation_exception_is_justified();

-- ------------------------------------------------------------------------------------------------
-- ZY683 — a quarantine is alerted in the same transaction
-- ------------------------------------------------------------------------------------------------

-- DEFERRED, because the exception row and the audit row are separate statements.
create function assert_reconciliation_quarantine_is_alerted() returns trigger
language plpgsql
as $$
begin
  if new.kind <> 'quarantined' then return null; end if;
  if exists (select 1 from audit_event
              where entity_type = 'reconciliation_exception'
                and entity_id = new.id::text
                and action = 'payment.reconciliation-quarantined') then
    return null;
  end if;
  raise exception
    'ReconciliationQuarantineNotAlerted: intent % was quarantined and reached COMMIT with no '
    'audit_event(action=payment.reconciliation-quarantined, entity_type=reconciliation_exception, '
    'entity_id=%) in the same transaction. The acceptance line is "quarantined and ALERTED, never '
    'silently deleted", and an audit row written afterwards in a second transaction is not the same '
    'guarantee: the quarantine can commit and the alert can fail, and the only evidence that an intent '
    'went unexplained would be the intent.',
    new.gateway_intent_id, new.id
    using errcode = 'ZY683';
end $$;

comment on function assert_reconciliation_quarantine_is_alerted() is
  'Raises ZY683 at COMMIT for a quarantined exception with no matching audit_event in the same '
  'transaction (0093 ZZ004''s argument). A deferrable constraint trigger rather than an AFTER trigger, '
  'so the audit row may be written either side of the exception and neither may be written later.';

create constraint trigger reconciliation_exception_is_alerted
  after insert on reconciliation_exception
  deferrable initially deferred
  for each row execute function assert_reconciliation_quarantine_is_alerted();

-- ------------------------------------------------------------------------------------------------
-- ZY684 — a finished run's watermark may not go backwards
-- ------------------------------------------------------------------------------------------------

create function assert_reconciliation_watermark_advances() returns trigger
language plpgsql
as $$
declare
  v_previous text;
begin
  if new.finished_at is null then return new; end if;

  select max(r.cursor_to) into v_previous
    from payment_reconciliation_run r
   where r.gateway = new.gateway and r.finished_at is not null and r.id <> new.id;

  if v_previous is not null and new.cursor_to < v_previous then
    raise exception
      'ReconciliationWatermarkWentBackwards: a finished run for % closed at cursor % and the watermark '
      'already stood at %. A cursor is a monotone bookmark the gateway guarantees, so a finished run '
      'behind the watermark means two passes read overlapping windows and the later one closed first - '
      'and the next pass would then re-read a window whose repairs are already made. Those repairs are '
      'idempotent, so the damage is not double-counting: it is that the watermark no longer says what '
      'has been read, which is the one thing it is for.',
      new.gateway, new.cursor_to, v_previous
      using errcode = 'ZY684';
  end if;

  return new;
end $$;

comment on function assert_reconciliation_watermark_advances() is
  'Raises ZY684 when a FINISHING run closes at a cursor behind the current watermark. Immediate rather '
  'than deferred: the comparison is against rows that already exist and there is no legal intermediate '
  'state. Only finished runs are compared, which is what lets an interrupted pass re-read its window.';

create trigger payment_reconciliation_run_watermark_advances
  before update on payment_reconciliation_run
  for each row execute function assert_reconciliation_watermark_advances();

-- ------------------------------------------------------------------------------------------------
-- The agent behind the cron
-- ------------------------------------------------------------------------------------------------

-- `on conflict do nothing` for the reason every other agent insert has it: a migration run twice must
-- change nothing, and this file is replayed against every database.
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('payment_reconciliation', 'Missed-event payment reconciliation',
   'Pulls the gateway''s own event stream since a durable watermark, diffs it against the intents this '
   'build recorded, applies the events a lost webhook never delivered, and quarantines any divergence '
   'nothing explains. Webhooks are at-least-once and sometimes zero-times; this is what makes the ledger '
   'eventually correct anyway (Y-PAY-05, ADR 0101). What the watchdog watches here is the ABSENCE of a '
   'success, because a reconciliation that stopped running is invisible in every other way: its output '
   'in the healthy case is nothing at all.',
   60 * 60, 0)
on conflict (agent_key) do nothing;

-- And its heartbeat row, because `agentsWithHeartbeat` INNER JOINS the two and the watchdog evaluates
-- what that returns. An `agent_definition` row with no heartbeat row is an agent the watchdog cannot see
-- at all — the exact state a watchdog exists to make impossible — and it fails
-- `apps/worker/src/jobs/agent-watchdog.itest.ts`'s registry-completeness case by name. 0031 states the
-- convention and 0110, 0122 and 0133 restate it: a new agent has to bring its own.
insert into agent_heartbeat (agent_key)
values ('payment_reconciliation')
on conflict (agent_key) do nothing;

commit;
