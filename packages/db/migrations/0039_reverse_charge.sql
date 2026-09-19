-- 0039 — the imported-services reverse charge: two entries, never one, and the scan that finds a missing pair.
--
-- 0028 left `imported_services_reverse_charge` out of `bill_line.tax_treatment` and said so in the column
-- comment; 0034 repeated it. Both gave the same reason: a value the schema accepts but no code path posts
-- correctly would record a bill that looks complete and understates the return. This migration is the
-- other half — the treatment, the TWO figures it produces, the posting rule that keeps the entry balanced,
-- the refusals that stop one side of the pair existing without the other, and the population the nightly
-- exception report scans.
--
-- ## A reverse charge is two entries
--
-- An offshore supplier charges no UAE VAT: DigitalOcean, Resend, Google, Meta and Anthropic (docs/04 §4)
-- are not established here and issue no UAE tax invoice, which is why `supplier_tax_profile` refuses a TRN
-- on an offshore supplier at all. The tax is not absent, though — on an imported service the recipient
-- accounts for it. So one supply produces two VAT entries:
--
--   **output side**  the VAT the business must declare as though it had charged itself.
--                    `Cr 2035 Reverse-charge VAT payable`, whose `vat_box` is `reverse_charge`.
--   **input side**   the same VAT, claimed back where the category allows recovery.
--                    `Dr 1080 Recoverable input VAT`, whose `vat_box` is `recoverable_input_tax`.
--
-- Where the input is recoverable the two are equal and the net cash effect is nil — which is exactly why
-- the obligation is missed: nothing is owed, so nothing prompts anybody. Where the input is **blocked**
-- (entertainment, or a staff benefit the business is not obliged to provide — 0034, docs/04 §4 §7) the
-- output stands alone and the VAT is a real cost, debited to the expense with the rest of the line. A
-- reverse charge recorded as ONE figure is the mistake this migration exists to prevent: a single net-zero
-- line declares nothing in the output box and claims nothing in the input box, and the return is wrong on
-- both sides while the ledger balances perfectly.
--
-- Hence two columns, not one, and not a single "reverse_charge_vat_fils" with a sign convention. The pair
-- is the record: `output - input` is the tax the business bore, which is zero for a recoverable category
-- and the whole amount for a blocked one. It is derived on the way out rather than stored, because a third
-- column is a third figure that can disagree with the two it is made of.
--
-- ## The reverse charge is NOT part of `gross`, `net` or `vat_fils`
--
-- `gross_fils = net_fils` on a reverse-charge line, and `vat_fils` (generated as `gross - net`) is zero.
-- That is not an omission: the supplier charged nothing, the payable to them is the consideration, and the
-- reverse-charge VAT is owed to the FTA rather than to the vendor. Adding it to the gross would inflate
-- trade payables by tax the supplier never invoiced and will never be paid — and the payment run would
-- then overpay every offshore vendor by 5%.
--
-- For the same reason the input side is its own column rather than `recoverable_input_vat_fils`. That
-- column is the claim supported by a supplier's tax invoice, which is why `bill_recoverable_needs_a_trn`
-- demands a TRN for it — and an offshore supplier has none. The document behind a reverse-charge claim is
-- the business's own self-assessment, not the vendor's invoice, so the two claims are two columns and the
-- TRN rule keeps applying unchanged to the one it was written for.
--
-- ## The rate is data, and the figure is pinned to it
--
-- `bill_line_reverse_charge_output_matches_the_rate` pins the output figure to
-- `round(net_fils × vat_rate_bp / 10000)`. The rate is the authority's to set and a filed line keeps the
-- rate it was filed at (0028), so the arithmetic cannot be assumed — and unlike a sale, where VAT is the
-- remainder of an authoritative gross (ADR 0007), a reverse charge has no gross to take a remainder from:
-- the tax is computed ON the consideration and a rounding is unavoidable. The same rule is stated in
-- `packages/core/src/tax/reverse-charge.ts` as `reverseChargeOn`, because `packages/db` may not import
-- `packages/core`, and `packages/fixtures/src/reverse-charge.itest.ts` asserts the two agree over the
-- half-fils boundaries. The same arrangement, for the same reason, as `payables_aging_bucket()`.
--
-- ## Why a nightly report exists at all, when so much is enforced here
--
-- Everything below refuses a bill whose reverse charge is internally wrong. What no constraint can refuse
-- is a bill that was RIGHT when it was written and is wrong now, and there are two such routes:
--
--   1. `supplier_tax_profile.place_of_supply_rule` is UPDATEable — deliberately, because it is
--      configuration an admin corrects (0028 grants UPDATE on the profile and withholds it on the bill).
--      A supplier mistakenly recorded `outside_scope` has bills posted with no pair, entirely legally;
--      correcting the rule makes every one of them a missing reverse charge, retroactively. PostgreSQL
--      does not re-validate a CHECK on a row nobody touched, and the bill is append-only, so nothing
--      fires and nothing can.
--   2. Every bill posted before this migration. Their two columns default to 0, which is the only value
--      they can have, and whether each one owed a reverse charge is a question about a row elsewhere.
--
-- The place-of-supply rule is therefore deliberately NOT snapshotted onto the bill, unlike the TRN and the
-- residency. The two cases are opposites: a supplier's registration genuinely changes over time, so the
-- TRN must be frozen or a later registration would make January recoverable. The place of supply does
-- not change — it is a fact about the supply that we either recorded correctly or did not. If we recorded
-- it wrongly the return was wrong, and the answer is an adjustment, not a frozen mistake that reads as
-- correct for ever. Freezing it would make the exception report structurally incapable of finding
-- anything, which is a report that reports success silently.
--
-- ## Custom SQLSTATEs (class ZV is 0028's; 'ZL' is the ledger's, 'ZB' booking's)
--
--   ZV007  ReverseChargeInputDoesNotMatchAccount  — the input side contradicts the account's recovery
--                                                   classification: claimed on an account that is not
--                                                   recoverable, or not claimed on one that is
--   ZV008  ReverseChargeDoesNotMatchPlaceOfSupply — a line that owes a reverse charge accounts for none,
--                                                   or one that owes none accounts for some
--
-- Matched on the code and never on the message, like ZV001-ZV006.
--
-- See docs/04-uae-compliance.md §4, docs/OPEN-QUESTIONS.md Y11-vat201-boxes, ADR 0007 and ADR 0017.

