-- 0086 — attendance, the timesheet approval that locks a period, and the dated correction that is the only
-- way to change what a locked period says.
--
-- P-HR-07's subject is EVIDENCE. A punch is a claim about what somebody did on a day, and the thing that
-- makes it worth keeping is that it cannot be rewritten afterwards: payroll pays attendance, so a table
-- whose rows can be edited is a table where a paid hour can be made to have never happened. Every table
-- here is therefore append-only, and a correction is a NEW dated row rather than an edit — the journal rule
-- (0018) applied to hours instead of to money, and the acceptance criterion says so in those words.
--
-- The arithmetic and every judgement live in `packages/core/src/hr/attendance.ts`, which is pure. This
-- migration supplies the two things a pure function may not contain: the FIGURES a variance is judged
-- against, and the record of what was punched, corrected and approved.
--
-- ## Why the grace windows are VERSIONED rows and not `app_setting`
--
-- This is 0059's decision for the overtime rates, 0066's for the leave entitlement and 0081's for the
-- coverage thresholds, taken a fourth time — and it is SHARPEST here, because this is the unit that is asked
-- about the past most often. "Was she late on the 4th of March?" is not a question about policy; it is a
-- question about a day that has already been approved and already been paid. An `app_setting` row holds ONE
-- current value: widen the grace window from five minutes to ten in April and every March lateness
-- retroactively disappears, with nothing in the database able to say what the window was when the timesheet
-- was approved. `app_setting_history` could reconstruct it, and a history read as a rule table is a rule
-- table nobody meant to build (0059's words, still true).
--
-- `timesheet_approval` therefore snapshots `grace_rule_effective_from` and
-- `working_hours_rule_effective_from`. The row does not record "this attendance was on time" — a claim that
-- decays — but "this attendance was on time against THESE windows, priced at THESE rates", which stays true.
--
-- ## Which references pin their parent, and which are plain columns
--
-- Every table here is append-only, so the rule 0081 wrote down applies to all of them: **an immutable row
-- holds nothing else hostage.** Both referential actions fail against a parent anybody legitimately deletes,
-- and for the same underlying reason — `ON DELETE SET NULL` arrives as an UPDATE, which these tables refuse
-- for every role, and `ON DELETE RESTRICT` pins the parent for ever, because nothing here can be deleted to
-- release it. P-HR-06 found both halves through OTHER units' suites: eleven cases in
-- `business-days.itest.ts` and one of P-HR-05's.
--
-- So, reference by reference:
--
--   * **`employee_id` IS a key, on all three tables.** 0030 already decided that deleting a person to erase
--     their roster is the delete worth refusing, and attendance is the stronger case: these rows are the
--     evidence of what somebody worked, which is the input to what they are paid. Ending employment is
--     `employed_until`, and it always was.
--   * **`trading_date` is a PLAIN COLUMN, on all three tables.** This is the one that looks like it should be
--     a key and must not be. `business_day` is GENERATED: `generateBusinessDays` deletes a row when a date
--     stops trading and rewrites it when the hours change, and `packages/fixtures/src/business-days.itest.ts`
--     empties the whole table in a `beforeEach` to prove it. An append-only attendance row can never be
--     deleted, so a RESTRICT reference from one pins every date it names FOR EVER, for every caller, from the
--     first punch recorded.
--
--     0076 does hold this key — `cash_session.trading_date` restricts `business_day`, because a counted
--     drawer is evidence about a day and a day you took money on is not a day anybody may un-trade — and the
--     difference is not the meaning but the mechanism. A `cash_session` row CAN be deleted (0076 revokes
--     DELETE from `berelax_app` and the owner keeps it), so the pin can be released and its own suite
--     releases it. Nothing in this file can be deleted by anybody, so the same key would not mean "you may
--     not un-trade this day"; it would mean "this date can never be removed for any reason, including one
--     generated in error". The guard therefore lives where the row is still fixable, at INSERT:
--     `assert_attendance_trading_date` refuses a punch whose date disagrees with
--     `attendance_trading_date_for()`, and refuses one on a date `business_day` does not hold at all.
--   * **`rota_version_id` IS a key, on `timesheet_approval`.** This is what P-HR-06 deferred here, in its own
--     words: the immutable `rota_version` exists to be compared against. The reference is evidence — "these
--     payable minutes were measured against THIS published rota" — and the pin costs nothing, because
--     `rota_version` can never be deleted either (ZW001). A plain column would say which version judged it
--     and leave a caller free to approve a timesheet against a version that was never published.
--   * **`corrects_event_id` IS a key, on `attendance_correction`.** Both ends are append-only, so the pin is
--     on a row nothing could delete anyway. 0081 kept its self-references for exactly this reason.
--   * **The two rule `effective_from` dates on `timesheet_approval` are PLAIN COLUMNS**, which is 0081's
--     decision verbatim: what a reader wants from them is which standard applied, not a guarantee that the
--     standard's row is still on disk — and `hr-working-hours.itest.ts` empties `working_hours_rule` inside a
--     rolled-back probe to prove P-HR-05's reader throws rather than inventing rates.
--
-- Consequence worth knowing for every later unit, stated as P-HR-06 stated its own: `hr-attendance.itest.ts`
-- leaves `attendance_event`, `attendance_correction` and `timesheet_approval` rows behind that CANNOT be
-- deleted, by design. Any table those rows reference must tolerate that for ever, which is why only
-- `employee` and `rota_version` are referenced — two tables that already tolerate it.
--
-- ## The period lock has ONE reader, and this file does not add a second
--
-- "Is this date inside a closed accounting period?" is `period_lock_for()` (0018) in the database and
-- `periodStatusOn()` (M-VAT-06) in TypeScript, over that function and `earliest_open_date_from()` (0073).
-- Nothing here re-answers it. `raise_if_period_locked()` is CALLED by the two guards below, which is the same
-- choke point every posting path reaches, so a punch cannot be refused by one rule and permitted by another —
-- and because 0073 redefined that function to name the earliest OPEN date as well as the locked period, the
-- refusal a person reads sends them to a month they can actually use rather than only telling them which one
-- they cannot.
--
-- There are TWO locks in play and they are different facts, which is why the second one is a trigger of this
-- file's own rather than a second reading of the first:
--
--   1. The **accounting period lock** — `period_lock`, about the ledger, about everybody. A punch or a
--      correction dated inside one is refused with ZL002, by the function above.
--   2. The **approved timesheet** — about one employee and one period. After approval, a new punch for that
--      period is refused with ZX004, and the remedy is different: not "post it in the next open month" but
--      "file a dated correction", because the hours themselves have been agreed. The message names the
--      approval and the correction path.
--
-- ## Private SQLSTATEs
--
--   ZX001  attendance_event / attendance_correction / timesheet_approval is append-only; UPDATE or DELETE
--          refused
--   ZX002  a clock-in while one is open, or a clock-out with none open
--   ZX003  the punch's trading_date is not the one attendance_trading_date_for() derives, or names a date
--          business_day does not hold
--   ZX004  the period is closed by an approved timesheet; a new attendance row is refused
--   ZX005  a timesheet approval does not follow: the period is not inside the rota version's period, or the
--          rota version is superseded
--
-- Class `ZX` because every letter from `ZB` to `ZW` is taken and what a private code has to be is unique to
-- one file rather than memorable — 0077's reasoning, which 0081 quoted verbatim.
--
-- See docs/OPEN-QUESTIONS.md Y9-attendance, Y9-overtime and Y9-coverage, and packages/core/src/hr/.

begin;

-- ---------------------------------------------------------------------------------------------
-- attendance_grace_rule — the versioned variance figures (Y9-attendance)
-- ---------------------------------------------------------------------------------------------
create table attendance_grace_rule (
  -- The first TRADING date this version governs, and the primary key for 0059's reason: two versions taking
  -- effect on one date is not a change of policy, it is an ambiguity, and the reader picks "the latest row at
  -- or before the trading date", which has no answer when two rows tie.
  --
  -- No foreign key into `business_day`: a rule commences on a calendar date whether or not the premises
  -- trades that day, and a grace window that could only commence on a trading day would be unrecordable for
  -- any change agreed over a closure. 0081 gives the same reason for the same shape.
  effective_from                     date     primary key,

  -- Minutes AFTER the rostered start a clock-in may be and still be on time. The manifest's provisional line
  -- says five minutes each side and nothing confirms it.
  grace_minutes_after_start          smallint not null
    constraint attendance_grace_rule_start_grace_plausible
      check (grace_minutes_after_start between 0 and 120),

  -- Minutes BEFORE the rostered end a clock-out may be and still be on time. A separate column from the
  -- arrival grace although version 1 carries the same 5, because they answer different questions: how long a
  -- client may be kept waiting, against how early the floor may be left. A single column would mean
  -- confirming one figure also restated the other.
  grace_minutes_before_end           smallint not null
    constraint attendance_grace_rule_end_grace_plausible
      check (grace_minutes_before_end between 0 and 120),

  -- The span above which a clock-in and a clock-out are not believed to be one presence.
  --
  -- This is the acceptance criterion "a test asserts it never yields an implausible >12h shift" as a FIGURE
  -- rather than as a literal in a test. A therapist who forgot to clock out on Friday and clocked out on
  -- Saturday morning produces a pair spanning eighteen hours; of the two available errors, paying it and
  -- refusing to price it, only the second is visible and recoverable. Such a span is INCOMPLETE and
  -- contributes nothing until a correction says what happened.
  --
  -- 720 is the twelve hours the criterion names, and it is above the longest lawful presence rather than at
  -- it: the trading day is fifteen hours, `working_hours_rule` version 1 allows eight ordinary plus two
  -- overtime, and a figure at ten hours would disbelieve a lawful double shift. Zero is refused by the
  -- constraint below AND by `assertGraceRules` in @berelax/core, because zero makes every clock-out
  -- disbelieved and therefore pays nobody — the one value that looks strict and silently pays nothing.
  maximum_plausible_presence_minutes smallint not null
    constraint attendance_grace_rule_plausible_span_is_a_span
      check (maximum_plausible_presence_minutes between 1 and 1440),

  -- How far outside a trading day's own window a punch may fall and still be attributed to that day.
  --
  -- Needed because the truth requires it: a therapist arriving before the doors open at 11:00 and a front
  -- desk clocking out after the cash-up finishes are both ordinary, and `attendance_trading_date_for()` with
  -- no tolerance would refuse to attribute either — which means the front desk could not record what
  -- happened, and an unrecordable punch is a paid hour that vanishes.
  --
  -- The upper bound is not taste. Trading is 11:00-02:00, so the gap between one day's close and the next
  -- day's open is nine hours; a tolerance at or above 270 minutes each side would make two consecutive days'
  -- widened windows overlap, and a punch in the overlap would belong to two trading dates with nothing able
  -- to choose. 240 keeps a half-hour margin, and `hr-attendance.test.ts` asserts the non-overlap
  -- arithmetically rather than by eye.
  punch_tolerance_minutes            smallint not null
    constraint attendance_grace_rule_tolerance_cannot_overlap_two_days
      check (punch_tolerance_minutes between 0 and 240),

  -- HOW a punch reaches this table. A closed set with one member, which is the manifest's provisional line
  -- for Y9-attendance: manual clock-in and clock-out recorded by the front desk on the admin device, no
  -- biometric and no device integration. Recorded as a figure on the rule version rather than assumed,
  -- because "the answer is that there is no reader" is itself the answer somebody has to confirm — and the
  -- day a fingerprint reader is bought, this is a new version and a new member rather than a silent change
  -- in what every historical row meant.
  capture_method                     text     not null
    constraint attendance_grace_rule_capture_method_known
      check (capture_method in ('manual_front_desk')),

  -- The provenance trio every provisional row in this database carries, read by the Unconfirmed Assumptions
  -- panel exactly as it reads `app_setting`, `working_hours_rule` and `rota_coverage_rule`.
  is_provisional                     boolean  not null default true,
  provisional_note                   text,
  open_question_id                   text,
  constraint attendance_grace_rule_provisional_names_a_question
    check (not is_provisional or open_question_id is not null),
  source_note                        text     not null
    constraint attendance_grace_rule_source_note_not_placeholder
      check (not is_placeholder_text(source_note)),
  created_at                         timestamptz not null default now()
);

comment on table attendance_grace_rule is
  'Versioned attendance figures: the two grace windows, the span above which a presence is not believed, '
  'the tolerance a punch may fall outside its trading day by, and how a punch is captured. The version in '
  'force for a trading date is the row with the greatest effective_from at or before it, selected by '
  'attendanceGraceFor() in @berelax/core. Versioned rather than held in app_setting because attendance is '
  'asked about the PAST more insistently than anything else here: widening the grace window in April must '
  'not make March''s lateness retroactively disappear, and one current value cannot say what the window '
  'was when the timesheet was approved.';
comment on column attendance_grace_rule.maximum_plausible_presence_minutes is
  'The span above which a clock-in and a clock-out are not believed to be one presence. A forgotten '
  'clock-out closed the next morning would otherwise be paid as an eighteen-hour shift; instead the span is '
  'INCOMPLETE and contributes zero payable minutes until an audited correction says what happened.';
comment on column attendance_grace_rule.punch_tolerance_minutes is
  'How far outside its trading day''s window a punch may fall and still be attributed to it. Bounded at 240 '
  'because the gap between one day''s 02:00 close and the next day''s 11:00 open is nine hours, so a '
  'tolerance at 270 would make two days'' widened windows overlap and a punch in the overlap would belong '
  'to two trading dates.';

-- ---------------------------------------------------------------------------------------------
-- Version 1 — the build's provisional answer to Y9-attendance, and every figure in it is a guess
-- ---------------------------------------------------------------------------------------------
-- `effective_from` is 1900-01-01, the sentinel 0059 and 0081 both use and for their reason: every other
-- candidate is a claim. A date visibly before any trading this business could have done says what is true —
-- the provisional figures govern every trading date the system knows about, and no version before them
-- exists.
insert into attendance_grace_rule (
  effective_from,
  grace_minutes_after_start, grace_minutes_before_end,
  maximum_plausible_presence_minutes, punch_tolerance_minutes,
  capture_method,
  is_provisional, open_question_id, provisional_note, source_note
) values (
  date '1900-01-01',
  5, 5,
  720, 120,
  'manual_front_desk',
  true, 'Y9-attendance',
  'Provisional and none of it confirmed: a clock-in up to 5 minutes after the rostered start and a '
    || 'clock-out up to 5 minutes before the rostered end are ON_TIME; a clock-in and clock-out more than '
    || '12 hours apart are not believed to be one presence and contribute nothing until corrected; a punch '
    || 'up to 2 hours outside its trading day''s window is still that day''s, because staff arrive before '
    || 'the doors open and the cash-up runs after close. Capture is MANUAL, recorded by the front desk on '
    || 'the admin device: there is no biometric reader and no device integration, which is a fact about '
    || 'what the business has rather than a decision this build made.',
  'docs/OPEN-QUESTIONS.md Y9-attendance — provisional, no figure confirmed by the owner'
);

-- ---------------------------------------------------------------------------------------------
-- attendance_trading_date_for — the ONE definition of which trading date a punch belongs to
-- ---------------------------------------------------------------------------------------------
-- A function and not a column default, and in SQL rather than in TypeScript, for `period_lock_for()`'s
-- reason: the insert trigger below and `recordAttendancePunch` in @berelax/db both need the answer, and two
-- implementations of "which day is it" is one answer plus a future disagreement. `working-hours.ts` names
-- that mistake as the one this subject is most likely to ship, and there is exactly one reading of it.
--
-- Reads the materialised `business_day` calendar rather than re-deriving 11:00-02:00, so the 01:50 case is
-- not a special case at all: 01:50 on the 8th is inside the window that opened at 11:00 on the 7th, and the
-- row that contains it is the row that contains it.
--
-- The unwidened window wins over a widened one, which is the ordering that matters. With the tolerance
-- applied, 10:30 falls inside the previous day's widened window (closes 02:00, widened to 04:00 — not
-- 10:30) — so the case that actually arises is a punch at 10:52 for an 11:00 shift, inside today's widened
-- window and inside nothing else. The ordering is there so that a tolerance somebody later raises cannot
-- silently move a punch that sits squarely inside one day into a neighbour.
create function attendance_trading_date_for(p_occurred_at timestamptz) returns date
language sql
stable
as $$
  with tolerance as (
    -- The version governing the punch's own calendar date in the business zone. Deliberately NOT the version
    -- governing the trading date, which is what this function is computing: reading the tolerance from the
    -- answer would be circular, and a calendar date is unambiguous.
    select coalesce(max(punch_tolerance_minutes), 0)::int as minutes
      from attendance_grace_rule
     where effective_from = (
       select max(effective_from) from attendance_grace_rule
        where effective_from <= (p_occurred_at at time zone 'Asia/Dubai')::date
     )
  )
  select bd.trading_date
    from business_day bd, tolerance t
   where tstzrange(bd.opens_at - make_interval(mins => t.minutes),
                   bd.closes_at + make_interval(mins => t.minutes), '[)') @> p_occurred_at
   order by (tstzrange(bd.opens_at, bd.closes_at, '[)') @> p_occurred_at) desc,
            abs(extract(epoch from (bd.opens_at - p_occurred_at))),
            bd.trading_date
   limit 1
