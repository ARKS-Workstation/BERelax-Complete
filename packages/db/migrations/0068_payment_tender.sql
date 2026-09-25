-- 0068 — payments and refunds: the tender-type registry, over-tender change, and the two ceilings
--        that stop money being recorded twice.
--
-- M-TILL-06 created `payment` deliberately minimally and recorded that THIS unit extends it rather than
-- adding a second table, "because two tables recording money received is two answers to 'what has this
-- invoice been paid'". So nothing here creates a second money-received table. What it does is:
--
--   1. turn the closed list of tender kinds into a REGISTRY, `tender_type`, with a declared posting
--      account per type — which is 0063's `payment_tender_kind_known` becoming a foreign key;
--   2. give `payment` the two columns an over-tender needs, so change is RECORDED rather than netted;
--   3. add `refund`, whose authorising credit note is mandatory;
--   4. state the two ceilings — payments may not exceed the document, refunds may not exceed the
--      payments — as DEFERRED constraint triggers rather than as checks a repository performs.
--
-- ## 1. `tender_type` — the registry, and why the account lives here as well as in core
--
-- `packages/core/src/checkout/posting.ts` declares `TENDER_ACCOUNT`, and that is where the posting rule
-- reads it. This table is not a second opinion about it: `packages/db` may never import
-- `packages/core` (brief rule 4), so the write path has no way to see that map, and
-- `payment.posting_account_code` is SNAPSHOTTED onto every row precisely so that re-mapping a type
-- later cannot restate a posting already filed. The registry is what a snapshot is taken FROM, and the
-- two are held equal by `packages/fixtures/src/payment.itest.ts` — the one package allowed to depend on
-- both — with a control proving the comparison can fail.
--
-- A table and not an enum type, for 0063's reason: adding a tender type must not require `ALTER TYPE`
-- inside a transaction that also writes rows. It also gives each type the three facts a till needs and
-- a CHECK cannot express from `payment` alone:
--
--   - `gives_change`     — may a customer hand over more than is due in this form? Cash only. A card is
--                          authorised for an amount; an over-tender on one is a mis-keyed figure, not a
--                          twenty-dirham note.
--   - `requires_reference` — the terminal's approval code or the transfer reference. 0063 could only
--                          refuse a BLANK reference; it had no way to refuse a MISSING one, so a card
--                          payment with nothing to settle a dispute with was a storable row.
--   - `settles_immediately` — cash is in the drawer; a card batch and a transfer arrive later through a
--                          clearing account. `tender_type_change_needs_immediate_settlement` is the
--                          consequence: change cannot be handed back out of money that has not arrived.
--
-- `adapter` names which adapter owns the type. All three are `manual` today, which is the honest
-- answer — there is no gateway yet — and it is the column the Y-PAY types will differ on.
--
-- ## 2. `payment.change_given_fils` and `payment.applied_fils`
--
-- `amount_fils` keeps its meaning: what the customer handed over. `change_given_fils` is what was
-- handed back. They are separate columns and not one net figure, which is the whole of the acceptance
-- line "change given is recorded separately rather than netted into the payment": a drawer counted at
-- the end of the day is reconciled against the notes that went in and the notes that came out, and a
-- single net figure reconciles against neither.
--
-- `applied_fils` is GENERATED, `amount_fils - change_given_fils`, and stored. It is the one place the
-- netting happens, so the settlement view and the overpayment ceiling below read a column rather than
-- each repeating a subtraction. Generated for `appointment.holds_resources`'s reason (0024): a figure
-- every reader needs and nobody may set independently.
--
-- ## 3. `refund` — and the one column that has no foreign key yet
--
-- `credit_note_id` is NOT NULL. A refund from an invoice alone is money leaving the business with no
-- document behind it, and "an issued invoice is never edited or voided; a correction is a credit note"
-- (docs/04 §4) is only true if the refund path cannot be used to undo a sale. There is deliberately no
-- FOREIGN KEY: `credit_note` is M-TILL-08's table and does not exist yet. So the column is the
-- REQUIREMENT, enforced now, and the referential half — that the id names a real credit note, for this
-- invoice, whose value covers the refund — is M-TILL-08's to add. Stated here and in the manifest
-- rather than left to be discovered.
--
-- A refund is a NEW row with its own `trading_date`, never an edit of a `payment`. 0063 revoked UPDATE
-- and DELETE on `payment` for the application role for exactly this reason, and the same revocation is
-- made here: the refund's posting is a new journal entry, never an edit of the sale's.
--
-- ## 4. The two ceilings, as DEFERRED constraint triggers
--
-- Both are row-level facts about a TOTAL, so neither can be a CHECK. They are deferred to COMMIT for
-- the reason `0018_ledger.sql`'s balance trigger and `0026_invoice.sql`'s totals trigger are: the rows
-- that make the sum correct are written one statement at a time inside one transaction, and a trigger
-- that fired per statement would refuse the second tender of a two-tender checkout before the first was
-- finished being paid for. It is also what makes the CHECKOUT path work at all — see the gratuity note.
--
--   - `ZT001` Overpayment. The sum of `applied_fils` against a document may not exceed what the
--     document is payable for. That is `invoice.gross_total` PLUS the gratuity the document's own
--     posting collected: a tip is not consideration for a supply, so it appears on no tax invoice and
--     is therefore absent from `gross_total`, and the customer still handed it over. Taking the
--     gratuity from the invoice's own journal entry — the credit to `2040` — rather than from a second
--     column is the same decision as reading `booking_id` off the stored invoice row (0063): a figure
--     carried twice is a figure that can disagree. Without it every tipped checkout would be an
--     overpayment, because M-TILL-06's tenders sum to the basket's gross INCLUDING the tip.
--
--   - `ZT004` RefundExceedsPayments. The sum of refunds against a document may not exceed the sum
--     applied to it. Refunding money that was never taken is not a correction of anything.
--
-- `ZT002` and `ZT003` are the two per-row rules that need the registry: change on a type that gives
-- none, and a missing reference on a type that requires one. Immediate rather than deferred, because
-- both are properties of the row in hand and a caller reading the failure wants the row named.
--
-- ## 5. `invoice_settlement` — a view, not a stored balance
--
-- What an invoice has been paid is the SUM of its payments, and `leave_balance` (0066) settled the
-- shape this takes: "a leave balance is the figure in an HR system most often corrected
-- retrospectively, and a stored one disagrees with the movements the first time a month is
-- re-accrued". An outstanding receivable is the same figure on the money side. So there is no
-- `invoice.paid_total` column to drift, and `outstanding_fils` is `payable_fils - applied_fils` —
-- exactly the quantity `ZT001` refuses to let go negative, so the view and the ceiling cannot disagree
-- about whether a payment is allowed.
--
-- Refunds are reported BESIDE it and not subtracted from it. A refund follows a credit note, and a
-- credit note reduces the document's value — so the honest outstanding figure after one is
-- `gross - credited - paid + refunded`, and `credited` is M-TILL-08's. Subtracting refunds alone would
-- state a receivable for a supply that had been credited in full.
--
-- ## What is deliberately NOT here
--
-- No `payment.status` and no authorisation/capture state machine. The manual adapter takes money at the
-- till: authorising and capturing are one act, and a two-state column whose second value nothing ever
-- writes is a column that reads as "not captured yet" for every cash sale ever made. The gateway's
-- authorisation lifecycle is Y-PAY's, and `tender_type.adapter` is where it attaches.
--
-- No change to `checkout_finalisation`, and no partial tender at CHECKOUT. `TendersDoNotCoverBasket` in
-- core still refuses one, and the manifest NOTE on M-TILL-07 says why: relaxing it changes the entry
-- M-TILL-06's one transaction posts, and the receivable a partial checkout would raise has to be
-- debited by whoever issues the document. What this migration provides is the mechanism — a document
-- may be partly paid, and the outstanding figure is exact to the fils — against an invoice that was
-- issued unpaid.
begin;

