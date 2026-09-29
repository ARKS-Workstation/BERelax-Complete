-- 0104 — payroll: the run that cannot be edited after it has paid somebody, and the tip that cannot be
--        revenue.
--
-- P-HR-12's subject is a PAYSLIP SOMEBODY WILL DISPUTE. The arithmetic is six additions and a subtraction
-- and it is not where this goes wrong. What goes wrong is that a figure moves after it was paid, and every
-- table here exists to refuse one of the ways:
--
--   1. **Editing a run that has paid.** The commonest and the most plausible: a figure is wrong, somebody
--      corrects it in place, and the payslip in an employee's hand no longer matches the record. A run
--      becomes immutable the moment it is COMPLETED (ZY141), and a correction is a NEW run naming the one
--      it corrects (ZY143) — the journal rule of 0018 applied to wages, and the same shape P-HR-07 gave
--      attendance and P-HR-11 gave commission.
--   2. **Recomputing commission at payslip time.** P-HR-11 built a migration to make a commission run
--      reproducible; a payslip that called the engine again would throw that away, because it would resolve
--      "the rule in force" and a rate published in June would restate March. `payslip` therefore PINS the
--      `commission_run_id` and its version, and ZY147 refuses a non-zero commission that names neither.
--   3. **Paying a period whose attendance was never closed.** An INCOMPLETE presence contributes ZERO
--      payable minutes (P-HR-07), so a month in which every clock-out was missed approves as 0 minutes and
--      reads as somebody who never came in. ZY145 refuses the run rather than paying a month of
--      twelve-hour days as an ordinary one.
--   4. **A tip becoming revenue.** A tip is the customer's money on its way to a therapist. `employee_tip`
--      names the account it is owed against and ZY146 refuses one whose type is not `liability`, so "a tip
--      never lands in a revenue account" is a property of the schema rather than a habit of a function.
--   5. **A header that adds up while the lines do not.** The run carries its own `payslip_count` and
--      `net_total_fils` and ZY150 holds them to the payslips at COMPLETION — 0097's ZY074 arrangement, for
--      its reason: a total that is a sum of the rows it reports cannot disagree with them, and cannot catch
--      a payslip that was never written either.
--
-- The arithmetic and every judgement live in `packages/core/src/hr/payroll.ts` and
-- `packages/core/src/hr/wps-sif.ts`, both pure. This migration supplies the two things a pure function may
-- not contain: the FIGURES a payslip is computed from, and the record of what was paid.
--
--
-- ## The draft state, and why UPDATE is not simply revoked here
--
-- Every other append-only table in this schema revokes UPDATE outright. This one cannot, and the reason is
-- worth stating because it is the file's one departure from the pattern. A payroll run is built in stages:
-- the header, then a payslip per employee, then — once somebody has LOOKED at them — the run is completed.
-- Completing it is an UPDATE. So the rule is not "no UPDATE" but "one UPDATE, and only the one":
--
--   * `payroll_run_may_only_be_completed` (ZY142) compares `to_jsonb(new)` with `to_jsonb(old)` and permits
--     exactly three keys to move — `completed_at`, `completed_by` and `updated_at`. `to_jsonb` and not a
--     column list, for 0043's recorded reason: a column a later migration adds is covered the day it
--     appears rather than the day somebody remembers.
--   * `payroll_run_is_immutable_once_completed` (ZY141) refuses every UPDATE once `completed_at` is set,
--     and every DELETE always.
--
-- A draft run is therefore not a weaker record. It is a record nothing has been paid against, which is
-- exactly what `wps_export`'s ZY149 turns into a refusal: a file cannot be taken of a run that has not
-- been completed.
--
--
-- ## What this file does NOT invent, and it is most of a real payroll system
--
-- **No WPS employer id, agent id, establishment id or MOL number.** docs/04 §7's entire statement about the
-- Wage Protection System is *"salary file, in the format the bank requires"*: no bank is named, no agent
-- code, no layout, no field spec. `Y8-wps` is the question. The identifiers live in the settings registry,
-- default to values that SAY they are pending and that fail `validateWpsFile` twice over — brief rule 15 at
-- its sharpest in this build, because a plausible thirteen digits would produce a file that passes every
-- check and pays nineteen people against somebody else's registration. There is no column here holding one.
--
-- **No deduction policy and no deduction vocabulary.** `payroll_deduction` carries an authorised actor and a
-- free-text reason and NO `kind` enum. A closed set of kinds would be this build deciding which deductions
-- are lawful, and MOHRE caps deductions as a proportion of pay by a figure nobody here has been told —
-- `Y9-deductions`. What the schema does state is the part that is arithmetic rather than policy: a deduction
-- may not exceed the pay it comes out of, because that is a negative net.
--
-- **No monthly-to-hourly divisor.** `labour_cost_rule` (0081) already holds it, versioned and provisional
-- against Y9-overtime, and `payroll_run` PINS the version it used rather than resolving one at read time.
-- A run reproduced next year must price its overtime at the divisor that priced it the first time.
--
-- **No tip model beyond what Y9-tips already records.** "Cash only, individual, recorded but not banked" is
-- that row's provisional answer, and the reading this file takes is stated on `employee_tip` rather than
-- assumed: a tip that went through the till is the salon's cash and the salon's debt, which is why it is a
-- liability the payroll run discharges. A tip handed straight to a therapist has no row here at all, and
-- that absence is deliberate — the business cannot record money it never saw.
--
--
-- ## The period lock has ONE reader, and this file does not add a second
--
-- "Is this date inside a closed accounting period?" is `period_lock_for()` (0018), redefined by 0073 to name
-- the earliest OPEN date too. Nothing here re-answers it: `payroll_run_period_guard` CALLS
-- `raise_if_period_locked()`, which is why the acceptance line "a locked period refuses a new payroll run"
-- costs no new refusal code and names the earliest open date without this file knowing how to find it.
-- 0086 and 0097 both took the same decision and recorded it in the same words.
--
--
-- ## Private SQLSTATEs: ZY141-ZY150
--
-- The CLASS identifies nothing (ADR 0043). A refusal is identified by all five characters and every code is
-- an entry in `packages/db/src/sqlstate-registry.ts` that `pnpm sqlstate` proves against this file. This
-- unit's band is ZY141-ZY150 and it uses all ten:
--
--   ZY141  a COMPLETED payroll run was UPDATEd, or any payroll run was DELETEd
--   ZY142  a DRAFT payroll run was UPDATEd in some way other than being completed
--   ZY143  a second run over a period does not name the completed run it corrects
--   ZY144  a payslip, tip or deduction row was UPDATEd or DELETEd
--   ZY145  a run covers a period whose approved timesheets count an INCOMPLETE presence
--   ZY146  a tip is owed against an account whose type is not `liability`
--   ZY147  a payslip states a commission figure that names no run and version
--   ZY148  a payslip was added to a run that has already been completed
--   ZY149  a WPS export names a run that has not been completed
--   ZY150  a completed run's payslip_count or net_total_fils disagrees with its payslips
--
-- Ten and not one because each has a different runbook answer, which is 0061's argument for a private code
-- at all: "correct it with a new run", "complete the run first", "record an attendance correction" and
-- "name a liability account" are four different things to go and do.
--
-- See docs/adr/0054-a-payslip-pins-every-figure-it-prints.md, docs/OPEN-QUESTIONS.md Y8-wps, Y9-tips and
-- Y9-deductions, packages/core/src/hr/payroll.ts and packages/core/src/hr/wps-sif.ts.

