-- 0066 — leave entitlement, and the ledger a leave balance is the sum of.
--
-- P-HR-08's subject is arithmetic: what a month of service earns, which sick-leave band a day of illness
-- falls in, what a leave year carries over. The arithmetic is pure and lives in
-- `packages/core/src/hr/leave-accrual.ts` and `packages/core/src/hr/sick-leave.ts`. This migration
-- supplies the two things that arithmetic may not contain — the FIGURES, and the record of what has
-- already been earned and spent.
--
-- ## What this migration deliberately does NOT do
--
-- **It does not create `leave_request`, and it adds no column to it.** 0030 created it as a `tstzrange`
-- period plus a `leave_kind` and a `leave_status`, with the `employee_approved_leave` view every
-- availability consumer reads. 0030's comment on `leave_request.period` left ONE decision to this unit —
-- whether a leave day is aligned to the trading day or to the calendar day — and that decision is taken
-- in `leaveCoveragePeriod()` in `@berelax/core` rather than in SQL: a leave day covers its TRADING
-- session, so a day of leave on the 17th runs 11:00 on the 17th to 02:00 on the 18th and covers the
-- 01:30 appointment in the tail. Writing and approving that period is P-HR-09's. Putting the rule in SQL
-- as well would be a second reading of where a trading day ends, and `resolveTradingDate` is the one.
--
-- **It does not store a balance.** `leave_balance` is a VIEW over `leave_movement`, and that is the
-- central decision here. A leave balance is the figure in an HR system most often corrected
-- retrospectively — a month re-accrued, a cancelled holiday, an opening figure restated — and a stored
-- column is a second source of truth that disagrees with the movements the first time one of those
-- happens. As a view it cannot: the unit's property, that the sum of the movements always equals the
-- balance, is true by construction rather than by a reconciliation job nobody runs.
--
-- **It creates no `taken` movement kind.** A request RESERVES when it is made and the reservation simply
-- stops being refundable when it is approved, so an approval moves no balance and writes no row. A
-- `taken` row at approval would have to be paired with a reversal of the reservation in the same breath —
-- two rows saying one thing, which is the classic way a ledger comes to disagree with itself. Reserving
-- at request rather than at approval is also the strict reading: two pending requests, each affordable on
-- its own and together over the balance, is the failure a balance-at-approval model permits, and it is
-- discovered when the second one is approved and the balance goes negative.
--
-- **It does not hold the policy in `app_setting`.** Same reason 0059 gives for `working_hours_rule`, one
-- subject along: a setting has ONE current value and leave is asked about the past. Recomputing a
-- disputed month after a policy change must use the policy that applied then, and an `app_setting` row
-- overwritten since cannot say what it was. So the rules are VERSIONED rows keyed on the first date each
-- version governs, the version in force for a date is the latest row at or before it, and
-- `leave_movement.rule_effective_from` records which version produced each figure.
--
-- **It does not record an ABSENT day.** The accrual engine takes unpaid-leave days and ABSENT days as
-- separate arguments, each behind its own flag on the rule row, and both are tested. But an attendance
-- register does not exist in this schema: ABSENT is P-HR-07's variance outcome and P-HR-07 has not
-- landed. The nightly pass therefore supplies unpaid-leave days from `leave_request` and ZERO absent
-- days, which is stated in the job's header and deferred in the manifest rather than filled with a
-- guess. The engine needs no change when the register arrives; the job gains one read.
--
-- ## Why a hundredth of a day, and why it is an integer
--
-- 30 calendar days accrued monthly is 2.5 days a month, which is not a whole number of days. ADR 0007's
-- rule that money is integer fils is about RECONCILIATION rather than about money, and a leave balance
-- reconciles exactly as a ledger does: twelve months of accrual must equal the annual entitlement to the
-- last hundredth. So every quantity here is integer day-hundredths — 250 is 2.5 days, 3000 is 30 days —
-- and `leave_entitlement_rule_annual_total_matches_monthly_accrual` holds the headline entitlement to
-- twelve times the monthly figure, so a version whose contract number disagrees with its ledger number is
-- not a storable row. That disagreement is the one that ships: both figures are plausible and only one of
-- them is paid.
--
-- ## The private SQLSTATE class
--
-- `ZH001` (StaffLeaveMovementImmutable). A private class rather than `restrict_violation`, for 0061's
-- reason: a probe asserting "the ledger refused the UPDATE" must be able to tell THAT rule from the
-- several other restrict violations in this schema, and an operator reading a log needs to know which
-- runbook section they are in. `ZL` is the ledger's (0018) and `ZS` is the staff PII estate's (0050);
-- this is a third subject and takes a third class.