-- ------------------------------------------------------------------------------------------------
-- tender_type — the registry
-- ------------------------------------------------------------------------------------------------

create table tender_type (
  -- The code `payment.tender_kind` and `refund.tender_kind` carry. Lower snake case, so a display
  -- label change cannot silently become a new tender type.
  code                 text        primary key
                         constraint tender_type_code_is_snake_case
                         check (code ~ '^[a-z][a-z0-9_]*$'),
  label                text        not null
                         constraint tender_type_label_nonempty check (btrim(label) <> ''),
  -- Where a tender of this type is debited. What `payment.posting_account_code` is snapshotted FROM,
  -- and never joined to at report time: re-mapping card_in_salon from 1040 to 1020 in two years must
  -- not restate a posting already filed.
  posting_account_code text        not null references account (code),
  -- Cash only. A card is authorised for an amount and a transfer arrives for an amount; a surplus in
  -- either is a mis-keyed figure, and handing back "change" for one would take real money out of the
  -- drawer against money that was never over-paid.
  gives_change         boolean     not null,
  -- The terminal's approval code or the transfer reference. 0063 could refuse a blank one and had no
  -- way to refuse a missing one, so a disputed card payment with nothing to settle it was storable.
  requires_reference   boolean     not null,
  -- Cash is in the drawer now; a card batch and a bank transfer arrive later, which is why
  -- card_in_salon debits 1040 and not 1020.
  settles_immediately  boolean     not null,
  -- Which adapter owns this type. All three are `manual` today, which is the honest answer: the
  -- gateway does not exist. This is the column Y-PAY's types will differ on.
  adapter              text        not null
                         constraint tender_type_adapter_known
                         check (adapter in ('manual', 'gateway')),
  -- The order a till offers them in. Unique, so two types cannot occupy one position and leave the
  -- order to whatever the planner returned.
  sort_order           smallint    not null
                         constraint tender_type_sort_order_positive check (sort_order >= 1)
                         constraint tender_type_one_row_per_position unique,
  -- Retired rather than deleted: `payment.tender_kind` references this table, and a type that once
  -- took money has rows that must keep resolving. NULL means available.
  retired_at           timestamptz,
  created_at           timestamptz not null default now(),
  -- Change cannot be handed back out of money that has not arrived.
  constraint tender_type_change_needs_immediate_settlement
    check (not gives_change or settles_immediately)
);

