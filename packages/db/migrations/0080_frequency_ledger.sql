-- 0080 — the frequency ledger: one rolling-window count per contact, shared by every flow and campaign.
--
-- C-AUTO-03. docs/03 §5 wants drag-and-drop journeys and docs/04 §5 says TDRA's sanction for over-messaging
-- is sender-ID SUSPENSION rather than a per-message fine. Those two facts together are what this table is
-- for: three unrelated journeys — a win-back sequence, a birthday greeting and a February campaign — each
-- sending "only one message" collectively spam one person, every one of them inside its own rule, and the
-- penalty falls on the identity the business's booking confirmations also leave from.
--
-- So the count is per CONTACT and it is one count. A per-campaign cap may only ever be stricter
-- (C-AUTO-10); there is no arrangement of per-campaign caps that adds up to this one.
--
-- ## Why a refused attempt is a row in the SAME table, and why it still cannot be counted
--
-- B-MSG-04 writes no `message` row for a send the gate refused, and says why in
-- `packages/messaging/src/lifecycle.ts`: a durable row for a message that was deliberately never sent
-- would appear in the cost report and count against this very cap. It then names where each refusal IS
-- recorded — "its stores are C-CRM-03, C-CRM-04 and C-AUTO-03" — so the `frequency_capped` outcome is this
-- table's to keep, and the acceptance line "the other two record a 'frequency_capped' outcome with the cap
-- that bound them" is what needs it.
--
-- One table rather than two, because `frequency_ledger` is a merge participant and two would be two
-- entries in `MERGE_PARTICIPANTS` for one fact. What makes one table safe is `counted_at`:
--
--     counted_at is not null  <=>  outcome = 'sent'
--
-- and every count of the cap reads `counted_at`, never `attempted_at`. A refusal's `counted_at` is NULL,
-- and **no range predicate on a NULL is ever true** — so a query that forgot `where outcome = 'sent'`
-- still cannot count a refusal. That is not tidiness. Counting refusals would make the cap
-- self-reinforcing: the first refusal would raise the count that caused it, so a contact who hit the cap
-- once would be refused for ever, and each refusal would extend its own window. Three-valued logic is a
-- stronger guarantee than a WHERE clause somebody has to remember, and the check constraint below is what
-- holds the biconditional that makes it true.
--
-- `refused_at` is the mirror column rather than a second copy of `attempted_at`, so nothing is stored
-- twice: a row has exactly one of the two, `attempted_at` is when the decision was taken, and
-- `frequency_ledger_instants_match_the_outcome` refuses every other combination.
--
-- ## Why the merge strategy is `union_dedupe` and not append-only
--
-- 0069 §"the four strategies" already reserved `union_dedupe` for this table and
-- `packages/db/src/merge-participants.ts` names it. The argument, restated here because this is where the
-- unique index that implements it lives:
--
-- A ledger row says "this contact was sent a promotional message at this instant". After a merge the
-- contact IS the survivor, so re-pointing the row does not make it say anything untrue — it makes the cap
-- read one person's real history. The alternatives are both wrong in a direction somebody pays for:
-- leaving the loser's rows behind hands the merged contact a FRESH ALLOWANCE, which turns a merge into a
-- way to message somebody past the cap; copying them the way `consent` is copied would count one message
-- twice and silence the contact for a fortnight on the strength of one send, with a support ticket
-- nobody can answer because the ledger says two sends happened.
--
-- The de-duplication is the natural key, and `frequency_ledger_one_counted_send` is it:
-- `(contact_customer_id, send_key)` over COUNTED rows only. The case it exists for is real rather than
-- theoretical: pg-boss is at-least-once, a queued job carries the customer id it was enqueued with, and a
-- contact merged mid-run leaves a job pinned to the loser. A replay of that job after the send has
-- happened would write a second ledger row for ONE physical message; under this key the merge folds the
-- two into one.
--
-- The index is PARTIAL on `counted_at is not null` and that is load-bearing in the other direction: a
-- capped attempt that is retried after the window rolls must be able to become a `sent` row under the
-- SAME `send_key`, and a total index would refuse it. Refusal rows are deliberately unconstrained — they
-- are a log of attempts, and how many times a journey tried is worth being able to count.
-- `MERGE_PARTICIPANTS` mirrors this exactly: `conflictKey: ['send_key']`, `activePredicate: 'counted_at is
-- not null'`, and `assertParticipantKeyIsAUniqueIndex` refuses the registration if this index's columns
-- ever stop matching.
--
-- ## Why `source_ref` is text with no foreign key
--
-- A ledger row has to outlive the flow or campaign that caused it. A deleted campaign must not delete the
-- evidence of what it sent, and it must not reduce a contact's count — which a cascade would do silently,
-- handing the contact an allowance back. It is the `invoice` argument applied to a counter: the row
-- records what happened, not what still exists. `source_kind = 'campaign'` therefore has no table to point
-- at yet (C-AUTO-10 owns `campaign`) and needs none when it arrives.
--
-- Neither `source_ref` nor `send_key` is checked against `is_placeholder_text()`, and that is deliberate
-- rather than an omission of the rule 15 guard every other text column here carries. Both are machine
-- keys — a flow key, `templateKey:messageId` — not prose somebody has to answer, and that function is a
-- SUBSTRING search: a template key spelled `payment_pending`, or a flow named `winback_tbc`, would be
-- refused by a guard about placeholder legal copy. A blank is still refused, which is the part of the
-- guard that means something for a key.
--
-- ## The cap figures are provisional, and the cap cannot be switched off
--
-- `Y9-frequency-cap` is open: nobody has stated this business's marketing frequency. The provisional value
-- is 2 per rolling 7 days and 6 per rolling 30 days, held as `app_setting` rows flagged `is_provisional`
-- with that question id, so they appear in the Unconfirmed Assumptions panel and leave it by being
-- confirmed. The rows are NOT seeded here: 0010 leaves `app_setting` to `seedSettingDefaults`, which reads
-- the registry, and a figure written in two places is a figure that will disagree with itself.
--
-- What this migration does add is `frequency_cap_value_is_a_cap()`, which refuses `0`, `null` and
-- `'unlimited'` for those two keys with a readable message. `0` is refused although it looks like the
-- strictest possible setting, because in every other `max_` setting anybody has met `0` ALSO means "no
-- limit" — and a reader that treats it as falsy ("no cap configured, so allow") turns the strictest value
-- into the switched-off one. Stopping promotional traffic altogether is the marketing kill switch's job
-- (C-AUTO-05), which says so on its face and records who engaged it.
--
-- The rule is ONE function called from two places, for the reason `is_placeholder_text` gives for being
-- one function: the trigger is what gives a human a sentence they can act on, the CHECK is the layer that
-- still holds when `session_replication_role` has triggers off — which is how a restore runs — and two
-- copies of one predicate is one predicate plus a future disagreement.
--
-- ## The private SQLSTATE class
--
-- `ZW001` (FrequencyCapNotACap) and `ZW002` (FrequencyLedgerCountImmutable). A private class rather than
-- `invalid_parameter_value` for 0061's reason: that code is raised by a dozen other places, so a probe
-- asserting it passes when the statement bounced off something else entirely. `ZW` because every mnemonic
-- letter is taken and what the code has to be is unique to this file.

