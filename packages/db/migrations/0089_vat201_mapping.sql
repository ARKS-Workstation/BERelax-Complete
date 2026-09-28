-- 0089 — the VAT201 box mapping as ROWS, the return engine that sums them, and the drill-down.
--
-- M-VAT-07. [UNVERIFIED] Y11-vat201-boxes is open: the real box numbers await an FTA-registered tax agent,
-- and its recorded provisional answer is "Box 1 / Box 3 / Box 10 as placeholders, held in a data table with
-- a test proving the mapping is data not code". This file is that table, and the clause after the comma is
-- the whole design: `packages/fixtures/src/vat201.itest.ts` UPDATEs one row and asserts a figure lands in a
-- different box, with a control proving it was in the first box beforehand. A mapping written as
-- `if (grouping = 'standard_rated_supplies') then 1` is a mapping nobody can correct without a deploy, and
-- the one thing everybody agrees about this unit is that a tax agent will hand back different numbers.
--
-- ## Why account.vat_box could not be the mapping, measured
--
-- 0018 already tags every account with a GROUPING (`account.vat_box`), and M-VAT-03 recorded why that column
-- cannot be summed as "the amount in a box": every recoverable expense account carries
-- `recoverable_input_tax` as well as 1080 does, so a sum over the grouping adds the rent expense to the
-- input VAT. The figure it measured was 2,006,706 fils where the claim was 6,706.
--
-- The grouping is also not fine enough in the other direction. `reverse_charge` is carried by BOTH 2035
-- Reverse-charge VAT payable and 6075 Software and imported services, and a reverse-charge bill posts
-- Dr 6075 (net) Dr 1080 (tax reclaimed) Cr 2035 (tax declared) Cr 2010 (gross) — so within ONE grouping the
-- two accounts belong in different COLUMNS of the box and on opposite SIDES of the arithmetic. Any mapping
-- keyed on the grouping has to pick one and be wrong about the other.
--
-- So the mapping is keyed on the ACCOUNT, one row each, and it says three things the chart does not:
--
--   * `box_no`     — where on the form the figure lands. THIS is what Y11-vat201-boxes answers.
--   * `measure`    — which column of the box: the value of the supply (`net_supplies`) or the tax on it
--                    (`tax`). A revenue account holds the net; a VAT control account holds the tax.
--   * `contribution` — which direction is positive. `credit_less_debit` for the output side, so a debit to
--                    4095 Discounts and allowances REDUCES box 1 and a credit note reduces it too;
--                    `debit_less_credit` for the input side. Direction is never folded into a sign on the
--                    line — 0018's rule — so it has to be stated per attribution.
--
-- ## The seed is an INSERT … SELECT off the chart, deliberately
--
-- Not 63 hand-typed codes. The initial values are DERIVED from `account.vat_box` and `account.type`, which
-- makes two things true that a retyped list cannot: the seed cannot disagree with the chart on the day it
-- runs, and an account a LATER migration adds gets no row at all — which `vat201_mapping_is_complete()`
-- refuses (ZY001), instead of the account silently dropping out of the return. That is the acceptance line
-- "a test enumerates the chart and fails on an untagged account", enforced by the database rather than by a
-- test that has to remember to run.
--
-- The rows are STORED and not a view over that derivation, which is the point of the unit. A view would be
-- the `if` statement again with a `create or replace` in front of it.
--
-- ## What is NOT enforced, and why it is a report instead
--
-- The mapping is deliberately NOT tied to `account.vat_box` by a trigger. `reclassifyAccountRecoverability`
-- (M-VAT-02) is a sanctioned audited owner operation that UPDATEs `account.vat_box`, and a refusal raised
-- from a VAT table would make it unusable — the refusal would fire on the very operation the chart exists to
-- permit. Drift between the two is therefore reported rather than refused: `vat201_mapping_disagreement()`
-- returns one row per account whose attribution and grouping no longer agree, the working paper carries it
-- as a reconciliation section that must be empty, and the itest asserts it is empty for the seeded chart with
-- a control that retags an account and requires the row to appear. A refusal nobody can satisfy is worse
-- than a measurement somebody reads.
--
-- ## No arithmetic in this file divides, rounds or multiplies
--
-- [UNVERIFIED] Y11-rounding is provisionally "half-up on net, VAT as the remainder", and ADR 0007 makes
-- integer fils with the VAT-inclusive gross authoritative. Every figure below is a SUM of
-- `journal_line.debit_fils` and `journal_line.credit_fils` as they were posted. There is no `/`, no
-- `round()`, no `numeric` and no rate anywhere in `vat201_box_line` or `vat201_box_total`, so whichever way
-- Y11-rounding is answered no box total can move by a fils: the answer decides how an invoice SPLIT its
-- gross when it was issued, which is M-TILL's, and a filed period cannot be restated by re-reading it.
-- `packages/core/src/tax/vat201.ts` states the same claim as a source-level check with a control.
--
-- ## The totals are an aggregate OVER the drill-down, not a second query
--
-- `vat201_box_total()` sums `vat201_box_line()`. That is the structural half of "a box total equals the sum
-- of its drill-down lines, exact to the fils" — two independent queries would be two chances to filter
-- differently, and the defect this unit exists to prevent is a one-fils disagreement between a box and the
-- lines a preparer is shown when they click it. The itest re-sums the drill-down in TypeScript `BigInt` as
-- well, with a control that requires a deliberately wrong total to be detected, because a structural
-- guarantee nobody has watched fail is not evidence.
--
-- ## Private SQLSTATEs: ZY001 and ZY002, in a FRESH class
--
-- `packages/db/src/sqlstate-uniqueness.test.ts` records thirteen codes already standing for two rules each,
-- and measured before this file was written ZA through ZX are all in use: only ZY and ZZ were free. Taking
-- "the next number in a plausible class" would have made one file's translator report another file's refusal
-- with a plausible message and the wrong cause. ZY is unowned, so ZY001 and ZY002 collide with nothing, and
-- ZZ is now the ONLY free class left — recorded here because the next unit that needs one has to know.
--
--   ZY001  Vat201MappingIncomplete — an account feeds the return, or does not, and nothing says which
--   ZY002  Vat201MeasureNotPossible — a revenue or expense account cannot hold tax, and a VAT control
--          account cannot hold the value of a supply
--
-- See docs/OPEN-QUESTIONS.md (Y11-vat201-boxes, Y11-tax-agent, Y11-vat-package, Y11-rounding) and
-- docs/adr/0017-accounting-journal-and-no-auto-filing.md.

