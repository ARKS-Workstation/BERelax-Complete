-- 0106 — payment_intent, its append-only transactions, and the rule that only a gateway may move one.
--
-- Y-PAY-02. Two tables and five refusals. The tables are ordinary; the refusals are the unit, and each one
-- exists because the same thing can be got wrong in application code and then cannot be found.
--
-- ## Why the transaction table is `payment_intent_transaction` and not `payment_transaction`
--
-- `payment` (0063) already exists and means something else: ONE TENDER against an issued invoice, keyed in
-- at the till by a person who is holding the money. A table called `payment_transaction` beside it reads as
-- "a transaction against a payment", which is not what these rows are — they are movements against a GATEWAY
-- INTENT, which may have no invoice yet and may never acquire one (a declined authorisation, a voided hold).
-- The longer name is the whole of the difference, and the acceptance line's phrase "the payment transaction
-- table" is satisfied by it. 0068's argument for reusing `tender_type` rather than inventing a second
-- vocabulary is the same argument in the other direction: reuse a word when it means the same thing, and do
-- not reuse one when it does not.
--
-- ## The five refusals, and what each is against
--
-- **ZY161 — a transaction row is append-only.** The rows ARE the evidence that money moved. An UPDATE to one
-- would restate a movement that has already been reconciled against a gateway payout, and a DELETE would
-- make the intent's figures unexplainable while leaving them arithmetically consistent. A figure that is
-- wrong is a NEW row, which is what a gateway itself does: a reversal is an event, not an edit.
--
-- There is one row per gateway EVENT and not one per movement, and that choice is what makes ZY162 below
-- total. `action_required` and `authorisation_failed` move an intent's state while moving no money, so a
-- movements-only table would have left those two transitions with no row to name and the rule with an
-- exemption — and the exemption would itself have been a second copy, in plpgsql, of which events move
-- money. Three of the six kinds carry zero fils by CHECK, and "this event moved nothing" is recorded rather
-- than inferred from an absence. `@berelax/core`'s `intentTransactions` is the same projection, and the
-- property suite holds the two equal.
--
-- **ZY162 — an intent's state and figures move only with a NEW transaction row.** This is the unit's
-- subject, stated as schema. The acceptance line is *"a client-supplied success callback with no matching
-- gateway transaction leaves the intent in its prior state"*, and the tempting place to enforce that is the
-- route handler: check the callback against the gateway before believing it. That check is one `if` away
-- from being skipped, and the skip is invisible — the intent moves, the invoice is marked paid, and the
-- money was never taken. So the intent carries `last_transaction_id`, every UPDATE that changes its state or
-- any of its three figures must advance it, and the row it advances to must belong to this intent. A caller
-- with nothing but a browser's word for it has no row to name and therefore cannot move the intent, whatever
-- it believes. The gateway path has one because it wrote it in the same transaction. Total over the six
-- events, with no exemption: see ZY161's second paragraph for why that needed a row per event.
--
-- **ZY163 — the header equals its transactions, checked at COMMIT.** `authorised_fils`, `captured_fils` and
-- `refunded_fils` on the intent are a cached projection of the rows, and a cache that nothing checks is a
-- second source of truth. Deferred rather than immediate for 0018's reason: the row and the header are
-- separate INSERT/UPDATE statements, so an immediate trigger would reject the legal sequence. Note the
-- arithmetic: captures and refunds SUM, authorisations take the MAXIMUM. A gateway increasing a reservation
-- reports the new total rather than the increment, so summing them would double the ceiling every capture is
-- checked against — the one mistake here that makes an over-capture look legal.
--
-- **ZY164 — one row per gateway event per intent.** A webhook stream is
-- at-least-once (Y-PAY-04 owns the endpoint; this is the storage half), so the second delivery of a capture
-- must not be able to write a second row. A UNIQUE constraint would do it — and there is one — but the
-- refusal a caller sees from a bare unique violation cannot be told apart from any other, so the named code
-- is what lets a webhook handler answer 200 to a redelivery instead of 500.
--
-- **ZY165 — an intent's instrument must be one a GATEWAY serves.** `tender_type.adapter` is 0068's column
-- and 0105 filled in the first `gateway` row. An intent for `cash` would be a gateway authorisation for
-- money already in the drawer: the till path (`finaliseCheckout`) writes a `payment` row and posts directly,
-- and an intent beside it would post the same money twice. This is the one refusal here that is about the
-- vocabulary rather than about the ledger, and it is a trigger rather than a CHECK because the fact lives in
-- another table.
--
-- ## What is deliberately NOT here
--
-- **No transition table.** The (state, event) table is `packages/core/src/payments/state.ts` and is asserted
-- total over the enum product by `state.test.ts`. Restating it in plpgsql would be a second answer to "may
-- this event happen", and ADR 0043's own subject is what happens when one fact has two homes: they agree
-- until they do not, and the disagreement is found on a payment. ZY162 is the database's half — a state
-- change must be justified by a row — and WHICH state is core's. ADR 0056 records the division.
--
-- **No foreign key to `invoice`.** `reference` is text, as it is on the port: an intent is authorised before
-- there is a document (a deposit on a booking), and a nullable reference to a document that does not exist
-- yet is not the fact this table records. `payment.invoice_id` is a real key because a tender is BY
-- DEFINITION against an issued document; an intent is not.
--
-- **No DELETE anywhere.** Neither table can be emptied, and that is the point rather than an oversight:
-- ZY161 refuses a transaction DELETE for every role, so the intent it references can never be released
-- either. Brief rule 9's consequence applies — a suite over these tables asserts a DELTA and never a total,
-- and `packages/fixtures/src/payment-intent.itest.ts` does. Nothing is declared in
-- `packages/db/src/suite-table-declarations.ts` because nothing here is ever emptied by anybody.
--
-- Five private SQLSTATEs, `ZY161`-`ZY165`, of the band `ZY161`-`ZY170` issued to this unit. Allocated through
-- `packages/db/src/sqlstate-registry.ts` and not by reading the migrations a worktree can see (ADR 0043).
-- `ZY166`-`ZY170` are unused and are NOT registered: an entry for a code no migration raises is what
-- direction 3 of the gate refuses, which is the direction that lets the registry shrink.

