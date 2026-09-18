-- 0028 — purchases: suppliers, their tax profile, bills, bill lines and the payables aging buckets.
--
-- Purchases are where **input VAT recovery** lives, and recovery is the only reason this schema is
-- shaped the way it is. A UAE taxable person may reclaim the VAT a supplier charged only against a
-- valid tax invoice, and a tax invoice is only valid if it carries the supplier's TRN. So the one
-- question every row here has to be able to answer years later is: *did this bill support a claim,
-- and on what evidence?* Two consequences follow, and both are structural rather than procedural.
--
-- **A supplier with no TRN cannot support a claim, and a bill from one must still be postable.** An
-- unregistered supplier is not an error — below the registration threshold it is the normal case, and
-- a system that refused the bill would simply be a system the bookkeeper works around in a
-- spreadsheet. What must be impossible is *claiming* against it. Hence `supplier_tax_profile.trn`
-- nullable, `bill_line.tax_treatment` stating the claim per line, and three separate layers refusing a
-- recoverable line on a TRN-less bill: a CHECK on the bill, a trigger on the line, and the deferred
-- totals trigger that makes the header agree with the lines.
--
-- **The TRN is snapshotted onto the bill, not read through the supplier.** A supplier that registers
-- for VAT in March must not retroactively make January's bills recoverable, and one that
-- de-registers must not retroactively invalidate a claim already filed. The snapshot is taken by a
-- BEFORE INSERT trigger rather than passed in, so it cannot be typed in wrongly and cannot disagree
-- with the profile at the moment the bill was recorded.
--
-- ## Residency is stated, never inferred
--
-- `residency` is `not null` **with no default**, because there is no safe default. Defaulting to
-- domestic silently drops the reverse charge on every offshore bill — the single most commonly missed
-- obligation at this size (docs/04 §4) — and defaulting to offshore invents a reverse charge on the
-- landlord. A row that never stated its residency must fail to exist, which is what a `not null` with
-- no default means. The same argument makes `place_of_supply_rule` explicit: for an offshore supplier
-- the difference between an imported service (reverse charge, both VAT201 boxes) and a supply outside
-- the scope of UAE VAT (neither box) is not derivable from the supplier's address.
--
-- ## Immutability
--
-- `bill` and `bill_line` are append-only for the same reason `journal_entry` is (ADR 0017): they are
-- the evidence behind a filed return. A bill entered wrongly is answered by a dated reversal of its
-- journal entry and a fresh bill, and a supplier's correction arrives as their own credit note. In
-- particular the per-line **tax treatment is immutable**: reclassifying a line after the return that
-- included it has been filed would change a filed figure without leaving a trace, which is precisely
-- the failure the append-only journal exists to prevent. Settlement, when the payments unit lands,
-- will be an allocation row pointing at the bill — never an UPDATE of it.
--
-- ## Custom SQLSTATEs
--
-- Class 'ZV' is unused by PostgreSQL (Appendix A) and by the standard, which reserves I..Z for
-- user-defined conditions. 'ZL' is the ledger's (0018, 0027) and 'ZB' is booking's (0024).
--
--   ZV001  InputVatWithoutSupplierTrn — a recoverable line on a bill whose supplier had no TRN
--   ZV002  BillTotalsDoNotMatchLines  — the header summary disagrees with the lines (raised at COMMIT)
--   ZV003  SupplierHasNoTaxProfile    — a supplier with no explicit residency
--   ZV004  bill/bill_line is append-only; UPDATE or DELETE was refused
--
-- Matched on the code and never on the message, because a wording change must not silently stop a
-- caller recognising the refusal — the code that then treats a missing TRN as an unknown failure is
-- the code that retries it.
--
-- See docs/04-uae-compliance.md §4, docs/03-modules.md §7, ADR 0007 and ADR 0017.

begin;

