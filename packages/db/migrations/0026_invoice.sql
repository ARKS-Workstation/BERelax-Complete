-- 0026 — the invoice document: an issuer snapshot, per-line tax, and no way to change either.
--
-- Three rules carry this migration, and each one exists because the obvious alternative is wrong in a
-- way that only surfaces on a document already handed to a customer or filed with the FTA.
--
-- ## The issuer is SNAPSHOTTED, not joined
--
-- `legal_entity` and `premises` are singletons that change: a relocation, a change of legal name, a
-- TRN issued at last. A view that joined an invoice to them would rewrite every historic document the
-- day one of those changed — silently, and in the direction that makes a filed return disagree with
-- the documents supporting it. So the name, the address and the TRN are copied onto the row at issue
-- and never read back from their source. docs/01 and docs/04 §4.
--
-- ## A document total is the SUM of its lines, never a re-derivation from the document gross
--
-- VAT is a per-line fact. Two lines at 11 fils gross carry 1 fils each — 11 - round(11 * 20 / 21) = 1
-- — so the document's VAT is 2. Split the 22-fils TOTAL instead and the answer is 1, because
-- 22 - round(22 * 20 / 21) = 1. A fils, on a two-line receipt, and neither figure looks wrong on its
-- own. Which one is right is not a matter of taste: the customer was charged tax on each supply, the
-- line amounts are what the document shows, and 2 is the only figure the lines support.
--
-- Hence `assert_invoice_totals_match_lines()`, a DEFERRED constraint trigger. Deferred because the
-- header is inserted before its lines exist, so an immediate check would reject every invoice ever
-- issued. What it buys is that a caller which re-derives cannot commit: the transaction fails at
-- COMMIT with ZI001 naming both figures.
--
-- Note what is deliberately NOT here: no generated column for `vat_total`. A generated
-- `gross_total - round(gross_total * 20 / 21)` would be the re-derivation, stored, on every document,
-- and it would look like a safety feature.
--
-- ## An invoice is never corrected
--
-- Append-only, in both layers, exactly as the journal is (ADR 0017, migration 0018): the application
-- role is refused UPDATE, DELETE and TRUNCATE, and a pair of BEFORE triggers raises ZI003 for every
-- role including the owner — which is what a migration or a psql session connects as, and the one role
-- a privilege cannot constrain. A correction is a CREDIT NOTE, which is a separate document with its
-- own series (docs/04 §4, "Credit notes only for corrections. Never edit or delete an issued
-- invoice."). `packages/db/src/repositories/invoice.ts` therefore exports no update, edit, void or
-- delete function, asserted as an export-surface test rather than left as a convention.

begin;

-- ---------------------------------------------------------------------------------------------
-- Placeholders, recognised in one place
-- ---------------------------------------------------------------------------------------------
-- Several answers the build needs are still open (OPEN-QUESTIONS Y1-trn, Y1-nap, Y11-vat-invoice), and
-- the provisional values stand in for them as DATA so the system runs. A provisional value must never
-- reach a tax document, so the document refuses it.
--
-- Deliberately NOT `strict`. A strict function returns NULL for a NULL argument, a CHECK whose
-- expression evaluates to NULL is SATISFIED, and the constraint would then accept the very NULL it
-- exists to refuse — while reading, in the schema, as though it did not.
--
-- The same list is `PLACEHOLDER_MARKERS` in packages/core/src/money/vat.ts, because the CHECK has to
-- hold for a psql session and the application needs to explain the refusal before it attempts the
-- insert. Two implementations of one list is one list plus a future disagreement, so
-- packages/fixtures/src/invoice-document.itest.ts asserts the two agree on a table of spellings.
create function is_placeholder_text(p_value text) returns boolean
language sql
immutable
as $$
  select p_value is null
      or btrim(p_value) = ''
      or exists (
           select 1
           from unnest(array[
                  '[confirm]', 'to be confirmed', 'tbc', 'tbd', 'pending',
                  'placeholder', 'not configured', 'unknown', 'todo', 'xxx'
                ]) as m(marker)
           where strpos(lower(btrim(p_value)), m.marker) > 0
         );
$$;

comment on function is_placeholder_text(text) is
  'True for a blank value or one carrying a provisional marker. NOT strict on purpose: a strict '
  'function returns NULL for NULL, and a CHECK whose expression is NULL passes.';

-- ---------------------------------------------------------------------------------------------
-- The series a document may draw its number from
-- ---------------------------------------------------------------------------------------------
-- 0013 made `code` the primary key, so a foreign key on `series_code` alone proves the series exists
-- and nothing more: a credit note could be numbered out of TAX-INV and the range a VAT return reads
-- would contain two kinds of document. This unique constraint is what lets the composite foreign key
-- below tie the document's KIND to the series' kind, which is the claim that matters.
alter table document_series
  add constraint document_series_code_kind_unique unique (code, document_kind);

-- ---------------------------------------------------------------------------------------------
-- The invoice
-- ---------------------------------------------------------------------------------------------
create table invoice (
  id                      uuid        primary key default uuid_generate_v7(),

  -- A tax invoice carries the customer's details; a simplified invoice is the retail form below the
  -- threshold (docs/04 §4). A credit note is NOT a kind of invoice — it is a separate document with
  -- its own series and its own table, because a correction that lives in the same table as the thing
  -- it corrects is one `where` clause away from being counted twice.
  document_kind           text        not null
                            check (document_kind in ('tax_invoice', 'simplified_invoice')),

  -- --- the statutory number, as M-TILL-03 allocated it ----------------------------------------
  -- All four columns are stored, none is re-derived. `number` is what the gap report counts;
  -- `display_number` is the string printed on the document, composed once by
  -- document_number_display() at issue. Re-deriving the string later from the integer would let an
  -- admin renaming a prefix renumber an invoice that has already been filed.
  series_code             text        not null,
  period_key              text        not null,
  number                  bigint      not null check (number >= 1),
  display_number          text        not null,

  -- --- the issuer snapshot --------------------------------------------------------------------
  issuer_legal_name       text        not null,
  issuer_trading_name     text        not null,
  issuer_trn              text        not null,
  -- Newline-separated, in the order it prints. One column rather than a line table: an address is
  -- read as a block and never queried by line, and a child table would make the snapshot mutable
  -- one row at a time.
  issuer_address_snapshot text        not null,
  issuer_emirate          text        not null,
  issuer_phone            text,
  issuer_licence_number   text,
  -- Nullable, and the only mandatory-field gap in this schema. The Arabic-language requirement is
  -- real (docs/04 §4) and packages/pdf/src/documents/invoice.ts already renders an Arabic party name
  -- and address — but `legal_entity` and `premises` carry no Arabic columns, so there is nothing to
  -- snapshot FROM. NOT NULL here would make every invoice unissuable. See the NOTE on M-TILL-04.
  issuer_legal_name_ar    text,
  issuer_address_snapshot_ar text,

  -- --- the customer ---------------------------------------------------------------------------
  -- The id is provenance and may be null: a cash sale at the desk has no customer record. The NAME is
  -- snapshotted for the same reason the issuer is, and it is a record label — `Customer 0042` — never
  -- an invented name (ADR 0020).
  --
  -- `on delete restrict`, not `set null`. Two reasons, and the first is the one that would have bitten:
  -- this table is append-only, so a cascading SET NULL is an UPDATE that refuse_invoice_change() would
  -- refuse — the customer row would become undeletable anyway, with ZI003 instead of a foreign key
  -- error. The second is the rule itself: a five-year financial record outlives an erasure request,
  -- which anonymises the CRM identity rather than removing the invoice (docs/04 §4).
  customer_id             uuid        references customer(id) on delete restrict,
  customer_name_snapshot  text        not null,
  customer_trn            text,
  customer_address_snapshot text,
  customer_phone          text,

  -- --- the dates, which are three different facts ---------------------------------------------
  -- Date of issue: the calendar date the document was written.
  issue_date              date        not null,
  -- The trading date the document was issued on, for cash-up. NULLABLE: an invoice raised by the
  -- accountant at 10:00 is written while the premises is shut, so it belongs to no trading date at all.
  -- Storing the calendar date there instead would put that document in a cash-up it was never part of.
  issue_trading_date      date,
  -- Date of supply, and the TAX POINT. A supply on trading day D invoiced on D+1 keeps its tax point
  -- at D, so this is stored rather than derived from issue_date. Trading runs 11:00-02:00, so a 01:30
  -- treatment belongs to the PREVIOUS trading date: the value comes from resolveTradingDate in
  -- @berelax/core, never from truncating a timestamp, because a truncation moves that supply into the
  -- next day and potentially the next VAT period.
  tax_point_date          date        not null,
  issued_at               timestamptz not null default now(),

  -- --- the amounts ----------------------------------------------------------------------------
  -- Integer fils, VAT-inclusive gross authoritative (ADR 0007). Each is the SUM of the per-line
  -- amount; assert_invoice_totals_match_lines() is what makes that true rather than intended.
  currency                char(3)     not null default 'AED' check (currency = 'AED'),
  net_total               fils_nonneg not null,
  vat_total               fils_nonneg not null,
  gross_total             fils_nonneg not null,

  notes                   text,
  -- Which open question the field set stands in for, carried as data so a reader of the database can
  -- see that the superset is an assumption awaiting a tax agent rather than a confirmed list.
  provisional_open_question_id text,
  provisional_note        text,

  created_at              timestamptz not null default now(),

  -- No number is issued twice within a series' reset period, and no display string is issued twice at
  -- all. "Gap-free" without "no duplicates" is not a numbering range: two customers holding the same
  -- document reference is worse than a hole, because neither copy is wrong.
  constraint invoice_series_period_number_unique unique (series_code, period_key, number),
  constraint invoice_display_number_unique unique (display_number),
  -- The series must exist AND be a series for this kind of document.
  constraint invoice_series_kind_fk
    foreign key (series_code, document_kind) references document_series (code, document_kind),

  -- net + vat = gross exactly, which is the whole reason VAT is derived as the remainder rather than
  -- rounded independently (ADR 0007). A one-fils discrepancy here is a figure an auditor asks about.
  constraint invoice_totals_reconcile check (net_total + vat_total = gross_total),

  -- The issuer snapshot must be real. These refuse a value that stands in for an answer nobody has
  -- given — including the seeded Y1-trn placeholder, which fails both TRN constraints — and they refuse
  -- a NULL as well, which is the whole reason is_placeholder_text() is not STRICT: a strict function
  -- returns NULL for NULL, a CHECK whose expression is NULL is satisfied, and the constraint would then
  -- accept exactly the absence it exists to refuse. The NOT NULLs above say the same thing a second
  -- time, and the two say it for different readers: one is the column's own declaration, the other is
  -- what still holds if somebody ever relaxes it.
  constraint invoice_issuer_trn_is_fifteen_digits check (issuer_trn ~ '^[0-9]{15}$'),
  constraint invoice_issuer_trn_not_placeholder check (not is_placeholder_text(issuer_trn)),
  constraint invoice_issuer_name_not_placeholder
    check (not is_placeholder_text(issuer_legal_name)),
  constraint invoice_issuer_address_not_placeholder
    check (not is_placeholder_text(issuer_address_snapshot)),
  constraint invoice_customer_name_present check (btrim(customer_name_snapshot) <> ''),

  -- A document cannot be issued before the supply it describes.
  constraint invoice_tax_point_not_after_issue check (tax_point_date <= issue_date),
  constraint invoice_provisional_pair
    check ((provisional_open_question_id is null) = (provisional_note is null))
);

comment on table invoice is
  'An issued tax or simplified invoice. Append-only: UPDATE and DELETE raise ZI003 for every role, '
  'including the owner. A correction is a credit note, never an edit (docs/04 SS4). The issuer name, '
  'address and TRN are SNAPSHOTS of legal_entity and premises, so a relocation or a change of legal '
  'name cannot rewrite a document already filed.';
comment on column invoice.vat_total is
  'The SUM of per-line VAT, never VAT re-derived from gross_total. Two lines at 11 fils gross store 2 '
  'here; splitting the 22-fils total would give 1. Enforced at COMMIT by '
  'assert_invoice_totals_match_lines().';
comment on column invoice.tax_point_date is
  'Date of supply: the TRADING date the supply belongs to, which for a 01:30 treatment is the '
  'previous calendar date. Separate from issue_date because a supply on D invoiced on D+1 keeps its '
  'tax point at D.';
comment on column invoice.display_number is
  'The formatted statutory identifier, composed by document_number_display() at issue and never '
  'recomputed. The application role holds no UPDATE on this table, so no code path can renumber it.';
comment on column invoice.issuer_legal_name_ar is
  'Arabic legal name, nullable because legal_entity carries no Arabic column to snapshot from. The '
  'Arabic-language requirement (docs/04 SS4) is unmet until it does; see the NOTE on M-TILL-04.';

create index invoice_tax_point_date_idx on invoice (tax_point_date);
create index invoice_issue_trading_date_idx on invoice (issue_trading_date);
create index invoice_customer_id_idx on invoice (customer_id) where customer_id is not null;

-- ---------------------------------------------------------------------------------------------
-- The lines
-- ---------------------------------------------------------------------------------------------
-- No link to a sale or an appointment: neither table exists yet. M-TILL-06 owns that wiring, and a
-- foreign key written now with no writer is a guess about a column somebody else will name.
create table invoice_line (
  invoice_id       uuid        not null references invoice(id) on delete restrict,
  line_no          integer     not null check (line_no >= 1),

  -- Snapshots, like the issuer. Renaming a service in the catalogue must not restate what a customer
  -- was told they were buying.
  description_en   text        not null check (btrim(description_en) <> ''),
  -- Nullable for the same reason as the issuer's Arabic fields: the catalogue carries no Arabic
  -- display name yet.
  description_ar   text,

  quantity         integer     not null check (quantity >= 1),
  unit_gross_fils  fils_nonneg not null,
  -- Generated, because quantity times a unit price involves no rounding and therefore has exactly one
  -- correct value. A caller-supplied line total is a second opinion about multiplication.
  line_gross_fils  bigint      not null generated always as (unit_gross_fils * quantity) stored,
  vat_rate_bp      smallint    not null check (vat_rate_bp between 0 and 10000),

  -- Supplied by the caller from splitGross() in @berelax/core, NOT generated. The half-up rounding
  -- rule has one definition, in core, and a plpgsql re-implementation would be a second — with the
  -- disagreement surfacing on a document that has already been filed. What the database asserts is
  -- the invariant that cannot drift: the two sum to the gross.
  line_net_fils    fils_nonneg not null,
  line_vat_fils    fils_nonneg not null,

  created_at       timestamptz not null default now(),

  primary key (invoice_id, line_no),
  constraint invoice_line_totals_reconcile
    check (line_net_fils + line_vat_fils = unit_gross_fils * quantity)
);

comment on table invoice_line is
  'One line of an issued document. Append-only: UPDATE and DELETE raise ZI003. Per-line VAT is the '
  'authoritative figure; the document total is the sum of these, never the other way round.';
comment on column invoice_line.line_vat_fils is
  'This line''s VAT, derived as line gross minus line net by splitGross() in @berelax/core. Rounded '
  'on the LINE gross, not per unit: a quantity of 3 at 11 fils is 33 gross carrying 2 fils of VAT, '
  'and rounding per unit would claim 3.';

create index invoice_line_invoice_id_idx on invoice_line (invoice_id);

-- ---------------------------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------------------------
create function refuse_invoice_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    '% is append-only; % is refused. Correct an issued invoice with a credit note, never by editing it.',
    tg_table_name, tg_op
    using errcode = 'ZI003';
end $$;

comment on function refuse_invoice_change() is
  'Raises ZI003. Fires for EVERY role, including the owner: the grants below constrain berelax_app, '
  'and a migration or a psql session does not connect as berelax_app.';

create trigger invoice_no_update before update on invoice
  for each row execute function refuse_invoice_change();
create trigger invoice_no_delete before delete on invoice
  for each row execute function refuse_invoice_change();
create trigger invoice_line_no_update before update on invoice_line
  for each row execute function refuse_invoice_change();
create trigger invoice_line_no_delete before delete on invoice_line
  for each row execute function refuse_invoice_change();

-- ---------------------------------------------------------------------------------------------
-- The totals invariant, DEFERRED to COMMIT
-- ---------------------------------------------------------------------------------------------
-- The header is inserted before its lines exist, so between the two statements the document's totals
-- do not match its (zero) lines by construction. An immediate trigger would reject every invoice ever
-- issued, and the only way to satisfy it would be to insert the header and all lines in one statement
-- and hope nobody ever writes the loop.
--
-- `deferrable initially deferred` moves the check to COMMIT: each INSERT succeeds and the transaction
-- fails as a whole. packages/db/src/repositories/invoice.itest.ts asserts exactly that shape — the
-- header with the re-derived VAT inserted successfully, the lines inserted successfully, the failure
-- arriving at COMMIT — because a test that failed on the first insert would have proved the opposite.
create function assert_invoice_totals_match_lines() returns trigger
language plpgsql
as $$
declare
  v_invoice_id uuid;
  v_lines      integer;
  v_net        bigint;
  v_vat        bigint;
  v_gross      bigint;
  h_net        bigint;
  h_vat        bigint;
  h_gross      bigint;
  h_number     text;
begin
  -- One function for both triggers. `invoice` carries the id as `id`, `invoice_line` as `invoice_id`.
  --
  -- An IF rather than a CASE expression: plpgsql resolves every field reference in an expression
  -- before evaluating the branch condition, so `case ... else new.invoice_id end` raises
  -- "record new has no field invoice_id" on the invoice trigger — every time, for every document.
  if tg_table_name = 'invoice' then
    v_invoice_id := new.id;
  else
    v_invoice_id := new.invoice_id;
  end if;

  select net_total, vat_total, gross_total, display_number
    into h_net, h_vat, h_gross, h_number
    from invoice
   where id = v_invoice_id;

  -- The foreign key makes a line without a header impossible, and this is stated anyway because of
  -- how the three tests below fail: `h_vat <> v_vat` against a NULL header evaluates to NULL rather
  -- than true, so every one of them would fall through and the guard would report success on the one
  -- shape it exists to catch.
  if h_number is null then
    raise exception 'InvoiceTotalsDisagree: no invoice header with id %', v_invoice_id
      using errcode = 'ZI001';
  end if;

  select count(*),
         coalesce(sum(line_net_fils), 0),
         coalesce(sum(line_vat_fils), 0),
         coalesce(sum(line_gross_fils), 0)
    into v_lines, v_net, v_vat, v_gross
    from invoice_line
   where invoice_id = v_invoice_id;

  -- An invoice with no lines states nothing and would commit with totals of zero, which reads as a
  -- legitimate zero-value document. It fires no line trigger at all, so only the header trigger can
  -- see it.
  if v_lines = 0 then
    raise exception 'InvoiceWithoutLines: invoice "%" has no lines', h_number
      using errcode = 'ZI002';
  end if;

  if h_vat <> v_vat then
    raise exception
      'InvoiceTotalsDisagree: invoice "%" states vat_total % fils; its % line(s) sum to % fils. '
      'A document total is the SUM of per-line VAT, never VAT re-derived from the document gross.',
      h_number, h_vat, v_lines, v_vat
      using errcode = 'ZI001';
  end if;

  if h_net <> v_net then
    raise exception
      'InvoiceTotalsDisagree: invoice "%" states net_total % fils; its % line(s) sum to % fils.',
      h_number, h_net, v_lines, v_net
      using errcode = 'ZI001';
  end if;

  if h_gross <> v_gross then
    raise exception
      'InvoiceTotalsDisagree: invoice "%" states gross_total % fils; its % line(s) sum to % fils.',
      h_number, h_gross, v_lines, v_gross
      using errcode = 'ZI001';
  end if;

  return null;
end $$;

comment on function assert_invoice_totals_match_lines() is
  'Raises ZI001 (totals disagree) or ZI002 (no lines) at COMMIT. Both triggers resolve the invoice id '
  'from their own row, so one function serves the header and the lines.';

create constraint trigger invoice_totals_match_lines
  after insert on invoice
  deferrable initially deferred
  for each row execute function assert_invoice_totals_match_lines();

create constraint trigger invoice_line_totals_match_lines
  after insert on invoice_line
  deferrable initially deferred
  for each row execute function assert_invoice_totals_match_lines();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 granted berelax_app select, insert, update and delete on every table in public AND set default
-- privileges that extend the same to every table created afterwards — so these two tables arrive with
-- UPDATE and DELETE already granted. An append-only table that forgets to revoke them is append-only
-- only for as long as nobody writes the statement.
grant select, insert on invoice, invoice_line to berelax_app;
revoke update, delete on invoice, invoice_line from berelax_app;

-- TRUNCATE is the one statement that fires no row-level DELETE trigger, so the refusal triggers above
-- would not see it. 0009 never granted it; stated explicitly because "it was never granted" and "we
-- checked" are different facts.
revoke truncate on invoice, invoice_line from berelax_app;

-- Redundant after the table-level revoke, and kept because it is the specific promise M-TILL-03 needs
-- from this unit: a series' prefix and padding remain editable configuration, and no change to them
-- can renumber an issued document, because the stored string is not writable by the application at
-- all. The column-level revoke says that about the column, where a reader of this file looks for it.
revoke update (display_number, number, period_key, series_code) on invoice from berelax_app;

-- Reporting reads documents and must never write them. 0009 grants it SELECT on everything in public;
-- UPDATE and DELETE were never granted, so there is nothing to revoke — stated for the same reason.
grant select on invoice, invoice_line to berelax_readonly;

-- ---------------------------------------------------------------------------------------------
-- The issuer, seeded so it cannot be issued
-- ---------------------------------------------------------------------------------------------
-- `legal_entity` had no row at all, which meant the first attempt to issue an invoice would fail with
-- "no such row" — a message that says nothing about what is missing. It now has one, carrying the real
-- legal name and trading name from docs/13 §1 and a TRN that is deliberately NOT a number.
--
-- 'TRN-PENDING-Y1-TRN' fails invoice_issuer_trn_is_fifteen_digits, fails
-- invoice_issuer_trn_not_placeholder, and fails requireIssuerTrn() in @berelax/core with
-- TrnNotConfigured. That is the point: the system must be unable to put a plausible-looking invented
-- registration number on a tax invoice, which is a misrepresentation to the customer and to the FTA.
-- Y1-trn closes by an UPDATE to this row with the real fifteen digits, and nothing else changes.
--
-- B-CAT-06 owns the full premises and catalogue seed. This is the identity minimum, and
-- `on conflict do nothing` so it neither fights that unit nor reverts an owner's entry on a re-run.
insert into legal_entity (id, legal_name, trading_name, trn, licensing_authority, emirate)
values (
  1,
  'BE RELAX SPA - L.L.C - O.P.C',
  'BE RELAX - Massage Center and Spa',
  'TRN-PENDING-Y1-TRN',
  'ADDED',
  'Abu Dhabi'
)
on conflict (id) do nothing;

commit;