begin;

-- ------------------------------------------------------------------------------------------------
-- payment_intent — one row per authorisation attempt, keyed by the caller's idempotency key
-- ------------------------------------------------------------------------------------------------

create table payment_intent (
  id                   uuid        primary key default uuid_generate_v7(),
  -- Supplied by the CALLER, and UNIQUE. This is "unique idempotency keys on the public surface": the key is
  -- claimed by this INSERT before the gateway is called, so a replay loses the race here and returns the
  -- first intent without the adapter being reached at all. A key generated on this side could not
  -- deduplicate a retry, because the retry would generate a second one (0063's argument for
  -- `checkout_finalisation.idempotency_key`, and the same shape).
  idempotency_key      text        not null
                         constraint payment_intent_one_intent_per_key unique
                         constraint payment_intent_key_nonempty check (btrim(idempotency_key) <> ''),
  -- Which gateway answered. Not a foreign key: the gateway set is configuration (`PAYMENT_PROVIDER`) and
  -- lives in `packages/payments/src/registry.ts`, so a table of gateway names here would be a second
  -- answer to which ones exist — and one that a deploy could not change.
  gateway              text        not null
                         constraint payment_intent_gateway_nonempty check (btrim(gateway) <> ''),
  -- The gateway's own id for this intent. NULL until it answers, which is a real state and not a gap: the
  -- row is written first so the key is claimed, and an intent that never got an answer is exactly the one
  -- Y-PAY-05's reconciliation has to find. UNIQUE per gateway, because two of our intents pointing at one
  -- of theirs would double-count every event it emits.
  gateway_intent_id    text
                         constraint payment_intent_gateway_id_nonempty
                         check (gateway_intent_id is null or btrim(gateway_intent_id) <> ''),
  state                text        not null default 'requires_authorisation'
                         constraint payment_intent_state_known
                         check (state in ('requires_authorisation', 'requires_customer_action',
                                          'authorised', 'captured', 'voided', 'failed')),
  -- The tender kind, into 0068's registry. ZY165 additionally requires its `adapter` to be `gateway`.
  instrument           text        not null references tender_type (code),
  -- Snapshotted from the registry at authorisation, never looked up later: re-mapping an instrument's
  -- account in two years must not restate a posting already filed (0063's rule for `payment`).
  posting_account_code text        not null references account (code),
  -- What was ASKED for, which is not what was reserved. A declined authorisation reserved nothing and its
  -- `authorised_fils` is 0; without this column there would be no record of the figure attempted, and a
  -- declined intent would be indistinguishable from one nobody ever sent.
  requested_fils       fils_nonneg not null
                         constraint payment_intent_requested_positive check (requested_fils > 0),
  -- The three figures, each a cached projection of the transaction rows and each held equal to them at
  -- COMMIT by ZY163. The two CHECKs are the cheap half of the same claim, and they are here as well
  -- because a CHECK cannot be deferred past the statement that broke it: the error names the column.
  authorised_fils      fils_nonneg not null default 0,
  captured_fils        fils_nonneg not null default 0,
  refunded_fils        fils_nonneg not null default 0,
  -- The document or booking this belongs to, carried through to reconciliation. Text, not a key: see the
  -- header. Non-blank, because blank reads as a reference that was not captured rather than one that does
  -- not exist (`GatewayReferenceMissing` refuses the same thing one layer up).
  reference            text        not null
                         constraint payment_intent_reference_nonempty check (btrim(reference) <> ''),
  -- The transaction row that last moved this intent. NULL only while the intent is still in its initial
  -- state and nothing has happened to it; ZY162 is what requires every later move to advance it. The
  -- foreign key is added after `payment_intent_transaction` exists, below.
  last_transaction_id  uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint payment_intent_captured_within_authorised
    check (captured_fils <= authorised_fils),
  constraint payment_intent_refunded_within_captured
    check (refunded_fils <= captured_fils),
  constraint payment_intent_one_row_per_gateway_intent unique (gateway, gateway_intent_id),
  -- An intent that has moved names the row that moved it, and one that has not has no row to name. Stated
  -- as a constraint rather than left to ZY162 because it is the ONE case the trigger cannot see: a row
  -- INSERTed straight into a non-initial state fires no UPDATE.
  constraint payment_intent_initial_state_has_no_transaction
    check ((state = 'requires_authorisation') = (last_transaction_id is null))
);

comment on table payment_intent is
  'One gateway authorisation attempt. UNIQUE on idempotency_key is what makes a replay return the first '
  'intent rather than authorising twice - the row is written BEFORE the gateway is called, so the second '
  'caller loses the race here and the adapter is never reached. The three fils columns are a cached '
  'projection of payment_intent_transaction and are held equal to it at COMMIT by ZY163; the rows are the '
  'record and these are the read.';
comment on column payment_intent.gateway_intent_id is
  'The gateway''s own id, NULL until it answers. A real state rather than a gap: an intent whose key was '
  'claimed and whose authorisation never returned is precisely what Y-PAY-05 reconciles, and a NOT NULL '
  'here would have forced the gateway call to happen before the key was claimed - which is the ordering '
  'that lets two concurrent callers both authorise.';
comment on column payment_intent.requested_fils is
  'What was asked, not what was reserved. A declined authorisation has authorised_fils 0 and this figure '
  'is the only record that anything was attempted at all.';
comment on column payment_intent.last_transaction_id is
  'The append-only row that last moved this intent. ZY162 requires every UPDATE changing the state or any '
  'figure to advance this to a NEW row belonging to this intent, which is how "only the gateway can move '
  'an intent" becomes a property of the database rather than a check in a route handler somebody may skip.';

create index payment_intent_reference_idx on payment_intent (reference);
-- Y-PAY-05 pulls every intent that is not settled, so the partial index is over exactly those states.
create index payment_intent_open_idx on payment_intent (state, created_at)
  where state in ('requires_authorisation', 'requires_customer_action', 'authorised');

create trigger payment_intent_updated_at before update on payment_intent
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------------------------------------
-- payment_intent_transaction — the append-only movements
-- ------------------------------------------------------------------------------------------------

create table payment_intent_transaction (
  id                uuid        primary key default uuid_generate_v7(),
  payment_intent_id uuid        not null references payment_intent (id),
  -- The gateway event this row records. UNIQUE per intent, which is the storage half of
  -- exactly-once-per-event: a redelivered capture cannot write a second row however many times it arrives.
  gateway_event_id  text        not null
                      constraint payment_intent_transaction_event_nonempty
                      check (btrim(gateway_event_id) <> ''),
  -- The event type, which IS the row's kind. This CHECK mirrors PAYMENT_INTENT_EVENTS in @berelax/core
  -- exactly as payment_intent_state_known mirrors PAYMENT_INTENT_STATES, and payment-intent.itest.ts holds
  -- both lists equal to their enums in BOTH directions, read out of the catalogue. A second vocabulary was
  -- written first and deleted: it was a bijection with the event enum, so it was a rename with nothing in
  -- it but one more thing to drift the day Y-PAY-08 adds the dispute event.
  gateway_event_type text       not null
                      constraint payment_intent_transaction_event_type_known
                      check (gateway_event_type in ('action_required', 'authorised',
                                                    'authorisation_failed', 'captured', 'refunded',
                                                    'voided')),
  -- Integer fils. Zero for exactly the three events that move no money, and strictly positive for the
  -- three that do. `fils_nonneg` alone would accept a zero-fils capture, which is a capture somebody
  -- started and did not fill in and would read as a settled movement for nothing (0063's argument for
  -- `payment_amount_positive`, split by event because three of the six need the zero).
  amount_fils       fils_nonneg not null,
  -- The GATEWAY's instant, carried from the event and never ours. What the pure fold orders by, so a
  -- projection rebuilt from these rows converges the same way it did from the events.
  occurred_at       timestamptz not null,
  -- The idempotency key of the call that produced this row, or the webhook delivery that did. Recorded so
  -- an operator reading a row can find the call in the gateway's own log; not unique here, because one
  -- call's snapshot can legitimately carry several events (an authorisation plus its capture).
  idempotency_key   text        not null
                      constraint payment_intent_transaction_key_nonempty
                      check (btrim(idempotency_key) <> ''),
  created_at        timestamptz not null default now(),
  -- The three-way rule, and it is INTENT_EVENT_CARRIES_AMOUNT in @berelax/core: an event that moves money
  -- carries a positive figure, an event that moves none carries exactly zero. Neither direction is
  -- cosmetic — a `voided` row with a figure reads as a partial release, which does not exist.
  constraint payment_intent_transaction_amount_matches_event
    check (
      case when gateway_event_type in ('authorised', 'captured', 'refunded')
           then amount_fils > 0 else amount_fils = 0 end
    ),
  constraint payment_intent_transaction_one_row_per_event
    unique (payment_intent_id, gateway_event_id)
);

comment on table payment_intent_transaction is
  'One row per gateway event against an intent: the three money events carry fils and the three that move '
  'nothing carry zero, which is what lets ZY162 require a row for EVERY state move with no exemption. '
  'Append-only - UPDATE and DELETE raise ZY161 for every role including the owner - because '
  'these rows ARE the evidence the money moved, and a figure that is wrong is a NEW row exactly as it is '
  'at the gateway. The intent''s three fils columns are derived from these and held equal to them at '
  'COMMIT. No row is ever removed, so a suite over this table asserts a DELTA and never a total.';
comment on column payment_intent_transaction.gateway_event_id is
  'The gateway''s stable event id, unique per intent. A webhook stream is at-least-once, so this is what '
  'makes the second delivery of one capture unable to write a second row - the same identity the pure '
  'fold in @berelax/core deduplicates on, so the stored rows and the folded projection agree.';
comment on column payment_intent_transaction.gateway_event_type is
  'The event type, which is the row''s kind. Mirrors PAYMENT_INTENT_EVENTS in @berelax/core, asserted '
  'equal in both directions by payment-intent.itest.ts against the catalogue. One vocabulary rather than '
  'two, for the reason 0105 reuses tender_type rather than inventing a second enum of instruments.';
comment on column payment_intent_transaction.amount_fils is
  'Integer fils. Strictly positive for authorised, captured and refunded; exactly zero for the other '
  'three, which move no money. Both directions matter, which is why this is a CHECK on the pair rather '
  'than left to the fils_nonneg domain.';

create index payment_intent_transaction_intent_idx
  on payment_intent_transaction (payment_intent_id, occurred_at);

-- The reference back, added now that both tables exist. ON DELETE RESTRICT is the default and is left
-- implicit nowhere else in this file: stated, because it is load-bearing. A transaction row cannot be
-- deleted by anybody (ZY161), so this key makes the intent it names undeletable too — which is the
-- intended reading of P-HR-07's mechanical test (can the CHILD be deleted to release the pin?). The answer
-- is no, and pinning the parent is the point: an intent that touched money is evidence, not a draft.
alter table payment_intent
  add constraint payment_intent_last_transaction_fk
  foreign key (last_transaction_id) references payment_intent_transaction (id) on delete restrict;

-- ------------------------------------------------------------------------------------------------
-- ZY161 — a transaction row is append-only
-- ------------------------------------------------------------------------------------------------

create function refuse_payment_intent_transaction_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'PaymentIntentTransactionIsAppendOnly: % on payment_intent_transaction is refused. These rows are the '
    'evidence that money moved and they are reconciled against the gateway''s own payout file; a figure '
    'that is wrong is a NEW row - a further capture, a refund, a reversal - exactly as it is at the '
    'gateway. Editing one would restate a movement somebody has already been paid against.',
    tg_op
    using errcode = 'ZY161';
end $$;

comment on function refuse_payment_intent_transaction_change() is
  'Raises ZY161 for every UPDATE and DELETE on payment_intent_transaction, for EVERY role including the '
  'owner. The remedy is always a new row, never an edit.';

create trigger payment_intent_transaction_no_update before update on payment_intent_transaction
  for each row execute function refuse_payment_intent_transaction_change();
create trigger payment_intent_transaction_no_delete before delete on payment_intent_transaction
  for each row execute function refuse_payment_intent_transaction_change();

-- ------------------------------------------------------------------------------------------------
-- ZY162 — an intent moves only with a new transaction row of its own
-- ------------------------------------------------------------------------------------------------
-- The unit's subject. Four ways an UPDATE can be wrong and each is a separate sentence in the message,
-- because the runbook answer differs: "nothing moved, so do not write" is not "you named somebody else's
-- row".
--
-- What counts as a MOVE is the state or any of the three figures changing. `gateway_intent_id` filling in
-- is deliberately NOT a move: the gateway answering with its id is the same authorisation being recorded,
-- and requiring a transaction row for it would force one to exist before the event that justifies it.
create function assert_payment_intent_moves_with_a_transaction() returns trigger
language plpgsql
as $$
declare
  v_owner  uuid;
  v_change text;
begin
  if new.state = old.state
     and new.authorised_fils = old.authorised_fils
     and new.captured_fils = old.captured_fils
     and new.refunded_fils = old.refunded_fils then
    return new;
  end if;

  -- The change, spelled out. The first version of both messages read 'moved from "%" to "%"' and printed
  -- `authorised` twice for a figure-only change, which is the shape of message that sends a reader looking
  -- at the state column for a defect in the amounts.
  v_change := format(
    'state "%s"->"%s", authorised %s->%s, captured %s->%s, refunded %s->%s',
    old.state, new.state, old.authorised_fils, new.authorised_fils,
    old.captured_fils, new.captured_fils, old.refunded_fils, new.refunded_fils);

  if new.last_transaction_id is null then
    raise exception
      'PaymentIntentMovedWithoutATransaction: intent % changed (%) naming no transaction row. Only a '
      'gateway movement may move an intent: a client that reports success has not been near the money, '
      'and the row it cannot name is the row that would have proved otherwise.',
      old.id, v_change
      using errcode = 'ZY162';
  end if;

  if new.last_transaction_id is not distinct from old.last_transaction_id then
    raise exception
      'PaymentIntentMovedWithoutATransaction: intent % changed (%) still naming transaction %, which had '
      'already been applied. Every move is justified by a NEW row; re-naming the last one is how one '
      'capture comes to be counted twice.',
      old.id, v_change, old.last_transaction_id
      using errcode = 'ZY162';
  end if;

  select t.payment_intent_id into v_owner
    from payment_intent_transaction t where t.id = new.last_transaction_id;

  if v_owner is null then
    raise exception
      'PaymentIntentMovedWithoutATransaction: intent % names transaction %, which does not exist.',
      old.id, new.last_transaction_id
      using errcode = 'ZY162';
  end if;

  if v_owner <> old.id then
    raise exception
      'PaymentIntentMovedWithoutATransaction: intent % names transaction %, which belongs to intent %. A '
      'movement justifies the intent it was recorded against and no other - answering with another '
      'intent''s row would report one document''s figures as another''s.',
      old.id, new.last_transaction_id, v_owner
      using errcode = 'ZY162';
  end if;

  return new;
end $$;

comment on function assert_payment_intent_moves_with_a_transaction() is
  'Raises ZY162 when an UPDATE changes payment_intent.state or any of its three fils figures without '
  'advancing last_transaction_id to a NEW payment_intent_transaction row belonging to that intent. This is '
  'ADR 0056: the gateway, never the client, is the only thing that can move an intent, enforced where a '
  'route handler cannot be skipped. It does NOT re-implement the (state, event) table - that is '
  'packages/core/src/payments/state.ts and has one home.';

create trigger payment_intent_moves_with_a_transaction before update on payment_intent
  for each row execute function assert_payment_intent_moves_with_a_transaction();

-- ------------------------------------------------------------------------------------------------
-- ZY163 — the header equals its transactions, at COMMIT
-- ------------------------------------------------------------------------------------------------
-- Deferred for 0018's reason: the transaction row and the header UPDATE are separate statements, so the
-- intent is transiently out of step with its rows by construction and an IMMEDIATE trigger would reject
-- every legal write. The transaction fails as a whole if the two disagree.
--
-- `max` for authorisations and `sum` for the rest. A gateway increasing a reservation reports the NEW TOTAL
-- rather than the increment, so summing them would double the ceiling every capture is checked against —
-- the same arithmetic as `reduceIntent` in @berelax/core, which takes the largest authorisation it has seen.
create function assert_payment_intent_matches_its_transactions() returns trigger
language plpgsql
as $$
declare
  v_intent     uuid;
  v_authorised bigint;
  v_captured   bigint;
  v_refunded   bigint;
  v_rows_auth  bigint;
  v_rows_cap   bigint;
  v_rows_ref   bigint;
begin
  -- IF/ELSE and not a CASE expression over tg_table_name. plpgsql passes every field reference in one
  -- expression to the planner as a parameter, so `case ... then new.payment_intent_id else new.id end`
  -- resolves BOTH names against whichever record it was handed and fails with "record new has no field"
  -- on one of the two tables. Two statements, each compiled only when it is reached.
  if tg_table_name = 'payment_intent_transaction' then
    v_intent := new.payment_intent_id;
  else
    v_intent := new.id;
  end if;

  -- Absent only if the whole transaction is being rolled back, in which case this never commits. Both
  -- keys make it impossible otherwise.
  select pi.authorised_fils, pi.captured_fils, pi.refunded_fils
    into v_authorised, v_captured, v_refunded
    from payment_intent pi where pi.id = v_intent;
  if not found then return null; end if;

  select coalesce(max(case when t.gateway_event_type = 'authorised' then t.amount_fils end), 0),
         coalesce(sum(case when t.gateway_event_type = 'captured' then t.amount_fils else 0 end), 0),
         coalesce(sum(case when t.gateway_event_type = 'refunded' then t.amount_fils else 0 end), 0)
    into v_rows_auth, v_rows_cap, v_rows_ref
    from payment_intent_transaction t where t.payment_intent_id = v_intent;

  if (v_authorised, v_captured, v_refunded) <> (v_rows_auth, v_rows_cap, v_rows_ref) then
    raise exception
      'PaymentIntentDisagreesWithItsTransactions: intent % states authorised %, captured %, refunded % '
      'fils; its append-only rows say %, % and %. The three columns are a projection of the rows and the '
      'rows are the record, so a header that has drifted reconciles against nothing - and the difference '
      'is invisible in every report that reads only the header.',
      v_intent, v_authorised, v_captured, v_refunded, v_rows_auth, v_rows_cap, v_rows_ref
      using errcode = 'ZY163';
  end if;

  return null;
end $$;

comment on function assert_payment_intent_matches_its_transactions() is
  'Raises ZY163 at COMMIT when payment_intent''s three fils columns disagree with the sum of its '
  'payment_intent_transaction rows - MAX over authorised rows, SUM over captured and refunded, because a '
  'reservation increase reports the new total rather than the increment. One function for both tables: '
  'each carries the intent id under a different column name, resolved from tg_table_name.';

create constraint trigger payment_intent_transaction_matches_header
  after insert on payment_intent_transaction
  deferrable initially deferred
  for each row execute function assert_payment_intent_matches_its_transactions();

create constraint trigger payment_intent_matches_its_transactions
  after insert or update on payment_intent
  deferrable initially deferred
  for each row execute function assert_payment_intent_matches_its_transactions();

-- ------------------------------------------------------------------------------------------------
-- ZY164 — one row per gateway event, as a named refusal
-- ------------------------------------------------------------------------------------------------
-- `payment_intent_transaction_one_row_per_event` already refuses the second row. This turns the unique
-- violation into a code, and the reason is the webhook handler Y-PAY-04 builds: a redelivery has to be
-- answerable with 200 and no second transition, and a bare 23505 cannot be told apart from any other
-- unique violation in the same statement — including the intent's own idempotency key, which means the
-- opposite thing.
create function refuse_duplicate_payment_intent_event() returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from payment_intent_transaction t
     where t.payment_intent_id = new.payment_intent_id
       and t.gateway_event_id = new.gateway_event_id
  ) then
    raise exception
      'PaymentIntentEventAlreadyRecorded: gateway event % has already been recorded against intent %. A '
      'webhook stream is at-least-once, so this is a redelivery rather than a second movement: the '
      'caller may answer 200 and change nothing.',
      new.gateway_event_id, new.payment_intent_id
      using errcode = 'ZY164';
  end if;
  return new;
