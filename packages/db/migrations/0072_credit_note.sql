-- 0072 — the credit note: the ONLY way an issued document is corrected, and the document a refund
--        has to name.
--
-- 0026 created `invoice` append-only and said in its own comment what the correction path is: "A
-- correction is a credit note, never an edit (docs/04 SS4)." 0013 already allocated the CR-NOTE series
-- and stated why it is a separate counter — "a shared counter would make the credit-note range depend
-- on invoice volume, so 'CN-00042' would not be the forty-second credit note". 0068 created `refund`
-- with `credit_note_id NOT NULL` and no foreign key, because this table did not exist. So nothing here
-- re-argues that a credit note is a separate document with its own series; what it does is:
--
--   1. create `credit_note` and `credit_note_line`, with 0026's issuer-snapshot rules restated so a
--      correction carries the same statutory field set as the thing it corrects;
--   2. cap the CUMULATIVE credited quantity of an invoice line at what was invoiced, under a lock, so
--      two credit notes racing for the same line cannot both win;
--   3. refuse a note dated inside a locked period, naming the earliest date that is OPEN rather than
--      only the period that is shut;
--   4. give `refund.credit_note_id` its real foreign key, plus the two checks 0068 deferred here — the
--      note is for THIS invoice, and its value covers what went back.
--
-- What it does NOT do is lower the ceiling on what may be collected. See the last section.
--
-- SQLSTATE class 'ZD'. 'ZC' is 0029's (canonical paths and redirects) and a second meaning for one
-- class is how a caller comes to handle a redirect defect as a credit-note defect.
--
--
-- ## What a credit note does NOT reference, and why
--
-- `credit_note.invoice_id` is a plain uuid with NO foreign key, and `credit_note_line.invoice_line_no`
-- names a line of that invoice with no composite key either. Both are enforced instead by
-- `credit_note_corrects_a_real_invoice()` and `credit_note_line_within_the_invoiced_quantity()`, which
-- raise `ZD001` and `ZD004` by name at INSERT.
--
-- This is 0067's trade (`booking_manage_grant.booking_id`) made for a different reason, and the reason
-- is worth stating because a reader's first instinct here is that the key was forgotten. A foreign key
-- buys exactly one thing that an INSERT-time check does not: it keeps the reference true against a
-- later DELETE of the parent. `invoice` and `invoice_line` refuse DELETE for EVERY role including the
-- owner — `refuse_invoice_change()` raises ZI003 from a BEFORE DELETE trigger, not from a grant — so
-- there is no DELETE for the key to protect against. The one statement that removes an invoice row is
-- TRUNCATE by the owner, and that is precisely the statement the key would break: seven integration
-- suites across six units truncate the invoice family by an explicit list (PostgreSQL refuses a
-- truncate while a referencing table is missing from it), and `refund` arriving as the fourth
-- referencing table in 0068 turned all of them red at once. Paying that again for a reference that
-- protects against a statement the database already refuses is the wrong side of the trade.
--
-- The cost, stated so it is not discovered: a suite that truncates `invoice` without also truncating
-- `credit_note` leaves a note about a document that no longer exists. The suites this unit owns name
-- both, and a suite that wants the rows gone should name both.
--
-- `credit_note.journal_entry_id` DOES carry a real key to `journal_entry`, because nothing truncates
-- the journal and the reversal is the half of a credit note that has to be unreachable-if-absent.
--
--
-- ## The reversal is dated on the CREDIT NOTE's own date
--
-- `tax_point_date` is the date of the adjustment, and it is what the reversing entry is dated on. A
-- credit note raised in October for a September invoice posts its reversal in OCTOBER: September may
-- be filed, and restating a filed period is exactly what `period_lock` exists to prevent. That is not
-- enforceable from this table alone — the entry lives in `journal_entry` — so
-- `credit_note_reversal_is_dated_on_the_note()` holds the two equal, and it is the constraint that
-- makes "dated on the credit note's own date" a property of the schema rather than of the caller.
--
-- A credit note may not be dated BEFORE the supply it corrects (`ZD002`): a correction that appears in
-- a period the original never reached is a correction of nothing.
--
--
-- ## What a credit note does NOT change: what may still be collected
--
-- 0068 asked which of two figures is authoritative once a document has been credited — `ZT004`
-- (refunds capped at what was applied) or `invoice_settlement.outstanding_fils`. The answer here is
-- that BOTH of 0068's ceilings are left exactly as they are, and `invoice_payable_fils()` is not
-- touched.
--
-- The reason is the failure the alternative produces. `outstanding_fils` is defined as exactly the
-- quantity `ZT001` refuses to let go negative, which is what stops the view and the ceiling disagreeing
-- about whether one more payment is allowed. Subtracting the credited amount from that function would
-- lower the ceiling under payments that had ALREADY been applied — an invoice paid in full in September
-- and credited in full in October would read as an overpayment in a figure that is reconciled against a
-- counted drawer, and the cash in that drawer would stop being explainable by any row. Money that was
-- honestly taken is not un-taken by a document; it is owed back, which is a different fact with a
-- different account (`1050`, where 0068's payment and refund postings meet it) and, in this view, a
-- different column.
--
-- So `invoice_settlement` gains `credited_fils` and `receivable_fils` and keeps `outstanding_fils`
-- unchanged. A NEGATIVE `receivable_fils` is the honest reading of "we hold money we owe back".
--
-- See docs/04 SS4, docs/adr/0017 and 0013/0026/0068.

begin;

-- ------------------------------------------------------------------------------------------------
-- credit_note — the correcting document
-- ------------------------------------------------------------------------------------------------
create table credit_note (
  id                      uuid        primary key default uuid_generate_v7(),

  -- The document being corrected. No foreign key; see the header.
  invoice_id              uuid        not null,

  -- A constant column, and it exists for the composite foreign key below rather than to be read.
  -- 0026 added `document_series_code_kind_unique (code, document_kind)` so a tax invoice cannot be
  -- numbered out of the credit-note range; the same key pointed the other way is what stops a credit
  -- note being numbered out of TAX-INV. A generated column cannot participate in a foreign key, so it
  -- is an ordinary column pinned by a CHECK.
  document_kind           text        not null default 'credit_note'
                            constraint credit_note_document_kind_is_credit_note
                            check (document_kind = 'credit_note'),

  -- --- the statutory number, as allocate_document_number() handed it over ----------------------
  -- Stored, never re-derived, for 0026's reason: recomposing the string from the integer later would
  -- let an admin renaming a prefix renumber a note that has already been filed.
  series_code             text        not null,
  period_key              text        not null,
  number                  bigint      not null check (number >= 1),
  display_number          text        not null,

  -- --- the issuer snapshot, on 0026's rules ---------------------------------------------------
  -- Restated rather than joined to the invoice, and that is the decision a reader is most likely to
  -- think is duplication. A credit note is a document in its own right: it is issued on its own date,
  -- possibly after a relocation or a change of legal name, and it must print the issuer as it was
  -- THEN. Copying the invoice's snapshot would print September's address on an October document; a
  -- join to `legal_entity` would print today's on both.
  issuer_legal_name       text        not null,
  issuer_trading_name     text        not null,
  issuer_trn              text        not null,
  issuer_address_snapshot text        not null,
  issuer_emirate          text        not null,
  issuer_phone            text,
  issuer_licence_number   text,
  -- Nullable for 0026's reason and no other: `legal_entity` and `premises` carry no Arabic columns, so
  -- there is nothing to snapshot from. NOT NULL here would make every credit note unissuable.
  issuer_legal_name_ar    text,
  issuer_address_snapshot_ar text,

  -- --- the customer ---------------------------------------------------------------------------
  -- `on delete restrict` for 0026's two reasons: this table is append-only, so a cascading SET NULL is
  -- an UPDATE the refusal trigger would refuse anyway, and a five-year financial record outlives an
  -- erasure request.
  customer_id             uuid        references customer(id) on delete restrict,
  customer_name_snapshot  text        not null,
  customer_trn            text,
  customer_address_snapshot text,
  customer_phone          text,

  -- --- the dates ------------------------------------------------------------------------------
  -- The calendar date the note was written.
  issue_date              date        not null,
  -- The trading date it was issued on, for cash-up. NULLABLE for 0026's reason: a note raised by the
  -- accountant at 10:00 is written while the premises is shut and belongs to no trading date at all.
  issue_trading_date      date,
  -- The date of the ADJUSTMENT, and the date the reversal posts under. Not the invoice's tax point:
  -- see the header.
  tax_point_date          date        not null,
  issued_at               timestamptz not null default now(),

  -- --- the amounts, stated POSITIVE ------------------------------------------------------------
  -- A credit note's figures are what it takes OFF, held as positive fils in the `fils_nonneg` domain
  -- every other money column uses. The direction is the journal's — the reversal debits revenue — and
  -- a negative amount here would be a second way of saying the same thing, with two spellings of every
  -- report that sums it.
  currency                char(3)     not null default 'AED' check (currency = 'AED'),
  net_total               fils_nonneg not null,
  vat_total               fils_nonneg not null,
  gross_total             fils_nonneg not null,

  -- Why the supply was credited. Mandatory and free text: a correction with no stated reason cannot be
  -- reviewed, and a closed list of reasons is a policy nobody has set (there is no reason code on the
  -- refund side either, and inventing one here would put a made-up taxonomy on a statutory document).
  reason                  text        not null
                            constraint credit_note_reason_present check (btrim(reason) <> ''),

  -- The reversing entry. A real foreign key (see the header) and NOT NULL, because a credit note whose
  -- reversal was never posted has changed a customer's balance and moved nothing in the books. The key
  -- is DEFERRED, and that is what fixes the ORDER of the two inserts: the note has to be written first,
  -- so that its own BEFORE INSERT trigger is what refuses a locked period and names the earliest open
  -- date. Post the entry first and `journal_entry`'s own period guard (ZL002, 0018) gets there first
  -- with a message about a journal entry, on a request that was about a document.
  journal_entry_id        text        not null,

  notes                   text,
  provisional_open_question_id text,
  provisional_note        text,

  created_at              timestamptz not null default now(),

  -- 0026's pair of uniques, for 0026's reason: "gap-free" without "no duplicates" is not a numbering
  -- range, because two customers holding the same document reference is worse than a hole.
  constraint credit_note_series_period_number_unique unique (series_code, period_key, number),
  constraint credit_note_display_number_unique unique (display_number),
  -- The series must exist AND be a credit-note series.
  constraint credit_note_series_kind_fk
    foreign key (series_code, document_kind) references document_series (code, document_kind),

  -- One reversal per note, so a second note cannot attach itself to the first one's entry and be
  -- counted twice in a VAT box that reads the journal.
  constraint credit_note_one_reversal_per_entry unique (journal_entry_id),
  constraint credit_note_reversal_fk
    foreign key (journal_entry_id) references journal_entry (entry_id)
    deferrable initially deferred,

  constraint credit_note_totals_reconcile check (net_total + vat_total = gross_total),
  -- A zero-value credit note corrects nothing and would consume a statutory number.
  constraint credit_note_gross_positive check (gross_total > 0),

  -- The issuer snapshot must be real. Word for word 0026's set, including the seeded Y1-trn
  -- placeholder failing both TRN constraints, and including that is_placeholder_text() is not STRICT
  -- so that a NULL is refused rather than satisfying the CHECK.
  constraint credit_note_issuer_trn_is_fifteen_digits check (issuer_trn ~ '^[0-9]{15}$'),
  constraint credit_note_issuer_trn_not_placeholder check (not is_placeholder_text(issuer_trn)),
  constraint credit_note_issuer_name_not_placeholder
    check (not is_placeholder_text(issuer_legal_name)),
  constraint credit_note_issuer_address_not_placeholder
    check (not is_placeholder_text(issuer_address_snapshot)),
  constraint credit_note_customer_name_present check (btrim(customer_name_snapshot) <> ''),

  constraint credit_note_tax_point_not_after_issue check (tax_point_date <= issue_date),
  constraint credit_note_provisional_pair
    check ((provisional_open_question_id is null) = (provisional_note is null))
);

comment on table credit_note is
  'The only correction to an issued document. Append-only: UPDATE and DELETE raise ZD009 for every '
  'role including the owner - a credit note issued in error is answered by re-invoicing the supply, '
  'never by editing the note. Its own series (CR-NOTE), its own issuer snapshot taken on ITS date, '
  'and its own reversal dated on tax_point_date.';
comment on column credit_note.invoice_id is
  'The document corrected. No foreign key: invoice refuses DELETE for every role (ZI003), so the only '
  'statement a key would guard against is a TRUNCATE by the owner - which is the test teardown in '
  'seven suites that the key would break. Enforced at INSERT by credit_note_corrects_a_real_invoice().';
comment on column credit_note.tax_point_date is
  'The date of the ADJUSTMENT, and the entry_date of the reversal. A note raised in October for a '
  'September invoice posts in October, because September may be filed.';
comment on column credit_note.gross_total is
  'What this note takes off, POSITIVE. The direction is the journal''s; a negative column here would '
  'be a second spelling of the same fact in every report that sums it.';
comment on column credit_note.journal_entry_id is
  'The reversing entry. NOT NULL, because a credit note whose reversal was never posted has changed a '
  'customer''s balance and moved nothing in the books.';

create index credit_note_invoice_idx on credit_note (invoice_id);
create index credit_note_tax_point_date_idx on credit_note (tax_point_date);
create index credit_note_customer_id_idx on credit_note (customer_id) where customer_id is not null;

-- ------------------------------------------------------------------------------------------------
-- credit_note_line — which invoiced line is being credited, and how much of it
-- ------------------------------------------------------------------------------------------------
create table credit_note_line (
  credit_note_id   uuid        not null references credit_note(id) on delete restrict,
  line_no          integer     not null check (line_no >= 1),

  -- The line of `credit_note.invoice_id` this credits. A plain integer for the reason invoice_id is a
  -- plain uuid; `credit_note_line_credits_a_real_line()` is what makes it true.
  invoice_line_no  integer     not null check (invoice_line_no >= 1),

  -- Snapshots, like the invoice's. Renaming a service must not restate what a customer was told they
  -- were being refunded for.
  description_en   text        not null check (btrim(description_en) <> ''),
  description_ar   text,

  -- How much of the invoiced quantity is credited. `credit_note_line_within_the_invoiced_quantity()`
  -- caps the CUMULATIVE figure across every note against the invoice line's own quantity.
  quantity         integer     not null check (quantity >= 1),
  -- Held equal to the invoiced line's by the trigger. A credit at a different unit price is a
  -- repricing, which is a new supply and not a correction of this one.
  unit_gross_fils  fils_nonneg not null,
  line_gross_fils  bigint      not null generated always as (unit_gross_fils * quantity) stored,
  vat_rate_bp      smallint    not null check (vat_rate_bp between 0 and 10000),

  -- Supplied by the caller from splitGross() in @berelax/core, NOT generated, for 0026's reason: the
  -- half-up rounding rule has one definition and a plpgsql re-implementation would be a second, with
  -- the disagreement surfacing on a document that has already been filed.
  line_net_fils    fils_nonneg not null,
  line_vat_fils    fils_nonneg not null,

  created_at       timestamptz not null default now(),

  primary key (credit_note_id, line_no),
  -- One line per invoiced line per note. Without it the cumulative cap would have to sum within the
  -- note as well as across notes, and a note crediting the same line twice reads as two corrections of
  -- two different things.
  constraint credit_note_line_one_per_invoice_line unique (credit_note_id, invoice_line_no),
  constraint credit_note_line_totals_reconcile
    check (line_net_fils + line_vat_fils = unit_gross_fils * quantity)
);

comment on table credit_note_line is
  'One credited line, naming the invoiced line it corrects. Append-only: UPDATE and DELETE raise '
  'ZD009. Per-line VAT is the authoritative figure; the note''s total is the sum of these.';
comment on column credit_note_line.quantity is
  'How much of the invoiced quantity this note credits. The CUMULATIVE figure across all notes is '
  'capped at the invoiced quantity by a trigger that takes a lock, so two notes racing for one line '
  'cannot both win.';

create index credit_note_line_note_idx on credit_note_line (credit_note_id);

-- ------------------------------------------------------------------------------------------------
-- Append-only enforcement
-- ------------------------------------------------------------------------------------------------
-- A separate function from refuse_invoice_change(), not a reuse of it. Its message names the remedy —
-- "correct an issued invoice with a credit note" — and that remedy is wrong here: a credit note is not
-- corrected by another credit note, it is answered by re-invoicing the supply. A refusal that sends
-- the reader to the wrong remedy is worse than a generic one.
create function refuse_credit_note_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    '% is append-only; % is refused. A credit note issued in error is answered by re-invoicing the '
    'supply on a new document, never by editing the note.',
    tg_table_name, tg_op
    using errcode = 'ZD009';
end $$;

comment on function refuse_credit_note_change() is
  'Raises ZD009. Fires for EVERY role, including the owner: the grants below constrain berelax_app, '
  'and a migration or a psql session does not connect as berelax_app.';

create trigger credit_note_no_update before update on credit_note
  for each row execute function refuse_credit_note_change();
create trigger credit_note_no_delete before delete on credit_note
  for each row execute function refuse_credit_note_change();
create trigger credit_note_line_no_update before update on credit_note_line
  for each row execute function refuse_credit_note_change();
create trigger credit_note_line_no_delete before delete on credit_note_line
  for each row execute function refuse_credit_note_change();

-- ------------------------------------------------------------------------------------------------
-- The earliest OPEN date, so a refusal says where the note can go instead
-- ------------------------------------------------------------------------------------------------
-- The acceptance for this unit asks that a note dated in a locked period be refused with an error that
-- names the earliest open period. `raise_if_period_locked()` (0018) names the LOCKED one, which is the
-- right message for a posting and half a message for a document somebody now has to re-date.
--
-- It returns a DATE and not a period identifier, and that is not a shortcut. `period_lock` holds the
-- CLOSED periods; an open period is the absence of a row, so there is no identifier to name. The
-- earliest date that no lock covers is the one fact the schema actually holds, and it is what the
-- person re-dating the note needs.
--
-- The loop walks past adjacent locks. `period_lock_no_overlap` makes at most one lock match a date, so
-- each step moves strictly forward to the day after the lock it found and the walk terminates; the
-- bound is there because an unbounded loop inside a trigger is a hung transaction rather than an
-- error, and 1000 consecutive locked periods is not a state this business reaches.
create function earliest_open_date_from(p_from date) returns date
language plpgsql
stable
as $$
declare
  v_date date := p_from;
  v_ends date;
begin
  for i in 1..1000 loop
    select ends_on into v_ends from period_lock
     where v_date between starts_on and ends_on
     limit 1;
    if not found then
      return v_date;
    end if;
    v_date := v_ends + 1;
  end loop;
  raise exception
    'earliest_open_date_from(%) walked 1000 consecutive locked periods without reaching an open '
    'date. That is not a state this business reaches; suspect overlapping or generated locks.',
    p_from using errcode = 'ZD003';
end $$;

comment on function earliest_open_date_from(date) is
  'The first date on or after p_from that no period_lock covers. A DATE and not a period_id because '
  'period_lock holds the CLOSED periods - an open period is the absence of a row and has no id.';

-- ------------------------------------------------------------------------------------------------
-- ZD001/ZD002/ZD003 — the note corrects a real invoice, on a date that is after it and open
-- ------------------------------------------------------------------------------------------------
create function credit_note_corrects_a_real_invoice() returns trigger
language plpgsql
as $$
declare
  v_tax_point date;
  v_number    text;
  v_period    text;
  v_open      date;
begin
  select tax_point_date, display_number into v_tax_point, v_number
    from invoice where id = new.invoice_id;

  -- Stated rather than left to a foreign key that is deliberately absent. The NULL test is on
  -- `v_number`, which is NOT NULL on the row, so "no row" and "a row with a null tax point" cannot be
  -- confused.
  if v_number is null then
    raise exception
      'CreditNoteWithoutInvoice: credit note % names invoice %, which does not exist. A correction of '
      'nothing is not a document.',
      new.display_number, new.invoice_id using errcode = 'ZD001';
  end if;

  if new.tax_point_date < v_tax_point then
    raise exception
      'CreditNoteBeforeTheSupply: credit note % is dated % and corrects invoice "%" whose supply is '
      'dated %. A correction may not appear in a period the original never reached.',
      new.display_number, new.tax_point_date, v_number, v_tax_point using errcode = 'ZD002';
  end if;

  v_period := period_lock_for(new.tax_point_date);
  if v_period is not null then
    -- The locked period AND the earliest open date. Naming only the lock sends the person to the
    -- month they cannot use; naming only the open date hides why.
    v_open := earliest_open_date_from(new.tax_point_date);
    raise exception
      'PeriodLocked: cannot issue credit note % dated %; accounting period "%" is locked. The '
      'earliest open date is %.',
      new.display_number, new.tax_point_date, v_period, v_open using errcode = 'ZD003';
  end if;

  return new;
end $$;

comment on function credit_note_corrects_a_real_invoice() is
  'Raises ZD001 (no such invoice), ZD002 (dated before the supply) or ZD003 (locked period, naming '
  'the earliest OPEN date). BEFORE INSERT, so the refusal arrives at the statement that caused it.';

create trigger credit_note_corrects_an_invoice before insert on credit_note
  for each row execute function credit_note_corrects_a_real_invoice();

-- ------------------------------------------------------------------------------------------------
-- ZD004/ZD005/ZD006 — the credited line exists, is priced as it was sold, and is not over-credited
-- ------------------------------------------------------------------------------------------------
-- The cumulative cap is the acceptance line that says "enforced by a DB constraint and proven by two
-- parallel credit notes for the same line where exactly one succeeds", and the second half is what
-- makes the lock necessary. Two transactions each summing `credit_note_line` see none of the other's
-- uncommitted rows, so both pass and both commit: the sum is only a ceiling if the readers are
-- serialised.
--
-- The lock is an ADVISORY lock on the invoice line's identity and not `select ... for update` on the
-- row itself, and that is measured rather than stylistic. `invoice_line` has UPDATE revoked from
-- `berelax_app` (0026), and PostgreSQL requires UPDATE for `FOR UPDATE` — so the row lock raises
-- `permission denied for table invoice_line` for the application role, which is every caller that
-- matters. A SECURITY DEFINER wrapper would work and would hand the write path a privilege it has no
-- other reason to hold. An advisory lock needs no privilege, is released at COMMIT, and a hash
-- collision costs two unrelated lines a moment of serialisation rather than correctness: the sum below
-- still reads the real rows.
create function credit_note_line_within_the_invoiced_quantity() returns trigger
language plpgsql
as $$
declare
  v_invoice        uuid;
  v_note_number    text;
  v_invoiced       integer;
  v_unit_gross     bigint;
  v_rate_bp        smallint;
  v_credited       integer;
  v_line_net       bigint;
  v_line_vat       bigint;
begin
  select invoice_id, display_number into v_invoice, v_note_number
    from credit_note where id = new.credit_note_id;
  if v_invoice is null then
    -- Unreachable through the foreign key on credit_note_id, and stated because the comparisons below
    -- against a NULL would each evaluate to NULL and fall through, reporting success on the one shape
    -- this function exists to catch. 0026's totals trigger states the same guard for the same reason.
    raise exception
      'CreditNoteLineWithoutNote: no credit note with id %', new.credit_note_id
      using errcode = 'ZD004';
  end if;

  -- Taken before the read, so the transaction that loses the race reads the winner's committed row.
  perform pg_advisory_xact_lock(
    hashtextextended(v_invoice::text || ':' || new.invoice_line_no::text, 0));

  select quantity, unit_gross_fils, vat_rate_bp, line_net_fils, line_vat_fils
    into v_invoiced, v_unit_gross, v_rate_bp, v_line_net, v_line_vat
    from invoice_line
   where invoice_id = v_invoice and line_no = new.invoice_line_no;

  if v_invoiced is null then
    raise exception
      'CreditNoteLineWithoutInvoiceLine: credit note % credits line % of invoice %, which has no such '
      'line.',
      v_note_number, new.invoice_line_no, v_invoice using errcode = 'ZD004';
  end if;

  if new.unit_gross_fils <> v_unit_gross or new.vat_rate_bp <> v_rate_bp then
    raise exception
      'CreditNotePriceDisagrees: credit note % credits line % of invoice % at % fils per unit at %bp; '
      'the line was sold at % fils at %bp. A credit at a different price is a repricing, which is a '
      'new supply rather than a correction of this one.',
      v_note_number, new.invoice_line_no, v_invoice, new.unit_gross_fils, new.vat_rate_bp,
      v_unit_gross, v_rate_bp using errcode = 'ZD005';
  end if;

  -- BEFORE INSERT, so `new` is not in the table yet and the sum below would be the cumulative figure
  -- WITHOUT this line. Adding it is what makes the comparison a ceiling rather than a report on what
  -- has already happened, and leaving it out would let every line be credited one note too many.
  select coalesce(sum(l.quantity), 0) + new.quantity into v_credited
    from credit_note_line l
    join credit_note n on n.id = l.credit_note_id
   where n.invoice_id = v_invoice and l.invoice_line_no = new.invoice_line_no;

  if v_credited > v_invoiced then
    raise exception
      'CreditNoteOverCredits: line % of invoice % was invoiced % and would now be credited % in '
      'total. A supply cannot be credited more than it was sold.',
      new.invoice_line_no, v_invoice, v_invoiced, v_credited using errcode = 'ZD006';
  end if;

  -- A FULL credit of a line must carry the line's own VAT, to the fils. A partial one may not: three
  -- notes of quantity 1 against a line of 3 at 11 fils gross carry 1 fils of VAT each, and the line
  -- carries 2 - which is the 11-fils case 0026 exists to keep straight. So this is asserted for the
  -- full credit only, where the two figures have to agree and a re-derivation is what makes them
  -- disagree.
  if new.quantity = v_invoiced and (new.line_net_fils <> v_line_net or new.line_vat_fils <> v_line_vat)
  then
    raise exception
      'CreditNoteFullCreditDisagrees: credit note % credits all % of line % of invoice % and states '
      'net % / VAT % fils; the line states net % / VAT %. A full credit carries the line''s own '
      'figures, never a re-derivation of them.',
      v_note_number, v_invoiced, new.invoice_line_no, v_invoice,
      new.line_net_fils, new.line_vat_fils, v_line_net, v_line_vat
      using errcode = 'ZD005';
  end if;

  return new;
end $$;

comment on function credit_note_line_within_the_invoiced_quantity() is
  'Raises ZD004 (no such line), ZD005 (a different unit price, rate, or a full credit whose figures '
  'are re-derived) or ZD006 (cumulative quantity above what was invoiced). Takes an advisory lock on '
  'the invoice line first, because two summing readers are not a ceiling until they serialise.';

create trigger credit_note_line_credits_a_real_line before insert on credit_note_line
  for each row execute function credit_note_line_within_the_invoiced_quantity();

-- ------------------------------------------------------------------------------------------------
-- ZD007/ZD008 — the note's totals are the sum of its lines, and it has lines, checked at COMMIT
-- ------------------------------------------------------------------------------------------------
-- 0026's shape and 0026's reason: the header is inserted before its lines exist, so an IMMEDIATE
-- trigger would reject every note ever issued and the only way to satisfy it would be to insert the
-- header and every line in one statement.
create function assert_credit_note_totals_match_lines() returns trigger
language plpgsql
as $$
declare
  v_note   uuid;
  v_lines  integer;
  v_net    bigint;
  v_vat    bigint;
  v_gross  bigint;
  h_net    bigint;
  h_vat    bigint;
  h_gross  bigint;
  h_number text;
begin
  -- An IF and not a CASE expression, for 0026's reason: plpgsql resolves every field reference in an
  -- expression before evaluating the branch, so `case ... else new.credit_note_id end` raises "record
  -- new has no field credit_note_id" on the header trigger, every time, for every document.
  if tg_table_name = 'credit_note' then
    v_note := new.id;
  else
    v_note := new.credit_note_id;
  end if;

  select net_total, vat_total, gross_total, display_number
    into h_net, h_vat, h_gross, h_number
    from credit_note where id = v_note;

  if h_number is null then
    raise exception 'CreditNoteTotalsDisagree: no credit note with id %', v_note
      using errcode = 'ZD007';
  end if;

  select count(*),
         coalesce(sum(line_net_fils), 0),
         coalesce(sum(line_vat_fils), 0),
         coalesce(sum(line_gross_fils), 0)
    into v_lines, v_net, v_vat, v_gross
    from credit_note_line where credit_note_id = v_note;

  -- A note with no lines states nothing, consumes a statutory number and would commit with totals of
  -- zero — except that credit_note_gross_positive refuses zero totals, so the shape that reaches here
  -- is a note whose header claims an amount and whose lines are missing. It fires no line trigger at
  -- all, so only the header trigger can see it.
  if v_lines = 0 then
    raise exception 'CreditNoteWithoutLines: credit note "%" has no lines', h_number
      using errcode = 'ZD008';
  end if;

  if h_vat <> v_vat then
    raise exception
      'CreditNoteTotalsDisagree: credit note "%" states vat_total % fils; its % line(s) sum to % '
      'fils. A document total is the SUM of per-line VAT, never VAT re-derived from the gross.',
      h_number, h_vat, v_lines, v_vat using errcode = 'ZD007';
  end if;

  if h_net <> v_net then
    raise exception
      'CreditNoteTotalsDisagree: credit note "%" states net_total % fils; its % line(s) sum to % fils.',
      h_number, h_net, v_lines, v_net using errcode = 'ZD007';
  end if;

  if h_gross <> v_gross then
    raise exception
      'CreditNoteTotalsDisagree: credit note "%" states gross_total % fils; its % line(s) sum to % '
      'fils.',
      h_number, h_gross, v_lines, v_gross using errcode = 'ZD007';
  end if;

  return null;
end $$;

comment on function assert_credit_note_totals_match_lines() is
  'Raises ZD007 (totals disagree) or ZD008 (no lines) at COMMIT. Both triggers resolve the note id '
  'from their own row, so one function serves the header and the lines.';

create constraint trigger credit_note_totals_match_lines
  after insert on credit_note
  deferrable initially deferred
  for each row execute function assert_credit_note_totals_match_lines();

create constraint trigger credit_note_line_totals_match_lines
  after insert on credit_note_line
  deferrable initially deferred
  for each row execute function assert_credit_note_totals_match_lines();

-- ------------------------------------------------------------------------------------------------
-- The reversal is dated on the note, and it reverses something
-- ------------------------------------------------------------------------------------------------
-- DEFERRED, because the entry is inserted before the note and its LINES are inserted after it: at the
-- moment the note is written the entry exists but is transiently unbalanced by construction (0018
-- defers its own balance check for exactly that reason), and this check reads the entry's total.
-- The account a credited supply is parked in, in exactly one place in SQL, so the pair with
-- `ACCOUNTS.tradeReceivables` in @berelax/core and `TRADE_RECEIVABLES_ACCOUNT_CODE` in @berelax/db can be
-- asserted in one place rather than wherever the literal happened to be typed. 0068 states
-- `tips_payable_account_code()` for the same reason, and packages/fixtures/src/credit-note.itest.ts makes
-- the assertion with a control.
--
-- `1050 Trade receivables` is 0068's choice, not this migration's, and the reason for following it is in
-- 0072's header: a payment posts Dr tender / Cr 1050, a refund posts Dr 1050 / Cr tender, and
-- `manual-payment.ts` names the credit note's half as `Cr 1050`. Following it makes an invoice, a full
-- credit note and a full refund net to zero in EVERY account any of the three touched.
create or replace function credit_note_settlement_account_code() returns text
  language sql immutable parallel safe
  as $$ select '1050'::text $$;

comment on function credit_note_settlement_account_code() is
  'The account a credit note credits: the receivable a payment clears and a refund re-creates (0068). '
  'Stated once here so the pair with ACCOUNTS.tradeReceivables in @berelax/core and '
  'TRADE_RECEIVABLES_ACCOUNT_CODE in @berelax/db is one assertion rather than a search for a literal.';

create function credit_note_reversal_is_dated_on_the_note() returns trigger
language plpgsql
as $$
declare
  v_date     date;
  v_source   text;
  v_credited bigint;
begin
  select entry_date, source into v_date, v_source
    from journal_entry where entry_id = new.journal_entry_id;

  if v_date <> new.tax_point_date then
    raise exception
      'CreditNoteReversalMisdated: credit note % is dated % and its reversal "%" is dated %. A '
      'correction posts in the period the NOTE falls in, or a filed period gets restated.',
      new.display_number, new.tax_point_date, new.journal_entry_id, v_date
      using errcode = 'ZD011';
  end if;

  if v_source <> 'reversal' then
    raise exception
      'CreditNoteReversalMisclassified: credit note % has reversal "%" classified as a "%" entry. A '
      'refund and a credited sale produce identical lines and are answered differently when a '
      'customer asks, which is why journal_entry.source is carried rather than inferred.',
      new.display_number, new.journal_entry_id, v_source
      using errcode = 'ZD011';
  end if;

  -- What the entry parks in `1050 Trade receivables` is what the note says it took off the document.
  -- The account is named once here and read from the chart by @berelax/core's posting rule;
  -- packages/fixtures holds the two equal.
  select coalesce(sum(credit_fils - debit_fils), 0) into v_credited
    from journal_line
   where entry_id = new.journal_entry_id
     and account_code = credit_note_settlement_account_code();

  if v_credited <> new.gross_total then
    raise exception
      'CreditNoteReversalDisagrees: credit note % states % fils and its reversal "%" credits % fils '
      'to the settlement account. The note and its posting are two statements of one amount.',
      new.display_number, new.gross_total, new.journal_entry_id, v_credited
      using errcode = 'ZD011';
  end if;

  return null;
end $$;

comment on function credit_note_reversal_is_dated_on_the_note() is
  'Raises ZD011 when the reversal is dated on any date but the note''s, is not a reversal, or credits '
  'an amount to the settlement account that is not the note''s gross. DEFERRED: the entry''s lines are '
  'inserted after the note, and 0018 defers its own balance check for the same reason.';

create constraint trigger credit_note_reversal_matches
  after insert on credit_note
  deferrable initially deferred
  for each row execute function credit_note_reversal_is_dated_on_the_note();

-- ------------------------------------------------------------------------------------------------
-- refund — the foreign key and the two checks 0068 deferred to this unit
-- ------------------------------------------------------------------------------------------------
-- 0068: "`credit_note_id` is NOT NULL and carries NO foreign key, because `credit_note` is
-- M-TILL-08's: the requirement — money does not leave against an invoice alone — is enforceable today
-- and the reference is not." Here is the reference.
--
-- Unlike `credit_note.invoice_id`, this one IS a real key. `refund` is already named in every suite
-- that truncates the invoice family, so a suite truncating `credit_note` has to name `refund` — and
-- the suites that truncate `credit_note` are this unit's. There is no cost to pay twice.
alter table refund
  add constraint refund_authorised_by_credit_note
  foreign key (credit_note_id) references credit_note (id);

comment on column refund.credit_note_id is
  'The credit note that authorises this refund, with a real foreign key since 0072. NOT NULL, because '
  'a refund from an invoice alone is money leaving the business with no document behind it.';

-- ZD010 (on refund) — the note is for THIS document.
--
-- IMMEDIATE, because it is a property of one row: the note either names this invoice or it does not,
-- and there is nothing to wait for. The ceilings below are deferred; this is not.
create function refund_credit_note_is_for_this_document() returns trigger
language plpgsql
as $$
declare
  v_invoice uuid;
  v_number  text;
begin
  -- A MISSING id is not this trigger's to report. `refund.credit_note_id` is NOT NULL (0068), and a
  -- BEFORE ROW trigger runs before the column constraints are checked — so raising here on a null would
  -- take the refusal away from the constraint whose message names the column, and 0068's own probe
  -- asserts 23502 on exactly that statement. Returning lets the NOT NULL do its job.
  if new.credit_note_id is null then
    return new;
  end if;

  select invoice_id, display_number into v_invoice, v_number
    from credit_note where id = new.credit_note_id;

  -- Unreachable past the foreign key above, and stated because `v_invoice <> new.invoice_id` against a
  -- NULL evaluates to NULL and a plpgsql IF treats that as false — so the guard would fall through on
  -- the one shape it exists to catch. It is also what a caller reads INSTEAD of the key's own
  -- `violates foreign key constraint`, because a BEFORE trigger runs before the key is checked.
  if v_number is null then
    raise exception 'RefundWithoutCreditNote: no credit note with id %', new.credit_note_id
      using errcode = 'ZD010';
  end if;

  if v_invoice <> new.invoice_id then
    raise exception
      'RefundCreditNoteIsForAnotherDocument: the refund is against invoice % and credit note % '
      'corrects invoice %. A note authorises money leaving against the document it corrects and no '
      'other.',
      new.invoice_id, v_number, v_invoice using errcode = 'ZD010';
  end if;

  return new;
end $$;

comment on function refund_credit_note_is_for_this_document() is
  'Raises ZD010 when a refund names a credit note for a different invoice. IMMEDIATE: it is a '
  'property of one row and there is nothing to wait for.';

create trigger refund_credit_note_matches_the_document before insert on refund
  for each row execute function refund_credit_note_is_for_this_document();

-- ZD012 (on refund) — the note's value covers what went back.
--
-- DEFERRED for 0068's reason: a refund split across two tender forms is two statements in one
-- transaction, and a per-statement check would refuse the second before the first had finished.
--
-- The NAME matters. PostgreSQL fires several AFTER triggers on one event in alphabetical order by
-- trigger name, and 0068's ceiling is `refund_not_more_than_was_paid`. 'n' sorts before 'w', so
-- ZT004 — "refunding money that was never taken is not a correction of anything" — still reaches a
-- caller first for a refund that breaks both, which is what 0068's gate probe asserts by name.
create function refund_within_the_credit_note() returns trigger
language plpgsql
as $$
declare
  v_credited bigint;
  v_refunded bigint;
  v_number   text;
begin
  select gross_total, display_number into v_credited, v_number
    from credit_note where id = new.credit_note_id;
  select coalesce(sum(amount_fils), 0) into v_refunded
    from refund where credit_note_id = new.credit_note_id;

  if v_refunded > v_credited then
    raise exception
      'RefundExceedsCreditNote: credit note % credits % fils and % fils have been refunded against '
      'it. A second refund on one note is a second payment of one correction.',
      v_number, v_credited, v_refunded using errcode = 'ZD012';
  end if;

  return null;
end $$;

comment on function refund_within_the_credit_note() is
  'Raises ZD012 when the refunds against one credit note exceed what it credits. DEFERRED for ZT004''s '
  'reason, and named so it sorts AFTER refund_not_more_than_was_paid: a refund breaking both ceilings '
  'should report the one about money rather than the one about paperwork.';

create constraint trigger refund_within_its_credit_note
  after insert on refund
  deferrable initially deferred
  for each row execute function refund_within_the_credit_note();

-- ------------------------------------------------------------------------------------------------
-- What has been credited, for the view — and the ceiling this migration deliberately does NOT add
-- ------------------------------------------------------------------------------------------------
-- `invoice_payable_fils()` is not changed; the header says why. The obvious other half of that decision
-- is a SECOND ceiling on `payment` — "no more money is collected against a supply that has been
-- credited" — and it is deliberately absent, because neither shape it could take is sound:
--
--   * IMMEDIATE, it steals ZT001's refusal. `applied > payable - credited` with no credit note is
--     ZT001's own condition, and ZT001 is DEFERRED, so the immediate one would fire first and a caller
--     paying one fils too much would read a message about credit notes. 0068's gate probe asserts ZT001
--     BY NAME on exactly that statement.
--   * DEFERRED, it refuses a transaction that pays a document and credits it together, because at COMMIT
--     both rows are there and `applied > payable - credited` holds for every document paid in full and
--     then credited in full. That is the ordinary end state, reached in two transactions in production
--     and in ONE in a fixture, an import, or 0068's own accepted-rows control.
--
-- So the ceiling on what may be COLLECTED stays exactly what 0068 made it, and what a credit note
-- changes is visible in `invoice_settlement.receivable_fils` going negative rather than in a refusal.
-- The till reading that figure before offering to take payment is M-TILL-13's; see the NOTE on
-- M-TILL-08.
create function credited_total_fils(p_invoice uuid) returns bigint
  language sql stable as $$
  select coalesce(sum(gross_total), 0)::bigint from credit_note where invoice_id = p_invoice
$$;

comment on function credited_total_fils(uuid) is
  'What has been credited off a document, positive fils. Read from the notes rather than carried on '
  'the invoice, for the reason invoice_settlement is a view: there is no invoice.credited_total to '
  'drift from the documents that produced it.';

-- ------------------------------------------------------------------------------------------------
-- invoice_settlement — credited and receivable, beside what 0068 already answered
-- ------------------------------------------------------------------------------------------------
-- `create or replace`, so every reader of the existing columns keeps working: the first nine columns
-- are 0068's, in 0068's order and types, and the two new ones are appended. `outstanding_fils` keeps
-- its definition on purpose — it is exactly the quantity ZT001 refuses to let go negative, and
-- redefining it would make the view and the ceiling disagree about whether one more payment is
-- allowed, which is the one property 0068 built it to have.
create or replace view invoice_settlement as
  select
    i.id                                        as invoice_id,
    i.display_number,
    i.gross_total::bigint                       as gross_fils,
    invoice_payable_fils(i.id)                  as payable_fils,
    coalesce(p.tendered_fils, 0)                as tendered_fils,
    coalesce(p.change_given_fils, 0)            as change_given_fils,
    coalesce(p.applied_fils, 0)                 as applied_fils,
    coalesce(r.refunded_fils, 0)                as refunded_fils,
    invoice_payable_fils(i.id) - coalesce(p.applied_fils, 0) as outstanding_fils,
    -- 0072. What the credit notes against this document take off it.
    credited_total_fils(i.id)                   as credited_fils,
    -- 0068's NOTE: "the honest figure after a refund is gross - credited - applied + refunded and
    -- `credited` is that unit's". Here it is. NEGATIVE means the business holds money it owes back,
    -- which is the honest reading of a document paid in full and then credited in full, and it is why
    -- this is a separate column rather than a redefinition of `outstanding_fils`.
    invoice_payable_fils(i.id)
      - credited_total_fils(i.id)
      - coalesce(p.applied_fils, 0)
      + coalesce(r.refunded_fils, 0)            as receivable_fils
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
  'What each document has been tendered, given back as change, applied, refunded, credited and still '
  'owes. A VIEW and not a stored balance, for the reason leave_balance is one (0066). '
  'outstanding_fils is what may still be COLLECTED (ZT001''s quantity); receivable_fils is what the '
  'customer still owes after credits and refunds, and is NEGATIVE when the business owes money back.';

-- ------------------------------------------------------------------------------------------------
-- Privileges
-- ------------------------------------------------------------------------------------------------
-- 0009 granted the application role select, insert, update and delete on every table in public AND set
-- default privileges extending that to tables created later, so both tables arrive with UPDATE and
-- DELETE already granted. An append-only table that forgets to revoke them is append-only only for as
-- long as nobody writes the statement.
grant select, insert on credit_note, credit_note_line to berelax_app;
revoke update, delete on credit_note, credit_note_line from berelax_app;

-- TRUNCATE is the one statement that fires no row-level DELETE trigger, so the refusal triggers above
-- would not see it. 0009 never granted it; stated explicitly because "it was never granted" and "we
-- checked" are different facts.
revoke truncate on credit_note, credit_note_line from berelax_app;

-- The specific promise M-TILL-03 needs from this table, restated where a reader looks for it: a
-- series' prefix and padding remain editable configuration, and no change to them can renumber an
-- issued note, because the stored string is not writable by the application at all.
revoke update (display_number, number, period_key, series_code) on credit_note from berelax_app;

grant select on credit_note, credit_note_line to berelax_readonly;

commit;