begin;

-- ---------------------------------------------------------------------------------------------
-- The two figures, on the line and on the header
-- ---------------------------------------------------------------------------------------------
-- `default 0`, for the reason 0034 gave its own columns one: every row that exists predates the treatment,
-- so 0 is the only value any of them can hold, and the CHECKs below pin both columns on a row where the
-- figures matter. Dropping the default instead would refuse every INSERT that does not name the columns,
-- including the known-bad fixtures in scripts/test-gates.mjs — and a probe refused by a missing column is
-- a probe that no longer tests the rule it names.
alter table bill_line add column reverse_charge_output_vat_fils fils_nonneg not null default 0;
alter table bill_line add column reverse_charge_input_vat_fils  fils_nonneg not null default 0;
alter table bill      add column reverse_charge_output_vat_fils fils_nonneg not null default 0;
alter table bill      add column reverse_charge_input_vat_fils  fils_nonneg not null default 0;

comment on column bill_line.reverse_charge_output_vat_fils is
  'The VAT this imported service self-accounts as though the business had charged itself: credited to '
  '2035 Reverse-charge VAT payable, whose vat_box is reverse_charge. Zero for every other treatment. It '
  'is NOT part of gross_fils — the supplier charged nothing and is owed nothing extra.';
comment on column bill_line.reverse_charge_input_vat_fils is
  'The same VAT claimed back, debited to 1080 Recoverable input VAT. Equal to the output side where the '
  'account is classified recoverable and ZERO where it is blocked or out of scope, which is the one case '
  'a reverse charge costs real money. Its own column rather than recoverable_input_vat_fils, because that '
  'claim rests on a supplier TRN and an offshore supplier has none.';
comment on column bill.reverse_charge_output_vat_fils is
  'The sum of the lines output sides. A summary like every other header figure, checked at COMMIT by '
  'bill_totals_match_lines.';
comment on column bill.reverse_charge_input_vat_fils is
  'The sum of the lines input sides. Below the output total by exactly the tax the business bore on '
  'blocked categories, which is the figure that makes a reverse charge visible in the ledger at all.';