$$;

comment on function attendance_trading_date_for(timestamptz) is
  'The trading date an attendance punch belongs to: the business_day whose window contains the instant, or '
  'whose window widened by attendance_grace_rule.punch_tolerance_minutes does. Null when no day is close '
  'enough, which assert_attendance_trading_date turns into ZX003. THE one definition - the insert trigger '
  'and recordAttendancePunch both call it, so a punch cannot be filed under one day and read under another.';

-- ---------------------------------------------------------------------------------------------
-- attendance_event — one row per punch, append-only
-- ---------------------------------------------------------------------------------------------
-- One row per PUNCH and not one row per presence with a nullable clock-out, and that is forced by the rest
-- of the design rather than chosen for elegance: a presence row would have its clock-out filled in later by
-- an UPDATE, and this table refuses every UPDATE. A pair of events makes INCOMPLETE a shape — a clock-in
-- with nothing after it — rather than a null somebody has to remember to check.
create table attendance_event (
  id              uuid        primary key default uuid_generate_v7(),

  -- A KEY, and the one reference in this file that pins a parent anybody might otherwise delete. 0030
  -- already decided that deleting a person to erase their roster is the delete worth refusing, and this is
  -- the stronger case: the row is the evidence of what somebody worked, which is the input to what they are
  -- paid. Ending employment is `employed_until`.
  employee_id     uuid        not null references employee (id) on delete restrict,

  -- The trading date, materialised — and a PLAIN COLUMN, which is the decision this file's header argues at
  -- length. `business_day` is generated and `business-days.itest.ts` empties it; nothing here can ever be
  -- deleted, so a RESTRICT reference would pin every date named for ever, for every caller, and break the
  -- generator in eleven cases of another unit's suite. The guard is at INSERT, where the row is still
  -- fixable: `assert_attendance_trading_date` refuses a date `attendance_trading_date_for()` disagrees with
  -- and a date `business_day` does not hold at all.
  trading_date    date        not null,

  kind            text        not null
    constraint attendance_event_kind_known check (kind in ('clock_in', 'clock_out')),

  -- When the punch happened. `timestamptz`, because a wall-clock time cannot say which side of midnight a
  -- 01:50 clock-out is on, and that is the whole subject.
  --
  -- On a WHOLE MINUTE, refused rather than truncated. `workedMinutes` in @berelax/core refuses a span off a
  -- whole minute — rounding it would create or destroy paid time by a few seconds per shift, which
  -- reconciles to nothing — so seconds admitted here would surface as a thrown pricing call on a screen
  -- rather than as a rejected punch at the desk. A punch is recorded to the minute, and the constraint says
  -- so where the value arrives.
  occurred_at     timestamptz not null
    constraint attendance_event_occurred_on_whole_minute
      check (date_trunc('minute', occurred_at) = occurred_at),

  -- When the front desk typed it, which is not when it happened. Both are kept because the gap between them
  -- is the only signal that a punch was entered after the fact, and a single column would make a punch typed
  -- three days later indistinguishable from one typed as somebody walked in.
  recorded_at     timestamptz not null default now(),

  -- How it was captured. The same closed set as `attendance_grace_rule.capture_method`, restated on the row
  -- because the rule version says what the business HAS and the row says what was actually used — and the
  -- day a second method exists, a row recorded under the old one must keep saying so.
  capture_method  text        not null
    constraint attendance_event_capture_method_known
      check (capture_method in ('manual_front_desk')),

  -- Who recorded it. A label and not a uuid: there is no admin session until W-SYS-01, and the audit row
  -- written in the same transaction carries the actor. Never a placeholder and never blank — a punch nobody
  -- is accountable for is a punch nobody can be asked about.
  recorded_by     text        not null
    constraint attendance_event_recorded_by_not_placeholder
      check (not is_placeholder_text(recorded_by) and btrim(recorded_by) <> ''),

  created_at      timestamptz not null default now(),

  -- Two punches at the same instant for one person is a double-tap on the admin device, not two events. It
  -- would pair into a zero-length presence, which `workedMinutes` refuses — so the constraint turns a
  -- mis-click at the desk into a refusal at the desk rather than a thrown pricing call on a screen later.
  constraint attendance_event_one_punch_per_instant unique (employee_id, occurred_at)
);