begin;

-- ---------------------------------------------------------------------------------------------
-- The versioned policy
-- ---------------------------------------------------------------------------------------------
create table leave_entitlement_rule (
  -- The first date this version governs. The primary key, because two versions taking effect on one date
  -- is not a policy change but an ambiguity: the reader picks "the latest row at or before the date",
  -- which has no answer when two rows tie.
  --
  -- A calendar date and deliberately NOT a trading date or a foreign key into `business_day`, for 0059's
  -- reason: a labour rule commences whether or not the premises trades that day, and one that could only
  -- commence on a trading day would be unrecordable for any change announced over a closure.
  effective_from                         date        primary key,

  -- The headline annual entitlement, in whole calendar days. A LEAVE day is a calendar day: 30 days of
  -- annual leave consumes 30 days whether or not a weekly rest day falls inside them.
  annual_entitlement_days                integer     not null
    constraint leave_entitlement_rule_annual_entitlement_plausible
      check (annual_entitlement_days > 0 and annual_entitlement_days <= 366),
  -- Day-hundredths earned by a whole month of service. 250 is 2.5 days.
  monthly_accrual_hundredths             integer     not null
    constraint leave_entitlement_rule_monthly_accrual_plausible
      check (monthly_accrual_hundredths >= 0 and monthly_accrual_hundredths <= 36600),
  -- The two figures above are the same entitlement stated twice, so they must agree exactly. Without
  -- this, one number goes on the contract and a different one into the ledger, both look reasonable, and
  -- the discrepancy is found a year later by an employee counting their own days.
  constraint leave_entitlement_rule_annual_total_matches_monthly_accrual
    check (annual_entitlement_days * 100 = monthly_accrual_hundredths * 12),

  probation_months                       integer     not null
    constraint leave_entitlement_rule_probation_plausible
      check (probation_months >= 0 and probation_months <= 60),
  -- Whether accrual RUNS during probation. Separate from whether leave may be TAKEN during it, which is
  -- not a column at all: taking is refused for every date before the probation end, by
  -- mayTakeAnnualLeaveOn() in @berelax/core. One flag for both would make the probationary period cost
  -- the employee entitlement they are earning, and nothing records what was refused.
  accrues_during_probation               boolean     not null,

  -- The most that may cross a leave-year boundary. Anything above it is forfeited at the boundary.
  carry_over_cap_hundredths              integer     not null
    constraint leave_entitlement_rule_carry_over_cap_plausible
      check (carry_over_cap_hundredths >= 0 and carry_over_cap_hundredths <= 36600),
  -- Whether carried days lapse at the end of the leave year they were carried into.
  --
  -- A BOOLEAN and not a month count, deliberately. A count would let this table state a figure — "expires
  -- after seven months" — that the engine has no per-day FIFO ledger to honour, and a policy the code
  -- silently rounds is worse than one it cannot express. Answering Y9-leave-detail with anything other
  -- than "at the next leave-year end" or "never" therefore needs a unit, not a value.
  carry_over_expires_after_one_leave_year boolean    not null,
  -- Whether the leave year runs from the employment anniversary rather than from 1 January. The
  -- anniversary is derived from `employee.employed_from`, a column the database holds; any other fixed
  -- anchor would be a date invented by the build (brief rule 15), so nothing else is expressible.
  leave_year_starts_on_anniversary       boolean     not null,

  -- Which non-working days stop earning accrual. Policy, not arithmetic, so each is a flag rather than a
  -- branch in the engine — and each is proved to change the answer by its own test.
  unpaid_leave_reduces_accrual           boolean     not null,
  absent_day_reduces_accrual             boolean     not null,

  -- The sick-leave bands, in whole days, counted from day 1 of one illness. 15 / 30 / 45 means day 15 is
  -- the last full-pay day, day 16 the first half-pay day, day 45 the last, day 46 the first unpaid day
  -- and day 91 the first with no entitlement at all. `unpaid` and `exhausted` are the same money and
  -- different facts: one is authorised sick leave, the other is the end of the entitlement.
  sick_full_pay_days                     integer     not null
    constraint leave_entitlement_rule_sick_full_plausible
      check (sick_full_pay_days >= 0 and sick_full_pay_days <= 366),
  sick_half_pay_days                     integer     not null
    constraint leave_entitlement_rule_sick_half_plausible
      check (sick_half_pay_days >= 0 and sick_half_pay_days <= 366),
  sick_unpaid_days                       integer     not null
    constraint leave_entitlement_rule_sick_unpaid_plausible
      check (sick_unpaid_days >= 0 and sick_unpaid_days <= 366),
  -- A tier set with nothing in any band is not a tier set: every day of every illness would answer
  -- `exhausted`, which satisfies any boundary test written against it while entitling nobody to anything.
  constraint leave_entitlement_rule_sick_tiers_are_not_all_empty
    check (sick_full_pay_days + sick_half_pay_days + sick_unpaid_days > 0),

  -- The provenance trio every provisional row in this database carries, read by the Unconfirmed
  -- Assumptions panel exactly as it reads `app_setting`.
  is_provisional                         boolean     not null default true,
  provisional_note                       text,
  open_question_id                       text,
  constraint leave_entitlement_rule_provisional_names_a_question
    check (not is_provisional or open_question_id is not null),
  -- Where the figures came from. NOT NULL and never a placeholder: a leave policy whose provenance is
  -- blank is one somebody will read as agreed.
  source_note                            text        not null
    constraint leave_entitlement_rule_source_note_not_placeholder
      check (not is_placeholder_text(source_note)),
  created_at                             timestamptz not null default now()
);

