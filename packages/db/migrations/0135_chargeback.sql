-- 0135 — the chargeback: a third party's decision, arriving late, as a dated event and never as an edit.
--
-- Y-PAY-08. ADR 0089 is the decision, `packages/core/src/ledger/chargeback.ts` is the entries and
-- `packages/core/src/payments/refund.ts` is the cap. What this file is for is the half a `psql` prompt can
-- reach, and for this unit that half is most of the unit: the things being prevented here are a refund
-- that a screen's validation would be the only thing standing in the way of, and a chargeback recorded by
-- editing the payment it is about.
--
-- ## Why a chargeback is a ROW and not a column on the payment
--
-- The acquirer takes the money back and tells the business afterwards — sometimes weeks afterwards, and
-- sometimes about a trading day that has been cashed up, reported and filed. The tempting
-- implementation is `payment_intent.captured_fils = captured_fils - disputed`, and it is refused on two
-- separate grounds.
--
-- The first is mechanical: `captured_fils` is a PROJECTION of the append-only `payment_intent_transaction`
-- rows and `ZY163` holds the two equal at commit, so the subtraction cannot be written without also
-- writing a fake transaction row. The second is the reason `ZY163` exists at all: the capture HAPPENED.
-- Restating it would leave the sale's own journal entry explaining money the header says was never taken,
-- and nothing in the database would say which of the two was edited.
--
-- So a dispute is `chargeback`: its own `received_at`, its own `trading_date`, its own journal entry, and
-- no write to `payment_intent` at all. `pnpm no-invoice-mutation` enforces the identical rule one table
-- along for `invoice` and `credit_note`, and this file contains no UPDATE of any payment or document.
--
-- ## Why the trading date is checked here and not just computed by the caller
--
-- Trading runs 11:00-02:00, so an acquirer's notice at 01:30 belongs to the PREVIOUS trading date.
-- `resolveTradingDate` in `@berelax/core` is the primitive and the caller resolves it — but `ZY432` checks
-- the answer against `business_day` in SQL, because a notice attributed to the calendar date lands in a
-- cash-up for a day whose session had not started, and the two days' card totals are then both wrong by
-- the same amount in opposite directions. That is the kind of error that reconciles perfectly at every
-- level except the one it is wrong at.
--
-- A notice outside trading hours is REFUSED rather than attributed to the nearest day (ADR 0070). Of the
-- two available errors only one is detectable afterwards: a refusal names the notice and stops the import,
-- and a substituted date reconciles against a day nothing happened on.
--
-- ## ZY433 is the unit's other half: the refund cap is a DATABASE refusal
--
-- `payment_intent` already carries `check (refunded_fils <= captured_fils)`. That check is satisfied by an
-- intent whose money has ALREADY been taken back: AED 100 captured, AED 100 charged back, and AED 100 is
-- still refundable by that arithmetic — so the business refunds money it no longer has, and the figure
-- reconciles at both ends. What remains refundable is `captured - refunded - chargedBackNet`, and `ZY433`
-- is that identity over the rows.
--
-- It is checked on BOTH tables, because either side can break it: a refund arriving after a dispute, and a
-- dispute arriving after a refund. The second is the common one — a customer refunded in good faith, who
-- then disputes the original charge anyway — and a rule attached only to the refund path would miss it
-- entirely.
--
-- Y-PAY-06's deposit refund already caps at the balance held and records why in its own file: an uncapped
-- subtraction returns a NEGATIVE refund the day a fee exceeds a deposit, which posts as money ARRIVING
-- from a cancellation. This is the same mistake with a third party in it.
--
-- ## The partition is total, so 1045 cannot hold a balance nobody can explain
--
-- `kind` is {received, won, lost} and `ZY434` refuses a resolution with no `received` before it and a
-- second resolution after one. Every received dispute therefore ends won or lost, which is what makes
-- `1045 Disputed card receipts` a clearing account rather than a place figures accumulate. `ZY436` holds a
-- won dispute's entry to being the REVERSAL of its received entry, which is the acceptance line "a won
-- dispute reverses it to a net-zero journal effect, asserted to the fils" made into a statement PostgreSQL
-- enforces — a hand-built mirror entry would be correct today and would be where the two amounts drifted.
--
-- ## One account, added here and generated from the chart
--
-- `1045` is new. It is NOT `1030 Gateway clearing`: a clearing balance is money the business WILL receive
-- and a disputed receipt is money it MAY receive, and a reader of the balance sheet who cannot see the two
-- apart cannot check either against its own source — ADR 0064's argument for a partition, and 0077's
-- argument for 2045 one liability along. And it is not an expense, because at the moment a chargeback
-- lands the business has not lost the money; it has lost the use of it while somebody else decides.
--
-- Six codes of the band `ZY431`-`ZY440`. `ZY437`-`ZY440` are unused and are NOT registered: an entry for a
-- code no migration raises is what direction 3 of ADR 0043's gate refuses.
--
--   ZY431  a chargeback row is append-only
--   ZY432  a chargeback's trading date must be the business day containing the instant it arrived
--   ZY433  refunded plus charged-back-net may never exceed captured
--   ZY434  a resolution must follow a received dispute, and a dispute resolves once
--   ZY435  a dispute may not be recorded against an intent that captured nothing
--   ZY436  a won dispute's entry must REVERSE its received entry, to the fils