-- ---------------------------------------------------------------------------------------------
-- The supplier
-- ---------------------------------------------------------------------------------------------
-- Suppliers are companies. There is no contact person here and no invented name: the business's real
-- supplier list is an import (H-MIG), and a fixture that looks like production data gets exported to a
-- spreadsheet and then believed (packages/fixtures/src/synthetic.ts).
create table supplier (
  supplier_id  uuid        primary key default uuid_generate_v7(),
  -- A stable handle for a seed, a recurring-cost definition (M-VAT-04) and a test fixture. The uuid is
  -- the key; this is what a human and a migration refer to, and it never changes.
  code         text        not null unique check (code ~ '^[a-z0-9][a-z0-9-]*$'),
  legal_name   text        not null check (btrim(legal_name) <> ''),
  -- Null when the supplier trades under its legal name. Not an empty string: '' and NULL would be two
  -- spellings of the same fact and every display would have to handle both.
  trading_name text        check (trading_name is null or btrim(trading_name) <> ''),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table supplier is
  'One row per supplier. Every supplier has exactly one supplier_tax_profile, enforced at COMMIT by '
  'supplier_has_tax_profile — a supplier with no stated residency is how an offshore bill silently '
  'loses its reverse charge.';
comment on column supplier.code is
  'Stable handle used by seeds, recurring-cost definitions and fixtures. The uuid is the key.';

create trigger supplier_updated_at before update on supplier
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- The tax profile
-- ---------------------------------------------------------------------------------------------
-- A separate table rather than columns on `supplier`, because the two are asked about differently: the
-- name and the code are administrative and change freely, while residency, the place-of-supply rule
-- and the TRN are the facts a VAT return is built on. Keeping them in their own row makes "every
-- supplier has an explicit tax position" a constraint that can be stated (below) rather than a habit.
create table supplier_tax_profile (
  -- The primary key IS the foreign key: exactly one profile per supplier, enforced by the shape
  -- instead of by a unique index somebody could later drop.
  supplier_id          uuid        primary key references supplier (supplier_id),
  -- NOT NULL AND NO DEFAULT. See the header: there is no safe default, and a row that never stated
  -- its residency must fail to exist rather than read as whichever value the schema picked.
  residency            text        not null check (residency in ('domestic', 'offshore')),
  -- How the supply is treated for UAE VAT. Stated rather than derived from residency, because an
  -- offshore supplier's supply is either an imported service (reverse charge, appearing in both VAT201
  -- boxes) or outside the scope of UAE VAT entirely, and nothing about the supplier says which.
  place_of_supply_rule text        not null check (place_of_supply_rule in (
                         'domestic_uae', 'imported_services_reverse_charge', 'outside_scope')),
  -- The supplier's UAE Tax Registration Number, or NULL for a supplier that is not registered.
  --
  -- NULL is a decision, not an omission: below the registration threshold an unregistered supplier is
  -- the normal case. What it cannot do is support a recoverable input claim, which is enforced on the
  -- bill and on the line rather than here, because the fact that matters is the TRN **at the time of
  -- the bill** and not today's.
  --
  -- 15 digits, which is the published TRN format. [UNVERIFIED] the check-digit rule, so the pattern
  -- validates length and alphabet only: refusing a real TRN because our arithmetic was wrong would
  -- block a legitimate claim, which is worse than accepting a typo the FTA will query.
  trn                  text        check (trn is null or trn ~ '^[0-9]{15}$'),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- A UAE TRN on an offshore supplier is a contradiction: the TRN is what makes a UAE tax invoice
  -- valid, and an offshore supplier does not issue one. In practice this row is a supplier marked
  -- offshore by mistake — the mistake that also loses the reverse charge.
  constraint supplier_tax_profile_offshore_holds_no_uae_trn
    check (residency <> 'offshore' or trn is null),
  -- A domestic supply takes place in the UAE; an offshore one is an import or out of scope. Stating
  -- both columns and constraining the pair is what stops 'domestic' + reverse charge, which would
  -- self-account for VAT the supplier already charged and claim it twice.
  constraint supplier_tax_profile_rule_matches_residency check (
    case residency
      when 'domestic' then place_of_supply_rule = 'domestic_uae'
      else place_of_supply_rule in ('imported_services_reverse_charge', 'outside_scope')
    end
  )
);

comment on table supplier_tax_profile is
  'The VAT position of one supplier: residency, place-of-supply rule and TRN. residency is not null '
  'with NO DEFAULT — defaulting it to domestic drops the reverse charge on every offshore bill, and '
  'defaulting it to offshore invents one on the landlord.';
comment on column supplier_tax_profile.trn is
  'The supplier UAE TRN, or NULL for an unregistered supplier. NULL is a decision: an unregistered '
  'supplier is normal below the threshold, and a bill from one is postable but supports no claim.';
comment on column supplier_tax_profile.residency is
  'domestic | offshore. No default, deliberately: see the table comment.';

create trigger supplier_tax_profile_updated_at before update on supplier_tax_profile
  for each row execute function set_updated_at();

