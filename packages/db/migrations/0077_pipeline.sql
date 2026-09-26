-- 0077 — the pipeline board: ordered stages, one card per person, and every move recorded.
--
-- C-AUTO-08's subject is the cheap half of "drag and drop CRM" (docs/03 §5): cards dragged between
-- ordered columns. The expensive half is the interpreter (C-AUTO-07). What this migration encodes is the
-- part a drag cannot be trusted without.
--
-- ## A stage is a claim about a person, so the vocabulary is a TABLE
--
-- "This person is at `contacted`" is a statement the front desk makes about somebody, and the six labels
-- in the manifest are this build's guess — nobody has stated a sales pipeline. So `pipeline_stage` is a
-- table with the provenance trio 0031, 0032 and 0053 established (`is_provisional`, `open_question_id`,
-- `provisional_note`), for 0053's reason restated: a `create type ... as enum` has nowhere to put one,
-- and a label whose whole status is "to be confirmed" must carry the marker that says so (brief rule 15).
-- `customer_pipeline_card.stage_key` is therefore `text` with a foreign key rather than an enum, which is
-- the same trade `customer.lifecycle_state` makes.
--
-- It is NOT `customer_lifecycle_state` under another name. The lifecycle is derived from what has
-- happened (`lead`, `new`, `active`, `lapsing`, `lapsed`, `blocked` — C-CRM-01's reducer computes it from
-- events); a pipeline stage is where a human has PUT somebody, and the two disagree on purpose: a record
-- can be `active` in the lifecycle and `lapsed` on the board because the receptionist has given up on
-- them. Two vocabularies, two questions, and a single column could only answer one.
--
-- ## Why the card table is named `customer_pipeline_card` and the other two are not
--
-- `CRM_TABLE_PATTERN` in `packages/db/src/repositories/crm.ts` is `^customer(_|$)`, and every table in
-- that area must be audited by a named repository action or by a trigger — enumerated from
-- `information_schema`, so a table added to the area and not registered is reported rather than being
-- invisible. The card is in the area on purpose: its row is what the front desk says about a person, so
-- `customer_pipeline_card_audit` gives every change an `audit_event` row whatever wrote it, including a
-- psql correction. `pipeline_stage` is the board's column list and `pipeline_stage_transition` IS an
-- append-only record of who moved whom, so neither is a claim somebody makes about a person that could
-- go unattributed, and neither carries the prefix. The naming is the classification.
--
-- ## Positions are unique AND gapless, and both halves are the database's
--
-- A duplicate position renders one column twice; a gap renders an empty column between two full ones,
-- which reads as a stage nobody is at. `customer_lifecycle_state.display_order` already carries the
-- UNIQUE half and says why ("which is how a Kanban board comes to render a column twice (C-AUTO-08
-- depends on it)"). This adds the other half.
--
-- Both are DEFERRED, and that is what makes a reorder possible at all. Moving `booked` from 3 to 1 means
-- three rows change position, and every intermediate state of that shuffle has either a duplicate or a
-- gap: an immediate UNIQUE refuses the first statement, and an immediate gapless check refuses the
-- second. So the constraint is `deferrable initially deferred` and the gapless check is a deferred
-- CONSTRAINT trigger — both evaluated once, at COMMIT, over the state the transaction leaves behind.
-- `reorderPipelineStages` therefore needs no scratch positions and no `set display_order = -n` pass,
-- which is the trick that leaves negative positions behind when a transaction dies half way through.
--
-- ## A stage change without a transition row is refused by the DATABASE
--
-- The acceptance line is "a trigger asserts a pipeline_stage change without a matching transition row is
-- impossible (known-bad fixture attempts a bare UPDATE)". `customer_pipeline_card_records_every_move` is
-- a deferred constraint trigger that, at commit, requires a `pipeline_stage_transition` row for exactly
-- this move: same contact, `from_stage_key` the value the card held, `to_stage_key` the value it now
-- holds, and `occurred_at` equal to the card's own `stage_entered_at`. That last equality is what stops
-- an OLDER transition satisfying a new move — without it, a card moved back to a stage it had visited
-- before would be accepted on the strength of the earlier row, and the board's history would be missing
-- the move nobody can see it is missing.
--
-- Deferred rather than BEFORE, because the writer cannot insert the transition before the card row it
-- describes exists: the transition names the contact and the two stages, and the ordering inside
-- `moveCard` is card-then-log. Deferred also means a bare `update customer_pipeline_card set stage_key =
-- 'booked'` raises at COMMIT rather than at the statement, which is the correct moment — a statement-time
-- refusal could be worked around by writing the log first, and there is no ordering that satisfies this
-- one except writing both.
--
-- It fires for EVERY role including the owner, for 0070's reason: the revokes below cover the application
-- role, and the owner is who moves a card by hand at 02:00 to "just fix one column".
--
-- ## The private SQLSTATE class
--
-- `ZU001` (PipelineStageChangeUnrecorded), `ZU002` (PipelineTransitionImmutable), `ZU003`
-- (PipelineStagePositionsNotGapless). A private class rather than `restrict_violation` for 0061's reason:
-- that code is raised by seven other triggers and every ON DELETE RESTRICT foreign key here, so a probe
-- asserting it passes when the statement bounced off something else entirely. `ZU` and not a mnemonic
-- letter because the mnemonic ones are taken — `ZK` is the KEK's, `ZP` is consent's, `ZF` is the flow's —
-- and what the code has to be is PRIVATE and unique to this file, not memorable.
--
-- Three codes and not one, because the three refusals have three different runbook answers: "move it
-- through moveCard, which writes the log", "a transition is a record of something that happened and
-- cannot be edited", and "the positions no longer describe a board — reorder them as a permutation".

