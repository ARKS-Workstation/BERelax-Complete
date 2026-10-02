-- 0132 — the period-boundary lock: once an opening balance is attested, nothing may be dated behind it.
--
-- `0027_opening_balances.sql` built the opening position: one `opening_balance_import` row per entity per
-- date, one balanced journal entry behind it, `ZL004` refusing any posting dated before the opening date,
-- and zeros flagged provisional rather than seeded silently. This migration closes the two ways round it
-- that were still open, and ties the attested totals to the ledger they claim to describe.
--
-- ## The hole, and why it is not theoretical
--
-- `refuse_entry_before_opening()` exempts `source in ('opening_balance', 'reversal')`, and 0027 gives the
-- reason: the opening entry itself has to be insertable, and it commits BEFORE the import row exists to
-- guard against it. That exemption is correct for exactly one entry and permanent for every other.
--
-- **H-MIG-03 posts its reconstructed package liability on `journal_entry.source = 'opening_balance'`**
-- (ADR 0069), and H-MIG-07's opening trial balance posts on the same source. So "the opening position"
-- is not one entry in this build, it is a SET of them — and with the exemption as it stood, a second
-- `opening_balance` entry could be dated anywhere before the boundary at any time afterwards, inside the
-- period the attested totals already summarise. The books would still balance. They would simply be
-- larger, which 0027's own header names as the failure nobody can detect afterwards.
--
-- Three refusals close it, and each names a different thing to go and do.
--
-- **`ZY381` — once ANY opening balance has been imported, no entry may be dated before the boundary,
-- whatever its source.** The exemption survives only in the window before the first import row exists,
-- which is the window the opening entry is inserted in. This is the acceptance line "the period up to the
-- cutover boundary is locked after import and a posting into it is refused with a named error", and it is
-- a database refusal rather than a convention because there are five posting paths and a rule enforced in
-- five places has five chances to be forgotten — 0027's own argument, applied to the hole 0027 left.
--
-- **`ZY383` — once an import exists for a boundary, no further `opening_balance` entry may be dated ON
-- that boundary either.** ZY381 covers "before"; this covers "on", which is where the opening entries
-- actually sit. The attested totals are append-only, so an entry added afterwards makes them wrong while
-- every balance still ties. The remedy is named and it is the one ADR 0017 already prescribes: a dated
-- REVERSAL plus a fresh import at a new boundary, which `opening_date_for()`'s `min()` was written to
-- support.
--
-- It follows that **the package liability must be imported BEFORE the opening trial balance**, which is
-- the dependency H-MIG-07's manifest entry already declares. That is not an accident of ordering: the
-- trial balance is the statement of the WHOLE opening position, so anything belonging in it has to be in
-- the books before it is attested.
--
-- **`ZY382` — the attested totals must equal the journal lines of the entry the attestation NAMES, and
-- the refusal names the imbalance in fils on each side.** `opening_balance_import_balances` (0027) holds
-- debits equal to credits WITHIN the row, which is a claim about two numbers somebody typed; this holds
-- those numbers to the posting they describe. `importOpeningBalances` sums them off its own lines so it
-- satisfies this by construction, which is the point: the refusal is for an attestation written any other
-- way — by hand, by a later migration, by a psql session — and 0027 deliberately left the totals as
-- "derived, and asserted against the lines by the itest rather than trusted". This is that assertion
-- moved into the database. Deferred, because the entry and the import row are inserted in one transaction
-- and the row comes second.
--
-- It is also the acceptance line "the opening trial balance is refused unless debits equal credits, and
-- the error names the imbalance in fils", from the second of two directions — `assertImportable` in
-- `packages/db/src/services/opening-balances.ts` already refuses an unbalanced FILE before anything is
-- written and names the difference, and this refuses an attestation that disagrees with what was written.
-- The imbalance is printed on both sides and as a difference, because "out by 1,250 fils" is what
-- somebody corrects a spreadsheet from and "debits 4,000,000 credits 3,998,750" is what they check it
-- against.
--
-- **What ZY382 is NOT, and the version that was built first.** It was going to hold the totals to every
-- `opening_balance` line dated at the boundary — the whole position's sum, H-MIG-03's reconstructed
-- package liability included — which would have made a double count impossible in the schema rather than
-- in the importer. It is not that, for a mechanical reason: `importOpeningBalances` computes its totals
-- from its own lines, so the moment any other entry shared the boundary that existing and tested writer
-- would have stopped being able to commit at all. Holding the whole position together is therefore the
-- IMPORTER's, through `readOpeningBalancePostings` and `openingRemainder`, with the reconciliation
-- asserted per account to the fils — which is what H-MIG-07's own acceptance line asks for ("asserted by
-- a reconciliation test") rather than a refusal.
--
-- **`ZY384` — `opening_balance_import` is append-only.** 0027 revoked UPDATE and DELETE from
-- `berelax_app`, which is the privilege and not the rule: a migration, a psql session or a role added
-- later is outside it, and ZY382 is a DEFERRED check that fires on INSERT — so an UPDATE afterwards could
-- change the attested totals with nothing re-checking them. The acceptance line is "an attempted edit of
-- an opening balance is refused; a correction posts as a dated reversal", and this is the half of it that
-- is about the attestation rather than about the journal (which `refuse_journal_change()` already covers).
--
-- ## What this migration deliberately does not do
--
-- **It does not add a `period_lock` row for the period before the boundary, and it does not touch
-- `period_lock` at all.** That table is for CLOSING a month that has been reported (0073), and its
-- `period_lock_no_overlap` exclusion is over dated ranges; the pre-boundary period has no start that is
-- not invented, and `raise_if_period_locked` would then be a second answer to a question ZL004 and ZY381
-- already answer. One rule, two codes, no magic date.
--
-- **It does not seed, extend or re-tag the chart of accounts.** Every account already carries exactly one
-- `vat201_box_mapping` row, forced by `account_carries_a_vat201_attribution` (0089, ZY009). An import that
-- created accounts would have to supply those attributions, and an attribution is a decision about what
-- feeds a VAT return — which is the owner's and the accountant's, not an importer's. H-MIG-07's
-- `importers/ledger/coa.ts` therefore CHECKS the chart the balances are posted against rather than
-- writing it, and the opening-balance importer refuses a file naming an account the chart does not hold.