begin;

-- ---------------------------------------------------------------------------------------------
-- The boxes on the form
-- ---------------------------------------------------------------------------------------------
-- One row per box the return has. Three rows today, and every one of them provisional.
--
-- `display_order` is stated rather than taken from `box_no`, so that answering Y11-vat201-boxes — which may
-- renumber all three — does not silently reorder the working paper a preparer has learnt to read.
create table vat201_box (
  -- The number printed on the form. NOT a serial: it is the authority's, and a surrogate key here would
  -- make the one value the tax agent supplies the one value this table does not hold.
  box_no           integer     primary key check (box_no between 1 and 99),
  label            text        not null check (btrim(label) <> ''),
  -- Which half of the return the box belongs to. Carried rather than inferred from the number, because the
  -- numbering is exactly what is unconfirmed: a rule of "boxes below 9 are output" is a second assumption
  -- riding on the first, and it would be wrong silently.
  side             text        not null check (side in ('output', 'input')),
  display_order    integer     not null unique check (display_order >= 1),
  -- The provenance trio `unconfirmedAssumptionRows()` reads, so a provisional box number appears on the
  -- Unconfirmed Assumptions panel next to the price list and the consent wording rather than only in a
  -- migration comment (docs/12 §2).
  is_provisional   boolean     not null,
  open_question_id text,
  provisional_note text,
  created_at       timestamptz not null default now(),
  constraint vat201_box_provisional_trio check (
    is_provisional = (open_question_id is not null and provisional_note is not null)
  ),
  -- Brief rule 15's mechanism, and the constraint that makes the flag impossible to leave behind. While the
  -- numbering is provisional the LABEL has to SAY so, in the words is_placeholder_text() recognises (0026) —
  -- so a working paper that reaches a reviewer cannot print "Box 1  Standard-rated supplies" as though
  -- somebody had confirmed that it is box 1. The two directions are what make it worth having: the marker
  -- cannot be removed while the flag is set, and the flag cannot be cleared while the marker is there.
  constraint vat201_box_provisional_label_is_marked
    check (is_provisional = is_placeholder_text(label))
);

comment on table vat201_box is
  'One row per VAT201 box. Every row is [UNVERIFIED] against Y11-vat201-boxes: the numbers 1, 3 and 10 '
  'are the recorded provisional answer and not a confirmed layout. Answering it is an UPDATE of these '
  'rows plus the labels, and no code changes.';
comment on column vat201_box.side is
  'output or input. What makes a net payable computable at all, and carried rather than derived from '
  'box_no because the numbering is the unconfirmed part.';

