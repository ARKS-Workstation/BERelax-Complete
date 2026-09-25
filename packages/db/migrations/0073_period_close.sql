-- 0073 — closing a period: the preconditions, the evidence hash, and the refusal that says where a
--        correction may go instead.
--
-- 0018 built the MECHANISM. `period_lock` with a gist exclusion constraint so two overlapping locks
-- cannot exist, `period_lock_for(date)` as the single definition of "is this date closed",
-- `raise_if_period_locked()` raising ZL002, and BEFORE INSERT guards on `journal_entry` and
-- `journal_line` so every posting path meets the lock at one choke point. M-TILL-02's own NOTE says
-- what it left: "lockAccountingPeriod checks no preconditions ... Refusing a close until the trial
-- balance balances and every document in the period is posted, naming the earliest OPEN period in the
-- refusal, and hashing the period's trial balance into the audit row are that unit's acceptance lines."
--
-- This is that unit. Four things:
--
--   1. `period_close_blocker(starts_on, ends_on)` — the documents that must be posted before a period
--      may be closed, enumerated as ROWS so a caller can name them, plus the trial balance difference.
--   2. A BEFORE INSERT trigger on `period_lock` that refuses a close those blockers apply to, for
--      EVERY role including the owner. ZE001 (the ledger does not balance) and ZE002 (documents in the
--      period are not posted, named).
--   3. `period_trial_balance_hash(as_at)` — the content hash of the period's trial balance, computed
--      here so that recomputing it years later cannot disagree with whatever the closing code did.
--   4. `raise_if_period_locked()` redefined so ZL002 names the earliest OPEN date as well as the locked
--      period, from every posting path at once.
--
-- SQLSTATE class 'ZE'. 'ZP' would have been the mnemonic one and it is 0056's (consent); a second
-- meaning for one class is how a caller comes to handle a consent defect as a period-close defect.
--
--
-- ## Why the preconditions are in the DATABASE and not only in the service
--
-- A close that a service checks and the database does not is a close that `psql` performs. That is not
-- a hypothetical route: `packages/db/src/repositories/journal.ts` is one caller of `period_lock`, a
-- migration is another, and an import or a fixture is a third. The rule this unit exists to state — a
-- filed period describes books that balanced and documents that were all in them — is worth nothing if
-- the one statement that establishes it can be issued without it.
--
-- So the trigger is the authority and `closeAccountingPeriod` is the good error message. The service
-- reads `period_close_blocker()` first so a caller gets the offending document ids as DATA rather than
-- as a sentence to parse, and then inserts the lock, which re-checks. Two statements of one rule would
-- normally be one too many (0018's argument for not pre-checking the balance in TypeScript), and the
-- difference here is that the service does not RE-EXPRESS the rule: it calls the same function the
-- trigger calls. There is one definition and two readers of it.
--
--
-- ## Why reopening gets no refusal trigger, when the journal has one
--
-- 0018 considered exactly this and decided against it, and the decision stands: "a mis-typed lock range
-- or a misspelled account name must be correctable by a migration without someone having to drop a
-- trigger first, and dropping a trigger to fix a typo is how the trigger ends up dropped."
--
-- Two pieces of evidence arrived since, both of which would have been broken by the trigger and neither
-- of which is a reopening: `packages/db/src/repositories/journal.itest.ts` resets between cases by
-- deleting every `period_lock` row, and block 97 of `scripts/test-gates.mjs` clears the gate's own year
-- before each credit-note probe for the same reason. A BEFORE DELETE refusal for every role would turn
-- both red, and the fix would be to drop it.
--
-- What makes reopening impossible for every CODE path is stated where it belongs. The application role
-- holds no UPDATE and no DELETE on `period_lock` (0018's grants), so the statement raises 42501 for the
-- role the application connects as; no function exported from `@berelax/db` performs one, which
-- `period-close.itest.ts` asserts over the export surface; and ADR 0031 records that reopening is
-- therefore a migration. The gate block proves the refusal by issuing the statement as that role
-- rather than by reading the ADR.


-- ------------------------------------------------------------------------------------------------
-- The trial balance difference, as the database computes it
-- ------------------------------------------------------------------------------------------------
-- `packages/db/src/queries/trial-balance.ts` is the reader every report and gate uses, and this is the
-- same sum. It is restated here and not called through, because the caller of the TRIGGER is a bare
-- INSERT and cannot reach TypeScript — and a precondition that could only be evaluated by the
-- application would be the bypass this file exists to close.
--
-- `bigint` and never a float, for trial-balance.ts's own recorded reason: a ledger holding 2^53 + 1
-- fils on each side reported a difference of -4 fils out of nothing when the two sides were rounded
-- independently. Postgres `sum()` over bigint returns numeric, so the cast is explicit.
--
-- Cumulative to `p_as_at`, matching `trialBalanceAsAt`: a trial balance is a position and not a
-- movement. A period whose own movement balanced but which opened on an unbalanced position is not a
-- period anyone should file.
create function period_trial_balance_difference_fils(p_as_at date) returns bigint
language sql
stable
as $$
  select coalesce(sum(l.debit_fils) - sum(l.credit_fils), 0)::bigint
    from journal_line l
    join journal_entry e on e.entry_id = l.entry_id
   where e.entry_date <= p_as_at;
$$;

comment on function period_trial_balance_difference_fils(date) is
  'debits minus credits over every journal line dated on or before p_as_at, in integer fils. Zero in '
  'a sound ledger. The same sum as trialBalanceAsAt, in the one place a trigger can reach it.';


-- ------------------------------------------------------------------------------------------------
-- The content hash of a period's trial balance
-- ------------------------------------------------------------------------------------------------
-- The acceptance: "closing writes an audit_event naming the closer and a content hash of the period's
-- trial balance; recomputing that trial balance later reproduces the same hash byte for byte."
--
-- Three decisions, each of which would break that claim if taken the other way.
--
-- **In SQL and not in TypeScript.** The hash is evidence, and evidence that only one program can
-- reproduce is evidence about the program. A `psql` session can recompute this one; so can a report
-- written in five years by something that is not this codebase.
--
-- **Account CODE, debits and credits — never the account NAME or type.** `account.name` is a
-- classification label and `reclassify-account.ts` exists to change one. A hash over the name would
-- change when a chart tidy-up renamed "Treatment revenue", and the period's books would read as
-- restated when nothing about them had moved. The figures and the codes are the trial balance; the
-- names are how it is presented.
--
-- **A version tag in the preimage.** If the canonical form ever has to change, a hash taken under the
-- old form must be visibly incomparable rather than quietly unequal. 'tb1' says which form produced it,
-- and a future 'tb2' cannot collide with it.
--
-- `order by l.account_code` inside the aggregate, because `string_agg` without it is fed rows in
-- whatever order the plan produced — which is stable on a small table and stops being stable the first
-- time the planner picks a parallel sequential scan. That is the whole failure mode this function has
-- to not have.
create function period_trial_balance_hash(p_as_at date) returns text
language sql
stable
as $$
  select encode(
    sha256(
      convert_to(
        'tb1|' || p_as_at::text || E'\n' || coalesce(
          (select string_agg(t.line, E'\n' order by t.account_code)
             from (select l.account_code,
                          l.account_code || '|' || sum(l.debit_fils)::text || '|'
                            || sum(l.credit_fils)::text as line
                     from journal_line l
                     join journal_entry e on e.entry_id = l.entry_id
                    where e.entry_date <= p_as_at
                    group by l.account_code
                   having sum(l.debit_fils) <> 0 or sum(l.credit_fils) <> 0) t),
          ''),
        'UTF8')),
    'hex');
$$;

comment on function period_trial_balance_hash(date) is
  'sha256 of the canonical trial balance as at p_as_at: "tb1|<date>" then one line per account of '
  'code|debits|credits, ordered by code. Deliberately excludes account names, which reclassification '
  'may change without any figure moving. The version tag makes a future canonical form incomparable '
  'rather than merely unequal.';


-- ------------------------------------------------------------------------------------------------
-- The documents that must be posted before a period may be closed
-- ------------------------------------------------------------------------------------------------
-- A document dated inside a period and absent from the ledger is the failure a close exists to catch.
-- Filing the return leaves that supply out of it permanently, because the period it belongs to is now
-- shut and the correction has to go somewhere else -- which is a restatement, and a restatement is the
-- thing period locking exists to make unnecessary.
--
-- Returned as ROWS and not as a boolean, because the acceptance asks the refusal to "enumerate the
-- offending document ids" and a caller that has to parse them out of a sentence will get it wrong. The
-- trigger formats them into its message; `periodCloseBlockers` hands the same rows back as data.
--
-- ## What "posted" means for each of the three, and why they differ
--
-- `invoice` carries no entry reference at all. M-TILL-06 posts the sale and the document together and
-- records the pair in `checkout_finalisation`, whose `journal_entry_id` and `invoice_id` are both
-- UNIQUE and NOT NULL -- so the existence of that row IS the invoice being posted, and its absence is
-- the reachable case here. `issueInvoice` (M-TILL-04) is the primitive `finaliseCheckout` calls, and a
-- caller that reaches it directly can commit an invoice the ledger has never heard of.
--
-- `credit_note.journal_entry_id` and `bill.entry_id` are NOT NULL and carry foreign keys, so for those
-- two an unposted document is unrepresentable rather than merely absent. They are enumerated anyway,
-- by the same rule, for one reason: the check then judges the SCHEMA rather than restating today's
-- version of it, and a later migration that makes either column nullable is already covered. A branch
-- that cannot fire today is stated as such in the comment and asserted as such by the gate -- which
-- reads `information_schema` for the NOT NULL rather than claiming the branch was tested.
--
-- The date is each document's own tax point: `invoice.tax_point_date`, `credit_note.tax_point_date`,
-- `bill.bill_date`. Never the issue date, and never `created_at`. A period is a span of tax points, and
-- 0026 separated the two columns precisely so a document entered in October could belong to September.
create function period_close_blocker(p_starts_on date, p_ends_on date)
returns table (document_kind text, document_id text, document_label text, document_date date)
language sql
stable
as $$
  select 'invoice'::text, i.id::text, i.display_number, i.tax_point_date
    from invoice i
   where i.tax_point_date between p_starts_on and p_ends_on
     and not exists (select 1 from checkout_finalisation cf where cf.invoice_id = i.id)
  union all
  select 'credit_note'::text, cn.id::text, cn.display_number, cn.tax_point_date
    from credit_note cn
   where cn.tax_point_date between p_starts_on and p_ends_on
     and not exists (select 1 from journal_entry e where e.entry_id = cn.journal_entry_id)
  union all
  select 'bill'::text, b.bill_id::text, b.display_number, b.bill_date
    from bill b
   where b.bill_date between p_starts_on and p_ends_on
     and not exists (select 1 from journal_entry e where e.entry_id = b.entry_id)
   order by 4, 3;
$$;

comment on function period_close_blocker(date, date) is
  'Every invoice, credit note and bill whose tax point falls in the range and which the ledger does '
  'not account for. Rows and not a boolean, so a refusal can name the documents. An invoice is posted '
  'when a checkout_finalisation row references it; the other two carry NOT NULL entry references, so '
  'their branches judge the schema rather than restating it.';


-- ------------------------------------------------------------------------------------------------
-- ZE001 / ZE002 — the close itself is refused
-- ------------------------------------------------------------------------------------------------
-- How many document ids the refusal names before it stops. All of them would put an unbounded string
-- into an error message -- a period with a thousand stragglers produces a refusal nothing can read and
-- a log line nothing can store -- and naming none would leave the caller exactly where it started.
-- Ten, plus the count, so the message is both actionable and bounded. The full list is available from
-- `period_close_blocker()`, which is what `periodCloseBlockers` returns and what the service puts in
-- the AppError's details.
create function assert_period_closeable() returns trigger
language plpgsql
as $$
declare
  v_difference bigint;
  v_total      integer;
  v_named      text;
begin
  -- The balance first, and the order is deliberate rather than incidental. An unbalanced ledger makes
  -- every figure in the period untrustworthy INCLUDING the ones the documents would reconcile to, so
  -- reporting the stragglers first would send somebody to chase documents while the books do not add
  -- up. Whichever fires, the other is still there on the next attempt.
  v_difference := period_trial_balance_difference_fils(new.ends_on);
  if v_difference <> 0 then
    raise exception
      'PeriodWillNotBalance: cannot close accounting period "%" (% to %); the trial balance as at % '
      'is out by % fils. A period is filed on books that balance.',
      new.period_id, new.starts_on, new.ends_on, new.ends_on, v_difference
      using errcode = 'ZE001';
  end if;

  -- The exact count and the first ten names, in ONE pass. `count(*)` over a LIMITed subquery would
  -- count what was named rather than what exists, and taking the total from a second call to
  -- `period_close_blocker()` would read every straggler row twice -- which is the cost the limit is
  -- there to avoid. A window function inside the aggregate gets both from one scan.
  select count(*), string_agg(label, ', ' order by ord) filter (where ord <= 10)
    into v_total, v_named
    from (
      select b.document_kind || ' ' || b.document_label || ' (' || b.document_id || ')' as label,
             row_number() over (order by b.document_date, b.document_label) as ord
        from period_close_blocker(new.starts_on, new.ends_on) b
    ) named;

  if v_total > 0 then
    raise exception
      'PeriodHasUnpostedDocuments: cannot close accounting period "%" (% to %); % document(s) dated '
      'in it are not in the ledger%: %. Post them or re-date them; a closed period cannot take them '
      'afterwards.',
      new.period_id, new.starts_on, new.ends_on, v_total,
      -- Said out loud when the list is truncated. A message that showed ten of forty without saying so
      -- reads as the whole answer, and somebody posts ten documents and tries the close again.
      case when v_total > 10 then ' (the first 10 shown)' else '' end,
      v_named
      using errcode = 'ZE002';
  end if;

  return new;
end $$;

comment on function assert_period_closeable() is
  'Raises ZE001 (the trial balance as at ends_on does not balance, naming the difference in fils) or '
  'ZE002 (documents dated in the period are not in the ledger, naming up to ten of them and counting '
  'the rest). BEFORE INSERT and for EVERY role including the owner: a close that only the application '
  'checks is a close that psql performs.';

-- BEFORE INSERT and not a CHECK constraint, for the reason 0018 gives for its own period guards: a
-- CHECK may only read the row it is on, and both of these are statements about other tables.
create trigger period_lock_is_closeable before insert on period_lock
  for each row execute function assert_period_closeable();


-- ------------------------------------------------------------------------------------------------
-- ZL002 now names the earliest OPEN date, from every posting path at once
-- ------------------------------------------------------------------------------------------------
-- The acceptance: "after close, inserting a journal_line dated in that period raises PeriodLocked
-- naming the earliest open period, asserted from the invoice, credit note, bill, payment and
-- package-redemption paths."
--
-- 0018's message names the LOCKED period, which is the right half and sends somebody to the month
-- after it -- which may also be shut. 0072 hit this for credit notes and answered it in
-- `credit_note`'s own trigger with `earliest_open_date_from()`, so ZD003 carries both. That left the
-- ledger's own refusal saying less than the document's about the same fact.
--
-- Redefined here rather than copied into five triggers, and that IS the assertion for all five paths:
-- every posting path in this system -- the invoice through `finaliseCheckout`, the credit note through
-- `issueCreditNote`, the bill through `postBill`, the payment through the manual-payment adapter, and
-- the package redemption -- reaches `journal_entry` or `journal_line`, whose BEFORE INSERT guards both
-- call this one function. M-VAT-05 made the same argument for `BeforeOpeningBalance` and ZL004: "A
-- rule enforced in five places has five chances to be forgotten, and the one that is forgotten posts
-- into the period the opening entry already summarises."
--
-- `create or replace` and not a second function. A `raise_if_period_locked_v2` alongside the original
-- would leave 0018's triggers calling the one that says less, and the first person to add a posting
-- path would pick whichever they found first.
--
-- The added sentence is APPENDED. Every existing assertion on this message -- the period identifier in
-- `journal.itest.ts`, `periodId` in `checkout-finalise.itest.ts`, `PeriodLocked` in both -- is on a
-- substring, so a suffix keeps them all true. Reordering the message would not have.
create or replace function raise_if_period_locked(p_entry_date date, p_what text) returns void
language plpgsql
stable
as $$
declare
  v_period text := period_lock_for(p_entry_date);
  v_open   date;
begin
  if v_period is not null then
    -- The period identifier is IN the message, not merely in the SQLSTATE. "Posting refused" without
    -- it sends the person to the wrong month, and the entry they then chase is usually correct.
    v_open := earliest_open_date_from(p_entry_date);
    raise exception
      'PeriodLocked: cannot post % dated %; accounting period "%" is locked. The earliest open date '
      'is %.',
      p_what, p_entry_date, v_period, v_open
      using errcode = 'ZL002';
  end if;
end $$;

comment on function raise_if_period_locked(date, text) is
  'Raises ZL002 when p_entry_date falls in a locked period, naming the LOCKED period and the earliest '
  'OPEN date. Called by the BEFORE INSERT guards on journal_entry and journal_line, which is the one '
  'choke point every posting path reaches -- so the five paths carry this refusal without five copies '
  'of it.';