begin;

-- ---------------------------------------------------------------------------------------------
-- The stage vocabulary
-- ---------------------------------------------------------------------------------------------
create table pipeline_stage (
  stage_key        text        not null
    constraint pipeline_stage_key_is_lower_snake_case check (stage_key ~ '^[a-z][a-z0-9_]{0,47}$'),
  -- The column order, 1..n with no gaps. `display_order` and not `position` for two reasons: it is what
  -- `customer_lifecycle_state`, `rooms` and `service` already call this, and POSITION is a SQL function
  -- whose name has to be quoted in half the places a column of that name would appear.
  display_order    smallint    not null
    constraint pipeline_stage_display_order_is_positive check (display_order >= 1),
  -- What the column MEANS. Required, because a stage nobody can define is a stage two receptionists
  -- will use differently, and the board would then be measuring two things in one column.
  description      text        not null
    constraint pipeline_stage_description_is_stated
      check (not is_placeholder_text(description) and length(description) between 1 and 500),
  is_provisional   boolean     not null default false,
  open_question_id text,
  provisional_note text,
  -- Archiving rather than deleting, and the archived row KEEPS its position. A stage a card has ever
  -- been moved to is named by transition rows that are append-only, so a DELETE would either be refused
  -- by the foreign key or would erase the meaning of a move; and renumbering the survivors to close the
  -- gap would rewrite the board's order as a side effect of hiding one column.
  archived_at      timestamptz,
  -- The flow that entry to this stage starts, or null for a stage that starts none. The subscription
  -- lives on the STAGE rather than in the flow document because a trigger node carries no stage
  -- qualifier (`FLOW_TRIGGER_EVENTS` has `pipeline.stage_entered` and the node is `.strict()`), and a
  -- stage is where an operator is already configuring the board. One flow per stage and not a join
  -- table: the second flow on one column is a question for the editor that has to display them
  -- (C-AUTO-09), and a join table nothing writes two rows into is a table pretending to a capability.
  entry_flow_key   text        references flow (flow_key) on update cascade on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint pipeline_stage_pkey primary key (stage_key),
  -- DEFERRED: see the header. A reorder passes through states that hold a duplicate.
  constraint pipeline_stage_display_order_unique unique (display_order) deferrable initially deferred,
  -- The provenance trio, whole or absent. 0053's constraint, restated for this vocabulary.
  constraint pipeline_stage_provenance
    check ((is_provisional and open_question_id is not null) or not is_provisional)
);

