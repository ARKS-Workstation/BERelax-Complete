-- 0034 — blocked input VAT: the categories UAE VAT denies recovery on, recorded per line.
--
-- 0028 deliberately left `blocked input VAT` out of `bill_line.tax_treatment`, saying so in the column
-- comment: a treatment the schema accepts but no code path posts correctly would record a bill that
-- looks complete and understates the return. This migration is the other half — the treatment, the
-- figure it produces, the posting rule that keeps the entry balanced, and the three refusals that stop
-- a blocked category being claimed by accident.
--
-- ## What is blocked, and why each one is here
--
-- docs/04 §4: "**Blocked input VAT** — entertainment and certain other categories. Needs an account
-- classification so it is excluded from recovery automatically." The categories this business actually
-- incurs are two, and they are named on the accounts rather than in code:
--
--   6090  Entertainment and staff hospitality   already `blocked_input_tax` in 0018.
--   5060  Staff accommodation and transport     reclassified below, from recoverable to blocked.
--
-- 5060 is the change. An employee benefit is recoverable only where the business is **obliged** to
-- provide it; docs/04 §7 names mandatory unemployment and health insurance, which is why 6110 Insurance
-- stays recoverable, and names no obligation to house or transport staff. docs/13 §2 says staff
-- transport at 02:00 "is a safety matter" — a real cost, incurred from the first month, on an
-- obligation nobody has confirmed. So the conservative reading stands: not recoverable, recorded
-- against OPEN-QUESTIONS Y11-blocked-vat. An over-claim is a penalty and an under-claim is money left
-- on the table, and only one of those is a compliance failure.
--
-- **No motor-vehicle category is invented.** UAE VAT blocks recovery on a motor vehicle available for
-- personal use, and this business operates none: docs/01 records that outcall and mobile therapists were
-- dropped by the owner, which "removes ... vehicle and mileage records". There is no such account in the
-- chart and this migration does not add one. The absence is stated in
-- packages/core/src/tax/recoverability.ts as BLOCKED_CATEGORIES_NOT_INCURRED, so it reads as a decision
-- rather than an omission.
--
-- ## Why the classification is written on the LINE and not read back through the account
--
-- The same argument 0026 makes for snapshotting the issuer onto an invoice, and 0028 for snapshotting
-- the supplier's TRN onto a bill. A VAT return that recomputed recoverability from today's chart would
-- silently restate a filed period the day an interpretation changes — and Y11-blocked-vat is exactly
-- such an interpretation, so that day is expected rather than hypothetical. `bill_line.tax_treatment`
-- and the new `bill_line.blocked_input_vat_fils` are what the working paper sums; nothing in
-- packages/db/src/queries/input-vat-recovery.ts joins `account` to decide what was claimed.
-- Reclassifying 5060 back to recoverable therefore changes what the NEXT bill records and cannot reach
-- one already posted, which is the property packages/fixtures/src/recoverability.itest.ts asserts by
-- reclassifying and re-reading.
--
-- ## The posting rule
--
-- **Dr expense (net + blocked VAT), Dr recoverable input VAT, Cr trade payables (gross).** Blocked VAT
-- is part of the cost: it goes to the expense account, never to 1080, and it is disclosed rather than
-- dropped. The debit side still sums to the gross for every mix of treatments, because a blocked line
-- contributes its whole gross and a recoverable one contributes its net plus its claim.
--
-- ## Custom SQLSTATEs (class ZV is 0028's; 'ZL' is the ledger's, 'ZB' booking's)
--
--   ZV005  BlockedInputVatIsNotRecoverable      — a claim on an account not classified recoverable
--   ZV006  BlockedTreatmentNeedsABlockedAccount — a blocked line on an account that is not a blocked
--                                                 category
--
-- Matched on the code and never on the message, like ZV001-ZV004.
--
-- See docs/04-uae-compliance.md §4 and §7, docs/13-business-profile.md §2, docs/OPEN-QUESTIONS.md
-- Y11-blocked-vat, ADR 0007 and ADR 0017.

begin;

-- ---------------------------------------------------------------------------------------------
-- The blocked figure, on the line and on the header
-- ---------------------------------------------------------------------------------------------
-- `default 0` where `recoverable_input_vat_fils` has none, and the difference is not laziness. Every
-- row that exists predates the treatment, so 0 is the only value any of them can have — and the CHECKs
-- below pin the column to `gross - net` for a blocked line, so the default cannot stand in for a
-- decision on a row where the figure matters. Dropping the default instead would refuse every INSERT
-- that does not name the column, including the known-bad fixtures in scripts/test-gates.mjs, and a
-- probe refused by a missing column is a probe that no longer tests the rule it names.
alter table bill_line add column blocked_input_vat_fils fils_nonneg not null default 0;
alter table bill      add column blocked_input_vat_fils fils_nonneg not null default 0;