comment on table leave_entitlement_rule is
  'Versioned leave policy: the annual entitlement, the monthly accrual, the probation length, the '
  'carry-over cap and its expiry, the leave-year anchor, which absences stop accrual, and the three '
  'sick-leave bands. The version in force for a date is the row with the greatest effective_from at or '
  'before it, selected by leaveRulesFor() in @berelax/core. Versioned rather than held in app_setting '
  'because leave is asked about the PAST: recomputing a disputed month after a policy change must use '
  'the policy that applied then, and one current value cannot say what it was.';
comment on column leave_entitlement_rule.effective_from is
  'The first date this version governs. No foreign key to business_day: a labour rule commences on a '
  'calendar date whether or not the premises trades that day.';
comment on column leave_entitlement_rule.monthly_accrual_hundredths is
  'Day-hundredths earned by a whole month of service; 250 is 2.5 days. Integer for ADR 0007''s reason '
  'applied to entitlement rather than money: twelve months must equal the annual figure exactly.';
comment on column leave_entitlement_rule.accrues_during_probation is
  'Whether accrual runs during probation. Whether leave may be TAKEN during it is not a column: taking '
  'is refused for every date before the probation end, by mayTakeAnnualLeaveOn() in @berelax/core.';
comment on column leave_entitlement_rule.carry_over_expires_after_one_leave_year is
  'Whether carried days lapse at the end of the leave year they were carried into. A boolean rather '
  'than a month count, because a count could state an expiry the engine has no per-day ledger to '
  'honour, and a policy the code silently rounds is worse than one it cannot express.';
comment on column leave_entitlement_rule.sick_full_pay_days is
  'Days of one illness paid in full, counted from day 1. With 15 here, day 15 is full pay and day 16 is '
  'the first half-pay day — the boundary an off-by-one moves silently.';

-- ---------------------------------------------------------------------------------------------
-- The movement ledger
-- ---------------------------------------------------------------------------------------------
-- Five kinds, and the SIGN is fixed per kind: opening_balance, accrual and released add; reserved and
-- carry_over_forfeited take away. That is what makes the balance the plain sum of one column, and
-- therefore what makes `leave_balance` expressible as a view rather than as a stored figure.
--
-- There is deliberately no `taken`: see the header. An approval moves no balance and writes no row.
create type leave_movement_kind as enum (
  'opening_balance',
  'accrual',
  'carry_over_forfeited',
  'reserved',
  'released'
);