-- The population M-VAT-03's nightly reverse-charge exception report scans.
create index supplier_tax_profile_offshore_idx
  on supplier_tax_profile (supplier_id) where residency = 'offshore';

-- Every supplier has a tax profile, checked at COMMIT.
--
-- DEFERRED, because the profile is a second INSERT: an immediate trigger would refuse every supplier
-- ever created. Deferring it to COMMIT is what makes "explicit residency" a property of the database
-- rather than of the one code path that happens to insert both rows.
create function assert_supplier_has_tax_profile() returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from supplier_tax_profile p where p.supplier_id = new.supplier_id) then
    return null;
  end if;
  raise exception
    'SupplierHasNoTaxProfile: supplier "%" has no supplier_tax_profile, so its residency is unstated',
    new.code
    using errcode = 'ZV003',
          hint = 'Insert the tax profile in the same transaction: residency has no default.';
end $$;

comment on function assert_supplier_has_tax_profile() is
  'Raises ZV003 at COMMIT. Deferred because the profile arrives as a second INSERT; an immediate '
  'trigger would refuse every supplier ever created.';

create constraint trigger supplier_has_tax_profile
  after insert on supplier
  deferrable initially deferred
  for each row execute function assert_supplier_has_tax_profile();

-- ---------------------------------------------------------------------------------------------
-- The bill
-- ---------------------------------------------------------------------------------------------
create table bill (
  bill_id            uuid        primary key default uuid_generate_v7(),
  supplier_id        uuid        not null references supplier (supplier_id),
  -- The supplier's own document number, as printed on their invoice. Their range, not ours: it has
  -- gaps, restarts, letters and duplicates across suppliers, which is why we keep our own alongside it.
  supplier_reference text        not null check (btrim(supplier_reference) <> ''),

  -- Our own gapless internal reference, allocated by allocate_document_number() from the counter row
  -- in document_series (0013, ADR 0023) inside the transaction that inserts this bill. A sequence
  -- would leak a number on every rolled-back bill, and the columns are named exactly as
  -- NUMBERING_LEDGER_COLUMNS in packages/db/src/repositories/numbering.ts requires so the gap report
  -- reads this table without a second implementation.
  --
  -- A purchase bill is not a statutory document of ours — the statutory document is the supplier's
  -- invoice. The reference is gap-free anyway, because a missing number in our own range is a bill
  -- somebody removed, and "the bookkeeper deleted it" is not a record.
  series_code        text        not null references document_series (code),
  period_key         text        not null,
  number             bigint      not null check (number >= 1),
  display_number     text        not null unique,

  -- The supplier's tax position AT THE TIME OF THE BILL, snapshotted by bill_supplier_tax_snapshot
  -- below rather than passed in. A supplier that registers for VAT in March must not retroactively
  -- make January's bills recoverable, and one that de-registers must not invalidate a filed claim.
  supplier_trn       text        check (supplier_trn is null or supplier_trn ~ '^[0-9]{15}$'),
  supplier_residency text        not null check (supplier_residency in ('domestic', 'offshore')),

  -- The supplier's invoice date: the tax point, and what their own records call this document.
  bill_date          date        not null,
  -- When payment falls due. The only input to the payables aging buckets, which is why it is not
  -- nullable: a payable with no due date is a payable that never appears as overdue.
  due_date           date        not null,

  -- The journal entry this bill posted. NOT NULL: a bill in this system is a posted document, and one
  -- row per entry — unique, because two bills sharing an entry would double the payable. The business
  -- day the entry belongs to lives on the entry (journal_entry.entry_date, already resolved by the
  -- caller with resolveTradingDate) and is deliberately not copied here: two copies of a date that
  -- decides which VAT period a figure lands in is one copy plus a future disagreement.
  entry_id           text        not null unique references journal_entry (entry_id),

  currency           text        not null default 'AED' check (currency = 'AED'),
  -- Integer fils, VAT-inclusive gross authoritative (ADR 0007). The header is a SUMMARY of the lines,
  -- not a second source of truth: bill_totals_match_lines refuses at COMMIT if it disagrees.
  net_fils           fils_nonneg not null,
  gross_fils         fils_nonneg not null,
  -- Derived by the database as gross - net, so `net + vat = gross` holds by construction and no
  -- caller can round the two sides independently. This is ADR 0007's derivation expressed as a column
  -- rather than as a rule somebody has to remember.
  vat_fils           fils_nonneg not null generated always as (gross_fils - net_fils) stored,
  -- The input VAT this bill supports a claim for: the sum of its recoverable lines, and zero for a
  -- bill from a supplier with no TRN.
  recoverable_input_vat_fils fils_nonneg not null,
  -- Who entered it. A label, not a uuid: the audit_event row written in the same transaction carries
  -- the full actor and request context (F06).
  received_by        text        not null check (btrim(received_by) <> ''),
  created_at         timestamptz not null default now(),

  -- The duplicate every accounts-payable process exists to catch: the same supplier invoice entered
  -- twice, which pays it twice and claims its VAT twice. Scoped per supplier, because two suppliers
  -- numbering their invoices '001' is not a duplicate.
  constraint bill_supplier_reference_unique unique (supplier_id, supplier_reference),
  -- Our own range, gap-free per series and period.
  constraint bill_internal_number_unique unique (series_code, period_key, number),

  constraint bill_gross_positive check (gross_fils > 0),
  constraint bill_net_positive check (net_fils > 0),
  constraint bill_gross_not_below_net check (gross_fils >= net_fils),
  constraint bill_recoverable_not_above_vat
    check (recoverable_input_vat_fils <= gross_fils - net_fils),
  -- A one-day credit period is legitimate; a due date before the invoice date is a typo that would
  -- make a brand-new bill 30 days overdue in the aging report.
  constraint bill_due_not_before_bill_date check (due_date >= bill_date),
  -- The rule this whole migration is about, as a row-level CHECK so it holds for every role and
  -- survives any trigger being dropped: no TRN, no claim.
  constraint bill_recoverable_needs_a_trn
    check (recoverable_input_vat_fils = 0 or supplier_trn is not null)
);