comment on table tender_type is
  'Every way the business takes money, with the account each one is debited to. The registry '
  '0063''s `payment_tender_kind_known` CHECK became a foreign key into. Held equal to TENDER_ACCOUNT '
  'in @berelax/core by packages/fixtures/src/payment.itest.ts, because packages/db may not import '
  'packages/core and a snapshot has to be taken from something.';
comment on column tender_type.posting_account_code is
  'Where a tender of this type is debited. Snapshotted onto payment.posting_account_code at the time '
  'the money is taken and never joined to afterwards: re-mapping a type must not restate a posting '
  'already filed.';
comment on column tender_type.gives_change is
  'Cash only. A surplus on a card or a transfer is a mis-keyed amount, and paying change against one '
  'would take money out of the drawer that nobody over-paid.';
comment on column tender_type.retired_at is
  'Set rather than deleting the row: payment.tender_kind references it, and a type that once took '
  'money must keep resolving for every document it settled.';

insert into tender_type (
  code, label, posting_account_code, gives_change, requires_reference, settles_immediately,
  adapter, sort_order
) values
  -- 1010 Cash in drawer. The only type that gives change, and the only one with no reference: there
  -- is none, and an empty string reads as one that was not captured (0063).
  ('cash', 'Cash', '1010', true, false, true, 'manual', 1),
  -- 1040 Card terminal clearing and NOT the bank: the terminal settles in a batch, net of fees, days
  -- later, and debiting 1020 would leave the bank reconciliation out by every unsettled batch.
  ('card_in_salon', 'Card — in-salon terminal', '1040', false, true, false, 'manual', 2),
  -- 1020 Bank current. A transfer that has landed IS in the account.
  ('bank_transfer', 'Bank transfer', '1020', false, true, false, 'manual', 3);