-- ---------------------------------------------------------------------------------------------
-- The mapping: one row per account, saying where its lines land on the form
-- ---------------------------------------------------------------------------------------------
create table vat201_box_mapping (
  -- One row per account, enforced by the primary key. That IS the acceptance line's "exactly one vat_box
  -- tag or an explicit out_of_scope marker": two attributions for one account would double-count every
  -- line on it, and a database that can hold the defect will eventually hold it.
  account_code     text        primary key references account (code),
  -- box           the attribution is complete: this account's lines land in box_no, in column `measure`.
  -- unallocated   the account FEEDS the return and the box number is not known yet. The figure is
  --               reported under its own heading and the return is not fileable while it is non-zero.
  --               A guessed box number would be indistinguishable from a confirmed one, which is the
  --               failure this state exists to avoid (brief rule 15).
  -- out_of_scope  the account feeds no part of the return, DECIDED. Never "not yet classified": that is
  --               what the absence of a row means, and ZY001 refuses it.
  disposition      text        not null
                     check (disposition in ('box', 'unallocated', 'out_of_scope')),
  box_no           integer     references vat201_box (box_no),
  -- Which column of the box. `net_supplies` is the value of the supply or the purchase; `tax` is the VAT
  -- on it. The distinction M-VAT-03 measured the cost of not having.
  measure          text        check (measure in ('net_supplies', 'tax')),
  -- Which direction is positive for this attribution. `credit_less_debit` on the output side, so a debit
  -- to 4095 Discounts and allowances and the credit note that reverses a sale both REDUCE box 1 instead of
  -- being dropped or added.
  contribution     text        check (contribution in ('credit_less_debit', 'debit_less_credit')),
  -- Why. For `out_of_scope` it is the reason nothing is claimed; for `unallocated` it is what is missing.
  -- NOT NULL: an attribution with no stated reason is one nobody can review, and a tax agent reviewing
  -- this table is the entire point of the unit.
  note             text        not null check (btrim(note) <> ''),
  open_question_id text,
  created_at       timestamptz not null default now(),
  -- The shape each disposition requires, as one CASE rather than three CHECKs, so a disposition added
  -- later cannot slip through with no shape at all: an unlisted value makes the CASE return NULL and a
  -- CHECK whose expression is NULL is SATISFIED, which is why the ELSE is written out.
  constraint vat201_box_mapping_shape check (
    case disposition
      when 'box' then box_no is not null and measure is not null and contribution is not null
      -- The box number is the ONLY thing missing, so answering the question is `set disposition = 'box',
      -- box_no = N` and nothing else has to be worked out again.
      when 'unallocated' then box_no is null and measure is not null and contribution is not null
      when 'out_of_scope' then box_no is null and measure is null and contribution is null
      else false
    end
  ),
  -- An unallocated attribution is an OPEN QUESTION and names it. Exactly, in both directions: an
  -- allocated row carrying a question id would keep a settled account on the panel for ever.
  constraint vat201_box_mapping_unallocated_names_its_question
    check ((disposition = 'unallocated') = (open_question_id is not null))
);

comment on table vat201_box_mapping is
  'Account -> VAT201 box, column and direction. The mapping is ROWS so a tax agent can correct it without '
  'a deploy (Y11-vat201-boxes); packages/fixtures/src/vat201.itest.ts proves a changed row moves a figure '
  'to a different box with no code edit. Keyed on the ACCOUNT and not on account.vat_box, because 2035 and '
  '6075 share a grouping and belong in different columns of the box on opposite sides of the arithmetic.';

create index vat201_box_mapping_box_idx on vat201_box_mapping (box_no, account_code)
  where box_no is not null;

-- ---------------------------------------------------------------------------------------------
-- ZY001 — every account is attributed, one way or the other
-- ---------------------------------------------------------------------------------------------
-- DEFERRED, because an account and its attribution are two INSERTs in one transaction and a migration
-- adding an account has to be able to write them in either order.
--
-- Fires for EVERY role including the owner, 0018's reason restated: a migration, an import and a psql
-- session are three callers that are not the application, and the application holds no write privilege on
-- either table at all — so a rule only the application checked would be a rule nothing checks.
create function vat201_mapping_is_complete() returns trigger
language plpgsql
as $$
declare
  v_missing text;
  v_count   integer;
begin
  select count(*), string_agg(a.code, ', ' order by a.code)
    into v_count, v_missing
    from account a
    left join vat201_box_mapping m on m.account_code = a.code
   where m.account_code is null;

  if v_count > 0 then
    raise exception
      'Vat201MappingIncomplete: % account(s) feed the VAT return or do not, and nothing says which: %. '
      'Every account carries exactly one vat201_box_mapping row — a box attribution, an unallocated one '
      'naming its open question, or an explicit out_of_scope marker with a reason. An account with no row '
      'drops out of the return silently, which is the one failure a VAT201 working paper cannot survive.',
      v_count, v_missing
      using errcode = 'ZY001';
  end if;
  return null;
end $$;

comment on function vat201_mapping_is_complete() is
  'Raises ZY001. Deferred to COMMIT so an account and its attribution may be inserted in either order, '
  'and fires for every role including the owner: the application holds no write privilege here, so every '
  'writer is a migration or a psql session.';

create constraint trigger account_carries_a_vat201_attribution
  after insert on account
  deferrable initially deferred
  for each row execute function vat201_mapping_is_complete();

-- Both directions, because they are different defects arriving by different routes: an account inserted
-- with no attribution, and an attribution deleted from under an account that already had one.
--
-- One consequence, stated because it was found by trying: an account can no longer be DELETEd on its own.
-- The foreign key refuses removing the account first and ZY001 refuses removing the attribution first, so
-- both statements have to be in one transaction. That is correct — an account with entries against it is
-- not removable at all — and it is the kind of thing a later migration discovers at the worst moment.
create constraint trigger vat201_mapping_covers_every_account
  after delete on vat201_box_mapping
  deferrable initially deferred
  for each row execute function vat201_mapping_is_complete();