begin;

-- ---------------------------------------------------------------------------------------------
-- The vocabularies
-- ---------------------------------------------------------------------------------------------
-- Enums rather than tables, which is the opposite of 0053's and 0077's choice, and for the reason those
-- two give for theirs: a label whose whole status is "to be confirmed" needs somewhere to carry the
-- marker that says so (brief rule 15), and neither of these is that. `sent` and `frequency_capped` are
-- outcomes of code in this repository, and `flow`/`campaign`/`manual` are the three things in this build
-- that can ask for a promotional send. Nobody has to confirm them.
create type frequency_ledger_outcome as enum (
  'sent',             -- a promotional message left, and it counts
  'frequency_capped'  -- the cap refused it, and it must never count
);

create type frequency_source_kind as enum (
  'flow',      -- a journey node (C-AUTO-07)
  'campaign',  -- a one-off broadcast (C-AUTO-10)
  'manual'     -- a staff member sending one promotional message from a screen
);

-- ---------------------------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------------------------
create table frequency_ledger (
  id                  uuid                     not null default uuid_generate_v7(),
  -- CASCADE, which is 0053's choice for every satellite table about a customer, and right here for a
  -- second reason: this table's whole purpose is to protect a LIVE contact from being over-messaged, so
  -- with the contact erased there is nobody left to protect. RESTRICT would also make `delete from
  -- customer` fail for every suite that clears the table (the hazard 0063 records about `appointment`).
  contact_customer_id uuid                     not null references customer (id) on delete cascade,
  outcome             frequency_ledger_outcome not null,
  -- The instant a SENT promotional message is counted at. NULL for every outcome that did not send, which
  -- is what makes a refusal invisible to any range predicate — see the header.
  counted_at          timestamptz,
  -- The mirror: when the cap refused the attempt. Exactly one of the two is set.
  refused_at          timestamptz,
  -- When the decision was taken, whichever way it went. From the caller's clock, never `now()`: a rolling
  -- window asserted against the server clock cannot be asserted to the second.
  attempted_at        timestamptz              not null,
  -- Recorded, not counted. The cap is global across channels — the summary says so — so an SMS and an
  -- email both spend one allowance. This column is what a report of WHERE the allowance went reads.
  channel             message_channel          not null,
  -- The send that happened. NULL for a refusal, because nothing was sent — and RESTRICT because a message
  -- row is the evidence of what the ledger is counting.
  message_id          uuid                     references message (id) on delete restrict,
  source_kind         frequency_source_kind    not null,
  -- Which flow or campaign spent the allowance. Text with no foreign key: see the header.
  source_ref          text                     not null
    constraint frequency_ledger_source_ref_is_stated check (length(btrim(source_ref)) > 0),
  -- The natural key of the send ATTEMPT, supplied by the caller: `templateKey:messageId` for a send
  -- (`idempotencyKeyFor` in @berelax/messaging), and C-AUTO-07's (flow_run, node, channel, contact) key
  -- for a node. It is what `union_dedupe` folds on — see the header.
  send_key            text                     not null
    constraint frequency_ledger_send_key_is_stated check (length(btrim(send_key)) > 0),
  -- Which cap refused, and the numbers it refused on. Recorded rather than recomputed: the cap is a
  -- setting an owner may change, and "why was this refused in March" must not be answered with April's
  -- figure. The same argument `working_hours_rule` makes for versioning payroll rates.
  bound_cap_key       text,
  bound_cap_limit     integer,
  bound_cap_window_seconds integer,
  bound_cap_count     integer,
  created_at          timestamptz              not null default now(),

  constraint frequency_ledger_pkey primary key (id),

  -- THE biconditional the whole design rests on. Both halves, so neither can drift: a `sent` row with no
  -- `counted_at` is a send the cap cannot see, and a `frequency_capped` row WITH one is a refusal that
  -- counts itself.
  constraint frequency_ledger_instants_match_the_outcome check (
    (outcome = 'sent') = (counted_at is not null)
    and (outcome = 'frequency_capped') = (refused_at is not null)
  ),
  -- The instant a decision is recorded at is the instant it was taken. Stated as an equality rather than
  -- stored once, because `attempted_at` is what an ordering of ATTEMPTS reads and `counted_at` is what the
  -- cap reads, and the day they are allowed to differ is the day the cap counts a send at a different
  -- instant from the one the log shows.
  constraint frequency_ledger_counted_at_is_the_attempt check (
    counted_at is null or counted_at = attempted_at
  ),
  constraint frequency_ledger_refused_at_is_the_attempt check (
    refused_at is null or refused_at = attempted_at
  ),
  -- A counted send names the message it counted; a refusal cannot, because nothing was sent.
  constraint frequency_ledger_sent_names_its_message check (
    (outcome = 'sent') = (message_id is not null)
  ),
  -- A refusal that does not say which cap bound it, and on what numbers, is a refusal nobody can answer a
  -- question about. All four together or none: a partially-filled set is how a report comes to show a
  -- limit without the count it was compared against.
  constraint frequency_ledger_refusal_names_its_cap check (
    (outcome = 'frequency_capped') = (
      bound_cap_key is not null and bound_cap_limit is not null
      and bound_cap_window_seconds is not null and bound_cap_count is not null
    )
  ),
  -- The numbers have to be numbers a cap could have had, and the count has to be one that REFUSES. A
  -- recorded refusal claiming a limit of 0, or a count below the limit, is a refusal that never had to
  -- happen — and that row is the evidence somebody would read to decide the cap is wrong.
  constraint frequency_ledger_bound_cap_numbers_are_sane check (
    bound_cap_limit is null
    or (bound_cap_limit >= 1 and bound_cap_window_seconds >= 1 and bound_cap_count >= bound_cap_limit)
  ),
  constraint frequency_ledger_bound_cap_key_known check (
    bound_cap_key is null or bound_cap_key in ('week', 'month')
  )
);