-- ------------------------------------------------------------------------------------------------
-- payment — the registry foreign key, and the two columns an over-tender needs
-- ------------------------------------------------------------------------------------------------

-- The CHECK becomes a FOREIGN KEY, which is what M-TILL-06's NOTE deferred here. It keeps the NAME
-- `payment_tender_kind_known` on purpose: the name is the contract that lets a caller — and the gate
-- probe in scripts/test-gates.mjs that has asserted on it since 0063 — tell "that is not a tender type
-- we take" from every other refusal in the same transaction. A constraint cannot be both a CHECK and a
-- foreign key, so it is dropped and re-added rather than renamed.
alter table payment drop constraint payment_tender_kind_known;
alter table payment add constraint payment_tender_kind_known
  foreign key (tender_kind) references tender_type (code);

alter table payment
  -- What was handed back. Separate from amount_fils, never netted into it: a counted drawer is
  -- reconciled against what went in and what came out, and one net figure reconciles against neither.
  add column change_given_fils fils_nonneg not null default 0,
  -- What this tender actually settled. The one place the netting happens, so the settlement view and
  -- the overpayment ceiling read a column instead of each repeating the subtraction.
  --
  -- `fils` and NOT `fils_nonneg`, which is the opposite of what it looks like it should be. A generated
  -- column's DOMAIN is checked before the table's CHECK constraints, so with `fils_nonneg` here a
  -- change of 101 against a tender of 100 was refused by `fils_nonneg_check` — a message naming no
  -- constraint a caller could recognise, and the named rule below never fired at all. Measured, not
  -- reasoned: the probe in manual-payment.itest.ts read `value for domain fils_nonneg violates check
  -- constraint "fils_nonneg_check"`. So the domain is the permissive one and
  -- `payment_change_not_more_than_tendered` is the authority, by name.
  add column applied_fils fils
    generated always as (amount_fils - change_given_fils) stored;

alter table payment
  -- Change may not exceed what was handed over, and this is the constraint that says so — see the
  -- note on `applied_fils` for why it is not left to a domain.
  add constraint payment_change_not_more_than_tendered
    check (change_given_fils <= amount_fils);

comment on column payment.change_given_fils is
  'What was handed back to the customer out of this tender. Recorded separately and never netted into '
  'amount_fils: a drawer is counted against the notes that went in and the notes that came out.';
comment on column payment.applied_fils is
  'What this tender settled: amount_fils - change_given_fils, generated. The single place the netting '
  'happens, so the settlement view and the ZT001 ceiling cannot each subtract differently.';

-- ------------------------------------------------------------------------------------------------
-- refund — money going back, with the document that authorises it
-- ------------------------------------------------------------------------------------------------