comment on table bill is
  'A supplier bill, posted. Append-only: UPDATE and DELETE raise (ADR 0017), because this is the '
  'evidence behind a filed return. A wrong bill is answered by a dated reversal of its journal entry '
  'plus a fresh bill; settlement will be an allocation row, never an UPDATE of this one.';
comment on column bill.supplier_trn is
  'The supplier TRN as it stood when the bill was recorded, set by trigger from supplier_tax_profile. '
  'NULL means the supplier was not registered then, and bill_recoverable_needs_a_trn makes that a '
  'zero claim — a later registration cannot reach back and make January recoverable.';
comment on column bill.vat_fils is
  'Derived as gross - net (ADR 0007), so net + vat = gross exactly and neither side can be rounded '
  'independently.';
comment on column bill.due_date is
  'The only input to the payables aging buckets. See payables_aging_bucket().';

create index bill_supplier_idx on bill (supplier_id, bill_date desc);
-- The aging query's scan: every bill ordered by when it fell due.
create index bill_due_date_idx on bill (due_date);

create table bill_line (
  bill_id              uuid        not null references bill (bill_id),
  -- Position within the bill, so two runs over the same bill produce byte-identical working papers.
  line_no              smallint    not null check (line_no >= 1),
  description          text        not null check (btrim(description) <> ''),
  -- Which expense this is. A foreign key to the chart, so a mistyped code fails at the INSERT rather
  -- than appearing in the trial balance as an account nobody recognises.
  expense_account_code text        not null references account (code),

  -- The per-line tax treatment, IMMUTABLE once written (see the table comment). Stated per line and
  -- not per bill, because one bill routinely mixes them: a utilities invoice carrying a standard-rated
  -- supply and an out-of-scope government fee is the ordinary case, and a bill-level treatment would
  -- force the preparer to split it by hand or to claim the wrong figure.
  --
  --   standard_recoverable     5% UAE VAT from a TRN-holding supplier; the VAT is recoverable
  --   no_trn_not_recoverable   the supplier is not registered, so nothing is claimable and the whole
  --                            amount is cost
  --   zero_rated               a zero-rated supply: VAT is 0 and there is nothing to claim
  --   exempt                   an exempt supply: no VAT was chargeable
  --   out_of_scope             outside the scope of UAE VAT, e.g. a supply made and consumed abroad
  --
  -- Two treatments are deliberately ABSENT rather than declared and unimplemented: blocked input VAT
  -- (entertainment, M-VAT-02) and the imported-services reverse charge (M-VAT-03). Each needs posting
  -- behaviour this unit does not have — VAT to expense for the first, a self-accounted pair for the
  -- second — and a value this schema accepts but no code path posts correctly is worse than a value
  -- that does not exist: the bill would be recorded, look complete, and understate the return. Adding
  -- one is a migration, which is the same answer 0013 gives for a new document series.
  tax_treatment        text        not null check (tax_treatment in (
                         'standard_recoverable', 'no_trn_not_recoverable',
                         'zero_rated', 'exempt', 'out_of_scope')),
  -- The rate the supplier charged, in basis points: 500 is 5%. Held as data rather than assumed,
  -- because the rate is the authority's to set and a filed line must keep the rate it was filed at.
  vat_rate_bp          smallint    not null check (vat_rate_bp between 0 and 10000),

  net_fils             fils_nonneg not null,
  gross_fils           fils_nonneg not null,
  vat_fils             fils_nonneg not null generated always as (gross_fils - net_fils) stored,
  recoverable_input_vat_fils fils_nonneg not null,
  created_at           timestamptz not null default now(),

  primary key (bill_id, line_no),

  constraint bill_line_net_positive check (net_fils > 0),
  constraint bill_line_gross_not_below_net check (gross_fils >= net_fils),
  -- Only a standard-rated line carries VAT. An unregistered supplier cannot charge VAT at all, and a
  -- zero-rated, exempt or out-of-scope supply has none — so a gross above net on any of those is an
  -- amount the preparer has mis-described, and it is the description that decides what is claimed.
  constraint bill_line_only_a_standard_rated_line_carries_vat
    check (tax_treatment = 'standard_recoverable' or gross_fils = net_fils),
  constraint bill_line_rate_matches_treatment
    check (tax_treatment = 'standard_recoverable' or vat_rate_bp = 0),
  -- The claim is the line's own VAT, or nothing. Written on the line rather than recomputed at return
  -- time, so the figure in a filed VAT201 can be traced to the row that produced it.
  constraint bill_line_recoverable_matches_treatment check (
    recoverable_input_vat_fils =
      case when tax_treatment = 'standard_recoverable' then gross_fils - net_fils else 0 end
  )
);