comment on table frequency_ledger is
  'One row per promotional send DECISION for one contact: a counted send, or an attempt the cap refused. '
  'The cap counts counted_at, which is NULL for a refusal, so no range predicate can ever count a '
  'refusal - without which the cap would be self-reinforcing, each refusal raising the count that caused '
  'it. Transactional traffic is never written here at all: a booking confirmation that spent a marketing '
  'allowance would silence the marketing the business is allowed to do.';
comment on column frequency_ledger.counted_at is
  'The instant a SENT promotional message is counted at. NULL for every other outcome, which is what '
  'makes a refusal invisible to the count by three-valued logic rather than by a WHERE clause.';
comment on column frequency_ledger.send_key is
  'The natural key of the send attempt. frequency_ledger_one_counted_send de-duplicates counted rows on '
  '(contact, send_key), which is what the union_dedupe merge strategy folds on: an at-least-once job '
  'replayed after a merge would otherwise write a second row for one physical message.';
comment on column frequency_ledger.source_ref is
  'The flow or campaign that spent the allowance. Text with NO foreign key deliberately: a deleted '
  'campaign must not delete the evidence of what it sent, nor reduce a contact''s count.';

-- THE natural key, and the merge's conflict key. Partial on counted rows: a capped attempt retried after
-- the window rolls must be able to become a sent row under the same send_key.
create unique index frequency_ledger_one_counted_send
  on frequency_ledger (contact_customer_id, send_key)
  where counted_at is not null;