-- The vocabulary grows by exactly one value, and this is the last treatment either 0028 or 0034 named as
-- deliberately absent. Dropped and re-added rather than edited, because a CHECK cannot be altered in place.
alter table bill_line drop constraint bill_line_tax_treatment_check;
alter table bill_line add constraint bill_line_tax_treatment_check
  check (tax_treatment in ('standard_recoverable', 'blocked_not_recoverable',
                           'imported_services_reverse_charge',
                           'no_trn_not_recoverable', 'zero_rated', 'exempt', 'out_of_scope'));

comment on column bill_line.tax_treatment is
  'The claim this line supports, stored on the line and never recomputed. Two treatments carry VAT the '
  'SUPPLIER charged: standard_recoverable, whose VAT is claimed, and blocked_not_recoverable, whose VAT is '
  'cost. imported_services_reverse_charge carries none of the suppliers and self-accounts its own, in two '
  'entries — the output side always, the input side only where the account allows recovery.';

-- A reverse-charge line carries a RATE although it carries no supplier VAT, which is why this constraint
-- is widened rather than left alone: the rate is what the self-assessed figure is computed at, and a
-- filed line keeps the rate it was filed at. Renamed constraints are invisible to `pnpm db:drift`, which
-- compares columns only, so packages/db/src/schema/bill.ts is updated with it.
alter table bill_line drop constraint bill_line_rate_matches_treatment;
alter table bill_line add constraint bill_line_rate_matches_treatment
  check (tax_treatment in ('standard_recoverable', 'blocked_not_recoverable',
                           'imported_services_reverse_charge')
         or vat_rate_bp = 0);

-- And it must carry one. A reverse charge at 0 bp accounts for nothing, and the figure below would have
-- no rate to be checkable against.
alter table bill_line add constraint bill_line_reverse_charge_carries_a_rate
  check (tax_treatment <> 'imported_services_reverse_charge' or vat_rate_bp > 0);

-- Only an imported service self-accounts. A reverse charge on a domestic supply would declare output VAT
-- on a supply the supplier already charged us for, and then claim it a second time.
alter table bill_line add constraint bill_line_reverse_charge_only_on_an_imported_service
  check (tax_treatment = 'imported_services_reverse_charge'
         or (reverse_charge_output_vat_fils = 0 and reverse_charge_input_vat_fils = 0));

-- THE constraint of this migration, at row level: a line recorded as an imported service accounts for
-- output VAT. A zero here is the whole failure — the bill posts, balances, reconciles to the supplier's
-- invoice to the fils, and declares nothing in the output box.
alter table bill_line add constraint bill_line_imported_service_accounts_for_output_vat
  check (tax_treatment <> 'imported_services_reverse_charge' or reverse_charge_output_vat_fils > 0);

-- The figure is the rate applied to the consideration, rounded half-up — `numeric` throughout, so nothing
-- here is a float and nothing can overflow bigint on the way (ADR 0007). Stated in SQL as well as in
-- `reverseChargeOn`, and asserted to agree with it over the boundaries.
alter table bill_line add constraint bill_line_reverse_charge_output_matches_the_rate
  check (
    reverse_charge_output_vat_fils
      = round(net_fils::numeric * vat_rate_bp / 10000)
    or tax_treatment <> 'imported_services_reverse_charge'
  );

-- Claim all of it or none of it. Recoverability is a property of the ACCOUNT (0034), so a line is either
-- coded to a category that allows recovery or to one that does not; a partial claim would be an
-- apportionment, which nothing in this system computes and nobody could reproduce from the row. This is
-- also the "the two sides do not agree" refusal in the direction that matters: more claimed than declared.
alter table bill_line add constraint bill_line_reverse_charge_input_is_all_or_nothing
  check (reverse_charge_input_vat_fils in (0, reverse_charge_output_vat_fils));

-- The header cannot claim more than it declares. NOT all-or-nothing here, unlike the line: one offshore
-- invoice may legitimately mix a recoverable line with a blocked one, and the header then sits between the
-- two — which is precisely the figure a tax agent asks about.
alter table bill add constraint bill_reverse_charge_input_not_above_output
  check (reverse_charge_input_vat_fils <= reverse_charge_output_vat_fils);

-- A reverse charge belongs to an offshore supply. Asserted against the SNAPSHOT rather than the profile,
-- so it holds for every role and cannot be undone by a later correction to the supplier — the mirror of
-- supplier_tax_profile_rule_matches_residency, on the row that the return is built from.
alter table bill add constraint bill_reverse_charge_needs_an_offshore_supplier
  check (reverse_charge_output_vat_fils = 0 or supplier_residency = 'offshore');