begin;

-- ---------------------------------------------------------------------------------------------
-- Nothing behind the boundary, once the boundary is attested
-- ---------------------------------------------------------------------------------------------

create or replace function refuse_entry_behind_the_boundary()
returns trigger
language plpgsql
as $$
declare
  v_opening date;
begin
  v_opening := opening_date_for();

  -- Before the first import there is no boundary to be behind, which is also what lets the opening entry
  -- itself be inserted: it commits, and only then does the import row exist.
  if v_opening is null then
    return new;
  end if;

  if new.entry_date < v_opening then
    raise exception
      'BehindTheOpeningBoundary: entry % is dated % and the books open on %. The period before the '
      'boundary is summarised by the opening balance already imported, so a posting into it is counted '
      'twice — and the books still balance afterwards, which is why nothing downstream would report it. '
      'This applies to an opening_balance and a reversal as well: 0027 exempted those two sources so the '
      'opening entry could be inserted at all, and that exemption is correct for exactly one entry and '
      'permanent for every other.',
        new.entry_id, new.entry_date, v_opening
      using errcode = 'ZY381',
            hint = 'A correction to the opening position is a dated REVERSAL on or after the boundary '
                   'plus a fresh import at a new boundary (ADR 0017). Nothing is ever dated behind it.';
  end if;

  -- On the boundary, an `opening_balance` entry is part of the attested position — and the attestation is
  -- append-only, so it closes when the import row is written.
  if new.entry_date = v_opening and new.source = 'opening_balance' then
    raise exception
      'OpeningPositionIsClosed: entry % is dated % on the opening boundary with source opening_balance, '
      'and an opening balance for that boundary has already been imported. The attested totals are '
      'append-only, so an entry added now makes them wrong while every balance still ties — which is '
      '0027''s own undetectable failure. The package liability (H-MIG-03) belongs in the trial balance '
      'and therefore has to be imported BEFORE it, which is the dependency H-MIG-07 declares.',
        new.entry_id, new.entry_date
      using errcode = 'ZY383',
            hint = 'Post a dated reversal on or after the boundary and import a corrected opening '
                   'position at a NEW boundary. opening_date_for() takes the min(), so the guard moves '
                   'to the earliest of them and nothing behind it reopens.';
  end if;

  return new;