end $$;

comment on function refuse_duplicate_payment_intent_event() is
  'Raises ZY164 for a second row naming one (intent, gateway_event_id). The UNIQUE constraint is what '
  'makes it impossible under concurrency - this trigger is what makes the refusal NAMEABLE, so a webhook '
  'handler can tell a redelivery from a duplicated idempotency key, which is the other unique violation '
  'reachable from the same transaction and means the opposite thing.';

create trigger payment_intent_transaction_event_once before insert on payment_intent_transaction
  for each row execute function refuse_duplicate_payment_intent_event();

-- ------------------------------------------------------------------------------------------------
-- ZY165 — an intent's instrument must be one a gateway serves
-- ------------------------------------------------------------------------------------------------
-- 0068 put the closed set ('manual', 'gateway') on `tender_type.adapter` and said this was the column
-- Y-PAY's types would differ on; 0105 added the one `gateway` row. An intent for `cash` would be a gateway
-- authorisation for money already in the drawer, and since `finaliseCheckout` writes a `payment` row and
-- posts directly for those, the same money would be posted twice. A trigger and not a CHECK because the
-- fact is in another table.
create function assert_payment_intent_instrument_is_a_gateway_kind() returns trigger
language plpgsql
as $$
declare
  v_adapter text;
begin
  select tt.adapter into v_adapter from tender_type tt where tt.code = new.instrument;

  if v_adapter <> 'gateway' then
    raise exception
      'PaymentIntentInstrumentIsNotAGatewayKind: "%" is served by the "%" adapter, so there is nothing to '
      'authorise: money taken at the desk is recorded as a payment against the invoice and posted in the '
      'same transaction. An intent beside it would post the same money twice.',
      new.instrument, v_adapter
      using errcode = 'ZY165';
  end if;

  return new;
end $$;

comment on function assert_payment_intent_instrument_is_a_gateway_kind() is
  'Raises ZY165 unless tender_type.adapter for the intent''s instrument is ''gateway''. The foreign key '
  'already refuses an unknown kind; this refuses a KNOWN one that the till takes rather than a gateway.';

create trigger payment_intent_instrument_is_a_gateway_kind
  before insert or update of instrument on payment_intent
  for each row execute function assert_payment_intent_instrument_is_a_gateway_kind();

commit;
