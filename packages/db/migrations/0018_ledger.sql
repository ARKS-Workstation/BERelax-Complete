-- 0018 — the append-only double-entry journal, the chart of accounts, and period locks.
--
-- ADR 0017: an accounting record that can be edited is not evidence. The FTA expects a taxable
-- person to produce records showing what was charged and when, and a table where a row can be
-- UPDATEd cannot show that. So there is no edit and no delete here. A wrong entry is answered by a
-- dated reversal (reverseEntry in packages/core/src/ledger/reverse.ts) and then by a fresh correct
-- entry, which is what a paper ledger required and for the same reason.
--
-- Three enforcement layers, each covering a hole the others leave:
--
--   1. GRANTS. On the journal the application role holds INSERT and SELECT and nothing else; on the
--      chart it holds SELECT alone. An injected statement cannot reach UPDATE or DELETE because the
--      privilege is absent, not because no code path writes one. This is the layer that survives a
--      compromised connection string.
--   2. TRIGGERS that RAISE. Privileges protect against the application role only; a migration, a
--      psql session or a future admin tool connects as the owner. The triggers refuse for every
--      role, and they raise rather than silently doing nothing (see the note on rules below).
--   3. A DEFERRED constraint trigger for the balance invariant. An entry is balanced as a whole and
--      its lines arrive one INSERT at a time, so the check belongs at COMMIT. An immediate trigger
--      would reject the first line of every two-line entry ever posted.
--
-- Why triggers rather than `create rule ... do instead nothing`, which 0005 and 0010 use for
-- audit_event and app_setting_history: a rule reports SUCCESS to the caller. Code that UPDATEs a
-- journal row is code that believes it is correcting history, and it must be told that it cannot
-- rather than left believing it did. 0016 made the same choice for google_connection_events.
--
-- Custom SQLSTATEs, so a caller can tell these three refusals apart without matching on message
-- text (a wording change would silently stop the translation working, and the code that would then
-- treat a locked period as an unknown failure is the code that retries it):
--
--   ZL001  journal row is append-only; UPDATE or DELETE was refused
--   ZL002  PeriodLocked — the entry date falls inside a locked accounting period
--   ZL003  UnbalancedEntry — debits and credits do not agree, or the entry has fewer than two lines
--
-- Class 'ZL' is unused by PostgreSQL (Appendix A) and by the SQL standard, which reserves classes
-- beginning with a letter in I..Z for user-defined conditions.
--
-- See docs/adr/0017-accounting-journal-and-no-auto-filing.md and packages/core/src/ledger/.

begin;

-- ---------------------------------------------------------------------------------------------
-- The chart of accounts
-- ---------------------------------------------------------------------------------------------
-- The chart is a row, not a constant, because it is PROVISIONAL: Y8-coa is open, the business has an
-- existing chart and the accountant has monthly expectations nobody has written down yet. The marker
-- travels with the data, so an accountant reading the database can see that the classification is an
-- assumption rather than a decision. Dropping the marker on the way into Postgres would leave the
-- provisional flag visible only to whoever reads the TypeScript.
create table chart_of_accounts (
  id                           text        primary key check (btrim(id) <> ''),
  -- Both provisional columns or neither: a marker names the open question AND says what standing in
  -- for it assumes. Half a marker is the shape that survives a review as "already answered".
  provisional_open_question_id text,
  provisional_note             text,
  created_at                   timestamptz not null default now(),
  constraint chart_of_accounts_provisional_pair
    check ((provisional_open_question_id is null) = (provisional_note is null))
);

comment on table chart_of_accounts is
  'One row per chart. Mirrors ChartOfAccounts in packages/core/src/ledger/chart-of-accounts.ts, '
  'including its provisional marker, and the round-trip is asserted by '
  'packages/fixtures/src/ledger-chart.itest.ts so the two cannot drift.';