begin;

-- ---------------------------------------------------------------------------------------------
-- employee_tip — an individually attributed pass-through liability
-- ---------------------------------------------------------------------------------------------
create table employee_tip (
  id                     uuid        primary key default uuid_generate_v7(),

  -- A KEY, for `attendance_event.employee_id`'s reason: the row is the evidence of money owed to a person,
  -- and there is no reading of it that survives the person going. Ending employment is `employed_until`.
  employee_id            uuid        not null references employee (id) on delete restrict,

  -- The trading date the tip was received on. A PLAIN COLUMN and not a reference into `business_day`, for
  -- `attendance_event.trading_date`'s reason: this table can never be deleted from, so a RESTRICT
  -- reference would pin every date it names for ever and break the generator `business-days.itest.ts`
  -- empties. Trading runs 11:00-02:00, so a tip at 01:30 belongs to the PREVIOUS trading date — which is
  -- also which payroll period it falls in, and getting it wrong moves money between months.
  trading_date           date        not null,

  amount_fils            bigint      not null
                           constraint employee_tip_amount_is_positive check (amount_fils > 0),

  -- The account the salon owes it against. A COLUMN with a foreign key, and this is the acceptance
  -- criterion made structural: "a tip amount never lands in a revenue account" is a claim a test can make
  -- about one code path and the schema can make about every path, including a `psql` session and an import
  -- of another environment's rows. `assert_tip_is_owed_as_a_liability` (ZY146) refuses any account whose
  -- type is not `liability`, so there is no spelling of this INSERT that books a tip as income.
  --
  -- Defaulted to 2040 `Tips payable to therapists`, which 0018 already seeded — this file invents no
  -- account. The default is a default and not a hard-coded constant: a business with several tip
  -- liabilities (pooled and individual, say) would use more than one, and Y9-tips has not said.
  liability_account_code text        not null default '2040'
                           references account (code) on delete restrict,

  -- Where the money physically arrived, so the ledger side has something to reconcile against.
  --
  -- Nullable, and the null is honest rather than lazy: `cash_session` (0076) is the till, and a tip
  -- recorded against one is cash the salon actually holds. A tip with no session named is one somebody
  -- recorded outside a cash-up, which is a thing to chase rather than a thing to refuse — refusing it would
  -- push the record out of the system altogether, and an unrecorded tip is the failure this table exists to
  -- prevent.
  cash_session_id        uuid        references cash_session (id) on delete restrict,

  -- Who recorded it. A label and not a uuid, for `attendance_event.recorded_by`'s reason: the audit row
  -- written in the same transaction carries the actor, and this is the row's own record of accountability.
  -- Never blank and never a placeholder — a tip nobody is accountable for is a tip nobody can be asked
  -- about, and this is somebody else's money.
  recorded_by            text        not null
                           constraint employee_tip_recorded_by_not_placeholder
                             check (not is_placeholder_text(recorded_by) and btrim(recorded_by) <> ''),

  created_at             timestamptz not null default now()
);

comment on table employee_tip is
  'One individually attributed tip, append-only (ZY144). A pass-through LIABILITY and never revenue: the '
  'row names the liability account the salon owes it against and ZY146 refuses any account whose type is '
  'not liability, so no INSERT can book a tip as income. Y9-tips'' provisional answer is cash only and '
  'individual; a tip handed straight to a therapist has no row here, because the business cannot record '
  'money it never saw.';
comment on column employee_tip.liability_account_code is
  'The account the salon owes the tip against, defaulting to 2040 Tips payable to therapists (seeded by '
  '0018; this file invents no account). A column rather than a constant because a pooled tip would be a '
  'different liability, and ZY146 is what makes "never revenue" structural rather than conventional.';
comment on column employee_tip.trading_date is
  'The trading date the tip was received on, which is also which payroll period it falls in. Trading runs '
  '11:00-02:00, so a tip at 01:30 belongs to the PREVIOUS trading date and a truncation would move it into '
  'the next month.';

create index employee_tip_employee_day_idx on employee_tip (employee_id, trading_date);
create index employee_tip_day_idx on employee_tip (trading_date);

-- ---------------------------------------------------------------------------------------------
-- payroll_deduction — an authorised, dated reduction. Never derived.
-- ---------------------------------------------------------------------------------------------
-- NO `kind` vocabulary, deliberately, and this is the one table in the file whose shape is an argument.
--
-- The obvious design is a closed set of deduction kinds — unpaid leave, an advance repayment, a fine. Every
-- one of those three is a POLICY claim: whether an absence is unpaid, whether an advance may be recovered
-- from wages at all, and what proportion of pay a deduction may reach are questions Federal Decree-Law 33 of
-- 2021 answers and nobody has told this build what the answers are (`Y9-deductions`). A vocabulary would
-- read as the list of deductions this business makes, and a screen offering it would be this build
-- suggesting them.
--
-- So a deduction is an authorised actor, a reason somebody wrote, and an amount. That is the weakest true
-- statement, and the part the schema DOES enforce is the part that is arithmetic rather than policy: a
-- deduction may not exceed the pay it comes out of (`payslip_net_is_nonneg`), because that is a negative net.
create table payroll_deduction (
  id               uuid        primary key default uuid_generate_v7(),
  employee_id      uuid        not null references employee (id) on delete restrict,

  -- The trading date the deduction is ABOUT, which decides the period it falls in.
  trading_date     date        not null,

  amount_fils      bigint      not null
                     constraint payroll_deduction_amount_is_positive check (amount_fils > 0),

  -- What it is for, in somebody's own words. NOT NULL, not blank and not a placeholder: a deduction with no
  -- stated reason is the one an employee cannot challenge, and an unchallengeable deduction from wages is
  -- the thing labour law is most interested in.
  reason           text        not null
                     constraint payroll_deduction_reason_is_stated
                       check (not is_placeholder_text(reason) and btrim(reason) <> ''),

  -- Who authorised it, as a label. Distinct from `recorded_by` on purpose: the person who types a deduction
  -- and the person who may authorise one are different roles, and one column would let the first stand in
  -- for the second.
  authorised_by    text        not null
                     constraint payroll_deduction_authorised_by_not_placeholder
                       check (not is_placeholder_text(authorised_by) and btrim(authorised_by) <> ''),
  recorded_by      text        not null
                     constraint payroll_deduction_recorded_by_not_placeholder
                       check (not is_placeholder_text(recorded_by) and btrim(recorded_by) <> ''),
  created_at       timestamptz not null default now()
);

