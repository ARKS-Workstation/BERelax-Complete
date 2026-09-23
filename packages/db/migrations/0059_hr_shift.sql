-- 0059 — the working-hours rate table: the versioned rule set the shift maths reads, and nothing else.
--
-- P-HR-05's subject is arithmetic — how many minutes a 18:00–02:00 shift is, which trading date they
-- belong to, and which of them are ordinary, overtime, night-window or public-holiday minutes. The
-- arithmetic is pure and lives in `packages/core/src/hr/working-hours.ts`. This migration supplies the
-- one thing that arithmetic may not contain: the FIGURES.
--
-- ## What this migration deliberately does NOT do
--
-- **It does not create `shift` or `shift_assignment`.** 0030 created both, as a `tstzrange` period plus a
-- `trading_date` that is a foreign key into `business_day`, and they are what B-AVAIL-04's therapist pool
-- already reads (`packages/db/src/repositories/eligibility.ts`). The unit's summary names those two
-- tables because the maths is attributed to them, not because they were missing.
--
-- **It does not constrain `shift.period` to sit inside its trading date's window.** 0030 says why, in so
-- many words: the solver intersects presence with the window, so a shift running past close offers
-- nothing past close and a shift filed under the wrong trading date covers no candidate of that date —
-- both roster errors are inert, and a trigger asserting it would be a second opinion about where a
-- trading day ends. This unit is the one that would most like such a trigger and is the one that must
-- least add it: `resolveTradingDate` in `@berelax/core` is the single reading of "which day is it", and a
-- CHECK re-deriving the same rule in SQL would be the second reading that drifts.
--
-- **It does not hold the multipliers in `app_setting`.** That is the obvious alternative and it is wrong
-- here for a reason the acceptance criterion cannot state: a setting has ONE current value, and payroll
-- is asked about the past. Recomputing March's hours after an April rate change must use March's rates,
-- and an `app_setting` row overwritten in April cannot say what March's were — `app_setting_history` can,
-- but a history read as a rate table is a rate table nobody meant to build. So the rules are VERSIONED
-- rows keyed on the first trading date each version governs, and the version in force for a trading date
-- is the latest row at or before it. The provenance trio is on the row, so the panel still lists them:
-- `unconfirmedAssumptionRows()` reads this table the same way it reads `app_setting`.
--
-- **It does not hold a public-holiday calendar.** The holiday bucket takes the holiday-ness of the
-- TRADING DATE as an argument. `premises_closure` (0003) already carries `kind = 'public_holiday'` with
-- `is_confirmed`, because the holidays are lunar and announced at short notice, and
-- `publicHolidayTradingDates` in `@berelax/core` expands those rows into the set the maths needs. What
-- that table cannot answer is a public holiday the premises TRADES THROUGH: there is no closure row for
-- it, so the day looks ordinary. Inventing a calendar of lunar dates here would be exactly what brief
-- rule 15 refuses — a plausible holiday list is indistinguishable from a confirmed one — so the gap is
-- recorded as a deferral in the manifest rather than filled with a guess.
--
-- ## Why basis points and not a numeric
--
-- `overtime_multiplier_bp = 12500` is 1.25. Integer, for ADR 0007's reason one layer along: the figure
-- is multiplied by a minute count and will one day be multiplied by a fils-denominated wage, and a
-- `numeric(4,2)` here is the float-money mistake wearing a rate's costume. Basis points also make the
-- "no multiplier literal in the function body" grep test meaningful: there is no spelling of 1.25 the
-- arithmetic could reach for, because the arithmetic works in whole basis points throughout.
--
-- ## The uplift floor, and why it is a constraint
--
-- Each worked minute is paid at the DEAREST applicable rate and counted in that one bucket, so the
-- buckets partition the minutes and sum to the total exactly (the unit's property). That model needs
-- `ordinary` to be the floor: an "uplift" below the ordinary rate would make the dearest-applicable rule
-- assign a night minute to `ordinary`, which reads as a bug in the bucket split rather than as a rate
-- somebody typed wrong. Hence `working_hours_rule_uplifts_are_not_reductions`.

begin;

create table working_hours_rule (
  -- The first TRADING date this version governs. The primary key, because two versions taking effect on
  -- one date is not a rate change, it is an ambiguity — and the reader picks "the latest row at or before
  -- the trading date", which has no answer when two rows tie.
  --
  -- Deliberately NOT a foreign key into `business_day`. A rule takes effect on a calendar date whether or
  -- not the premises trades that day, and a labour rule that could only commence on a trading day would
  -- be unrecordable for any change announced over a closure.
  effective_from               date        primary key,

  -- Ordinary hours before a minute becomes overtime-eligible. Consumed by every worked minute in the
  -- order worked, whatever bucket it lands in: a minute at 23:00 is paid at the night rate and is still
  -- one of the day's first eight hours.
  ordinary_minutes_per_day     integer     not null
    constraint working_hours_rule_ordinary_day_plausible
      check (ordinary_minutes_per_day > 0 and ordinary_minutes_per_day <= 1440),
  ordinary_minutes_per_week    integer     not null
    constraint working_hours_rule_ordinary_week_plausible
      check (ordinary_minutes_per_week > 0 and ordinary_minutes_per_week <= 10080),
  -- Which weekday a working week starts on, 0 = Sunday, the spelling `premises_hours.day_of_week` uses.
  -- Part of the rule and not a display preference: a weekly cap without a week boundary is not a cap,
  -- and the boundary is a TRADING date boundary — the week a shift belongs to follows its trading date,
  -- so a shift running 23:00 Friday to 02:00 Saturday is wholly in Friday's week.
  week_starts_on               smallint    not null
    constraint working_hours_rule_week_starts_on_is_a_weekday
      check (week_starts_on between 0 and 6),
  -- The daily overtime ceiling. Exceeding it is a VIOLATION and not a dearer bucket: overtime beyond the
  -- cap is unlawful, and pricing it would turn a compliance breach into a line on a payslip.
  overtime_daily_cap_minutes   integer     not null
    constraint working_hours_rule_overtime_cap_plausible
      check (overtime_daily_cap_minutes >= 0 and overtime_daily_cap_minutes <= 1440),
  -- The minimum gap between two consecutive presences for one employee. Between PRESENCES, not between
  -- rows: a roster written in two abutting halves is one presence, and a gap of zero between them is not
  -- a rest breach.
  minimum_rest_minutes         integer     not null
    constraint working_hours_rule_minimum_rest_plausible
      check (minimum_rest_minutes >= 0 and minimum_rest_minutes <= 1440),

  -- The night window as local wall-clock times, half-open `[from, until)`. Two `time` columns rather than
  -- a range because the window WRAPS midnight — 22:00 to 04:00 — which is the same reason
  -- `premises_hours` carries `open_time`/`close_time` plus a generated `crosses_midnight` rather than a
  -- range, and the same reason `shift.period` is instants rather than two times: a wrapping wall-clock
  -- window is not an interval on one date.
  night_window_from            time        not null,
  night_window_until           time        not null,
  constraint working_hours_rule_night_window_nonempty
    check (night_window_from <> night_window_until),

  -- Basis points. 10000 is the ordinary rate.
  ordinary_multiplier_bp       integer     not null,
  overtime_multiplier_bp       integer     not null,
  night_multiplier_bp          integer     not null,
  public_holiday_multiplier_bp integer     not null,
  constraint working_hours_rule_ordinary_is_the_base_rate
    check (ordinary_multiplier_bp = 10000),
  constraint working_hours_rule_uplifts_are_not_reductions
    check (overtime_multiplier_bp >= ordinary_multiplier_bp
       and night_multiplier_bp >= ordinary_multiplier_bp
       and public_holiday_multiplier_bp >= ordinary_multiplier_bp),

  -- The provenance trio every provisional row in this database carries, read by the Unconfirmed
  -- Assumptions panel exactly as it reads `app_setting`.
  is_provisional               boolean     not null default true,
  provisional_note             text,
  open_question_id             text,
  constraint working_hours_rule_provisional_names_a_question
    check (not is_provisional or open_question_id is not null),
  -- Where the figures came from. NOT NULL and never a placeholder: a rate table whose provenance is
  -- blank is a rate table somebody will read as agreed.
  source_note                  text        not null
    constraint working_hours_rule_source_note_not_placeholder
      check (not is_placeholder_text(source_note)),
  created_at                   timestamptz not null default now()
);

comment on table working_hours_rule is
  'Versioned working-hours rules: ordinary hours, the overtime cap, the minimum rest gap, the night '
  'window and the four bucket multipliers in basis points. The version in force for a trading date is '
  'the row with the greatest effective_from at or before it, selected by rulesFor() in @berelax/core. '
  'Versioned rather than held in app_setting because payroll is asked about the PAST: recomputing '
  'March after an April rate change must use March''s rates, and one current value cannot say what '
  'they were.';
comment on column working_hours_rule.effective_from is
  'The first trading date this version governs. No foreign key to business_day: a rule commences on a '
  'calendar date whether or not the premises trades that day.';
comment on column working_hours_rule.ordinary_minutes_per_day is
  'Minutes before a worked minute becomes overtime-eligible. Consumed by every worked minute in the '
  'order worked, whatever bucket it lands in.';
comment on column working_hours_rule.overtime_daily_cap_minutes is
  'The daily overtime ceiling. Exceeding it is reported as a violation, never as a dearer bucket: '
  'pricing unlawful overtime turns a compliance breach into a payslip line.';
comment on column working_hours_rule.minimum_rest_minutes is
  'Minimum gap between consecutive PRESENCES for one employee. Abutting or overlapping shift rows are '
  'merged into one presence first, so a rota written in two halves is not a rest breach.';
comment on column working_hours_rule.night_window_from is
  'Local wall-clock start of the night window, half-open [from, until). Wraps midnight when from > '
  'until, which is why this is two time columns and not a range.';
comment on column working_hours_rule.ordinary_multiplier_bp is
  'Pinned to 10000. The ordinary rate is the base by definition; a base above 1.0 would double-count '
  'the wage it multiplies. Stored rather than assumed so the pure splitter reads every multiplier from '
  'this table and holds no rate literal of its own.';

-- ---------------------------------------------------------------------------------------------
-- Version 1 — the build's provisional answer to Y9-overtime, and every figure in it is a guess
-- ---------------------------------------------------------------------------------------------
-- docs/OPEN-QUESTIONS.md A2 carries Y9-overtime with "all figures to confirm". The strictest reading of
-- Federal Decree-Law 33 of 2021 that the build can defend is taken, because the strict answer is the one
-- that fails loudly if it is wrong: an overtime cap set too LOW reports a violation somebody has to look
-- at, while one set too high reports nothing and the breach is invisible.
--
-- `effective_from` is 1900-01-01, and that is a sentinel rather than a date. Every other candidate is a
-- claim: the commencement date of the decree-law would say these figures are the law's, and the
-- business's first trading date would say somebody agreed them then. A date visibly before any trading
-- this business could have done says what is true — the provisional rules govern every trading date the
-- system knows about, and no version before them exists.
--
-- The public-holiday multiplier is the one figure with no number in the manifest's provisional set, and
-- it is deliberately the same 150% as the night window rather than something dearer. The alternative the
-- law offers for a public holiday worked — a compensatory rest day — is not expressible as a multiplier
-- at all, so a higher figure invented here would be a guess dressed as the strict reading. 150% is the
-- highest uplift the build has any basis for, and Y9-overtime is what replaces it.
-- `week_starts_on = 1` (Monday) is a guess of the same kind, and it is the one figure here whose wrongness
-- is silent: a week boundary on the wrong day moves minutes between weeks without changing any day's
-- total, so the weekly cap is computed over the wrong seven days and nothing looks odd. It is flagged by
-- the same question for that reason.
insert into working_hours_rule (
  effective_from,
  ordinary_minutes_per_day, ordinary_minutes_per_week, week_starts_on,
  overtime_daily_cap_minutes, minimum_rest_minutes,
  night_window_from, night_window_until,
  ordinary_multiplier_bp, overtime_multiplier_bp,
  night_multiplier_bp, public_holiday_multiplier_bp,
  is_provisional, open_question_id, provisional_note, source_note
) values (
  date '1900-01-01',
  480, 2880, 1,
  120, 660,
  time '22:00', time '04:00',
  10000, 12500,
  15000, 15000,
  true, 'Y9-overtime',
  'Every figure is the build''s strictest reading of Federal Decree-Law 33 of 2021 and none is '
    || 'confirmed: 8h/day, 48h/week starting Monday, 1.25x overtime capped at 2h/day, 1.5x between '
    || '22:00 and 04:00, 1.5x on a public holiday worked, and 11h minimum rest between presences. The '
    || 'public-holiday figure has no number in the handover at all; the compensatory-rest-day '
    || 'alternative the law offers cannot be expressed as a multiplier.',
  'docs/OPEN-QUESTIONS.md Y9-overtime — provisional, strictest reading, no figure confirmed by the owner'
);

commit;