-- The population the nightly exception report scans: an offshore bill that accounts for no reverse charge.
-- Partial, because on a healthy ledger it is the smaller half of a small table and the report must not read
-- every bill ever posted to find none.
create index bill_reverse_charge_missing_idx on bill (supplier_id, entry_id)
  where supplier_residency = 'offshore' and reverse_charge_output_vat_fils = 0;

-- ---------------------------------------------------------------------------------------------
-- The header is still a summary of the lines — now including both sides of the pair
-- ---------------------------------------------------------------------------------------------
-- Replaced rather than extended by a third trigger, for the reason 0034 gave: two functions summing the
-- same rows are two chances to disagree about which rows they are. Still DEFERRED by the triggers 0028
-- created, which this replacement leaves in place.
--
-- This is also the check that makes the header's pair evidence rather than assertion. Without it a bill
-- could state a 5,000-fils output side its lines never produced, and the output box would be summed from a
-- figure no document supports.
create or replace function assert_bill_totals_match_lines() returns trigger
language plpgsql
as $$
declare
  -- `new.bill_id` on both tables: the header's own key and the line's parent share the column name,
  -- which is what lets one function serve both triggers.
  v_bill_id     uuid := new.bill_id;
  v_net         bigint;
  v_gross       bigint;
  v_recoverable bigint;
  v_blocked     bigint;
  v_rc_output   bigint;
  v_rc_input    bigint;
  v_lines       integer;
  v_h_net       bigint;
  v_h_gross     bigint;
  v_h_recover   bigint;
  v_h_blocked   bigint;
  v_h_rc_output bigint;
  v_h_rc_input  bigint;
begin
  select b.net_fils, b.gross_fils, b.recoverable_input_vat_fils, b.blocked_input_vat_fils,
         b.reverse_charge_output_vat_fils, b.reverse_charge_input_vat_fils
    into v_h_net, v_h_gross, v_h_recover, v_h_blocked, v_h_rc_output, v_h_rc_input
    from bill b where b.bill_id = v_bill_id;
  -- The bill is gone, which can only happen inside a transaction that also removed it. Nothing to
  -- check, and raising here would refuse a legitimate rollback path.
  if not found then
    return null;
  end if;

  select coalesce(sum(l.net_fils), 0), coalesce(sum(l.gross_fils), 0),
         coalesce(sum(l.recoverable_input_vat_fils), 0), coalesce(sum(l.blocked_input_vat_fils), 0),
         coalesce(sum(l.reverse_charge_output_vat_fils), 0),
         coalesce(sum(l.reverse_charge_input_vat_fils), 0),
         count(*)
    into v_net, v_gross, v_recoverable, v_blocked, v_rc_output, v_rc_input, v_lines
    from bill_line l where l.bill_id = v_bill_id;

  -- A bill with no lines describes nothing. It fires no line trigger at all, which is why the header
  -- carries its own copy of this constraint trigger: without it, an empty bill would commit and sit in
  -- the payables ledger as a demand for money with no stated reason.
  if v_lines = 0 then
    raise exception 'BillTotalsDoNotMatchLines: bill % has no lines', v_bill_id
      using errcode = 'ZV002';
  end if;

  if v_net <> v_h_net or v_gross <> v_h_gross or v_recoverable <> v_h_recover
     or v_blocked <> v_h_blocked or v_rc_output <> v_h_rc_output or v_rc_input <> v_h_rc_input then
    raise exception
      'BillTotalsDoNotMatchLines: bill % header says net %, gross %, recoverable %, blocked %, '
      'reverse-charge output %, reverse-charge input % but its % line(s) sum to net %, gross %, '
      'recoverable %, blocked %, reverse-charge output %, reverse-charge input %',
      v_bill_id, v_h_net, v_h_gross, v_h_recover, v_h_blocked, v_h_rc_output, v_h_rc_input,
      v_lines, v_net, v_gross, v_recoverable, v_blocked, v_rc_output, v_rc_input
      using errcode = 'ZV002';
  end if;

  return null;
end $$;

comment on function assert_bill_totals_match_lines() is
  'Raises ZV002 at COMMIT. Both triggers read new.bill_id, which bill and bill_line both carry, so one '
  'function serves both. Since 0039 it also compares both sides of the reverse charge, which is what '
  'makes the output box a summary of documents rather than a figure the header asserted.';