comment on table attendance_event is
  'One attendance punch, append-only. A pair of rows rather than a presence row with a nullable clock-out, '
  'because filling a clock-out in later is an UPDATE and this table refuses every UPDATE - so INCOMPLETE is '
  'a shape (a clock-in with nothing after it) rather than a null a reader has to remember. trading_date is '
  'materialised by attendance_trading_date_for() and deliberately NOT foreign-keyed: business_day is '
  'generated, and a row that can never be deleted would pin every date it names for ever.';
comment on column attendance_event.trading_date is
  'The trading date the punch belongs to, from attendance_trading_date_for(). A 01:50 clock-out belongs to '
  'the day that opened at 11:00 the previous calendar date. NOT a foreign key, and the reason is the '
  'mechanism rather than the meaning: cash_session.trading_date IS one because a cash_session can be '
  'deleted to release the pin, and nothing in this table can.';
comment on column attendance_event.recorded_at is
  'When the front desk typed it, as against occurred_at, when it happened. Both, because the gap is the '
  'only signal that a punch was entered after the fact.';

create index attendance_event_employee_day_idx
  on attendance_event (employee_id, trading_date, occurred_at);
create index attendance_event_day_idx on attendance_event (trading_date, occurred_at);

-- ---------------------------------------------------------------------------------------------
-- timesheet_approval — the approval, and the lock it puts on a period
-- ---------------------------------------------------------------------------------------------
create table timesheet_approval (
  id                                uuid        primary key default uuid_generate_v7(),

  -- A KEY, for `attendance_event.employee_id`'s reason.
  employee_id                       uuid        not null references employee (id) on delete restrict,

  -- Inclusive at both ends, because a trading date is a whole session and a half-open date range invites the
  -- off-by-one that drops the last day of the period — `rota_version` gives the same reason for the same
  -- shape. NOT foreign-keyed into `business_day`: a period is a LABEL for what was approved and its ends may
  -- fall on a closed date, and refusing that would refuse a correct approval for the shape of its label.
  from_trading_date                 date        not null,
  to_trading_date                   date        not null,
  constraint timesheet_approval_period_ordered check (to_trading_date >= from_trading_date),

  -- The published rota the attendance was measured against. A KEY, and this is what P-HR-06 deferred here in
  -- its own words: the immutable `rota_version` EXISTS to be compared against. Two things follow from its
  -- being a key rather than a plain uuid. The pin costs nothing, because `rota_version` can never be deleted
  -- either (ZW001), so this is the case 0081 describes as its own self-references — a reference between two
  -- tables neither of which anybody can delete. And it is not provenance but a PRECONDITION: a plain column
  -- would let a timesheet be approved against a version that was never published, which is exactly the
  -- after-the-fact variance the immutability was built to prevent.
  rota_version_id                   uuid        not null references rota_version (id) on delete restrict,

  -- The two rule versions that judged and priced it, snapshotted as PLAIN DATES.
  --
  -- 0081's decision verbatim, for its reason: a row in an immutable table records what was true and holds
  -- nothing else hostage. What a reader wants from these is which standard applied, not a guarantee that the
  -- standard's row is still on disk — and `packages/fixtures/src/hr-working-hours.itest.ts` empties
  -- `working_hours_rule` inside a rolled-back probe to prove P-HR-05's reader throws rather than inventing
  -- rates, which a RESTRICT reference from a row that can never be deleted would refuse.
  grace_rule_effective_from         date        not null,
  working_hours_rule_effective_from date        not null,

  -- The payable minutes, which are P-HR-05's bucket total over the ATTENDED presences and not a figure
  -- computed here or in @berelax/db. `summariseTimesheet` in @berelax/core sums
  -- `summariseWorkedHours().days[].totalMinutes`, and the buckets are a partition of that total by that
  -- module's own property — which is how "approved payable minutes equal the sum of the P-HR-05 buckets"
  -- holds by construction rather than as an agreement between two implementations that will drift.
  payable_minutes                   integer     not null
    constraint timesheet_approval_payable_minutes_nonneg check (payable_minutes >= 0),

  -- `sum(minutes x multiplierBp)`, whole basis-point-minutes. Deliberately NOT money, and deliberately not
  -- the labour-cost forecast either: P-HR-05 stops here because `employee.basic_wage_fils` is a monthly
  -- figure whose conversion is unanswered (Y9-overtime), and 0081's own comment says a forecast is a forecast
  -- while payroll pays attendance. This column is the attendance half of that sentence.
  weighted_minute_bp                bigint      not null
    constraint timesheet_approval_weighted_bp_nonneg check (weighted_minute_bp >= 0),

  -- How many spans contributed nothing because an end was unknown or not believed.
  --
  -- NOT NULL on every row, and for `rota_version.forecast_unpriced_employees`'s reason exactly: an INCOMPLETE
  -- span contributes zero payable minutes, so a timesheet over a period where every clock-out was missed is
  -- 0 minutes and reads as a therapist who never came in. A screen printing the payable total must print
  -- this beside it, and `renderTimesheetsHtml` does.
  incomplete_presence_count         smallint    not null
    constraint timesheet_approval_incomplete_count_nonneg check (incomplete_presence_count >= 0),

  -- How many spans were attended with nothing rostered for them. Recorded for the same reason as the count
  -- above and with the opposite sign: unrostered minutes ARE payable (somebody who worked is paid, which is
  -- the strict reading — see Y9-attendance), so a period of entirely unrostered work approves silently, and
  -- a figure nobody prints is a roster nobody fixes.
  unrostered_presence_count         smallint    not null default 0
    constraint timesheet_approval_unrostered_count_nonneg check (unrostered_presence_count >= 0),

  -- A label, not a uuid: there is no admin session until W-SYS-01, and the audit row written in the same
  -- transaction carries the actor. Never a placeholder — an approval whose approver is blank is an approval
  -- nobody is accountable for, and this one locks a period.
  approved_by                       text        not null
    constraint timesheet_approval_approved_by_not_placeholder
      check (not is_placeholder_text(approved_by) and btrim(approved_by) <> ''),
  approved_at                       timestamptz not null default now(),
  created_at                        timestamptz not null default now(),

  -- One approval per employee per period. Approving the same period twice is the thing to refuse: the second
  -- would put two payable figures on one week with nothing able to choose, and a correction is a dated row
  -- rather than a re-approval.
  constraint timesheet_approval_one_per_employee_per_period
    unique (employee_id, from_trading_date, to_trading_date)
);