-- ---------------------------------------------------------------------------------------------
-- ZY002 — a revenue account cannot hold tax, and a VAT control account cannot hold a supply
-- ---------------------------------------------------------------------------------------------
-- The one rule in this file that is NOT a VAT question, which is why it is enforced rather than reported:
-- it is double entry. 4010 Treatment revenue holds the NET of a sale, so `measure = 'tax'` on it would put
-- the whole net into box 1's VAT column — a figure about twenty-one times too large, on a return that still
-- balances and whose drill-down still reconciles to it. The mapping is meant to be corrected by hand by a
-- tax agent, and this is the correction that cannot be allowed through.
--
-- BEFORE and not deferred: the foreign key already guarantees the account exists, so the answer is
-- available at statement time and an immediate refusal names the row the writer just typed.
create function vat201_measure_matches_the_account() returns trigger
language plpgsql
as $$
declare
  v_type text;
begin
  if new.measure is null then
    return new;
  end if;

  select a.type into v_type from account a where a.code = new.account_code;

  if new.measure = 'tax' and v_type not in ('asset', 'liability') then
    raise exception
      'Vat201MeasureNotPossible: account % is a(n) % account and cannot hold tax. A revenue account '
      'holds the NET of a supply and an expense account holds what a purchase cost; the tax lives on a '
      'control account (2030, 2035, 1080). Mapping it as measure = ''tax'' would report the whole net as '
      'VAT — about twenty-one times the right figure, on a return whose drill-down still reconciles.',
      new.account_code, v_type
      using errcode = 'ZY002';
  end if;

  if new.measure = 'net_supplies' and v_type not in ('revenue', 'expense') then
    raise exception
      'Vat201MeasureNotPossible: account % is a(n) % account and holds no supply value. A VAT control '
      'account carries tax, not the value it was charged on; mapping it as measure = ''net_supplies'' '
      'would report the tax as though it were turnover.',
      new.account_code, v_type
      using errcode = 'ZY002';
  end if;

  return new;
end $$;

comment on function vat201_measure_matches_the_account() is
  'Raises ZY002. Double entry rather than a VAT question, which is why it is refused and the drift '
  'against account.vat_box is only reported: a revenue account mapped as tax reports the net as VAT.';

create trigger vat201_box_mapping_measure_is_possible
  before insert or update on vat201_box_mapping
  for each row execute function vat201_measure_matches_the_account();

-- ---------------------------------------------------------------------------------------------
-- The boxes, provisional. Three of them, and every number is [UNVERIFIED].
-- ---------------------------------------------------------------------------------------------
-- 1, 3 and 10 are Y11-vat201-boxes' RECORDED provisional answer in docs/OPEN-QUESTIONS.md and are not
-- invented here. No fourth row is added: the open question names three numbers, and a box for zero-rated or
-- exempt supplies would be a number nobody has given. The chart carries no zero-rated or exempt revenue
-- account either, so those groupings are reported by the working paper as a ZERO with the reason attached
-- rather than as a box with a made-up number — a zero that says why is evidence, and a guessed box number
-- filed on a return is not recoverable.
insert into vat201_box (box_no, label, side, display_order, is_provisional, open_question_id, provisional_note) values
  (1, 'Standard-rated supplies — box number to be confirmed (Y11-vat201-boxes)', 'output', 1, true,
      'Y11-vat201-boxes',
      'Box 1 is the recorded provisional answer for standard-rated sales and their output tax. An '
      'FTA-registered tax agent confirms the real number (Y11-tax-agent); until then the label carries '
      'the marker so no working paper can present it as settled.'),
  (3, 'Supplies subject to the reverse charge — box number to be confirmed (Y11-vat201-boxes)', 'output', 2, true,
      'Y11-vat201-boxes',
      'Box 3 is the recorded provisional answer for the reverse charge on imported services: the value of '
      'the supply and the tax the business declares on it. The recoverable half of the same pair is '
      'claimed in the input box, never netted against this one.'),
  (10, 'Recoverable input tax — box number to be confirmed (Y11-vat201-boxes)', 'input', 3, true,
      'Y11-vat201-boxes',
      'Box 10 is the recorded provisional answer for standard-rated expenses and the input tax recovered '
      'on them. Blocked input tax is deliberately NOT mapped to it: whether the blocked expenditure '
      'appears in this box''s value column is a second question nobody has asked.')
on conflict (box_no) do nothing;