comment on column bill_line.blocked_input_vat_fils is
  'The VAT this line was charged and cannot recover: entertainment, or an employee benefit the business '
  'is not obliged to provide (docs/04 SS4, SS7). It is part of the cost, debited to the expense account, '
  'and it is what the non-recoverable disclosure line of the VAT201 working papers is summed from.';
comment on column bill.blocked_input_vat_fils is
  'The sum of the blocked lines. A summary of the lines like every other header figure, checked at '
  'COMMIT by bill_totals_match_lines.';

-- The vocabulary grows by exactly one value. The name is dropped and re-added rather than edited,
-- because a CHECK cannot be altered in place, and it keeps the name the Drizzle mirror already states.
alter table bill_line drop constraint bill_line_tax_treatment_check;
alter table bill_line add constraint bill_line_tax_treatment_check
  check (tax_treatment in ('standard_recoverable', 'blocked_not_recoverable',
                           'no_trn_not_recoverable', 'zero_rated', 'exempt', 'out_of_scope'));

comment on column bill_line.tax_treatment is
  'The claim this line supports, stored on the line and never recomputed. Two treatments carry VAT: '
  'standard_recoverable, whose VAT is claimed, and blocked_not_recoverable, whose VAT is cost. The '
  'imported-services reverse charge (M-VAT-03) is still absent on purpose: a value no code path posts '
  'correctly would record a bill that looks complete and understates the return.';

-- Two treatments carry VAT now, so the constraint that said "only a standard-rated line" is renamed as
-- well as widened. Leaving the old name in place would have been the cheaper edit and would leave a
-- constraint whose name asserts something false — which is the thing a reviewer reads first.
-- packages/db/src/schema/bill.ts and the M-VAT-01 probe in scripts/test-gates.mjs are updated with it.
alter table bill_line drop constraint bill_line_only_a_standard_rated_line_carries_vat;
alter table bill_line add constraint bill_line_only_a_vat_bearing_treatment_carries_vat
  check (tax_treatment in ('standard_recoverable', 'blocked_not_recoverable') or gross_fils = net_fils);

alter table bill_line drop constraint bill_line_rate_matches_treatment;
alter table bill_line add constraint bill_line_rate_matches_treatment
  check (tax_treatment in ('standard_recoverable', 'blocked_not_recoverable') or vat_rate_bp = 0);

-- A blocked line is one the supplier DID charge VAT on and we may not reclaim. With no VAT there is
-- nothing blocked, and `blocked_not_recoverable` would be a preparer using the new treatment as a
-- catch-all for "not recoverable" — which is what `no_trn_not_recoverable`, `exempt`, `zero_rated` and
-- `out_of_scope` already say, each for a different reason. The disclosure line exists to show the tax
-- the business bore; a zero in it shows nothing.
alter table bill_line add constraint bill_line_blocked_line_carries_vat
  check (tax_treatment <> 'blocked_not_recoverable' or gross_fils > net_fils);

-- The blocked figure is the line's own VAT, or nothing — the same shape as
-- bill_line_recoverable_matches_treatment, and the reason is the same: the figure in a filed VAT201 has
-- to be traceable to the row that produced it rather than recomputed from a rule that has since moved.
alter table bill_line add constraint bill_line_blocked_matches_treatment
  check (
    blocked_input_vat_fils =
      case when tax_treatment = 'blocked_not_recoverable' then gross_fils - net_fils else 0 end
  );

-- Nothing beyond the bill's own VAT can be claimed or blocked. Stated over the SUM, because the two
-- figures partition the VAT: every line's VAT is recoverable, blocked, or zero, so the header's
-- `recoverable + blocked` is its `gross - net` exactly — an equality this constraint deliberately does
-- not assert, because the header is written before its lines and the equality is what
-- bill_totals_match_lines proves at COMMIT against the rows themselves.
alter table bill add constraint bill_blocked_not_above_vat
  check (recoverable_input_vat_fils + blocked_input_vat_fils <= gross_fils - net_fils);

-- Blocked VAT is VAT somebody charged us, and only a registered supplier can charge it. Without a TRN
-- on the snapshot there is no tax invoice, so there is no VAT — the whole amount is cost and the line is
-- `no_trn_not_recoverable`. The same rule and the same shape as bill_recoverable_needs_a_trn: a blocked
-- figure standing on no tax invoice would overstate the non-recoverable disclosure, which is a figure a
-- tax agent reads.
alter table bill add constraint bill_blocked_needs_a_trn
  check (blocked_input_vat_fils = 0 or supplier_trn is not null);