end
$$;

comment on function refuse_entry_behind_the_boundary() is
  'Raises ZY381 for an entry dated BEFORE the boundary, whatever its source, and ZY383 for a further '
  'opening_balance entry dated ON it. Two codes because the remedies differ: the first is a date to '
  'correct, the second is a reversal and a re-based import. Separate from refuse_entry_before_opening() '
  '(0027) rather than replacing it, so ZL004 goes on being raised by the migration the registry names.';

create trigger journal_entry_not_behind_the_boundary
  before insert on journal_entry
  for each row execute function refuse_entry_behind_the_boundary();

-- ---------------------------------------------------------------------------------------------
-- The attested totals must equal the ledger they describe
-- ---------------------------------------------------------------------------------------------

create or replace function assert_opening_totals_tie_to_the_ledger()
returns trigger
language plpgsql
as $$
declare
  v_debit  bigint;
  v_credit bigint;
begin
  -- The lines of the entry this attestation NAMES. See the header for why it is not every
  -- `opening_balance` line at the boundary: that reading would stop `importOpeningBalances` committing
  -- the moment any other entry shared the date, and holding the whole position together is the
  -- importer's job through `readOpeningBalancePostings` and `openingRemainder`.
  select coalesce(sum(l.debit_fils), 0), coalesce(sum(l.credit_fils), 0)
    into v_debit, v_credit
    from journal_line l
   where l.entry_id = new.entry_id;

  if v_debit = new.total_debit_fils and v_credit = new.total_credit_fils then
    return null;
  end if;

  raise exception
    'OpeningTotalsDoNotTieToTheEntry: the import for % attests debits % and credits % in fils, and entry '
    '% holds debits % and credits %. The debit side is out by % fils and the credit side by % fils. '
    '0027 left these totals "derived, and asserted against the lines by the itest rather than trusted"; '
    'this is that assertion in the database, because the row is append-only (ZY384) and nothing else '
    'would ever re-derive them.',
      new.opening_date, new.total_debit_fils, new.total_credit_fils, new.entry_id,
      v_debit, v_credit,
      new.total_debit_fils::bigint - v_debit, new.total_credit_fils::bigint - v_credit
    using errcode = 'ZY382',
          hint = 'Attest the sum of the lines actually posted. importOpeningBalances() in packages/db '
                 'computes them off its own lines and satisfies this by construction.';
end
$$;

comment on function assert_opening_totals_tie_to_the_ledger() is
  'Raises ZY382 at COMMIT, naming the imbalance on each side in fils. 0027 left the totals derived and '
  'asserted by an itest rather than trusted; this is that assertion moved into the database, which '
  'matters because the row is append-only so nothing would ever re-derive them.';

create constraint trigger opening_balance_import_ties_to_the_ledger
  after insert on opening_balance_import
  deferrable initially deferred
  for each row execute function assert_opening_totals_tie_to_the_ledger();

-- ---------------------------------------------------------------------------------------------
-- The attestation is append-only
-- ---------------------------------------------------------------------------------------------

create or replace function refuse_opening_balance_import_change()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'OpeningBalanceImportIsAppendOnly: an opening-balance import may not be %. It is the owner''s '
    'attestation of what the books opened at, and ZY382 is a DEFERRED check that fires on INSERT — so an '
    'UPDATE afterwards would change the attested totals with nothing re-checking them against the ledger.',
      lower(tg_op)
    using errcode = 'ZY384',
          hint = 'A corrected opening position is a dated reversal plus a fresh import at a new '
                 'boundary (ADR 0017). 0027 says the same thing about the absent updated_at column: an '
                 'import is a fact, not a record that gets revised.';
end
$$;

comment on function refuse_opening_balance_import_change() is
  'Raises ZY384. 0027 revoked UPDATE and DELETE from berelax_app, which is the privilege and not the '
  'rule: a migration, a psql session or a role added later is outside it.';

create trigger opening_balance_import_no_update
  before update on opening_balance_import
  for each row execute function refuse_opening_balance_import_change();

create trigger opening_balance_import_no_delete
  before delete on opening_balance_import
  for each row execute function refuse_opening_balance_import_change();

commit;