-- The index the cap is read through: one contact, counted rows, newest first. Partial for the same reason
-- the count reads `counted_at` — a refusal has no business in the index the cap scans.
create index frequency_ledger_cap_read_idx
  on frequency_ledger (contact_customer_id, counted_at desc)
  where counted_at is not null;

-- "What did this journey spend, and what did it get refused" — the report C-AUTO-10's pre-launch estimate
-- and the owner's "why did nobody get the February campaign" both ask.
create index frequency_ledger_source_idx
  on frequency_ledger (source_kind, source_ref, attempted_at desc);
create index frequency_ledger_refusal_idx
  on frequency_ledger (contact_customer_id, refused_at desc)
  where refused_at is not null;

-- ---------------------------------------------------------------------------------------------
-- A counted send is never re-dated, and never quietly un-counted
-- ---------------------------------------------------------------------------------------------
-- The merge moves `contact_customer_id` and must be able to. Everything else about a counted row is a
-- statement about a message that has already left: moving `counted_at` slides a send in or out of a
-- window, and clearing it removes a send from the count altogether — which is the one UPDATE that would
-- let somebody hand a contact an allowance back without deleting anything. Both raise ZW002.
--
-- For EVERY role including the owner, which is 0077's reason: the revoke below covers the application
-- role, and the owner is who edits a row by hand at 02:00 to get a campaign out.
create or replace function assert_frequency_ledger_count_is_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.counted_at is distinct from old.counted_at then
    raise exception
      'frequency_ledger %: counted_at cannot be changed (% -> %). It is when a promotional message that '
      'has already left was counted; moving it slides the send into or out of a rolling window, and '
      'clearing it removes the send from the cap while leaving the row that says it happened. A merge '
      'moves contact_customer_id and nothing else here.',
      old.id, old.counted_at, new.counted_at
      using errcode = 'ZW002';
  end if;
  if new.outcome is distinct from old.outcome
     or new.message_id is distinct from old.message_id
     or new.send_key is distinct from old.send_key
     or new.attempted_at is distinct from old.attempted_at then
    raise exception
      'frequency_ledger %: outcome, message_id, send_key and attempted_at describe a decision that has '
      'already been taken and cannot be edited. A refused attempt that later succeeds is a NEW row.',
      old.id
      using errcode = 'ZW002';
  end if;
  return new;
end $$;