comment on table bill_line is
  'One line of a supplier bill, carrying its own immutable tax treatment. Append-only: UPDATE and '
  'DELETE raise. Reclassifying a line after the return that included it was filed would change a '
  'filed figure with no trace, which is the failure ADR 0017 exists to prevent.';
comment on column bill_line.tax_treatment is
  'The claim this line supports, stored on the line and never recomputed. blocked input VAT '
  '(M-VAT-02) and the imported-services reverse charge (M-VAT-03) are absent on purpose: a value no '
  'code path posts correctly would record a bill that looks complete and understates the return.';

-- The VAT201 working papers group by account, and M-VAT-02 enumerates the chart against these lines.
create index bill_line_account_idx on bill_line (expense_account_code, bill_id);

-- ---------------------------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------------------------
-- A trigger that RAISES, not `create rule ... do instead nothing`: a rule reports success, and code
-- that UPDATEs a bill is code that believes it corrected a filed figure. It must be told that it did
-- not. Same reasoning, and same shape, as refuse_journal_change() in 0018.
--
-- Fires for EVERY role including the owner. The revokes below cover the application role; a
-- migration, a psql session and a future admin tool connect as the owner, and the owner is who
-- rewrites history by hand at 2am.
create function refuse_purchase_document_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    '% is append-only; % is refused. A wrong bill is answered by a dated reversal and a fresh bill.',
    tg_table_name, tg_op
    using errcode = 'ZV004';
end $$;

comment on function refuse_purchase_document_change() is
  'Raises ZV004 for bill and bill_line, for every role. The tax treatment of a filed line is not '
  'editable, which is the whole point of storing it on the line.';

create trigger bill_no_update before update on bill
  for each row execute function refuse_purchase_document_change();
create trigger bill_no_delete before delete on bill
  for each row execute function refuse_purchase_document_change();
create trigger bill_line_no_update before update on bill_line
  for each row execute function refuse_purchase_document_change();
create trigger bill_line_no_delete before delete on bill_line
  for each row execute function refuse_purchase_document_change();

-- ---------------------------------------------------------------------------------------------
-- The supplier tax snapshot
-- ---------------------------------------------------------------------------------------------
-- Assigns `supplier_trn` and `supplier_residency` from the profile, overwriting whatever the caller
-- supplied. Overwriting rather than validating, because a snapshot that can be passed in is a
-- snapshot that can be typed in: one digit of a TRN nobody will ever check again is all it takes to
-- support a claim the FTA will disallow. With the value assigned here the bill's evidence and the
-- profile cannot disagree about the moment the bill was recorded.
create function bill_supplier_tax_snapshot() returns trigger
language plpgsql
as $$
declare
  v_residency text;
  v_trn       text;
  v_found     boolean;