comment on table payroll_deduction is
  'One authorised, dated reduction of pay, append-only (ZY144). NO kind vocabulary deliberately: which '
  'deductions are lawful and what proportion of pay they may reach is Y9-deductions and nobody has '
  'answered it, so a closed set would read as the list of deductions this business makes. A reason '
  'somebody wrote, an authoriser distinct from the recorder, and an amount.';
comment on column payroll_deduction.authorised_by is
  'Who authorised it. Separate from recorded_by because the person who types a deduction and the person '
  'who may authorise one are different roles, and one column lets the first stand in for the second.';

create index payroll_deduction_employee_day_idx on payroll_deduction (employee_id, trading_date);

-- ---------------------------------------------------------------------------------------------
-- payroll_run — one payroll over one period, immutable once completed
-- ---------------------------------------------------------------------------------------------
create table payroll_run (
  id                              uuid        primary key default uuid_generate_v7(),

  period_starts_on                date        not null,
  period_ends_on                  date        not null,
  constraint payroll_run_period_ends_on_or_after_it_starts
    check (period_ends_on >= period_starts_on),

  -- THE pin for overtime. The `labour_cost_rule` version that turned a MONTHLY wage into a rate per minute,
  -- NOT NULL, so a run cannot exist without naming the divisor that priced it. `labour_cost_rule` uses
  -- `effective_from` as its primary key (0081), so that is what this references; the table can never be
  -- deleted from, which makes `restrict` belt-and-braces over an impossibility, exactly as 0097's pin is.
  --
  -- Recorded rather than resolved at read time for the reason P-HR-11's whole unit is about: a run
  -- reproduced next year must price its overtime at the divisor that priced it the first time, and
  -- `labourCostRulesFor` would answer with whatever is in force then.
  labour_cost_rule_effective_from date        not null
                                    references labour_cost_rule (effective_from) on delete restrict,

  -- The run this one corrects, or null for the first run of a period.
  --
  -- A self-reference between two rows neither of which anybody can delete, which is the case 0081 describes
  -- as its own self-references. ZY143 is what makes it a PRECONDITION rather than provenance: the second run
  -- over a period cannot be written without naming the first, so "a correction is a new dated run
  -- referencing the original" is unstorable any other way.
  corrects_run_id                 uuid        references payroll_run (id) on delete restrict,
  constraint payroll_run_does_not_correct_itself check (corrects_run_id is null or corrects_run_id <> id),

  -- The header figures, held to the payslips by ZY150 at completion. Carried rather than summed at read
  -- time so the reconciliation has something to reconcile AGAINST: 0097's argument, and the sharper version
  -- of it here, because these two figures are what the WPS file DECLARES and what the receiving bank
  -- compares its own count and sum against.
  payslip_count                   integer     not null default 0
                                    constraint payroll_run_payslip_count_is_nonneg
                                      check (payslip_count >= 0),
  net_total_fils                  bigint      not null default 0
                                    constraint payroll_run_net_total_is_nonneg
                                      check (net_total_fils >= 0),

  -- Employees the run could not produce a payslip for, and why they are COUNTED rather than passed over.
  --
  -- `rota_version.forecast_unpriced_employees`'s argument exactly (0081), and it bites harder here: all
  -- nineteen seeded employees have `basic_wage_fils` null (Y8-staff), so a run that treated an absent wage
  -- as zero would pay nineteen payslips of 0.00 AED and every figure on the screen would reconcile. A run
  -- over an entirely unpriced establishment is `payslip_count = 0` with this at 19, and the screen must
  -- print the second beside the first.
  unpriced_employee_count         integer     not null default 0
                                    constraint payroll_run_unpriced_count_is_nonneg
                                      check (unpriced_employee_count >= 0),

  -- Null while the run is a DRAFT. Set once, by the one UPDATE ZY142 permits, after which ZY141 refuses
  -- every change. This column IS the immutability boundary — see the file header.
  completed_at                    timestamptz,
  completed_by                    text
                                    constraint payroll_run_completed_by_not_placeholder
                                      check (completed_by is null
                                             or (not is_placeholder_text(completed_by)
                                                 and btrim(completed_by) <> '')),
  -- Both or neither. A `completed_at` with no `completed_by` is a run nobody is accountable for, and this
  -- one has paid people.
  constraint payroll_run_completion_is_complete
    check ((completed_at is null) = (completed_by is null)),

  created_at                      timestamptz not null default now(),
  created_by                      text        not null
                                    constraint payroll_run_created_by_not_placeholder
                                      check (not is_placeholder_text(created_by)
                                             and btrim(created_by) <> ''),
  updated_at                      timestamptz not null default now()
);

comment on table payroll_run is
  'One payroll over one period. A DRAFT until completed_at is set, and immutable after (ZY141); the only '
  'UPDATE permitted before is the completion itself (ZY142). A run that is wrong is corrected by a NEW '
  'dated run naming this one (ZY143) - 0018''s journal rule applied to wages. It PINS the labour_cost_rule '
  'version that priced its overtime, because a run reproduced next year must use the divisor that priced '
  'it the first time.';
comment on column payroll_run.completed_at is
  'Null while the run is a draft. THE immutability boundary: before it, only the completion UPDATE is '
  'permitted (ZY142); after it, nothing is (ZY141). A WPS export of an uncompleted run is refused (ZY149).';
comment on column payroll_run.unpriced_employee_count is
  'Employees with no basic_wage_fils on file, counted rather than passed over. All nineteen seeded '
  'employees have none (Y8-staff), so a run treating an absent wage as zero would pay nineteen payslips of '
  '0.00 AED with every figure on the screen reconciling.';
comment on column payroll_run.labour_cost_rule_effective_from is
  'The versioned monthly-wage divisor (0081) that priced this run''s overtime uplift. A pin and not a '
  'resolution: labourCostRulesFor would answer with whatever is in force when the run is reproduced.';

create index payroll_run_period_idx on payroll_run (period_starts_on, period_ends_on);
create index payroll_run_corrects_idx on payroll_run (corrects_run_id);

-- One FIRST run per period. A second must be a correction, which is ZY143's other half stated as an index.
--
-- Partial on `corrects_run_id is null`, so the history of corrections is unbounded and the original is
-- unambiguous — `employee_bank_detail_one_current`'s shape (0050) and its reason: without it, "which run
-- paid March" has as many answers as March has runs, and the query that picks one picks the wrong one.
create unique index payroll_run_one_original_per_period
  on payroll_run (period_starts_on, period_ends_on) where corrects_run_id is null;

