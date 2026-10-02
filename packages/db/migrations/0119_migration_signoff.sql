-- 0119_migration_signoff.sql — H-MIG-03
--
-- The owner sign-off, and the shape a RECONSTRUCTED package liability has.
--
-- H-MIG-01 created the staging ledger and deliberately left two things to this unit: the sign-off row
-- (0111's header — "a table with no unit deciding who may sign and what a signature covers would be a
-- shape for somebody else to work around") and the hash it attests to, which is already there:
-- `import_run.source_file_hash`, the sha-256 of the file's bytes. H-MIG-02 built the workbook and the
-- validator and left the `apply` half, the attestation flag and the liability report. This file is the
-- database half of that `apply`.
--
-- ============================================================================================
-- 1. What a reconstructed sale IS, which is the decision in this file
-- ============================================================================================
--
-- A reconstructed package was sold before these books existed. `package_sale` therefore records what is
-- still OUTSTANDING — the sessions the holder may still take and what they are worth — and NOT the package
-- as it was sold. What was sold, what has been taken, what was paid, when, and on what evidence are facts
-- about the RECONSTRUCTION, and they live on `imported_package_sale` beside it, in the workbook's own
-- figures.
--
-- That is not a convenience. The sessions a reconstruction says were taken were delivered under the
-- previous arrangement, against no appointment in this database, and 0083's ZG009 is right that a drawdown
-- here must have a `package_redemption` behind it — because a redemption posts the release through `4020`
-- and `2030` (ZG008), which would be output VAT on a supply that happened before this system traded. There
-- is no honest way to write the already-taken sessions into `package_balance.sessions_redeemed`, so they
-- are not written there at all: the entitlement that arrives is the one that remains.
--
-- Two consequences, both stated because somebody will meet them:
--
--   * **A fully drawn package imports with NO `package_sale` at all.** Nothing is outstanding, so there is
--     no liability, no balance and no posting — and `package_balance.value_fils > 0` and
--     `sessions_total >= 1` would refuse a sale of nothing anyway. The row still arrives, as an
--     `imported_package_sale` with no sale, because the cash was received (it belongs in the
--     reconciliation) and because the history is what the holder will ask about. H-MIG-02's clean fixture
--     carries such a row deliberately.
--   * **"How many did I buy?" is answered from the reconstruction record, not from `package_balance`.**
--     The desk's question — how many are left — is answered by the balance, and is right. Both figures
--     exist; they are in the two places that can each be read for what they are.
--
-- ============================================================================================
-- 2. The three rules that had to change, and the one that is REPLACED
-- ============================================================================================
--
--   * **`expires_on` stops being GENERATED** (0078 derived it from `trading_date + validity_months`). A
--     reconstruction's expiry is the date the holder's own copy carries — which is why H-MIG-02 asks for
--     it as a column rather than deriving it: the validity was an assumption when the package was sold and
--     may not have been six months. What replaces the expression is a trigger that derives the same date
--     for every sale that is not a reconstruction, so M-TILL-09's sell path supplies nothing and gets what
--     it always got (ZY253 refuses a caller that states a different one, rather than overwriting it), and
--     ZY254 makes the column immutable afterwards — which 0078 could leave to the generated expression and
--     cannot any more.
--   * **ZG002 is exempted for a reconstruction, and REPLACED by ZY257.** It holds a sale's price, validity,
--     transferability, balance policy and session count equal to the template version it names. A
--     reconstruction's price is what the customer handed over — H-MIG-02's workbook says so on its face
--     ("Not the template price — what this customer handed over, including any discount nobody recorded")
--     and its clean fixture carries a row paid at 95,000 against a configured 100,000 — and its session
--     count is what remains. So the sale is held to the ATTESTATION instead: ZY257 requires its price, its
--     session count and its expiry to be the figures the workbook row carries, computed from them by
--     0083's own release formula and not by a second arithmetic. The exemption is one branch and nothing
--     else in that function moves; gate case 147i breaks a till sale's price and requires ZG002 back, so
--     the guard is shown to have survived being edited.
--   * **Nothing else changes.** ZG005 (the posting is a pure deferred-revenue posting), ZG006 (one balance
--     per line of the version, summing to the price), ZG009 (a drawdown has a redemption behind it) and
--     ZG010 (a redemption is in time, read off `expires_on`) are untouched and hold for a reconstruction
--     exactly as they do for a till sale. ZG005 in particular is what makes H-MIG-03's third acceptance
--     line — no output VAT at import — a property of the database rather than of this file.
--
-- ============================================================================================
-- 3. The posting
-- ============================================================================================
--
--     Dr  3030  Retained earnings              what is still owed
--       Cr  2050  Deferred revenue — packages      the same
--
-- One entry per reconstructed sale, dated on the opening date, `source = 'opening_balance'`, and ZG005
-- holds it: it credits `2050` by exactly the sale's price — which here IS the outstanding liability — and
-- moves nothing on any revenue account and nothing on `2030`. So the sum of `2050` after the import is the
-- sum of what is outstanding, to the fils, which is H-MIG-03's first acceptance line.
--
-- `source = 'opening_balance'` is not a label: ZL004 (0027) refuses any entry dated before the books open
-- except an opening balance and a reversal, and this is one. The counterpart is `3030 Retained earnings`
-- and NOT cash: the money was received in a period these books do not contain, so the other side of the
-- entry is opening equity. The CASH is H-MIG-07's opening asset — its acceptance line says the opening
-- balance sheet "ties to the H-MIG-03 package liability, cash and bank to the fils" — and
-- `artifacts/migration/package-liability.json` carries the figure it has to include. Debiting cash here
-- would double it the moment H-MIG-07 imports the opening trial balance, which is the one error in an
-- opening position that is undetectable afterwards: the books still balance.
--
-- The already-delivered part of every package is in opening retained earnings by construction, because
-- only the outstanding part is ever credited to `2050`. There is no entry for it and no revenue recognised
-- for it, which is the correct treatment of a supply made before the opening date (0027: "a posting before
-- the opening date is a posting into the period the opening entry already summarises").
--
-- ============================================================================================
-- 4. What is deliberately NOT here
-- ============================================================================================
--
--   * **No opening-balance import row and no period lock.** `opening_balance_import` and the cutover lock
--     are H-MIG-07's, which depends on this unit. A row there sets `opening_date_for()` and therefore the
--     ZL004 threshold for the whole ledger, and choosing it is that unit's decision.
--   * **No cutover-date setting.** The opening date is a column on the sign-off — the owner says which day
--     the liability enters the books, as part of what they are signing — and it is a foreign key to
--     `business_day`, so nothing here invents a trading date. A setting named here would be the shape
--     H-MIG-07 has to work around, which is H-MIG-01's own argument about this unit's sign-off table one
--     unit along.
--   * **No evidence-kind CHECK.** `imported_package_sale.evidence_kind` is free text for the reason
--     `import_row.outcome_detail` is: H-MIG-02 owns the vocabulary (`EVIDENCE_KINDS` in
--     `packages/migration/src/importers/packages/workbook.ts`) and a list here would be a second one for
--     it to disagree with. The ONE value this file spells is `owner_attestation`, once, as the EXPRESSION
--     of the attestation flag — so the flag cannot disagree with the kind rather than merely being held
--     equal to it — and `packages/fixtures/src/package-liability.test.ts` holds that literal against
--     H-MIG-02's array.
--   * **No breakage posting for an already-expired reconstruction.** A card that expired before the books
--     opened is still a liability under the provisional `retained` answer to Y9-package-policy (0083 §4),
--     so it imports with its expiry in the past and `package_expiry_exposure` measures it. An entry moving
--     `2050` into revenue would recognise money the business still owes, on a VAT box, for a supply that
--     has not happened.
--
-- ============================================================================================
-- Private SQLSTATEs. Band ZY251-ZY260; ZY259 and ZY260 are left FREE and deliberately UNREGISTERED,
-- because an entry for a code no migration raises is what direction 3 of `pnpm sqlstate` refuses.
-- ============================================================================================
--
--   ZY251  an owner import sign-off was UPDATEd or DELETEd
--   ZY252  a reconstructed package sale states no expiry
--   ZY253  a package sale that is not a reconstruction states an expiry other than its terms'
--   ZY254  a package sale's expiry was changed after the fact
--   ZY255  a reconstruction record was UPDATEd or DELETEd
--   ZY256  a reconstruction's sign-off does not attest to the hash of the file its row came from
--   ZY257  a reconstructed sale's figures disagree with the reconstruction that attests to them
--   ZY258  a package sale marked as a reconstruction carries no reconstruction record

begin;

-- ---------------------------------------------------------------------------------------------
-- The owner sign-off
-- ---------------------------------------------------------------------------------------------
--
-- It attests to `import_run.source_file_hash` — the sha-256 of the file's BYTES — and not to a run, and
-- the direction matters. A signature is about the FILE: the owner reads the workbook, accepts the balances
-- in it as liabilities of the business, and signs. A run is one attempt at importing it, there may be
-- several (a dry run, a live run, a resumed live run), and they all share the hash. Keying the signature
-- on a run would mean re-signing in order to rehearse.
--
-- It also carries the figures the owner is accepting, because that is what a signature is FOR. The cash
-- total is the one H-MIG-03's second acceptance line reconciles against: the import is blocked when the
-- file's prices do not sum to it, to the fils, and the variance report names the rows that contribute.
-- Keeping it here rather than on a command line is what makes the reconciliation auditable afterwards — a
-- figure typed into a shell is a figure nobody can check a month later.
create table import_staging.import_sign_off (
  id                    uuid        primary key default uuid_generate_v7(),
  -- The importer whose file this is, by registered name. Free text for 0111's reason: the list of
  -- importers is `packages/migration/src/registry.ts`, and an enum here would be a second list that a new
  -- importer has to migrate before it can run once.
  importer              text        not null check (length(importer) between 1 and 64),
  -- The same value, in the same spelling, as `import_run.source_file_hash`. ZY256 is what holds the two
  -- together for every imported row.
  source_file_hash      text        not null check (source_file_hash ~ '^[0-9a-f]{64}$'),
  -- Who signed, as they identified themselves. NOT defaulted and NOT a role name: brief rule 15 — a
  -- plausible value here is indistinguishable from a true one, and this column is the whole of "who
  -- accepted these balances as liabilities of the business".
  signed_by             text        not null check (btrim(signed_by) <> ''),
  signed_on             date        not null,
  -- What the signature covers, in the signer's words. Required, because a signature on nothing in
  -- particular is not evidence of anything a month later.
  statement             text        not null check (btrim(statement) <> ''),
  -- The figures the owner accepted. `rows_attested` and `total_price_paid_fils` are the file's own totals
  -- as H-MIG-02's validator computes them, so a signature against a DIFFERENT file than the one that was
  -- counted is visible; `cash_received_fils` is the INDEPENDENT figure, which is the only reason the
  -- reconciliation is a check at all.
  rows_attested         integer     not null check (rows_attested >= 1),
  total_price_paid_fils fils_nonneg not null check (total_price_paid_fils > 0),
  cash_received_fils    fils_nonneg not null check (cash_received_fils > 0),
  -- The business day the liability enters these books. Every reconstructed sale is filed on it and every
  -- entry this import posts is dated on it, so the opening position is one dated thing. A foreign key to
  -- `business_day`, so nothing here invents a trading date: 0011 generates those rows over a rolling
  -- horizon and leaves a closed date ABSENT, and a historical purchase date usually has no row at all —
  -- which is one of the two reasons a reconstruction is not filed on the day it was bought.
  opening_date          date        not null references business_day (trading_date)
                          on update cascade on delete restrict,
  created_at            timestamptz not null default now(),
  -- One signature per file per importer. A second would be two answers to "what did the owner accept",
  -- and the lookup the importer makes would have to choose between them.
  constraint import_sign_off_one_per_file unique (importer, source_file_hash),
  /*
    H-MIG-03's second acceptance line, as a CHECK: "a supplied cash-received total differing by one fils
    blocks the import".

    It blocks it by making the SIGNATURE unrecordable, which is the only place the rule can be enforced
    once rather than per row. The two columns come from different places on purpose — one is the file's own
    total as the validator counted it, the other is what the business says it received — so this is the
    check that holds two statements of one figure equal, in the same commit as the second statement (the
    repository's own rule about drift). No tolerance, not even one fils: both sides are sums of integers
    (ADR 0007), and a tolerance would be a number somebody chose, after which an import out by the width
    of it would complete and the opening balance sheet would be wrong by it for ever.

    A variance therefore means the FILE is wrong and has to be corrected — which gives it a new hash and
    needs a new signature. The report naming the rows that contribute is
    `formatOpeningPackageVariance` in `@berelax/core`: this constraint can say that the figures disagree
    and cannot say which of forty lines somebody mistyped, so the refusal and the report are deliberately
    in two places, and `scripts/migrate-package-liability.mjs` prints the second before reaching the first.
  */
  constraint import_sign_off_reconciles_to_the_cash_received
    check (total_price_paid_fils = cash_received_fils)
);

comment on table import_staging.import_sign_off is
  'The owner''s attestation for ONE source file, keyed on the sha-256 of its bytes — the only identity a '
  'typed spreadsheet has (0111). Append-only: UPDATE and DELETE raise ZY251. It carries the figures the '
  'owner accepted, including the cash actually received, which is what H-MIG-03 reconciles the file''s '
  'prices against.';
comment on column import_staging.import_sign_off.source_file_hash is
  'The value H-MIG-01 said this row would attest to: import_run.source_file_hash. ZY256 holds every '
  'imported row''s run to this hash, so a signature cannot be about a file other than the one imported.';
comment on column import_staging.import_sign_off.cash_received_fils is
  'What the business says it actually received for these packages. INDEPENDENT of the file: the whole '
  'point of the reconciliation is that this figure comes from somewhere else, so a mistyped price in the '
  'workbook is visible rather than self-confirming.';
comment on column import_staging.import_sign_off.opening_date is
  'The business day the liability enters these books. A foreign key to business_day, so an import cannot '
  'be filed on a date the trading calendar does not hold — and nothing invents one.';

create index import_sign_off_importer on import_staging.import_sign_off (importer, created_at desc);

-- ZY251. ADR 0008's shape, and 0111's argument for the whole schema: the ledger is the evidence. A
-- signature that can be edited afterwards is not a signature, and a corrected reconstruction is a new
-- file, a new hash and a new signature — never a rewritten record of the old one.
create or replace function import_staging.refuse_sign_off_change()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'SignOffImmutable: the sign-off % for importer "%" on file hash % may not be % — a corrected '
    'reconstruction is a NEW file with a new hash and a new signature, and the record of what was signed '
    'for before is what makes the correction auditable',
    old.id, old.importer, old.source_file_hash, lower(tg_op)
    using errcode = 'ZY251';
end $$;

comment on function import_staging.refuse_sign_off_change() is
  'Raises ZY251 for both events. One function and two triggers, 0111''s reason: the half-written pair — '
  'one trigger copied for the other event with the word not changed — is where this defect always hides.';

create trigger import_sign_off_no_update before update on import_staging.import_sign_off
  for each row execute function import_staging.refuse_sign_off_change();
create trigger import_sign_off_no_delete before delete on import_staging.import_sign_off
  for each row execute function import_staging.refuse_sign_off_change();

-- 0111 granted select/insert on every table in `import_staging` and set default privileges for tables
-- created later, so this table ARRIVED with those and with nothing else. The revoke is stated anyway, for
-- 0078's reason — the door is held twice, and a refusal trigger reporting what a grant says is allowed is
-- append-only by convention rather than by privilege.
revoke update, delete, truncate on import_staging.import_sign_off from berelax_app;

-- ---------------------------------------------------------------------------------------------
-- A sale may be a RECONSTRUCTION, and then it states its own expiry
-- ---------------------------------------------------------------------------------------------

alter table package_sale add column reconstructed boolean not null default false;

comment on column package_sale.reconstructed is
  'True for an outstanding liability imported out of H-MIG-02''s reconstruction workbook, false for every '
  'sale the till makes. It is what ZG002 branches on, so the rule holding a till sale to its template '
  'version is unchanged for a till sale and is REPLACED — by ZY257, against the workbook row that attests '
  'to the figures — for a reconstruction. ZY258 is what makes it impossible to carry the mark and attest '
  'to nothing. Immutable: package_sale_terms_are_immutable compares the whole row bar customer_id, and a '
  'column it does not have to be told about is 0078''s reason for comparing it that way.';

/*
  `expires_on` stops being GENERATED.

  It was `(trading_date + make_interval(months => validity_months))::date`, which is right for a package
  sold today under terms the catalogue holds and cannot express a reconstruction at all: a reconstructed
  sale is FILED on the opening date (see the header) and its expiry is the date the holder's own copy
  carries, which H-MIG-02 asks for as a column precisely because the validity was an assumption when the
  package was sold.

  `drop expression` keeps every stored value and the column's type, its nullability and every reader of
  it — 0083's ZG010 compares a redemption's business day against this column and the service compares the
  same two dates, and neither changes. What replaces the expression is a BEFORE INSERT trigger that
  derives the same date for a sale that is not a reconstruction, so M-TILL-09's sell path supplies nothing
  and gets what it always got; it REFUSES a non-reconstruction that supplies a different date (ZY253)
  rather than overwriting it, because a caller that passed one meant it and silently replacing it is how
  the two halves of an expiry rule start disagreeing.
*/
alter table package_sale alter column expires_on drop expression;

comment on column package_sale.expires_on is
  'When the entitlement runs out. DERIVED from trading_date + validity_months for a sale the till makes '
  '(and refused if a caller states another — ZY253), STATED for a reconstruction, where it is what the '
  'holder''s own copy says and nothing else can know it (ZY252). Stored rather than generated since 0119, '
  'and immutable afterwards (ZY254); every reader, 0083''s ZG010 included, is unchanged.';

create or replace function package_sale_expiry_is_derived_or_stated()
returns trigger
language plpgsql
as $$
declare
  v_derived date := (new.trading_date + make_interval(months => new.validity_months::integer))::date;
begin
  if new.reconstructed then
    if new.expires_on is null then
      raise exception
        'ZY252: a reconstructed package sale must state the expiry its holder''s own copy carries. '
        'Deriving it would restate a term the customer agreed to, and this sale is filed on the day the '
        'liability entered these books rather than on the day it was bought — so the derived date (%) is '
        'about nothing at all.',
        v_derived
        using errcode = 'ZY252';
    end if;
    return new;
  end if;

  if new.expires_on is null then
    new.expires_on := v_derived;
    return new;
  end if;

  if new.expires_on <> v_derived then
    raise exception
      'ZY253: this sale expires on % and its own terms — business day % plus % month(s) — end on %. A '
      'sale the till makes may not carry an expiry other than its terms'', because 0083''s ZG010 refuses '
      'a redemption against this column and the two would then disagree about when the money ran out.',
      new.expires_on, new.trading_date, new.validity_months, v_derived
      using errcode = 'ZY253';
  end if;
  return new;
end $$;

comment on function package_sale_expiry_is_derived_or_stated() is
  'Raises ZY252 and ZY253. What 0078''s generated expression became when a reconstruction had to be able '
  'to state its own expiry: the derivation is unchanged for a till sale, and a caller supplying a '
  'different date is now refused rather than silently overwritten.';

create trigger package_sale_expiry_is_derived_or_stated
  before insert on package_sale
  for each row execute function package_sale_expiry_is_derived_or_stated();

/*
  ZY254 — and this trigger exists because `package_sale_terms_are_immutable` (ZG001) removes `expires_on`
  from both sides of its comparison.

  0078 removed it for a reason that was true then and is not now: PostgreSQL computes a GENERATED column
  after the BEFORE triggers have run, so `new.expires_on` was NULL there while `old.expires_on` held the
  stored date — the rows differed on EVERY update, including the customer re-point that function exists to
  permit, and the first version of it refused the merge it was written for. The column is stored now, so
  the exclusion no longer costs nothing: it makes the one date a reconstruction states the one column a
  later statement could move without ZG001 noticing.

  A SEPARATE trigger rather than widening ZG001's comparison, and the reason is mechanical rather than
  stylistic: ZG001 is also raised by `package_row_is_immutable` in 0078, and `pnpm sqlstate` refuses a code
  whose live raise sites span two migrations — one code standing for two rules. Re-defining that function
  here unchanged, purely to keep the pair in one file, would leave a reader of 0078 looking at a definition
  that is no longer live. So the new rule gets a code of its own, which is what ADR 0043 asks of a rule
  with its own remedy: the remedy here is a reversing entry and a fresh import, not a correction.
*/
create or replace function package_sale_expiry_is_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.expires_on is distinct from old.expires_on then
    raise exception
      'ZY254: package sale % expires on % and something tried to move it to %. For a reconstruction that '
      'date is the only copy of a term the holder agreed to; for a sale the till made it is derived from '
      'terms that are themselves immutable. The remedy either way is a reversing entry and a new sale.',
      old.id, old.expires_on, new.expires_on
      using errcode = 'ZY254';
  end if;
  return new;
end $$;

comment on function package_sale_expiry_is_immutable() is
  'Raises ZY254. The half of ZG001 that 0078 could leave to a generated expression and 0119 cannot: '
  'package_sale_terms_are_immutable removes expires_on from both sides of its comparison, because the '
  'column used to be NULL in a BEFORE trigger.';

-- Fires before `package_sale_terms_are_immutable`, which is alphabetical order and is deliberate: a
-- statement that moved the expiry AND something else should be told about the expiry, which is the column
-- the other message does not mention.
create trigger package_sale_expiry_is_immutable
  before update on package_sale
  for each row execute function package_sale_expiry_is_immutable();

-- ---------------------------------------------------------------------------------------------
-- The reconstruction record
-- ---------------------------------------------------------------------------------------------
--
-- What the workbook said about one reconstructed package. Every figure here comes from a cell a human
-- filled in and none is derived from anything else in this database — which is the point: when an imported
-- balance disagrees with what the owner believes, this row and `import_staging.entity_provenance` together
-- answer "row 214 of <file>, whose content hashed to <hash>, said so".
--
-- It carries no customer id. A customer MERGE re-points `package_sale.customer_id` — 0078 permits exactly
-- that one column to move and `merge-participants.ts` registers the table as `repoint_update` — so a second
-- copy of the holder here would be the copy the merge did not follow.
create table imported_package_sale (
  id                      uuid        primary key default uuid_generate_v7(),
  sign_off_id             uuid        not null
                            references import_staging.import_sign_off (id) on delete restrict,
  /*
    The outstanding liability this row produced, or NULL when nothing is outstanding.

    NULL is the fully drawn package: no sessions left, nothing owed, so no sale, no balance and no posting
    (`package_balance_value_positive` and `package_balance_sessions_positive` would refuse a sale of
    nothing in any case). The row is still here because the cash was received — it belongs in the
    reconciliation — and because the history is what the holder will ask about. ZY257 holds the two cases
    apart: `sessions_remaining = 0` exactly when this column is null.
  */
  package_sale_id         uuid        unique references package_sale (id) on delete restrict,
  -- The holder, by phone in E.164, as the workbook stated it. Kept even though the sale resolves to a
  -- customer, because a fully drawn row has no sale to resolve through — and because it is what the
  -- workbook row says rather than what this database made of it.
  holder_phone_e164       text        not null
                            constraint imported_package_sale_holder_is_e164
                            check (holder_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- The template the row named. Text and not a key into `package_template`: this is the cell as typed, and
  -- the sale is where the resolved version id lives.
  template_key            text        not null check (btrim(template_key) <> ''),
  -- The day the customer actually paid, which is NOT the sale's trading_date: see the header. Kept because
  -- it is part of the row's identity in the workbook — (holder, template, purchase date) is the only
  -- identity a reconstructed row has (H-MIG-02) — and because it is the first thing a holder will say.
  purchase_date           date        not null,
  -- What was handed over, VAT-inclusive gross, integer fils (ADR 0007). Not the template's price.
  price_paid_fils         fils_nonneg not null check (price_paid_fils > 0),
  sessions_total_attested smallint    not null check (sessions_total_attested >= 1),
  sessions_used_attested  smallint    not null check (sessions_used_attested >= 0),
  -- Derived here although the workbook asks a person for it, which is not a contradiction: H-MIG-02 asks
  -- so that a row can be caught contradicting ITSELF, and by the time a row reaches this table that check
  -- has passed. A third typed copy would be a third thing to disagree.
  sessions_remaining      smallint    not null
                            generated always as (sessions_total_attested - sessions_used_attested) stored,
  -- The expiry the holder's own copy carries. Held equal to the sale's `expires_on` by ZY257.
  stated_expires_on       date        not null,
  -- H-MIG-02's closed vocabulary, by value and not by CHECK: see the header on why a list here would be a
  -- second one.
  evidence_kind           text        not null check (btrim(evidence_kind) <> ''),
  evidence_reference      text        not null check (btrim(evidence_reference) <> ''),
  /*
    The honour-once-on-evidence flag — H-MIG-03's fifth acceptance line, and Y9-package-thin's population.

    GENERATED and not stored independently. A boolean beside the kind would be two statements of one fact
    and the failure mode is the quiet one: a row whose kind is `owner_attestation` with the flag false is a
    liability resting on a recollection that every report counts as documented. Generated, the flag cannot
    disagree with the kind — there is nothing to hold equal.

    `owner_attestation` is the ONE value of H-MIG-02's vocabulary this file spells, and
    `packages/fixtures/src/package-liability.test.ts` holds this literal against `EVIDENCE_KINDS`.
  */
  admitted_on_attestation boolean     not null
                            generated always as (evidence_kind = 'owner_attestation') stored,
  notes                   text,
  created_at              timestamptz not null default now(),
  -- An expiry before the purchase is H-MIG-02's `expiry-must-not-precede-the-purchase-date` rejection. It
  -- is a CHECK here as well because the validator guards the FILE and this table is reachable without one.
  constraint imported_package_sale_expiry_after_purchase
    check (stated_expires_on >= purchase_date),
  constraint imported_package_sale_used_within_total
    check (sessions_used_attested <= sessions_total_attested),
  -- The row's identity in the workbook, which is also what makes a double import of one line visible here
  -- and not only in the staging ledger. H-MIG-02 refuses a duplicate inside one file; this refuses one
  -- across two files, which no validator pass can see.
  constraint imported_package_sale_one_per_holder_template_purchase
    unique (holder_phone_e164, template_key, purchase_date)
);

comment on table imported_package_sale is
  'What H-MIG-02''s workbook said about one reconstructed package, kept beside the package_sale it '
  'produced — or with no sale at all when nothing is outstanding. Append-only (ZY255). Every figure is a '
  'cell a human filled in; none is derived from anything else in this database, which is what makes it '
  'evidence rather than a second opinion.';
comment on column imported_package_sale.purchase_date is
  'The day the customer paid. Deliberately NOT the sale''s trading_date, which is the day the liability '
  'entered these books: business_day has no row for most historical dates and ZL004 refuses an entry '
  'dated before the books open.';
comment on column imported_package_sale.package_sale_id is
  'The outstanding liability, or NULL for a fully drawn package — which has nothing left to owe and so no '
  'sale, no balance and no posting. ZY257 holds this null exactly when sessions_remaining is zero.';
comment on column imported_package_sale.admitted_on_attestation is
  'Y9-package-thin: the balance rests on the owner''s recollection and no document of any kind. ADMITTED '
  'and flagged rather than refused, because the business took the money — refusing it would leave a real '
  'liability off the balance sheet and turn the customer away at the desk. Generated from evidence_kind, '
  'so the flag and the kind cannot disagree.';

create index imported_package_sale_sign_off on imported_package_sale (sign_off_id);
create index imported_package_sale_attested on imported_package_sale (id)
  where admitted_on_attestation;

-- ZY255. The reason ZY251 and 0111's ZY195 give: this row is the evidence an imported figure rests on.
create or replace function refuse_imported_package_change()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'ZY255: the reconstruction record % (holder %, template %, purchased %) may not be % — it is the copy '
    'of the workbook row the liability was imported from, and a correction is a new import against a newly '
    'signed file',
    old.id, old.holder_phone_e164, old.template_key, old.purchase_date, lower(tg_op)
    using errcode = 'ZY255';
end $$;

comment on function refuse_imported_package_change() is
  'Raises ZY255 for both events. One function and two triggers, for the reason the pair above gives.';

create trigger imported_package_sale_no_update before update on imported_package_sale
  for each row execute function refuse_imported_package_change();
create trigger imported_package_sale_no_delete before delete on imported_package_sale
  for each row execute function refuse_imported_package_change();

-- 0009 granted the application role select, insert, update and delete on every table in `public` AND set
-- default privileges extending that to tables created later — so this table ARRIVED with UPDATE and DELETE
-- already granted. The table-level REVOKE has to come first: a column-list grant does not narrow an
-- existing table-level one, and leaving the revoke out cost 0076 a whole run.
revoke update, delete, truncate on imported_package_sale from berelax_app;

-- ---------------------------------------------------------------------------------------------
-- ZY257 — a reconstructed sale carries the figures the reconstruction attests to
-- ---------------------------------------------------------------------------------------------
--
-- What ZG002 is for a till sale, this is for a reconstruction: the sale's columns are held equal to
-- something, and the something is the workbook rather than the catalogue.
--
-- The third equality is the one that does the work. The outstanding liability is
--
--     price_paid - package_release_through_fils(price_paid, sessions_total, sessions_used)
--
-- and that function is 0083's — the ONE statement of what a session of a balance is worth, which ZG009
-- re-adds over every balance and `releaseThrough` in `@berelax/core` is the TypeScript half of (held equal
-- over a census by `packages/fixtures/src/package-redemption.itest.ts`). Writing the subtraction out here
-- in arithmetic of its own would be a second implementation of a rule this schema spends most of its
-- constraints protecting, and the figure it produced would differ from the one a redemption computes in
-- exactly the cases where a price does not divide by a session count.
--
-- IMMEDIATE, because the sale exists before this row does and every value compared is already stored. The
-- reverse direction — a sale marked `reconstructed` with no record at all — cannot be immediate and is
-- ZY258.
create or replace function imported_package_matches_its_sale()
returns trigger
language plpgsql
as $$
declare
  v_sale        package_sale;
  v_outstanding bigint;
  /*
    `sessions_remaining` is GENERATED, and PostgreSQL computes a generated column AFTER the BEFORE triggers
    have run — so `new.sessions_remaining` is NULL here and every comparison against it is NULL, which is
    neither true nor false and let every row through. It is 0078's own recorded trap, which that file hit
    with `expires_on` in `package_sale_terms_are_immutable`, and the integration suite found it again here:
    the first version of this function reported "<NULL> session(s) remaining" about a row that had three.
    So the figure is recomputed from the two columns it is generated from, which the trigger CAN see.
  */
  v_remaining   integer := new.sessions_total_attested - new.sessions_used_attested;
begin
  v_outstanding := new.price_paid_fils - package_release_through_fils(
    new.price_paid_fils, new.sessions_total_attested, new.sessions_used_attested);

  if v_remaining = 0 then
    if new.package_sale_id is not null then
      raise exception
        'ZY257: this reconstruction has no sessions remaining and names package sale %. A fully drawn '
        'package owes nothing, so there is no liability for these books to carry — the row is kept '
        'because the cash was received and because the history is what the holder will ask about.',
        new.package_sale_id
        using errcode = 'ZY257';
    end if;
    return new;
  end if;

  if new.package_sale_id is null then
    raise exception
      'ZY257: this reconstruction has % session(s) remaining, worth % fils, and names no package sale. An '
      'outstanding entitlement nothing points at is a liability the balance sheet cannot carry and the '
      'front desk cannot honour.',
      v_remaining, v_outstanding
      using errcode = 'ZY257';
  end if;

  select * into v_sale from package_sale where id = new.package_sale_id;

  if not v_sale.reconstructed then
    raise exception
      'ZY257: package sale % is not marked as a reconstruction, so a reconstruction record may not attest '
      'to it. ZG002 holds a till sale to the template version it names, and a record here would make '
      'every liability report count a sale the till made as imported.',
      new.package_sale_id
      using errcode = 'ZY257';
  end if;

  if v_sale.price_fils <> v_outstanding then
    raise exception
      'ZY257: package sale % carries a liability of % fils and this reconstruction attests to % fils paid '
      'for % session(s) of which % were taken, which the release formula leaves at % fils outstanding. A '
      'reconstructed sale records what is still OWED, because the delivered sessions were supplied before '
      'these books existed.',
      new.package_sale_id, v_sale.price_fils, new.price_paid_fils, new.sessions_total_attested,
      new.sessions_used_attested, v_outstanding
      using errcode = 'ZY257';
  end if;

  if v_sale.session_count <> v_remaining then
    raise exception
      'ZY257: package sale % carries % session(s) and this reconstruction attests to % remaining of %. '
      'The entitlement that arrives is the one that remains.',
      new.package_sale_id, v_sale.session_count, v_remaining,
      new.sessions_total_attested
      using errcode = 'ZY257';
  end if;

  if v_sale.expires_on <> new.stated_expires_on then
    raise exception
      'ZY257: package sale % expires on % and this reconstruction attests to %. The expiry is a term the '
      'holder agreed to and the only copy of it is theirs.',
      new.package_sale_id, v_sale.expires_on, new.stated_expires_on
      using errcode = 'ZY257';
  end if;
  return new;
end $$;

comment on function imported_package_matches_its_sale() is
  'Raises ZY257. The replacement for ZG002 on a reconstruction: the sale''s liability, session count and '
  'expiry are held equal to the workbook row that attests to them — the liability through 0083''s own '
  'release formula — rather than to the template version the sale names, which holds what the business '
  'offers TODAY and never what this customer bought.';

create trigger imported_package_matches_its_sale
  before insert on imported_package_sale
  for each row execute function imported_package_matches_its_sale();

-- ---------------------------------------------------------------------------------------------
-- ZY256 — the sign-off attests to the hash of the file the row came from
-- ---------------------------------------------------------------------------------------------
--
-- H-MIG-03's fourth acceptance line, as a property of the database: "the sign-off is stored immutably
-- against the hash of the file it attests to". Immutably is ZY251. AGAINST THE HASH is this.
--
-- It is not checkable by the importer, and that is why it is here. `ImporterDefinition.apply` is handed a
-- unit of work and a payload — not the run, not the file, not the hash — so an importer can only look its
-- own run up and could look up the wrong one. This walks the other way: from the row, through
-- `import_staging.entity_provenance`, to the run that actually produced it, and requires that run's
-- `source_file_hash` to be the one the signature names.
--
-- DEFERRED, because the framework records provenance AFTER `apply` returns (0111: the three statements'
-- order is the importer's business). At COMMIT the provenance row exists — ZY196 refuses the commit if it
-- does not — so the walk resolves, or the row was written by something that went round `runImport`. That
-- is refused here by the same code and for the same reason: an imported liability whose file nobody signed
-- for is the artefact this whole unit exists to prevent.
create or replace function imported_package_sign_off_attests_to_its_file()
returns trigger
language plpgsql
as $$
declare
  v_signed text;
  v_hashes integer;
  v_hash   text;
begin
  select s.source_file_hash into v_signed
    from import_staging.import_sign_off s where s.id = new.sign_off_id;

  select count(distinct p.source_file_hash), min(p.source_file_hash)
    into v_hashes, v_hash
    from import_staging.entity_provenance p
   where p.target_schema = 'public'
     and p.target_table = 'imported_package_sale'
     and p.target_id = new.id::text;

  if coalesce(v_hashes, 0) = 0 then
    raise exception
      'ZY256: reconstruction record % resolves to no imported source row, so there is no file for '
      'sign-off % to be about. An imported liability is a row of a signed workbook or it is a figure '
      'nobody can defend.',
      new.id, new.sign_off_id
      using errcode = 'ZY256';
  end if;

  if v_hashes > 1 or v_hash <> v_signed then
    raise exception
      'ZY256: reconstruction record % was imported from a file hashing to % and sign-off % attests to %. '
      'A signature is about the bytes of ONE file — the only identity a typed spreadsheet has — so a '
      'sign-off naming another file is a signature for balances nobody read.',
      new.id, coalesce(v_hash, '<several>'), new.sign_off_id, v_signed
      using errcode = 'ZY256';
  end if;
  return null;
end $$;

comment on function imported_package_sign_off_attests_to_its_file() is
  'Raises ZY256 at COMMIT. The acceptance line "the sign-off is stored immutably against the hash of the '
  'file it attests to", read from the row''s own provenance rather than from anything the importer passed '
  '— because apply() is handed no run and no hash and could only guess.';

create constraint trigger imported_package_sign_off_attests_to_its_file
  after insert on imported_package_sale
  deferrable initially deferred
  for each row execute function imported_package_sign_off_attests_to_its_file();

-- ---------------------------------------------------------------------------------------------
-- ZG002, by exemption
-- ---------------------------------------------------------------------------------------------
--
-- A reconstruction's terms are the customer's and are held against `imported_package_sale` by ZY257. The
-- version it names is still a real version and still supplies the catalogue variant the entitlement is
-- about — ZG006 holds one balance per line of it, unchanged — but its price and session count are what the
-- business offers TODAY, which is not what this customer bought and not what is left of it.
--
-- The exemption is one branch and nothing else in the function moves, which is the shape that makes it
-- arguable at all. Gate case 147i breaks a till sale's price and requires ZG002 back by name, so the guard
-- is shown to have survived being edited; 147j is the same case for the reconstruction path, where the
-- figure is refused by ZY257 instead.
create or replace function package_sale_terms_match_version() returns trigger
  language plpgsql as $$
declare
  v        package_template_version;
  sessions integer;
begin
  if new.reconstructed then
    return null;
  end if;

  select * into v from package_template_version where id = new.template_version_id;
  select coalesce(sum(session_count), 0) into sessions
    from package_template_line where template_version_id = new.template_version_id;

  if new.price_fils <> v.price_fils
     or new.validity_months <> v.validity_months
     or new.transferable is distinct from v.transferable
     or new.unredeemed_balance_policy <> v.unredeemed_balance_policy
     or new.session_count <> sessions then
    raise exception
      'ZG002: the terms snapshotted on this sale disagree with version % of the template it names. '
      'Sale: % fils, % session(s), % month(s), transferable %, balance %. Version: % fils, % '
      'session(s), % month(s), transferable %, balance %.',
      v.version,
      new.price_fils, new.session_count, new.validity_months, new.transferable,
      new.unredeemed_balance_policy,
      v.price_fils, sessions, v.validity_months, v.transferable, v.unredeemed_balance_policy
      using errcode = 'ZG002';
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- ZY258 — a sale marked as a reconstruction carries the record that attests to it
-- ---------------------------------------------------------------------------------------------
--
-- The other direction of ZY257, and it cannot be the same trigger: this one fires on the SALE, and the
-- record it is about arrives afterwards. Without it, `reconstructed = true` is a way to switch ZG002 off
-- and be held to nothing in its place — which is the one hole exempting another unit's constraint could
-- leave, so it is the refusal in this file that is about this file.
--
-- DEFERRED, ZG004's shape and for its reason: the sale and its record are separate INSERTs in one
-- transaction, and an immediate check would fire on the sale before its own record existed.
create or replace function package_sale_reconstruction_is_attested()
returns trigger
language plpgsql
as $$
begin
  if not new.reconstructed then
    return null;
  end if;

  if not exists (
    select 1 from imported_package_sale i where i.package_sale_id = new.id
  ) then
    raise exception
      'ZY258: package sale % is marked as a reconstruction and no reconstruction record attests to it. '
      'The mark exempts the sale from ZG002, so a sale carrying it with nothing to be held against '
      'instead is a liability held to nothing at all.',
      new.id
      using errcode = 'ZY258';
  end if;
  return null;
end $$;

comment on function package_sale_reconstruction_is_attested() is
  'Raises ZY258 at COMMIT. `reconstructed` turns another unit''s constraint off for this row; this is what '
  'makes it impossible to turn it off and attest to nothing.';

create constraint trigger package_sale_reconstruction_is_attested
  after insert on package_sale
  deferrable initially deferred
  for each row execute function package_sale_reconstruction_is_attested();

-- ---------------------------------------------------------------------------------------------
-- The liability report, and the flag on the customer record
-- ---------------------------------------------------------------------------------------------

/**
 * The imported package liability, one row per reconstructed package — fully drawn ones included.
 *
 * H-MIG-03's first and fifth acceptance lines read this. The sum of `remaining_value_fils` is what `2050`
 * has to equal to the fils, and `admitted_on_attestation` is the flag the fifth line requires to be
 * visible in the liability report. The provenance columns come from `import_staging.entity_provenance`,
 * which is the ONE place (target row) -> (file, line, content hash) is written (0111), so a figure in this
 * report resolves to the line of the spreadsheet it was typed on without this view re-deriving anything.
 *
 * `remaining_value_fils` is `value_fils - released_fils` summed over the sale's balances, and NOT the
 * figure ZY257 held the sale's price to. The two are equal at import and stop being equal the first time a
 * holder walks in and redeems a session — at which point the balance is right and the attested arithmetic
 * is history. A report that read the attestation would show a liability the business no longer owes.
 */
create view imported_package_liability as
  select i.id                                              as reconstruction_id,
         i.package_sale_id,
         s.customer_id,
         i.holder_phone_e164,
         i.template_key,
         s.trading_date                                    as opening_date,
         i.purchase_date,
         i.stated_expires_on,
         i.price_paid_fils,
         i.sessions_total_attested,
         i.sessions_used_attested,
         i.sessions_remaining,
         coalesce(sum(b.value_fils - b.released_fils), 0)  as remaining_value_fils,
         coalesce(sum(b.sessions_total - b.sessions_redeemed), 0) as sessions_available,
         i.evidence_kind,
         i.evidence_reference,
         i.admitted_on_attestation,
         i.notes,
         s.journal_entry_id,
         i.sign_off_id,
         o.signed_by,
         o.signed_on,
         o.source_file_hash,
         p.source_file,
         p.source_line,
         p.content_hash,
         p.importer,
         p.importer_version
    from imported_package_sale i
    join import_staging.import_sign_off o on o.id = i.sign_off_id
    left join package_sale s on s.id = i.package_sale_id
    left join package_balance b on b.package_sale_id = i.package_sale_id
    left join import_staging.entity_provenance p
           on p.target_schema = 'public'
          and p.target_table = 'imported_package_sale'
          and p.target_id = i.id::text
   group by i.id, i.package_sale_id, i.holder_phone_e164, i.template_key, i.purchase_date,
            i.stated_expires_on, i.price_paid_fils, i.sessions_total_attested,
            i.sessions_used_attested, i.sessions_remaining, i.evidence_kind, i.evidence_reference,
            i.admitted_on_attestation, i.notes, i.sign_off_id,
            s.customer_id, s.trading_date, s.journal_entry_id,
            o.signed_by, o.signed_on, o.source_file_hash,
            p.source_file, p.source_line, p.content_hash, p.importer, p.importer_version;

comment on view imported_package_liability is
  'H-MIG-03''s liability report: one row per reconstructed package, with what the workbook attested, what '
  'is still owed, the attestation flag, who signed for it, and the line of which file it came from. The '
  'sum of remaining_value_fils is what 2050 Deferred revenue has to equal to the fils.';

grant select on imported_package_liability to berelax_app;

/**
 * The attestation flag, on the customer record.
 *
 * The other half of the fifth acceptance line, and a VIEW rather than a column on `customer` for the
 * reason 0084's `customer_contraindication_flags` is one: the fact belongs to the package, the customer
 * record is where it has to be VISIBLE, and a boolean on `customer` would be a second statement that
 * nothing holds equal — out of date the moment a second package is imported.
 *
 * It resolves through the SALE and therefore shows no fully drawn package, which is the right answer for
 * the desk: the flag is there so that somebody about to honour an entitlement knows what it rests on, and
 * a package with nothing left to honour is not a decision anybody is making. `merge_survivor_of` for
 * 0084's reason — a holder whose duplicate record was merged away must not silently lose the flag.
 */
create view customer_package_attestation as
  select merge_survivor_of(s.customer_id)                            as customer_id,
         count(*)::integer                                           as imported_package_count,
         count(*) filter (where i.admitted_on_attestation)::integer   as attested_package_count,
         bool_or(i.admitted_on_attestation)                          as has_attested_package
    from imported_package_sale i
    join package_sale s on s.id = i.package_sale_id
   group by merge_survivor_of(s.customer_id);

comment on view customer_package_attestation is
  'Whether any outstanding package on this customer''s record was admitted on the owner''s recollection '
  'alone (Y9-package-thin), for the front desk to see before honouring it. One row per LIVE customer with '
  'an outstanding imported package, so a reader still queries `where customer_id = $1`.';

grant select on customer_package_attestation to berelax_app;

commit;