create table refund (
  id                   uuid        primary key default uuid_generate_v7(),
  invoice_id           uuid        not null references invoice (id),
  -- MANDATORY. A refund from an invoice alone is money leaving with no document behind it, and it is
  -- how "an issued invoice is never edited or voided" stops being true. NO foreign key yet:
  -- `credit_note` is M-TILL-08's table. The requirement is enforced now; the reference is M-TILL-08's.
  credit_note_id       uuid        not null,
  -- Position within the document's refunds, so two reads list them in the same order (0063's reason
  -- for payment.tender_no).
  refund_no            smallint    not null,
  -- The form the money went back in, from the same registry the tenders come from.
  tender_kind          text        not null
                         constraint refund_tender_kind_known
                         references tender_type (code),
  -- Snapshotted for payment.posting_account_code's reason. A refund's posting is a NEW entry crediting
  -- this account, never an edit of the sale's debit to it.
  posting_account_code text        not null references account (code),
  amount_fils          fils_nonneg not null
                         constraint refund_amount_positive check (amount_fils > 0),
  reference            text
                         constraint refund_reference_nonempty
                         check (reference is null or btrim(reference) <> ''),
  -- The BUSINESS DAY the money went back, resolved by the caller. Trading runs 11:00-02:00, so a
  -- 01:30 refund belongs to the previous trading date and the cash-up that reconciles it cuts here.
  trading_date         date        not null,
  refunded_at          timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  constraint refund_no_positive check (refund_no >= 1),
  constraint refund_one_row_per_number unique (invoice_id, refund_no)
);

comment on table refund is
  'Money returned against an issued document, with the credit note that authorises it. A new row with '
  'its own trading_date, never an edit of a payment - and its posting is a new journal entry, never an '
  'edit of the sale''s. credit_note_id carries no foreign key yet because credit_note is M-TILL-08''s '
  'table; the NOT NULL is the half that can be enforced today.';
comment on column refund.credit_note_id is
  'The credit note that authorises this refund. NOT NULL, because a refund from an invoice alone is '
  'money leaving the business with no document behind it. M-TILL-08 adds the foreign key and the '
  'check that the note is for THIS invoice and covers the amount.';

create index refund_invoice_idx on refund (invoice_id);
create index refund_trading_date_idx on refund (trading_date, tender_kind);
create index refund_credit_note_idx on refund (credit_note_id);

-- ------------------------------------------------------------------------------------------------
-- The account a gratuity is collected in, stated once
-- ------------------------------------------------------------------------------------------------

-- `2040 Gratuities payable` appears in exactly one place in SQL, so the pair with
-- `ACCOUNTS.tipsPayable` in @berelax/core can be asserted in one assertion rather than wherever the
-- literal happened to be typed. packages/fixtures/src/payment.itest.ts makes that assertion, with a
-- control proving it would notice a disagreement.
create or replace function tips_payable_account_code() returns text
  language sql immutable parallel safe
  as $$ select '2040'::text $$;

comment on function tips_payable_account_code() is
  'The account a gratuity is credited to, stated once so the ZT001 ceiling and @berelax/core''s '
  'ACCOUNTS.tipsPayable can be compared in one place (packages/fixtures/src/payment.itest.ts).';

-- ------------------------------------------------------------------------------------------------
-- ZT002 / ZT003 — the two per-row rules that need the registry
-- ------------------------------------------------------------------------------------------------

-- One function for both tables, because the rules are properties of the TENDER TYPE and both tables
-- carry one. `change_given_fils` exists only on `payment`, so it is read through `to_jsonb(new)` rather
-- than as a field: naming a column plpgsql cannot resolve on the other table would make the trigger
-- raise for every refund, and two near-identical functions is the shape in which one of them silently
-- stops being kept in step with the other.
create or replace function tender_row_matches_its_type() returns trigger
  language plpgsql as $$
declare
  v_gives_change       boolean;
  v_requires_reference boolean;
  v_change             bigint;
begin
  select gives_change, requires_reference
    into v_gives_change, v_requires_reference
    from tender_type where code = new.tender_kind;

  if v_gives_change is null then
    -- No registry row, so there are no rules to apply. The row is returned rather than refused HERE,
    -- and the foreign key refuses it a moment later by name — `payment_tender_kind_known` for a
    -- payment, `refund_tender_kind_known` for a refund. Raising here instead would mean a caller, and
    -- the gate probe that has asserted on that name since 0063, saw a plpgsql message in place of the
    -- constraint. Nothing is waved through: every rule below reads a column of a row that must exist.
    return new;
  end if;

  v_change := coalesce((to_jsonb(new) ->> 'change_given_fils')::bigint, 0);
  if v_change > 0 and not v_gives_change then
    raise exception
      'ChangeOnATenderThatGivesNone: % fils of change against a "%" tender. A card is authorised for '
      'an amount and a transfer arrives for an amount; a surplus on either is a mis-keyed figure, and '
      'paying change against one takes money out of the drawer that nobody over-paid.',
      v_change, new.tender_kind using errcode = 'ZT002';
  end if;

  if v_requires_reference and new.reference is null then
    raise exception
      'TenderReferenceRequired: a "%" tender on % carries no reference. It is the field a disputed '
      'card payment is settled with, and 0063 could only refuse a blank one.',
      new.tender_kind, tg_table_name using errcode = 'ZT003';
  end if;

  return new;