-- The population the non-recoverable disclosure line is derived from, so the working paper does not scan
-- every line ever posted to find three.
create index bill_line_blocked_idx on bill_line (bill_id) where blocked_input_vat_fils > 0;

-- ---------------------------------------------------------------------------------------------
-- The header is still a summary of the lines — now including the blocked figure
-- ---------------------------------------------------------------------------------------------
-- Replaced rather than extended by a second trigger: two functions summing the same rows is two chances
-- to disagree about which rows they are. Still DEFERRED by the triggers 0028 created, which this
-- replacement leaves in place — the lines arrive as separate INSERTs, so between the header and its last
-- line a bill is transiently inconsistent by construction.
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
  v_lines       integer;
  v_h_net       bigint;
  v_h_gross     bigint;
  v_h_recover   bigint;
  v_h_blocked   bigint;
begin
  select b.net_fils, b.gross_fils, b.recoverable_input_vat_fils, b.blocked_input_vat_fils
    into v_h_net, v_h_gross, v_h_recover, v_h_blocked
    from bill b where b.bill_id = v_bill_id;
  -- The bill is gone, which can only happen inside a transaction that also removed it. Nothing to
  -- check, and raising here would refuse a legitimate rollback path.
  if not found then
    return null;
  end if;

  select coalesce(sum(l.net_fils), 0), coalesce(sum(l.gross_fils), 0),
         coalesce(sum(l.recoverable_input_vat_fils), 0), coalesce(sum(l.blocked_input_vat_fils), 0),
         count(*)
    into v_net, v_gross, v_recoverable, v_blocked, v_lines
    from bill_line l where l.bill_id = v_bill_id;

  -- A bill with no lines describes nothing. It fires no line trigger at all, which is why the header
  -- carries its own copy of this constraint trigger: without it, an empty bill would commit and sit in
  -- the payables ledger as a demand for money with no stated reason.
  if v_lines = 0 then
    raise exception 'BillTotalsDoNotMatchLines: bill % has no lines', v_bill_id
      using errcode = 'ZV002';
  end if;

  if v_net <> v_h_net or v_gross <> v_h_gross or v_recoverable <> v_h_recover
     or v_blocked <> v_h_blocked then
    raise exception
      'BillTotalsDoNotMatchLines: bill % header says net %, gross %, recoverable %, blocked % but its '
      '% line(s) sum to net %, gross %, recoverable %, blocked %',
      v_bill_id, v_h_net, v_h_gross, v_h_recover, v_h_blocked,
      v_lines, v_net, v_gross, v_recoverable, v_blocked
      using errcode = 'ZV002';
  end if;

  return null;
end $$;

comment on function assert_bill_totals_match_lines() is
  'Raises ZV002 at COMMIT. Both triggers read new.bill_id, which bill and bill_line both carry, so one '
  'function serves both. Since 0034 it also compares the blocked figure, which is what makes the '
  'non-recoverable disclosure line a summary of rows rather than a second number.';

-- ---------------------------------------------------------------------------------------------
-- A claim needs an account classified recoverable, and a blocked line needs a blocked account
-- ---------------------------------------------------------------------------------------------
-- The classification is a property of the account (0018: `input_vat_recoverable` is `not null` with no
-- default, and `vat_box` is nullable-but-explicit). Those two columns state three positions:
--
--   blocked       vat_box = 'blocked_input_tax'      VAT charged, recovery denied
--   recoverable   input_vat_recoverable              VAT charged, recovery allowed
--   out_of_scope  neither                            no recoverable input VAT arises here
--
-- `account_blocked_input_vat_is_not_recoverable` already makes the contradictory pair impossible, so the
-- order of the CASE below is total rather than a guess. The same derivation is `recoverabilityOf` in
-- packages/core/src/tax/recoverability.ts — packages/db may not import packages/core, so the rule has
-- two statements and packages/fixtures/src/recoverability.itest.ts asserts they agree over every account
-- in the chart. The same arrangement, for the same reason, as payables_aging_bucket().
--
-- This is the layer that catches an entertainment invoice coded to 6090 and recorded
-- `standard_recoverable`: a bill that posts, balances, looks complete, and over-claims. Neither
-- existing layer sees it — the TRN is present and the arithmetic is right.
create function assert_line_matches_account_recoverability() returns trigger
language plpgsql
as $$
declare
  v_box         text;
  v_recoverable boolean;
  v_name        text;
  v_class       text;
