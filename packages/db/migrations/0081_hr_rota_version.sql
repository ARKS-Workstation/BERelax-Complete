-- 0081 — rota publishing: the immutable published version, the versioned coverage and fatigue rules, the
-- wage divisor the forecast needs, the swap and claim record, and the per-employee publication notice.
--
-- P-HR-06's subject is a refusal. A rota is validated and then either published or not, and the whole unit
-- is the set of reasons not to. The arithmetic and every rule live in `packages/core/src/hr/rota-validator.ts`
-- and `packages/core/src/hr/labour-cost.ts`, which are pure; this migration supplies the two things a pure
-- function may not contain — the FIGURES the rules are judged against, and the record of what was published.
--
-- ## Why the coverage and fatigue thresholds are VERSIONED rows and not `app_setting`
--
-- This is the same decision 0059 took for the overtime rates and 0066 took for the leave entitlement, and
-- it is taken again here for the same reason rather than by analogy: **a rota is asked about the past.**
-- "Was the floor covered on the 4th of March?" and "why was that swap refused?" are questions about a rota
-- that was published months ago, and the answer has to be judged by the thresholds that applied then. An
-- `app_setting` row has ONE current value: raise the floor minimum from 2 to 3 in April and every March
-- rota retroactively becomes non-compliant, with nothing in the database able to say it was compliant when
-- it was published. `app_setting_history` could reconstruct it, but a history read as a rule table is a
-- rule table nobody meant to build (0059's words, and they are still true).
--
-- It is sharper here than for a pay rate, because a published `rota_version` is IMMUTABLE and names the
-- rule version that validated it (`coverage_rule_effective_from`). So the record is not "this rota was
-- valid" — a claim that decays — but "this rota satisfied THESE thresholds", which stays true for ever.
-- Answering Y9-coverage therefore publishes a NEW `rota_coverage_rule` row and the Unconfirmed Assumptions
-- panel row leaves by that version being confirmed, exactly as Y9-overtime's does.
--
-- ## Why there is no `status` column and no draft version row
--
-- The obvious shape is `rota_version.status in ('draft','published','superseded')`. It is wrong here, and
-- the reason is in 0030's own comment: "a shift IS deleted — an unpublished roster is rewritten". The
-- DRAFT already exists and it is `shift` plus `shift_assignment`, mutable, rewritten freely, which is what
-- the availability solver reads. So a draft `rota_version` row would be a second draft, and the two would
-- disagree the first time somebody edited one of them.
--
-- Every row in `rota_version` is therefore a PUBLISHED version, and publishing is an INSERT. Supersession
-- is forward-only: the new row carries `supersedes_id` pointing at the row it replaces, `unique
-- (supersedes_id)` means two versions cannot both claim to replace the same one, and "the current version
-- for a period" is the row nothing supersedes. That uniqueness is not tidiness — it is what makes a
-- concurrent double-publish a database error instead of two rival current rotas.
--
-- ## Why the assignments are SNAPSHOTTED rather than referencing shift_assignment
--
-- `rota_version_assignment` copies the employee, the trading date and the period onto its own row.
-- Referencing `shift_assignment` instead would make a published rota change when somebody deleted a draft
-- shift — `shift_assignment.shift_id` is `on delete cascade`, so the published rota would lose rows
-- silently, and an immutable version that loses rows is not immutable. `source_shift_id` is kept as a
-- nullable back-reference with `on delete set null`, so the link survives while the draft does and its
-- disappearance costs nothing.
--
-- ## An immutable row holds nothing else hostage
--
-- Every table here that cannot be edited — `rota_version`, `rota_version_assignment`,
-- `rota_change_request`, `rota_publication_notice` — references its parents as PLAIN COLUMNS wherever the
-- parent is something anybody legitimately deletes or rewrites. `trading_date`, the three rule
-- `effective_from` dates and both `shift_id` columns are all plain, and each column says why beside itself.
--
-- The principle is worth stating once because both referential actions fail here, for the same underlying
-- reason, and both failures were found by another unit's suite rather than by reading:
--
--   * **ON DELETE SET NULL arrives as an UPDATE**, and these tables refuse every UPDATE for every role. A
--     `source_shift_id` reference therefore made `delete from shift` impossible, so the draft roster — which
--     0030 exists to let anybody rewrite — could never be rewritten again.
--   * **ON DELETE RESTRICT pins the parent for ever**, because nothing here can be deleted to release it.
--     A reference to `business_day` stopped `generateBusinessDays` removing a date that had stopped trading,
--     and a reference to `working_hours_rule` stopped P-HR-05's suite emptying the rate table in a probe to
--     prove its reader throws rather than inventing rates.
--
-- 0077 recorded the first half for `pipeline_stage_transition.customer_id` ("an append-only log cannot
-- reference a mutable parent, because the cascade would fire the refusal trigger"). The second half is this
-- file's contribution to the same lesson. What IS still referenced: `employee_id`, because 0030 already
-- decided that deleting a person to erase their roster is a delete worth refusing; `message_id`, which
-- nothing deletes; and the self-references inside this file's own immutable tables, which nothing can.
--
-- ## What an OPEN SHIFT is, and why it needs no table
--
-- A `shift` row with no `shift_assignment` row. 0030 made them two tables precisely so one rostered span
-- can have n employees on it, and n = 0 is the open shift: a span the premises needs covered and nobody is
-- on yet. A `rota_open_shift` table would be a second way to say the same thing, and the two would
-- disagree the moment somebody inserted an assignment without clearing the flag.
--
-- ## Private SQLSTATEs
--
--   ZW001  published rota version or assignment is immutable; UPDATE or DELETE refused
--   ZW002  rota_change_request is append-only; UPDATE or DELETE refused
--   ZW003  the new version's assignment set is identical to the version it supersedes
--   ZW004  rota_publication_notice is append-only; UPDATE or DELETE refused
--   ZW005  the new version does not follow the one it supersedes: wrong period, or a gap in the numbering
--
-- Class `ZW` because the mnemonic letters are taken (`ZR` is the reschedule's, `ZS` the session's) and
-- what a private code has to be is unique to one file rather than memorable — 0077's reasoning verbatim.
--
-- See docs/OPEN-QUESTIONS.md Y9-coverage and Y9-overtime, and packages/core/src/hr/.

begin;

-- ---------------------------------------------------------------------------------------------
-- rota_coverage_rule — the versioned coverage and fatigue thresholds (Y9-coverage)
-- ---------------------------------------------------------------------------------------------
create table rota_coverage_rule (
  -- The first TRADING date this version governs, and the primary key for 0059's reason: two versions
  -- taking effect on one date is not a threshold change, it is an ambiguity, and the reader picks "the
  -- latest row at or before the trading date", which has no answer when two rows tie.
  --
  -- No foreign key into `business_day`: a rule commences on a calendar date whether or not the premises
  -- trades that day, and a coverage rule that could only commence on a trading day would be unrecordable
  -- for any change agreed over a closure.
  effective_from                   date     primary key,

  -- The grid the floor is counted on. 30 minutes because that is the granularity the acceptance criterion
  -- names and the one the booking slot grid already uses; a column rather than a constant because the
  -- segment length is a judgement about how short a gap in cover is allowed to be, and a rota validated on
  -- a 30-minute grid is not the same claim as one validated hourly.
  coverage_segment_minutes         smallint not null
    constraint rota_coverage_rule_segment_divides_an_hour
      check (coverage_segment_minutes in (10, 15, 20, 30, 60)),

  -- Therapists who must be on the floor for the WHOLE of every open segment. Therapists, not employees:
  -- a receptionist on shift covers no treatment, so counting assignments rather than therapists would
  -- report a fully covered floor with nobody able to deliver anything.
  minimum_therapists_on_floor      smallint not null
    constraint rota_coverage_rule_floor_minimum_is_positive
      check (minimum_therapists_on_floor >= 1),

  -- Of those, how many must be able to deliver a wet-room treatment, in every segment where the wet room
  -- is bookable. Zero is representable and is NOT the shipped value: it is what the owner sets if the bath
  -- is to be treated as ordinary cover.
  minimum_wet_room_capable         smallint not null
    constraint rota_coverage_rule_wet_minimum_not_above_floor
      check (minimum_wet_room_capable >= 0
         and minimum_wet_room_capable <= minimum_therapists_on_floor),

  -- The fatigue caps, per therapist per BUSINESS DAY. Treatment minutes, not rostered minutes: the cap is
  -- on hands-on work and a therapist rostered eight hours with four hours booked has worked four.
  treatment_minutes_cap_per_day    smallint not null
    constraint rota_coverage_rule_treatment_cap_plausible
      check (treatment_minutes_cap_per_day > 0 and treatment_minutes_cap_per_day <= 1440),
  -- The sub-cap: of the day's treatment minutes, how many may be high-intensity work.
  high_intensity_minutes_cap_per_day smallint not null
    constraint rota_coverage_rule_high_intensity_cap_within_total
      check (high_intensity_minutes_cap_per_day >= 0
         and high_intensity_minutes_cap_per_day <= treatment_minutes_cap_per_day),

  -- WHICH treatments the sub-cap applies to, by `service.treatment` code.
  --
  -- Seeded EMPTY, and that is the honest state rather than an oversight. Y9-coverage says "max 4 of them
  -- deep-tissue" and the catalogue contains no deep-tissue treatment: 0004's regulatory profile refuses
  -- "Therapeutic Deep Tissue" as a CLAIM on a service name, so no service is recorded as one and nothing
  -- in this database says which of the twelve is heavy work. Naming three of them here would be brief
  -- rule 15's mistake exactly — a plausible classification is indistinguishable from a configured one, and
  -- this one would silently refuse rotas or silently allow them depending on which way it guessed.
  --
  -- An empty array is VISIBLY unanswered: the sub-cap is inert, the Unconfirmed Assumptions panel says so,
  -- and the rule itself is fully implemented and fully tested in `packages/core/src/hr/rota-validator.ts`.
  -- Answering Y9-coverage is one row, not one unit.
  high_intensity_treatment_codes   text[]   not null default '{}'
    -- Every element is a lower-snake-case label and none is null or blank. Written as ONE scalar
    -- expression over the joined array because a CHECK constraint may not contain a subquery, and the
    -- `array_position` half is not redundant: array_to_string DROPS a null element silently, so the
    -- pattern alone would accept `{null}` as an empty list.
    constraint rota_coverage_rule_high_intensity_codes_are_labels
      check (array_position(high_intensity_treatment_codes, null::text) is null
         and array_to_string(high_intensity_treatment_codes, ',') ~ '^([a-z0-9_]+(,[a-z0-9_]+)*)?$'),

  -- The provenance trio every provisional row in this database carries, read by the Unconfirmed
  -- Assumptions panel exactly as it reads `app_setting` and `working_hours_rule`.
  is_provisional                   boolean  not null default true,
  provisional_note                 text,
  open_question_id                 text,
  constraint rota_coverage_rule_provisional_names_a_question
    check (not is_provisional or open_question_id is not null),
  source_note                      text     not null
    constraint rota_coverage_rule_source_note_not_placeholder
      check (not is_placeholder_text(source_note)),
  created_at                       timestamptz not null default now()
);

comment on table rota_coverage_rule is
  'Versioned coverage and fatigue thresholds: the segment grid, the floor minimum, the wet-room minimum '
  'and the two daily treatment-load caps. The version in force for a trading date is the row with the '
  'greatest effective_from at or before it, selected by rotaCoverageRulesFor() in @berelax/core. '
  'Versioned rather than held in app_setting because a rota is asked about the PAST: raising the floor '
  'minimum in April must not make March''s published rota retroactively non-compliant, and one current '
  'value cannot say what the threshold was when the rota was published.';
comment on column rota_coverage_rule.minimum_therapists_on_floor is
  'Therapists who must be present for the WHOLE of every open segment. Therapists and not employees: a '
  'receptionist on shift covers no treatment.';
comment on column rota_coverage_rule.high_intensity_treatment_codes is
  'The service.treatment codes the high-intensity sub-cap applies to. Seeded EMPTY: no treatment in the '
  'catalogue is recorded as heavy work and 0004 refuses "Therapeutic Deep Tissue" as a claim, so naming '
  'any of them here would be a guess indistinguishable from a decision (Y9-coverage, brief rule 15).';

-- ---------------------------------------------------------------------------------------------
-- Version 1 — the build's provisional answer to Y9-coverage, and every figure in it is a guess
-- ---------------------------------------------------------------------------------------------
-- docs/OPEN-QUESTIONS.md Y9-coverage carries "2 therapists on the floor; max 6 treatment-hours/day/
-- therapist, max 4 of them deep-tissue". Those three figures are taken as given; the other three are this
-- file's and each is the strictest reading available:
--
--   * `coverage_segment_minutes = 30` is the acceptance criterion's grid.
--   * `minimum_wet_room_capable = 1` is the manifest's provisional line ("at least 1 wet-room-capable
--     whenever the wet room is bookable"). Strict, and cheap to satisfy while both style skills reach a
--     wet-room service — see the note on capability in `readRotaCoverageInputs`.
--   * `high_intensity_treatment_codes` is EMPTY, which is the one figure here that is deliberately NOT
--     the strictest reading. The strictest would be "every treatment is heavy work", which turns the
--     240-minute sub-cap into the real daily cap and refuses rotas the owner has not been asked about;
--     the least strict is an invented list of three services. Empty is neither: it is visibly unanswered,
--     it refuses nothing, and it says so on the panel. Of the two errors available — refusing a rota for a
--     rule nobody set, or allowing one against a rule nobody set — only the first is attributed to the
--     build, and the second is already covered by the 360-minute total cap that IS set.
--
-- `effective_from` is 1900-01-01, the same sentinel 0059 uses and for the same reason: every other
-- candidate is a claim. A date visibly before any trading this business could have done says what is true —
-- the provisional thresholds govern every trading date the system knows about, and no version before them
-- exists.
insert into rota_coverage_rule (
  effective_from,
  coverage_segment_minutes,
  minimum_therapists_on_floor, minimum_wet_room_capable,
  treatment_minutes_cap_per_day, high_intensity_minutes_cap_per_day,
  high_intensity_treatment_codes,
  is_provisional, open_question_id, provisional_note, source_note
) values (
  date '1900-01-01',
  30,
  2, 1,
  360, 240,
  '{}',
  true, 'Y9-coverage',
  'Provisional and none of it confirmed: 2 therapists on the floor in every 30-minute segment, at least '
    || '1 of them able to deliver a wet-room treatment whenever the wet room is bookable, 6 treatment-'
    || 'hours a day per therapist and 4 of those hours high-intensity. The high-intensity TREATMENT LIST '
    || 'is empty, so the 240-minute sub-cap is inert: no service in the catalogue is recorded as heavy '
    || 'work and 0004 refuses "Therapeutic Deep Tissue" as a claim, so a list here would be invented.',
  'docs/OPEN-QUESTIONS.md Y9-coverage — provisional, strictest reading, no figure confirmed by the owner'
);

-- ---------------------------------------------------------------------------------------------
-- labour_cost_rule — the monthly-wage divisor, versioned (Y9-overtime, Y8-staff)
-- ---------------------------------------------------------------------------------------------
-- P-HR-05 stopped at `weightedMinuteBp`, whole basis-point-minutes, and its NOTE says why: turning that
-- into money needs a rate per minute, `employee.basic_wage_fils` is a MONTHLY figure, and the monthly-to-
-- hourly divisor is a policy question nobody has answered. This unit's acceptance criterion demands an
-- integer-fils forecast, so the divisor has to exist — and it exists HERE, as a versioned row with the
-- provenance trio, rather than as a constant in the arithmetic.
--
-- A separate table from `working_hours_rule` rather than two more columns on it. Two reasons, and the
-- second is the one that decided it. The divisor answers a different question from the multipliers (what
-- an hour of a monthly salary is worth, against what an uplift is), and it will be answered by a different
-- person. And `working_hours_rule` is 0059's table: a column added to it from here would put two units'
-- figures in one row, so confirming Y9-overtime's multipliers would mean publishing a version that also
-- restates a divisor nobody asked about.
create table labour_cost_rule (
  effective_from            date     primary key,

  -- Calendar days a monthly wage is taken to cover. 30, which is the MOHRE convention for converting a
  -- monthly wage to a daily one and is a convention rather than a figure anybody here has confirmed.
  -- Deliberately not 30.4375 or the actual length of the month: a divisor that varies by month makes the
  -- same shift cost different amounts in February and March, and the forecast would stop being comparable
  -- across the months an owner compares.
  monthly_wage_days_divisor smallint not null
    constraint labour_cost_rule_days_divisor_plausible
      check (monthly_wage_days_divisor between 1 and 31),

  -- Minutes a daily wage is taken to cover, which with the divisor above fixes the fils per ordinary
  -- minute. Stored here and NOT read from `working_hours_rule.ordinary_minutes_per_day`, although version 1
  -- carries the same 480: the ordinary-minutes figure is a CAP (the point a minute becomes overtime-
  -- eligible) and this one is a DENOMINATOR, and reading a cap as a denominator means that raising the
  -- daily cap to 9 hours would quietly make every hour cheaper. Two figures that happen to be equal.
  paid_minutes_per_day      smallint not null
    constraint labour_cost_rule_paid_minutes_plausible
      check (paid_minutes_per_day between 1 and 1440),

  is_provisional            boolean  not null default true,
  provisional_note          text,
  open_question_id          text,
  constraint labour_cost_rule_provisional_names_a_question
    check (not is_provisional or open_question_id is not null),
  source_note               text     not null
    constraint labour_cost_rule_source_note_not_placeholder
      check (not is_placeholder_text(source_note)),
  created_at                timestamptz not null default now()
);

comment on table labour_cost_rule is
  'Versioned divisors turning a MONTHLY employee.basic_wage_fils into a rate per worked minute, which is '
  'the one thing P-HR-05''s bucket arithmetic deliberately stops short of. Versioned for the reason '
  'working_hours_rule is: a forecast reproduced for last March must use March''s divisor. A forecast '
  'only - payroll pays attendance (P-HR-07), never this figure.';
comment on column labour_cost_rule.paid_minutes_per_day is
  'The DENOMINATOR, not the overtime cap. Equal to working_hours_rule.ordinary_minutes_per_day in '
  'version 1 and deliberately a separate figure: reading the cap as a denominator would make every hour '
  'cheaper the day somebody raised the daily cap.';

insert into labour_cost_rule (
  effective_from, monthly_wage_days_divisor, paid_minutes_per_day,
  is_provisional, open_question_id, provisional_note, source_note
) values (
  date '1900-01-01', 30, 480,
  true, 'Y9-overtime',
  'A monthly basic wage is taken to cover 30 calendar days of 480 paid minutes, so the ordinary rate is '
    || 'basic_wage_fils / 14400 per minute. The 30-day divisor is the MOHRE convention and the 480 '
    || 'matches working_hours_rule version 1''s ordinary day; neither is confirmed, and P-HR-05''s NOTE '
    || 'records that nobody has answered the monthly-to-hourly question at all.',
  'docs/OPEN-QUESTIONS.md Y9-overtime and Y8-staff — the monthly-to-hourly divisor, unanswered'
);

-- ---------------------------------------------------------------------------------------------
-- rota_version — one row per PUBLISHED rota, immutable
-- ---------------------------------------------------------------------------------------------
create table rota_version (
  id                                 uuid        primary key default uuid_generate_v7(),

  -- The trading dates the rota covers, inclusive at both ends. A trading date is a whole session, so a
  -- half-open range invites the off-by-one that drops the last day of the week — `readRosteredShifts`
  -- gives the same reason for the same shape.
  --
  -- NOT foreign-keyed into `business_day`, although every ASSIGNMENT's trading date is. The period is a
  -- label for what was published and its ends may fall on a closed date (a Monday-to-Sunday rota in a week
  -- the premises shuts on the Monday); refusing that would refuse a correct rota for the shape of its
  -- label. What must name a trading day is a shift, and that is constrained where it is true.
  from_trading_date                  date        not null,
  to_trading_date                    date        not null,
  constraint rota_version_period_ordered check (to_trading_date >= from_trading_date),

  -- Forward-only supersession. The new version points at the one it replaces; "the current version for a
  -- period" is the row nothing points at. UNIQUE, and that is the load-bearing part: two concurrent
  -- publishes both superseding version 3 would otherwise leave two rival current rotas, and nothing in the
  -- reader could pick between them. With it, the second publish is a database error.
  supersedes_id                      uuid        unique references rota_version (id) on delete restrict,
  constraint rota_version_does_not_supersede_itself check (supersedes_id is distinct from id),

  -- 1 for the first publication of a period, one more than its predecessor's afterwards. Enforced by
  -- `assert_rota_version_sequence` below rather than by a sequence, because a gap would read as a deleted
  -- version and nothing here is ever deleted.
  version_no                         integer     not null
    constraint rota_version_number_is_positive check (version_no >= 1),
  constraint rota_version_number_unique_per_period
    unique (from_trading_date, to_trading_date, version_no),

  -- The three rule versions that judged and priced this rota, snapshotted.
  --
  -- This is the whole point of versioning the thresholds. The row does not record "this rota was valid",
  -- which is a claim that decays the next time a threshold moves; it records "this rota satisfied THESE
  -- thresholds", which stays true.
  --
  -- Plain dates and NOT foreign keys, which is `source_shift_id`'s decision again and the principle behind
  -- both, stated once for the whole table: **a row in an immutable table records what was true, and holds
  -- nothing else hostage.** These three began as `on delete restrict` references and the consequence was
  -- general rather than incidental — `rota_version` can never be deleted, so any RESTRICT reference from it
  -- makes its parent undeletable for ever, for every caller, from the first rota published.
  -- `packages/fixtures/src/hr-working-hours.itest.ts` empties `working_hours_rule` inside a rolled-back
  -- probe to prove `readWorkingHoursRules` throws rather than inventing rates — a claim P-HR-05 needs — and
  -- this reference refused that delete and failed another unit's suite on the shared database.
  --
  -- The provenance is unaffected. The dates are recorded, `publishRota` reads them from these very tables in
  -- the same transaction so they exist by construction, and nothing about the record is weaker for the
  -- constraint being absent: what a reader wants from this row is which standard applied, not a guarantee
  -- that the standard's row is still on disk.
  coverage_rule_effective_from       date        not null,
  working_hours_rule_effective_from  date        not null,
  labour_cost_rule_effective_from    date        not null,

  -- The forecast at publication, in integer fils, VAT-free (a wage is not a supply). Stored rather than
  -- recomputed on read: the wages it was computed from are mutable, so a figure recomputed next month
  -- would answer a different question from the one the rota was approved against.
  forecast_labour_cost_fils          fils_nonneg not null,

  -- How many assigned employees had NO basic wage on file when the forecast was made.
  --
  -- NOT NULL and recorded on every version, because the alternative is the defect this column exists to
  -- prevent: an employee with no wage contributes nothing to a sum, so a forecast over a rota where no
  -- wage is recorded is 0 fils and reads as a free rota. All nineteen seeded employees have
  -- `basic_wage_fils` null — a wage is a fact about a person and the build does not invent one (brief rule
  -- 15) — so this is the ORDINARY state today, not an edge case. A screen that prints the forecast must
  -- print this beside it, and `renderRotaHtml` does.
  forecast_unpriced_employees        smallint    not null
    constraint rota_version_unpriced_count_nonneg check (forecast_unpriced_employees >= 0),

  -- The sha-256 of the assignment set's canonical text — `rotaAssignmentCanonicalForm()` in
  -- @berelax/core, hashed by `publishRota` in @berelax/db because packages/core hashes nothing
  -- (`booking-token.ts` takes a digest its caller computed, for the same reason). What makes
  -- "re-publishing an unchanged rota emits no notification" a property of the DATABASE rather than of
  -- whichever caller remembered to compare: `refuse_unchanged_rota_version` refuses an insert whose digest
  -- equals its predecessor's, so no version is created and therefore no notice row is either.
  --
  -- Not unique per period: a rota may legitimately return to an earlier arrangement after two edits, and
  -- only the IMMEDIATE predecessor is what "unchanged" means.
  assignment_digest                  text        not null
    constraint rota_version_digest_is_a_sha256_hex check (assignment_digest ~ '^[0-9a-f]{64}$'),

  published_at                       timestamptz not null default now(),
  -- A label, not a uuid: there is no admin session until W-SYS-01, and the audit row written in the same
  -- transaction carries the actor. Never a placeholder — a publication whose publisher is blank is a
  -- publication nobody is accountable for.
  published_by                       text        not null
    constraint rota_version_published_by_not_placeholder
      check (not is_placeholder_text(published_by) and btrim(published_by) <> ''),
  created_at                         timestamptz not null default now()
);

comment on table rota_version is
  'One PUBLISHED rota, immutable. There is no draft row and no status column: the draft is shift plus '
  'shift_assignment, which 0030 lets be rewritten freely. An edit to a published rota is a NEW version '
  'carrying supersedes_id, and unique(supersedes_id) is what makes a concurrent double-publish a '
  'database error rather than two rival current rotas.';
comment on column rota_version.assignment_digest is
  'sha-256 of rotaAssignmentCanonicalForm() in @berelax/core, hashed by publishRota in @berelax/db. '
  'refuse_unchanged_rota_version refuses an insert whose digest equals its predecessor''s, which is how '
  'an unchanged re-publish emits no staff notification: it creates no version at all.';
comment on column rota_version.forecast_unpriced_employees is
  'Assigned employees with no basic_wage_fils on file when the forecast was made. Recorded on every '
  'version because an unpriced employee contributes nothing to a sum, so a forecast over a rota of '
  'unpriced employees is 0 fils and reads as a free rota. All nineteen seeded employees are unpriced.';

create index rota_version_period_idx on rota_version (from_trading_date, to_trading_date, version_no desc);
-- "The current version", which is every read's first question: the row nothing supersedes. A partial index
-- on the supersession target is what makes that a lookup rather than an anti-join over the table.
create index rota_version_supersedes_idx on rota_version (supersedes_id)
  where supersedes_id is not null;

create table rota_version_assignment (
  rota_version_id uuid        not null references rota_version (id) on delete restrict,
  employee_id     uuid        not null references employee (id) on delete restrict,

  -- The trading date, snapshotted, and deliberately NOT foreign-keyed into `business_day` — which is the
  -- opposite of `shift.trading_date` one table along, and the difference is that a shift row is mutable and
  -- this one is not.
  --
  -- It began as a reference, on the reasoning that a published rota naming a date the premises does not
  -- trade is a roster error worth refusing. The reasoning was right and the place was wrong. `business_day`
  -- is GENERATED: `generateBusinessDays` deletes a row when a date stops trading and rewrites it when the
  -- hours change, and `packages/fixtures/src/business-days.itest.ts` empties the whole table in a
  -- `beforeEach` to prove it. Nothing in `rota_version_assignment` can ever be deleted, so a RESTRICT
  -- reference from it pins every trading date it names for ever — and one published rota made the business
  -- day generator unable to do its job, in eleven cases across another unit's suite.
  --
  -- The guard still exists where the row is mutable and a roster error is still fixable:
  -- `shift.trading_date` IS a foreign key (0030), and a published assignment is a copy of a draft that came
  -- through it. Refusing it a second time here bought nothing and cost the generator.
  trading_date    date        not null,

  -- The rostered span, copied from `shift.period`. The same three constraints 0030 puts on it, restated
  -- rather than inherited, because a snapshot with looser constraints than its source is a snapshot that
  -- can hold what the source refuses.
  period          tstzrange   not null,
  constraint rota_version_assignment_period_nonempty check (not isempty(period)),
  constraint rota_version_assignment_period_bounded
    check (lower(period) is not null and upper(period) is not null),
  constraint rota_version_assignment_period_half_open
    check (lower_inc(period) and not upper_inc(period)),

  -- The draft row this was published from. A plain uuid and deliberately NOT a foreign key, which is
  -- 0077's decision for `pipeline_stage_transition.customer_id` verbatim and for exactly its reason: an
  -- immutable table cannot reference a mutable parent. `on delete set null` would have been the obvious
  -- shape and it is unimplementable here — the cascade arrives as an UPDATE, `refuse_published_rota_change`
  -- refuses every UPDATE for every role, so `delete from shift` would become impossible and the roster
  -- could never be rewritten again. Found by `hr-rota.itest.ts`, whose own cleanup was the first thing the
  -- cascade broke.
  --
  -- Keeping the id after the draft is gone is the better record anyway: it says which row this span was
  -- published from, which stays true, where a nulled column says only that something was deleted.
  source_shift_id uuid,

  created_at      timestamptz not null default now(),

  -- One employee cannot be published twice onto the same span in the same version. Two identical rows
  -- would be counted twice by the coverage read and would double the forecast for that span.
  primary key (rota_version_id, employee_id, period)
);

comment on table rota_version_assignment is
  'The published rota, snapshotted: who, which trading date, which span. Copies rather than references '
  'shift_assignment, because shift_assignment.shift_id is ON DELETE CASCADE and a published rota that '
  'lost rows when a draft shift was deleted would not be immutable.';

create index rota_version_assignment_employee_idx
  on rota_version_assignment (employee_id, trading_date);
create index rota_version_assignment_date_idx
  on rota_version_assignment (rota_version_id, trading_date);

-- A trigger that RAISES rather than `create rule ... do instead nothing`, for 0018's reason: a rule
-- reports SUCCESS, so code that edited a published rota would believe it had corrected it. The whole unit
-- is that an edit is a new version, and code taking the other path has to be told, not humoured.
create function refuse_published_rota_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'A published rota version is immutable; % on % is refused. An edit to a published rota is a NEW '
    'rota_version carrying supersedes_id, which is what lets a swap, a sickness or a correction be seen '
    'as a change rather than as the rota having always said something else.',
    tg_op, tg_table_name
    using errcode = 'ZW001';
end $$;

comment on function refuse_published_rota_change() is
  'Raises ZW001 (PublishedRotaImmutable) for rota_version and rota_version_assignment, for every role '
  'including the owner. An edit is a new version, not an UPDATE of the old one.';

create trigger rota_version_no_update before update on rota_version
  for each row execute function refuse_published_rota_change();
create trigger rota_version_no_delete before delete on rota_version
  for each row execute function refuse_published_rota_change();
create trigger rota_version_assignment_no_update before update on rota_version_assignment
  for each row execute function refuse_published_rota_change();
create trigger rota_version_assignment_no_delete before delete on rota_version_assignment
  for each row execute function refuse_published_rota_change();

-- The version number and the period must follow from the predecessor, and both halves matter.
--
-- A version whose `version_no` did not follow its predecessor's would leave a gap that reads as a deleted
-- version, in a table where nothing is ever deleted. A version superseding one for a DIFFERENT period
-- would chain two unrelated rotas, so "the current version for this week" would return last week's.
create function assert_rota_version_sequence() returns trigger
language plpgsql
as $$
declare
  previous rota_version;
begin
  if new.supersedes_id is null then
    if new.version_no <> 1 then
      raise exception
        'A rota version that supersedes nothing is version 1 of its period, not %. A later version '
        'must name the one it replaces, or the chain the reader walks has no start.',
        new.version_no
        using errcode = 'ZW005';
    end if;
    return new;
  end if;

  select * into previous from rota_version where id = new.supersedes_id;
  if previous.from_trading_date <> new.from_trading_date
     or previous.to_trading_date <> new.to_trading_date then
    raise exception
      'Rota version % covers %..% and cannot supersede one covering %..%. Chaining two periods would '
      'make "the current version for this week" answer with another week''s rota.',
      new.id, new.from_trading_date, new.to_trading_date,
      previous.from_trading_date, previous.to_trading_date
      using errcode = 'ZW005';
  end if;
  if new.version_no <> previous.version_no + 1 then
    raise exception
      'Rota version numbering must be unbroken: superseding version % makes this one %, not %. A gap '
      'reads as a deleted version in a table where nothing is ever deleted.',
      previous.version_no, previous.version_no + 1, new.version_no
      using errcode = 'ZW005';
  end if;
  return new;
end $$;

comment on function assert_rota_version_sequence() is
  'Raises ZW005 when a new rota_version does not follow the one it supersedes: wrong period, or a gap in '
  'the version numbering. Version 1 is the row that supersedes nothing.';

create trigger rota_version_sequence_follows before insert on rota_version
  for each row execute function assert_rota_version_sequence();

-- The unchanged re-publish, refused at COMMIT.
--
-- A DEFERRED constraint trigger, and it has to be: the digest covers the assignment rows, which arrive one
-- INSERT at a time after the version row. An immediate trigger would compare a digest against a version
-- with no assignments yet and refuse every second publication ever made.
--
-- This is the acceptance criterion "re-publishing an unchanged version emits none", and putting it here
-- rather than in the publisher is deliberate. A caller-side comparison is one `if` away from being lost,
-- and what it would cost is a notification to every therapist on the rota saying it had changed when it
-- had not — the kind of message that teaches people to ignore the channel.
create function refuse_unchanged_rota_version() returns trigger
language plpgsql
as $$
declare
  previous_digest text;
begin
  if new.supersedes_id is null then return new; end if;
  select assignment_digest into previous_digest from rota_version where id = new.supersedes_id;
  if previous_digest = new.assignment_digest then
    raise exception
      'Rota version % has the same assignment set as the version it supersedes (digest %). Publishing it '
      'would notify every assigned therapist that a rota had changed when it had not, and a channel that '
      'says that is a channel people stop reading.',
      new.id, new.assignment_digest
      using errcode = 'ZW003';
  end if;
  return new;
end $$;

comment on function refuse_unchanged_rota_version() is
  'Raises ZW003 at COMMIT when a new rota_version''s assignment digest equals its predecessor''s. '
  'DEFERRED because the digest covers rows that arrive after the version row.';

create constraint trigger rota_version_changes_something
  after insert on rota_version
  deferrable initially deferred
  for each row execute function refuse_unchanged_rota_version();

-- ---------------------------------------------------------------------------------------------
-- rota_change_request — swaps and open-shift claims, append-only, decided in the same transaction
-- ---------------------------------------------------------------------------------------------
-- There is no `pending` state, and that is a scoping decision with a reason rather than a simplification.
-- A pending request needs an APPROVER, and there is no admin session until W-SYS-01 — so a pending row
-- would sit waiting for an identity that does not exist, and the first thing built on top of it would be a
-- way to approve without one. A request is therefore evaluated by the validator and either applied (which
-- publishes a new version, so the swap is visible where every other rota change is) or recorded as refused
-- with the rule that refused it.
--
-- The refused rows are the point of the table. "Why can't I swap with her on Thursday?" has one answer and
-- it is the rule name the validator returned; without this table the answer exists only in whatever the
-- screen said at the time.
create table rota_change_request (
  id                      uuid        primary key default uuid_generate_v7(),
  kind                    text        not null
    constraint rota_change_request_kind_known check (kind in ('swap', 'open_shift_claim')),

  -- The published version the request was made against. RESTRICT: the request only means something
  -- relative to the rota it was asked about.
  rota_version_id         uuid        not null references rota_version (id) on delete restrict,

  -- The span at issue: the DRAFT shift, because that is what a swap or a claim actually moves. A plain
  -- uuid and not a foreign key, for `rota_version_assignment.source_shift_id`'s reason — this table is
  -- append-only, so any referential action that arrives as an UPDATE hits ZW002 and makes deleting a draft
  -- shift impossible.
  shift_id                uuid,

  -- Who is giving the shift up, and who is taking it. A claim has no giver: an open shift is a `shift`
  -- row with no assignment, so there is nobody to take it from.
  from_employee_id        uuid        references employee (id) on delete restrict,
  to_employee_id          uuid        not null references employee (id) on delete restrict,
  constraint rota_change_request_swap_has_two_sides
    check ((kind = 'swap') = (from_employee_id is not null)),
  constraint rota_change_request_sides_differ
    check (from_employee_id is null or from_employee_id <> to_employee_id),

  decision                text        not null
    constraint rota_change_request_decision_known check (decision in ('applied', 'refused')),

  -- The rule that refused it, by the name `@berelax/core` returns. ROTA_RULE_NAMES in
  -- `packages/core/src/hr/rota-validator.ts` is the vocabulary and it has eight members:
  -- `minimum_floor_coverage`, `wet_room_capability`, `daily_treatment_load_cap`,
  -- `daily_high_intensity_load_cap`, `daily_overtime_cap`, `weekly_ordinary_cap`, `minimum_rest` and
  -- `credential_not_current`. Enumerated here rather than summarised, because a rule renamed in TypeScript
  -- and left alone in this comment leaves the migration describing a vocabulary that no longer exists —
  -- and `packages/fixtures/src/hr-rota.test.ts` reads both lists against each other, in both directions,
  -- so the enumeration is checked rather than decorative. A TEXT column and not an enum: the rule set is
  -- `packages/core`'s and a migration per new rule would put the vocabulary in two places, where 0053's
  -- note says a vocabulary about a judgement belongs in one.
  refused_rule            text,
  refusal_detail          text,
  -- Biconditionals both ways. A refusal with no rule is a refusal nobody can answer, and an applied
  -- request carrying one is a row two readers would count differently.
  constraint rota_change_request_refusal_names_a_rule
    check ((decision = 'refused') = (refused_rule is not null)),
  constraint rota_change_request_refusal_detail_follows_the_rule
    check (refused_rule is not null or refusal_detail is null),

  -- The version the application produced. Set for `applied` and nothing else.
  applied_rota_version_id uuid        unique references rota_version (id) on delete restrict,
  constraint rota_change_request_application_names_a_version
    check ((decision = 'applied') = (applied_rota_version_id is not null)),

  requested_by            text        not null
    constraint rota_change_request_requested_by_not_placeholder
      check (not is_placeholder_text(requested_by) and btrim(requested_by) <> ''),
  requested_at            timestamptz not null default now(),
  created_at              timestamptz not null default now()
);

comment on table rota_change_request is
  'Swaps and open-shift claims, append-only, each decided in the transaction that made it. No pending '
  'state: a pending request needs an approver and there is no admin session until W-SYS-01. A refused '
  'row carries the rule name @berelax/core returned, which is the only durable answer to "why was my '
  'swap refused".';

create index rota_change_request_version_idx on rota_change_request (rota_version_id, requested_at desc);
create index rota_change_request_employee_idx on rota_change_request (to_employee_id, requested_at desc);

create function refuse_rota_change_request_edit() returns trigger
language plpgsql
as $$
begin
  raise exception
    'rota_change_request is append-only; % is refused. A request that was refused stays refused: the '
    'remedy is a new request against the rota as it now stands, and rewriting the old one would erase '
    'the only record of what the validator said.',
    tg_op
    using errcode = 'ZW002';
end $$;

comment on function refuse_rota_change_request_edit() is
  'Raises ZW002 (RotaChangeRequestImmutable) for every role including the owner. A refused request is '
  'answered by a new request, not by editing the record of the old one.';

create trigger rota_change_request_no_update before update on rota_change_request
  for each row execute function refuse_rota_change_request_edit();
create trigger rota_change_request_no_delete before delete on rota_change_request
  for each row execute function refuse_rota_change_request_edit();

-- ---------------------------------------------------------------------------------------------
-- rota_publication_notice — one row per assigned employee per published version
-- ---------------------------------------------------------------------------------------------
-- The acceptance criterion is "publish emits one staff notification per assigned employee through a
-- transactional-class template, and re-publishing an unchanged version emits none". This table is what
-- "emits one" means, and it is a row rather than a `message` row for a reason 0075 already had to record:
-- **nothing in this build holds a staff contact detail.** `employee` has no phone and no email, there is
-- no `employee_contact` table, and inventing an address would be brief rule 15's mistake in the one place
-- it would actually send something to a stranger.
--
-- So a notice row is written for every assigned employee, addressed at the transactional template
-- `hr.rota_published`, and its outcome is `skipped` with `no_recipient_on_file` until a staff address
-- exists. That is deliberately not a no-op that reports success (docs/12 §1): the row says what was
-- attempted, for whom, against which template, and exactly why nothing left the building — which is
-- visible on the rota screen and countable by a test.
--
-- The second half of the criterion needs no code here at all: an unchanged re-publish creates no
-- `rota_version` (ZW003 above), and a notice row cannot exist without one.
create table rota_publication_notice (
  id              uuid        primary key default uuid_generate_v7(),
  rota_version_id uuid        not null references rota_version (id) on delete restrict,
  employee_id     uuid        not null references employee (id) on delete restrict,

  -- The template the notice is addressed at, and it must be a TRANSACTIONAL one. A rota is a fact about
  -- somebody's working week, so the marketing kill switch and the promotional sender identity must not be
  -- able to touch it; `template-corpus.test.ts` asserts the key's class, and the constraint here refuses
  -- the row rather than trusting the caller to have picked correctly.
  template_key    text        not null
    constraint rota_publication_notice_template_is_the_rota_one
      check (template_key = 'hr.rota_published'),

  outcome         text        not null
    constraint rota_publication_notice_outcome_known check (outcome in ('sent', 'skipped')),
  -- A CLOSED set, and `no_recipient_on_file` is the shipped state rather than an edge case.
  skipped_reason  text
    constraint rota_publication_notice_skipped_reason_known
      check (skipped_reason in ('no_recipient_on_file', 'send_refused')),
  constraint rota_publication_notice_skip_carries_a_reason
    check ((outcome = 'skipped') = (skipped_reason is not null)),

  -- The message, when one was produced. Nullable even for `sent`, for 0075's reason: F03 diverts every
  -- send to the local outbox outside production and writes no `message` row.
  message_id      uuid        references message (id) on delete restrict,
  constraint rota_publication_notice_skip_produced_no_message
    check (skipped_reason is null or message_id is null),

  notified_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),

  -- One notice per employee per version. This is the constraint the acceptance criterion's "one per
  -- assigned employee" rests on: an employee rostered on four days of the week is told once about the
  -- week, and a publisher that looped over assignments instead of employees would be refused here rather
  -- than sending four messages.
  constraint rota_publication_notice_one_per_employee_per_version
    unique (rota_version_id, employee_id)
);

comment on table rota_publication_notice is
  'One row per assigned employee per published rota version: the staff notification. UNIQUE on '
  '(version, employee) is what makes it one per employee rather than one per shift. Outcome is skipped '
  'with no_recipient_on_file today, because nothing in this build holds a staff phone or email and a '
  'plausible address would be indistinguishable from a configured one (brief rule 15).';

create index rota_publication_notice_employee_idx
  on rota_publication_notice (employee_id, notified_at desc);

create function refuse_rota_publication_notice_edit() returns trigger
language plpgsql
as $$
begin
  raise exception
    'rota_publication_notice is append-only; % is refused. It is the record that somebody was told '
    'their rota had changed, and a record of a notification that can be edited is not evidence anybody '
    'was told.',
    tg_op
    using errcode = 'ZW004';
end $$;

comment on function refuse_rota_publication_notice_edit() is
  'Raises ZW004 (RotaNoticeImmutable) for every role including the owner.';

create trigger rota_publication_notice_no_update before update on rota_publication_notice
  for each row execute function refuse_rota_publication_notice_edit();
create trigger rota_publication_notice_no_delete before delete on rota_publication_notice
  for each row execute function refuse_rota_publication_notice_edit();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 grants the application role select/insert/update/delete on every table created in `public`
-- afterwards and extends it to tables created later by default privileges, so these revokes are
-- load-bearing rather than decorative — and stated explicitly because a managed database restored from a
-- dump does not necessarily carry the same defaults.
--
-- The triggers above already refuse for every role. These are the second layer, the one that answers "you
-- may not" rather than "you tried", and TRUNCATE is the operation no row trigger can see: a truncated
-- rota_version table takes every published rota with it, and every notice that proves anybody was told.
revoke update, delete, truncate on rota_version from berelax_app;
revoke update, delete, truncate on rota_version_assignment from berelax_app;
revoke update, delete, truncate on rota_change_request from berelax_app;
revoke update, delete, truncate on rota_publication_notice from berelax_app;
-- The two rule tables are versioned by INSERT, exactly as working_hours_rule is: confirming Y9-coverage
-- publishes a new row and never edits the provisional one, because a published rota names the row that
-- judged it and editing that row would change what the rota is recorded as having satisfied.
revoke update, delete, truncate on rota_coverage_rule from berelax_app;
revoke update, delete, truncate on labour_cost_rule from berelax_app;

commit;