-- ---------------------------------------------------------------------------------------------
-- The mapping, derived from the chart rather than retyped
-- ---------------------------------------------------------------------------------------------
-- Four INSERT … SELECTs, keyed on (account.vat_box, account.type). Written this way for three reasons, in
-- order of how much they cost when ignored:
--
--   1. A retyped list of 63 codes can disagree with the chart on the day it is written, and the
--      disagreement is invisible — both sides look like a list of accounts.
--   2. `measure` and `contribution` follow from `account.type` and nothing else: revenue and expense
--      accounts hold supply VALUES, asset and liability accounts hold TAX; revenue and liability accounts
--      are credit-side, asset and expense accounts are debit-side. Deriving them once is one statement of
--      that rule instead of 63 chances to mistype one.
--   3. 4095 Discounts and allowances is a CONTRA revenue account whose normal_balance is 'debit'. Its
--      contribution is `credit_less_debit` all the same, because it belongs to the output side of the
--      return: a 500-fils discount must REDUCE box 1 by 500, not increase it. Deriving from `type` gets
--      that right; deriving from `normal_balance` gets it exactly backwards, on the one account in the
--      chart where the two differ.
--
-- The rows are stored, not a view. A view would be the derivation again, and the derivation is what a tax
-- agent has to be able to overrule per account.
insert into vat201_box_mapping (account_code, disposition, box_no, measure, contribution, note, open_question_id)
select a.code,
       'box',
       1,
       case when a.type in ('revenue', 'expense') then 'net_supplies' else 'tax' end,
       case when a.type in ('revenue', 'liability') then 'credit_less_debit' else 'debit_less_credit' end,
       'Standard-rated supplies. ' ||
         case when a.type = 'revenue' then 'The value of the supply.' else 'The output tax on it.' end,
       null
  from account a
 where a.vat_box in ('standard_rated_supplies', 'output_tax')
on conflict (account_code) do nothing;

insert into vat201_box_mapping (account_code, disposition, box_no, measure, contribution, note, open_question_id)
select a.code,
       'box',
       3,
       case when a.type in ('revenue', 'expense') then 'net_supplies' else 'tax' end,
       case when a.type in ('revenue', 'liability') then 'credit_less_debit' else 'debit_less_credit' end,
       'Reverse charge on imported services. ' ||
         case
           when a.type = 'expense' then 'The value of the imported supply, declared by us.'
           else 'The output tax we declare on it, never netted against the input claim.'
         end,
       null
  from account a
 where a.vat_box = 'reverse_charge'
on conflict (account_code) do nothing;

insert into vat201_box_mapping (account_code, disposition, box_no, measure, contribution, note, open_question_id)
select a.code,
       'box',
       10,
       case when a.type in ('revenue', 'expense') then 'net_supplies' else 'tax' end,
       case when a.type in ('revenue', 'liability') then 'credit_less_debit' else 'debit_less_credit' end,
       'Recoverable standard-rated expenses. ' ||
         case
           when a.type = 'expense' then 'What the purchase cost, net of recoverable tax.'
           else 'The input tax claimed, from a supplier''s tax invoice or from our own self-assessment.'
         end,
       null
  from account a
 where a.vat_box = 'recoverable_input_tax'
on conflict (account_code) do nothing;

