-- 0154 — segments, campaigns, and a spend cap the DATABASE enforces.
--
-- C-AUTO-10. docs/03 §5 asks for segments that compile to one query with a cached count, and campaigns
-- that estimate recipients, segments and cost before launch and then stop at a cap. Three decisions shape
-- this file, and the first one is the only one that could not be put off.
--
-- 1. **THE CAP IS THE DATABASE'S, NOT THE SENDER'S.** `CampaignSpend` in
--    `packages/messaging/src/send.ts` already checks a cap before every send, and that check is right and
--    is not enough: it holds a counter in one process. Two workers draining one campaign each read a
--    spend of 400 of a 500 cap, each decide one more message fits, and both send — so the cap is
--    exceeded by exactly as many workers as are running. A cap in application code is a cap until two
--    workers run.
--
--    So the reservation and the recipient's claim are ONE STATEMENT: `claim_campaign_recipient` takes the
--    campaign row's lock, picks the next pending recipient, and either adds the estimate to `spent_fils`
--    and hands the recipient back, or marks that recipient `held` with `cap_exceeded` and hands back
--    nothing. There is no window between the check and the record for a second worker to run in.
--
--    And there is a second, structural layer underneath, for the day somebody rewrites the function:
--    `campaign_spend_within_cap` is a CHECK, so `spent_fils` cannot exceed `cap_fils` by any route at
--    all — a hand-written UPDATE, a future function, a `psql` session. That is the two-layer shape
--    `frequency_cap_value_is_a_cap()` has in 0080 and `effectivePromotionalHours` has in
--    `promotional-window.ts`: the readable refusal for a human, and the structural one that holds when the
--    readable one is bypassed. ZY753 is the third layer and the narrowest: `spent_fils` may be MOVED only
--    from inside the two functions, so a direct UPDATE is refused by name rather than merely bounded.
--
-- 2. **A SENT ROW CARRIES ITS GATE DECISION AND ITS CONSENT RECORD, AND THE DATABASE REQUIRES IT.** The
--    acceptance line is *"so a regulator question is answerable from one query"*, and a question is
--    answerable from one query only if the columns cannot be null on a sent row. A test asserting it is a
--    test about the rows that exist; `campaign_recipient_sent_row_is_answerable` is a statement about every
--    row that ever will. `consent_record_id` is the `consent` row's id and is a plain uuid rather than a
--    foreign key, for `consent.contact_customer_id`'s stated reason (0056): the consent ledger is
--    deliberately not joined to by reference, so an erasure cannot cascade a regulator's evidence away.
--
-- 3. **THE CACHED COUNT IS DATED OR IT IS NOT THERE.** `customer_segment_cached_count_is_dated` holds the
--    number and its instant together, both or neither. A count with no instant is a number a screen shows
--    next to a send button with nothing saying how old it is, and C-AUTO-10's provisional answer is
--    explicit that the timestamp is shown "next to the number rather than hidden" — which it cannot be if
--    the row is allowed not to have one.
--
-- **The promotional window is NOT in this file.** `messaging.promotional_window` is the ceiling and
-- `packages/core/src/messaging/promotional-window.ts` is the rule; a CHECK on `scheduled_at` would be a
-- second answer to when a message may be sent, and the symptom of two answers is a campaign every screen
-- says was compliant. `scheduled_at` is therefore an instant with no window constraint on it, and
-- `refuseCampaignScheduleOutsideWindow` in `@berelax/core` is what refuses one at authoring time.
--
-- **No spend figure is written here.** `cap_fils` is NOT NULL with no default: the AED 500 in
-- C-AUTO-10's manifest entry is a provisional value and it lives in the F09 settings registry where it
-- carries `provisional: true` and reaches the Unconfirmed Assumptions panel. A default here would be the
-- same number in a place that cannot say it is provisional.

-- ---------------------------------------------------------------------------------------------
-- The vocabularies
-- ---------------------------------------------------------------------------------------------
create type campaign_state as enum (
  'draft',      -- Being written. No recipients may be claimed.
  'scheduled',  -- An instant has been set and accepted against the promotional window.
  'running',    -- Claimable. The only state claim_campaign_recipient will claim from.
  'halted',     -- Stopped before the end: the cap bound, or the window closed under it.
  'completed',  -- Every recipient reached a terminal state.
  'cancelled'
);