begin;

-- ------------------------------------------------------------------------------------------------
-- 1045 Disputed card receipts
-- ------------------------------------------------------------------------------------------------

-- GENERATED from STANDARD_SPA_CHART in packages/core/src/ledger/chart-of-accounts.ts, not retyped;
-- `on conflict do nothing` so re-applying is safe (0018's shape).
insert into account (chart_id, code, name, type, normal_balance, contra, vat_box, input_vat_recoverable)
values ('standard-spa-uae', '1045', 'Disputed card receipts', 'asset', 'debit', false, null, false)
on conflict (code) do nothing;

-- Every account carries exactly one `vat201_box_mapping` row or `ZY009` refuses the transaction, and this
-- one is `out_of_scope`. A dispute moves money between a clearing account and a claim; it is not a supply
-- and it does not adjust one. The invoice stands and its output VAT stands with it, which is why a
-- chargeback entry touches neither 2030 nor any revenue account — and an `unallocated` row here would put
-- a figure with nowhere to go on the working papers over a transaction that is not a supply at all.
--
-- `open_question_id` is null and the constraint requires it to be: an allocated row carrying a question id
-- would keep a settled account on the Unconfirmed Assumptions panel for ever (0089's own rule, 0124's
-- wording).
insert into vat201_box_mapping (account_code, disposition, box_no, measure, contribution, note)
values ('1045', 'out_of_scope', null, null, null,
        'Feeds no VAT201 box. A balance-sheet claim against an acquirer. A chargeback does not undo the '
        'supply - the treatment was delivered and the invoice stands - so no output VAT is adjusted and '
        'the disputed amount belongs to no box. A LOST dispute writes the amount off to 6150 Bad debt, '
        'which is where that account''s own mapping takes it.')
on conflict (account_code) do nothing;

-- `1045` appears in exactly one place in SQL that a caller can read, so the pair with
-- `ACCOUNTS.disputedCardReceipts` in @berelax/core can be asserted in ONE assertion rather than wherever
-- the literal happened to be typed. `customer_deposit_account_code()` (0124) and
-- `tips_payable_account_code()` (0068) are the same arrangement one account along each way.
create function disputed_card_receipts_account_code() returns text
  language sql immutable parallel safe
  as $$ select '1045'::text $$;

comment on function disputed_card_receipts_account_code() is
  'The account a card receipt sits in while a third party decides whether the business may keep it. '
  'Stated once so ZY436''s predicate and @berelax/core''s ACCOUNTS.disputedCardReceipts can be compared in '
  'one place (packages/fixtures/src/chargeback.itest.ts).';

-- ------------------------------------------------------------------------------------------------
-- chargeback — the dispute, as the events that made it
-- ------------------------------------------------------------------------------------------------

create table chargeback (
  id                uuid        primary key default uuid_generate_v7(),
  -- A real key, and deliberately so: a dispute with no payment behind it is money leaving with nothing on
  -- the other side. `payment_intent` is in none of the five truncate families (0068's `payment` is, and
  -- this table does not reference it), so the key costs no suite its teardown.
  payment_intent_id uuid        not null references payment_intent (id),

  -- The ACQUIRER's own identifier for the dispute, so two notices about one dispute are one dispute. Free
  -- text and not an enum of formats: no gateway has been chosen (Y7-gateway) and nothing here may assume
  -- the shape of a reference a vendor nobody picked will mint.
  dispute_ref       text        not null
                      constraint chargeback_dispute_ref_nonempty check (btrim(dispute_ref) <> ''),

  kind              text        not null
                      constraint chargeback_kind_known
                      check (kind in ('received', 'won', 'lost')),

  amount_fils       fils_nonneg not null
                      constraint chargeback_amount_positive check (amount_fils > 0),

  -- The instant the NOTICE arrived, and the business day it belongs to. Both, because the second is not
  -- derivable from the first without `business_day` and the first is what an operator disputes.
  received_at       timestamptz not null,
  trading_date      date        not null references business_day (trading_date),

  -- Mandatory and a real key: a dispute with no entry behind it makes 1045 unexplainable, which is
  -- `deposit_movement.journal_entry_id`'s decision one liability along.
  journal_entry_id  text        not null references journal_entry (entry_id),

  created_at        timestamptz not null default now(),

  -- One row per dispute per kind. A redelivered webhook notice is then a unique violation rather than a
  -- second posting, which is the property Y-PAY-04's handler needs to answer a replay with 200 and no
  -- second transition.
  constraint chargeback_one_row_per_dispute_event unique (dispute_ref, kind)
);

comment on table chargeback is
  'Every event in a card dispute: the acquirer taking the money, and its decision afterwards. A ROW and '
  'never an edit to the payment - payment_intent.captured_fils is a projection of append-only transaction '
  'rows (ZY163) and the capture HAPPENED, so restating it would leave the sale''s own entry explaining '
  'money the header says was never taken. Append-only itself: UPDATE and DELETE raise ZY431, for every '
  'role including the owner, because a dispute that was reported wrongly is a NEW event. kind is a total partition {received, won, lost} and ZY434 keeps it so, which is what '
  'makes 1045 a clearing account rather than a place figures accumulate.';
comment on column chargeback.trading_date is
  'The business day this notice belongs to, from resolveTradingDate in @berelax/core. ZY432 checks it '
  'against business_day, because trading runs 11:00-02:00 and a notice at 01:30 belongs to the PREVIOUS '
  'trading date - attributed to the calendar date it lands in a cash-up for a session that had not '
  'started, and two days'' card totals are wrong by the same amount in opposite directions.';
comment on column chargeback.dispute_ref is
  'The ACQUIRER''s identifier for the dispute, so two notices about one dispute are one dispute. Free '
  'text: no gateway has been chosen (Y7-gateway) and the shape of this value is not this build''s to '
  'assume.';

create index chargeback_intent_idx on chargeback (payment_intent_id, received_at);
create index chargeback_trading_date_idx on chargeback (trading_date, kind);
create index chargeback_dispute_idx on chargeback (dispute_ref);

revoke update, delete, truncate on chargeback from berelax_app;

-- ------------------------------------------------------------------------------------------------
-- chargeback_position — what each dispute has taken, net of what was won back
-- ------------------------------------------------------------------------------------------------

-- ADR 0057's shape: the live figure is a derivation over rows nobody has edited, not a stored column. A
-- `lost` dispute leaves the money gone and so does an unresolved one; only a `won` one gives it back, and
-- unresolved and lost must count the SAME way, because "we might get it back" is not money the business
-- can refund to somebody else in the meantime.
create view chargeback_position as
select c.payment_intent_id,
       sum(case when c.kind = 'received' then c.amount_fils
                when c.kind = 'won'      then -c.amount_fils
                else 0 end)::bigint as charged_back_net_fils,
       count(*) filter (where c.kind = 'received')::int as disputes_received,
       count(*) filter (where c.kind = 'won')::int      as disputes_won,
       count(*) filter (where c.kind = 'lost')::int     as disputes_lost
  from chargeback c
 group by c.payment_intent_id;

comment on view chargeback_position is
  'Per intent: what disputes have taken, NET of what was won back, and the counts behind it. An intent '
  'with no dispute is ABSENT rather than zero - "never disputed" and "disputed and won" are different '
  'facts and the second one has rows. chargedBackNetFils in @berelax/core is the same arithmetic and '
  'packages/fixtures/src/chargeback.itest.ts holds the two equal.';

grant select on chargeback_position to berelax_app;

-- ------------------------------------------------------------------------------------------------
-- ZY431 — a chargeback row is append-only
-- ------------------------------------------------------------------------------------------------

create function refuse_chargeback_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'ChargebackIsAppendOnly: % on chargeback is refused. Each row is a dated event with its own journal '
    'entry behind it, and the whole point of the table is that a third party''s decision is RECORDED '
    'rather than applied as an edit. Editing a row would restate a decision the ledger has already '
    'explained; deleting one would leave an entry with nothing it was about. A dispute reported wrongly '
    'is a NEW event.',
    tg_op
    using errcode = 'ZY431';
end $$;

comment on function refuse_chargeback_change() is
  'Raises ZY431 for every UPDATE and DELETE on chargeback, for EVERY role including the owner. The remedy '
  'is always a new event.';

create trigger chargeback_no_update before update on chargeback
  for each row execute function refuse_chargeback_change();
create trigger chargeback_no_delete before delete on chargeback
  for each row execute function refuse_chargeback_change();

-- ------------------------------------------------------------------------------------------------
-- ZY432 / ZY435 / ZY436 — the date, the capture behind it, and the reversal that must net to zero
-- ------------------------------------------------------------------------------------------------

-- DEFERRED for ZY436's half, because the entry, its lines and this row are separate INSERT statements, so
-- an immediate trigger would reject the legal sequence (0124's reason, one table along).
create function assert_chargeback_is_attributable() returns trigger
language plpgsql
as $$
declare
  v_resolved  date;
  v_captured  bigint;
  v_state     text;
begin
  -- The business day CONTAINING the instant. `business_day` is the primitive and its ranges are half-open
  -- `[opens_at, closes_at)`, which is the same convention every interval in this build uses - so an
  -- instant exactly at close belongs to the next session and not to two.
  select bd.trading_date into v_resolved
    from business_day bd
   where tstzrange(bd.opens_at, bd.closes_at, '[)') @> new.received_at
   order by bd.trading_date
   limit 1;

  if v_resolved is null then
    raise exception
      'ChargebackIsOutsideTrading: dispute % arrived at % which falls in no business_day session, so the '
      'trading date it claims (%) cannot be checked. It is REFUSED rather than attributed to the nearest '
      'day: a substituted date reconciles perfectly against a day nothing happened on, and a refusal '
      'names the notice (ADR 0070).',
      new.dispute_ref, new.received_at, new.trading_date
      using errcode = 'ZY432';
  end if;

  if v_resolved <> new.trading_date then
    raise exception
      'ChargebackTradingDateDisagrees: dispute % arrived at %, which belongs to trading date %, and the '
      'row claims %. Trading runs 11:00-02:00, so a notice at 01:30 belongs to the PREVIOUS trading '
      'date - attributed to the calendar date it lands in a cash-up for a session that had not started, '
      'and two days'' card totals are then wrong by the same amount in opposite directions.',
      new.dispute_ref, new.received_at, v_resolved, new.trading_date
      using errcode = 'ZY432';
  end if;

  select pi.captured_fils, pi.state into v_captured, v_state
    from payment_intent pi where pi.id = new.payment_intent_id;

  if coalesce(v_captured, 0) = 0 then
    raise exception
      'ChargebackAgainstAnUncapturedIntent: intent % is "%" and has captured % fils, so there is nothing '
      'for dispute % to take back. An authorisation is a RESERVATION and not money; a voided or failed '
      'intent moved none at all. A dispute recorded here would be money leaving the business with '
      'nothing on the other side of the entry.',
      new.payment_intent_id, coalesce(v_state, 'absent'), coalesce(v_captured, 0), new.dispute_ref
      using errcode = 'ZY435';
  end if;

  return new;
end $$;

comment on function assert_chargeback_is_attributable() is
  'ZY432 holds a chargeback''s trading_date to the business_day containing received_at - the 01:30 rule - '
  'and refuses an instant in no session rather than attributing it to the nearest day (ADR 0070). ZY435 '
  'refuses a dispute against an intent that captured nothing.';

create trigger chargeback_is_attributable
  before insert on chargeback
  for each row execute function assert_chargeback_is_attributable();

-- ------------------------------------------------------------------------------------------------
-- ZY434 — a resolution follows a received dispute, and a dispute resolves once
-- ------------------------------------------------------------------------------------------------

-- The unique constraint already refuses a second `won`. What it cannot refuse is a `won` AND a `lost` for
-- one dispute, or either with no `received` before it - and both of those leave 1045 holding a figure
-- nobody can explain, which is the whole reason the partition has to be total.
create function assert_chargeback_sequence() returns trigger
language plpgsql
as $$
declare
  v_received  int;
  v_resolved  int;
begin
  if new.kind = 'received' then
    return new;
  end if;

  select count(*) filter (where c.kind = 'received'),
         count(*) filter (where c.kind in ('won', 'lost'))
    into v_received, v_resolved
    from chargeback c
   where c.dispute_ref = new.dispute_ref;

  if v_received = 0 then
    raise exception
      'ChargebackResolvedBeforeItArrived: dispute % is being recorded as "%" and no received event for it '
      'exists. A decision about a dispute nobody took the money for would credit 1045 with a balance it '
      'never held, and the account would carry the difference for ever.',
      new.dispute_ref, new.kind
      using errcode = 'ZY434';
  end if;

  if v_resolved > 0 then
    raise exception
      'ChargebackResolvedTwice: dispute % already has a resolution and is being recorded as "%" as well. '
      'A dispute is decided once; a second decision would unwind 1045 twice and leave the account '
      'negative by the disputed amount.',
      new.dispute_ref, new.kind
      using errcode = 'ZY434';
  end if;

  return new;
end $$;

comment on function assert_chargeback_sequence() is
  'Raises ZY434 for a resolution with no received event before it, and for a second resolution of one '
  'dispute. The unique constraint refuses a repeated KIND; this refuses a wrong SEQUENCE, which is a '
  'different claim and the one that keeps the {received, won, lost} partition total.';

create trigger chargeback_sequence
  before insert on chargeback
  for each row execute function assert_chargeback_sequence();

-- ------------------------------------------------------------------------------------------------
-- ZY436 — a won dispute's entry REVERSES its received entry, to the fils
-- ------------------------------------------------------------------------------------------------

-- DEFERRED: the entry, its lines and this row are separate statements.
--
-- The claim is checked over `journal_line` on `1045` rather than by comparing `chargeback.amount_fils`,
-- and that is the point. Two entries can each balance perfectly while moving different amounts on this
-- one account, and that is the only way the identity can fail - so the identity is read where it lives.
create function assert_won_chargeback_nets_to_zero() returns trigger
language plpgsql
as $$
declare
  disputed_account text := disputed_card_receipts_account_code();
  v_received_entry text;
  v_reverses       text;
  v_net            bigint;
begin
  if new.kind <> 'won' then
    return null;
  end if;

  select c.journal_entry_id into v_received_entry
    from chargeback c
   where c.dispute_ref = new.dispute_ref and c.kind = 'received';

  select e.reverses into v_reverses
    from journal_entry e where e.entry_id = new.journal_entry_id;

  if v_reverses is distinct from v_received_entry then
    raise exception
      'WonChargebackIsNotAReversal: dispute % was won, so its entry % must REVERSE the received entry %, '
      'and it names % instead. A hand-built mirror entry is correct today and is where the two amounts '
      'drift the day a partial resolution exists - reverseEntry in @berelax/core swaps the sides and '
      'leaves the absolute fils untouched, so a reversal cannot round differently from its original.',
      new.dispute_ref, new.journal_entry_id, v_received_entry, coalesce(v_reverses, 'nothing')
      using errcode = 'ZY436';
  end if;

  select coalesce(sum(l.debit_fils - l.credit_fils), 0) into v_net
    from journal_line l
   where l.account_code = disputed_account
     and l.entry_id in (v_received_entry, new.journal_entry_id);

  if v_net <> 0 then
    raise exception
      'WonChargebackDoesNotNetToZero: dispute % was won and its two entries move % fils net on %. A won '
      'dispute means the money came back, so the pair must unwind to NOUGHT to the fils; a residue is a '
      'balance on a clearing account that nothing will ever clear.',
      new.dispute_ref, v_net, disputed_account
      using errcode = 'ZY436';
  end if;

  return null;
end $$;

comment on function assert_won_chargeback_nets_to_zero() is
  'Raises ZY436 at COMMIT when a won dispute''s entry is not the reversal of its received entry, or when '
  'the pair leaves a non-zero balance on 1045. Read over journal_line rather than over the two amounts, '
  'because two entries can each balance while moving different amounts on one account - which is the only '
  'way the identity can fail.';

create constraint trigger chargeback_won_nets_to_zero
  after insert on chargeback
  deferrable initially deferred
  for each row execute function assert_won_chargeback_nets_to_zero();

-- ------------------------------------------------------------------------------------------------
-- ZY433 — refunded plus charged-back-net may never exceed captured
-- ------------------------------------------------------------------------------------------------

-- The identity: `refunded_fils + chargedBackNet <= captured_fils`.
--
-- Checked on BOTH tables, because either side can break it. A refund arriving after a dispute is the
-- obvious case; a DISPUTE arriving after a refund is the common one — a customer refunded in good faith
-- who then disputes the original charge anyway — and a rule attached only to the refund path would miss
-- it entirely.
--
-- DEFERRED, so a transaction that posts a refund and its credit note and then corrects a figure inside
-- itself is judged on what it leaves behind rather than on an intermediate state.
create function assert_capture_is_not_over_reversed() returns trigger
language plpgsql
as $$
declare
  v_intent    uuid;
  v_captured  bigint;
  v_refunded  bigint;
  v_disputed  bigint;
begin
  if tg_table_name = 'chargeback' then
    v_intent := new.payment_intent_id;
  else
    v_intent := new.id;
  end if;

  select pi.captured_fils, pi.refunded_fils into v_captured, v_refunded
    from payment_intent pi where pi.id = v_intent;
  -- Absent only if the whole transaction is being rolled back, in which case this never commits.
  if not found then return null; end if;

  select coalesce(p.charged_back_net_fils, 0) into v_disputed
    from chargeback_position p where p.payment_intent_id = v_intent;
  v_disputed := coalesce(v_disputed, 0);

  if v_refunded + v_disputed > v_captured then
    raise exception
      'CaptureIsOverReversed: intent % captured % fils and now has % refunded and % charged back net, '
      'which is % fils more than ever arrived. `check (refunded_fils <= captured_fils)` is satisfied by '
      'this state and that is why this rule exists: an intent whose capture has been taken back by an '
      'acquirer still looks fully refundable to that check, so the business refunds money it no longer '
      'has and the figure reconciles at both ends. What remains refundable is captured - refunded - '
      'chargedBackNet, and this is a DATABASE refusal rather than a screen''s validation because a '
      'screen''s validation is a request that the caller be polite.',
      v_intent, v_captured, v_refunded, v_disputed, (v_refunded + v_disputed - v_captured)
      using errcode = 'ZY433';
  end if;

  return null;
end $$;

comment on function assert_capture_is_not_over_reversed() is
  'Raises ZY433 at COMMIT when refunded_fils plus the net charged-back amount exceeds captured_fils. One '
  'function for both tables because it is ONE identity; tg_table_name chooses where the intent id comes '
  'from, in an IF rather than a CASE expression for 0106''s measured reason - plpgsql resolves every '
  'field reference in one expression and fails with "record new has no field" on whichever table lacks it.';

create constraint trigger chargeback_capture_is_not_over_reversed
  after insert on chargeback
  deferrable initially deferred
  for each row execute function assert_capture_is_not_over_reversed();

create constraint trigger payment_intent_capture_is_not_over_reversed
  after insert or update on payment_intent
  deferrable initially deferred
  for each row execute function assert_capture_is_not_over_reversed();

commit;