end $$;

comment on function tender_row_matches_its_type() is
  'Raises ZT002 for change against a tender type that gives none and ZT003 for a missing reference on '
  'a type that requires one. Immediate rather than deferred: both are properties of the row in hand, '
  'and a caller reading the failure wants that row named. Shared by payment and refund, reading '
  'change_given_fils through to_jsonb because only one of the two has it.';

create trigger payment_matches_its_tender_type
  before insert on payment
  for each row execute function tender_row_matches_its_type();

create trigger refund_matches_its_tender_type
  before insert on refund
  for each row execute function tender_row_matches_its_type();

-- ------------------------------------------------------------------------------------------------
-- ZT001 — payments may not exceed the document and the gratuity it collected
-- ------------------------------------------------------------------------------------------------

create or replace function invoice_payable_fils(p_invoice uuid) returns bigint
  language sql stable as $$
  select coalesce(i.gross_total, 0)::bigint + coalesce((
           -- The gratuity THIS document's own posting collected. A tip is not consideration for a
           -- supply, so it is on no tax invoice and absent from gross_total - and the customer handed
           -- it over all the same, which is why M-TILL-06's tenders sum to the basket including it.
           -- Read from the entry rather than carried in a second column, so the two cannot disagree.
           select sum(jl.credit_fils - jl.debit_fils)
             from checkout_finalisation cf
             join journal_line jl on jl.entry_id = cf.journal_entry_id
            where cf.invoice_id = p_invoice
              and jl.account_code = tips_payable_account_code()
         ), 0)::bigint
    from invoice i where i.id = p_invoice
$$;

comment on function invoice_payable_fils(uuid) is
  'What a document may be paid in total: its gross plus the gratuity its own journal entry collected. '
  'The gratuity is on no tax invoice (it is not consideration for a supply) and was still handed over, '
  'so a ceiling of gross_total alone would make every tipped checkout an overpayment.';

create or replace function payment_within_the_document() returns trigger
  language plpgsql as $$
declare
  v_payable bigint;
  v_applied bigint;
begin
  v_payable := invoice_payable_fils(new.invoice_id);
  select coalesce(sum(applied_fils), 0) into v_applied
    from payment where invoice_id = new.invoice_id;

  if v_applied > v_payable then
    raise exception
      'Overpayment: invoice % has % fils applied against a payable total of % fils. A payment that '
      'takes a document above what it is payable for is a mis-keyed amount or a second tap, and the '
      'answer to a genuine over-collection is change (recorded on the tender) or a credit note.',
      new.invoice_id, v_applied, v_payable using errcode = 'ZT001';
  end if;

  return null;
end $$;

comment on function payment_within_the_document() is
  'Raises ZT001 when the payments applied to a document exceed what it is payable for. DEFERRED, '
  'because the tenders of one checkout are inserted a statement at a time inside one transaction and '
  'a per-statement check would refuse the second tender before the first had finished paying.';

create constraint trigger payment_not_more_than_the_document
  after insert on payment
  deferrable initially deferred
  for each row execute function payment_within_the_document();

-- ------------------------------------------------------------------------------------------------
-- ZT004 — refunds may not exceed what was paid
-- ------------------------------------------------------------------------------------------------