comment on type campaign_state is
  'Where a campaign is. ''halted'' is deliberately ONE state with a reason column rather than '
  '''halted_cap'' and ''halted_window'': the two are stopped campaigns with a remainder held, the '
  'operator does the same thing about both, and a per-cause state is the shape that grows a third label '
  'nobody handles. The reason is campaign.halted_reason.';

create type campaign_recipient_state as enum (
  'pending',  -- Enumerated at launch, not yet claimed by a worker.
  'claimed',  -- Reserved against the cap. Exactly one worker holds it.
  'sent',     -- Left the choke point. Carries its gate decision and consent record.
  'held',     -- Not sent and not failed: the cap bound, or the window closed. Still owed.
  'failed'    -- The transport refused it. The reservation is released.
);

comment on type campaign_recipient_state is
  'One recipient''s outcome. ''held'' and ''failed'' are different facts and the acceptance line depends '
  'on the difference: held + sent == total is the arithmetic a halted campaign is read by, and a '
  'provider failure is not a message the campaign still owes.';

create type campaign_halt_reason as enum ('spend_cap_reached', 'promotional_window_closed', 'operator');

comment on type campaign_halt_reason is
  'Why a running campaign stopped. Null while it has not. Separate from campaign_state for the reason '
  'that type''s comment gives.';

-- ---------------------------------------------------------------------------------------------
-- The segment
-- ---------------------------------------------------------------------------------------------
create table customer_segment (
  id uuid primary key default uuid_generate_v7(),
  segment_key text not null,
  title text not null,
  -- The definition document, as `serialiseSegmentDefinition` produces it. jsonb and not SQL text: the
  -- compiler in `packages/core/src/automation/segment-compile.ts` turns it into one parameterised query
  -- against an allowlisted attribute registry, and a stored SQL string would be a stored injection with a
  -- cached count attached. Nothing in this build ever executes bytes from this column.
  definition jsonb not null,
  -- GENERATED ALWAYS, for flow_definition.node_count's reason: a caller-supplied term count is a second
  -- opinion about a document the row already holds.
  term_count integer not null generated always as (jsonb_array_length(definition -> 'terms')) stored,
  -- The count, and the instant it was taken. Both or neither — see decision 3 in the header.
  cached_count integer,
  cached_count_at timestamptz,
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint customer_segment_key_unique unique (segment_key),
  constraint customer_segment_key_is_lower_snake_case
    check (segment_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint customer_segment_cached_count_is_dated
    check ((cached_count is null) = (cached_count_at is null)),
  constraint customer_segment_cached_count_is_not_negative
    check (cached_count is null or cached_count >= 0),
  constraint customer_segment_term_count_within_maximum check (term_count between 1 and 20)
);

comment on table customer_segment is
  'One segment definition and its cached count. The definition is a document this build COMPILES, never '
  'SQL this build stores: segment-compile.ts emits one parameterised query from an allowlisted attribute '
  'registry, and an attribute resolving outside the permitted schemas is refused by name — which is how a '
  'segment can never reach the clinical schema.';

comment on column customer_segment.cached_count_at is
  'When the cached count was taken. NOT NULL whenever the count is, by constraint, because a count with '
  'no instant is a number beside a send button with nothing saying how stale it is. The staleness window '
  'is the F09 setting crm.segment_count_staleness_seconds, which carries provisional: true.';

comment on column customer_segment.term_count is
  'GENERATED ALWAYS from the document. Not writable.';

-- ---------------------------------------------------------------------------------------------
-- The campaign
-- ---------------------------------------------------------------------------------------------
create table campaign (
  id uuid primary key default uuid_generate_v7(),
  campaign_key text not null,
  title text not null,
  segment_id uuid not null references customer_segment (id),
  -- The template the copy comes from. Plain text and not a foreign key into message_template, because the
  -- class rule is the choke point's: resolveSenderIdentity and the gate read the template row, and a
  -- reference here would invite a second reading of which class this campaign is.
  template_key text not null,
  channel message_channel not null,
  state campaign_state not null default 'draft',
  halted_reason campaign_halt_reason,
  -- When it may leave. No window CHECK — see the header.
  scheduled_at timestamptz,
  -- The pre-launch estimate, stored so the actual can be reconciled against it to the fils. All three,
  -- because the acceptance line names all three and a screen showing a cost without the segment count it
  -- was multiplied from states a figure nobody can check.
  estimated_recipients integer,
  estimated_segments integer,
  estimated_fils integer,
  -- The cap, and what has been spent against it. NOT NULL with no default: see the header.
  cap_fils integer not null,
  spent_fils integer not null default 0,
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  launched_at timestamptz,
  halted_at timestamptz,
  constraint campaign_key_unique unique (campaign_key),
  constraint campaign_key_is_lower_snake_case check (campaign_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint campaign_cap_is_a_whole_non_negative_number_of_fils check (cap_fils >= 0),
  -- THE structural cap. See decision 1: this is what holds when the function is rewritten.
  constraint campaign_spend_within_cap check (spent_fils >= 0 and spent_fils <= cap_fils),
  constraint campaign_estimate_is_whole check (
    (estimated_recipients is null or estimated_recipients >= 0)
    and (estimated_segments is null or estimated_segments >= 0)
    and (estimated_fils is null or estimated_fils >= 0)
  ),
  -- The three estimate columns are one act. A cost with no recipient count is the figure nobody can
  -- reconcile, which is the whole subject of the acceptance line they exist for.
  constraint campaign_estimate_is_whole_or_absent check (
    (estimated_recipients is null) = (estimated_fils is null)
    and (estimated_segments is null) = (estimated_fils is null)
  ),
  constraint campaign_scheduled_state_has_an_instant
    check (state <> 'scheduled' or scheduled_at is not null),
  constraint campaign_halt_is_dated_and_reasoned check (
    (state = 'halted') = (halted_reason is not null)
    and (halted_reason is null) = (halted_at is null)
  )
);

comment on table campaign is
  'One campaign: a segment, a template, a cap and a schedule. spent_fils is moved only by '
  'claim_campaign_recipient and settle_campaign_recipient (ZY753), bounded by campaign_spend_within_cap, '
  'and the two together are why the cap is the database''s rather than the sender''s.';

comment on column campaign.spent_fils is
  'What this campaign has reserved or spent, in fils. Moved only from inside the claim and settle '
  'functions: a direct UPDATE raises ZY753. The CHECK campaign_spend_within_cap bounds it by any route.';

comment on column campaign.scheduled_at is
  'When the campaign may leave. Deliberately carries NO promotional-window constraint: the window is '
  'messaging.promotional_window and the rule is packages/core/src/messaging/promotional-window.ts, and a '
  'second answer here is how a 21:30 send comes to be compliant on every screen.';

create index campaign_state_scheduled_idx on campaign (state, scheduled_at);
create index campaign_segment_idx on campaign (segment_id);

-- ---------------------------------------------------------------------------------------------
-- The recipients
-- ---------------------------------------------------------------------------------------------
create table campaign_recipient (
  id uuid primary key default uuid_generate_v7(),
  campaign_id uuid not null references campaign (id) on delete cascade,
  customer_id uuid not null references customer (id) on delete cascade,
  -- The enumeration order, so "recipient 120 of 200" is a fact about the row rather than about whichever
  -- order a worker happened to read them in. Claimed in this order.
  position integer not null,
  state campaign_recipient_state not null default 'pending',
  -- What was reserved against the cap when this row was claimed, and what it actually cost. Both, because
  -- the acceptance line asks for the estimate to equal the outcome to the fils and an equality needs two
  -- numbers.
  reserved_fils integer,
  cost_fils integer,
  segments smallint,
  -- The gate's verdict and the consent row it rested on. NOT NULL on a sent row, by constraint.
  gate_decision text,
  consent_record_id uuid,
  -- Why it was not sent. Set on a held or failed row.
  held_reason text,
  claimed_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null,
  constraint campaign_recipient_one_message_per_contact unique (campaign_id, customer_id),
  constraint campaign_recipient_position_is_unique unique (campaign_id, position),
  constraint campaign_recipient_position_is_positive check (position >= 1),
  -- THE regulator constraint. See decision 2 in the header.
  constraint campaign_recipient_sent_row_is_answerable check (
    state <> 'sent'
    or (gate_decision is not null and consent_record_id is not null and cost_fils is not null
        and segments is not null and settled_at is not null)
  ),
  constraint campaign_recipient_claim_is_reserved
    check (state = 'pending' or state = 'held' or (reserved_fils is not null and claimed_at is not null)),
  constraint campaign_recipient_money_is_not_negative check (
    (reserved_fils is null or reserved_fils >= 0) and (cost_fils is null or cost_fils >= 0)
  ),
  constraint campaign_recipient_not_sent_row_has_a_reason
    check (state <> 'held' or held_reason is not null)
);

comment on table campaign_recipient is
  'One contact on one campaign, with its outcome. A sent row is required to carry its gate decision and '
  'the id of the consent record it rested on (campaign_recipient_sent_row_is_answerable), so '
  '"which consent did this message go out under" is one query and never a reconstruction. A row that has '
  'reached ''sent'' may not then be edited or deleted (ZY755).';

comment on column campaign_recipient.consent_record_id is
  'The consent row this send rested on. A plain uuid and NOT a foreign key, for consent.contact_customer_id''s '
  'stated reason: the consent ledger is not joined to by reference, so an erasure cannot cascade a '
  'regulator''s evidence away.';

comment on column campaign_recipient.held_reason is
  'Why this contact was not sent to. ''cap_exceeded'' is what claim_campaign_recipient writes when the '
  'reservation would breach the cap; the window halt writes its own. A held row is still owed, which is '
  'what makes held + sent == total the arithmetic a halted campaign is read by.';

create index campaign_recipient_claim_idx on campaign_recipient (campaign_id, state, position);
create index campaign_recipient_customer_idx on campaign_recipient (customer_id);
-- The regulator's query: every sent row and the consent it rested on, without a sequential scan over
-- every campaign that ever ran.
create index campaign_recipient_consent_idx on campaign_recipient (consent_record_id)
  where consent_record_id is not null;

-- ---------------------------------------------------------------------------------------------
-- ZY753 — `spent_fils` has ONE pair of writers
-- ---------------------------------------------------------------------------------------------
-- The CHECK bounds the column and this names the writer, and the two are not the same claim. A bounded
-- column can still be moved by anything: a repair script that "fixed" a spend, a future function that
-- forgot to take the lock, an operator in psql. Every one of those is a cap that was respected by
-- arithmetic and bypassed by process, and the symptom is a campaign whose recorded spend is correct and
-- whose sends were not counted.
create or replace function refuse_campaign_spend_move()
returns trigger
language plpgsql
as $$
begin
  if new.spent_fils is distinct from old.spent_fils
     and coalesce(current_setting('berelax.campaign_spend_move', true), 'off') <> 'on' then
    raise exception
      'campaign.spent_fils may be moved only by claim_campaign_recipient() and '
      'settle_campaign_recipient(), which reserve against the cap and reconcile to the provider''s '
      'figure in one statement each. This UPDATE moved it from % to % from outside both. A spend moved '
      'by hand is a cap that was respected by arithmetic and bypassed by process: the column reads '
      'correctly and the messages it was supposed to count have already left.',
      old.spent_fils, new.spent_fils
      using errcode = 'ZY753';
  end if;
  return new;
end;
$$;

comment on function refuse_campaign_spend_move() is
  'ZY753. The narrowest of the three cap layers: the CHECK bounds the column, the claim function closes '
  'the check-then-record window, and this names the only two writers.';

create trigger campaign_spend_has_one_pair_of_writers
  before update on campaign
  for each row execute function refuse_campaign_spend_move();

-- ---------------------------------------------------------------------------------------------
-- ZY754 — a cap may not be lowered below what has already been spent
-- ---------------------------------------------------------------------------------------------
-- `campaign_spend_within_cap` would refuse this too, with 23514 and the constraint's name, and that is
-- the wrong message for the one person who will meet it: an operator reducing a cap mid-send. The
-- difference matters because the two answers are different actions — raise the cap, or halt the
-- campaign — and "violates check constraint" names neither.
create or replace function refuse_campaign_cap_below_spend()
returns trigger
language plpgsql
as $$
begin
  if new.cap_fils < new.spent_fils then
    raise exception
      'Campaign % has already recorded % fils of spend and the cap may not be lowered to %. The spend '
      'is money that has left: lowering the cap under it would not un-send anything, it would only make '
      'the cap a number the campaign is already past. Halt the campaign to stop the remainder, or raise '
      'the cap to the figure that was authorised.',
      new.campaign_key, new.spent_fils, new.cap_fils
      using errcode = 'ZY754';
  end if;
  return new;
end;
$$;

comment on function refuse_campaign_cap_below_spend() is
  'ZY754. campaign_spend_within_cap refuses the same row; this answers the operator who will actually '
  'meet it, because "raise the cap" and "halt the campaign" are different actions and a constraint name '
  'names neither.';

create trigger campaign_cap_stays_above_spend
  before update of cap_fils on campaign
  for each row execute function refuse_campaign_cap_below_spend();

-- ---------------------------------------------------------------------------------------------
-- ZY755 — a row that has been sent is evidence
-- ---------------------------------------------------------------------------------------------
create or replace function refuse_sent_campaign_recipient_change()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'campaign_recipient % reached ''sent'' and may not be deleted. The row carries the gate decision '
      'and the consent record the message rested on, which is the only evidence that this contact was '
      'sent to lawfully; a deleted row is a message that happened and cannot be answered for.',
      old.id
      using errcode = 'ZY755';
  end if;
  raise exception
    'campaign_recipient % reached ''sent'' and may not be edited. An SMS cannot be un-sent, so every '
    'column on this row is a statement about something that has already left: editing one makes the '
    'record and the event disagree, and the record is what a regulator reads.',
    old.id
    using errcode = 'ZY755';
end;
$$;

comment on function refuse_sent_campaign_recipient_change() is
  'ZY755. Partial immutability: a row becomes evidence when it reaches ''sent'', and only then. The '
  'pending -> claimed -> sent transitions are ordinary updates, which is why this table carries no '
  'append-only marker and no blanket refusal.';

create trigger campaign_recipient_sent_row_is_evidence
  before update or delete on campaign_recipient
  for each row when (old.state = 'sent')
  execute function refuse_sent_campaign_recipient_change();

-- ---------------------------------------------------------------------------------------------
-- The claim: a reservation and a recipient, in one statement
-- ---------------------------------------------------------------------------------------------
-- This function is decision 1. Everything it does happens under the campaign row's lock, so two workers
-- calling it concurrently serialise, and there is no instant at which both have read a spend and neither
-- has written one.
--
-- It returns the recipient it claimed, or the recipient it HELD, and the caller can tell which from the
-- state. Returning the held row rather than nothing is what makes `held + sent == total` arithmetic the
-- caller can finish: a worker that got nothing back cannot tell "the cap bound" from "there was nothing
-- left", and those are the two answers a halted campaign has to distinguish.
create or replace function claim_campaign_recipient(p_campaign_id uuid, p_estimate_fils integer)
returns campaign_recipient
language plpgsql
as $$
declare
  v_campaign campaign;
  v_recipient campaign_recipient;
begin
  if p_estimate_fils is null or p_estimate_fils < 0 then
    raise exception
      'A reservation must be a whole non-negative number of fils, received %. Money is integer fils '
      '(ADR 0007) and a null estimate would reserve nothing against the cap while sending a message that '
      'costs something.', p_estimate_fils
      using errcode = 'ZY751';
  end if;

  -- The lock, and it is the whole mechanism. Everything after this line is serialised per campaign.
  select * into v_campaign from campaign where id = p_campaign_id for update;

  if not found then
    raise exception 'No campaign with id %.', p_campaign_id using errcode = 'ZY751';
  end if;

  if v_campaign.state <> 'running' then
    raise exception
      'Campaign % is %, and a recipient may be claimed only from ''running''. A claim against a draft or '
      'a cancelled campaign is a send nobody authorised, and against a halted one it is a send past the '
      'boundary that halted it.',
      v_campaign.campaign_key, v_campaign.state
      using errcode = 'ZY751';
  end if;

  -- `skip locked` is not an optimisation here: without it a second worker would block on the first
  -- worker's row rather than taking the next one, and a campaign would drain at one message at a time
  -- however many workers were running.
  select * into v_recipient
    from campaign_recipient
   where campaign_id = p_campaign_id and state = 'pending'
   order by position
   for update skip locked
   limit 1;

  if not found then
    return null;
  end if;

  if v_campaign.spent_fils + p_estimate_fils > v_campaign.cap_fils then
    -- The cap bound. The recipient is HELD rather than left pending: a pending row would be claimed again
    -- by the next worker, and the campaign would spin against its own cap for ever.
    update campaign_recipient
       set state = 'held', held_reason = 'cap_exceeded'
     where id = v_recipient.id
     returning * into v_recipient;
    return v_recipient;
  end if;

  perform set_config('berelax.campaign_spend_move', 'on', true);
  update campaign
     set spent_fils = spent_fils + p_estimate_fils, updated_at = now()
   where id = p_campaign_id;
  perform set_config('berelax.campaign_spend_move', 'off', true);

  update campaign_recipient
     set state = 'claimed', reserved_fils = p_estimate_fils, claimed_at = now()
   where id = v_recipient.id
   returning * into v_recipient;

  return v_recipient;
end;
$$;

comment on function claim_campaign_recipient(uuid, integer) is
  'Reserves an estimate against the campaign''s cap and claims the next pending recipient, in ONE '
  'statement under the campaign row''s lock. Returns the claimed recipient, or the recipient it HELD '
  'with ''cap_exceeded'', or null when nothing is pending. The two outcomes are distinguishable because '
  'a worker that got nothing back cannot tell "the cap bound" from "there was nothing left", and those '
  'are the two answers a halted campaign has to give.';

-- ---------------------------------------------------------------------------------------------
-- The settlement: the provider's figure, reconciled against the reservation
-- ---------------------------------------------------------------------------------------------
-- The reservation was an estimate from this build's own segment arithmetic; what the provider accepted is
-- what will be billed. Both are kept and the difference is applied to `spent_fils`, so the cap is
-- enforced against the estimate (before the send, because an SMS cannot be un-sent) and REPORTED against
-- the actual.
create or replace function settle_campaign_recipient(
  p_recipient_id uuid,
  p_state campaign_recipient_state,
  p_cost_fils integer,
  p_segments smallint,
  p_gate_decision text,
  p_consent_record_id uuid,
  p_held_reason text
)
returns campaign_recipient
language plpgsql
as $$
declare
  v_recipient campaign_recipient;
  v_campaign campaign;
  v_delta integer;
begin
  select * into v_recipient from campaign_recipient where id = p_recipient_id for update;
  if not found then
    raise exception 'No campaign_recipient with id %.', p_recipient_id using errcode = 'ZY752';
  end if;

  if v_recipient.state <> 'claimed' then
    raise exception
      'campaign_recipient % is % and may be settled only from ''claimed''. A settlement from ''pending'' '
      'would record a cost against a reservation that was never taken, and the cap would then be short by '
      'exactly that amount for the rest of the campaign.',
      p_recipient_id, v_recipient.state
      using errcode = 'ZY752';
  end if;

  if p_state not in ('sent', 'held', 'failed') then
    raise exception
      'A settlement must move a recipient to ''sent'', ''held'' or ''failed'', not to ''%''. Those three '
      'are the terminal states, and held + sent == total is the arithmetic a halted campaign is read by.',
      p_state
      using errcode = 'ZY752';
  end if;

  select * into v_campaign from campaign where id = v_recipient.campaign_id for update;

  -- A sent message costs what the provider accepted. A held or failed one costs nothing, so its whole
  -- reservation goes back: holding a reservation for a message that did not leave is a cap that shrinks
  -- every time a transport fails.
  v_delta := coalesce(case when p_state = 'sent' then p_cost_fils else 0 end, 0)
             - coalesce(v_recipient.reserved_fils, 0);

  perform set_config('berelax.campaign_spend_move', 'on', true);
  update campaign
     set spent_fils = spent_fils + v_delta, updated_at = now()
   where id = v_campaign.id;
  perform set_config('berelax.campaign_spend_move', 'off', true);

  update campaign_recipient
     set state = p_state,
         cost_fils = case when p_state = 'sent' then p_cost_fils else null end,
         segments = case when p_state = 'sent' then p_segments else null end,
         gate_decision = p_gate_decision,
         consent_record_id = p_consent_record_id,
         held_reason = p_held_reason,
         settled_at = now()
   where id = p_recipient_id
   returning * into v_recipient;

  return v_recipient;
end;
$$;

comment on function settle_campaign_recipient(uuid, campaign_recipient_state, integer, smallint, text, uuid, text) is
  'Records what one claimed recipient actually cost and releases the difference against the reservation. '
  'The cap is ENFORCED against the estimate, before the send, because an SMS cannot be un-sent; it is '
  'REPORTED against the provider''s figure, which is what will be billed. A held or failed recipient '
  'returns its whole reservation: a cap that kept a reservation for a message that never left would '
  'shrink on every transport failure.';