comment on table pipeline_stage is
  'The pipeline board columns, in order. A TABLE and not an enum because every label is this build''s '
  'guess and an enum label cannot carry is_provisional, an OPEN-QUESTIONS id or a note (Y9-crm-pipeline). '
  'Positions are 1..n with no duplicate and no gap, both enforced at COMMIT so a reorder can shuffle '
  'through states that hold neither property.';
comment on column pipeline_stage.display_order is
  'The column order: 1..n over every row in this table, archived ones included. Unique (deferred) and '
  'gapless (pipeline_stage_positions_are_gapless, ZU003). A duplicate renders one column twice and a gap '
  'renders an empty column between two full ones, which reads as a stage nobody is at.';
comment on column pipeline_stage.archived_at is
  'When this column left the board. The row and its position STAY: transitions naming it are '
  'append-only, so a delete would erase what a move meant, and renumbering to close the gap would '
  'reorder the board as a side effect of hiding one column.';
comment on column pipeline_stage.entry_flow_key is
  'The flow that entry to this stage enrols the contact on, through enrolOnLiveVersion - the same writer '
  'every other trigger uses - or null for a stage that starts none. On the stage rather than in the flow '
  'document because a trigger node declares pipeline.stage_entered and carries no stage qualifier.';

create trigger pipeline_stage_updated_at before update on pipeline_stage
  for each row execute function set_updated_at();

-- The audit trigger 0053 introduced, reused. A vocabulary has no repository — it is changed by a
-- migration or by a one-off admin correction — so a trigger is the right instrument, and the key column
-- is read out of the row as jsonb by the argument, which is why one function serves three tables.
create trigger pipeline_stage_audit
  after insert or update or delete on pipeline_stage
  for each row execute function record_crm_vocabulary_change('stage_key');

-- ---------------------------------------------------------------------------------------------
-- The gapless rule
-- ---------------------------------------------------------------------------------------------
-- A CONSTRAINT trigger and not a CHECK, because the property is about the TABLE and a CHECK sees one
-- row. Deferred, so it is evaluated once at commit over the state the transaction leaves rather than
-- after each statement of a shuffle.
--
-- `count(*) = max(display_order) and min(display_order) = 1` is the whole test, and it is sufficient
-- because the UNIQUE constraint supplies distinctness: n distinct integers in [1, n] are exactly 1..n.
-- Stated as three aggregates rather than as a `generate_series` anti-join for that reason — the
-- cheaper form is also the one whose argument fits in a sentence.
create function assert_pipeline_stage_positions_are_gapless() returns trigger
language plpgsql
as $$
declare
  v_count integer;
  v_min   integer;
  v_max   integer;
begin
  select count(*), min(display_order), max(display_order) into v_count, v_min, v_max
    from pipeline_stage;
  -- An empty table is gapless. The board is then empty, which is a different problem and not this
  -- trigger's: refusing it here would make the last stage undeletable for no reason anybody could act on.
  if v_count = 0 then
    return null;
  end if;
  if v_min <> 1 or v_max <> v_count then
    raise exception
      'pipeline_stage positions must be 1..%, with no duplicate and no gap; they are %..% over % row(s). '
      'A gap renders an empty column between two full ones, which reads as a stage nobody is at. Reorder '
      'the stages as a PERMUTATION (reorderPipelineStages) rather than by editing one position.',
      v_count, v_min, v_max, v_count
      using errcode = 'ZU003';
  end if;
  return null;
end $$;

comment on function assert_pipeline_stage_positions_are_gapless() is
  'Raises ZU003 when pipeline_stage.display_order is not 1..n. Deferred to COMMIT, so a reorder may pass '
  'through states that hold a gap; distinctness comes from pipeline_stage_display_order_unique, which is '
  'what makes three aggregates a sufficient test.';

create constraint trigger pipeline_stage_positions_are_gapless
  after insert or update or delete on pipeline_stage
  deferrable initially deferred
  for each row execute function assert_pipeline_stage_positions_are_gapless();

-- ---------------------------------------------------------------------------------------------
-- The seeds
-- ---------------------------------------------------------------------------------------------
-- In the migration rather than in a seed script, for 0053's reason about the lifecycle vocabulary: a
-- board with no columns cannot accept a card at all, so these rows are not fixture data — they are part
-- of what the schema means. All six provisional, all six pointing at one OPEN-QUESTIONS row.
insert into pipeline_stage
  (stage_key, display_order, description, is_provisional, open_question_id, provisional_note)