-- ---------------------------------------------------------------------------------------------
-- A pair that is due is accounted for, and one that is not due is not invented
-- ---------------------------------------------------------------------------------------------
-- Two mistakes, one trigger, because both are the same question asked from opposite sides — does this line
-- owe a reverse charge? — and the answer to both is a row in `supplier_tax_profile` neither the line nor a
-- CHECK on the bill can see.
--
-- **The line owes one and accounts for none (ZV008).** This is the missing pair at its source, and it is
-- the failure docs/04 §4 calls "the most commonly missed obligation at this size". Caught at the statement
-- that wrote it, where a person is holding the invoice.
--
-- **The line accounts for one and owes none.** An `outside_scope` supply that self-accounts VAT declares
-- output tax on something UAE VAT never reached, which overstates the return — the rarer direction, and
-- the one nobody would think to look for.
--
-- The rule is read from the profile rather than from a snapshot, and the migration header says why: the
-- place of supply is a fact about the supply rather than a state of the supplier, so a correction to it
-- makes the bills already posted wrong rather than making the correction retroactive. What this trigger
-- cannot do is revisit those bills, which is the whole reason the nightly report exists.
--
-- A mixed invoice — an imported-services supplier billing something genuinely outside the scope of UAE VAT
-- on the same document — is refused here rather than allowed. There is no per-line place of supply in this
-- schema to record it with, so allowing it would mean accepting a line whose treatment nothing states a
-- basis for; the conservative direction is to refuse, because under-declaring the reverse charge is the
-- failure this unit exists to prevent. Expressing a per-supply place of supply is a schema change, which
-- is the same answer 0028 gives for a new document series.
create function assert_reverse_charge_matches_place_of_supply() returns trigger
language plpgsql
as $$
declare
  v_rule        text;
  v_supplier    text;
  v_box         text;
  v_recoverable boolean;
  v_name        text;
  v_class       text;
begin
  select p.place_of_supply_rule, s.code
    into v_rule, v_supplier
    from bill b
    join supplier s            on s.supplier_id = b.supplier_id
    join supplier_tax_profile p on p.supplier_id = b.supplier_id
   where b.bill_id = new.bill_id;

  -- No profile is ZV003's refusal to make, raised by bill_supplier_tax_snapshot before the bill exists.
  -- Naming it here as well would report the wrong problem.
  if v_rule is null then
    return new;
  end if;

  if v_rule = 'imported_services_reverse_charge' and new.reverse_charge_output_vat_fils = 0 then
    raise exception
      'ReverseChargeDoesNotMatchPlaceOfSupply: line % from supplier "%" is an imported service and '
      'accounts for no reverse-charge VAT, so the output tax on it would be declared nowhere',
      new.line_no, v_supplier
      using errcode = 'ZV008',
            hint = 'Record the line as imported_services_reverse_charge and state the VAT it '
                   'self-accounts. An offshore supplier charges no UAE VAT, so the tax on an imported '
                   'service is declared and claimed by us, in two entries.';
  end if;

  if v_rule <> 'imported_services_reverse_charge' and new.reverse_charge_output_vat_fils > 0 then
    raise exception
      'ReverseChargeDoesNotMatchPlaceOfSupply: line % from supplier "%" self-accounts % fils of '
      'reverse-charge VAT, but that supplier place-of-supply rule is %',
      new.line_no, v_supplier, new.reverse_charge_output_vat_fils, v_rule
      using errcode = 'ZV008',
            hint = 'A supply outside the scope of UAE VAT owes no reverse charge, and a domestic supply '
                   'carries the supplier own VAT. State the place of supply on the supplier first.';
  end if;

  if new.reverse_charge_output_vat_fils = 0 then
    return new;
  end if;

  -- The input side is decided by the account, exactly as the claim on a domestic bill is (0034). The FK
  -- guarantees the row, so a missing account is not a case this has to answer.
  select a.vat_box, a.input_vat_recoverable, a.name
    into v_box, v_recoverable, v_name
    from account a where a.code = new.expense_account_code;

  v_class := case
               when v_box = 'blocked_input_tax' then 'blocked'
               when v_recoverable then 'recoverable'
               else 'out_of_scope'
             end;

  if new.reverse_charge_input_vat_fils > 0 and v_class <> 'recoverable' then
    raise exception
      'ReverseChargeInputDoesNotMatchAccount: line % claims % fils of reverse-charge input VAT on '
      'account % (%), which is classified % for input VAT recovery',
      new.line_no, new.reverse_charge_input_vat_fils, new.expense_account_code, v_name, v_class
      using errcode = 'ZV007',
            hint = 'The output side is still declared: a reverse charge on a blocked or out-of-scope '
                   'category costs the business the tax. Claim nothing and let the VAT go to the '
                   'expense with the rest of the line.';
  end if;

  if new.reverse_charge_input_vat_fils = 0 and v_class = 'recoverable' then
    raise exception
      'ReverseChargeInputDoesNotMatchAccount: line % declares % fils of reverse-charge VAT and claims '
      'none, on account % (%), which IS classified recoverable',
      new.line_no, new.reverse_charge_output_vat_fils, new.expense_account_code, v_name
      using errcode = 'ZV007',
            hint = 'Both sides or neither. Declaring the output and abandoning the input pays the FTA '
                   'tax the business was entitled to reclaim, which is the half of this pair nobody '
                   'notices is missing.';
  end if;

  return new;