comment on type leave_movement_kind is
  'Why a leave balance moved. opening_balance, accrual and released are positive; reserved and '
  'carry_over_forfeited are negative, held by leave_movement_sign_matches_kind. There is no ''taken'': a '
  'request reserves when it is made and approval only makes the reservation final, so an approval writes '
  'no row. A taken row would have to be paired with a reversal of the reservation, which is two rows '
  'saying one thing.';

create table leave_movement (
  id                 uuid                not null default uuid_generate_v7(),
  -- RESTRICT, for 0030's reason: somebody who has accrued leave has a history, and deleting the person
  -- to clear the balance is the delete this refuses. Ending employment is `employee.employed_until`.
  employee_id        uuid                not null references employee (id) on delete restrict,
  kind               leave_movement_kind not null,
  -- Signed day-hundredths. The balance is the SUM of this column and nothing else.
  hundredths         integer             not null,
  -- The date the movement is dated on: the last day of the accrual month, the leave-year boundary, the
  -- day the request was made. A date and not an instant, because a leave movement is a fact about a day
  -- and never about a moment inside one — unlike `shift.period`, which is instants for exactly the
  -- opposite reason.
  occurred_on        date                not null,
  -- The first date of the leave year this movement belongs to, computed once by leaveYearStart() in
  -- @berelax/core. Stored rather than derived in SQL because the anchor is a POLICY (the employment
  -- anniversary, or 1 January) and re-deriving it here would be a second reading of that policy which
  -- disagrees with the first for every employee not engaged on 1 January.
  leave_year_start   date                not null,

  -- Set on `accrual` and on nothing else. With employee_id it is the idempotency key the nightly pass
  -- depends on, enforced by leave_movement_one_accrual_per_month below.
  accrual_month      date,
  -- Set on `reserved` and `released` and on nothing else. No ON DELETE action is needed: 0030 revokes
  -- DELETE on leave_request from the application role, because leave is cancelled and never deleted.
  leave_request_id   uuid                references leave_request (id),
  -- Which policy version produced the figure, so a recomputed month can be compared with the one that
  -- was written. The AMOUNT is snapshotted on this row, so editing a rule version cannot change a
  -- balance already earned — only the explanation of how it was reached.
  rule_effective_from date               references leave_entitlement_rule (effective_from),

  -- Who or what wrote it. A label, not a uuid: the audit_event row written in the same transaction
  -- carries the full actor and request context (F06).
  created_by         text                not null
    constraint leave_movement_created_by_not_placeholder
      check (not is_placeholder_text(created_by)),
  -- Where an imported figure came from. NOT NULL for an opening balance and null otherwise, held by
  -- leave_movement_opening_balance_has_provenance.
  source_note        text,
  is_provisional     boolean             not null default false,
  provisional_note   text,
  open_question_id   text,
  created_at         timestamptz         not null default now(),

  constraint leave_movement_pkey primary key (id),

  -- The sign is the kind's, always. A positive `reserved` row would credit leave the employee asked to
  -- spend, and the balance would still be the sum of the column, so nothing else in the schema could
  -- notice.
  constraint leave_movement_sign_matches_kind check (
    case kind
      when 'carry_over_forfeited' then hundredths <= 0
      when 'reserved'             then hundredths <= 0
      else hundredths >= 0
    end
  ),
  -- Both directions, as one named constraint: an accrual with no month is as wrong as a forfeiture with
  -- one, and a single biconditional catches both.
  constraint leave_movement_accrual_month_matches_kind
    check ((kind = 'accrual') = (accrual_month is not null)),
  -- The first of the month. `date_trunc` would answer the same question in a second place; the day of
  -- the month is the whole of the claim.
  constraint leave_movement_accrual_month_is_a_first
    check (accrual_month is null or extract(day from accrual_month) = 1),
  constraint leave_movement_request_matches_kind
    check ((kind in ('reserved', 'released')) = (leave_request_id is not null)),
  -- Accrual and forfeiture are derived from a policy version, so each must name the one it used. A
  -- reservation is not: it is the number of calendar days somebody asked for.
  constraint leave_movement_rule_matches_kind
    check ((kind in ('accrual', 'carry_over_forfeited')) = (rule_effective_from is not null)),
  constraint leave_movement_opening_balance_has_provenance check (
    (kind = 'opening_balance') = (source_note is not null)
    and (source_note is null or not is_placeholder_text(source_note))
  ),
  constraint leave_movement_provisional_names_a_question
    check (not is_provisional or open_question_id is not null)
);