values
  ('new_enquiry', 1, 'Somebody has made contact and nothing has been offered yet.', true,
   'Y9-crm-pipeline',
   'Six stages chosen by this build; no sales pipeline has been stated by the business.'),
  ('contacted',   2, 'The salon has replied and is waiting on the enquirer.', true, 'Y9-crm-pipeline',
   'Six stages chosen by this build; no sales pipeline has been stated by the business.'),
  ('booked',      3, 'An appointment exists and has not been attended yet.', true, 'Y9-crm-pipeline',
   'Six stages chosen by this build; no sales pipeline has been stated by the business.'),
  ('attended',    4, 'A first treatment has been completed.', true, 'Y9-crm-pipeline',
   'Six stages chosen by this build; no sales pipeline has been stated by the business.'),
  ('repeat',      5, 'More than one treatment completed. A returning client.', true, 'Y9-crm-pipeline',
   'Six stages chosen by this build; no sales pipeline has been stated by the business.'),
  ('lapsed',      6, 'The front desk has given up on this enquiry for now.', true, 'Y9-crm-pipeline',
   'Six stages chosen by this build; no sales pipeline has been stated by the business.');

-- ---------------------------------------------------------------------------------------------
-- The move log
-- ---------------------------------------------------------------------------------------------
create table pipeline_stage_transition (
  id             uuid        not null default uuid_generate_v7(),
  -- A plain uuid and deliberately NOT a foreign key, which is 0056's decision for `consent` and its
  -- reason verbatim: an append-only log cannot hold a reference to a mutable parent, because a cascade
  -- would fire the refusal trigger below and make `delete from customer` impossible — and this record
  -- must outlive the erasure of the identity it is about. `customer_pipeline_card` carries the real
  -- foreign key; this is the history of what was done, which is a different kind of fact.
  customer_id    uuid        not null,
  -- NULL means the card was created in this stage: there was no column it came from. Nullable rather
  -- than a sentinel stage, because a sentinel would be a seventh column on the board.
  --
  -- ON UPDATE RESTRICT on both, and that is the rule rather than an omission: a stage key is immutable
  -- once any card has entered it, because a cascade would be an UPDATE on this table and this table
  -- refuses one. Renaming a column on the board is therefore adding a stage and moving the cards, which
  -- is what the log can describe.
  from_stage_key text
    references pipeline_stage (stage_key) on update restrict on delete restrict,
  to_stage_key   text        not null
    references pipeline_stage (stage_key) on update restrict on delete restrict,
  -- The four facts the acceptance line names: actor, from, to and timestamp. The actor is a KIND and a
  -- label, 0046's shape, because the label is what a reader needs and the kind is what a filter needs.
  actor_kind     text        not null
    constraint pipeline_stage_transition_actor_kind_known
      check (actor_kind in ('staff', 'customer', 'system', 'agent')),
  actor_label    text        not null
    constraint pipeline_stage_transition_actor_is_stated
      check (not is_placeholder_text(actor_label) and length(actor_label) between 1 and 200),
  -- When the move happened, from an injected clock rather than from `now()`: an ordering asserted
  -- against the server clock cannot be tested under a frozen one (0070's argument for `enrolled_at`).
  occurred_at    timestamptz not null,
  created_at     timestamptz not null default now(),

  constraint pipeline_stage_transition_pkey primary key (id),
  -- A move goes somewhere. `from` = `to` is not a move, and recording one would let a caller satisfy
  -- the card's constraint trigger without changing anything.
  constraint pipeline_stage_transition_goes_somewhere
    check (from_stage_key is null or from_stage_key <> to_stage_key),
  -- What makes the card's deferred check answerable by exactly one row: two moves of one contact into
  -- one stage at one instant are the same move recorded twice.
  constraint pipeline_stage_transition_one_per_instant
    unique (customer_id, to_stage_key, occurred_at)
);

comment on table pipeline_stage_transition is
  'Every move of a card between columns: who, from where, to where, and when. Append-only: UPDATE and '
  'DELETE raise ZU002 for every role including the owner, because this log is the only evidence that a '
  'stage change happened and who made it - and because customer_pipeline_card_records_every_move reads '
  'it at COMMIT, a writer that could delete a row could move a card with no record of the move.';
comment on column pipeline_stage_transition.customer_id is
  'Plain uuid, deliberately not a foreign key - 0056''s decision for consent. An append-only log cannot '
  'hold a reference to a mutable parent: a cascade would fire the refusal trigger and make `delete from '
  'customer` impossible, and this record must outlive the erasure of the identity it is about.';
comment on column pipeline_stage_transition.from_stage_key is
  'The column the card came from, or NULL when the card was created in to_stage_key. Nullable rather '
  'than a sentinel stage, because a sentinel would be a seventh column on the board. ON UPDATE RESTRICT '
  'on both stage references: a stage key is immutable once a card has entered it, because a cascade '
  'would be an UPDATE on a table that refuses one.';
comment on column pipeline_stage_transition.occurred_at is
  'When the move happened, from the caller''s clock. Equal to the card''s stage_entered_at for the move '
  'that put it where it is, which is what stops an older transition satisfying a newer move.';

create index pipeline_stage_transition_customer_idx
  on pipeline_stage_transition (customer_id, occurred_at desc);
-- "How many cards entered this column this month", which is the only aggregate a board offers.
create index pipeline_stage_transition_stage_idx
  on pipeline_stage_transition (to_stage_key, occurred_at desc);

-- A trigger that RAISES rather than `create rule ... do instead nothing`, for 0066's and 0070's reason:
-- a rule reports success, so code that edited the log would believe it had.
create function refuse_pipeline_transition_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'pipeline_stage_transition is append-only; % is refused. The log is the only evidence that a card '
    'moved and who moved it, and customer_pipeline_card_records_every_move reads it at COMMIT - so a '
    'caller that could remove a row could move a card with nothing recording the move.',
    tg_op
    using errcode = 'ZU002';
end $$;

comment on function refuse_pipeline_transition_change() is
  'Raises ZU002 (PipelineTransitionImmutable) for pipeline_stage_transition, for every role including '
  'the owner. A correction is a new move, not an edit to the record of the old one.';

create trigger pipeline_stage_transition_no_update before update on pipeline_stage_transition
  for each row execute function refuse_pipeline_transition_change();
create trigger pipeline_stage_transition_no_delete before delete on pipeline_stage_transition
  for each row execute function refuse_pipeline_transition_change();

-- ---------------------------------------------------------------------------------------------
-- The card
-- ---------------------------------------------------------------------------------------------
create table customer_pipeline_card (
  -- The customer IS the card: one person is in one column. The primary key says so, which is what makes
  -- "two cards for one person" unrepresentable rather than a rule the board has to remember while it
  -- renders. A board that drew one person twice would take two moves for one drag.
  customer_id      uuid        not null references customer (id) on delete cascade,
  stage_key        text        not null
    references pipeline_stage (stage_key) on update restrict on delete restrict,
  -- When the card entered the column it is in. Equal to the `occurred_at` of the transition that put it
  -- there, which is the equality customer_pipeline_card_records_every_move checks.
  stage_entered_at timestamptz not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint customer_pipeline_card_pkey primary key (customer_id)
);

comment on table customer_pipeline_card is
  'Where one contact is on the pipeline board. One row per person - the customer id IS the primary key - '
  'so two cards for one person are unrepresentable. Every change of stage_key must be accompanied by a '
  'pipeline_stage_transition row for exactly that move (ZU001), checked at COMMIT for every role '
  'including the owner. Named under customer_ deliberately: the row is what the front desk says about a '
  'person, so it is in the CRM audit area and customer_pipeline_card_audit covers it.';
comment on column customer_pipeline_card.stage_entered_at is
  'When the card entered this column, equal to the occurred_at of the transition that moved it. The '
  'equality is what stops an older transition into the same stage satisfying a newer move.';

create trigger customer_pipeline_card_updated_at before update on customer_pipeline_card
  for each row execute function set_updated_at();

-- Audited by trigger and not by a repository action, although it HAS a repository. The register's two
-- arms are about who can be trusted to record a change, and for this table the honest answer is nobody:
-- the card is one column and one instant, a psql UPDATE is a plausible correction, and the whole point of
-- the row is that a stage is attributable. The trigger takes its actor from the transaction-local
-- `berelax.audit_actor_*` settings (0036's mechanism), which `moveCard` sets, and records `system` with a
-- stating label when there is none.
create trigger customer_pipeline_card_audit
  after insert or update or delete on customer_pipeline_card
  for each row execute function record_crm_vocabulary_change('customer_id');

create index customer_pipeline_card_stage_idx
  on customer_pipeline_card (stage_key, stage_entered_at);

-- ---------------------------------------------------------------------------------------------
-- A stage change is refused unless the move is recorded
-- ---------------------------------------------------------------------------------------------
create function assert_pipeline_card_move_is_recorded() returns trigger
language plpgsql
as $$
declare
  v_from text;
begin
  -- An UPDATE that does not touch the stage is not a move. Without this the trigger would refuse every
  -- unrelated write to the row, and the first one is `set_updated_at`'s own.
  if tg_op = 'UPDATE'
     and new.stage_key is not distinct from old.stage_key
     and new.stage_entered_at is not distinct from old.stage_entered_at then
    return null;
  end if;

  v_from := case when tg_op = 'UPDATE' then old.stage_key else null end;

  -- `is not distinct from` on the FROM column, because it is nullable on an insert and `= null` is
  -- NULL: a comparison that silently answers NULL is how a guard comes to pass everything (0065's note).
  if not exists (
    select 1 from pipeline_stage_transition t
     where t.customer_id = new.customer_id
       and t.to_stage_key = new.stage_key
       and t.from_stage_key is not distinct from v_from
       and t.occurred_at = new.stage_entered_at
  ) then
    raise exception
      'customer_pipeline_card.stage_key changed from % to % for contact % with no pipeline_stage_'
      'transition recording that move at %. A stage is a claim somebody made about a person, so the '
      'claim and its record are one transaction: move the card with moveCard, which writes both.',
      coalesce(v_from, '(none)'), new.stage_key, new.customer_id, new.stage_entered_at
      using errcode = 'ZU001';
  end if;
  return null;
end $$;

comment on function assert_pipeline_card_move_is_recorded() is
  'Raises ZU001 when a customer_pipeline_card row is created or its stage changed without a matching '
  'pipeline_stage_transition row - same contact, same from, same to, same instant. Deferred to COMMIT, '
  'because the log cannot be written before the card it describes exists; and for every role including '
  'the owner, because the owner is who moves a card by hand at 02:00.';

create constraint trigger customer_pipeline_card_records_every_move
  after insert or update on customer_pipeline_card
  deferrable initially deferred
  for each row execute function assert_pipeline_card_move_is_recorded();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 grants the application role select/insert/update/delete on every table created in `public`
-- afterwards and sets default privileges extending that to tables created later, so these revokes are
-- load-bearing rather than decorative — and stated explicitly because a managed database restored from a
-- dump does not necessarily carry the same defaults.
--
-- The triggers above already refuse for every role. These are the second layer, and the one that gives a
-- caller a privilege error rather than a raised exception: "you may not" rather than "you tried".
-- TRUNCATE is the one a trigger cannot see, and a truncated transition log is a board whose every card
-- can then be moved with no record of the move.
revoke update, delete, truncate on pipeline_stage_transition from berelax_app;
-- A stage is never DELETED — archived instead, which is an UPDATE of `archived_at`. The manifest's
-- provisional line says the stages are editable in settings, so INSERT and UPDATE both stay: adding a
-- column and reordering the board are things an owner does. What must not happen is a stage disappearing,
-- because a transition row names it and the move it records would stop meaning anything.
revoke delete, truncate on pipeline_stage from berelax_app;
-- A card is removed by removing the contact (the cascade above), not by taking it off the board: "not on
-- the board" and "never was" are different facts, and only the log can tell them apart. DELETE therefore
-- has no legitimate caller; the cascade from `customer` still works, because a referential action runs
-- with the privileges of the referencing table's owner rather than the caller's.
revoke delete, truncate on customer_pipeline_card from berelax_app;

commit;