-- ---------------------------------------------------------------------------------------------
-- payslip — one employee's figures under one run
-- ---------------------------------------------------------------------------------------------
create table payslip (
  id                    uuid        primary key default uuid_generate_v7(),
  run_id                uuid        not null references payroll_run (id) on delete restrict,
  employee_id           uuid        not null references employee (id) on delete restrict,

  -- The five additive components, in the order the document prints them. Each `fils_nonneg` (ADR 0007's
  -- domain, 0050's spelling): money is integer fils, and a negative component here would be a deduction
  -- wearing an earning's name.
  basic_fils            fils_nonneg not null,
  allowances_fils       fils_nonneg not null,
  overtime_fils         fils_nonneg not null,
  commission_fils       fils_nonneg not null,
  tips_fils             fils_nonneg not null,

  deductions_fils       fils_nonneg not null,

  -- GENERATED, both, for `employee.total_wage_fils`'s recorded reason: the payslip, the screen and the WPS
  -- file must not be able to compute these differently, and the one that disagrees is discovered by an
  -- employee. Generated also makes a wrong net UNSTORABLE rather than merely detectable, which is stronger
  -- than a CHECK comparing two columns somebody wrote.
  --
  -- The oracle the acceptance criterion asks for is therefore a THIRD computation and not this one:
  -- `summarisePayroll` in @berelax/core sums the components, these columns sum them again in SQL, and
  -- `packages/core/src/hr/payroll.test.ts` sums them a third time from a table of worked examples. Three
  -- independent statements of one identity, which is what makes "reconciles" a claim rather than a tautology.
  gross_fils            fils_nonneg not null generated always as
                          (basic_fils + allowances_fils + overtime_fils + commission_fils + tips_fils)
                          stored,
  net_fils              bigint      not null generated always as
                          (basic_fils + allowances_fils + overtime_fils + commission_fils + tips_fils
                             - deductions_fils) stored,

  -- A deduction larger than the pay it comes out of is a negative net. Refused rather than floored at zero:
  -- a floor forgives the excess silently and the excess is the figure somebody has to look at. What the
  -- lawful PROPORTION is, this file does not say — Y9-deductions — and a percentage here would be invented.
  constraint payslip_net_is_nonneg check (
    basic_fils + allowances_fils + overtime_fils + commission_fils + tips_fils - deductions_fils >= 0
  ),

  -- THE commission pin. Both columns or neither, and non-zero commission must have them (ZY147).
  --
  -- `commission_run_id` is a foreign key into a table nothing can delete from (ZY072), so the version that
  -- judged the figure is reachable from the payslip for ever. `commission_rule_version` is snapshotted
  -- BESIDE it rather than joined for, because what a disputing employee is handed is a sheet of paper: the
  -- version has to be ON the payslip, not one join away from it.
  commission_run_id     uuid        references commission_run (id) on delete restrict,
  commission_rule_version integer
                          constraint payslip_commission_version_starts_at_one
                            check (commission_rule_version is null or commission_rule_version >= 1),
  constraint payslip_commission_pin_is_whole
    check ((commission_run_id is null) = (commission_rule_version is null)),

  -- The attendance this payslip priced, pinned the same way and for the same reason. NOT NULL: a payslip
  -- whose overtime came from nowhere is a figure nobody can check, and an employee with no approved
  -- timesheet for the period is not somebody this run can pay overtime to.
  timesheet_approval_id uuid        not null references timesheet_approval (id) on delete restrict,
  payable_minutes       integer     not null
                          constraint payslip_payable_minutes_is_nonneg check (payable_minutes >= 0),
  -- The uplift basis-point-minutes the overtime figure was priced from, snapshotted so "why is the overtime
  -- 4,125 fils" is one row with no join — 0097's argument for snapshotting a band and a rate.
  overtime_uplift_minute_bp bigint  not null
                          constraint payslip_uplift_bp_is_nonneg check (overtime_uplift_minute_bp >= 0),

  created_at            timestamptz not null default now(),

  -- One payslip per employee per run. Two would be two payments with nothing able to choose, and the WPS
  -- file would carry both.
  constraint payslip_once_per_employee_per_run unique (run_id, employee_id)
);

comment on table payslip is
  'One employee''s figures under one run, append-only (ZY144). gross_fils and net_fils are GENERATED so '
  'the payslip, the screen and the WPS file cannot compute them differently - and a wrong net is '
  'unstorable rather than merely detectable. Every figure it prints is PINNED to what decided it: the '
  'commission run and its rule version (ZY147), the timesheet approval, and through the run the '
  'labour_cost_rule version that priced the overtime.';
comment on column payslip.net_fils is
  'GENERATED: basic + allowances + overtime + commission + tips - deductions. The figure the WPS file pays '
  'and the one an employee disputes, which is why it is not a column anybody writes.';
comment on column payslip.commission_run_id is
  'The commission_run this figure is a line of. A payslip names the RUN and the VERSION that produced its '
  'commission, never a recomputation at payslip time: resolving "the rule in force" would restate March at '
  'June''s rates. ZY147 refuses a non-zero commission that names neither.';
comment on column payslip.overtime_uplift_minute_bp is
  'The uplift basis-point-minutes the overtime figure was priced from: weighted_minute_bp less '
  'payable_minutes at the ordinary multiplier. Snapshotted so "why is the overtime this figure" is one row '
  'with no join.';

create index payslip_run_idx on payslip (run_id);
create index payslip_employee_idx on payslip (employee_id, created_at desc);
create index payslip_commission_run_idx on payslip (commission_run_id);

-- ---------------------------------------------------------------------------------------------
-- wps_export — the audited record that a file left the building
-- ---------------------------------------------------------------------------------------------
-- An export is the insider-threat signal (0005's `audit_event_export_idx`), and `recordExport` writes the
-- audit row with its row count. This table is the other half: the audit row says somebody exported, and
-- this says WHAT — which run, how many records, what total, and the digest of the bytes. Without the digest
-- there is no way to tell the file a bank received from a file somebody edited afterwards.
create table wps_export (
  id            uuid        primary key default uuid_generate_v7(),

  -- The run exported. ZY149 refuses one that has not been completed: a file taken of a draft is a payment
  -- instruction for figures nobody has signed off, and it is indistinguishable from a real one downstream.
  run_id        uuid        not null references payroll_run (id) on delete restrict,

  -- Which layout produced the bytes. The closed set matches `WPS_SIF_FORMATS` in @berelax/core, restated
  -- here for `attendance_event.capture_method`'s reason: the day the bank's real spec arrives it is a NEW
  -- member, and every file already exported keeps saying which layout wrote it.
  format        text        not null
                  constraint wps_export_format_known check (format in ('generic_mohre_v1')),

  record_count  integer     not null
                  constraint wps_export_record_count_is_nonneg check (record_count >= 0),
  total_fils    bigint      not null
                  constraint wps_export_total_is_nonneg check (total_fils >= 0),

  -- sha256 of the bytes, lower-case hex. Sixty-four characters, constrained, because a digest that is not
  -- one is a digest nobody can compare and it would be discovered in front of an auditor.
  file_sha256   text        not null
                  constraint wps_export_sha256_shape check (file_sha256 ~ '^[0-9a-f]{64}$'),

  exported_by   text        not null
                  constraint wps_export_exported_by_not_placeholder
                    check (not is_placeholder_text(exported_by) and btrim(exported_by) <> ''),
  exported_at   timestamptz not null default now()
);

comment on table wps_export is
  'One WPS file that left the building, append-only (ZY144). The audit_event written in the same '
  'transaction says somebody exported and how many rows (0005''s insider-threat index); this says which '
  'run, which layout, and the sha256 of the bytes - without which a file a bank received cannot be told '
  'from one somebody edited afterwards. ZY149 refuses an export of a run that is not completed.';

create index wps_export_run_idx on wps_export (run_id);
create index wps_export_exported_at_idx on wps_export (exported_at desc);

-- ---------------------------------------------------------------------------------------------
-- ZY141 / ZY142 — the run is immutable once completed, and a draft may only be completed
-- ---------------------------------------------------------------------------------------------
-- Two functions and not one, because the two refusals have different runbook answers — 0097's argument
-- verbatim. A run that has PAID somebody is corrected by running the period again; a DRAFT that somebody is
-- trying to edit is a caller doing something the API does not offer, and telling them the first when they
-- meant the second sends them to create a run they did not need.
--
-- BEFORE triggers rather than privileges alone. The revokes below cover the application role, and a
-- migration, a `psql` session and a restore do not connect as it — 0018's wording, and it is the half of
-- "immutable" that a convention cannot hold.
create function refuse_completed_payroll_run_change() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'PayrollRunIsImmutable: payroll run % has been paid against and DELETE is refused. A run is the '
      'evidence behind a payslip somebody holds and a WPS file a bank received; a run that is wrong is '
      'corrected by running the period AGAIN, which is a new run naming this one.',
      old.id using errcode = 'ZY141';
  end if;
  raise exception
    'PayrollRunIsImmutable: payroll run % was completed at % and UPDATE is refused. Correct it with a '
    'NEW run whose corrects_run_id names this one - never by editing figures somebody was already paid.',
    old.id, old.completed_at using errcode = 'ZY141';
end $$;

comment on function refuse_completed_payroll_run_change() is
  'Raises ZY141 for every DELETE on payroll_run and for every UPDATE of a COMPLETED one, for EVERY role '
  'including the owner. Separate from refuse_payroll_run_draft_edit() because the remedy differs: a new '
  'RUN, not a different API call.';

create function refuse_payroll_run_draft_edit() returns trigger
language plpgsql
as $$
declare
  v_allowed text[];
  v_changed text[];
begin
  /*
    Two allow-lists, because a draft accepts exactly one kind of UPDATE and it is the one that ENDS the
    draft.

    **Completing the run** is also the moment its header figures become knowable: `payslip_count` and
    `net_total_fils` are the sum of rows that arrive over several transactions while the run is open, so
    they cannot be supplied when it is opened — and ZY150 fires on this very UPDATE to hold them to the
    payslips. So the completing UPDATE may set the three header figures alongside the two completion
    columns, and nothing else.

    **Any other UPDATE of a draft** may change nothing but `updated_at`. That is stricter than it first
    looks and it is the point: a draft whose figures were edited in place could not be told from one whose
    INPUTS changed, and the remedy for a wrong draft is to discard it and build it again — which costs
    nothing, because a draft has paid nobody.

    `to_jsonb(new)` against `to_jsonb(old)` rather than a column list, which is 0043's technique and 0050's
    reason for reusing it: a column a later migration adds to this table is covered the day it appears
    rather than the day somebody remembers to add it to a list. A new column is therefore IMMUTABLE by
    default here, which is the safe direction for a table about pay.
  */
  if new.completed_at is not null then
    v_allowed := array['completed_at', 'completed_by', 'updated_at',
                       'payslip_count', 'net_total_fils', 'unpriced_employee_count'];
  else
    v_allowed := array['updated_at'];
  end if;

  select array_agg(key order by key) into v_changed
    from jsonb_each(to_jsonb(old)) o
    where not (o.key = any(v_allowed))
      and o.value is distinct from (to_jsonb(new) -> o.key);

  if v_changed is not null then
    raise exception
      'PayrollRunDraftMayOnlyBeCompleted: payroll run % is a draft and this UPDATE changes %. A draft '
      'accepts exactly one UPDATE - the one that completes it, which sets completed_at, completed_by and '
      'the three header figures ZY150 then checks against the payslips. A figure that is wrong in a draft '
      'is corrected by discarding the draft and building it again, because a run whose numbers moved while '
      'it was open cannot be told from one whose inputs changed - and a draft has paid nobody, so '
      'discarding it costs nothing.',
      old.id, array_to_string(v_changed, ', ') using errcode = 'ZY142';
  end if;
  return new;
end $$;

comment on function refuse_payroll_run_draft_edit() is
  'Raises ZY142 when an UPDATE of a DRAFT payroll run changes anything it may not. The COMPLETING update '
  'may set completed_at, completed_by and the three header figures (which only become knowable then, and '
  'which ZY150 checks on the same statement); any other update of a draft may change nothing but '
  'updated_at. to_jsonb rather than a column list, so a column added later is immutable by default.';

create trigger payroll_run_no_delete before delete on payroll_run
  for each row execute function refuse_completed_payroll_run_change();
create trigger payroll_run_no_update_once_completed before update on payroll_run
  for each row when (old.completed_at is not null)
  execute function refuse_completed_payroll_run_change();
create trigger payroll_run_draft_may_only_be_completed before update on payroll_run
  for each row when (old.completed_at is null)
  execute function refuse_payroll_run_draft_edit();
create trigger payroll_run_updated_at before update on payroll_run
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- ZY144 — the payslip, the tip, the deduction and the export are append-only
-- ---------------------------------------------------------------------------------------------
-- One function for four tables, unlike the run's two, because the runbook answer IS the same for all four:
-- none of them is corrected, each is superseded by a new row, and the message says which table refused.
create function refuse_payroll_record_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'PayrollRecordIsAppendOnly: % is a record of money owed or paid and % is refused. A figure that is '
    'wrong is a NEW row - a correcting payroll run, a further tip, a further deduction, a further export - '
    'never an edit to the row somebody was paid against.',
    tg_table_name, tg_op
    using errcode = 'ZY144';
end $$;

comment on function refuse_payroll_record_change() is
  'Raises ZY144 for every UPDATE and DELETE on payslip, employee_tip, payroll_deduction and wps_export, '
  'for EVERY role including the owner. One function for four tables because the remedy is the same for '
  'all four: a new row, never an edit.';

create trigger payslip_no_update before update on payslip
  for each row execute function refuse_payroll_record_change();
create trigger payslip_no_delete before delete on payslip
  for each row execute function refuse_payroll_record_change();
create trigger employee_tip_no_update before update on employee_tip
  for each row execute function refuse_payroll_record_change();
create trigger employee_tip_no_delete before delete on employee_tip
  for each row execute function refuse_payroll_record_change();
create trigger payroll_deduction_no_update before update on payroll_deduction
  for each row execute function refuse_payroll_record_change();
create trigger payroll_deduction_no_delete before delete on payroll_deduction
  for each row execute function refuse_payroll_record_change();
create trigger wps_export_no_update before update on wps_export
  for each row execute function refuse_payroll_record_change();
create trigger wps_export_no_delete before delete on wps_export
  for each row execute function refuse_payroll_record_change();

-- ---------------------------------------------------------------------------------------------
-- ZY143 — a second run over a period must name the completed run it corrects
-- ---------------------------------------------------------------------------------------------
-- `payroll_run_one_original_per_period` already refuses a second run with a NULL `corrects_run_id`. This is
-- the other three quarters of the rule, and each quarter is a way the correction chain becomes unreadable:
--
--   * a correction naming a run over a DIFFERENT period is not a correction, it is a run filed under the
--     wrong month, and every later reader would reconcile it against the wrong figures;
--   * a correction naming a run that was never COMPLETED is correcting a draft, which is not a thing that
--     happened — a draft is discarded and rebuilt (ZY142's message says so);
--   * a chain is fine and a cycle is not, and `payroll_run_does_not_correct_itself` only catches the
--     one-row case.
create function assert_payroll_correction_names_its_original() returns trigger
language plpgsql
as $$
declare
  v_starts date;
  v_ends   date;
  v_done   timestamptz;
begin
  if new.corrects_run_id is null then return new; end if;

  select period_starts_on, period_ends_on, completed_at
    into v_starts, v_ends, v_done
    from payroll_run where id = new.corrects_run_id;

  -- Unreachable through the foreign key, answered rather than asserted so the message below cannot print
  -- "expected <NULL>" — 0097's habit, for the restore-with-triggers-off case.
  if not found then
    raise exception
      'PayrollCorrectionNamesNoRun: payroll run % claims to correct %, which does not exist.',
      new.id, new.corrects_run_id using errcode = 'ZY143';
  end if;

  if v_starts <> new.period_starts_on or v_ends <> new.period_ends_on then
    raise exception
      'PayrollCorrectionPeriodDiffers: payroll run for %..% claims to correct run %, which covers %..%. '
      'A run over a different period is not a correction of this one; it is a run filed under the wrong '
      'month, and every later reader would reconcile it against the wrong figures.',
      new.period_starts_on, new.period_ends_on, new.corrects_run_id, v_starts, v_ends
      using errcode = 'ZY143';
  end if;

  if v_done is null then
    raise exception
      'PayrollCorrectionCorrectsADraft: payroll run % is a draft, so there is nothing to correct. A draft '
      'is discarded and built again; only a COMPLETED run has paid anybody, and only a payment needs '
      'correcting.',
      new.corrects_run_id using errcode = 'ZY143';
  end if;
  return new;
end $$;

comment on function assert_payroll_correction_names_its_original() is
  'Raises ZY143 when a correcting payroll run names a run over a different period, or a run that was '
  'never completed. The fourth quarter of the rule - a second run with no corrects_run_id at all - is '
  'payroll_run_one_original_per_period.';

create trigger payroll_run_correction_names_its_original before insert on payroll_run
  for each row execute function assert_payroll_correction_names_its_original();

-- ---------------------------------------------------------------------------------------------
-- ZY145 — a run may not cover a period whose attendance was never closed
-- ---------------------------------------------------------------------------------------------
-- The acceptance criterion: "running payroll over a period with an INCOMPLETE attendance row is refused
-- naming the row".
--
-- **`timesheet_approval.incomplete_presence_count` and NOT a second pairing of the punches.** Whether a
-- clock-in was ever closed, and whether a span is believed at all, is decided in exactly one place —
-- `pairAttendancePunches` in @berelax/core, against the `attendance_grace_rule` version the approval
-- snapshotted — and P-HR-07 stored the count on the approval row so a later reader does not have to ask
-- again. A SQL re-derivation here would be a second implementation of the plausibility ceiling, and the two
-- would disagree the first time that figure was versioned: 0080's header says what a second reader costs.
--
-- So this names the APPROVAL row and its count, which is what the database can see. The specific
-- `attendance_event` ids come from `assertAttendanceIsComplete` in @berelax/core, which the orchestrator
-- calls with the refs `incompletePresencesOf` read off the variances — one implementation, two layers: the
-- trigger holds for a `psql` session and the application tells a human which punch to go and fix.
create function assert_payroll_run_over_closed_attendance() returns trigger
language plpgsql
as $$
declare
  v_row record;
begin
  select id, employee_id, from_trading_date, to_trading_date, incomplete_presence_count
    into v_row
    from timesheet_approval
    where incomplete_presence_count > 0
      -- Inclusive overlap at both ends, because a timesheet period is a label whose ends are whole trading
      -- dates: a half-open comparison drops an approval that ends on the day the payroll period starts.
      and from_trading_date <= new.period_ends_on
      and to_trading_date   >= new.period_starts_on
    order by from_trading_date, employee_id
    limit 1;

  if found then
    raise exception
      'PayrollOverUnclosedAttendance: timesheet_approval % (employee %, %..%) counts % INCOMPLETE '
      'presence(s), so payroll for %..% is refused rather than run over it. An INCOMPLETE presence '
      'contributes ZERO payable minutes, so a month of missed clock-outs approves as 0 minutes and reads '
      'as somebody who never came in - and paying that is the failure this refuses. Record an '
      'attendance_correction (P-HR-07) saying what happened, then run payroll.',
      v_row.id, v_row.employee_id, v_row.from_trading_date, v_row.to_trading_date,
      v_row.incomplete_presence_count, new.period_starts_on, new.period_ends_on
      using errcode = 'ZY145';
  end if;
  return new;
end $$;

comment on function assert_payroll_run_over_closed_attendance() is
  'Raises ZY145 when any timesheet_approval overlapping the run''s period counts an INCOMPLETE presence. '
  'Reads P-HR-07''s stored count rather than pairing the punches again: whether a clock-in was closed is '
  'decided once, in pairAttendancePunches, against the grace version the approval snapshotted.';

create trigger payroll_run_over_closed_attendance before insert on payroll_run
  for each row execute function assert_payroll_run_over_closed_attendance();

-- ---------------------------------------------------------------------------------------------
-- The locked period, through the ONE reader of it
-- ---------------------------------------------------------------------------------------------
-- "A locked period refuses a new payroll run" costs no private code, because `raise_if_period_locked()`
-- (0018, redefined by 0073) already raises ZL002 and already names the locked period AND the earliest open
-- date. 0086 and 0097 both call it rather than re-answering the question, and this is the third.
--
-- The date tested is `period_ends_on`: a payroll run is a posting DATED at the end of the period it pays,
-- which is the date a ledger entry for it would carry. Testing the start instead would let a run be created
-- over a month whose close had already happened.
create function payroll_run_period_guard() returns trigger
language plpgsql
as $$
begin
  perform raise_if_period_locked(
    new.period_ends_on,
    'payroll run for ' || new.period_starts_on || '..' || new.period_ends_on
  );
  return new;
end $$;

comment on function payroll_run_period_guard() is
  'Calls raise_if_period_locked() for the run''s period end, so a locked accounting period refuses a new '
  'payroll run with ZL002 naming the locked period and the earliest open date. No second reader of the '
  'lock exists to disagree with it.';

create trigger payroll_run_period_lock before insert on payroll_run
  for each row execute function payroll_run_period_guard();

-- ---------------------------------------------------------------------------------------------
-- ZY146 — a tip is a liability, never revenue
-- ---------------------------------------------------------------------------------------------
-- A CHECK cannot express this: the account's TYPE lives on another table. So a trigger, and a BEFORE INSERT
-- one, which is the layer that still holds for a `psql` session and for an import of another environment's
-- rows — the paths a repository-level test cannot see.
--
-- It refuses everything that is not `liability` rather than refusing `revenue` specifically, and that is the
-- difference between a rule and a list: a tip credited to an EXPENSE account is equally wrong and would
-- pass a revenue-only test, and a tip credited to an ASSET account is the till reconciling to nothing.
create function assert_tip_is_owed_as_a_liability() returns trigger
language plpgsql
as $$
declare
  v_type text;
  v_name text;
begin
  select type, name into v_type, v_name from account where code = new.liability_account_code;

  if not found then
    -- Unreachable through the foreign key; answered for the restore-with-triggers-off case.
    raise exception
      'TipAccountUnknown: tip names account %, which does not exist.',
      new.liability_account_code using errcode = 'ZY146';
  end if;

  if v_type <> 'liability' then
    raise exception
      'TipIsNotALiability: a tip of % fils for employee % names account % ("%"), whose type is "%". A tip '
      'is the customer''s money on its way to a therapist: the salon HOLDS it and OWES it, so it is a '
      'liability and never revenue, an expense or an asset. Booking it as income would overstate turnover, '
      'overstate the VAT due on a supply nobody made, and take somebody else''s money into the '
      'profit-and-loss account.',
      new.amount_fils, new.employee_id, new.liability_account_code, v_name, v_type
      using errcode = 'ZY146';
  end if;
  return new;
end $$;

comment on function assert_tip_is_owed_as_a_liability() is
  'Raises ZY146 unless employee_tip.liability_account_code names an account whose type is liability. '
  'Refuses everything that is not a liability rather than refusing revenue specifically: a tip booked to '
  'an expense account is equally wrong and would pass a revenue-only test.';

create trigger employee_tip_is_a_liability before insert on employee_tip
  for each row execute function assert_tip_is_owed_as_a_liability();

-- ---------------------------------------------------------------------------------------------
-- ZY147 — a commission figure on a payslip names the run and the version that produced it
-- ---------------------------------------------------------------------------------------------
-- `payslip_commission_pin_is_whole` already refuses one of the two columns without the other. This is the
-- rule the unit is actually about: a NON-ZERO commission with no pin at all.
--
-- It also holds the snapshotted version EQUAL to the run's, which is the half a foreign key cannot state.
-- 0097 made the same claim about `commission_line` with a composite foreign key onto
-- `commission_run_rule_version_pin` — available there because the line stores the version's UUID. Here the
-- payslip stores the version NUMBER, which is what a reader needs printed on the page, so the equality is a
-- trigger instead. Without it the pin would be a number somebody keeps in step, which is the drift 0097's
-- own comment refuses.
create function assert_payslip_commission_is_pinned() returns trigger
language plpgsql
as $$
declare
  v_version integer;
begin
  if new.commission_fils = 0 then
    if new.commission_run_id is not null then
      raise exception
        'PayslipZeroCommissionNamesARun: payslip for employee % states no commission and names run %. '
        'That is not harmless: naming a run says one was read and produced nothing for this employee, '
        'which is a different fact from the commission module being disabled (Y9-commission), and the two '
        'must not be written the same way.',
        new.employee_id, new.commission_run_id using errcode = 'ZY147';
    end if;
    return new;
  end if;

  if new.commission_run_id is null then
    raise exception
      'PayslipCommissionIsUnpinned: payslip for employee % states % fils of commission and names no '
      'commission run. A figure with no run behind it cannot be reproduced - the run holds the rule '
      'version and the source_as_of instant, and without them the question a therapist actually asks has '
      'no answer. P-HR-11 exists to make it answerable.',
      new.employee_id, new.commission_fils using errcode = 'ZY147';
  end if;

  select version into v_version
    from commission_rule c
    join commission_run r on r.rule_version_id = c.id
    where r.id = new.commission_run_id;

  if v_version is distinct from new.commission_rule_version then
    raise exception
      'PayslipCommissionVersionDiffers: payslip for employee % names commission run % and version %, but '
      'that run was judged by version %. The version is printed on the payslip rather than joined for, so '
      'it is snapshotted - and a snapshot that disagrees with its source is the drift the pin exists to '
      'prevent.',
      new.employee_id, new.commission_run_id, new.commission_rule_version, v_version
      using errcode = 'ZY147';
  end if;
  return new;
end $$;

comment on function assert_payslip_commission_is_pinned() is
  'Raises ZY147 when a payslip states a non-zero commission with no run, when a zero commission names a '
  'run, or when the snapshotted rule version disagrees with the run''s. The equality is a trigger and not '
  'a composite foreign key because the payslip stores the version NUMBER, which is what a reader needs '
  'printed on the page.';

create trigger payslip_commission_is_pinned before insert on payslip
  for each row execute function assert_payslip_commission_is_pinned();

-- ---------------------------------------------------------------------------------------------
-- ZY148 — a payslip may not be added to a run that has already been completed
-- ---------------------------------------------------------------------------------------------
-- Without this, the immutability of a completed run is only half true: nothing would have UPDATEd the run,
-- and its `payslip_count` would silently stop being the number of payslips it has. That is the worst
-- available shape, because ZY150 checks the header against the payslips at COMPLETION and would never look
-- again — so the twentieth payslip added to a completed run of nineteen would be invisible to every check
-- in this file and visible only as a WPS file whose declared count was wrong.
create function assert_payslip_run_is_open() returns trigger
language plpgsql
as $$
declare
  v_done timestamptz;
begin
  select completed_at into v_done from payroll_run where id = new.run_id;

  if v_done is not null then
    raise exception
      'PayrollRunAlreadyCompleted: payroll run % was completed at % and a payslip cannot be added to it. '
      'The run''s payslip_count and net_total_fils were reconciled against its payslips at completion '
      '(ZY150) and are never checked again, so a payslip added afterwards would be invisible to every '
      'other rule here and visible only as a WPS file whose declared count was wrong. Pay this employee '
      'in a correcting run.',
      new.run_id, v_done using errcode = 'ZY148';
  end if;
  return new;
end $$;

comment on function assert_payslip_run_is_open() is
  'Raises ZY148 when a payslip is inserted against a COMPLETED payroll run. Without it the completed '
  'run''s header would silently stop being the number of payslips it has, and ZY150 never looks again.';

create trigger payslip_run_is_open before insert on payslip
  for each row execute function assert_payslip_run_is_open();

-- ---------------------------------------------------------------------------------------------
-- ZY149 — a WPS export names a COMPLETED run
-- ---------------------------------------------------------------------------------------------
-- A file taken of a draft is a payment instruction for figures nobody has signed off, and downstream it is
-- indistinguishable from a real one: the bytes carry no draft flag a bank would read. So the state is
-- checked where the export is recorded, and the refusal says what to do.
create function assert_wps_export_names_a_completed_run() returns trigger
language plpgsql
as $$
declare
  v_done  timestamptz;
  v_count integer;
  v_total bigint;
begin
  select completed_at, payslip_count, net_total_fils
    into v_done, v_count, v_total
    from payroll_run where id = new.run_id;

  if not found then
    raise exception
      'WpsExportNamesNoRun: export names payroll run %, which does not exist.',
      new.run_id using errcode = 'ZY149';
  end if;

  if v_done is null then
    raise exception
      'WpsExportOfADraft: payroll run % has not been completed, so no WPS file may be taken of it. The '
      'bytes carry no draft flag a bank would read, so a file of a draft is indistinguishable from a real '
      'payment instruction. Complete the run first.',
      new.run_id using errcode = 'ZY149';
  end if;

  -- The export's own figures against the run's. The file DECLARES these two and a receiving bank compares
  -- its own count and sum against them (`wps_record_count_disagrees`, `wps_total_disagrees` in
  -- @berelax/core), so an export row that disagrees with its run is a rejection waiting to happen — and
  -- the export row is the only evidence of what was actually sent.
  if new.record_count <> v_count or new.total_fils <> v_total then
    raise exception
      'WpsExportDisagreesWithItsRun: export of run % declares % record(s) totalling % fils; the run '
      'reports % record(s) totalling %. The file declares these two figures and the receiving bank checks '
      'them, so an export row that disagrees with its run is a rejection waiting to happen.',
      new.run_id, new.record_count, new.total_fils, v_count, v_total
      using errcode = 'ZY149';
  end if;
  return new;
end $$;

comment on function assert_wps_export_names_a_completed_run() is
  'Raises ZY149 when a wps_export names a run that has not been completed, or declares a record count or '
  'total that disagrees with the run''s. The bytes carry no draft flag a bank would read.';

create trigger wps_export_names_a_completed_run before insert on wps_export
  for each row execute function assert_wps_export_names_a_completed_run();

-- ---------------------------------------------------------------------------------------------
-- ZY150 — a completed run's header equals its payslips
-- ---------------------------------------------------------------------------------------------
-- 0097's ZY074 arrangement, at the other end of the lifecycle. The header is an INDEPENDENT figure so the
-- payslips can be reconciled against it — a total that is a sum of the rows it reports cannot disagree with
-- them, and cannot catch a payslip that was never written either.
--
-- Checked at COMPLETION rather than on every insert, and NOT as a deferred constraint trigger: the payslips
-- of a run arrive over several transactions while it is a draft (that is what a draft is for), so a
-- deferred check at the end of the first transaction would fire against a run holding one payslip. The
-- completion UPDATE is the one moment the run claims to be finished, which is the moment to hold it to its
-- own claim.
--
-- The count is checked beside the total because the two fail differently — 0097's reason, and it applies
-- unchanged: a total that matches with a zero-net payslip missing would report the right money about the
-- wrong number of people, and the WPS file declares both.
create function assert_completed_payroll_run_matches_its_payslips() returns trigger
language plpgsql
as $$
declare
  v_sum   bigint;
  v_count integer;
begin
  select coalesce(sum(net_fils), 0), count(*) into v_sum, v_count
    from payslip where run_id = new.id;

  if v_sum <> new.net_total_fils or v_count <> new.payslip_count then
    raise exception
      'PayrollRunDisagreesWithItsPayslips: run % is being completed reporting % fils over % payslip(s), '
      'and its payslips sum to % fils over %. The header is an independent figure precisely so the '
      'payslips can be reconciled against it; a header that disagrees is a screen that adds up and a WPS '
      'file a bank rejects.',
      new.id, new.net_total_fils, new.payslip_count, v_sum, v_count
      using errcode = 'ZY150';
  end if;
  return new;
end $$;

comment on function assert_completed_payroll_run_matches_its_payslips() is
  'Raises ZY150 when the UPDATE that completes a payroll run reports a net_total_fils or payslip_count '
  'that disagrees with its payslip rows. Checked at completion and not as a deferred constraint, because '
  'a draft''s payslips arrive over several transactions.';

create trigger payroll_run_matches_its_payslips before update on payroll_run
  for each row when (old.completed_at is null and new.completed_at is not null)
  execute function assert_completed_payroll_run_matches_its_payslips();

-- ---------------------------------------------------------------------------------------------
-- payslip_detail — the payslip a reader is shown, with everything it is pinned to
-- ---------------------------------------------------------------------------------------------
-- A VIEW and not a stored summary, for the reason `commission_derivation` (0097), `leave_balance` (0066) and
-- `invoice_settlement` (0068) are views: there is no second copy of the figures to drift from the rows that
-- produced them.
--
-- It names the employee by `staff_reference` and NEVER by a display name. Nineteen employment records have
-- no name recorded (ADR 0020, Y12-names), and a payslip is exactly the document on which an invented one
-- would look like a fact about a person.
create view payslip_detail as
  select
    p.id                            as payslip_id,
    p.run_id,
    p.employee_id,
    e.staff_reference,
    r.period_starts_on,
    r.period_ends_on,
    r.completed_at                  as run_completed_at,
    r.corrects_run_id,
    r.labour_cost_rule_effective_from,
    p.basic_fils,
    p.allowances_fils,
    p.overtime_fils,
    p.commission_fils,
    p.tips_fils,
    p.gross_fils,
    p.deductions_fils,
    p.net_fils,
    p.commission_run_id,
    p.commission_rule_version,
    p.timesheet_approval_id,
    p.payable_minutes,
    p.overtime_uplift_minute_bp,
    t.working_hours_rule_effective_from,
    t.grace_rule_effective_from,
    p.created_at
  from payslip p
  join payroll_run r on r.id = p.run_id
  join employee e on e.id = p.employee_id
  join timesheet_approval t on t.id = p.timesheet_approval_id;

comment on view payslip_detail is
  'One row per payslip with every version it is pinned to: the commission run and rule version, the '
  'timesheet approval and the two rule versions THAT snapshotted, and the run''s labour_cost_rule. A view '
  'and not a stored summary, so no second copy of the figures can drift. The employee is named by '
  'staff_reference and never by a display name: nineteen records have none (ADR 0020).';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 granted the application role select, insert, update and delete on every table in public AND set
-- default privileges extending that to tables created later, so all five tables arrive with UPDATE and
-- DELETE already granted. An append-only table that forgets to revoke them is append-only only for as long
-- as nobody writes the statement.
--
-- `payroll_run` keeps UPDATE, and it is the one table in this file that does: completing a run is an UPDATE,
-- and it is the application that completes it. What a run may become is ZY141 and ZY142's business rather
-- than a privilege's — see the file header. Everything else loses both.
grant select, insert, update on payroll_run to berelax_app;
revoke delete on payroll_run from berelax_app;

grant select, insert on payslip, employee_tip, payroll_deduction, wps_export to berelax_app;
revoke update, delete on payslip, employee_tip, payroll_deduction, wps_export from berelax_app;

-- TRUNCATE fires no row-level DELETE trigger, so the refusals above would not see it. The application role
-- holds no TRUNCATE (it is owner-only and never granted), which is what 0083, 0093 and 0097 rely on too —
-- and it is why the integration suites that clear these tables do so as the OWNER.
grant select on payslip_detail to berelax_app;

commit;