comment on table timesheet_approval is
  'One approved timesheet, append-only: the payable minutes for one employee and one period, measured '
  'against the immutable rota_version named on the row. After it exists, a new attendance_event for that '
  'employee and period is refused (ZX004) and the only way to change the period is a dated '
  'attendance_correction - the journal rule (0018) applied to hours rather than to money.';
comment on column timesheet_approval.rota_version_id is
  'The published rota the attendance was measured against. A KEY and not a plain column because it is a '
  'PRECONDITION rather than provenance: this is what P-HR-06 deferred here - the immutable version exists '
  'to be compared against - and a plain column would let a timesheet be approved against a version nobody '
  'published.';
comment on column timesheet_approval.incomplete_presence_count is
  'Spans that contributed nothing because an end was unknown or not believed. On every row, because a '
  'timesheet whose clock-outs were all missed is 0 payable minutes and reads as somebody who never came in.';

create index timesheet_approval_period_idx
  on timesheet_approval (from_trading_date, to_trading_date);
create index timesheet_approval_version_idx on timesheet_approval (rota_version_id);

-- ---------------------------------------------------------------------------------------------
-- attendance_correction — the dated adjustment row, append-only
-- ---------------------------------------------------------------------------------------------
-- The acceptance criterion: "a correction inserts a dated adjustment row while the original row is
-- unchanged (mirrors the append-only journal rule)". This table is the dated adjustment row, and every part
-- of that sentence is a column or a trigger here.
create table attendance_correction (
  id                  uuid        primary key default uuid_generate_v7(),
  employee_id         uuid        not null references employee (id) on delete restrict,

  -- The trading date being corrected. A PLAIN COLUMN, for `attendance_event.trading_date`'s reason: this
  -- table is append-only too, so a reference would pin the date for ever.
  trading_date        date        not null,

  -- The date the adjustment is POSTED on, which is what makes it a dated adjustment rather than an edit.
  --
  -- Distinct from `trading_date` and that distinction is the whole mechanism, copied from
  -- `postDatedCorrection` (M-VAT-06): the correction is ABOUT a day in a closed period and is RECORDED on a
  -- day in an open one. `attendance_correction_period_guard` below refuses an adjustment_date inside a
  -- locked accounting period by calling `raise_if_period_locked()` — the same function every posting path in
  -- this database reaches — so the refusal names the locked period AND the earliest open date, and no second
  -- reader of the lock exists to disagree with it.
  adjustment_date     date        not null,

  kind                text        not null
    constraint attendance_correction_kind_known
      check (kind in ('supply_missing_clock_out', 'amend_punch_instant')),

  -- The punch being corrected. A KEY, and the pin costs nothing because both ends are append-only: 0081 kept
  -- its self-references for exactly this reason. NULL is refused for `amend_punch_instant` and required for
  -- neither — a missing clock-out is supplied against the clock-in that is open, which is a punch that
  -- exists, so both kinds name a row.
  corrects_event_id   uuid        not null references attendance_event (id) on delete restrict,

  -- What the correction says the instant is.
  --
  -- **A correction produces no `attendance_event`, and that is the load-bearing part of the design.** The
  -- obvious shape is for a supplied clock-out to insert a punch, and it is wrong twice over: the punch would
  -- be dated inside the period the correction exists to work around, so the accounting-period guard and
  -- ZX004 would both refuse the very row the remedy depends on — and it would put the same fact in two
  -- places, so a reader that found the punch and not the correction would report a corrected day as an
  -- ordinary one, with no reason and no author attached to a changed payslip.
  --
  -- So this column IS the corrected instant, and `applyAttendanceCorrections` in @berelax/core layers the
  -- corrections over the punches when the timesheet is computed. The original row is unchanged in the
  -- strongest sense available: nothing was written beside it either.
  --
  -- Whole-minute for `attendance_event.occurred_at`'s reason: it becomes a punch instant in the reader, and
  -- `workedMinutes` refuses a span off a whole minute.
  corrected_occurred_at timestamptz not null
    constraint attendance_correction_instant_on_whole_minute
      check (date_trunc('minute', corrected_occurred_at) = corrected_occurred_at),

  -- The reason, and the acceptance criterion names this one exactly: "an empty reason is rejected by
  -- constraint, not by UI validation alone". Three refusals rather than one, because each catches a
  -- different way of writing nothing: blank after trimming, a placeholder marker the schema refuses
  -- (migration 0026), and a reason too short to be one. The length floor is the weakest of the three and
  -- still worth having — "x" passes both the others and answers nobody's question about a changed payslip.
  reason              text        not null
    constraint attendance_correction_reason_is_a_reason
      check (btrim(reason) <> ''
         and not is_placeholder_text(reason)
         and length(btrim(reason)) >= 8),

  corrected_by        text        not null
    constraint attendance_correction_corrected_by_not_placeholder
      check (not is_placeholder_text(corrected_by) and btrim(corrected_by) <> ''),
  corrected_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),

  -- One correction per punch per kind. A second `supply_missing_clock_out` against the same clock-in would
  -- produce a second clock-out, and `assert_attendance_punch_alternates` would refuse the punch with a
  -- message about alternation rather than about the duplicate correction that caused it.
  constraint attendance_correction_one_per_event_per_kind unique (corrects_event_id, kind)
);

