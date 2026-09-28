-- 0091 — the run, the idempotency key, and the step log that answers one question in one query.
--
-- C-AUTO-07's half of the drag-and-drop product. 0070 built the flow, its immutable versions and the
-- enrolment pin, and said in its own header what it was NOT building: *"No interpreter state. `flow_run`,
-- the step log, the idempotency key and the execution cap are C-AUTO-07's."* This is that file, and
-- nothing here re-argues the pin.
--
-- ## The three tables, and why each is a table rather than a column
--
-- **`flow_run`** is where an enrolment has got to: the cursor, the executions it has spent, the ceiling it
-- was started under and how it ended. Separate from `flow_enrolment` because the two answer different
-- questions and 0070 says so — an enrolment's `status` is whether the contact is on the flow, a run's is
-- whether the interpreter is making progress, and a column that held both would be two facts in one. It is
-- also where a DRY RUN lives, with no enrolment at all: a projection is a run of the interpreter over an
-- audience, so making it the same table is what stops the dry run being a second interpreter.
--
-- **`flow_node_effect`** is the idempotency key, and it is a table because the guarantee is a UNIQUE
-- constraint. The acceptance line is exact: *"Idempotency is a unique constraint on (flow_run, node,
-- channel, contact) and the handler is at-least-once safe: delivering the same job 50 times produces
-- exactly one message row and 49 typed 'duplicate' outcomes."* So the handler INSERTS this row with
-- `on conflict on constraint flow_node_effect_once_per_contact do nothing` and reads the ABSENCE of a
-- returned row as `duplicate` — a typed outcome derived from the constraint itself, never a caught
-- exception whose message happened to mention uniqueness. The row carries no outcome and no message id: it
-- is a TOKEN, and everything a reader wants to know about what happened is on the step log beside it.
--
-- **`flow_step_log`** is the evidence. *"Every step log row names the definition version, node id, resolved
-- consent record id and gate decision, so 'why did this contact get this message' is one query."* One
-- query means one SELECT with no join, so every one of those four is a column here — including
-- `definition_version`, which a join to `flow_run` could have supplied and which is denormalised
-- deliberately: the composite foreign key below makes it a version that was really published, and a row
-- that had to be joined to be read is a row a support question answers with two queries.
--
-- ## Why the dry run's guarantee is in the database and not in the interpreter's care
--
-- *"Dry run writes a full projected step log ... and exactly zero message rows and zero provider calls."*
-- A code path that is careful is a code path somebody edits. So `flow_node_effect` refuses an INSERT for a
-- dry run outright and `flow_step_log` refuses one carrying a `message_id` (both ZY003), for every role
-- including the owner. The row-count assertions in the suite then measure a rule the database holds rather
-- than a habit the worker has.
--
-- ## Why the execution cap is a column and not a constant in SQL
--
-- `max_node_executions` is NOT NULL with NO DEFAULT, so the writer has to supply it —
-- `MAX_FLOW_NODE_EXECUTIONS` in `@berelax/shared`, which is the one place the provisional 200 is written.
-- A DEFAULT here would be a second statement of that figure and the first edit to either would make a run
-- judged by one ceiling and reported against another. What the database states is the RELATION:
-- `flow_run_executions_within_bound` says `node_executions` never exceeds the ceiling on its own row, so a
-- run that halted late could not be stored.
--
-- ## Why `flow_enrolment` gains a partial unique index here
--
-- Two acceptance lines meet on it. *"Enrolling the same contact twice in one flow yields one active
-- enrolment"* and *"a contact merged mid-run continues on the survivor exactly once"*. The first is a
-- dedupe the enrolment writer performs and the second is a MERGE, which goes nowhere near that writer:
-- `mergeCustomers` issues `update flow_enrolment set customer_id = survivor`, and with nothing to refuse it
-- the survivor would end up on one flow twice and be sent every node twice. So the guarantee is the index,
-- and the merge participant's conflict key is what turns a refusal into the loser's enrolment being
-- RETAINED on the tombstone with a stated reason.
--
-- The predicate is `ended_at is null` rather than `status = 'active'`, and the two are the same set:
-- 0070's `flow_enrolment_ended_matches_status` is the biconditional `(status = 'active') = (ended_at is
-- null)`. It is spelled the `is null` way because `MERGE_PARTICIPANT`'s `activePredicate` grammar
-- (`SQL_PREDICATE`, deliberately narrow — a grammar wide enough to be useful is wide enough to carry a
-- subquery into `sql.unsafe`) admits `<column> is [not] null` and nothing else.
--
-- ## What this file changes in 0035, and why now rather than then
--
-- `message.last_failure_reason` gains `stale_outside_window`. C-AUTO-04 deliberately did not add it and
-- said why: *"the value would be unwritable by anything, and a vocabulary with no writer is a CHECK five
-- other units' probes depend on, edited for a caller that does not exist."* The caller now exists — the
-- release job below is the first thing in this build that moves a held message — so the value is added
-- together with the one writer of it. `message_sent_counts_an_attempt` is relaxed in the same breath and
-- only for that reason: an expiry is a message that never left, so it has NO attempt, and the original
-- constraint would have made the honest row unstorable. A `sent` row with zero attempts is still refused,
-- which is what gate case 39c measures.
--
-- ## The private SQLSTATE class
--
-- Class `ZY`, and the choice is forced: `packages/db/src/sqlstate-uniqueness.test.ts` records that `ZA`
-- through `ZX` are taken and only `ZY` and `ZZ` are free, and thirteen codes already stand for two
-- unrelated rules each. Four codes, because four different refusals have four different runbook answers:
--
--   ZY001  a flow_step_log row was UPDATEd or DELETEd — the evidence is the record, and a support
--          question answered from an edited log is answered from nothing
--   ZY002  a flow_node_effect row was DELETEd, or UPDATEd in any way other than a merge re-pointing its
--          contact — removing the token is how a node comes to execute twice
--   ZY003  a DRY RUN tried to leave something behind: a node effect at all, or a step log row naming a
--          message. "A dry run sends nothing" has to hold for a psql session too
--   ZY004  a run's mode or its enrolment changed — a dry run turned into a live one would send every
--          message it had only projected

begin;

-- ---------------------------------------------------------------------------------------------
-- Vocabularies
-- ---------------------------------------------------------------------------------------------
-- Enums rather than text CHECKs, and each one is mirrored by a list in `@berelax/shared` that
-- `packages/fixtures/src/flow-interpreter.itest.ts` compares against `pg_enum` in BOTH directions. That
-- comparison is the whole reason an enum is safe here: two statements of one vocabulary are fine when
-- something fails the moment they disagree, and are a latent defect otherwise.
--
-- `flow_enrolment.ended_reason` deliberately stays `text` (0070's decision, and its reason still holds):
-- FLOW_END_REASONS is DERIVED from the DSL's own exit reasons plus the interpreter's halts, so an enum
-- would be a THIRD statement of a list that is already computed, and the day a ninth exit reason is drawn
-- the enum would be the thing refusing to store it.
create type flow_run_mode as enum ('live', 'dry_run');

comment on type flow_run_mode is
  'Whether a run performs its side effects or only projects them. A dry run has no enrolment and may '
  'leave behind no node effect and no message (ZY003).';

create type flow_run_status as enum ('running', 'completed', 'loop_detected', 'cancelled');

comment on type flow_run_status is
  'Where a run got to. loop_detected is a status of its own rather than a cancelled row with a reason, '
  'because the question an operator asks is "how many runs are halting" and that is a COUNT.';

create type flow_node_outcome as enum (
  'executed',
  -- The idempotency token was already there: this job has been delivered before. Nothing was sent.
  'duplicate',
  -- The gate held the message for the promotional window. The release instant is on the step log row.
  'held',
  -- The gate refused, the template was unusable, or the staging guard diverted it. Nothing left.
  'refused',
  -- A node with no side effect outside the run: a trigger, a delay, a condition, a split, an exit.
  'no_effect'
);

comment on type flow_node_outcome is
  'What one attempt at one node produced. FLOW_NODE_OUTCOMES in @berelax/shared is the same list, and '
  'flow-interpreter.itest.ts compares the two against pg_enum in both directions.';

-- ---------------------------------------------------------------------------------------------
-- The run
-- ---------------------------------------------------------------------------------------------
create table flow_run (
  id                      uuid            not null default uuid_generate_v7(),
  -- NULL for a dry run, and the biconditional below makes that the only reading. CASCADE for 0070's
  -- reason about `flow_enrolment.customer_id`: a run is a process attached to an enrolment, and a
  -- RESTRICT here would make `delete from customer` fail for every suite that clears the table.
  enrolment_id            uuid            references flow_enrolment (id) on delete cascade,
  flow_id                 uuid            not null,
  -- The version this run interprets. The interpreter reads the PINNED document and nothing else
  -- (`readEnrolmentPinnedDefinition`), so the run carries the number the enrolment pinned rather than
  -- resolving max(version) at every tick — which is the drift 0070 exists to prevent, one table along.
  definition_version      integer         not null,
  mode                    flow_run_mode   not null,
  status                  flow_run_status not null default 'running',
  node_executions         integer         not null default 0,
  -- The ceiling, from MAX_FLOW_NODE_EXECUTIONS. No DEFAULT: see the header.
  max_node_executions     integer         not null,
  -- The node to decide about next. NULL means "at the trigger", which is where a run starts.
  cursor_node_id          text
    constraint flow_run_cursor_is_a_node_id
      check (cursor_node_id is null or cursor_node_id ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- When a wait ends. Set by a delay node, cleared when the run resumes. Not the source of the resume —
  -- the pg-boss job's `startAfter` is — but the durable record of it, so a lost job is recoverable.
  resume_at               timestamptz,
  -- The instant the delays of the NEXT leg are measured from: when this run last resumed. Measuring every
  -- delay from `started_at` would make the second delay in a flow already elapsed.
  elapsed_from            timestamptz     not null,
  -- A dry run's audience, whole, and the rows the cap stopped it projecting. Both or neither, so an
  -- overflow can never be reported as nothing: a plan silently trimmed to a thousand rows is an operator
  -- reading the plan of a campaign they are not about to send.
  projected_audience_size integer
    constraint flow_run_projected_audience_is_not_negative
      check (projected_audience_size is null or projected_audience_size >= 0),
  projected_rows_omitted  integer
    constraint flow_run_projected_omission_is_not_negative
      check (projected_rows_omitted is null or projected_rows_omitted >= 0),
  started_at              timestamptz     not null,
  ended_at                timestamptz,
  -- From FLOW_END_REASONS. Text for the reason the header gives, held by `isFlowEndReason` at the one
  -- writer rather than by an enum that would be a third statement of a derived list.
  ended_reason            text
    constraint flow_run_ended_reason_not_placeholder
      check (ended_reason is null or not is_placeholder_text(ended_reason)),
  created_at              timestamptz     not null default now(),
  updated_at              timestamptz     not null default now(),

  constraint flow_run_pkey primary key (id),
  -- One LIVE run per enrolment. Nullable, so every dry run's NULL is distinct and the constraint says
  -- nothing about them.
  constraint flow_run_one_per_enrolment unique (enrolment_id),
  -- The same pin `flow_enrolment` carries, to the same pair, for the same reason: a version a run is
  -- interpreting cannot be removed and the pair cannot name a version that was never published.
  constraint flow_run_pins_a_definition_version
    foreign key (flow_id, definition_version) references flow_definition (flow_id, version)
    on update restrict on delete restrict,
  constraint flow_run_bound_is_positive check (max_node_executions >= 1),
  -- THE cap, as a relation between two columns rather than as the number 200 written here. A run that
  -- executed one node past its own ceiling cannot be stored, whatever the worker believed.
  constraint flow_run_executions_within_bound
    check (node_executions between 0 and max_node_executions),
  -- A live run is an enrolment's; a dry run is nobody's. Stated as a biconditional so neither half can
  -- drift into the other: a live run with no enrolment would be a send to nobody, and a dry run with one
  -- would be a projection somebody is enrolled on.
  constraint flow_run_live_run_is_an_enrolments
    check ((mode = 'live') = (enrolment_id is not null)),
  constraint flow_run_dry_run_reports_its_audience
    check ((mode = 'dry_run') = (projected_audience_size is not null)),
  constraint flow_run_audience_and_omission_travel_together
    check ((projected_audience_size is null) = (projected_rows_omitted is null)),
  -- An ended run has an end and a reason, and a running one has neither. 0070's arrangement on
  -- `flow_enrolment`, restated because the failure is the same: a `loop_detected` row with no `ended_at`
  -- is unreportable and a `running` row with one is a contradiction a reader resolves by guessing.
  constraint flow_run_ended_matches_status check ((status = 'running') = (ended_at is null)),
  constraint flow_run_ended_reason_matches_status
    check ((status = 'running') = (ended_reason is null)),
  constraint flow_run_ends_after_it_starts check (ended_at is null or ended_at >= started_at)
);

comment on table flow_run is
  'One run of the interpreter: a live run of one enrolment, or a dry run over an audience with no '
  'enrolment at all. It holds the cursor, the executions spent, the ceiling the run was started under '
  'and how it ended. What it SENT is flow_step_log; what it has already done once is flow_node_effect.';
comment on column flow_run.max_node_executions is
  'The execution ceiling this run was judged by, supplied by the writer from MAX_FLOW_NODE_EXECUTIONS. '
  'No DEFAULT: a number here would be a second statement of a provisional figure, and a run halted '
  'under one ceiling and reported against another is unanswerable.';
comment on column flow_run.projected_rows_omitted is
  'How many projected rows a dry run''s cap stopped it producing. Reported rather than trimmed in '
  'silence: zero is the only state in which the plan may be read as the whole plan.';

create trigger flow_run_updated_at before update on flow_run
  for each row execute function set_updated_at();

-- "Which runs are still going", without scanning finished ones.
create index flow_run_active_idx on flow_run (flow_id) where status = 'running';
-- The release sweep's read: a run waiting on an instant that has passed.
create index flow_run_resume_idx on flow_run (resume_at) where resume_at is not null;

-- ---------------------------------------------------------------------------------------------
-- The mode and the enrolment are immutable
-- ---------------------------------------------------------------------------------------------
-- Only those two. `status`, `cursor_node_id`, `node_executions`, `resume_at` and the ending are what the
-- interpreter moves, so a blanket refusal of UPDATE would make a run unable to progress — which is 0070's
-- reasoning about `flow_enrolment`'s pin, and the reason this is a column-level rule.
--
-- `is distinct from` rather than `<>` on both, because `enrolment_id` IS nullable and a comparison that
-- silently answers NULL is how a guard comes to pass everything (0065's note on `cleared_reason`).
create function refuse_flow_run_reidentification() returns trigger
language plpgsql
as $$
begin
  if new.mode is distinct from old.mode then
    raise exception
      'ZY004: a flow_run''s mode may not change. Turning a dry run into a live one would send every '
      'message it had only projected, from a row whose step log says nothing was sent.'
      using errcode = 'ZY004';
  end if;
  if new.enrolment_id is distinct from old.enrolment_id then
    raise exception
      'ZY004: a flow_run''s enrolment may not change. The run''s idempotency tokens are keyed on the run, '
      'so moving it onto another enrolment would hand that enrolment a set of nodes it is recorded as '
      'having already executed.'
      using errcode = 'ZY004';
  end if;
  return new;
end $$;

comment on function refuse_flow_run_reidentification() is
  'Raises ZY004 when an UPDATE would change flow_run.mode or flow_run.enrolment_id. Everything else on '
  'the row stays writable, because the interpreter has to be able to advance a run.';

create trigger flow_run_identity_is_immutable before update on flow_run
  for each row execute function refuse_flow_run_reidentification();

-- ---------------------------------------------------------------------------------------------
-- The idempotency token
-- ---------------------------------------------------------------------------------------------
-- The acceptance line's constraint, and the whole mechanism behind "delivering the same job 50 times
-- produces exactly one message row and 49 typed `duplicate` outcomes". The handler inserts this row with
-- `on conflict ... do nothing returning id` BEFORE it calls a transport; no returned row means the token
-- was already taken, which the caller reads as `duplicate` and answers without asking a vendor anything.
create table flow_node_effect (
  id                  uuid            not null default uuid_generate_v7(),
  flow_run_id         uuid            not null references flow_run (id) on delete cascade,
  node_id             text            not null
    constraint flow_node_effect_node_is_a_node_id check (node_id ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- The channel is part of the key because one node can legitimately reach one contact on two channels
  -- if a later DSL version says so, and a key without it would make the second one a duplicate of the
  -- first. `message_channel` rather than text, so a channel nobody implements cannot be claimed.
  channel             message_channel not null,
  -- The contact. CASCADE for 0053's reason, and the column a merge RE-POINTS: after a merge the contact
  -- IS the survivor, so the token has to move or the node would execute again under the survivor's key.
  contact_customer_id uuid            not null references customer (id) on delete cascade,
  claimed_at          timestamptz     not null,

  constraint flow_node_effect_pkey primary key (id),
  -- (flow_run, node, channel, contact). The acceptance line names these four and this is them.
  constraint flow_node_effect_once_per_contact
    unique (flow_run_id, node_id, channel, contact_customer_id)
);

comment on table flow_node_effect is
  'The idempotency token for one node of one run, reaching one contact on one channel. Inserted before '
  'any transport is called, so a replayed job reads the conflict as a typed duplicate outcome and asks '
  'no vendor anything. Every UPDATE except a merge re-pointing contact_customer_id raises ZY002, and so '
  'does every DELETE: removing a token is how a node comes to execute twice. A dry run may not insert '
  'one at all (ZY003).';
comment on column flow_node_effect.contact_customer_id is
  'The contact the node reached. Re-pointed by a customer merge and by nothing else, which is what makes '
  '"a contact merged mid-run continues on the survivor exactly once" hold: the token moves with the '
  'person, so the survivor''s key finds it.';

-- ---------------------------------------------------------------------------------------------
-- The step log
-- ---------------------------------------------------------------------------------------------
create table flow_step_log (
  id                   uuid              not null default uuid_generate_v7(),
  flow_run_id          uuid              not null references flow_run (id) on delete cascade,
  flow_id              uuid              not null,
  -- Denormalised deliberately: "why did this contact get this message" must be ONE query, and a version
  -- that had to be joined out of flow_run is a support question answered with two. The composite foreign
  -- key below is what keeps it honest.
  definition_version   integer           not null,
  node_id              text              not null
    constraint flow_step_log_node_is_a_node_id check (node_id ~ '^[a-z][a-z0-9_]{0,31}$'),
  node_kind            text              not null
    constraint flow_step_log_node_kind_not_placeholder check (not is_placeholder_text(node_kind)),
  -- The branch the run took out of this node: `default`, a condition's true/false, or a split's label.
  -- On the row rather than derivable, because a split's choice is a fact about THIS run.
  branch               text              not null
    constraint flow_step_log_branch_is_a_label check (branch ~ '^[a-z][a-z0-9_]{0,31}$'),
  outcome              flow_node_outcome not null,
  contact_customer_id  uuid              not null references customer (id) on delete cascade,
  channel              message_channel,
  template_key         text,
  -- The message this step produced. NULL for a node that sends nothing, for a refusal (B-MSG-04's rule:
  -- a refused send writes no message row) and for every dry-run row (ZY003 refuses one).
  message_id           uuid              references message (id) on delete restrict,
  -- The consent record the gate's answer actually rested on, by id. `resolveConsent` returns it
  -- (`ConsentResolution.recordId`); the gate reduces the same resolution to a boolean, and recording the
  -- id is how the boolean is recovered rather than recomputed differently. NULL for a transactional node
  -- and for a node that asked nothing.
  consent_record_id    uuid              references consent (id) on delete restrict,
  -- The gate's own word: `allow`, `refused_no_consent`, `queued_for_window`, `stale_outside_window`, and
  -- so on. Text rather than an enum because the vocabulary is `@berelax/messaging`'s GateDecision and its
  -- refusals, which this schema does not own; an enum here would be the drifting copy.
  gate_decision        text
    constraint flow_step_log_gate_decision_not_placeholder
      check (gate_decision is null or not is_placeholder_text(gate_decision)),
  -- When the node ran, or — for a dry run — when it WOULD run. One column for both, because a projection
  -- whose instant meant something different from a live row's could not be compared with the run.
  planned_at           timestamptz       not null,
  -- The authoring-time figures, which a dry run needs in order to be a quotation and a live row keeps as
  -- what was charged. `fils`, so it is the same money type as every other cost in this schema (ADR 0007).
  encoding             text
    constraint flow_step_log_encoding_known
      check (encoding is null or encoding in ('GSM-7', 'UCS-2')),
  segments             smallint
    constraint flow_step_log_segments_not_negative check (segments is null or segments >= 0),
  cost_fils            fils
    constraint flow_step_log_cost_not_negative check (cost_fils is null or cost_fils >= 0),
  -- Why this step did what it did, when the outcome alone does not say: a refusal's detail, a halt's
  -- explanation, the release instant a hold was given.
  detail               text,
  recorded_at          timestamptz       not null default now(),

  constraint flow_step_log_pkey primary key (id),
  constraint flow_step_log_pins_a_definition_version
    foreign key (flow_id, definition_version) references flow_definition (flow_id, version)
    on update restrict on delete restrict,
  -- A message row belongs to a step that sent something. Stated the one way round that is always true: a
  -- `no_effect` or `duplicate` step never has one, and an `executed` step on a node that sends nothing
  -- does not either — so the biconditional would be false in the harmless direction.
  constraint flow_step_log_message_belongs_to_a_send
    check (message_id is null or outcome in ('executed', 'held')),
  -- An SMS costing is a set: an encoding with no segment count is half a quotation, and a dry run whose
  -- plan showed one without the other could not be compared with the invoice.
  constraint flow_step_log_costing_is_whole
    check ((encoding is null) = (segments is null) and (segments is null) = (cost_fils is null)),
  -- A costing belongs to a message node. Anything else with one is a cost attributed to a tag.
  constraint flow_step_log_costing_belongs_to_a_message
    check (encoding is null or channel is not null)
);

comment on table flow_step_log is
  'One row per node one run took, live or projected. Append-only: UPDATE and DELETE raise ZY001 for '
  'every role including the owner, because this is the evidence a support question is answered from and '
  'an edited log answers nothing. Every row names the definition version, the node, the resolved consent '
  'record and the gate decision, so "why did this contact get this message" is one SELECT with no join.';
comment on column flow_step_log.consent_record_id is
  'The consent row the gate''s answer rested on, as resolveConsent named it. The gate reduces the same '
  'resolution to a boolean; this is how the boolean is recovered rather than recomputed differently.';
comment on column flow_step_log.definition_version is
  'The version of the flow this step was taken under, denormalised so the question is one query, and '
  'held to a version that was really published by flow_step_log_pins_a_definition_version.';

-- THE read behind "why did this contact receive this message": one contact, newest first.
create index flow_step_log_contact_idx on flow_step_log (contact_customer_id, planned_at desc);
-- And from the other end: everything one message's step said about itself.
create index flow_step_log_message_idx on flow_step_log (message_id) where message_id is not null;
create index flow_step_log_run_idx on flow_step_log (flow_run_id, planned_at);

-- ---------------------------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------------------------
-- Triggers that RAISE rather than `create rule ... do instead nothing`, for 0066's reason: a rule reports
-- success, so code that edited the log would believe it had. Both fire for EVERY role including the owner
-- — the revokes below cover the application role, and the owner is who edits a row by hand at 2am.
create function refuse_flow_step_log_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'ZY001: flow_step_log is append-only; % is refused. This is what "why did this contact get this '
    'message" is answered from, so a row that can be edited is an answer nobody can rely on. A step that '
    'was wrong is corrected by the next run''s rows, not by rewriting this one.',
    tg_op
    using errcode = 'ZY001';
end $$;

comment on function refuse_flow_step_log_change() is
  'Raises ZY001 (FlowStepLogAppendOnly) for flow_step_log, for every role including the owner.';

create trigger flow_step_log_no_update before update on flow_step_log
  for each row execute function refuse_flow_step_log_change();
create trigger flow_step_log_no_delete before delete on flow_step_log
  for each row execute function refuse_flow_step_log_change();

-- The token is narrower: a customer merge re-points `contact_customer_id` and nothing else may move.
-- `package_sale`'s arrangement (0078, ZG001) applied to an idempotency key, and for the same shape of
-- reason — the one legitimate UPDATE in the system touches one column.
create function refuse_flow_node_effect_change() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'ZY002: a flow_node_effect row may not be deleted. It is the record that this node has already '
      'reached this contact on this channel, so removing it is how a message comes to be sent twice. A '
      'run that should not continue is ended on flow_run, not by clearing its tokens.'
      using errcode = 'ZY002';
  end if;
  if new.flow_run_id is distinct from old.flow_run_id
     or new.node_id is distinct from old.node_id
     or new.channel is distinct from old.channel
     or new.claimed_at is distinct from old.claimed_at
     or new.id is distinct from old.id then
    raise exception
      'ZY002: a flow_node_effect row may only ever have its contact_customer_id changed, and only by a '
      'customer merge re-pointing it onto the survivor. Moving the run, the node, the channel or the '
      'instant would make the token describe an execution that never happened.'
      using errcode = 'ZY002';
  end if;
  return new;
end $$;

comment on function refuse_flow_node_effect_change() is
  'Raises ZY002 (FlowNodeEffectImmutable) for a DELETE, and for an UPDATE of anything but '
  'contact_customer_id — which a customer merge re-points and nothing else does.';

create trigger flow_node_effect_no_delete before delete on flow_node_effect
  for each row execute function refuse_flow_node_effect_change();
create trigger flow_node_effect_only_repoint before update on flow_node_effect
  for each row execute function refuse_flow_node_effect_change();

-- ---------------------------------------------------------------------------------------------
-- A dry run leaves nothing behind
-- ---------------------------------------------------------------------------------------------
-- The database's own statement of "exactly zero message rows and zero provider calls". A CHECK cannot see
-- the parent row's mode, so this is a trigger — and it is the reason the suite's row-count assertions
-- measure a rule rather than the worker's care.
create function refuse_dry_run_side_effect() returns trigger
language plpgsql
as $$
declare
  run_mode flow_run_mode;
begin
  select mode into run_mode from flow_run where id = new.flow_run_id;
  if run_mode is distinct from 'dry_run' then
    return new;
  end if;
  if tg_table_name = 'flow_node_effect' then
    raise exception
      'ZY003: a dry run may not claim an idempotency token. A token is the record that a side effect '
      'happened, and a dry run has none — one left behind would make the LIVE run of the same flow skip '
      'the node as a duplicate and send nothing at all.'
      using errcode = 'ZY003';
  end if;
  if new.message_id is not null then
    raise exception
      'ZY003: a dry run''s step log row may not name a message. The whole claim is zero message rows, '
      'and a projection pointing at one is either a message that was sent or a reference to somebody '
      'else''s.'
      using errcode = 'ZY003';
  end if;
  return new;
end $$;

comment on function refuse_dry_run_side_effect() is
  'Raises ZY003 when a dry run would leave a side effect behind: any flow_node_effect row, or a '
  'flow_step_log row naming a message. Fires for every role including the owner.';

create trigger flow_node_effect_not_for_a_dry_run before insert on flow_node_effect
  for each row execute function refuse_dry_run_side_effect();
create trigger flow_step_log_dry_run_sends_nothing before insert on flow_step_log
  for each row execute function refuse_dry_run_side_effect();

-- ---------------------------------------------------------------------------------------------
-- One ACTIVE enrolment per contact per flow
-- ---------------------------------------------------------------------------------------------
-- See the header. Partial on `ended_at is null`, which is exactly `status = 'active'` by 0070's
-- `flow_enrolment_ended_matches_status`, and spelled this way so the merge participant's narrow
-- `activePredicate` grammar can state it.
create unique index flow_enrolment_one_active_per_contact
  on flow_enrolment (flow_id, customer_id)
  where ended_at is null;

comment on index flow_enrolment_one_active_per_contact is
  'A contact may be on one flow once at a time. This is what makes "enrolling the same contact twice '
  'yields one active enrolment" a guarantee rather than a habit of the enrolment writer, and it is also '
  'what a customer merge meets: the loser''s enrolment is RETAINED on the tombstone rather than giving '
  'the survivor two runs of one flow and two of every message.';

-- ---------------------------------------------------------------------------------------------
-- A held message can now expire, because something finally releases one
-- ---------------------------------------------------------------------------------------------
-- See the header for why this belongs to this file rather than to C-AUTO-04.
alter table message drop constraint message_failure_reason_known;
alter table message add constraint message_failure_reason_known check (
  last_failure_reason is null or last_failure_reason in (
    'provider_rejected',
    'provider_rate_limited',
    'provider_unavailable',
    'provider_error',
    'delivery_reported_failed',
    -- The two ways a HELD promotional message ends without ever having been attempted, both written by
    -- the release path this unit adds and by nothing else. HELD_MESSAGE_TERMINAL_REASONS in
    -- @berelax/shared is the same pair.
    --
    -- Held for longer than MAX_QUEUED_PROMOTIONAL_STALENESS_SECONDS, so it expires unsent rather than
    -- arriving late. Y9-queued-staleness: a 23:00 offer released at 07:00 is advertising yesterday, and
    -- the recipient's allowance would be spent on a message about something that has gone.
    'stale_outside_window',
    -- The gate refused at RELEASE time a message it had held: the contact withdrew consent, was
    -- suppressed or crossed the frequency cap while the message waited for the window. Kept apart from
    -- the expiry because it is different work for whoever reads the report - this one is the compliance
    -- path working rather than a fault.
    'refused_after_hold')
);

alter table message drop constraint message_sent_counts_an_attempt;
alter table message add constraint message_sent_counts_an_attempt check (
  status = 'queued'
  or attempts >= 1
  -- An expiry is the one terminal state with no attempt: nothing was ever handed to a vendor, which is
  -- the whole difference between it and a failure. A `sent` row with no attempt is still refused, which
  -- is the rule this constraint was written for (docs/12 §1: a stub must never look like it worked).
  or last_failure_reason in ('stale_outside_window', 'refused_after_hold')
);

comment on constraint message_sent_counts_an_attempt on message is
  'Nothing leaves the system without a counted attempt. The two exceptions are a held promotional message '
  'that expired unsent and one the gate refused at release time: neither has an attempt because no vendor '
  'was ever asked, and both are terminal for that reason. A sent row with zero attempts is still refused.';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 grants the application role select/insert/update/delete on every table created in `public`
-- afterwards and sets default privileges extending that to later tables, so these arrive with UPDATE and
-- DELETE already granted and the revokes are load-bearing. The door is held twice, 0072's and 0078's
-- arrangement: the triggers above refuse for every role, and the grants refuse before a trigger is
-- reached.
--
-- The table-level REVOKE has to come FIRST. A column-list grant does not narrow an existing table-level
-- one, and leaving the revoke out cost 0076 a whole run.
revoke update, delete, truncate on flow_step_log from berelax_app;

revoke update, delete, truncate on flow_node_effect from berelax_app;
-- The one legitimate UPDATE in the system: a customer merge re-pointing the token onto the survivor.
grant update (contact_customer_id) on flow_node_effect to berelax_app;

-- `flow_run` stays fully writable except for DELETE: the interpreter advances a run, and a run that
-- should stop is ENDED rather than removed — a deleted run is a set of tokens with nothing to explain
-- them, and the cascade from `flow_enrolment` still works because a referential action runs with the
-- privileges of the referencing table's owner rather than the caller's.
revoke delete, truncate on flow_run from berelax_app;

commit;