begin
  select p.residency, p.trn, true
    into v_residency, v_trn, v_found
    from supplier_tax_profile p
   where p.supplier_id = new.supplier_id;

  if v_found is not true then
    -- The deferred trigger on `supplier` also catches this, at COMMIT. This one catches the bill
    -- inserted in the same transaction as its supplier, before the profile row exists — and it names
    -- the bill, which is what the person entering it is looking at.
    raise exception
      'SupplierHasNoTaxProfile: supplier % has no tax profile, so bill "%" has no stated residency',
      new.supplier_id, new.supplier_reference
      using errcode = 'ZV003';
  end if;

  new.supplier_residency := v_residency;
  new.supplier_trn       := v_trn;
  return new;
end $$;

comment on function bill_supplier_tax_snapshot() is
  'Sets bill.supplier_trn and bill.supplier_residency from the profile, ignoring what the caller '
  'passed. A snapshot that can be passed in can be typed in, and one wrong digit supports a claim '
  'the FTA will disallow.';

create trigger bill_supplier_tax_snapshot before insert on bill
  for each row execute function bill_supplier_tax_snapshot();

-- ---------------------------------------------------------------------------------------------
-- No claim without a tax invoice
-- ---------------------------------------------------------------------------------------------
-- `bill_recoverable_needs_a_trn` already refuses a recoverable TOTAL on a TRN-less bill. This refuses
-- the recoverable LINE, at the statement that wrote it, naming the line — and it closes the hole the
-- CHECK cannot see: a header summary of zero with a recoverable line underneath it, which would
-- otherwise fail at COMMIT with "the totals do not match the lines" and send the reader looking for
-- an arithmetic error rather than a missing tax invoice.
create function assert_recoverable_line_has_a_tax_invoice() returns trigger
language plpgsql
as $$
declare
  v_trn text;
begin
  if new.recoverable_input_vat_fils = 0 then
    return new;
  end if;

  select b.supplier_trn into v_trn from bill b where b.bill_id = new.bill_id;
  if v_trn is not null then
    return new;
  end if;

  raise exception
    'InputVatWithoutSupplierTrn: line % claims % fils of input VAT, but the supplier held no TRN '
    'when the bill was recorded, so there is no valid tax invoice to claim against',
    new.line_no, new.recoverable_input_vat_fils
    using errcode = 'ZV001',
          hint = 'Record the line as no_trn_not_recoverable: the amount is cost, not a claim.';
end $$;

create trigger bill_line_recoverable_needs_a_tax_invoice before insert on bill_line
  for each row execute function assert_recoverable_line_has_a_tax_invoice();

comment on function assert_recoverable_line_has_a_tax_invoice() is
  'Raises ZV001. The line-level half of the no-TRN-no-claim rule; the row-level CHECK on bill is the '
  'other half, and neither sees what the other does.';

-- ---------------------------------------------------------------------------------------------
-- The header is a summary of the lines, checked at COMMIT
-- ---------------------------------------------------------------------------------------------
-- The header totals exist because a payable is a header-level fact: the aging report, the supplier
-- statement and the cash-flow forecast all ask "how much is outstanding on this bill", and making
-- each of them sum the lines is how two reports come to disagree. They are a summary, not a second
-- truth, and this is what makes the difference real rather than asserted.
--
-- DEFERRED, for exactly the reason 0018's balance trigger is: the lines arrive as separate INSERTs,
-- so between the header and its last line the bill is transiently inconsistent by construction. An
-- immediate trigger would reject every bill ever entered.
create function assert_bill_totals_match_lines() returns trigger
language plpgsql
as $$
declare
  -- `new.bill_id` on both tables: the header's own key and the line's parent are the same column name,
  -- which is what lets one function serve both triggers.
  v_bill_id    uuid := new.bill_id;
  v_net        bigint;
  v_gross      bigint;
  v_recoverable bigint;
  v_lines      integer;
  v_h_net      bigint;
  v_h_gross    bigint;
  v_h_recover  bigint;