comment on table leave_movement is
  'Every movement of every leave balance, signed, in day-hundredths. Append-only: UPDATE and '
  'DELETE raise ZH001 for every role, because a balance that could be edited is one nobody can '
  'reconcile; a correction is a further movement. The balance is the SUM of this table and has no other '
  'home: leave_balance is a view over it, which is what makes "the sum of the movements equals the '
  'balance" true by construction instead of by a reconciliation job.';
comment on column leave_movement.hundredths is
  'Signed day-hundredths: 250 is 2.5 days. Positive for opening_balance, accrual and released; negative '
  'for reserved and carry_over_forfeited.';
comment on column leave_movement.occurred_on is
  'The date the movement is dated on. A date and not an instant: a leave movement is a fact about a day, '
  'never about a moment inside one.';
comment on column leave_movement.leave_year_start is
  'The first date of the leave year this movement belongs to, computed by leaveYearStart() in '
  '@berelax/core. Stored rather than re-derived in SQL, because the anchor is a policy and a second '
  'reading of it disagrees for every employee not engaged on 1 January.';
comment on column leave_movement.accrual_month is
  'The first day of the month accrued for. With employee_id it is the accrual job''s idempotency key, '
  'enforced by leave_movement_one_accrual_per_month.';
comment on column leave_movement.rule_effective_from is
  'The policy version that produced the figure. The amount itself is snapshotted on this row, so '
  'editing a version cannot change a balance already earned — only the explanation of it.';

-- ACCEPTANCE: the accrual job is idempotent per (employee, accrual_month). This index IS that
-- guarantee, and the job inserts `on conflict do nothing`, so a second pass over the same month inserts
-- nothing, returns nothing, writes no second audit row and publishes no second event. Nothing is
-- remembered in the job: 0031 records what that costs — a pass holding "already accrued" in its own
-- state accrues twice the first time that state is lost.
create unique index leave_movement_one_accrual_per_month
  on leave_movement (employee_id, accrual_month) where kind = 'accrual';

-- And one imported opening balance per employee. A second import would ADD to the first rather than
-- replace it, so the balance would be the sum of two statements of the same fact — and both would look
-- like figures somebody had checked.
create unique index leave_movement_one_opening_balance
  on leave_movement (employee_id) where kind = 'opening_balance';

create index leave_movement_employee_idx on leave_movement (employee_id, occurred_on);
create index leave_movement_request_idx
  on leave_movement (leave_request_id) where leave_request_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------------------------
-- A trigger that RAISES rather than `create rule ... do instead nothing`: a rule reports success, and
-- code that UPDATEs a movement would believe it had corrected a balance. Same shape and same reasoning
-- as refuse_recurring_cost_history_change() in 0031 and the journal's in 0018.
--
-- Fires for EVERY role including the owner. The revokes below cover the application role; a migration, a
-- psql session and a future admin tool connect as the owner, and the owner is who rewrites history by
-- hand at 2am.
create function refuse_leave_movement_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'leave_movement is append-only; % is refused. A leave balance is the sum of its movements, so a '
    'correction is a further movement and never an edit: an edited row leaves the balance right and the '
    'reason for it unexplainable.',
    tg_op
    using errcode = 'ZH001';
end $$;

comment on function refuse_leave_movement_change() is
  'Raises ZH001 (StaffLeaveMovementImmutable) for leave_movement, for every role including the owner. '
  'The POLICY stays editable until a movement references it; what has been earned or spent does not.';

create trigger leave_movement_no_update before update on leave_movement
  for each row execute function refuse_leave_movement_change();
create trigger leave_movement_no_delete before delete on leave_movement
  for each row execute function refuse_leave_movement_change();

