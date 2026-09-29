-- 0107 — end-of-service gratuity: the liability that grows every month, and the three ways of getting it
--        into the journal wrongly.
--
-- P-HR-13's subject is A NUMBER ON THE BALANCE SHEET THAT NOBODY WILL LOOK AT FOR YEARS. Gratuity is not
-- paid monthly, it is OWED monthly, and the whole risk is that the figure is quietly wrong for thirty
-- months before the first leaver makes anybody add it up. Every table here exists to refuse one of the ways
-- that happens:
--
--   1. **Accruing the same month twice.** The commonest and the cheapest to cause: a monthly cron fires
--      twice, or a catch-up sweep meets a month it already did. `gratuity_accrual_one_original_per_month`
--      is a partial unique index and the job inserts `on conflict do nothing`, so a second pass inserts no
--      row, posts no journal line, and therefore cannot move a balance. Idempotence is a property of the
--      SCHEMA here and not of the job remembering anything (0031 records what a job's own state costs).
--   2. **Accruing into a month somebody has already filed.** ADR 0026: a closed period cannot be reopened
--      without a migration, and ADR 0017's journal has no edit. So an accrual for a locked month may not be
--      dated in it. `ZY174` refuses the row unless it NAMES the lock and carries an entry dated outside
--      every lock — which is one mechanism for the acceptance line's two halves ("accruing into a locked
--      period is refused; the entry lands in the next open period with a dated reference to the locked
--      one") rather than a refusal and a separate convention nobody enforces.
--   3. **An accrual row with no journal entry, or a journal entry that is not an accrual.** A liability on
--      an HR table and not in the ledger is a figure the trial balance cannot see; a liability in the ledger
--      with no HR row is one nobody can attribute to a person. `ZY173` refuses an accrual whose entry is not
--      a balanced two-line `gratuity_accrual` entry debiting an EXPENSE account and crediting a LIABILITY
--      account for exactly the accrued amount. The account TYPES are checked and the CODES deliberately are
--      not: the codes are resolved from settings against the chart (`Y8-coa` is open and the chart says so
--      on itself), so a code in this file would be the classification decided here. The same shape 0104
--      gave a tip with `ZY146`.
--   4. **Correcting by editing.** `ZY171` refuses every UPDATE and DELETE for every role. A correction is a
--      dated reversal plus a replacement row naming the one it supersedes (`ZY172`), and
--      `employee_gratuity_liability` excludes a superseded row — so the live liability is a SUM over rows
--      nobody has edited, which is what makes the reconciliation in the acceptance list provable.
--   5. **A leaver whose liability does not clear.** `ZY175` refuses a settlement for anything other than
--      EXACTLY the live accrued liability, so "the employee's liability nets to zero fils" is a fact the
--      database enforces rather than one a test hopes for. `ZY176` refuses a settlement for somebody still
--      employed, because a settlement of a liability that is still growing is an under-payment nobody will
--      revisit.
--
-- ## The figures are a versioned ROW and none of them is confirmed
--
-- docs/04 §7's entire statement on this subject is one line: "**End-of-service gratuity** as an accruing
-- balance-sheet liability, accrued monthly." No rate, no band, no cap, no wage basis, no authority. The
-- same section says where the HR figures go instead and why — "The figures are versioned rows rather than
-- prose", `working_hours_rule` (0059) and `leave_entitlement_rule` (0066), each flagged `is_provisional`
-- against a `Y9-` question — so `gratuity_rule` is that shape, flagged against `Y9-gratuity`, and answering
-- the question publishes a NEW version rather than editing anything. Gratuity is asked about the PAST for
-- payroll's reason: a leaver's settlement computed after a rate change must use the rate that applied then.
--
-- **There is deliberately no cap column.** docs/04 names none and the manifest forbids inventing one. It is
-- left OUT rather than nulled because the SHAPE is unknown as well as the number — a cap could be a ceiling
-- on the days earned, on the months that earn, or on the total as a multiple of the wage — so a nullable
-- column would be a place to put a figure the engine would then apply to the wrong quantity. Uncapped is
-- the prudent direction for a liability, and `Y9-gratuity` says so in words. This is 0066's reasoning about
-- carry-over expiry: a policy the code would silently mis-apply is worse as a column than unexpressible.
--
-- ## The gap this migration takes over from P-HR-07, and why it lands here
--
-- `closed_period_labour_adjustment` answers a gap `Y9-attendance` has carried since 0086: attendance for a
-- day in a CLOSED accounting period with NO punch at all cannot be entered, because
-- `attendance_correction.corrects_event_id` is NOT NULL — a correction amends a record and cannot invent
-- one. `Y9-attendance` recorded it as "a ledger-side adjustment rather than a punch" and pointed it at
-- P-HR-12. P-HR-12 re-pointed it here: its `payroll_deduction` only ever REDUCES pay, and unrecorded work
-- needs an UPWARD adjustment, which nothing in the payroll schema expresses. This is the HR migration that
-- posts to the ledger, so it is this one's.
--
-- The AMOUNT is stated by whoever authorises it and is never derived, for `Y9-deductions`' reason stated in
-- the other direction: deriving it means deciding what a day of a monthly salary is worth, which nobody has
-- answered, and a derived figure would be indistinguishable on the ledger from one a manager authorised.
-- It credits `wages payable` rather than reaching into a payroll run, because a completed run is immutable
-- (`ZY141`) and its header figures may only be written by the statement that completes it (`ZY142`) — so an
-- adjustment that had to touch one would be unpostable. The next run discharges the payable instead, with
-- no completed run rewritten.
--
-- ## Private SQLSTATEs
--
-- `ZY171`-`ZY177`, allocated through `packages/db/src/sqlstate-registry.ts` and not by reading the
-- migrations a worktree can see (ADR 0043). `ZY178`-`ZY180` of the band are left free. Seven and not one
-- because each has a different thing to go and do: "correct it with a reversal", "wait for the period to
-- close", "post the journal entry first", "end the employment first", "recompute the liability" and "record
-- a punch correction instead" are six different answers, which is the argument for a private code at all.
--
-- See docs/adr/0057-a-gratuity-liability-is-cumulative-and-a-month-is-its-difference.md,
-- packages/core/src/hr/gratuity.ts and docs/04 §7.

begin;

-- ---------------------------------------------------------------------------------------------
-- gratuity_rule — the provisional figures, versioned
-- ---------------------------------------------------------------------------------------------
-- Mirrors GratuityRules in packages/core/src/hr/gratuity.ts. Every bound below is ALSO asserted by
-- assertGratuityRules() in that module, restated on purpose: this table is seeded here and a later unit
-- will add a version in its own migration, so the CHECK is what makes a hand-written INSERT with a mistyped
-- rate fail instead of land, and the TypeScript is what makes a row that reached a caller another way fail
-- before it prices anybody. packages/fixtures/src/hr-gratuity.itest.ts pushes the same bad row at both.
create table gratuity_rule (
  -- The first date this version governs. The primary key, for 0066's reason: two versions taking effect on
  -- one date is not a policy change but an ambiguity, because the reader takes "the latest row at or before
  -- the date" and that has no answer when two rows tie.
  --
  -- A calendar date and deliberately NOT a trading date, for 0059's reason: a labour rule commences whether
  -- or not the premises trades that day.
  effective_from             date        primary key,

  -- Days of wage earned per year of service, inside the first band and after it. Bounded by the length of a
  -- year: a rate above 366 days of wage per year of service earns more than the wage itself, which is not a
  -- policy anybody has — it is a transposed figure.
  days_per_year_first_band   integer     not null
    constraint gratuity_rule_first_band_plausible
      check (days_per_year_first_band >= 0 and days_per_year_first_band <= 366),
  days_per_year_after_band   integer     not null
    constraint gratuity_rule_after_band_plausible
      check (days_per_year_after_band >= 0 and days_per_year_after_band <= 366),
  -- A version earning nothing in EITHER band accrues zero for every employee for ever. That satisfies any
  -- reconciliation written against it while entitling nobody to anything, which is the shape 0066 refuses
  -- for an all-empty sick-leave tier set.
  constraint gratuity_rule_earns_something
    check (days_per_year_first_band + days_per_year_after_band > 0),

  -- Completed years of service at which the second rate starts to apply.
  band_boundary_years        integer     not null
    constraint gratuity_rule_band_boundary_plausible
      check (band_boundary_years >= 1 and band_boundary_years <= 50),

  -- Calendar days a monthly wage is taken to cover, so a day of wage can be derived from it.
  --
  -- Its own column and NOT read from `labour_cost_rule.monthly_wage_days_divisor` (0081), although version 1
  -- of both carries the same figure. 0081 itself makes exactly this distinction one step along, between its
  -- `paid_minutes_per_day` and `working_hours_rule.ordinary_minutes_per_day`: "Two figures that happen to be
  -- equal." That divisor is a FORECAST's — P-HR-07's NOTE declines to pay anybody with it in so many words —
  -- and this one is the basis of a statutory entitlement. They are flagged against DIFFERENT questions
  -- (Y9-overtime and Y9-gratuity), and one column serving both would clear the Unconfirmed Assumptions panel
  -- for an answer nobody gave.
  daily_wage_days_divisor    smallint    not null
    constraint gratuity_rule_days_divisor_plausible
      check (daily_wage_days_divisor between 1 and 31),

  -- Which wage figure the entitlement is computed on. 'basic' reads employee.basic_wage_fils and 'gross'
  -- reads employee.total_wage_fils, which 0050 generates as basic plus the three allowances.
  wage_basis                 text        not null
    constraint gratuity_rule_wage_basis_known check (wage_basis in ('basic', 'gross')),

  probation_months           integer     not null
    constraint gratuity_rule_probation_plausible
      check (probation_months >= 0 and probation_months <= 60),
  -- Whether accrual RUNS during probation. A probation month counts as SERVICE either way, so the band
  -- boundary arrives on the employment anniversary rather than later; that reading is the prudent one (it
  -- reaches the higher band sooner) and is recorded on Y9-gratuity as unsettled rather than as a second
  -- flag the engine would have to honour two ways.
  accrues_during_probation   boolean     not null,
  -- Whether an approved unpaid-leave day stops earning entitlement. Policy, not arithmetic, so it is a flag
  -- rather than a branch in the engine — and it is proved to change the answer by its own test.
  unpaid_leave_days_excluded boolean     not null,

  -- The provenance trio every provisional row in this database carries, read by the Unconfirmed Assumptions
  -- panel exactly as it reads `app_setting`.
  is_provisional             boolean     not null default true,
  provisional_note           text,
  open_question_id           text,
  constraint gratuity_rule_provisional_names_a_question
    check (not is_provisional or open_question_id is not null),
  -- Where the figures came from. NOT NULL and never a placeholder: a gratuity policy whose provenance is
  -- blank is one somebody will read as agreed, and what it decides is what an employee leaves with.
  source_note                text        not null
    constraint gratuity_rule_source_note_not_placeholder
      check (not is_placeholder_text(source_note)),
  created_at                 timestamptz not null default now()
);

comment on table gratuity_rule is
  'One row per version of the end-of-service gratuity policy. Mirrors GratuityRules in '
  'packages/core/src/hr/gratuity.ts. Versioned rather than held in app_setting because gratuity is asked '
  'about the PAST: a settlement recomputed after a rate change must use the rate that applied then, and '
  'one current value cannot say what it was. No CAP column deliberately — docs/04 names none and the SHAPE '
  'of a cap is as unknown as its number, so answering Y9-gratuity about a cap needs a unit, not a value.';
comment on column gratuity_rule.daily_wage_days_divisor is
  'Calendar days a monthly wage is taken to cover. NOT labour_cost_rule.monthly_wage_days_divisor, which is '
  'a forecast''s divisor flagged against Y9-overtime; this is a statutory entitlement basis flagged against '
  'Y9-gratuity. Two figures that happen to be equal in version 1.';

-- The application role reads this table and never writes it, the way it holds leave_entitlement_rule and
-- working_hours_rule: publishing a policy version is a migration, not a settings screen. No refusal trigger
-- for 0018's reason about `account` — a mistyped rate must be correctable by a migration without somebody
-- having to drop a trigger first, and dropping a trigger to fix a typo is how the trigger ends up dropped.
grant select on gratuity_rule to berelax_app;
revoke insert, update, delete, truncate on gratuity_rule from berelax_app;

-- ---------------------------------------------------------------------------------------------
-- gratuity_accrual — one month's movement, append-only, tied to its journal entry
-- ---------------------------------------------------------------------------------------------
create table gratuity_accrual (
  accrual_id           uuid        primary key default uuid_generate_v7(),
  employee_id          uuid        not null references employee (id) on delete restrict,

  -- The calendar month accrued FOR, always its first day. A date and not a text 'YYYY-MM', so the month is
  -- orderable and comparable against a period lock without parsing; the first-day CHECK is what stops two
  -- spellings of one month both being "not yet accrued", which would defeat the unique index below.
  accrual_month        date        not null
    constraint gratuity_accrual_month_is_first_of_month
      check (accrual_month = date_trunc('month', accrual_month)::date),
  -- The last day of that month: what the liability is measured AT. Derived, but stored, because every
  -- reconciliation joins on it and a query re-deriving it would be a second reading of the same fact.
  accrued_to           date        not null
    constraint gratuity_accrual_accrued_to_is_month_end
      check (accrued_to = (date_trunc('month', accrual_month) + interval '1 month - 1 day')::date),

  -- The wage the figure was computed on, PINNED. 0104's lesson applied one subject along: a payslip pins
  -- every figure it prints (ADR 0054) because recomputing later resolves "the wage in force" and restates
  -- history. A liability read back in three years must show the wage it was struck on.
  wage_fils            fils_nonneg not null,
  wage_basis           text        not null
    constraint gratuity_accrual_wage_basis_known check (wage_basis in ('basic', 'gross')),

  -- The working paper, pinned for the same reason: an employee disputing a figure asks which days counted.
  employed_days        integer     not null
    constraint gratuity_accrual_employed_days_plausible
      check (employed_days >= 0 and employed_days <= 31),
  unpaid_leave_days    integer     not null
    constraint gratuity_accrual_unpaid_days_plausible
      check (unpaid_leave_days >= 0 and unpaid_leave_days <= employed_days),

  -- The WHOLE liability owed at `accrued_to`, and the movement posted this month. Both stored: the
  -- cumulative is what the engine computes and the movement is what the journal holds, and keeping only one
  -- would make the other a re-derivation that could disagree. ADR 0057 is about which of the two is the
  -- primitive.
  cumulative_fils      fils_nonneg not null,
  accrued_fils         fils_nonneg not null
    constraint gratuity_accrual_movement_is_positive check (accrued_fils > 0),

  rule_effective_from  date        not null references gratuity_rule (effective_from),

  -- The journal entry this accrual IS. NOT NULL and UNIQUE: an accrual row with no entry is a liability the
  -- trial balance cannot see, and two accrual rows sharing an entry would each claim the whole of it.
  entry_id             text        not null unique references journal_entry (entry_id),
  -- Where that entry is dated. Equal to `accrued_to` in the ordinary case and LATER when the accrual month
  -- is locked; `assert_gratuity_accrual_period` (ZY174) is what holds the pair to exactly those two shapes.
  entry_date           date        not null,
  -- The locked period the accrual month fell in, when it did. Null means the month was open.
  locked_period_id     text        references period_lock (period_id),

  -- The accrual this one SUPERSEDES. A correction is a dated reversal plus a replacement row (ADR 0017),
  -- never an edit, and `employee_gratuity_liability` excludes any row some correction names — so the live
  -- liability is a sum over rows nobody has edited.
  corrects_accrual_id  uuid        references gratuity_accrual (accrual_id),
  constraint gratuity_accrual_does_not_correct_itself
    check (corrects_accrual_id is distinct from accrual_id),
  -- At most one correction per original, so a chain is A <- B <- C and never A <- B and A <- C, which would
  -- each count in the liability view and double the correction.
  constraint gratuity_accrual_one_correction_per_original unique (corrects_accrual_id),

  created_by           text        not null
    constraint gratuity_accrual_created_by_not_placeholder
      check (not is_placeholder_text(created_by) and btrim(created_by) <> ''),
  created_at           timestamptz not null default now()
  -- No updated_at and no set_updated_at trigger: there is no second version of a row here, and a column
  -- promising one would be a promise this table cannot keep. 0018 says the same of journal_entry.
);

comment on table gratuity_accrual is
  'One month''s movement in one employee''s end-of-service gratuity liability. Append-only: UPDATE and '
  'DELETE raise (ZY171). Tied '
  'to the journal entry that carries it (ZY173). The month''s figure is the DIFFERENCE between the whole '
  'liability owed at the month end and what is already on the books, which is why cumulative_fils is stored '
  'beside accrued_fils — see ADR 0057. A correction is a dated reversal plus a replacement row naming this '
  'one (ZY172).';
comment on column gratuity_accrual.entry_date is
  'Where the journal entry is dated: the month end when the month is open, and a date in the next OPEN '
  'period when the accrual month has been locked (ZY174). ADR 0026 — a closed period cannot be reopened.';
comment on column gratuity_accrual.cumulative_fils is
  'The whole liability owed at accrued_to, on the wage in wage_fils. Stored so a month''s figure can be '
  'read back as a difference without recomputing an engine that may since have changed.';

-- Idempotence, as a property of the schema. One ORIGINAL accrual per employee per month; a correction has
-- corrects_accrual_id set and is therefore outside the index. The job inserts `on conflict do nothing`, so
-- a second pass over the same month inserts no row, posts no journal line, and cannot move the balance.
create unique index gratuity_accrual_one_original_per_month
  on gratuity_accrual (employee_id, accrual_month)
  where corrects_accrual_id is null;

create index gratuity_accrual_employee_month_idx on gratuity_accrual (employee_id, accrual_month);
create index gratuity_accrual_month_idx on gratuity_accrual (accrual_month);
create index gratuity_accrual_entry_idx on gratuity_accrual (entry_id);
create index gratuity_accrual_locked_period_idx on gratuity_accrual (locked_period_id)
  where locked_period_id is not null;

-- ---------------------------------------------------------------------------------------------
-- gratuity_settlement — a leaver's liability discharged to exactly zero
-- ---------------------------------------------------------------------------------------------
create table gratuity_settlement (
  settlement_id   uuid        primary key default uuid_generate_v7(),
  -- One settlement per employee. UNIQUE rather than a count in a trigger: a second settlement would
  -- discharge a liability that is already zero, and ZY175 would refuse it anyway — this refuses it at the
  -- index, which is the layer that survives a concurrent pair.
  employee_id     uuid        not null unique references employee (id) on delete restrict,
  -- The date employment ended, snapshotted. `employee.employed_until` is mutable and the settlement is not,
  -- so a later correction to the employment record must not silently restate what was settled.
  employed_until  date        not null,
  settled_fils    fils_nonneg not null
    constraint gratuity_settlement_is_positive check (settled_fils > 0),
  entry_id        text        not null unique references journal_entry (entry_id),
  entry_date      date        not null,
  created_by      text        not null
    constraint gratuity_settlement_created_by_not_placeholder
      check (not is_placeholder_text(created_by) and btrim(created_by) <> ''),
  created_at      timestamptz not null default now()
);

comment on table gratuity_settlement is
  'A leaver''s accrued gratuity discharged. Append-only: UPDATE and DELETE raise (ZY171). settled_fils '
  'must equal the employee''s '
  'LIVE accrued liability exactly (ZY175), so "the liability nets to zero fils" is enforced rather than '
  'hoped for, and the employment must have ended (ZY176). It credits a PAYABLE and never cash: the money '
  'leaves through the payroll run, which this migration does not touch.';

create index gratuity_settlement_entry_idx on gratuity_settlement (entry_id);

-- ---------------------------------------------------------------------------------------------
-- closed_period_labour_adjustment — P-HR-07's gap, re-pointed here by P-HR-12
-- ---------------------------------------------------------------------------------------------
create table closed_period_labour_adjustment (
  adjustment_id    uuid        primary key default uuid_generate_v7(),
  employee_id      uuid        not null references employee (id) on delete restrict,

  -- The trading date the work was actually done on. Inside the locked period, which
  -- assert_closed_period_labour_adjustment (ZY177) is what enforces.
  worked_on        date        not null,
  -- The locked period the work falls in. NOT NULL: the whole reason this table exists is that the period
  -- has closed, and an adjustment naming no lock is one that should have been a punch correction.
  locked_period_id text        not null references period_lock (period_id),

  -- UPWARD only, which is the gap this table answers: 0104's payroll_deduction only ever reduces pay, and
  -- unrecorded work needs an increase. A reduction for a closed month is a different thing and is not this.
  amount_fils      fils_nonneg not null
    constraint closed_period_labour_adjustment_is_upward check (amount_fils > 0),

  -- Why, in somebody's own words, and NO kind vocabulary — 0104's reasoning for payroll_deduction applied
  -- here: a closed set would read as the list of reasons this business pays outside a timesheet. There is
  -- no punch and no timesheet, so the reason is the ONLY evidence the work happened.
  reason           text        not null
    constraint closed_period_labour_adjustment_reason_is_stated
      check (not is_placeholder_text(reason) and btrim(reason) <> ''),
  -- Who authorised it, and who typed it. Separate columns for 0104's reason: the person who records a
  -- payment and the person who may authorise one are different roles, and one column lets the first stand
  -- in for the second. Sharper here than for a deduction, because this one pays money out against no
  -- record at all.
  authorised_by    text        not null
    constraint closed_period_labour_adjustment_authorised_by_stated
      check (not is_placeholder_text(authorised_by) and btrim(authorised_by) <> ''),
  recorded_by      text        not null
    constraint closed_period_labour_adjustment_recorded_by_stated
      check (not is_placeholder_text(recorded_by) and btrim(recorded_by) <> ''),

  entry_id         text        not null unique references journal_entry (entry_id),
  -- Strictly after the work, and outside every lock (ZY177). An entry dated on or before the work is either
  -- inside the locked period — where it cannot post at all — or evidence that the period was open and a
  -- punch correction was the right answer.
  entry_date       date        not null
    constraint closed_period_labour_adjustment_dated_after_the_work
      check (entry_date > worked_on),
  created_at       timestamptz not null default now()
);

comment on table closed_period_labour_adjustment is
  'Work done on a date in a CLOSED accounting period with no punch ever recorded, paid as a ledger-side '
  'accrual. Append-only: UPDATE and DELETE raise (ZY171). Answers the gap Y9-attendance has carried '
  'since 0086: '
  'attendance_correction.corrects_event_id is NOT NULL, so a correction cannot invent a record. The AMOUNT '
  'is stated by the authoriser and never derived — deriving it means deciding what a day of a monthly '
  'salary is worth, which Y9-deductions records as unanswered, and a derived figure would be '
  'indistinguishable from an authorised one.';
comment on column closed_period_labour_adjustment.locked_period_id is
  'The period_lock containing worked_on. NOT NULL: an adjustment naming no lock is one whose month is still '
  'open, where an audited attendance correction is the right answer and this is not.';

create index closed_period_labour_adjustment_employee_idx
  on closed_period_labour_adjustment (employee_id, worked_on);
create index closed_period_labour_adjustment_period_idx
  on closed_period_labour_adjustment (locked_period_id);

-- ---------------------------------------------------------------------------------------------
-- Append-only enforcement (ZY171)
-- ---------------------------------------------------------------------------------------------
-- Triggers that RAISE rather than rules that silently do nothing, for 0018's reason: code that UPDATEs one
-- of these rows is code that believes it is correcting a liability, and it must be TOLD that it cannot
-- rather than left believing it did.
create function refuse_gratuity_record_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    '% is append-only; % is refused. A gratuity figure is corrected by a dated reversal plus a replacement '
    'row naming the one it supersedes, never by editing it.',
    tg_table_name, tg_op
    using errcode = 'ZY171';
end $$;

comment on function refuse_gratuity_record_change() is
  'Raises ZY171. Fires for EVERY role, including the owner: privileges cover the application role, and a '
  'migration or a psql session does not connect as the application role.';

create trigger gratuity_accrual_no_update before update on gratuity_accrual
  for each row execute function refuse_gratuity_record_change();
create trigger gratuity_accrual_no_delete before delete on gratuity_accrual
  for each row execute function refuse_gratuity_record_change();
create trigger gratuity_settlement_no_update before update on gratuity_settlement
  for each row execute function refuse_gratuity_record_change();
create trigger gratuity_settlement_no_delete before delete on gratuity_settlement
  for each row execute function refuse_gratuity_record_change();
create trigger closed_period_labour_adjustment_no_update
  before update on closed_period_labour_adjustment
  for each row execute function refuse_gratuity_record_change();
create trigger closed_period_labour_adjustment_no_delete
  before delete on closed_period_labour_adjustment
  for each row execute function refuse_gratuity_record_change();

-- ---------------------------------------------------------------------------------------------
-- A correction names a live original over the same employee and month (ZY172)
-- ---------------------------------------------------------------------------------------------
create function assert_gratuity_correction_names_its_original() returns trigger
language plpgsql
as $$
declare
  v_employee uuid;
  v_month    date;
begin
  if new.corrects_accrual_id is null then return new; end if;

  select employee_id, accrual_month into v_employee, v_month
    from gratuity_accrual where accrual_id = new.corrects_accrual_id;

  -- The row is guaranteed to exist by the foreign key, so a NULL here would mean the FK was dropped.
  if v_employee is null then
    raise exception
      'A gratuity correction names accrual % which does not exist.', new.corrects_accrual_id
      using errcode = 'ZY172';
  end if;

  -- Both, and separately. A correction over another EMPLOYEE moves a liability between two people and both
  -- balances then look plausible; a correction over another MONTH leaves the original month uncorrected and
  -- double-counts the other. Neither is visible in a total.
  if v_employee <> new.employee_id or v_month <> new.accrual_month then
    raise exception
      'A gratuity correction for employee % month % may not supersede accrual %, which is employee % '
      'month %. A correction restates ONE month for ONE person; anything else moves a liability between '
      'them and leaves both totals looking plausible.',
      new.employee_id, new.accrual_month, new.corrects_accrual_id, v_employee, v_month
      using errcode = 'ZY172';
  end if;

  return new;
end $$;

comment on function assert_gratuity_correction_names_its_original() is
  'Raises ZY172. A replacement accrual must supersede one over the same employee and the same month.';

create trigger gratuity_accrual_correction_names_its_original
  before insert on gratuity_accrual
  for each row execute function assert_gratuity_correction_names_its_original();

-- ---------------------------------------------------------------------------------------------
-- An accrual IS its journal entry (ZY173)
-- ---------------------------------------------------------------------------------------------
-- The entry and its lines must already be in the transaction when the accrual row is inserted. That
-- ordering is the repository's job and is stated in packages/db/src/repositories/gratuity.ts; here it is
-- enforced, because an accrual row inserted first would pass a check that could see no lines.
create function assert_gratuity_accrual_is_posted() returns trigger
language plpgsql
as $$
declare
  v_source  text;
  v_debits  bigint;
  v_credits bigint;
  v_lines   integer;
begin
  select source into v_source from journal_entry where entry_id = new.entry_id;
  if v_source is distinct from 'gratuity_accrual' then
    raise exception
      'Gratuity accrual for employee % month % names journal entry "%" whose source is "%", not '
      '"gratuity_accrual". The reconciliation that ties the liability account to these rows filters on '
      'the source, so an accrual posted under another source is invisible to it.',
      new.employee_id, new.accrual_month, new.entry_id, coalesce(v_source, '(no such entry)')
      using errcode = 'ZY173';
  end if;

  -- Exactly two lines, the debit on an EXPENSE account and the credit on a LIABILITY account, both for the
  -- accrued amount. The account TYPES are checked and the CODES deliberately are not: the codes are
  -- resolved from settings against a chart that is itself provisional against Y8-coa, so a code here would
  -- be this migration deciding an accountant's classification. The same shape 0104 gave a tip (ZY146).
  select count(*),
         coalesce(sum(l.debit_fils) filter (where a.type = 'expense'), 0),
         coalesce(sum(l.credit_fils) filter (where a.type = 'liability'), 0)
    into v_lines, v_debits, v_credits
    from journal_line l join account a on a.code = l.account_code
   where l.entry_id = new.entry_id;

  if v_lines <> 2 or v_debits <> new.accrued_fils or v_credits <> new.accrued_fils then
    raise exception
      'Gratuity accrual for employee % month % of % fils names entry "%" with % line(s), % fils debited '
      'to expense and % fils credited to liability. An accrual is exactly two lines — expense debit, '
      'liability credit — for exactly the accrued amount; anything else is a liability the trial balance '
      'and this table disagree about.',
      new.employee_id, new.accrual_month, new.accrued_fils, new.entry_id, v_lines, v_debits, v_credits
      using errcode = 'ZY173';
  end if;

  return new;
end $$;

comment on function assert_gratuity_accrual_is_posted() is
  'Raises ZY173. The named entry must be a gratuity_accrual entry of exactly two lines, debiting an '
  'expense account and crediting a liability account for the accrued amount. Types, never codes.';

create trigger gratuity_accrual_is_posted before insert on gratuity_accrual
  for each row execute function assert_gratuity_accrual_is_posted();

-- ---------------------------------------------------------------------------------------------
-- A locked accrual month lands in the next open period and says so (ZY174)
-- ---------------------------------------------------------------------------------------------
create function assert_gratuity_accrual_period() returns trigger
language plpgsql
as $$
declare
  -- period_lock_for() is 0018's one definition of "is this date closed", reused rather than re-queried:
  -- a second query that answered differently is exactly what that function exists to make impossible.
  v_month_lock text := period_lock_for(new.accrued_to);
  v_entry_lock text := period_lock_for(new.entry_date);
begin
  if new.locked_period_id is distinct from v_month_lock then
    raise exception
      'Gratuity accrual for employee % month % names locked period % but the month end % falls in %. '
      'The named lock is what tells an accountant reading the open period that the figure belongs to a '
      'month they have already filed, so a wrong one sends them to the wrong month.',
      new.employee_id, new.accrual_month, coalesce(new.locked_period_id, '(none)'),
      new.accrued_to, coalesce(v_month_lock, '(no locked period)')
      using errcode = 'ZY174';
  end if;

  -- The entry may never be dated inside a lock. 0018's journal_entry_period_lock refuses that at the
  -- entry INSERT with ZL002, so this is the second statement of the rule and it is deliberate: the accrual
  -- row is what a reader of THIS table sees, and a row whose entry_date sat in a lock could only exist if
  -- the entry had been posted before the lock — in which case the row is claiming something untrue now.
  if v_entry_lock is not null then
    raise exception
      'Gratuity accrual for employee % month % carries an entry dated %, which falls in locked '
      'accounting period "%". ADR 0026: a closed period cannot be reopened without a migration, so the '
      'entry belongs in the next OPEN period.',
      new.employee_id, new.accrual_month, new.entry_date, v_entry_lock
      using errcode = 'ZY174';
  end if;

  if v_month_lock is null then
    -- An open month is dated at its own month end. Anything else would make two accruals for one month
    -- indistinguishable in a date-ordered report, which is the report every reconciliation is built on.
    if new.entry_date <> new.accrued_to then
      raise exception
        'Gratuity accrual for employee % month % is dated % and its month end % is in no locked period, '
        'so it must be dated there. A freely-dated accrual for an open month puts the liability in a '
        'period that did not earn it.',
        new.employee_id, new.accrual_month, new.entry_date, new.accrued_to
        using errcode = 'ZY174';
    end if;
  elsif new.entry_date <= new.accrued_to then
    raise exception
      'Gratuity accrual for employee % month % is dated % but its month end % is inside locked period '
      '"%", so the entry must be dated AFTER it, in the next open period.',
      new.employee_id, new.accrual_month, new.entry_date, new.accrued_to, v_month_lock
      using errcode = 'ZY174';
  end if;

  return new;
end $$;

comment on function assert_gratuity_accrual_period() is
  'Raises ZY174. An accrual for an OPEN month is dated at its month end; one for a LOCKED month names '
  'that lock and is dated after it, outside every lock. ADR 0026.';

create trigger gratuity_accrual_period before insert on gratuity_accrual
  for each row execute function assert_gratuity_accrual_period();

-- ---------------------------------------------------------------------------------------------
-- The live liability per employee
-- ---------------------------------------------------------------------------------------------
-- A superseded row is EXCLUDED: any accrual some correction names is history, and the replacement carries
-- the corrected figure. So the live liability is a sum over rows nobody has edited, which is what makes the
-- reconciliation provable at all — see ADR 0057.
create view employee_gratuity_liability as
  select a.employee_id,
         sum(a.accrued_fils)::bigint                    as accrued_fils,
         max(a.accrual_month)                           as latest_accrual_month,
         count(*)::integer                              as accrual_count
    from gratuity_accrual a
   where not exists (
     select 1 from gratuity_accrual c where c.corrects_accrual_id = a.accrual_id
   )
   group by a.employee_id;

comment on view employee_gratuity_liability is
  'One employee''s LIVE accrued gratuity: the sum of accrual rows no correction supersedes. What ZY175 '
  'holds a settlement to, and what the reconciliation compares against the liability account.';

grant select on employee_gratuity_liability to berelax_app;

-- ---------------------------------------------------------------------------------------------
-- A settlement clears the liability exactly (ZY175) and only for a leaver (ZY176)
-- ---------------------------------------------------------------------------------------------
create function assert_gratuity_settlement_clears_the_liability() returns trigger
language plpgsql
as $$
declare
  v_accrued bigint;
begin
  select coalesce(accrued_fils, 0) into v_accrued
    from employee_gratuity_liability where employee_id = new.employee_id;
  v_accrued := coalesce(v_accrued, 0);

  if v_accrued <> new.settled_fils then
    raise exception
      'Gratuity settlement for employee % is % fils and the live accrued liability is % fils. A '
      'settlement discharges the liability EXACTLY, so the balance nets to zero; a settlement for any '
      'other figure leaves a residue on the liability account that nobody will revisit, and which of the '
      'two numbers is wrong is no longer recoverable once it has posted.',
      new.employee_id, new.settled_fils, v_accrued
      using errcode = 'ZY175';
  end if;

  return new;
end $$;

comment on function assert_gratuity_settlement_clears_the_liability() is
  'Raises ZY175. settled_fils must equal the live accrued liability exactly, so "nets to zero fils" is '
  'enforced by the database rather than asserted by a test.';

create function assert_gratuity_settlement_is_for_a_leaver() returns trigger
language plpgsql
as $$
declare
  v_until date;
begin
  select employed_until into v_until from employee where id = new.employee_id;

  if v_until is null then
    raise exception
      'Gratuity settlement for employee % records no end of employment: employee.employed_until is null. '
      'Settling a liability that is still growing is an under-payment nobody will revisit, because the '
      'settlement is the moment anybody looks at the figure.',
      new.employee_id
      using errcode = 'ZY176';
  end if;

  if new.employed_until <> v_until then
    raise exception
      'Gratuity settlement for employee % snapshots employment ending %, and the employee record says %. '
      'The snapshot exists so a later correction to the employment record cannot restate what was '
      'settled, which only works if it starts out equal to it.',
      new.employee_id, new.employed_until, v_until
      using errcode = 'ZY176';
  end if;

  return new;
end $$;

comment on function assert_gratuity_settlement_is_for_a_leaver() is
  'Raises ZY176. A settlement needs employee.employed_until set, and its own snapshot must equal it.';

-- PostgreSQL fires BEFORE triggers on one table in **trigger-name order**, not in creation order, so the
-- names carry the sequence. The first version of this block relied on creation order and carried a comment
-- claiming the leaver check ran first; it did not, because `gratuity_settlement_clears_the_liability` sorts
-- before `gratuity_settlement_is_for_a_leaver`. The integration suite found it by asking for ZY176 and being
-- handed ZY175.
--
-- The order matters because the two refusals send somebody to different places. "The amount does not match
-- the liability" for an employee who has not left sends them to recompute a figure, when the figure is fine
-- and the employment record is what is missing. The more fundamental fact goes first.
create trigger gratuity_settlement_check_1_is_for_a_leaver before insert on gratuity_settlement
  for each row execute function assert_gratuity_settlement_is_for_a_leaver();
create trigger gratuity_settlement_check_2_clears_the_liability before insert on gratuity_settlement
  for each row execute function assert_gratuity_settlement_clears_the_liability();

-- ---------------------------------------------------------------------------------------------
-- A closed-period adjustment names the lock it belongs to (ZY177)
-- ---------------------------------------------------------------------------------------------
create function assert_closed_period_labour_adjustment() returns trigger
language plpgsql
as $$
declare
  v_work_lock  text := period_lock_for(new.worked_on);
  v_entry_lock text := period_lock_for(new.entry_date);
begin
  if v_work_lock is null then
    raise exception
      'A closed-period labour adjustment for employee % names work on %, which falls in no locked '
      'accounting period. While the period is OPEN the answer is an audited attendance correction '
      '(0086), not a ledger adjustment: a correction amends the attendance record and this does not, so '
      'using it here would pay the work and leave the register still saying nobody came in.',
      new.employee_id, new.worked_on
      using errcode = 'ZY177';
  end if;

  if v_work_lock <> new.locked_period_id then
    raise exception
      'A closed-period labour adjustment for employee % names locked period % and the work on % falls in '
      '%. The named period is what an accountant reading the open month follows back, so a wrong one '
      'sends them to a month that owes nothing.',
      new.employee_id, new.locked_period_id, new.worked_on, v_work_lock
      using errcode = 'ZY177';
  end if;

  if v_entry_lock is not null then
    raise exception
      'A closed-period labour adjustment for employee % carries an entry dated %, which falls in locked '
      'accounting period "%". The adjustment exists because a period closed; posting it into another '
      'closed one moves the problem rather than answering it.',
      new.employee_id, new.entry_date, v_entry_lock
      using errcode = 'ZY177';
  end if;

  return new;
end $$;

comment on function assert_closed_period_labour_adjustment() is
  'Raises ZY177. The work must fall inside the named locked period and the entry outside every lock.';

create trigger closed_period_labour_adjustment_periods
  before insert on closed_period_labour_adjustment
  for each row execute function assert_closed_period_labour_adjustment();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 granted the application role select, insert, update and delete on every table in public AND set
-- default privileges to extend that to tables created later, so these tables arrive with UPDATE and DELETE
-- already granted. An append-only table that forgets to revoke them is append-only by convention only,
-- which is the hole ADR 0017 exists to close.
grant select, insert on gratuity_accrual, gratuity_settlement to berelax_app;
grant select, insert on closed_period_labour_adjustment to berelax_app;
revoke update, delete on gratuity_accrual, gratuity_settlement from berelax_app;
revoke update, delete on closed_period_labour_adjustment from berelax_app;
-- TRUNCATE fires no row-level DELETE trigger, so it is the one statement that could empty these past the
-- refusals above. 0009 never granted it; revoking it here says so out loud rather than leaving the reader
-- to work out that the hole is closed.
revoke truncate on gratuity_accrual, gratuity_settlement from berelax_app;
revoke truncate on closed_period_labour_adjustment from berelax_app;

-- ---------------------------------------------------------------------------------------------
-- Version 1 of the policy: every figure provisional against Y9-gratuity
-- ---------------------------------------------------------------------------------------------
-- `1900-01-01`, which is what `working_hours_rule` (0059), `leave_entitlement_rule` (0066),
-- `labour_cost_rule` (0081) and `attendance_grace_rule` (0086) all seed version 1 as, and the convention is
-- load-bearing rather than cosmetic: `gratuityRulesFor` refuses a date no version governs, so a version
-- starting later would make the first run throw for every month before it. A date DERIVED from the roster
-- was the first thing written here and it was wrong twice over — it depends on whether `pnpm seed` has run
-- yet, which is brief rule 12's `opening-balances.itest.ts` trap (a migration that won a race against the
-- seed and left the wrong value in a row every later suite reads), and the roster's own `employed_from` is
-- the epoch placeholder `1970-01-01` (0050's seeder, flagged against Y8-staff), so it would have anchored a
-- statutory policy to a date chosen to be visibly implausible.
insert into gratuity_rule (
  effective_from, days_per_year_first_band, days_per_year_after_band, band_boundary_years,
  daily_wage_days_divisor, wage_basis, probation_months, accrues_during_probation,
  unpaid_leave_days_excluded, is_provisional, provisional_note, open_question_id, source_note
) values (
  date '1900-01-01',
  21, 30, 5,
  30, 'basic', 6, false,
  true,
  true,
  'Every figure is the build''s strictest reading and NONE is confirmed: 21 days'' basic wage per year '
  'for the first 5 years and 30 thereafter, a monthly wage taken to cover 30 calendar days, accrual on '
  'basic wage only, no accrual during a 6-month probation although probation months still count as '
  'service, and approved unpaid-leave days excluded. There is deliberately NO CAP: docs/04 names none and '
  'the SHAPE of one is as unknown as its number. Three further readings are this build''s and are stated '
  'on Y9-gratuity: the wage is the wage as at the accrual month applied to the whole of service, a month '
  'straddling the band boundary earns at the higher rate, and probation months count as service.',
  'Y9-gratuity',
  'docs/04 section 7 states only that end-of-service gratuity is an accruing balance-sheet liability '
  'accrued monthly, and that all labour figures are to confirm with MOHRE or a labour lawyer. No rate, '
  'band, divisor, cap or wage basis appears anywhere in the handover; these are the build''s provisional '
  'reading, chosen in the direction that makes the liability larger.'
);

-- The monthly pass reports to this agent. `assertRegistry` in apps/worker refuses a cron without one, and
-- the interval is what the watchdog measures a dead pass against.
insert into agent_definition (agent_key, display_name, purpose, expected_interval_seconds)
values (
  'gratuity_accrual',
  'Monthly gratuity accrual',
  'Monthly: posts one balanced journal entry per employee for the difference between the end-of-service '
  'gratuity liability owed at the month end and what is already accrued (expense debit, liability '
  'credit). Idempotent per (employee, accrual_month) by a partial unique index, so a second pass posts '
  'nothing. An accrual for a month whose accounting period has since been locked lands in the next open '
  'period naming the locked one (P-HR-13, docs/04 SS7).',
  -- 31 days. A monthly cron, so a dead pass is reported after about two months rather than after two
  -- hours — the same reasoning 0066 records for leave_accrual, and the catch-up sweep is what makes that
  -- acceptable: a month the pass missed has no row and the next run accrues it.
  2678400
);

commit;