comment on table attendance_correction is
  'A dated adjustment to attendance, append-only. The original attendance_event is never touched: the '
  'correction records what the instant should be, on an adjustment_date that must fall in an OPEN '
  'accounting period, and (for a supplied clock-out) the punch it produced. The journal rule from 0018 '
  'applied to hours rather than to money - a correction is a new row, never an edit.';
comment on column attendance_correction.adjustment_date is
  'The date the adjustment is POSTED on, as against trading_date, the day it is ABOUT. postDatedCorrection '
  '(M-VAT-06) draws the same distinction for the same reason: a correction to a closed period is recorded '
  'in the next open one. Refused inside a locked period by raise_if_period_locked(), which names the '
  'earliest open date.';
comment on column attendance_correction.reason is
  'Why. Refused by CONSTRAINT rather than by UI validation alone, which the acceptance criterion names: '
  'blank, a placeholder marker (0026) and a string under eight characters are all rejected, because a '
  'correction with no reason is a changed payslip nobody can be asked about.';

create index attendance_correction_employee_day_idx
  on attendance_correction (employee_id, trading_date);
create index attendance_correction_adjustment_idx on attendance_correction (adjustment_date);

-- ---------------------------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------------------------
-- A trigger that RAISES rather than `create rule ... do instead nothing`, for 0018's reason: a rule reports
-- SUCCESS, so code that edited a punch would believe it had corrected it. The whole unit is that a
-- correction is a new dated row, and code taking the other path has to be told, not humoured.
create function refuse_attendance_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'Attendance is append-only; % on % is refused. A punch is evidence about what somebody worked and '
    'payroll pays attendance, so a row that can be edited is a row where a paid hour can be made never to '
    'have happened. The remedy is an attendance_correction dated in an OPEN period, which leaves the '
    'original row saying what it always said.',
    tg_op, tg_table_name
    using errcode = 'ZX001';
