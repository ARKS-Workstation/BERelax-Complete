-- 0063 — checkout finalisation: the three rows that make a till sale one fact, and the two
--        constraints that make "twice" impossible rather than unlikely.
--
-- M-TILL-06 writes an invoice, a balanced journal entry and the tenders in ONE transaction. The
-- transaction is what makes them all-or-none; this migration is what makes the *second* attempt
-- impossible, and it does that with keys the database refuses rather than with checks a repository
-- performs. A repository check is a read followed by a write, and the gap between them is exactly
-- where the double tap lands.
--
-- ## 1. `checkout_finalisation` — one idempotency key, one finalised checkout
--
-- The key is supplied by the CALLER (the till's request id), which is the whole point: a value the
-- database generated could not deduplicate a retry of the same request, because the retry would
-- generate a second one. The primary key on it is where two concurrent finalisations serialise —
-- the second INSERT blocks on the index until the first commits (then it is refused by
-- `checkout_finalisation_key_pk`) or rolls back (then it succeeds and gets a fresh attempt). That is
-- `booking_idempotency`'s mechanism (0024) applied to the till, and it is the reason the row is
-- written inside the checkout's own transaction: a claim that outlived a rolled-back checkout would
-- be a permanent refusal of a sale that never happened.
--
-- `request_fingerprint` is 0024's second column and for 0024's reason. Replaying a key with a
-- DIFFERENT basket is a bug in the caller, not a retry, and it has to be told apart from one:
-- without it the second request is handed an invoice for somebody else's basket and reads it as
-- success.
--
-- UNIQUE on `invoice_id` and on `journal_entry_id` as well, and neither is decoration. They are what
-- makes "one invoice and one journal entry per finalisation" a property of the schema rather than of
-- the code that filled it in, and they are the constraint a *second* finalisation of the same
-- checkout would trip even if it somehow arrived with a different key.
--
-- ## 2. `invoice_appointment` — an appointment is billed once, ever
--
-- This is the wiring M-TILL-04's NOTE deferred: "There is no link from invoice_line to a sale, an
-- appointment or a service_variant ... M-TILL-06 owns that wiring." It is a separate table and not a
-- column on `invoice_line` for one reason: the constraint that matters is UNIQUE on the
-- **appointment**, and a nullable column on `invoice_line` could not carry it without also claiming
-- that every invoice line is an appointment — which a retail line, a package sale and a rounding
-- adjustment are not.
--
-- `appointment_id` is a plain `uuid` with NO foreign key, which is 0055's decision, 0058's, 0021's
-- for `agent_run.job_id` and 0024's for `appointment.therapist_id`: PostgreSQL refuses `truncate
-- appointment` while a referencing table is missing from the statement, and four integration suites
-- truncate it by an explicit list. A foreign key here would break all four, and the failure would
-- surface as somebody else's suite going red on a table this unit never touched.
--
-- It also means the link survives an appointment's deletion, which is the correct direction: the
-- invoice is a statutory document and the appointment it billed is a detail of the diary. The trade
-- is real and stated — the link can be orphaned — and `invoice_appointment_appointment_once` is
-- still what stops a second bill, because it constrains the id and not the row.
--
-- ## 3. `payment` — the tenders
--
-- Created here because this unit's first acceptance line names it: aborting the finalisation must
-- leave zero rows in `invoice`, `invoice_line`, `journal_entry`, `journal_line` **and `payment`**.
-- Deliberately minimal. M-TILL-07 owns the tender-type REGISTRY (a table, with a declared posting
-- account per type, replacing the CHECK below with a foreign key), refunds, over-tender change and
-- the adapter interface; it depends on this unit, and extending one table is the alternative to two
-- tables both recording money received. See the NOTE on M-TILL-06 in build/manifest.yaml.
--
-- `posting_account_code` is SNAPSHOTTED onto the row rather than looked up from the tender type at
-- report time, for the reason every other money column in this schema is snapshotted: re-mapping
-- `card_in_salon` from 1040 to 1020 in two years must not restate a posting already filed. The
-- account is `TENDER_ACCOUNT` in packages/core/src/checkout/posting.ts, and the pair is asserted
-- together in packages/fixtures.
--
-- ## 4. `invoice.booking_id`
--
-- The other half of M-TILL-04's deferred wiring, and the column the `invoice.issued` event needs:
-- the acceptance asks for an event "carrying booking_id and customer_id", and an id carried on an
-- event but stored nowhere is a fact with no record. `customer_id` was already on `invoice` (0026).
--
-- No foreign key, for the same reason `invoice_appointment.appointment_id` has none: the suites that
-- truncate `appointment` truncate `booking` in the same statement.
--
-- `finaliseCheckout` DERIVES this from the appointments it is billing rather than accepting it as an
-- argument, and refuses a checkout whose appointments span two bookings. So the two links cannot
-- disagree: one is computed from the other inside the transaction that writes both.
--
-- ## What is deliberately NOT here
--
-- No `billed` appointment status. `appointment_status` is B-LIFE-01's nine states and
-- `appointment.holds_resources` is GENERATED from it (0024), so a tenth label would change what
-- holds a room; and `emitsRevenue` in `packages/core/src/lifecycle/transitions.ts` is declared by
-- exactly one status. "Billed" is therefore a DERIVED fact — the existence of an
-- `invoice_appointment` row — and there is no second column that could disagree with it. The
-- acceptance line this satisfies is the one that asserts the status is UNCHANGED by a failed
-- finalisation.
--
-- No re-statement of the balance rule, the totals rule or the period lock. 0018 and 0026 already
-- enforce all three, on the tables this unit writes to, and a third statement of one rule is a
-- second opportunity to disagree.
begin;

-- ------------------------------------------------------------------------------------------------
-- invoice.booking_id — the sale this document bills
-- ------------------------------------------------------------------------------------------------

alter table invoice
  -- No foreign key: four integration suites `truncate appointment, booking` by an explicit list and
  -- PostgreSQL refuses a truncate while a referencing table is absent from it (0055, 0058).
  add column booking_id uuid;

comment on column invoice.booking_id is
  'The booking this document bills, or NULL for a document raised outside a checkout (an opening '
  'adjustment, a retail-only sale). The wiring M-TILL-04''s NOTE deferred. No foreign key on '
  'purpose: the suites that truncate `appointment` truncate `booking` in the same statement. '
  'finaliseCheckout DERIVES it from the appointments being billed, so it cannot disagree with '
  'invoice_appointment.';

create index invoice_booking_idx on invoice (booking_id) where booking_id is not null;

-- ------------------------------------------------------------------------------------------------
-- invoice_appointment — one appointment, one invoice, ever
-- ------------------------------------------------------------------------------------------------

create table invoice_appointment (
  invoice_id     uuid        not null references invoice (id),
  -- Plain uuid, NO foreign key. See this migration's header: `truncate appointment` would break.
  appointment_id uuid        not null,
  -- Which line of the document billed it. Not a foreign key to `invoice_line` either, and that is a
  -- narrower point: the composite (invoice_id, line_no) IS available, but a redemption line bills an
  -- appointment that appears on NO invoice line at all (its gross is zero and the document does not
  -- state it), so the reference would have to be nullable and a nullable reference to a line is not
  -- the fact this table exists to record.
  line_no        smallint,
  created_at     timestamptz not null default now(),
  -- THE constraint. An appointment is billed once and the refusal is by name, so a caller can tell
  -- "already billed" from any other unique violation in the same transaction.
  constraint invoice_appointment_appointment_once unique (appointment_id),
  constraint invoice_appointment_pk primary key (invoice_id, appointment_id),
  constraint invoice_appointment_line_no_positive check (line_no is null or line_no >= 1)
);

comment on table invoice_appointment is
  'Which appointments an issued document billed. UNIQUE on appointment_id is what makes billing the '
  'same treatment twice impossible rather than unlikely - a repository check is a read followed by '
  'a write, and the double tap lands in the gap. "Billed" is this row existing; there is no '
  'appointment status for it, because holds_resources is GENERATED from that enum (0024).';
comment on column invoice_appointment.appointment_id is
  'No foreign key, deliberately: PostgreSQL refuses `truncate appointment` while a referencing table '
  'is absent from the statement and four suites truncate it by list (0055, 0058, 0021, 0024). The '
  'link may therefore be orphaned, which is the right direction - the document is statutory and the '
  'diary row is not - and the UNIQUE still bites, because it constrains the id.';

create index invoice_appointment_invoice_idx on invoice_appointment (invoice_id);

-- ------------------------------------------------------------------------------------------------
-- payment — what was tendered
-- ------------------------------------------------------------------------------------------------

create table payment (
  id                   uuid        primary key default uuid_generate_v7(),
  invoice_id           uuid        not null references invoice (id),
  -- Position within the checkout, so two reads of one sale list the tenders in the same order. An
  -- insertion-ordered list reorders the moment a query plan changes.
  tender_no            smallint    not null,
  -- The CHECK is M-TILL-07's to replace with a foreign key into its tender-type registry. A CHECK
  -- rather than an enum type: adding a tender type must not require ALTER TYPE inside a transaction
  -- that also writes rows.
  tender_kind          text        not null
                         constraint payment_tender_kind_known
                         check (tender_kind in ('cash', 'card_in_salon', 'bank_transfer')),
  -- Snapshotted from TENDER_ACCOUNT in @berelax/core, not looked up later: re-mapping a tender type
  -- must not restate a posting already filed.
  posting_account_code text        not null references account (code),
  -- Integer fils, and strictly positive. A zero tender is a payment somebody started and did not
  -- fill in; a negative one is a refund, which is a different document (M-TILL-08) and a different
  -- posting, and `fils_nonneg` alone would accept the zero.
  amount_fils          fils_nonneg not null
                         constraint payment_amount_positive check (amount_fils > 0),
  -- The terminal's approval code or the transfer reference. NULL for cash, which has none - absent
  -- rather than blank, because an empty string reads as a reference that was not captured.
  reference            text
                         constraint payment_reference_nonempty
                         check (reference is null or btrim(reference) <> ''),
  -- The BUSINESS DAY the money was taken on, resolved by the caller. Trading runs 11:00-02:00, so a
  -- 01:30 payment belongs to the previous trading date and the cash-up that reconciles it (M-TILL-11)
  -- cuts on this column. A date truncated from `received_at` would move it to the next day's drawer.
  trading_date         date        not null,
  received_at          timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  constraint payment_tender_no_positive check (tender_no >= 1),
  constraint payment_one_row_per_tender unique (invoice_id, tender_no)
);

comment on table payment is
  'What was tendered against an issued document, written in the document''s own transaction. '
  'Deliberately minimal: M-TILL-07 owns the tender-type registry that replaces '
  'payment_tender_kind_known with a foreign key, plus refunds, over-tender change and the gateway '
  'adapter. One table for money received, extended - not a second table beside it.';
comment on column payment.posting_account_code is
  'Where this tender was debited, snapshotted. card_in_salon is 1040 Card terminal clearing and NOT '
  'the bank: the terminal settles in a batch, net of fees, days later, and debiting 1020 would leave '
  'the bank reconciliation permanently out by every unsettled batch.';
comment on column payment.trading_date is
  'The trading date, resolved with resolveTradingDate. Not truncated from received_at: 01:30 belongs '
  'to the previous trading date, and getting it wrong moves takings between cash-ups (ADR 0007).';

create index payment_invoice_idx on payment (invoice_id);
create index payment_trading_date_idx on payment (trading_date, tender_kind);

-- ------------------------------------------------------------------------------------------------
-- checkout_finalisation — the idempotency key, and the one row per finalised checkout
-- ------------------------------------------------------------------------------------------------

create table checkout_finalisation (
  -- Supplied by the CALLER. A value generated here could not deduplicate a retry, because the retry
  -- would generate a second one.
  idempotency_key     text        not null
                        constraint checkout_finalisation_key_nonempty
                        check (btrim(idempotency_key) <> ''),
  -- A hash of the basket that claimed the key. Replaying a key with a different basket is a caller
  -- bug, not a retry, and handing back the first invoice would look like success (0024's argument).
  request_fingerprint text        not null
                        constraint checkout_finalisation_fingerprint_nonempty
                        check (btrim(request_fingerprint) <> ''),
  basket_id           text        not null
                        constraint checkout_finalisation_basket_nonempty
                        check (btrim(basket_id) <> ''),
  -- One invoice and one journal entry per finalisation, as SCHEMA rather than as a promise about the
  -- code that filled the row in.
  invoice_id          uuid        not null
                        constraint checkout_finalisation_one_invoice unique
                        references invoice (id),
  journal_entry_id    text        not null
                        constraint checkout_finalisation_one_entry unique
                        references journal_entry (entry_id),
  -- The booking and the customer the events carry, so `payment.recorded` reads them from a row
  -- rather than from the request that is already over. No foreign keys: see the header.
  booking_id          uuid,
  customer_id         uuid,
  -- The trading date the checkout was finalised on, and the date the entry is dated. Carried so the
  -- day's takings can be reconciled without joining through three tables.
  trading_date        date        not null,
  tender_total_fils   fils_nonneg not null
                        constraint checkout_finalisation_tender_total_positive
                        check (tender_total_fils > 0),
  finalised_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  -- Where two concurrent finalisations of one checkout serialise. Named explicitly rather than left
  -- as `checkout_finalisation_pkey`, because the test that proves idempotency asserts the refusal BY
  -- CONSTRAINT NAME: a second call that merely returned early would be lucky, not idempotent.
  constraint checkout_finalisation_key_pk primary key (idempotency_key)
);

comment on table checkout_finalisation is
  'Idempotency key -> the invoice, journal entry and tenders one checkout produced, written in the '
  'checkout''s OWN transaction so a rolled-back checkout releases its key and a genuine retry gets a '
  'fresh attempt. checkout_finalisation_key_pk is where two concurrent finalisations serialise: the '
  'second INSERT blocks on the index until the first commits or rolls back.';
comment on column checkout_finalisation.request_fingerprint is
  'A hash of the basket that claimed the key. A replay with a DIFFERENT basket is a caller bug, and '
  'returning the first invoice for it would be read as success.';

create index checkout_finalisation_trading_date_idx
  on checkout_finalisation (trading_date, finalised_at);
create index checkout_finalisation_booking_idx
  on checkout_finalisation (booking_id) where booking_id is not null;

-- ------------------------------------------------------------------------------------------------
-- Privileges
-- ------------------------------------------------------------------------------------------------
-- 0009 grants the application role select, insert, update and delete on every table created in
-- `public` afterwards, and sets default privileges so later tables arrive the same way. Stated
-- explicitly first rather than relied upon, because a managed database restored from a dump does not
-- necessarily carry the same defaults — and a till that cannot INSERT fails in front of a customer.
grant select, insert on invoice_appointment, payment, checkout_finalisation to berelax_app;

-- A tender is not corrected in place and a bill is not un-issued. An over-charge is answered by a
-- credit note (M-TILL-08) and a mis-keyed payment by a refund (M-TILL-07), both of which are new
-- rows with their own dates. UPDATE here would let the amount that was reconciled to a drawer change
-- after the drawer was counted, and DELETE would erase the claim that makes the idempotency key
-- work — which turns a resolved double tap back into two sales.
revoke update, delete on invoice_appointment, payment, checkout_finalisation from berelax_app;

-- TRUNCATE is the statement that slips past a row-level trigger, so it matters more than the rest.
-- 0009 grants by name and never granted it, which is not the same fact as "we checked".
revoke truncate on invoice_appointment, payment, checkout_finalisation from berelax_app;

-- `invoice.booking_id` needs no grant change: 0026 revoked UPDATE on `invoice` entirely, so the
-- column is write-once through the INSERT like every other column on that table.
--
-- Deliberately NO refusal TRIGGER on these three tables, unlike `journal_entry` and `invoice`. The
-- difference is what the row IS. A journal line and an invoice are history, and a trigger that fires
-- for the owner too is what makes them so. These three are records ABOUT a checkout whose history is
-- the invoice and the journal entry: a mis-typed tender reference has to be correctable by a
-- migration without somebody dropping a trigger first, and dropping a trigger to fix a typo is how
-- the trigger ends up dropped. That is 0018's reasoning for `account` and `period_lock`, applied to
-- the same distinction. The application role — the only path a request can take — holds neither
-- UPDATE nor DELETE, which is the layer that matters.

commit;