-- Blocked input tax. IN SCOPE and UNALLOCATED, which is the honest state and not a placeholder for one.
--
-- The expenditure is real and the tax on it was borne rather than claimed, so the account cannot be
-- out_of_scope; and whether the blocked NET appears in the input box's value column is a question
-- Y11-vat201-boxes' wording does not reach, so it cannot be mapped to box 10 either. Note also that 6090
-- carries the net AND the blocked VAT in one debit (post-bill: "blocked VAT is part of what the thing
-- cost"), so the ledger cannot separate them at all — the disclosure figure comes from
-- bill_line.blocked_input_vat_fils, which is M-VAT-02's working paper, and the return reconciles against it
-- rather than re-deriving it here.
insert into vat201_box_mapping (account_code, disposition, box_no, measure, contribution, note, open_question_id)
select a.code,
       'unallocated',
       null,
       'net_supplies',
       'debit_less_credit',
       'Blocked input tax (entertainment and staff hospitality, docs/04 §4). The expenditure is in scope '
       'and the tax on it is borne rather than claimed. Whether the blocked value appears in the input '
       'box''s value column is a question Y11-vat201-boxes'' wording does not reach, so no box number is '
       'guessed. Note that this account carries the net AND the blocked VAT in one debit, so the '
       'disclosure figure comes from bill_line and not from here.',
       -- Its OWN question and not Y11-vat201-boxes, which asks for the numbers for standard-rated sales,
       -- reverse charge and recoverable input VAT and does not reach this one. Filing a genuinely
       -- unasked question under a question that IS asked is how it gets answered by implication.
       'Y11-vat201-blocked-box'
  from account a
 where a.vat_box = 'blocked_input_tax'
on conflict (account_code) do nothing;

-- Everything the chart says feeds no grouping, made EXPLICIT. `account.vat_box is null` is documented in
-- 0018 as a decision and never "not yet classified", and this turns that documented decision into a row a
-- tax agent can see, disagree with and correct — which a NULL cannot be.
insert into vat201_box_mapping (account_code, disposition, box_no, measure, contribution, note, open_question_id)
select a.code,
       'out_of_scope',
       null,
       null,
       null,
       'Feeds no VAT201 box. ' ||
         case a.type
           when 'asset' then 'A balance-sheet asset: a movement of money or of a thing owned is not a supply.'
           when 'liability' then 'A balance-sheet liability: what is owed is not a supply.'
           when 'equity' then 'Equity: an owner''s contribution or drawing is not a supply.'
           when 'revenue' then 'Revenue outside the scope of VAT.'
           else 'An expense carrying no recoverable input tax — wages, a government fee, a fine, a ' ||
                'non-cash charge or a reconciliation difference.'
         end,
       null
  from account a
 where a.vat_box is null
on conflict (account_code) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Where a journal entry's source document is
-- ---------------------------------------------------------------------------------------------
-- The acceptance line is "every non-zero box drills box to journal line to source document", and the link
-- runs the other way in every table: each document carries the entry it posted. So this is a UNION over the
-- document tables rather than a column on the journal, and it has to stay a union — a `document_id` on
-- `journal_entry` would be a second answer to "what posted this" sitting beside eleven foreign keys that
-- already answer it.
--
-- `document_number` is NULL where the document has no printed number (a package sale, an opening-balance
-- import, a cash session). Deliberately not a fabricated reference: brief rule 15, and the drill-down
-- asserts a reachable DOCUMENT rather than a printed one.
create function vat201_entry_document_direct(p_entry_id text)
returns table (document_kind text, document_id text, document_number text)
language sql
stable
as $$
  select 'invoice', i.id::text, i.display_number
    from checkout_finalisation cf
    join invoice i on i.id = cf.invoice_id
   where cf.journal_entry_id = p_entry_id
  union all
  select 'credit_note', c.id::text, c.display_number
    from credit_note c where c.journal_entry_id = p_entry_id
  union all
  select 'bill', b.bill_id::text, b.display_number
    from bill b where b.entry_id = p_entry_id
  union all
  select 'package_sale', s.id::text, null
    from package_sale s where s.journal_entry_id = p_entry_id
  union all
  select 'package_redemption', r.id::text, null
    from package_redemption r where r.journal_entry_id = p_entry_id
  union all
  select 'opening_balance_import', o.import_id::text, null
    from opening_balance_import o where o.entry_id = p_entry_id
  union all
  select 'cash_session', cs.id::text, null
    from cash_session cs where cs.journal_entry_id = p_entry_id
  union all
  select 'cash_drop', cd.id::text, cd.reference
    from cash_drop cd where cd.journal_entry_id = p_entry_id
  union all
  select 'cash_session_adjustment', ca.id::text, null
    from cash_session_adjustment ca where ca.journal_entry_id = p_entry_id;
$$;

comment on function vat201_entry_document_direct(text) is
  'The documents that name this entry, one row each. A union because every document carries the entry it '
  'posted and not the other way round; a column on journal_entry would be a second answer beside nine '
  'foreign keys that already give one.';

-- A dated reversal (M-VAT-06's `postDatedCorrection`) posts a fresh entry with `reverses` set and no
-- document of its own — correctly: the document is the one being corrected. Without this hop every
-- correction's lines would drill down to nothing, and the acceptance line would fail on the one posting
-- path a closed period actually produces.
--
-- ONE hop and not a recursive walk. `postDatedCorrection` reverses the ORIGINAL entry, so a chain of
-- reversals of reversals is not a shape it can produce, and a bounded lookup cannot spin on a
-- `reverses` cycle that `journal_entry_is_not_its_own_reversal` does not rule out.
--
-- The hop is taken only when the entry has NO document of its own, so an entry that both carries a
-- document and reverses something (a credit note does both) yields exactly one row. That matters beyond
-- tidiness: `vat201_box_line` joins this LATERALLY without a LIMIT, so a second row DUPLICATES a journal
-- line and the exhaustive-partition census fails. The uniqueness is therefore proved by the partition
-- proof rather than assumed by a `limit 1` that would have hidden it.
create function vat201_entry_document(p_entry_id text)
returns table (document_kind text, document_id text, document_number text)
language sql
stable
as $$
  select d.document_kind, d.document_id, d.document_number
    from vat201_entry_document_direct(p_entry_id) d
  union all
  select 'reversal_of_' || d.document_kind, d.document_id, d.document_number
    from journal_entry e
    cross join lateral vat201_entry_document_direct(e.reverses) d
   where e.entry_id = p_entry_id
     and e.reverses is not null
     and not exists (select 1 from vat201_entry_document_direct(p_entry_id));
$$;

comment on function vat201_entry_document(text) is
  'The entry''s own document, or — only when it has none — the document of the entry it reverses, marked '
  'reversal_of_*. One hop: postDatedCorrection reverses the original, never a reversal.';

-- ---------------------------------------------------------------------------------------------
-- vat201_box_line — the drill-down, and the ONE definition the totals aggregate over
-- ---------------------------------------------------------------------------------------------
-- Every journal line dated in the window, with its attribution, its signed contribution and its source
-- document. Every line, not only the attributed ones: the exhaustive-partition acceptance line needs the
-- out-of-scope bucket to be part of the same enumeration, because a partition proved over two queries is a
-- proof about two `where` clauses agreeing.
--
-- The join to the mapping is a LEFT JOIN, which is the dangerous direction handled on purpose. An INNER
-- join would DROP a line whose account has no attribution — the line would vanish from the return and from
-- the census that is supposed to notice, and both would report success. LEFT JOIN plus
-- `coalesce(m.disposition, 'unattributed')` makes the same defect a visible bucket with a count.
--
-- No division, no rounding, no rate, no `numeric`: see the header. `::bigint` on both sides because the
-- fils domain is integer and a sum over it must not be handed back as a float (`trial-balance.ts` records
-- the four-fils difference a `number` produced out of nothing).
create function vat201_box_line(p_from date, p_to date)
returns table (
  entry_id        text,
  line_no         smallint,
  entry_date      date,
  source          text,
  narrative       text,
  account_code    text,
  account_name    text,
  disposition     text,
  box_no          integer,
  measure         text,
  contribution    text,
  debit_fils      bigint,
  credit_fils     bigint,
  signed_fils     bigint,
  document_kind   text,
  document_id     text,
  document_number text
)
language sql
stable
as $$
  select l.entry_id,
         l.line_no,
         e.entry_date,
         e.source,
         e.narrative,
         l.account_code,
         a.name,
         coalesce(m.disposition, 'unattributed'),
         m.box_no,
         m.measure,
         m.contribution,
         l.debit_fils::bigint,
         l.credit_fils::bigint,
         case m.contribution
           when 'credit_less_debit' then l.credit_fils::bigint - l.debit_fils::bigint
           when 'debit_less_credit' then l.debit_fils::bigint - l.credit_fils::bigint
           -- Out of scope, or unattributed. Zero rather than NULL so that a sum over the whole
           -- enumeration is the sum of the attributed lines and a NULL cannot swallow a bucket.
           else 0::bigint
         end,
         d.document_kind,
         d.document_id,
         d.document_number
    from journal_line l
    join journal_entry e on e.entry_id = l.entry_id
    join account a on a.code = l.account_code
    left join vat201_box_mapping m on m.account_code = l.account_code
    left join lateral vat201_entry_document(l.entry_id) d on true
   where e.entry_date between p_from and p_to;
$$;

comment on function vat201_box_line(date, date) is
  'Every journal line in the window with its VAT201 attribution, signed contribution and source document. '
  'The drill-down AND the definition vat201_box_total() aggregates over, so a box cannot disagree with '
  'the lines a preparer is shown when they click it.';

-- ---------------------------------------------------------------------------------------------
-- vat201_box_total — the boxes, as an aggregate over the drill-down
-- ---------------------------------------------------------------------------------------------
-- Every box, always, even at zero. A box with nothing in it is a row that says so; an absent row is
-- indistinguishable from a box nobody computed, which is the argument PAYABLES_AGING_BUCKETS and
-- INPUT_VAT_NON_RECOVERY_REASONS both make about an empty bucket.
create function vat201_box_total(p_from date, p_to date)
returns table (
  box_no            integer,
  label             text,
  side              text,
  display_order     integer,
  is_provisional    boolean,
  open_question_id  text,
  net_supplies_fils bigint,
  tax_fils          bigint,
  line_count        bigint
)
language sql
stable
as $$
  select b.box_no,
         b.label,
         b.side,
         b.display_order,
         b.is_provisional,
         b.open_question_id,
         coalesce(sum(case when l.measure = 'net_supplies' then l.signed_fils else 0 end), 0)::bigint,
         coalesce(sum(case when l.measure = 'tax' then l.signed_fils else 0 end), 0)::bigint,
         count(l.entry_id)::bigint
    from vat201_box b
    left join vat201_box_line(p_from, p_to) l on l.box_no = b.box_no
   group by b.box_no, b.label, b.side, b.display_order, b.is_provisional, b.open_question_id;
$$;

comment on function vat201_box_total(date, date) is
  'One row per box, always, even at zero. A sum over vat201_box_line() and never a second query over the '
  'journal: two queries are two chances to filter differently, and a one-fils disagreement between a box '
  'and its drill-down is the defect this unit exists to prevent.';

-- The other two buckets, by account, so nothing in the period is reported only as a total. `unattributed`
-- is included although ZY001 makes it unreachable: the acceptance line is a partition proof, and a proof
-- whose failing case cannot be represented is not one.
create function vat201_unboxed_total(p_from date, p_to date)
returns table (
  disposition       text,
  account_code      text,
  account_name      text,
  open_question_id  text,
  net_supplies_fils bigint,
  tax_fils          bigint,
  debits_fils       bigint,
  credits_fils      bigint,
  line_count        bigint
)
language sql
stable
as $$
  select l.disposition,
         l.account_code,
         l.account_name,
         m.open_question_id,
         coalesce(sum(case when l.measure = 'net_supplies' then l.signed_fils else 0 end), 0)::bigint,
         coalesce(sum(case when l.measure = 'tax' then l.signed_fils else 0 end), 0)::bigint,
         -- Debits PLUS credits and never the net, which is the measurement M-TILL-09's probe got wrong:
         -- 4010 credited against the contra 4095 by the same figure nets to zero and HAS moved money.
         sum(l.debit_fils)::bigint,
         sum(l.credit_fils)::bigint,
         count(*)::bigint
    from vat201_box_line(p_from, p_to) l
    left join vat201_box_mapping m on m.account_code = l.account_code
   where l.disposition <> 'box'
   group by l.disposition, l.account_code, l.account_name, m.open_question_id;
$$;

comment on function vat201_unboxed_total(date, date) is
  'The unallocated, out-of-scope and unattributed buckets, per account. Debits PLUS credits rather than '
  'the net, because a credit against a contra account nets to zero and has still moved money.';

-- ---------------------------------------------------------------------------------------------
-- The exhaustive partition, as a measurement
-- ---------------------------------------------------------------------------------------------
-- Four counts, one statement, so the acceptance line is a figure a psql session can reproduce rather than
-- a property a test file claims. All four have to be read together:
--
--   lines_in_period   the journal's own count over the window — the population.
--   lines_enumerated  what vat201_box_line() returned. GREATER than the population means a line was
--                     duplicated, which is the failure mode the LATERAL document join can produce.
--   lines_distinct    distinct (entry_id, line_no). Equal to lines_in_period when nothing was dropped.
--   unattributed      lines whose account has no mapping row. ZY001 makes this unreachable; it is counted
--                     so that "unreachable" is a measurement rather than an assertion.
create function vat201_partition_census(p_from date, p_to date)
returns table (
  lines_in_period  bigint,
  lines_enumerated bigint,
  lines_distinct   bigint,
  unattributed     bigint,
  boxed            bigint,
  unallocated      bigint,
  out_of_scope     bigint
)
language sql
stable
as $$
  -- ONE pass over the enumeration, with `filter` rather than seven subqueries over it.
  --
  -- Measured, because the first version was seven separate `select … from vat201_box_line(…)` subqueries
  -- and it cost 912 ms over 874 lines against 32 ms for a single call: PostgreSQL evaluates the
  -- set-returning function once per subquery and there is nothing to share. A census is the cheapest
  -- thing on the working paper and it was the most expensive by a factor of thirty.
  --
  -- An aggregate with no GROUP BY always returns exactly one row, so an empty period reports zeros rather
  -- than no row at all — which matters, because the reader treats a missing row as an invariant violation
  -- and a quarter with no trade in it is not one.
  select (select count(*)
            from journal_line l
            join journal_entry e on e.entry_id = l.entry_id
           where e.entry_date between p_from and p_to)::bigint,
         count(*)::bigint,
         count(distinct (l.entry_id, l.line_no))::bigint,
         (count(*) filter (where l.disposition = 'unattributed'))::bigint,
         (count(*) filter (where l.disposition = 'box'))::bigint,
         (count(*) filter (where l.disposition = 'unallocated'))::bigint,
         (count(*) filter (where l.disposition = 'out_of_scope'))::bigint
    from vat201_box_line(p_from, p_to) l;
$$;

comment on function vat201_partition_census(date, date) is
  'The exhaustive-partition acceptance line as seven counts a psql session can reproduce. '
  'lines_enumerated > lines_in_period is a duplicated line; lines_distinct < lines_in_period is a dropped '
  'one; unattributed > 0 is an account ZY001 should have refused.';

-- Where the mapping and the chart no longer agree. Reported and not refused: see the header.
create function vat201_mapping_disagreement()
returns table (account_code text, account_name text, chart_grouping text, disposition text, box_no integer)
language sql
stable
as $$
  select a.code, a.name, a.vat_box, m.disposition, m.box_no
    from account a
    join vat201_box_mapping m on m.account_code = a.code
   where (a.vat_box is null) <> (m.disposition = 'out_of_scope');
$$;

comment on function vat201_mapping_disagreement() is
  'One row per account whose chart grouping and VAT201 attribution disagree about whether it feeds the '
  'return at all. A REPORT and not a refusal: reclassifyAccountRecoverability updates account.vat_box as '
  'a sanctioned owner operation, and a trigger here would refuse the very change the chart permits.';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- SELECT only for the application, `account`'s own argument restated (0018): a classification is a
-- migration and not a settings screen. The mapping is meant to be corrected — by a migration, once a tax
-- agent has answered — and "correctable by a deploy" is a very different thing from "writable by a
-- request". A column-list grant does not narrow an existing table-level one, so the revokes are explicit.
grant select on vat201_box, vat201_box_mapping to berelax_app;
revoke insert, update, delete, truncate on vat201_box, vat201_box_mapping from berelax_app;

grant select on vat201_box, vat201_box_mapping to berelax_readonly;

commit;
