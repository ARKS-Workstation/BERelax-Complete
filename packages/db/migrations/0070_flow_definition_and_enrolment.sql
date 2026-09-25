-- 0070 — the flow, its immutable versions, and the enrolment pin that cannot drift.
--
-- C-AUTO-06's subject is one question: four hundred people are mid-flow and the owner edits it. The
-- answer this migration encodes is that an edit PUBLISHES A NEW VERSION and changes nothing about the
-- enrolments already running, because each of those names the exact version row it started under through
-- a composite foreign key. That is the same reasoning `leave_entitlement_rule` uses for a leave policy
-- (0066) and `checkout_finalisation` uses for a posting account (0063): a rule that is asked about the
-- PAST must be stored per version, and a reference that resolves to "the current one" cannot answer.
--
-- ## What is NOT here, and where it is
--
-- **No draft.** `flow_definition` holds PUBLISHED versions only, every one of them immutable. A builder's
-- work in progress lives in the builder (C-AUTO-09, whose acceptance requires save to be disabled while
-- the graph is invalid rather than a half-flow to be stored), so there is no `status` column and no
-- `published -> superseded` transition — which is deliberate, because such a transition would be an
-- UPDATE on a published row and the whole point of this table is that there is no such thing. Which
-- version is LIVE is `max(version)` for the flow, by construction; there is no `live_version` column to
-- disagree with the rows.
--
-- **No interpreter state.** `flow_run`, the step log, the idempotency key and the execution cap are
-- C-AUTO-07's (`packages/db/src/schema/flow-run.ts`). `flow_enrolment` here is the pin and the lifecycle
-- of an enrolment, and nothing about where in the graph it currently is.
--
-- **No validation.** The DSL's rules — one trigger, no dangling edge, no unbounded loop, a path delay
-- inside the maximum, an action bound to a template of its own class — are in `@berelax/core`
-- (`automation/dsl.ts`, `automation/static-analysis.ts`) and are injected into `publishFlowDefinition`,
-- because `packages/db` may not import `packages/core`. What the DATABASE refuses is the narrow set a
-- CHECK can state about a document: the DSL version it declares, and a node count inside the bound. The
-- two layers are the pair `schemas/consent.ts` describes — zod refuses a bad document at the edge with a
-- message a person can read, and the database refuses it at the last possible moment with no way round.
--
-- ## Why `node_count` is GENERATED
--
-- The bound on nodes (60, provisional) has to hold where the row is written, not only where the document
-- is parsed. A plain integer column would be a second statement of a fact the document already carries,
-- and the first `update` nobody wrote would make the two disagree. Generated from
-- `jsonb_array_length(definition -> 'nodes')` it cannot: a document with no `nodes` array raises on
-- INSERT rather than storing a flow with no steps, and the CHECK is then a statement about the document
-- itself.
--
-- ## The private SQLSTATE class
--
-- `ZF001` (FlowDefinitionImmutable) and `ZF002` (FlowEnrolmentPinImmutable). A private class rather than
-- `restrict_violation`, for 0061's reason: seven other triggers and every ON DELETE RESTRICT foreign key
-- in this schema raise that, so a probe asserting it passes when the statement bounced off something
-- else entirely. Two codes and not one, because the two refusals are different facts with different
-- runbook answers — one is "a published flow cannot be edited, publish a new version", the other is
-- "an enrolment cannot be moved onto another version, and nobody is allowed to migrate them in bulk".

begin;