end $$;

comment on function assert_reverse_charge_matches_place_of_supply() is
  'Raises ZV008 when a line owes a reverse charge and accounts for none, or accounts for one it does not '
  'owe, and ZV007 when the input side contradicts the account recovery classification. Fires for every '
  'role, because the hole it covers — an imported service recorded out_of_scope — posts, balances and '
  'declares nothing.';

create trigger bill_line_reverse_charge_matches_place_of_supply before insert on bill_line
  for each row execute function assert_reverse_charge_matches_place_of_supply();

-- ---------------------------------------------------------------------------------------------
-- The recurring register speaks the same vocabulary
-- ---------------------------------------------------------------------------------------------
-- 0031 posts recurring bills through the same `postBill`, so a treatment the bill path can post and the
-- register cannot name is a cost the register cannot describe. Every offshore vendor in 0028 is a monthly
-- subscription — DigitalOcean and Anthropic are billed every month from the first one — so the imported
-- services reverse charge is not an edge case here, it is the register's ordinary offshore row.
--
-- Extended BY NAME, which is what 0034 renamed it for.
alter table recurring_cost drop constraint recurring_cost_tax_treatment_allowed;
alter table recurring_cost add constraint recurring_cost_tax_treatment_allowed
  check (tax_treatment in ('standard_recoverable', 'blocked_not_recoverable',
                           'imported_services_reverse_charge',
                           'no_trn_not_recoverable', 'zero_rated', 'exempt', 'out_of_scope'));

-- ---------------------------------------------------------------------------------------------
-- The agent behind the nightly pass
-- ---------------------------------------------------------------------------------------------
-- `vat.reverse-charge-exceptions` is a cron, and 0021's contract is that every cron has an
-- `agent_definition` row: without one it has no declared interval and no budget, so nothing is watching it
-- and nothing is capping it. `pnpm jobs` refuses a cron with no agent.
--
-- The interval is a day, so the watchdog alerts after two missed passes rather than after one late one.
-- The budget is zero: the pass is one query and an outbox row, with no model call in it.
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('reverse_charge_exceptions', 'Reverse-charge exception report',
   'Scans every offshore bill in the window for a missing reverse-charge pair, a pair whose two sides do '
   'not agree, and a pair the ledger does not carry — then writes an outbox event whether or not it found '
   'any, so an empty report is evidence rather than silence (M-VAT-03).',
   60 * 60 * 24, 0)
on conflict (agent_key) do nothing;

-- `agentsWithHeartbeat` INNER joins, so an agent with no heartbeat row does not appear — and an agent that
-- does not appear is one the watchdog silently never checks. 0021 seeded a heartbeat for every agent it
-- created; a new agent has to bring its own.
insert into agent_heartbeat (agent_key) values ('reverse_charge_exceptions')
on conflict (agent_key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- Nothing is granted here, and that is the decision rather than an omission. The two columns arrive on
-- tables whose grants 0028 already settled — SELECT and INSERT for the application role, UPDATE, DELETE
-- and TRUNCATE revoked — and a column added to an append-only table inherits exactly that. The exception
-- report is a SELECT and its outbox row is an INSERT, both of which the role already holds.

commit;