begin
  select b.net_fils, b.gross_fils, b.recoverable_input_vat_fils
    into v_h_net, v_h_gross, v_h_recover
    from bill b where b.bill_id = v_bill_id;
  -- The bill is gone, which can only happen inside a transaction that also removed it. Nothing to
  -- check, and raising here would refuse a legitimate rollback path.
  if not found then
    return null;
  end if;

  select coalesce(sum(l.net_fils), 0), coalesce(sum(l.gross_fils), 0),
         coalesce(sum(l.recoverable_input_vat_fils), 0), count(*)
    into v_net, v_gross, v_recoverable, v_lines
    from bill_line l where l.bill_id = v_bill_id;

  -- A bill with no lines describes nothing. It fires no line trigger at all, which is why the header
  -- carries its own copy of this constraint trigger: without it, an empty bill would commit and sit
  -- in the payables ledger as a demand for money with no stated reason.
  if v_lines = 0 then
    raise exception 'BillTotalsDoNotMatchLines: bill % has no lines', v_bill_id
      using errcode = 'ZV002';
  end if;

  if v_net <> v_h_net or v_gross <> v_h_gross or v_recoverable <> v_h_recover then
    raise exception
      'BillTotalsDoNotMatchLines: bill % header says net %, gross %, recoverable % but its % line(s) '
      'sum to net %, gross %, recoverable %',
      v_bill_id, v_h_net, v_h_gross, v_h_recover, v_lines, v_net, v_gross, v_recoverable
      using errcode = 'ZV002';
  end if;

  return null;
end $$;

comment on function assert_bill_totals_match_lines() is
  'Raises ZV002 at COMMIT. Both triggers read new.bill_id, which bill and bill_line both carry, so '
  'one function serves both — the same arrangement as assert_entry_balanced() in 0018.';

create constraint trigger bill_totals_match_lines
  after insert on bill
  deferrable initially deferred
  for each row execute function assert_bill_totals_match_lines();

create constraint trigger bill_line_totals_match_bill
  after insert on bill_line
  deferrable initially deferred
  for each row execute function assert_bill_totals_match_lines();

-- ---------------------------------------------------------------------------------------------
-- Payables aging
-- ---------------------------------------------------------------------------------------------
-- The bucket a payable falls in, given a date to age it against.
--
-- `p_as_of` is a PARAMETER, never `current_date`. Every figure in this system has to be reproducible:
-- an aging report that read the clock would give a different answer tomorrow for the same closed
-- period, and the committed worked example in packages/fixtures/src/purchases.ts could not exist.
--
-- The boundaries are stated once, here, and mirrored by `payablesBucketFor` in
-- packages/core/src/purchases/payables-aging.ts — packages/db must not import packages/core, so the
-- rule has two statements and packages/fixtures/src/purchases.itest.ts asserts they agree over every
-- boundary day. The same arrangement, for the same reason, as price_list and resolve-price.ts.
--
-- Five buckets, where the acceptance names four (current/30/60/90+). The fifth exists because a
-- bucket labelled "90+" that actually holds a 75-day payable misstates the oldest debt in the
-- business, and the oldest debt is the only figure anybody reads an aging report for.
create function payables_aging_bucket(p_due_date date, p_as_of date) returns text
language sql
immutable
strict
as $$
  select case
    -- Due today is current. `p_as_of - p_due_date` is days overdue, and a payable due today is not
    -- overdue by anything — an off-by-one here puts every bill due today into the 1-30 bucket.
    when p_as_of - p_due_date <= 0  then 'current'
    when p_as_of - p_due_date <= 30 then 'days_1_30'
    when p_as_of - p_due_date <= 60 then 'days_31_60'
    when p_as_of - p_due_date <= 90 then 'days_61_90'
    else 'days_over_90'
  end
$$;

comment on function payables_aging_bucket(date, date) is
  'The aging bucket of one payable as at a date. The date is a parameter and never current_date: a '
  'report that read the clock could not be reproduced for a closed period.';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 granted the application role select, insert, update and delete on every table in public and
-- set default privileges to extend that to tables created later, so these four tables arrive with
-- UPDATE and DELETE already granted. An append-only table that forgets to revoke them is append-only
-- by convention only.
grant select, insert on bill, bill_line to berelax_app;
revoke update, delete on bill, bill_line from berelax_app;
-- TRUNCATE fires no row-level trigger, so it is the one statement that could empty these tables past
-- the refusals above. 0009 never granted it by name; revoking it says so out loud.
revoke truncate on bill, bill_line from berelax_app;