comment on function assert_frequency_ledger_count_is_immutable() is
  'Raises ZW002 when an UPDATE changes counted_at, outcome, message_id, send_key or attempted_at on a '
  'frequency_ledger row. contact_customer_id stays editable because the merge re-points it. For every '
  'role including the owner.';

create trigger frequency_ledger_count_is_immutable
  before update on frequency_ledger
  for each row execute function assert_frequency_ledger_count_is_immutable();

-- ---------------------------------------------------------------------------------------------
-- The cap cannot be switched off
-- ---------------------------------------------------------------------------------------------
-- ONE predicate, called from the trigger and from the CHECK. `case` rather than `and`, and that is not a
-- style choice: SQL does not guarantee the evaluation order of `and`, so
-- `jsonb_typeof(v) = 'number' and (v)::numeric >= 1` may evaluate the cast first and raise `cannot cast
-- jsonb string to type numeric` for the very value it is meant to refuse politely. `case` is documented
-- not to evaluate the branches it does not need.
create function frequency_cap_value_is_a_cap(p_value jsonb) returns boolean
language sql
immutable
as $$
  select case
           when p_value is null then false
           when jsonb_typeof(p_value) <> 'number' then false
           else (p_value)::numeric >= 1 and (p_value)::numeric = trunc((p_value)::numeric)
         end;
$$;

comment on function frequency_cap_value_is_a_cap(jsonb) is
  'True only for a whole JSON number >= 1. Refuses 0, JSON null, SQL NULL and any string including '
  '"unlimited". NOT strict, for is_placeholder_text''s reason: a strict function returns NULL for NULL '
  'and a CHECK whose expression is NULL is satisfied, which would accept the NULL it exists to refuse.';

create or replace function assert_frequency_cap_is_a_real_cap()
returns trigger
language plpgsql
as $$
begin
  if new.key not in ('messaging.frequency_cap_per_week', 'messaging.frequency_cap_per_month')
     or frequency_cap_value_is_a_cap(new.value) then
    return new;
  end if;

  raise exception
    '% cannot be set to %: the frequency cap is not switchable. Zero is refused as well as null and '
    '"unlimited", because in every other max_ setting zero ALSO means "no limit" - and a reader that '
    'treats it as falsy ("no cap configured, so allow") turns the strictest value into the switched-off '
    'one. Three unrelated journeys each sending "only one message" is how one contact is spammed inside '
    'every rule, and TDRA''s sanction is sender-ID suspension. To stop promotional traffic, engage the '
    'marketing kill switch, which says so on its face and records who engaged it. The cap must be a whole '
    'number of messages, at least 1 (Y9-frequency-cap: provisionally 2 per week and 6 per month).',
    new.key, coalesce(new.value::text, 'NULL')
    using errcode = 'ZW001';
end $$;

comment on function assert_frequency_cap_is_a_real_cap() is
  'Raises ZW001 when messaging.frequency_cap_per_week or _per_month is set to 0, null, a string such as '
  '"unlimited", or anything but a whole number >= 1. The CHECK constraint beside it calls the same '
  'predicate and is the layer that still holds when session_replication_role has triggers off, which is '
  'how a restore runs.';

create trigger app_setting_frequency_cap_is_a_real_cap
  before insert or update of value on app_setting
  for each row execute function assert_frequency_cap_is_a_real_cap();

-- The second layer. Named so the violation says what it is even without the trigger's sentence.
alter table app_setting
  add constraint app_setting_frequency_cap_cannot_be_switched_off check (
    key not in ('messaging.frequency_cap_per_week', 'messaging.frequency_cap_per_month')
    or frequency_cap_value_is_a_cap(value)
  );

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 grants the application role select/insert/update/delete on tables created in `public` afterwards,
-- so these revokes are load-bearing rather than decorative, and are stated explicitly because a managed
-- database restored from a dump does not necessarily carry the same defaults.
--
-- DELETE has no legitimate caller. A send that happened cannot be made not to have happened, and the one
-- reason anybody would delete a row here is to give a contact their allowance back — which is the cap
-- being switched off one contact at a time. Erasure still works: the cascade from `customer` runs with
-- the referencing table owner's privileges rather than the caller's, so C-CRM-10 removes a contact's
-- ledger with the contact.
--
-- TRUNCATE is the one a trigger cannot see, and a truncated ledger is every contact's cap reset at once.
revoke delete, truncate on frequency_ledger from berelax_app;

commit;