-- ---------------------------------------------------------------------------------------------
-- leave_balance — the view, which is the only balance there is
-- ---------------------------------------------------------------------------------------------
-- Grouped per employee. The per-leave-year figures a screen wants are the same sum with
-- `leave_year_start` in the group, and that grouping is left to the query that needs it rather than
-- frozen into a second view: a balance is a running figure and a leave year is a window on it, and a view
-- per window is how "which balance do I read" becomes a question.
--
-- Every `filter` total is reported as a POSITIVE number, with the sign flipped for the two negative
-- kinds, because that is how a person reads them: "12 days taken", not "minus 12 days taken". The
-- signed column stays the only thing `balance_hundredths` sums, so the presentation cannot drift from
-- the arithmetic.
create view leave_balance as
  select employee_id,
         sum(hundredths)::integer                                                as balance_hundredths,
         coalesce(sum(hundredths) filter (where kind = 'opening_balance'), 0)::integer
           as opening_hundredths,
         coalesce(sum(hundredths) filter (where kind = 'accrual'), 0)::integer   as accrued_hundredths,
         coalesce(-sum(hundredths) filter (where kind = 'reserved'), 0)::integer as reserved_hundredths,
         coalesce(sum(hundredths) filter (where kind = 'released'), 0)::integer  as released_hundredths,
         coalesce(-sum(hundredths) filter (where kind = 'carry_over_forfeited'), 0)::integer
           as forfeited_hundredths,
         count(*)::integer                                                       as movement_count,
         max(occurred_on)                                                        as last_movement_on,
         max(accrual_month) filter (where kind = 'accrual')                      as last_accrual_month
    from leave_movement
   group by employee_id;

comment on view leave_balance is
  'One row per employee who has any leave movement: the balance as the sum of leave_movement.hundredths, '
  'plus the same rows tallied by kind. The ONLY balance in this schema — there is no stored column, '
  'because a leave balance is corrected retrospectively more often than any other figure here and a '
  'stored one disagrees with the movements the first time that happens.';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 grants the application role select/insert/update/delete on every table created in `public`
-- afterwards, so these revokes are load-bearing rather than decorative — and stated explicitly because a
-- managed database restored from a dump does not necessarily carry the same defaults.
--
-- The triggers above already refuse UPDATE and DELETE for every role. These revokes are the second
-- layer, and they are the one that gives a caller a privilege error rather than a raised exception, which
-- is the difference between "you may not" and "you tried and it failed".
revoke update, delete, truncate on leave_movement from berelax_app;

-- A policy VERSION is published by a migration, not by the application. There is no admin screen that
-- writes one and there should not be: answering Y9-leave-detail means publishing a new version with its
-- own provenance, and an UPDATE in place would change the figures a movement already cites.
revoke insert, update, delete, truncate on leave_entitlement_rule from berelax_app;

-- ---------------------------------------------------------------------------------------------
-- The agent the monthly accrual pass reports to
-- ---------------------------------------------------------------------------------------------
-- `assertRegistry` refuses a cron job that names no `agent_definition` (G-AGT-01), and
-- `agent-watchdog.itest.ts` asserts the named row exists. A cron with no agent row has no declared
-- interval and no budget, so nothing is watching it and nothing is capping it.
--
-- The interval is 31 days, and the watchdog alerts at twice a declared interval — so a dead monthly pass
-- is reported after about two months rather than after two hours. That is inherent in a monthly job and
-- is stated here rather than disguised by declaring a shorter interval than the job runs at, which would
-- alert every month on a pass that is working. What makes the delay survivable is that the pass is a
-- CATCH-UP sweep: it accrues every complete month with no row yet, bounded by its own window, so a
-- missed month is repaired by the next run rather than lost.
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('leave_accrual', 'Monthly leave accrual',
   'Monthly: accrues annual leave for every complete month that has no accrual row yet, from the '
   'employment date or the catch-up window, reduced by approved unpaid leave. Idempotent per '
   '(employee, accrual_month) by a partial unique index, so a second pass writes nothing '
   '(P-HR-08, docs/04 SS7).',
   31 * 24 * 60 * 60, 0)
on conflict (agent_key) do nothing;

