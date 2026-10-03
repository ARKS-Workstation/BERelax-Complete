-- 0147 — the webhook event: replay protection and idempotency are TWO claims, and both live here.
--
-- Y-PAY-04. ADR 0100 is the decision, `packages/payments/src/webhook/verify.ts` is the signature and
-- `packages/payments/src/webhook/handlers.ts` is the application. What this file is for is the half that
-- survives a restart, and for this unit that half is most of the unit.
--
-- ## Why neither claim can live in a handler
--
-- The obvious implementation of "do not process an event twice" is a `Set` of seen event ids. It works
-- perfectly in a test, in review, and until the next deploy — at which point the set is empty, the
-- gateway is still retrying the deliveries it has not had a 200 for, and every one of them is applied a
-- second time. The web process restarts on every release and the worker restarts on every crash, so the
-- memory of what has been seen has to outlive both. That is this table.
--
-- ## The two claims, and why one unique constraint is not both
--
-- **Replay protection**: the same event delivered twice must land ONCE. `unique (gateway, event_id)` is
-- that, and the handler answers 200 to the second delivery rather than refusing it — a gateway that gets
-- a 4xx for a redelivery escalates an incident about an event that was already processed correctly.
--
-- **Idempotency**: a DIFFERENT event with a reused id must be REFUSED. The unique constraint cannot tell
-- the two apart: both are a second row with the same id. So `payload_sha256` is stored and `ZY672`
-- compares it — a redelivery of the same bytes is the first claim and a different body under a known id
-- is the second, and they take opposite actions. One is answered 200 and ignored; the other is refused,
-- audited and never applied, because it is either a gateway defect that would double-count money or
-- somebody who has the signing secret and is editing the payload.
--
-- The digest is of the BYTES the gateway sent, computed before the body was parsed — for
-- `settlement_batch.content_sha256`'s reason one unit along: two bodies that parse to the same delivery
-- in a different key order are the same event, and re-serialising a parsed object to hash it would make
-- them different.
--
-- ## Why there is a second table rather than a `handled` boolean
--
-- ADR 0008's rule is exactly-once-per-HANDLER, and one event legitimately has more than one. A `captured`
-- delivery moves the intent AND settles the invoice it paid for, and those are different writes that can
-- fail independently — so a boolean on the event would mean "something was done", which is not a claim
-- anybody can retry against. `payment_webhook_handler_run` carries one row per (event, handler) with its
-- own outcome, `unique (webhook_event_id, handler)` is the exactly-once, and a handler added later
-- re-processes the events it has no row for without re-running the ones it does.
--
-- `ZY674` holds `handler` to the set `payment_webhook_handlers()` declares, which is the SQL half of
-- `WEBHOOK_HANDLERS` in `@berelax/payments` with the pairing check shipping in the same commit
-- (`packages/fixtures/src/payment-webhook.itest.ts`). Without it a typo in a handler name is a NEW slot
-- in the unique constraint, so the event is processed twice and the key that was supposed to prevent it
-- reports success.
--
-- ## Why `ZY673` exists: "applied" has to mean something
--
-- A handler run recorded as `applied` for the intent handler must have the matching
-- `payment_intent_transaction` row, in the same transaction. Without it, the row says the event was
-- applied and nothing moved — and because the run row exists, no retry will ever look at that event
-- again. That is the worst available failure: a lost money movement that the system believes it has
-- processed. DEFERRED, because the transaction row and the run row are separate statements.
--
-- ## What is NOT here
--
-- No signing secret, no key version, no gateway name and no endpoint URL. `gateway` holds an adapter name
-- (`payment_intent.gateway`'s own column) and no provider has been chosen (`Y7-gateway`). The timestamp
-- TOLERANCE is not here either: it is a property of the verification and belongs beside it, and a column
-- for it would be a second answer to a question `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` already has.
--
-- A row here is EVIDENCE THAT A SIGNATURE VERIFIED, which is why there is no `verified` boolean: an
-- unverified delivery writes nothing at all, so a row for one cannot exist. The refusals are
-- `audit_event` rows and nothing else, because an unauthenticated request must not be able to fill a
-- table.
--
-- Four codes of the band ZY671-ZY680. `ZY675`-`ZY680` are unused and are NOT registered: an entry for a
-- code no migration raises is what direction 3 of ADR 0043's gate refuses.
--
--   ZY671  a webhook event and a handler run are append-only
--   ZY672  a reused event id with a different payload digest is refused
--   ZY673  a handler run recorded as applied must have the movement it claims to have applied
--   ZY674  a handler run must name a handler this build declares

begin;

-- ------------------------------------------------------------------------------------------------
-- payment_webhook_handlers — the handler set, stated once in SQL
-- ------------------------------------------------------------------------------------------------

-- The mirror of `WEBHOOK_HANDLERS` in `@berelax/payments`, held equal to it by
-- `packages/fixtures/src/payment-webhook.itest.ts`. `settlement_tie_account()` (0136) is the same
-- arrangement one unit along, and the reason is identical: the second home buys a REFUSAL the first
-- cannot make, because a typo in a handler name is a new slot in a unique constraint rather than an error.
create function payment_webhook_handlers() returns text[]
  language sql immutable parallel safe
  as $$ select array['intent', 'invoice-settlement']::text[] $$;

comment on function payment_webhook_handlers() is
  'The handlers a payment webhook event may be processed by. The SQL half of WEBHOOK_HANDLERS in '
  '@berelax/payments, held equal to it by packages/fixtures/src/payment-webhook.itest.ts. ZY674 is what '
  'it is for: unique (webhook_event_id, handler) is exactly-once only if the handler name is one of a '
  'closed set, because a typo is a NEW slot and the event is then processed twice while the constraint '
  'reports success.';

-- ------------------------------------------------------------------------------------------------
-- payment_webhook_event — one row per VERIFIED delivery
-- ------------------------------------------------------------------------------------------------

create table payment_webhook_event (
  id                 uuid        primary key default uuid_generate_v7(),

  -- The adapter the delivery is attributed to. `payment_intent.gateway`'s own column, and free text for
  -- its reason: no provider has been chosen (Y7-gateway).
  gateway            text        not null
                       constraint payment_webhook_event_gateway_nonempty
                       check (btrim(gateway) <> ''),

  -- The GATEWAY's own identifier for the event. Stable across redeliveries, which is the whole mechanism.
  event_id           text        not null
                       constraint payment_webhook_event_id_nonempty
                       check (btrim(event_id) <> ''),

  -- One of `PAYMENT_INTENT_EVENTS` in @berelax/core. Checked against the SAME tuple
  -- `payment_intent_transaction.gateway_event_type` admits, so a delivery this build cannot fold is
  -- refused at the boundary rather than stored and skipped for ever.
  event_type         text        not null
                       constraint payment_webhook_event_type_known
                       check (event_type in ('action_required', 'authorised', 'authorisation_failed',
                                             'captured', 'refunded', 'voided')),

  gateway_intent_id  text        not null
                       constraint payment_webhook_event_intent_nonempty
                       check (btrim(gateway_intent_id) <> ''),

  -- The amount the event carries, in integer fils, or NULL for an event that moves no money.
  --
  -- Stored, and that is load-bearing rather than a convenience. A capture delivered BEFORE the
  -- authorisation it belongs to cannot be folded when it arrives — ADR 0056's table is strict, and a
  -- capture on an unauthorised intent is a real defect — so it is HELD on this table and re-folded when
  -- its predecessor turns up. Re-folding needs the amount, and the only other place it exists is the
  -- body, which is not kept: a webhook payload is attacker-controlled text that verified, and under
  -- SAQ-A it is the one place a misconfigured gateway could put card data (ADR 0067). So the two
  -- figures the fold needs — the instant and the amount — are columns, and the body is not.
  --
  -- The three-way CHECK is `INTENT_EVENT_CARRIES_AMOUNT` in @berelax/core, and both directions are
  -- refusals: a `captured` with no amount is a capture of an unknown quantity the fold would have to
  -- guess at, and a `voided` WITH one reads as a partial void, which does not exist. It is the same
  -- partition `payment_intent_transaction_amount_matches_event` states one table along, and it is stated
  -- rather than joined because an event held here has no transaction row yet to borrow it from.
  amount_fils        bigint
                       constraint payment_webhook_event_amount_matches_type
                       check (
                         case
                           when event_type in ('authorised', 'captured', 'refunded')
                             then amount_fils is not null and amount_fils > 0
                           else amount_fils is null
                         end
                       ),

  -- The digest of the BYTES, lower-case hex, computed before the body was parsed. ZY672's subject.
  payload_sha256     text        not null
                       constraint payment_webhook_event_payload_is_sha256
                       check (payload_sha256 ~ '^[0-9a-f]{64}$'),

  -- The gateway's own instant, which the lifecycle fold orders by, and ours, which is when we heard.
  -- Both, because a delivery that arrived three days late is a fact about the gateway and `occurred_at`
  -- cannot say it.
  occurred_at        timestamptz not null,
  received_at        timestamptz not null default now(),

  -- The instant the SIGNATURE covered, from the signed timestamp header. Carried because it is the thing
  -- the tolerance was judged against, and a row that could not say so would make a dispute about whether
  -- a delivery was stale unanswerable.
  signed_at          timestamptz not null,

  -- One row per event per gateway. REPLAY PROTECTION: the second delivery of one event is a unique
  -- violation, which the handler answers 200 to rather than refusing.
  constraint payment_webhook_event_one_row_per_event unique (gateway, event_id)
);

comment on table payment_webhook_event is
  'One VERIFIED webhook delivery. A row here is EVIDENCE THAT A SIGNATURE VERIFIED, which is why there is '
  'no verified boolean: an unverified delivery writes nothing at all, so a row for one cannot exist, and '
  'the refusals are audit_event rows because an unauthenticated request must not be able to fill a table. '
  'unique (gateway, event_id) is REPLAY PROTECTION - the same event twice lands once - and '
  'payload_sha256 plus ZY672 is IDEMPOTENCY, which is a different claim: a DIFFERENT body under a known '
  'id is refused, audited and never applied. Append-only (ZY671) for every role including the owner.';
comment on column payment_webhook_event.payload_sha256 is
  'The digest of the BYTES the gateway sent, computed before the body was parsed. Of the bytes and not of '
  'the parsed delivery, for settlement_batch.content_sha256''s reason: two bodies that parse the same in '
  'a different key order are the same event, and re-serialising to hash would make them different.';
comment on column payment_webhook_event.amount_fils is
  'The amount the event carries, or NULL for one that moves no money. STORED, because a capture '
  'delivered before its authorisation cannot be folded on arrival (ADR 0056''s table is strict) and is '
  'HELD here until its predecessor turns up - and re-folding needs the amount. The body is not kept, so '
  'this column and occurred_at are the only two figures the fold has. The three-way check is '
  'INTENT_EVENT_CARRIES_AMOUNT in @berelax/core.';
comment on column payment_webhook_event.signed_at is
  'The instant the signature covered. Carried because it is what the timestamp tolerance was judged '
  'against; without it, a dispute about whether a delivery was stale has no answer in the database.';

create index payment_webhook_event_intent_idx
  on payment_webhook_event (gateway_intent_id, occurred_at);
create index payment_webhook_event_received_idx on payment_webhook_event (received_at desc);

revoke update, delete, truncate on payment_webhook_event from berelax_app;

-- ------------------------------------------------------------------------------------------------
-- payment_webhook_handler_run — exactly once per (event, handler)
-- ------------------------------------------------------------------------------------------------

create table payment_webhook_handler_run (
  id                 uuid        primary key default uuid_generate_v7(),
  webhook_event_id   uuid        not null references payment_webhook_event (id),

  handler            text        not null,

  -- `applied` means this handler changed something; `skipped` means it looked and had nothing to do (a
  -- capture for an intent that names no document, say). Both are a RUN: a handler that answered "nothing
  -- to do" must not be re-run on the next redelivery, because the answer will not have changed and the
  -- retry would be a scan nobody reads.
  outcome            text        not null
                       constraint payment_webhook_handler_run_outcome_known
                       check (outcome in ('applied', 'skipped')),

  -- What it did, for an operator. Blank is a blank row, which is the same lie as a missing one.
  detail             text        not null
                       constraint payment_webhook_handler_run_detail_nonempty
                       check (btrim(detail) <> ''),

  created_at         timestamptz not null default now(),

  -- ADR 0008's exactly-once-per-handler, as a constraint. One event, one run per handler.
  constraint payment_webhook_handler_run_once unique (webhook_event_id, handler)
);

comment on table payment_webhook_handler_run is
  'One row per (event, handler): ADR 0008''s exactly-once-per-handler as a constraint. A boolean on the '
  'event would have said only "something was done", and one delivery legitimately has more than one '
  'handler - a capture moves the intent AND settles the document it paid for, and those can fail '
  'independently. A handler added later re-processes the events it has no row for without re-running the '
  'ones it does. Append-only (ZY671).';

create index payment_webhook_handler_run_handler_idx
  on payment_webhook_handler_run (handler, created_at desc);

revoke update, delete, truncate on payment_webhook_handler_run from berelax_app;

-- ------------------------------------------------------------------------------------------------
-- ZY671 — both tables are append-only
-- ------------------------------------------------------------------------------------------------

create function refuse_payment_webhook_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'PaymentWebhookIsAppendOnly: % on %.% is refused. A webhook event row is evidence that a signature '
    'verified over specific bytes at a specific instant, and a handler run is evidence that an event was '
    'processed exactly once. Editing either would restate what was delivered or what was done, and '
    'deleting one would let a gateway''s next retry apply the same money movement again - which is the '
    'failure the table exists to prevent.',
    tg_op, tg_table_schema, tg_table_name
    using errcode = 'ZY671';
end $$;

comment on function refuse_payment_webhook_change() is
  'Raises ZY671 for every UPDATE and DELETE on payment_webhook_event and payment_webhook_handler_run, '
  'for EVERY role including the owner. One function for both because it is one rule.';

create trigger payment_webhook_event_no_update before update on payment_webhook_event
  for each row execute function refuse_payment_webhook_change();
create trigger payment_webhook_event_no_delete before delete on payment_webhook_event
  for each row execute function refuse_payment_webhook_change();
create trigger payment_webhook_handler_run_no_update before update on payment_webhook_handler_run
  for each row execute function refuse_payment_webhook_change();
create trigger payment_webhook_handler_run_no_delete before delete on payment_webhook_handler_run
  for each row execute function refuse_payment_webhook_change();

-- ------------------------------------------------------------------------------------------------
-- ZY672 — a reused event id with a different payload is refused
-- ------------------------------------------------------------------------------------------------

-- Immediate, because it is a property of the row against rows that already exist: there is no legal
-- intermediate state, and a refusal at the INSERT names the statement that caused it.
--
-- This fires BEFORE the unique constraint would, which is the point. A redelivery of the SAME bytes trips
-- `payment_webhook_event_one_row_per_event` (23505) and the caller answers 200; a reused id over
-- DIFFERENT bytes trips this and the caller refuses. A bare 23505 cannot tell the two apart, and treating
-- both as a redelivery is how a forged payload under a known event id would be silently accepted and
-- then silently ignored.
create function assert_webhook_event_id_is_not_reused() returns trigger
language plpgsql
as $$
declare
  v_existing text;
begin
  select e.payload_sha256 into v_existing
    from payment_webhook_event e
   where e.gateway = new.gateway and e.event_id = new.event_id;

  if v_existing is null then return new; end if;
  if v_existing = new.payload_sha256 then
    -- The same bytes again: a redelivery. Let the unique constraint refuse it, so the caller gets the
    -- 23505 it answers 200 to. Raising here would make a redelivery indistinguishable from a forgery.
    return new;
  end if;

  raise exception
    'WebhookEventIdReused: event % from % already exists with a different payload digest. Replay '
    'protection and idempotency are two different claims: the SAME event delivered twice lands once and '
    'is answered 200, and a DIFFERENT event under a reused id is refused. This is the second, and it is '
    'either a gateway defect that would double-count money or somebody who holds the signing secret and '
    'is editing the body. It is never applied.',
    new.event_id, new.gateway
    using errcode = 'ZY672';
end $$;

comment on function assert_webhook_event_id_is_not_reused() is
  'Raises ZY672 when an event id is reused over a DIFFERENT payload digest, and deliberately does NOT '
  'raise for the same digest - that case falls through to the unique constraint, whose 23505 the caller '
  'answers 200 to. A bare 23505 cannot tell a redelivery from a forgery, and treating both as a '
  'redelivery accepts the forgery silently and then ignores it silently.';

create trigger payment_webhook_event_id_is_not_reused
  before insert on payment_webhook_event
  for each row execute function assert_webhook_event_id_is_not_reused();

-- ------------------------------------------------------------------------------------------------
-- ZY673 / ZY674 — a run names a known handler, and "applied" means something moved
-- ------------------------------------------------------------------------------------------------

create function assert_webhook_handler_run_is_real() returns trigger
language plpgsql
as $$
declare
  v_event payment_webhook_event;
  v_moved int;
begin
  if not (new.handler = any (payment_webhook_handlers())) then
    raise exception
      'WebhookHandlerIsNotDeclared: "%" is not a handler this build declares (%). unique '
      '(webhook_event_id, handler) is exactly-once ONLY if the handler name is one of a closed set: a '
      'typo is a NEW slot in that constraint, so the event is processed twice while the constraint '
      'reports success. The set is payment_webhook_handlers() here and WEBHOOK_HANDLERS in '
      '@berelax/payments, held equal by packages/fixtures/src/payment-webhook.itest.ts.',
      new.handler, array_to_string(payment_webhook_handlers(), ', ')
      using errcode = 'ZY674';
  end if;

  if new.outcome <> 'applied' or new.handler <> 'intent' then
    return null;
  end if;

  select * into v_event from payment_webhook_event where id = new.webhook_event_id;
  -- Absent only if the whole transaction is being rolled back, in which case this never commits.
  if not found then return null; end if;

  select count(*) into v_moved
    from payment_intent_transaction t
    join payment_intent pi on pi.id = t.payment_intent_id
   where t.gateway_event_id = v_event.event_id
     and pi.gateway_intent_id = v_event.gateway_intent_id;

  if v_moved = 0 then
    raise exception
      'WebhookRunClaimsAnUnappliedMovement: the intent handler recorded event % as "applied" and there is '
      'no payment_intent_transaction for it on intent %. Because the run row exists, no retry will ever '
      'look at that event again - so this state is a LOST money movement that the system believes it has '
      'processed, which is the worst failure available to a webhook endpoint. ADR 0056: only a gateway '
      'transaction row may move an intent, and this is the other half of it.',
      v_event.event_id, v_event.gateway_intent_id
      using errcode = 'ZY673';
  end if;

  return null;
end $$;

comment on function assert_webhook_handler_run_is_real() is
  'ZY674 holds a run''s handler to payment_webhook_handlers(). ZY673 holds an "applied" run of the intent '
  'handler to having its payment_intent_transaction row, at COMMIT, because the run row is what stops a '
  'retry - so a run with nothing behind it is a lost movement nothing will ever revisit. Deferred, '
  'because the transaction row and the run row are separate statements.';

create constraint trigger payment_webhook_handler_run_is_real
  after insert on payment_webhook_handler_run
  deferrable initially deferred
  for each row execute function assert_webhook_handler_run_is_real();

commit;