end $$;

comment on function refuse_attendance_change() is
  'Raises ZX001 (AttendanceImmutable) for attendance_event, attendance_correction and timesheet_approval, '
  'for every role including the owner. A correction is a new dated row, not an UPDATE of the old one.';

create trigger attendance_event_no_update before update on attendance_event
  for each row execute function refuse_attendance_change();
create trigger attendance_event_no_delete before delete on attendance_event
  for each row execute function refuse_attendance_change();
create trigger attendance_correction_no_update before update on attendance_correction
  for each row execute function refuse_attendance_change();
create trigger attendance_correction_no_delete before delete on attendance_correction
  for each row execute function refuse_attendance_change();
create trigger timesheet_approval_no_update before update on timesheet_approval
  for each row execute function refuse_attendance_change();
create trigger timesheet_approval_no_delete before delete on timesheet_approval
  for each row execute function refuse_attendance_change();

-- ---------------------------------------------------------------------------------------------
-- The trading date on a punch must be the one there is exactly one definition of
-- ---------------------------------------------------------------------------------------------
-- Two refusals in one trigger, and they are the same claim seen from two sides: a punch on a date
-- `business_day` does not hold is a punch on a day the premises did not trade, and a punch whose column
-- disagrees with `attendance_trading_date_for()` is a punch filed under a day it did not happen on. Both
-- would be invisible afterwards — the first as a day with attendance and no trading, the second as hours
-- that appear on the wrong week's timesheet and balance perfectly on both.
create function assert_attendance_trading_date() returns trigger
language plpgsql
as $$
declare
  v_derived date := attendance_trading_date_for(new.occurred_at);