-- Every classification an account must state, and none of them has a default.
--
-- `normal_balance` is stated rather than derived from `type` because the sign of a balance is not
-- derivable from the type alone: accumulated depreciation is an asset on the credit side and owner's
-- drawings is equity on the debit side. "Asset implies debit" is right for most accounts and produces
-- a balance sheet with the wrong sign for the rest — an error that still reconciles to zero while
-- misstating the figure a reader cares about.
create table account (
  code                  text        primary key check (code ~ '^[0-9]{4}$'),
  chart_id              text        not null references chart_of_accounts(id),
  name                  text        not null check (btrim(name) <> ''),
  type                  text        not null
    check (type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  normal_balance        text        not null check (normal_balance in ('debit', 'credit')),
  -- Stated, not inferred: a contra account lives under a type and carries the opposite side.
  contra                boolean     not null,
  -- Nullable BUT EXPLICIT. `null` means "feeds no VAT201 grouping", decided. The database cannot
  -- distinguish that from an INSERT that simply omitted the column, which is why the round-trip test
  -- compares this column against a chart whose defineAccount() refuses an omission at construction.
  vat_box               text
    check (vat_box in ('standard_rated_supplies', 'zero_rated_supplies', 'exempt_supplies',
                       'reverse_charge', 'output_tax', 'recoverable_input_tax', 'blocked_input_tax')),
  -- Blocked input VAT (entertainment and similar, docs/04 section 4) is excluded from recovery by
  -- classification rather than by the preparer remembering.
  input_vat_recoverable boolean     not null,
  created_at            timestamptz not null default now(),
  -- The same rule as expectedNormalBalance() in core, restated here on purpose. The seed crosses a
  -- module boundary and later units will add accounts in their own migrations; a CHECK is what makes
  -- a hand-written INSERT with the wrong side fail instead of land. The two statements of the rule
  -- are kept honest by the round-trip test, which would fail on any account the pair disagreed about.
  constraint account_normal_balance_matches_type check (
    normal_balance = case when (type in ('asset', 'expense')) <> contra then 'debit' else 'credit' end
  ),
  constraint account_blocked_input_vat_is_not_recoverable check (
    not (vat_box = 'blocked_input_tax' and input_vat_recoverable)
  )
);

comment on table account is
  'The chart of accounts. A code is never renumbered: entries reference codes, and renumbering one '
  'means restating history in a journal that by definition cannot be edited. Adding or renaming an '
  'account is a migration, not a settings screen — the application role holds no write privilege.';
comment on column account.vat_box is
  'The VAT201 grouping this account feeds, or null for "feeds none". Null is a decision; it never '
  'means "not yet classified". [UNVERIFIED] The box numbering awaits a tax agent (docs/04 section 4).';

create index account_type_idx on account (type, code);
-- The population box 9 is derived from, so the recovery working paper does not scan the chart.
create index account_recoverable_idx on account (code) where input_vat_recoverable;

-- ---------------------------------------------------------------------------------------------
-- The journal
-- ---------------------------------------------------------------------------------------------
create table journal_entry (
  -- Allocated by the caller, not by the database: packages/core constructs an entry with an id it
  -- was given, and a surrogate key generated here would leave the id core validated with nothing to
  -- match against on the way back.
  entry_id    text        primary key check (btrim(entry_id) <> ''),
  -- The BUSINESS DAY the entry belongs to, already resolved by the caller (resolveTradingDate in
  -- @berelax/core). Trading runs 11:00-02:00, so a 01:30 sale belongs to the previous trading date,
  -- and a date derived here by truncating an instant would file it under the wrong day's takings.
  --
  -- Deliberately NOT a foreign key to business_day. A closed date is absent from that table (0011),
  -- and the journal must still be able to record the rent for a month containing days the premises
  -- were shut, an accrual dated on a period end, and an opening balance.
  entry_date  date        not null,
  narrative   text        not null check (btrim(narrative) <> ''),
  -- Why the entry exists, carried rather than inferred from the accounts: a refund and a cancelled
  -- sale produce identical lines and are answered differently when a customer asks.
  source      text        not null check (source in (
                'sale', 'refund', 'payment', 'payout', 'cash_up', 'supplier_bill', 'payroll',
                'gratuity_accrual', 'commission_accrual', 'package_sale', 'package_redemption',
                'voucher_sale', 'voucher_redemption', 'depreciation', 'opening_balance',
                'adjustment', 'reversal')),
  -- One entry, one currency. AED only today; widening this is a migration and a decision, not a
  -- column that quietly accepts a second currency into a trial balance that then sums both.
  currency    text        not null default 'AED' check (currency = 'AED'),
  -- The entry this one reverses. A correction is a NEW entry pointing at the old one.
  reverses    text        references journal_entry(entry_id),
  posted_at   timestamptz not null default now(),
  -- No updated_at and no set_updated_at trigger: there is no second version of a row here, and a
  -- column promising one would be a promise this table cannot keep.
  constraint journal_entry_is_not_its_own_reversal check (reverses is distinct from entry_id)
);

comment on table journal_entry is
  'Append-only: UPDATE and DELETE raise. A correction is a dated reversal plus a fresh entry '
  '(ADR 0017). entry_date is the business day the caller resolved, never a truncated instant.';

create index journal_entry_date_idx on journal_entry (entry_date, entry_id);
create index journal_entry_source_idx on journal_entry (source, entry_date);
create index journal_entry_reverses_idx on journal_entry (reverses) where reverses is not null;

create table journal_line (
  entry_id     text          not null references journal_entry(entry_id),
  -- Position within the entry, so two runs over the same entry produce byte-identical working
  -- papers. An insertion-ordered report diffs everywhere the moment a posting order changes.
  line_no      smallint      not null check (line_no >= 1),
  account_code text          not null references account(code),
  -- Integer fils, VAT-inclusive gross (ADR 0007). Never a float: half a fils in a journal cannot be
  -- reconciled by anyone, and the discrepancy surfaces during a VAT return, by which point it is
  -- history.
  debit_fils   fils_nonneg   not null default 0,
  credit_fils  fils_nonneg   not null default 0,
  currency     text          not null default 'AED' check (currency = 'AED'),
  memo         text,
  created_at   timestamptz   not null default now(),
  primary key (entry_id, line_no),
  -- Direction is the side, never the sign. A negative debit and a positive credit both balance, and
  -- only one of them is what the poster meant. Exactly one side carries the amount, and it is
  -- non-zero: a zero line is not a posting, it is a line somebody forgot to fill in.
  constraint journal_line_exactly_one_side check ((debit_fils = 0) <> (credit_fils = 0))
);

comment on table journal_line is
  'Append-only: UPDATE and DELETE raise. Balance is enforced at COMMIT by a DEFERRED constraint '
  'trigger, because the lines of one entry arrive as separate INSERTs.';

create index journal_line_account_idx on journal_line (account_code, entry_id);

-- ---------------------------------------------------------------------------------------------
-- Period locks
-- ---------------------------------------------------------------------------------------------
-- Period locking is what makes a VAT return meaningful: without it, a return filed on the 28th
-- describes a period that can still change on the 29th (ADR 0017).
--
-- M-TILL-01 exports no period-lock predicate, deliberately — a pure predicate in core would have to
-- be replaced by this table the moment locks became data, and two answers to "is February closed"
-- is one answer plus a future disagreement. The lock lives here, next to the rows it protects.
create table period_lock (
  -- The identifier an accountant uses for the period: '2026-08' for a month, '2026-Q3' for a VAT
  -- quarter. Free text on purpose — the VAT period length is the authority's to set, not ours — and
  -- it appears in the PeriodLocked message, so it has to be something a human recognises.
  period_id            text        primary key check (btrim(period_id) <> ''),
  starts_on            date        not null,
  ends_on              date        not null,
  reason               text        not null check (btrim(reason) <> ''),
  locked_at            timestamptz not null default now(),
  -- Who closed it. Only a member of staff or the system closes a period; the audit_event row written
  -- in the same transaction carries the full actor and request context.
  locked_by_actor_kind text        not null check (locked_by_actor_kind in ('staff', 'system')),
  locked_by_actor_id   uuid,
  constraint period_lock_ends_on_or_after_starts check (ends_on >= starts_on),
  -- Two overlapping locks would make "which period locks this date" ambiguous, and the PeriodLocked
  -- message would then name whichever row the planner happened to reach first. An inclusive
  -- daterange, because ends_on is the last day OF the period, not the first day after it.
  constraint period_lock_no_overlap
    exclude using gist ((daterange(starts_on, ends_on, '[]')) with &&)
);

comment on table period_lock is
  'A closed accounting period. Nothing may be posted with an entry_date inside one. The application '
  'role may INSERT (closing a period is an operation) but holds no UPDATE or DELETE: reopening a '
  'filed period is not something a code path does.';

create index period_lock_range_idx on period_lock (starts_on, ends_on);

-- ---------------------------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------------------------
create function refuse_journal_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    '% is append-only; % is refused. Correct a posting with a dated reversal, never by editing it.',
    tg_table_name, tg_op
    using errcode = 'ZL001';
end $$;

comment on function refuse_journal_change() is
  'Raises ZL001. Fires for EVERY role, including the owner: privileges cover the application role, '
  'and a migration or a psql session does not connect as the application role.';

create trigger journal_entry_no_update before update on journal_entry
  for each row execute function refuse_journal_change();
create trigger journal_entry_no_delete before delete on journal_entry
  for each row execute function refuse_journal_change();
create trigger journal_line_no_update before update on journal_line
  for each row execute function refuse_journal_change();
create trigger journal_line_no_delete before delete on journal_line
  for each row execute function refuse_journal_change();

-- `account` and `period_lock` get no refusal trigger, and the difference is deliberate. A journal row
-- is history. An account is a classification and a lock is an administrative fact ABOUT history: a
-- mis-typed lock range or a misspelled account name must be correctable by a migration without
-- someone having to drop a trigger first, and dropping a trigger to fix a typo is how the trigger
-- ends up dropped. Neither is reachable from the application role, which is the layer that matters.

-- ---------------------------------------------------------------------------------------------
-- The balance invariant, DEFERRED to COMMIT
-- ---------------------------------------------------------------------------------------------
-- An entry balances as a whole. Its lines arrive as separate INSERTs, so after the first line of a
-- two-line sale the journal is transiently unbalanced by construction — an IMMEDIATE trigger would
-- reject every entry ever posted, and the only way to satisfy it would be to insert all lines in one
-- statement and hope nobody ever writes the loop.
--
-- `deferrable initially deferred` moves the check to COMMIT: each INSERT succeeds, and the
-- transaction fails as a whole if the entry does not balance. packages/db/src/repositories/
-- journal.itest.ts asserts exactly that shape — lines inserted one at a time, each succeeding, the
-- failure arriving at COMMIT — because a test that failed on the first insert would have proved the
-- opposite of what is wanted.
create function assert_entry_balanced() returns trigger
language plpgsql
as $$
declare
  v_debit  bigint;
  v_credit bigint;
  v_lines  integer;
begin
  select coalesce(sum(l.debit_fils), 0), coalesce(sum(l.credit_fils), 0), count(*)
    into v_debit, v_credit, v_lines
    from journal_line l
   where l.entry_id = new.entry_id;

  -- A double entry needs at least two lines, and a single line can only balance by being zero —
  -- which journal_line_exactly_one_side already refuses. This is the case the line-level trigger
  -- cannot see at all: an entry inserted with NO lines fires no line trigger, so without the
  -- entry-level trigger below an empty entry would commit and sit in the journal as evidence of
  -- nothing.
  if v_lines < 2 then
    raise exception
      'UnbalancedEntry: entry "%" has % line(s); a double entry needs at least two',
      new.entry_id, v_lines
      using errcode = 'ZL003';
  end if;

  if v_debit <> v_credit then
    raise exception
      'UnbalancedEntry: entry "%" does not balance: debits % fils, credits % fils, difference % fils',
      new.entry_id, v_debit, v_credit, v_debit - v_credit
      using errcode = 'ZL003';
  end if;

  return null;
end $$;

comment on function assert_entry_balanced() is
  'Raises ZL003 at COMMIT. Both triggers read new.entry_id, which journal_entry and journal_line '
  'both carry, so one function serves both.';

create constraint trigger journal_line_entry_balanced
  after insert on journal_line
  deferrable initially deferred
  for each row execute function assert_entry_balanced();

create constraint trigger journal_entry_balanced
  after insert on journal_entry
  deferrable initially deferred
  for each row execute function assert_entry_balanced();

-- ---------------------------------------------------------------------------------------------
-- Period locking
-- ---------------------------------------------------------------------------------------------
-- The one definition of "is this date closed". Every guard calls it, so a query that answered
-- differently cannot exist.
create function period_lock_for(p_entry_date date) returns text
language sql
stable
as $$
  select period_id from period_lock
   where p_entry_date between starts_on and ends_on
   limit 1;
$$;

comment on function period_lock_for(date) is
  'The period_id locking this date, or null. `limit 1` is safe because period_lock_no_overlap makes '
  'at most one row match.';

create function raise_if_period_locked(p_entry_date date, p_what text) returns void
language plpgsql
stable
as $$
declare
  v_period text := period_lock_for(p_entry_date);
begin
  if v_period is not null then
    -- The period identifier is IN the message, not merely in the SQLSTATE. "Posting refused" without
    -- it sends the person to the wrong month, and the entry they then chase is usually correct.
    raise exception 'PeriodLocked: cannot post % dated %; accounting period "%" is locked',
      p_what, p_entry_date, v_period
      using errcode = 'ZL002';
  end if;
end $$;

create function journal_entry_period_guard() returns trigger
language plpgsql
as $$
begin
  perform raise_if_period_locked(new.entry_date, 'journal entry "' || new.entry_id || '"');
  return new;
end $$;

-- Separate from the entry guard because a line reads its date from its entry. Both exist: the entry
-- guard is what a posting hits first, and the LINE guard is what stops a line being appended to an
-- entry that was posted while the period was still open. The lock closes the period for both.
create function journal_line_period_guard() returns trigger
language plpgsql
as $$
declare
  v_entry_date date;
begin
  select e.entry_date into v_entry_date from journal_entry e where e.entry_id = new.entry_id;
  perform raise_if_period_locked(
    v_entry_date, 'journal line ' || new.line_no || ' on entry "' || new.entry_id || '"');
  return new;
end $$;

-- BEFORE INSERT, so the refusal arrives at the statement that caused it rather than at COMMIT. The
-- balance check is deferred because it is a property of a set of rows; this is a property of one row
-- and there is nothing to wait for.
create trigger journal_entry_period_lock before insert on journal_entry
  for each row execute function journal_entry_period_guard();
create trigger journal_line_period_lock before insert on journal_line
  for each row execute function journal_line_period_guard();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 granted the application role select, insert, update and delete on every table in public AND
-- set default privileges to extend that to tables created later — so these five tables arrive with
-- UPDATE and DELETE already granted. An append-only table that forgets to revoke them is append-only
-- by convention only, which is the hole ADR 0017 exists to close.
--
-- The grants are stated explicitly first rather than relied upon, because a managed database restored
-- from a dump may not carry the default privileges, and a posting path that cannot INSERT fails at
-- the till.
grant select, insert on journal_entry, journal_line to berelax_app;
grant select, insert on period_lock to berelax_app;
grant select on chart_of_accounts, account to berelax_app;

revoke update, delete on journal_entry, journal_line from berelax_app;
revoke update, delete on period_lock from berelax_app;
-- TRUNCATE does not fire a row-level DELETE trigger, so it is the one statement that could empty
-- these tables past the refusal triggers above. 0009 never granted it (it grants select, insert,
-- update and delete by name), and revoking it here says so out loud rather than leaving the reader to
-- work out that the hole is closed. The integration suite resets the journal between cases with
-- TRUNCATE as the owner, which is exactly why the application role must not hold it.
revoke truncate on journal_entry, journal_line, period_lock from berelax_app;
-- A chart change is a migration: renumbering a code referenced by history means restating history.
revoke insert, update, delete on chart_of_accounts, account from berelax_app;

-- Reporting reads the journal and must never write it. 0009 already grants it SELECT on everything
-- in public; UPDATE and DELETE were never granted, so there is nothing to revoke — stated here
-- because "it was never granted" and "we checked" are different facts.

-- ---------------------------------------------------------------------------------------------
-- The seeded chart
-- ---------------------------------------------------------------------------------------------
-- GENERATED from STANDARD_SPA_CHART in packages/core/src/ledger/chart-of-accounts.ts, not retyped.
-- packages/fixtures/src/ledger-chart.itest.ts reads these rows back and compares every field of
-- every account against that chart in both directions, so a hand-edit here — or an account added to
-- core without a migration — fails the build rather than producing two charts that disagree about
-- what account 6090 recovers.
--
-- `on conflict do nothing` so re-applying is safe.
insert into chart_of_accounts (id, provisional_open_question_id, provisional_note) values
  ('standard-spa-uae', 'Y8-coa',
   'Standard UAE spa chart, provisional until the existing chart and the monthly reporting the '
   'accountant expects are supplied. Answering Y8-coa should be a mapping exercise, not a re-design.')
on conflict (id) do nothing;

insert into account (chart_id, code, name, type, normal_balance, contra, vat_box, input_vat_recoverable) values
  ('standard-spa-uae', '1010', 'Cash in drawer', 'asset', 'debit', false, null, false),
  ('standard-spa-uae', '1015', 'Petty cash float', 'asset', 'debit', false, null, false),
  ('standard-spa-uae', '1020', 'Bank — current account', 'asset', 'debit', false, null, false),
  ('standard-spa-uae', '1030', 'Payment gateway clearing', 'asset', 'debit', false, null, false),
  ('standard-spa-uae', '1040', 'Card terminal clearing', 'asset', 'debit', false, null, false),
  ('standard-spa-uae', '1050', 'Trade receivables — corporate accounts', 'asset', 'debit', false, null, false),
  ('standard-spa-uae', '1060', 'Prepaid expenses', 'asset', 'debit', false, null, false),
  ('standard-spa-uae', '1070', 'Inventory — retail products', 'asset', 'debit', false, null, false),
  ('standard-spa-uae', '1075', 'Inventory — treatment consumables', 'asset', 'debit', false, null, false),
  ('standard-spa-uae', '1080', 'Recoverable input VAT', 'asset', 'debit', false, 'recoverable_input_tax', true),
  ('standard-spa-uae', '1090', 'Rent and utility deposits', 'asset', 'debit', false, null, false),
  ('standard-spa-uae', '1100', 'Furniture, fittings and equipment', 'asset', 'debit', false, null, false),
  ('standard-spa-uae', '1110', 'Accumulated depreciation', 'asset', 'credit', true, null, false),
  ('standard-spa-uae', '2010', 'Trade payables', 'liability', 'credit', false, null, false),
  ('standard-spa-uae', '2020', 'Accrued expenses', 'liability', 'credit', false, null, false),
  ('standard-spa-uae', '2030', 'Output VAT payable', 'liability', 'credit', false, 'output_tax', false),
  ('standard-spa-uae', '2035', 'Reverse-charge VAT payable', 'liability', 'credit', false, 'reverse_charge', false),
  ('standard-spa-uae', '2040', 'Tips payable to therapists', 'liability', 'credit', false, null, false),
  ('standard-spa-uae', '2050', 'Deferred revenue — packages', 'liability', 'credit', false, null, false),
  ('standard-spa-uae', '2055', 'Deferred revenue — gift vouchers', 'liability', 'credit', false, null, false),
  ('standard-spa-uae', '2060', 'Wages and salaries payable', 'liability', 'credit', false, null, false),
  ('standard-spa-uae', '2065', 'WPS payroll clearing', 'liability', 'credit', false, null, false),
  ('standard-spa-uae', '2070', 'End-of-service gratuity liability', 'liability', 'credit', false, null, false),
  ('standard-spa-uae', '2075', 'Accrued annual leave liability', 'liability', 'credit', false, null, false),
  ('standard-spa-uae', '2080', 'Staff commission payable', 'liability', 'credit', false, null, false),
  ('standard-spa-uae', '2085', 'Customer refunds payable', 'liability', 'credit', false, null, false),
  ('standard-spa-uae', '2090', 'Corporate tax payable', 'liability', 'credit', false, null, false),
  ('standard-spa-uae', '3010', 'Owner''s capital', 'equity', 'credit', false, null, false),
  ('standard-spa-uae', '3020', 'Owner''s drawings', 'equity', 'debit', true, null, false),
  ('standard-spa-uae', '3030', 'Retained earnings', 'equity', 'credit', false, null, false),
  ('standard-spa-uae', '4010', 'Treatment revenue', 'revenue', 'credit', false, 'standard_rated_supplies', false),
  ('standard-spa-uae', '4020', 'Package redemption revenue', 'revenue', 'credit', false, 'standard_rated_supplies', false),
  ('standard-spa-uae', '4030', 'Retail product revenue', 'revenue', 'credit', false, 'standard_rated_supplies', false),
  ('standard-spa-uae', '4040', 'Gift voucher redemption revenue', 'revenue', 'credit', false, 'standard_rated_supplies', false),
  ('standard-spa-uae', '4050', 'Unredeemed voucher breakage', 'revenue', 'credit', false, 'standard_rated_supplies', false),
  ('standard-spa-uae', '4090', 'Other operating income', 'revenue', 'credit', false, 'standard_rated_supplies', false),
  ('standard-spa-uae', '4095', 'Discounts and allowances', 'revenue', 'debit', true, 'standard_rated_supplies', false),
  ('standard-spa-uae', '5010', 'Therapist wages', 'expense', 'debit', false, null, false),
  ('standard-spa-uae', '5020', 'Staff commission expense', 'expense', 'debit', false, null, false),
  ('standard-spa-uae', '5030', 'End-of-service gratuity expense', 'expense', 'debit', false, null, false),
  ('standard-spa-uae', '5040', 'Annual leave expense', 'expense', 'debit', false, null, false),
  ('standard-spa-uae', '5050', 'Visa, permit and medical fees', 'expense', 'debit', false, null, false),
  ('standard-spa-uae', '5060', 'Staff accommodation and transport', 'expense', 'debit', false, 'recoverable_input_tax', true),
  ('standard-spa-uae', '6010', 'Rent', 'expense', 'debit', false, 'recoverable_input_tax', true),
  ('standard-spa-uae', '6020', 'Utilities', 'expense', 'debit', false, 'recoverable_input_tax', true),
  ('standard-spa-uae', '6030', 'Treatment consumables used', 'expense', 'debit', false, 'recoverable_input_tax', true),
  ('standard-spa-uae', '6040', 'Cost of retail goods sold', 'expense', 'debit', false, 'recoverable_input_tax', true),
  ('standard-spa-uae', '6050', 'Laundry and cleaning', 'expense', 'debit', false, 'recoverable_input_tax', true),
  ('standard-spa-uae', '6060', 'Repairs and maintenance', 'expense', 'debit', false, 'recoverable_input_tax', true),
  ('standard-spa-uae', '6070', 'Marketing and advertising', 'expense', 'debit', false, 'recoverable_input_tax', true),
  ('standard-spa-uae', '6075', 'Software and imported services', 'expense', 'debit', false, 'reverse_charge', true),
  ('standard-spa-uae', '6080', 'Payment processing fees', 'expense', 'debit', false, 'recoverable_input_tax', true),
  ('standard-spa-uae', '6085', 'Bank charges', 'expense', 'debit', false, null, false),
  ('standard-spa-uae', '6090', 'Entertainment and staff hospitality', 'expense', 'debit', false, 'blocked_input_tax', false),
  ('standard-spa-uae', '6095', 'Fines and penalties', 'expense', 'debit', false, null, false),
  ('standard-spa-uae', '6100', 'Professional fees', 'expense', 'debit', false, 'recoverable_input_tax', true),
  ('standard-spa-uae', '6110', 'Insurance', 'expense', 'debit', false, 'recoverable_input_tax', true),
  ('standard-spa-uae', '6120', 'Licence and government fees', 'expense', 'debit', false, null, false),
  ('standard-spa-uae', '6130', 'Depreciation', 'expense', 'debit', false, null, false),
  ('standard-spa-uae', '6140', 'Cash over and short', 'expense', 'debit', false, null, false),
  ('standard-spa-uae', '6150', 'Bad debt written off', 'expense', 'debit', false, null, false),
  ('standard-spa-uae', '6160', 'Corporate tax expense', 'expense', 'debit', false, null, false)
on conflict (code) do nothing;

commit;