-- `agentsWithHeartbeat` INNER joins definition to heartbeat, so an agent with no heartbeat row never
-- appears in the watchdog's list at all — which is worse than unwatched, because the
-- registry-completeness check would report it present (0033's note).
insert into agent_heartbeat (agent_key) values ('leave_accrual')
on conflict (agent_key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Version 1 — the build's provisional answer to Y9-leave-detail, and every figure in it is a guess
-- ---------------------------------------------------------------------------------------------
-- docs/OPEN-QUESTIONS.md A2 carries Y9-leave-detail, and docs/04 §7 carries the whole section's standing
-- caveat: "all figures to confirm with MOHRE or a labour lawyer". The strictest reading the build can
-- defend is taken, on the same principle 0059 states — the strict answer is the one that fails loudly if
-- it is wrong.
--
-- `effective_from` is 1900-01-01, and that is a sentinel rather than a date. Every other candidate is a
-- claim: the commencement date of Federal Decree-Law 33 of 2021 would say these figures are the law's,
-- and the business's first trading date would say somebody agreed them then. A date visibly before any
-- employment this business could have had says what is true — the provisional policy governs every date
-- the system knows about, and no version before it exists.
--
-- ## The one figure where the two recorded provisional answers DISAGREE
--
-- `carry_over_expires_after_one_leave_year` is FALSE — carried days do not lapse. The two recorded
-- positions conflict: Y9-leave-detail's answer says "30-day carry-over cap expiring after 12 months",
-- and P-HR-08's own manifest entry says "carry-over capped at 30 days and not expiring". The conflict is
-- resolved towards NOT expiring, and the reason is the direction of the error rather than a preference.
-- If leave does not in fact expire and the engine expires it, days vanish from a balance nobody
-- re-reads and the entitlement is gone; if leave does expire and the engine keeps it, the balance is too
-- high and shows on a report anybody can read. Of two errors, take the visible one that does not take
-- something away. The opposite policy is a one-row change and no code change — the engine implements
-- both and both are tested — so answering the question publishes a new version.
--
-- `leave_year_starts_on_anniversary` is TRUE, because the anniversary is derived from
-- `employee.employed_from`, which is a fact the database holds. A fixed calendar anchor would be a date
-- this build chose, which brief rule 15 refuses.
--
-- The two accrual-reduction flags are both TRUE, which is the strict reading: a day nobody was paid for
-- and nobody worked is not a day of service. Both are flags rather than branches so that answering the
-- question the other way is also a one-row change.
insert into leave_entitlement_rule (
  effective_from,
  annual_entitlement_days, monthly_accrual_hundredths,
  probation_months, accrues_during_probation,
  carry_over_cap_hundredths, carry_over_expires_after_one_leave_year,
  leave_year_starts_on_anniversary,
  unpaid_leave_reduces_accrual, absent_day_reduces_accrual,
  sick_full_pay_days, sick_half_pay_days, sick_unpaid_days,
  is_provisional, open_question_id, provisional_note, source_note
) values (
  date '1900-01-01',
  30, 250,
  6, true,
  3000, false,
  true,
  true, true,
  15, 30, 45,
  true, 'Y9-leave-detail',
  'Every figure is the build''s strictest reading of Federal Decree-Law 33 of 2021 and none is '
    || 'confirmed: 30 calendar days a year accrued at 2.5 a month from day one, 6 months'' probation '
    || 'during which leave accrues but may not be taken, a 30-day carry-over cap, sick leave of 15 full '
    || '/ 30 half / 45 unpaid days per illness, and unpaid or absent days not earning accrual. Two '
    || 'figures have no number in the handover at all. Carry-over EXPIRY is the one where the two '
    || 'recorded provisional answers conflict - Y9-leave-detail says carried days expire after 12 '
    || 'months and this unit''s manifest entry says they do not - and it is seeded as NOT expiring, '
    || 'because expiring entitlement that should not expire removes days invisibly while keeping days '
    || 'that should have lapsed only makes a balance too high. The LEAVE YEAR anchor is the employment '
    || 'anniversary, derived from employed_from rather than chosen, because any fixed calendar anchor '
    || 'would be a date the build invented.',
  'docs/OPEN-QUESTIONS.md Y9-leave-detail and docs/04 §7 - provisional, strictest reading, no figure '
    || 'confirmed by the owner'
);

commit;