begin
  if v_derived is null then
    raise exception
      'A punch at % belongs to no trading date. No business_day window contains it, even widened by '
      'attendance_grace_rule.punch_tolerance_minutes — so either the premises did not trade that session '
      'or the calendar has not been generated for it. Recording it against % would put attendance on a '
      'day with no trading.',
      new.occurred_at, new.trading_date
      using errcode = 'ZX003';
  end if;
  if v_derived <> new.trading_date then
    raise exception
      'A punch at % belongs to trading date % and not to %. Trading runs 11:00-02:00, so a 01:50 punch '
      'belongs to the day that opened at 11:00 the previous calendar date — and a punch filed under the '
      'wrong day moves paid hours between weeks while every total still balances.',
      new.occurred_at, v_derived, new.trading_date
      using errcode = 'ZX003';
  end if;
  return new;
end $$;

comment on function assert_attendance_trading_date() is
  'Raises ZX003 when a punch names a trading date attendance_trading_date_for() does not derive, or one no '
  'business_day holds. The guard is at INSERT because the column is deliberately not a foreign key: '
  'business_day is generated and an append-only row would pin every date it named for ever.';

create trigger attendance_event_date_is_derived before insert on attendance_event
  for each row execute function assert_attendance_trading_date();

-- ---------------------------------------------------------------------------------------------
-- Punches alternate, so INCOMPLETE means exactly one thing
-- ---------------------------------------------------------------------------------------------
-- Without this, two clock-ins in a row is representable, and every reader then has to decide which one to
-- pair — so "a missing clock-out is flagged INCOMPLETE" would mean whatever the pairing code happened to
-- do. With it, a day's punches alternate by construction, and a trailing clock-in is the ONE shape
-- INCOMPLETE can take. `pairAttendancePunches` in @berelax/core refuses a non-alternating sequence too,
-- because an owner-rights `psql` session reaches past this trigger, and a pairing that silently dropped a
-- stray punch would drop a whole presence from somebody's pay.
--
-- Scoped to the employee and the trading date, which is the grain a presence has. Across trading dates it
-- would be wrong: a therapist who forgot to clock out on Monday has an open clock-in for ever, and refusing
-- Tuesday's clock-in would stop them working until somebody filed a correction.
create function assert_attendance_punch_alternates() returns trigger
language plpgsql
as $$
declare
  v_last text;
begin
  select kind into v_last
    from attendance_event
   where employee_id = new.employee_id
     and trading_date = new.trading_date
     and (occurred_at, id) < (new.occurred_at, new.id)
   order by occurred_at desc, id desc
   limit 1;

  if new.kind = 'clock_in' and v_last = 'clock_in' then
    raise exception
      'Employee % already has an open clock-in on % and cannot clock in again. Two clock-ins with no '
      'clock-out between them would make a presence ambiguous, and whichever one a reader paired would '
      'decide somebody''s pay. Clock out first, or file an attendance_correction supplying the clock-out '
      'that was missed.',
      new.employee_id, new.trading_date
      using errcode = 'ZX002';
  end if;
  if new.kind = 'clock_out' and v_last is distinct from 'clock_in' then
    raise exception
      'Employee % has no open clock-in on %, so there is nothing for this clock-out to close. A clock-out '
      'standing alone is not a short shift; it is a punch whose start nobody recorded.',
      new.employee_id, new.trading_date
      using errcode = 'ZX002';
  end if;
  return new;
end $$;

comment on function assert_attendance_punch_alternates() is
  'Raises ZX002 for a clock-in while one is open, or a clock-out with none open, per employee per trading '
  'date. What makes INCOMPLETE mean exactly one thing: a trailing clock-in. Scoped to the trading date '
  'because an unclosed Monday must not stop somebody clocking in on Tuesday.';

create trigger attendance_event_punches_alternate before insert on attendance_event
  for each row execute function assert_attendance_punch_alternates();

-- ---------------------------------------------------------------------------------------------
-- The two period locks
-- ---------------------------------------------------------------------------------------------
-- 1. The ACCOUNTING period lock, which is everybody's and is about the ledger. `raise_if_period_locked()`
--    is called, never re-implemented: it is the function the BEFORE INSERT guards on `journal_entry` and
--    `journal_line` call, so a punch cannot be refused by one rule and permitted by another, and 0073
--    redefined it to name the earliest OPEN date as well as the locked period — which is what stops a
--    refusal sending somebody to a month they also cannot use.
create function attendance_event_period_guard() returns trigger
language plpgsql
as $$
begin
  perform raise_if_period_locked(
    new.trading_date,
    'the ' || new.kind || ' punch for employee ' || new.employee_id::text
  );
  return new;
end $$;

comment on function attendance_event_period_guard() is
  'Refuses a punch dated inside a closed accounting period, with ZL002 from raise_if_period_locked() - the '
  'one definition every posting path reaches. Not a second reader of the lock: periodStatusOn() in '
  '@berelax/db is the one TypeScript reader and it reads the same two SQL functions.';

create trigger attendance_event_period_lock before insert on attendance_event
  for each row execute function attendance_event_period_guard();

-- The adjustment_date, not the trading_date. A correction is ABOUT a closed day by definition — that is what
-- makes it a correction — and is RECORDED on an open one, exactly as `postDatedCorrection` posts the
-- reversing entry in the next open period.
create function attendance_correction_period_guard() returns trigger
language plpgsql
as $$
begin
  perform raise_if_period_locked(
    new.adjustment_date,
    'the attendance correction for employee ' || new.employee_id::text || ' on ' || new.trading_date::text
  );
  return new;