create or replace function refund_within_the_payments() returns trigger
  language plpgsql as $$
declare
  v_applied  bigint;
  v_refunded bigint;
begin
  select coalesce(sum(applied_fils), 0) into v_applied
    from payment where invoice_id = new.invoice_id;
  select coalesce(sum(amount_fils), 0) into v_refunded
    from refund where invoice_id = new.invoice_id;

  if v_refunded > v_applied then
    raise exception
      'RefundExceedsPayments: invoice % has % fils refunded against % fils applied. Refunding money '
      'that was never taken is not a correction of anything.',
      new.invoice_id, v_refunded, v_applied using errcode = 'ZT004';
  end if;

  return null;
end $$;

comment on function refund_within_the_payments() is
  'Raises ZT004 when the refunds against a document exceed what was applied to it. DEFERRED for '
  'ZT001''s reason: a refund split across two tender forms is two statements in one transaction.';

create constraint trigger refund_not_more_than_was_paid
  after insert on refund
  deferrable initially deferred
  for each row execute function refund_within_the_payments();

-- ------------------------------------------------------------------------------------------------
-- invoice_settlement — what a document has been paid, as a view
-- ------------------------------------------------------------------------------------------------

create view invoice_settlement as
  select
    i.id                                        as invoice_id,
    i.display_number,
    i.gross_total::bigint                       as gross_fils,
    invoice_payable_fils(i.id)                  as payable_fils,
    coalesce(p.tendered_fils, 0)                as tendered_fils,
    coalesce(p.change_given_fils, 0)            as change_given_fils,
    coalesce(p.applied_fils, 0)                 as applied_fils,
    coalesce(r.refunded_fils, 0)                as refunded_fils,
    -- Exactly the quantity ZT001 refuses to let go negative, so the view and the ceiling cannot
    -- disagree about whether one more payment is allowed. Refunds are reported beside it rather than
    -- subtracted: a refund follows a credit note, and the credited amount is M-TILL-08's.
    invoice_payable_fils(i.id) - coalesce(p.applied_fils, 0) as outstanding_fils
  from invoice i
  left join (
    select invoice_id,
           sum(amount_fils)::bigint       as tendered_fils,
           sum(change_given_fils)::bigint as change_given_fils,
           sum(applied_fils)::bigint      as applied_fils
      from payment group by invoice_id
  ) p on p.invoice_id = i.id
  left join (
    select invoice_id, sum(amount_fils)::bigint as refunded_fils
      from refund group by invoice_id
  ) r on r.invoice_id = i.id;

comment on view invoice_settlement is
  'What each document has been tendered, given back as change, applied, refunded and still owes. A '
  'VIEW and not a stored balance, for the reason leave_balance is one (0066): a stored figure '
  'disagrees with the movements the first time one is corrected. There is no invoice.paid_total.';

-- ------------------------------------------------------------------------------------------------
-- Privileges
-- ------------------------------------------------------------------------------------------------
-- 0009 sets default privileges so a later table arrives with select/insert/update/delete for the
-- application role. Stated explicitly rather than relied upon, because a managed database restored
-- from a dump does not necessarily carry the same defaults - and a till that cannot INSERT fails in
-- front of a customer.
grant select, insert on refund to berelax_app;
grant select on tender_type, invoice_settlement to berelax_app;

-- A refund is not corrected in place, for 0063's reason about `payment`: the amount that was
-- reconciled to a drawer must not change after the drawer was counted. A mis-keyed refund is answered
-- by another row with its own date.
revoke update, delete on refund from berelax_app;
revoke truncate on refund from berelax_app;

-- The registry is configuration, not a request's to write. Adding a tender type is a migration: it
-- needs a posting account chosen by somebody who knows what a clearing account is for, and
-- `tender_type_change_needs_immediate_settlement` is not a decision to leave to a form.
revoke insert, update, delete, truncate on tender_type from berelax_app;

commit;