-- ---------------------------------------------------------------------------------------------
-- The flow
-- ---------------------------------------------------------------------------------------------
create table flow (
  id          uuid        not null default uuid_generate_v7(),
  -- The stable machine key. UNIQUE, so two flows cannot share one name and an enrolment API can be
  -- called with a key rather than with a uuid nobody can read in a log.
  flow_key    text        not null
    constraint flow_key_is_lower_snake_case check (flow_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  title       text        not null
    constraint flow_title_not_placeholder check (not is_placeholder_text(title)),
  -- Whether the flow may take new enrolments. FALSE by default, and that default is the rule: publishing
  -- a version is drawing a flow, and enabling it is a separate decision somebody makes on purpose. A
  -- default of true would make the first publish of a win-back sequence start messaging the lapsed list.
  is_active   boolean     not null default false,
  created_by  text        not null
    constraint flow_created_by_not_placeholder check (not is_placeholder_text(created_by)),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint flow_pkey primary key (id),
  constraint flow_key_unique unique (flow_key)
);

comment on table flow is
  'One automation flow: its key, its title and whether it may take new enrolments. The DEFINITION is '
  'not here - every published version of it is a row in flow_definition, and the live version is '
  'max(version) for this flow rather than a column that could disagree with the rows.';
comment on column flow.is_active is
  'Whether the flow may take new enrolments. Defaults to FALSE: publishing a version is drawing a flow, '
  'and enabling it is a separate decision. A default of true makes the first publish of a win-back '
  'sequence start messaging the lapsed list.';

create trigger flow_updated_at before update on flow
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- The versions
-- ---------------------------------------------------------------------------------------------
create table flow_definition (
  flow_id      uuid        not null references flow (id) on delete restrict,
  -- Counts an operator's EDITS, from 1. Not a timestamp and not a digest: an enrolment pins this number,
  -- and a number a person can say out loud is what makes "the 400 are still on version 3" a sentence.
  version      integer     not null
    constraint flow_definition_version_is_positive check (version >= 1),
  -- The DSL's own schema version (FLOW_DSL_VERSION in @berelax/shared), so a reader can tell a version-1
  -- document from a version-2 one without parsing it.
  dsl_version  integer     not null
    constraint flow_definition_dsl_version_is_positive check (dsl_version >= 1),
  -- The document. `jsonb` rather than `json`: the canonical form `serialiseFlowDefinition` produces sorts
  -- every object's keys, so it is invariant under jsonb's normalisation and a stored definition still
  -- serialises byte-identically to what was published.
  definition   jsonb       not null,
  -- GENERATED, so it cannot disagree with the document. See the header.
  node_count   integer     generated always as (jsonb_array_length(definition -> 'nodes')) stored,
  published_by text        not null
    constraint flow_definition_published_by_not_placeholder check (not is_placeholder_text(published_by)),
  published_at timestamptz not null default now(),

  constraint flow_definition_pkey primary key (flow_id, version),
  -- The pair a `flow_enrolment` row points at. Named, because the enrolment's foreign key names it.
  constraint flow_definition_dsl_version_matches_document
    check (dsl_version is not distinct from (definition ->> 'dslVersion')::integer),
  -- The provisional bound from the manifest (60 nodes), enforced where the row is written.
  constraint flow_definition_node_count_within_maximum check (node_count between 1 and 60)
);

comment on table flow_definition is
  'One row per PUBLISHED version of a flow. Append-only: UPDATE and DELETE raise ZF001 for every role '
  'including the owner, because a version some enrolment is running on is the only record of what that '
  'enrolment agreed to do, and an edited definition leaves 400 people mid-flow on a graph nobody drew. '
  'An edit publishes version N+1; there is no draft state and no supersession column, because both '
  'would be an UPDATE on a row this table refuses to update.';
comment on column flow_definition.version is
  'Counts an operator''s edits from 1. The live version is max(version) for the flow; an enrolment pins '
  'the exact number it started under, through flow_enrolment_pins_a_definition_version.';
comment on column flow_definition.definition is
  'The flow DSL document, validated by validateFlowDefinition in @berelax/core before it is written. '
  'Stored in the canonical sorted-key form, which is invariant under jsonb normalisation.';
comment on column flow_definition.node_count is
  'GENERATED from the document. A plain column would be a second statement of the same fact, and the '
  'first UPDATE nobody wrote would make the two disagree.';

create index flow_definition_published_at_idx on flow_definition (flow_id, published_at desc);

-- ---------------------------------------------------------------------------------------------
-- Append-only enforcement for a published version
-- ---------------------------------------------------------------------------------------------
-- A trigger that RAISES rather than `create rule ... do instead nothing`, for 0066's reason: a rule
-- reports success, so code that edited a published flow would believe it had. Fires for EVERY role
-- including the owner — the revokes below cover the application role, and the owner is who edits a row
-- by hand at 2am to "just fix one delay".
create function refuse_flow_definition_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'flow_definition is append-only; % is refused. A published version is what the enrolments running '
    'on it agreed to do, so an edit is a new version (publishFlowDefinition) and never a change to this '
    'row: editing it in place moves every in-flight enrolment onto a graph nobody drew.',
    tg_op
    using errcode = 'ZF001';
end $$;

comment on function refuse_flow_definition_change() is
  'Raises ZF001 (FlowDefinitionImmutable) for flow_definition, for every role including the owner. The '
  'FLOW stays editable - its title, its key and whether it is active; what has been published does not.';

create trigger flow_definition_no_update before update on flow_definition
  for each row execute function refuse_flow_definition_change();
create trigger flow_definition_no_delete before delete on flow_definition
  for each row execute function refuse_flow_definition_change();

-- ---------------------------------------------------------------------------------------------
-- The enrolment, and its pin
-- ---------------------------------------------------------------------------------------------
-- Three labels and no more. `active` is running, `completed` is an exit node reached, `cancelled` is a
-- human or a merge ending it early. Where in the graph an active enrolment currently is, how many nodes
-- it has executed and what it sent are C-AUTO-07's `flow_run` and step log, not columns here.
create type flow_enrolment_status as enum ('active', 'completed', 'cancelled');

comment on type flow_enrolment_status is
  'Whether an enrolment is running, finished at an exit node, or was ended early. The step it is on is '
  'not here: that is flow_run (C-AUTO-07), and a status column that tried to hold both would be two '
  'facts in one.';

create table flow_enrolment (
  id                 uuid                  not null default uuid_generate_v7(),
  -- The pair. `flow_id` is NOT separately a foreign key to `flow`: the composite key below already
  -- guarantees a version row, and a version row already guarantees its flow, so a second constraint on
  -- the same column would be a second thing to keep in step.
  flow_id            uuid                  not null,
  -- The pinned version. NOT NULL, so there is no reference that can silently follow the latest version:
  -- a nullable column here would make "not pinned yet" expressible, and every reader would then have to
  -- decide what to do with it - and the convenient decision is to read max(version), which is the drift
  -- this whole migration exists to prevent.
  definition_version integer               not null,
  -- CASCADE, which is 0053's choice for every satellite table about a customer. An enrolment is a
  -- process attached to a contact: with the contact gone there is nobody to send to, and a RESTRICT here
  -- would also make `delete from customer` fail for every suite that clears the table (the hazard 0063
  -- records about truncating `appointment`).
  customer_id        uuid                  not null references customer (id) on delete cascade,
  status             flow_enrolment_status not null default 'active',
  enrolled_at        timestamptz           not null default now(),
  ended_at           timestamptz,
  -- Why it ended. The DSL's exit reasons are the vocabulary an exit node writes here (C-AUTO-07); a
  -- cancellation writes its own words. Free text and not an enum, because the interpreter that fills it
  -- does not exist yet and an enum this unit guessed at would be a vocabulary somebody has to migrate.
  ended_reason       text
    constraint flow_enrolment_ended_reason_not_placeholder
      check (ended_reason is null or not is_placeholder_text(ended_reason)),
  created_by         text                  not null
    constraint flow_enrolment_created_by_not_placeholder check (not is_placeholder_text(created_by)),

  constraint flow_enrolment_pkey primary key (id),
  -- THE pin. A composite foreign key to the exact version row, so a version an enrolment is running on
  -- cannot be removed and the pair cannot name a version that was never published.
  constraint flow_enrolment_pins_a_definition_version
    foreign key (flow_id, definition_version) references flow_definition (flow_id, version)
    on update restrict on delete restrict,
  -- An ended enrolment has an end, and a running one has none. One biconditional, so neither half can
  -- drift: a `completed` row with no `ended_at` is unreportable, and an `active` row with one is a
  -- contradiction a reader resolves by guessing.
  constraint flow_enrolment_ended_matches_status
    check ((status = 'active') = (ended_at is null)),
  constraint flow_enrolment_ended_reason_matches_status
    check ((status = 'active') = (ended_reason is null)),
  constraint flow_enrolment_ends_after_it_starts
    check (ended_at is null or ended_at >= enrolled_at)
);

comment on table flow_enrolment is
  'One enrolment of one contact on one PINNED version of a flow. The pin is the point: '
  'flow_enrolment_pins_a_definition_version is a composite foreign key to (flow_id, version), so an '
  'enrolment keeps being governed by the version it started under after the flow is edited, and '
  'definition_version is NOT NULL so there is no reference that can quietly follow max(version). The '
  'pin is also immutable - an UPDATE that changed either column raises ZF002 - because the bulk '
  '"upgrade everyone to the latest" is exactly the statement this design exists to refuse.';
comment on column flow_enrolment.definition_version is
  'The version this enrolment is governed by, for its whole life. NOT NULL and immutable (ZF002).';
comment on column flow_enrolment.ended_reason is
  'Why it ended: an exit node''s reason from the DSL, or a cancellation''s own words. Free text rather '
  'than an enum because the interpreter that writes it is C-AUTO-07''s and a vocabulary guessed at here '
  'would be one somebody has to migrate.';

-- The index the pinning question is asked through: "how many enrolments remain on version N", which
-- C-AUTO-09 displays before saving an edit and this unit's test counts.
create index flow_enrolment_version_idx on flow_enrolment (flow_id, definition_version);
create index flow_enrolment_customer_idx on flow_enrolment (customer_id);
-- Answering "what is still running" without scanning finished enrolments.
create index flow_enrolment_active_idx on flow_enrolment (flow_id) where status = 'active';

-- ---------------------------------------------------------------------------------------------
-- The pin is immutable
-- ---------------------------------------------------------------------------------------------
-- Only the pin. `status`, `ended_at` and `ended_reason` are what the interpreter moves, so a blanket
-- refusal of UPDATE would make an enrolment unable to finish — which is why this is a column-level rule
-- and not the append-only pair `flow_definition` carries.
--
-- `is distinct from` rather than `<>` on both columns: neither is nullable today, but a comparison that
-- silently answers NULL is how a guard comes to pass everything (0065's note on `cleared_reason`).
create function refuse_flow_enrolment_repin() returns trigger
language plpgsql
as $$
begin
  if new.flow_id is distinct from old.flow_id
     or new.definition_version is distinct from old.definition_version then
    raise exception
      'flow_enrolment.% may not change: an enrolment is governed by the version it started under for '
      'its whole life. Moving it onto another version is the bulk "upgrade everyone to the latest" that '
      'would silently change what 400 people mid-flow are about to be sent.',
      case when new.flow_id is distinct from old.flow_id then 'flow_id' else 'definition_version' end
      using errcode = 'ZF002';
  end if;
  return new;
end $$;

comment on function refuse_flow_enrolment_repin() is
  'Raises ZF002 (FlowEnrolmentPinImmutable) when an UPDATE would change flow_id or definition_version. '
  'Everything else on the row stays writable, because the interpreter has to be able to finish an '
  'enrolment.';

create trigger flow_enrolment_pin_is_immutable before update on flow_enrolment
  for each row execute function refuse_flow_enrolment_repin();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 grants the application role select/insert/update/delete on every table created in `public`
-- afterwards, so these revokes are load-bearing rather than decorative — and stated explicitly because a
-- managed database restored from a dump does not necessarily carry the same defaults.
--
-- The triggers above already refuse for every role. These are the second layer, and the one that gives a
-- caller a privilege error rather than a raised exception: "you may not" rather than "you tried".
revoke update, delete, truncate on flow_definition from berelax_app;
-- An enrolment is a record of something that happened to a contact. Ending one is a status change, so
-- DELETE has no legitimate caller; the cascade from `customer` still works, because a referential action
-- runs with the privileges of the referencing table's owner rather than the caller's.
revoke delete, truncate on flow_enrolment from berelax_app;

commit;