end $$;

comment on function attendance_correction_period_guard() is
  'Refuses a correction whose ADJUSTMENT date falls in a closed accounting period, with ZL002. The '
  'trading_date is deliberately not checked: a correction about a closed day is the whole point, and '
  'refusing it there would leave a wrong payslip with no remedy at all.';

create trigger attendance_correction_period_lock before insert on attendance_correction
  for each row execute function attendance_correction_period_guard();

-- 2. The APPROVED TIMESHEET, which is one employee's and one period's. A different fact from the accounting
--    lock and therefore a refusal of its own rather than a second reading of that one: the remedy is not
--    "post it in the next open month" but "file a dated correction", because the hours have been agreed and
--    the agreement is what a correction amends. The message names the approval and the remedy, for the
--    reason 0073 gives about naming the earliest open date — a refusal that names only what is shut sends
--    somebody nowhere they can go.
create function assert_attendance_period_not_approved() returns trigger
language plpgsql
as $$
declare
  v_approval timesheet_approval;
begin
  -- No exemption is needed and none exists, which is what `attendance_correction` producing no punch buys:
  -- a correction changes what an approved period says WITHOUT inserting a row into this table, so the lock
  -- here can be absolute. An exemption keyed on "this punch came from a correction" would be a hole in the
  -- lock that any caller could set a column to walk through.
  select * into v_approval from timesheet_approval
   where employee_id = new.employee_id
     and new.trading_date between from_trading_date and to_trading_date
   limit 1;

  if v_approval.id is not null then
    raise exception
      'Timesheet for employee % covering %..% was approved by % at %, so a new % punch on % is refused. '
      'The approved payable minutes are what payroll pays, and a punch inserted afterwards would change '
      'them with nothing recording that anything changed. File an attendance_correction instead: it names '
      'a reason, carries an adjustment_date in an OPEN accounting period, and leaves this period saying '
      'what it was approved as saying.',
      new.employee_id, v_approval.from_trading_date, v_approval.to_trading_date,
      v_approval.approved_by, v_approval.approved_at, new.kind, new.trading_date
      using errcode = 'ZX004';
  end if;
  return new;
end $$;

comment on function assert_attendance_period_not_approved() is
  'Raises ZX004 when a punch falls inside a period already approved for that employee. Absolute, with no '
  'exemption: a correction changes an approved period without inserting into this table, so nothing needs '
  'a way through the lock and no column can be set to find one.';

create trigger attendance_event_period_not_approved before insert on attendance_event
  for each row execute function assert_attendance_period_not_approved();

-- ---------------------------------------------------------------------------------------------
-- An approval must follow from the version it names
-- ---------------------------------------------------------------------------------------------
-- Two refusals, and both are about the claim `rota_version_id` makes. A timesheet approved against a version
-- covering another period would be measured against a rota that says nothing about the days on it, and every
-- day would come back UNROSTERED — payable, flagged, and wrong. A timesheet approved against a SUPERSEDED
-- version would be measured against a rota that was replaced before the period was worked, which is the
-- after-the-fact variance the immutability exists to prevent, wearing the immutability as a disguise.
create function assert_timesheet_approval_follows() returns trigger
language plpgsql
as $$
declare
  v_version rota_version;
  v_superseded_by uuid;
begin
  select * into v_version from rota_version where id = new.rota_version_id;

  if new.from_trading_date < v_version.from_trading_date
     or new.to_trading_date > v_version.to_trading_date then
    raise exception
      'A timesheet for %..% cannot be approved against rota version % (period %..%): the version says '
      'nothing about the days outside its own period, so every one of them would come back UNROSTERED and '
      'be paid as flagged work nobody rostered.',
      new.from_trading_date, new.to_trading_date, new.rota_version_id,
      v_version.from_trading_date, v_version.to_trading_date
      using errcode = 'ZX005';
  end if;

  select id into v_superseded_by from rota_version where supersedes_id = new.rota_version_id;
  if v_superseded_by is not null then
    raise exception
      'Rota version % was superseded by % and a timesheet may not be approved against it. Measuring '
      'attendance against a rota that was replaced before the period was worked is the after-the-fact '
      'variance an immutable version exists to prevent — the version is still readable, and it is still '
      'not what was rostered.',
      new.rota_version_id, v_superseded_by
      using errcode = 'ZX005';
  end if;
  return new;
end $$;

comment on function assert_timesheet_approval_follows() is
  'Raises ZX005 when a timesheet period is not inside the rota version''s period, or when that version has '
  'been superseded. The version is the thing the attendance was measured against, so both would make the '
  'payable minutes a measurement against a rota nobody worked.';

create trigger timesheet_approval_follows_its_version before insert on timesheet_approval
  for each row execute function assert_timesheet_approval_follows();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 grants the application role select/insert/update/delete on every table created in `public` afterwards
-- and extends it to tables created later by default privileges, so these revokes are load-bearing rather
-- than decorative — and stated explicitly because a managed database restored from a dump does not
-- necessarily carry the same defaults.
--
-- The triggers above already refuse for every role. These are the second layer, the one that answers "you
-- may not" rather than "you tried", and TRUNCATE is the operation no row trigger can see: a truncated
-- `attendance_event` takes every punch with it, and with them the evidence of every hour anybody was paid
-- for. 0076 and 0081 both state the same thing for the same reason.
revoke update, delete, truncate on attendance_event from berelax_app;
revoke update, delete, truncate on attendance_correction from berelax_app;
revoke update, delete, truncate on timesheet_approval from berelax_app;
-- The rule table is versioned by INSERT, exactly as `working_hours_rule` and `rota_coverage_rule` are:
-- confirming Y9-attendance publishes a new row and never edits the provisional one, because an approved
-- timesheet names the row that judged it and editing that row would change what the timesheet is recorded
-- as having satisfied.
revoke update, delete, truncate on attendance_grace_rule from berelax_app;

commit;