-- A supplier's name and its tax profile are configuration, and an admin corrects them: a TRN arrives
-- when the supplier registers, and a name is misspelled on the day it is created. So UPDATE is held
-- here, unlike on the bill — and the bill's snapshot is what stops a correction reaching a filed
-- claim.
grant select, insert, update on supplier, supplier_tax_profile to berelax_app;
-- A supplier referenced by a bill cannot be removed anyway (the foreign key refuses), and removing an
-- unused one is a migration. DELETE would only ever succeed on the row nobody has billed yet, which
-- is not worth a privilege that also permits the other case once a future column changes.
revoke delete, truncate on supplier, supplier_tax_profile from berelax_app;

revoke execute on function payables_aging_bucket(date, date) from public;
grant execute on function payables_aging_bucket(date, date) to berelax_app, berelax_readonly;

-- ---------------------------------------------------------------------------------------------
-- Our own numbering series for bills
-- ---------------------------------------------------------------------------------------------
-- 0013 created document_series for the three statutory ranges and constrained `document_kind` to
-- them. A bill joins it as a fourth kind rather than getting a counter of its own: the row-locked
-- counter is the one mechanism ADR 0023 argues for, and a second implementation of it would be a
-- second thing that can leak a number.
--
-- The check is dropped and re-added under a NAME, so the next kind extends it by name instead of
-- guessing what PostgreSQL called the anonymous one.
alter table document_series drop constraint if exists document_series_document_kind_check;
alter table document_series add constraint document_series_document_kind_allowed
  check (document_kind in ('tax_invoice', 'simplified_invoice', 'credit_note', 'supplier_bill'));

-- `reset_policy = 'never'`, unlike the three statutory ranges, and the difference is load-bearing.
--
-- `document_series` holds ONE counter and ONE `period_key` per series, so under the 'annual' policy a
-- document dated in a new period resets the counter — and a document dated back in the OLD period then
-- restarts that period's range and re-issues a number already used. For an invoice that is hypothetical:
-- we issue invoices in date order, as they happen. For a purchase bill it is the normal case — a supplier
-- invoice dated last December arrives in January, and last year's bill is entered after this year's. It
-- was found exactly that way: `bill_internal_number_unique` refused the second BILL-2026-00001 after a
-- 2027-dated bill had moved the counter, which is the constraint doing its job and a series nobody could
-- post to.
--
-- An unbroken range costs nothing here. This is our own internal reference, not a statutory range whose
-- numbering a tax authority reads per year, and a monotonic counter is gap-free whatever order the
-- invoices are dated in. 'BILL-00001' it is.
insert into document_series (code, document_kind, prefix, padding, reset_policy) values
  ('SUPP-BILL', 'supplier_bill', 'BILL-', 5, 'never')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------------------------
-- The seeded suppliers
-- ---------------------------------------------------------------------------------------------
-- The five offshore vendors this build actually buys from, named in docs/04 §4 and docs/05. They are
-- seeded because their residency is a fact the system must not be able to get wrong: an offshore
-- supplier marked domestic loses the reverse charge, which is the most commonly missed UAE VAT
-- obligation at this size and is incurred from the first invoice.
--
-- `legal_name` is the vendor name as the build knows it from docs/05, not a registered company name —
-- the registered entity and its address arrive with the first invoice (H-MIG). What matters here is
-- settled either way: none of them is established in the UAE, so none can issue a UAE tax invoice,
-- and their VAT is self-accounted rather than claimed from them.
--
-- **No domestic supplier is seeded.** The real list — landlord, utilities, laundry, consumables — is
-- an open question answered at import, and a seeded placeholder would put a company that does not
-- exist into the books, where it would be exported, demoed and eventually believed. The domestic
-- paths are exercised by suppliers the tests create, which is the same choice
-- packages/fixtures/src/synthetic.ts makes about people.
--
-- SMSala is deliberately absent: docs/04 says "SMSala if billed offshore", so its residency is
-- unknown, and guessing it is how a supplier ends up marked domestic by default.
insert into supplier (code, legal_name) values
  ('digitalocean', 'DigitalOcean'),
  ('resend',       'Resend'),
  ('google',       'Google'),
  ('meta',         'Meta'),
  ('anthropic',    'Anthropic')
on conflict (code) do nothing;

insert into supplier_tax_profile (supplier_id, residency, place_of_supply_rule, trn)
select s.supplier_id, 'offshore', 'imported_services_reverse_charge', null
  from supplier s
 where s.code in ('digitalocean', 'resend', 'google', 'meta', 'anthropic')
on conflict (supplier_id) do nothing;

commit;