begin
  -- The foreign key guarantees the row, so a missing account is not a case this has to answer.
  select a.vat_box, a.input_vat_recoverable, a.name
    into v_box, v_recoverable, v_name
    from account a where a.code = new.expense_account_code;

  v_class := case
               when v_box = 'blocked_input_tax' then 'blocked'
               when v_recoverable then 'recoverable'
               else 'out_of_scope'
             end;

  if new.recoverable_input_vat_fils > 0 and v_class <> 'recoverable' then
    raise exception
      'BlockedInputVatIsNotRecoverable: line % claims % fils of input VAT on account % (%), which is '
      'classified % for input VAT recovery',
      new.line_no, new.recoverable_input_vat_fils, new.expense_account_code, v_name, v_class
      using errcode = 'ZV005',
            hint = 'A blocked category is recorded blocked_not_recoverable, which posts the VAT to the '
                   'expense. An out-of-scope account carries no claimable VAT at all.';
  end if;

  if new.tax_treatment = 'blocked_not_recoverable' and v_class <> 'blocked' then
    raise exception
      'BlockedTreatmentNeedsABlockedAccount: line % is blocked_not_recoverable on account % (%), which '
      'is classified % rather than a blocked category',
      new.line_no, new.expense_account_code, v_name, v_class
      using errcode = 'ZV006',
            hint = 'Blocked recovery is a property of the category of spend, so it is the account that '
                   'decides it. Code the line to the blocked account, or record the treatment the '
                   'account supports.';
  end if;

  return new;
end $$;

comment on function assert_line_matches_account_recoverability() is
  'Raises ZV005 for a claim on an account not classified recoverable and ZV006 for a blocked line on an '
  'account that is not a blocked category. Fires for every role, because the hole it covers — an '
  'entertainment invoice recorded standard_recoverable — posts, balances and over-claims.';

create trigger bill_line_matches_account_recoverability before insert on bill_line
  for each row execute function assert_line_matches_account_recoverability();

-- ---------------------------------------------------------------------------------------------
-- 5060 is reclassified: staff accommodation and transport is a blocked employee benefit
-- ---------------------------------------------------------------------------------------------
-- An UPDATE of the chart, which is what a reclassification is. It is safe on an applied database
-- because no posted line can be affected: the treatment and the claim live on `bill_line`, and both are
-- append-only. Any line already posted to 5060 as `standard_recoverable` keeps its claim, which is the
-- correct outcome — it was filed under the classification in force at the time, and restating a filed
-- period is exactly what this design refuses to do.
--
-- packages/core/src/ledger/chart-of-accounts.ts carries the identical change, and
-- packages/fixtures/src/ledger-chart.itest.ts fails on any field of any account the two disagree about.
update account
   set vat_box = 'blocked_input_tax', input_vat_recoverable = false
 where code = '5060' and chart_id = 'standard-spa-uae';

comment on column account.input_vat_recoverable is
  'Whether input VAT on this account may be reclaimed. With vat_box it states one of three positions: '
  'blocked (vat_box = blocked_input_tax), recoverable, or out of scope. NOT NULL with no default, '
  'because there is no safe value: defaulting to true over-claims on entertainment and defaulting to '
  'false under-claims on rent. Reclassifying an account is an audited change '
  '(reclassifyAccountRecoverability in packages/db/src/services/reclassify-account.ts) and it applies to '
  'the next bill, never to one already posted.';

-- ---------------------------------------------------------------------------------------------
-- The recurring register speaks the same vocabulary
-- ---------------------------------------------------------------------------------------------
-- 0031 posts recurring bills through the same `postBill`, and its `tax_treatment` column mirrors
-- `bill_line.tax_treatment` — so a treatment added there and not here would leave the register unable
-- to describe a cost the bill path can post. Staff transport at 02:00 is a monthly contract, which is
-- precisely a recurring cost in a blocked category.
--
-- 0031's CHECK is anonymous, so it is dropped by the name PostgreSQL gave it and re-added by an
-- explicit one, the way 0028 did with document_series_document_kind_allowed: the next unit adding a
-- treatment extends it by name instead of guessing.
alter table recurring_cost drop constraint if exists recurring_cost_tax_treatment_check;
alter table recurring_cost add constraint recurring_cost_tax_treatment_allowed
  check (tax_treatment in ('standard_recoverable', 'blocked_not_recoverable',
                           'no_trn_not_recoverable', 'zero_rated', 'exempt', 'out_of_scope'));

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- Nothing is granted here, and that is the decision rather than an omission. The chart stays
-- SELECT-only for the application role (0018, asserted by
-- packages/db/src/repositories/journal.itest.ts): reclassifying a category is a tax-position change an
-- accountant signs off, not a form an authenticated request can post. `reclassifyAccountRecoverability`
-- writes the audit_event that makes the change reviewable and runs as the owner, which is the same
-- footing a migration has.

commit;
