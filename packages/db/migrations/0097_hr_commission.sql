-- 0097 — commission: the rule version that judged a run, and the run that cannot be recomputed into a
--        different answer.
--
-- P-HR-11's subject is REPRODUCIBILITY, and it is a narrower claim than it sounds. Anybody can compute a
-- commission figure. The thing that is hard, and the thing a therapist disputing a payslip needs, is that
-- the SAME period computed again — next month, next year, after the rates changed twice — comes back
-- byte-identical. Every defect this file exists to refuse is a way of quietly failing that:
--
--   1. **Recomputing from today's rules.** The version that judged a run is the version stored ON it. A
--      recompute that selects "the rule in force" answers with whatever is in force NOW, so a rate change
--      in June silently restates March. `commission_run.rule_version_id` is NOT NULL and
--      `commission_line` pins the SAME version through a composite foreign key rather than through a
--      second column somebody keeps in step.
--   2. **Editing a published rule.** A rate corrected in place makes every line ever computed from it
--      unreproducible, and nothing records that anything moved. Every table here refuses UPDATE and
--      DELETE for every role including the owner (ZY071, ZY072); a change is a NEW version naming the one
--      it supersedes.
--   3. **Recomputing a CLOSED period from rows that have since changed.** This is the one that looks like
--      it works. A late payment against a March invoice, or a sale backdated into March after March was
--      filed, changes what "completed and paid in March" means — so the recompute is correct arithmetic
--      over the wrong facts, and the figure differs from the one that was paid. `commission_run` therefore
--      stores `source_as_of`, the instant the source figures are READ at, and for a period a
--      `period_lock` covers that instant is the lock's own `locked_at` (ZY076). The run reads the books as
--      they stood when they were filed, which is what P-HR-07's timesheet lock does with hours and 0073's
--      trial-balance hash does with the ledger.
--   4. **A figure that does not follow from the rule it names.** A line could carry any `commission_fils`
--      at all and still satisfy every constraint above. `commission_fils_for()` is the arithmetic, in SQL,
--      and `assert_commission_line_follows_its_rule` (ZY077) holds every line to it — so "this line is
--      what version 1 says about this basis" is a property of the database rather than of whichever program
--      wrote the row.
--
-- The arithmetic and every judgement live in `packages/core/src/hr/commission.ts`, which is pure. This
-- migration supplies the two things a pure function may not contain: the FIGURES a commission is computed
-- from, and the record of what was computed.
--
--
-- ## No commission structure is configured, and this file invents none
--
-- `docs/OPEN-QUESTIONS.md` Y9-commission is open, and its provisional answer is not a rate: it is **"none
-- configured; the commission module ships disabled"**. So there is NO version 1 seeded here — unlike
-- `working_hours_rule` (0059), `leave_entitlement_rule` (0066), `rota_coverage_rule` (0081) and
-- `attendance_grace_rule` (0086), each of which seeds the build's strictest reading of a law that exists to
-- be read. There is no law about commission and no figure in the handover, so the strictest safe option is
-- the EMPTY table: with no version published, `commissionRuleFor` has nothing to return, the engine
-- produces zero lines, and nothing can be paid on a rate nobody chose. A seeded "10%" would be
-- indistinguishable from a configured one on the payslip that resulted, which is brief rule 15's whole
-- subject.
--
-- That is why this file's tests use a rule set the SUITE publishes. The deliverable is the mechanism with
-- the figures in a versioned row; every number in the tests is a fixture's, and none of them is in this
-- file or in TypeScript.
--
-- The module being off is `hr.commission_enabled` in the settings registry, default `false` and flagged
-- provisional against Y9-commission, so it appears on the Unconfirmed Assumptions panel beside the rule
-- versions themselves. A flag and not a missing table, because docs/12 §1.3 is explicit: the switch is
-- flipped by configuration, never by a code change.
--
--
-- ## Why the bands are rows on the version, and what the shape deliberately cannot express
--
-- Y9-commission asks whether the structure is "flat, tiered, service-dependent" and answers none of the
-- three. `commission_rule_band` is the smallest shape that can hold the two readings that are ARITHMETIC
-- rather than policy: one band from zero is a flat percentage, and several ascending bands are a tiered
-- one. The band is chosen by the value of the APPOINTMENT being commissioned.
--
-- Two other readings exist and this schema refuses to guess at either, which is stated here rather than
-- discovered later:
--
--   * A tier over the MONTH'S running total (the first 50,000 fils at one rate, the rest at another) is a
--     different rule, and a materially different one: the figure then depends on the ORDER the month is
--     walked in, so it needs a stated order to be reproducible at all.
--   * A per-SERVICE rate is a different rule again.
--
-- Either is a new column and a NEW version, never a reinterpretation of the rows already published — which
-- is the property that makes an answered question cheap. Both are recorded on Y9-commission as part of what
-- answering it must state.
--
--
-- ## The period lock has ONE reader, and this file does not add a second
--
-- "Is this date inside a closed accounting period?" is `period_lock_for()` (0018), redefined by 0073 to
-- name the earliest OPEN date too, and `periodStatusOn()` in `packages/db/src/services/period-close.ts`
-- is the one TypeScript reader of it. Nothing here re-answers it. `assert_commission_run_reads_the_lock`
-- CALLS `period_lock_for()`, and the repository reads `locked_at` off the lock that `periodStatusOn`
-- already named, BY PRIMARY KEY — which is a column of an identified row rather than a second answer to
-- which dates are closed.
--
--
-- ## Private SQLSTATEs: ZY071-ZY077
--
-- The CLASS no longer identifies a file (0091's header records why: four migrations reached for ZY001 in
-- one day because units pick classes independently). A refusal is identified by all five characters, and a
-- unit takes a SUBCLASS RANGE. This unit's band is ZY071-ZY080 and it takes seven of the ten:
--
--   ZY071  a commission_rule or commission_rule_band row was UPDATEd or DELETEd — a published version is
--          immutable, and a change is a new version
--   ZY072  a commission_run or commission_line row was UPDATEd or DELETEd — a run is evidence
--   ZY073  a version's bands do not cover the value range from zero upwards in ascending order
--   ZY074  a run's header total or line count does not equal its lines
--   ZY075  a run names a rule version that had not commenced when its period began
--   ZY076  a run over a locked period does not read the figures as at the lock, or an open period's run
--          names a lock
--   ZY077  a line's band, rate or figure does not follow from the rule version it names
--
-- ZY078-ZY080 are unused and are left to the next unit that needs a code in this band.
--
-- Seven and not one because each has a different runbook answer, which is the argument for a private code
-- (0061's, restated).
--
-- See docs/adr/0047-commission-reproducibility.md, docs/OPEN-QUESTIONS.md Y9-commission, and
-- packages/core/src/hr/commission.ts.

begin;

-- ---------------------------------------------------------------------------------------------
-- commission_rule — one published, immutable rule version
-- ---------------------------------------------------------------------------------------------
create table commission_rule (
  -- A uuid and not `effective_from` as the primary key, which is what 0059, 0081 and 0086 use for their
  -- versioned figures. The difference is that a commission LINE has to pin the version it was computed
  -- from for ever, and a date is the one key that a later correction of a commencement date would move
  -- under it. The date stays UNIQUE, so the ambiguity those files refuse — two versions taking effect on
  -- one date, which makes "the latest row at or before this date" have no answer — is still refused.
  id             uuid        primary key default uuid_generate_v7(),

  -- The version number, monotonic from 1. Carried as data rather than derived by counting rows, because
  -- every reader of a run wants to print "computed under version 3" and a count is not that: delete
  -- nothing and insert nothing out of order and the two agree, which is exactly the state that ends.
  version        integer     not null
                   constraint commission_rule_version_starts_at_one check (version >= 1),

  -- The first TRADING date this version governs. No foreign key into `business_day`: a rate commences on
  -- a calendar date whether or not the premises trades that day, and 0081 and 0086 give the same reason
  -- for the same shape. An append-only table must not pin the generated calendar either — P-HR-06 found
  -- that as eleven failures in a suite it did not own, and 0086 records it.
  effective_from date        not null,

  -- WHICH figure the percentage applies to. A column and not a constant, because "commission on net or on
  -- gross" is a business fact nobody has stated: VAT is not the salon's money, so net is the defensible
  -- reading, and a business that has always paid on the gross till value would be owed the other. Neither
  -- is guessed here — the column is NOT NULL with no default, so a version cannot be published without
  -- someone saying which.
  basis          text        not null
                   constraint commission_rule_basis_known
                     check (basis in ('net_of_vat', 'gross_inclusive')),

  -- The rounding direction, stated rather than inherited from whatever the arithmetic happens to do.
  --
  -- This is the acceptance criterion "an explicit asserted rounding direction" as a FIGURE on the version
  -- rather than as a constant in code. It matters by one fil per line and therefore by real money over a
  -- month, and the two available answers are both defensible: `floor` never overpays, `half_up` is what a
  -- spreadsheet does. A version names one, `commission_fils_for()` implements exactly these two, and a
  -- third would be a new member and a new version.
  rounding_mode  text        not null
                   constraint commission_rule_rounding_mode_known
                     check (rounding_mode in ('floor', 'half_up')),

  -- The version this one replaces, or null for the first. The same shape `rota_version` (0081) and
  -- `publication_record` (0093) use, and for their reason: a superseded version must stay READABLE,
  -- because the runs it judged still name it. Superseded-ness is therefore DERIVED — a version is
  -- superseded when a later one names it — rather than a column an UPDATE would have to set, which this
  -- table refuses.
  supersedes_id  uuid        references commission_rule (id) on delete restrict
                   constraint commission_rule_cannot_supersede_itself
                     check (supersedes_id is null or supersedes_id <> id),

  published_at   timestamptz not null default now(),
  published_by_actor_kind text not null
                   constraint commission_rule_publisher_kind_known
                     check (published_by_actor_kind in ('staff', 'system')),
  published_by_actor_id   uuid,

  -- The provenance trio every provisional row in this database carries, read by the Unconfirmed
  -- Assumptions panel exactly as it reads `working_hours_rule` and `attendance_grace_rule`.
  is_provisional boolean     not null default true,
  provisional_note text,
  open_question_id text,
  constraint commission_rule_provisional_names_a_question
    check (not is_provisional or open_question_id is not null),
  source_note    text        not null
                   constraint commission_rule_source_note_not_placeholder
                     check (not is_placeholder_text(source_note)),

  -- Two versions on one commencement date is not a change of policy, it is an ambiguity: the reader picks
  -- "the latest version at or before the trading date" and that has no answer when two rows tie.
  constraint commission_rule_one_version_per_date unique (effective_from),
  constraint commission_rule_version_unique unique (version)
);

comment on table commission_rule is
  'One published commission rule version: which figure a percentage applies to, how it rounds, and (in '
  'commission_rule_band) the rates. Append-only and IMMUTABLE — UPDATE and DELETE raise (ZY071) for every '
  'role including the owner — because a commission_line names the version that judged it and an edited '
  'version makes every line computed from it unreproducible. A change is a NEW version naming the one it '
  'supersedes. NOTHING IS SEEDED: Y9-commission is open and its provisional answer is "none configured", '
  'so an empty table is the strictest safe option and the engine produces zero lines.';
comment on column commission_rule.basis is
  'Whether a percentage applies to the net or the VAT-inclusive gross. NOT NULL with no default: nobody '
  'has stated which, and a default would be a guess indistinguishable from a decision.';
comment on column commission_rule.rounding_mode is
  'floor or half_up, stated on the version. One fil per line and real money over a month, and both '
  'answers are defensible, so the version names one rather than the code assuming one.';
comment on column commission_rule.supersedes_id is
  'The version this one replaces. Superseded-ness is DERIVED from a later version naming this one, not '
  'stored, because a column saying so would need an UPDATE and this table refuses every UPDATE.';

create index commission_rule_effective_from_idx on commission_rule (effective_from);

-- ---------------------------------------------------------------------------------------------
-- commission_rule_band — the rates of one version
-- ---------------------------------------------------------------------------------------------
-- Rows and not columns, so that flat and tiered are the same mechanism: one band from zero is a flat
-- percentage. Basis points and never a percentage or a decimal — 0059's multipliers, 0026's VAT rate and
-- 0083's release rate all use bp for the reason ADR 0007 gives about floats, and a "rate" that is 0.125
-- is a float in a costume.
create table commission_rule_band (
  rule_version_id uuid       not null references commission_rule (id) on delete restrict,

  -- Position within the version, from 1. The bands are ORDERED, and the order is data rather than the
  -- result of sorting on `from_fils` at read time: a reader that re-sorted would silently repair a
  -- version whose bands were entered in the wrong order, and the repair is what makes the wrong version
  -- undetectable.
  band_no        smallint    not null
                   constraint commission_rule_band_no_starts_at_one check (band_no >= 1),

  -- The inclusive lower bound of the appointment value this band's rate applies to, in integer fils. The
  -- band's upper bound is the next band's `from_fils`, and the last band has none — stated as an absence
  -- rather than as a sentinel, because a sentinel maximum is a figure somebody has to choose.
  from_fils      bigint      not null
                   constraint commission_rule_band_from_is_nonneg check (from_fils >= 0),

  rate_bp        integer     not null
                   constraint commission_rule_band_rate_bounded check (rate_bp between 0 and 10000),

  created_at     timestamptz not null default now(),

  constraint commission_rule_band_pk primary key (rule_version_id, band_no),
  -- Two bands starting at the same value is the same ambiguity two versions on one date would be.
  constraint commission_rule_band_one_per_threshold unique (rule_version_id, from_fils)
);

comment on table commission_rule_band is
  'The rates of one commission rule version, as ordered rows: one band from zero is a flat percentage and '
  'several ascending bands are a tiered one. Append-only and immutable with its version — UPDATE and '
  'DELETE raise (ZY071). The band applies to the value of the APPOINTMENT; a tier over the month''s '
  'running total and a per-service rate are different rules and a new version, recorded on Y9-commission.';
comment on column commission_rule_band.from_fils is
  'Inclusive lower bound of the appointment value in integer fils. The upper bound is the next band''s '
  'from_fils, and the last band has none — an absence rather than a sentinel maximum somebody chose.';

-- ---------------------------------------------------------------------------------------------
-- The bands cover the range from zero upwards, in ascending order
-- ---------------------------------------------------------------------------------------------
-- Without this, a version whose lowest band starts at 5,000 fils has NO rate for a 4,000-fil treatment,
-- and every reader then decides what to do about it — most plausibly by charging zero, which is a
-- therapist silently not paid for the cheapest appointments. With it, "some band applies" is true by
-- construction and the engine has no unanswered case to invent behaviour for.
--
-- A constraint trigger, DEFERRED, because the rule is about the SET of a version's bands and the rows
-- arrive one INSERT at a time: an immediate check would refuse band 2 on its way to a version that is
-- correct once band 3 lands. 0093's audit-row trigger is deferred for the same structural reason.
create function assert_commission_bands_cover_from_zero() returns trigger
language plpgsql
as $$
declare
  v_version    integer;
  v_count      integer;
  v_lowest     bigint;
  v_out_of_order integer;
begin
  select r.version into v_version from commission_rule r where r.id = new.rule_version_id;

  -- The version may be gone: nothing can DELETE a rule row, so this is unreachable through any statement
  -- the database permits. It is answered rather than asserted because a null `v_version` in the messages
  -- below would print "version <NULL>" and send somebody looking for a version number instead of a bug.
  if v_version is null then
    raise exception
      'CommissionBandOrphaned: band % names rule version % , which does not exist.',
      new.band_no, new.rule_version_id using errcode = 'ZY073';
  end if;

  select count(*), min(from_fils) into v_count, v_lowest
    from commission_rule_band where rule_version_id = new.rule_version_id;

  if v_count = 0 or v_lowest <> 0 then
    raise exception
      'CommissionBandsLeaveAGap: commission rule version % has % band(s) and its lowest starts at % '
      'fils, so no rate applies below that. An appointment in the gap would be commissioned at whatever '
      'the reader decided, which is a therapist quietly unpaid for the cheapest treatments. Band 1 must '
      'start at 0.',
      v_version, v_count, coalesce(v_lowest, 0) using errcode = 'ZY073';
  end if;

  -- `band_no` ascending must mean `from_fils` ascending. Counted with a window function rather than
  -- compared pairwise in plpgsql: one scan, and the count is what the message can print.
  select count(*) into v_out_of_order from (
    select from_fils, lag(from_fils) over (order by band_no) as previous
      from commission_rule_band where rule_version_id = new.rule_version_id
  ) ordered
   where previous is not null and from_fils <= previous;

  if v_out_of_order > 0 then
    raise exception
      'CommissionBandsOutOfOrder: commission rule version % has % band(s) whose from_fils does not '
      'exceed the band before it. The bands are ordered by band_no and the thresholds must ascend with '
      'it; a reader that re-sorted them would silently repair a version somebody entered wrongly.',
      v_version, v_out_of_order using errcode = 'ZY073';
  end if;

  return null;
end $$;

comment on function assert_commission_bands_cover_from_zero() is
  'Raises ZY073 when a version''s bands do not start at 0 or do not ascend with band_no. DEFERRED, '
  'because the rule is about the SET and the rows arrive one INSERT at a time.';

create constraint trigger commission_rule_band_covers_from_zero
  after insert on commission_rule_band
  deferrable initially deferred
  for each row execute function assert_commission_bands_cover_from_zero();

-- ---------------------------------------------------------------------------------------------
-- commission_fils_for — the arithmetic, in SQL, so the database can hold a line to its rule
-- ---------------------------------------------------------------------------------------------
-- In SQL as well as in `packages/core/src/hr/commission.ts`, and the duplication is deliberate for
-- `package_release_through_fils()`'s reason (0083): the formula is EVIDENCE, and evidence only one program
-- can reproduce is evidence about the program. A `psql` session recomputing a therapist's March has to get
-- the same figure, and the trigger below cannot reach TypeScript. The two implementations are held equal
-- over a bounded CENSUS in `packages/fixtures/src/hr-commission.itest.ts` — not a sample, because "these
-- two agree" checked on random inputs is a claim about the seed.
--
-- `bigint` throughout and integer division, never numeric and never a float. `p_basis_fils * p_rate_bp` is
-- at most 10^4 times the basis, so a 100,000,000-fil appointment reaches 10^12 — inside bigint by nine
-- orders of magnitude, and the reason the intermediate is not divided first: dividing by 10,000 before
-- multiplying is how a 1% rate on 9,900 fils becomes 0 instead of 99.
create function commission_fils_for(
  p_basis_fils bigint,
  p_rate_bp integer,
  p_rounding_mode text
) returns bigint
language plpgsql
immutable
as $$
begin
  if p_basis_fils < 0 then
    raise exception
      'CommissionBasisNegative: a commission basis of % fils is not a value. A refund is a reversal, '
      'never a negative line.', p_basis_fils using errcode = 'ZY077';
  end if;

  -- Integer division in PostgreSQL truncates toward zero, and the basis is non-negative here, so this IS
  -- a floor. Written as a division rather than as `floor(... / 10000.0)`, which would go through double
  -- precision and is the float-money mistake in a costume.
  if p_rounding_mode = 'floor' then
    return (p_basis_fils * p_rate_bp) / 10000;
  end if;

  if p_rounding_mode = 'half_up' then
    return (p_basis_fils * p_rate_bp + 5000) / 10000;
  end if;

  -- Not a fall-through to a default. A rounding mode nobody implemented must not silently become one of
  -- the two that exist; the CHECK on commission_rule.rounding_mode makes this unreachable through the
  -- table, and a future third member added there without being added here fails loudly instead.
  raise exception
    'CommissionRoundingModeUnknown: "%" is not a rounding mode this function implements. The modes are '
    'floor and half_up; a new one is a new member of commission_rule.rounding_mode AND a branch here.',
    p_rounding_mode using errcode = 'ZY077';
end $$;

comment on function commission_fils_for(bigint, integer, text) is
  'Commission in integer fils for a basis and a rate in basis points, rounded as the rule version says. '
  'Integer arithmetic throughout: the multiplication happens BEFORE the division, because dividing first '
  'turns 1% of 9,900 fils into 0. Mirrored by commissionFilsFor in @berelax/core and held equal to it '
  'over a census by packages/fixtures/src/hr-commission.itest.ts, for the reason 0083 gives.';

-- ---------------------------------------------------------------------------------------------
-- commission_run — one computation of one period under one version
-- ---------------------------------------------------------------------------------------------
create table commission_run (
  id                uuid        primary key default uuid_generate_v7(),

  -- THE pin. NOT NULL, so a run cannot exist without naming the version that judged it, and
  -- `on delete restrict` is belt-and-braces over a table nothing can delete from anyway.
  rule_version_id   uuid        not null references commission_rule (id) on delete restrict,

  period_starts_on  date        not null,
  period_ends_on    date        not null,

  -- The instant the SOURCE FIGURES are read at, and the reason this table can be recomputed.
  --
  -- Every earning this run considered had to exist at this instant: the read filters on `created_at <=
  -- source_as_of` for the appointment, the document and the payments. So a payment that arrives later, or
  -- a sale backdated into the period after the fact, cannot change the answer — which is what makes
  -- "recomputing reproduces every line byte-identically" a property rather than a hope.
  --
  -- For a period a `period_lock` covers this is the LOCK's own `locked_at`, held by ZY076 below. For an
  -- open period it is whatever instant the run was computed at, stored so the recompute can use it.
  source_as_of      timestamptz not null,

  -- The lock whose figures this run read, or null when the period was open. A column and not a
  -- re-derivation, because `period_lock` rows can be added later: a run computed over an open March and a
  -- run computed after March was filed are different facts about the same period, and a reader deriving
  -- the answer now would report the first as the second.
  locked_period_id  text        references period_lock (period_id) on delete restrict,

  -- Whether the module was ENABLED when this ran. Recorded, because a run that produced no lines because
  -- the module is off and a run that produced no lines because nobody worked are the same empty table and
  -- very different facts — and the first must never be reported as "no commission is due".
  module_enabled    boolean     not null,

  -- The header figures, held to the lines by ZY074. Carried rather than summed at read time so that the
  -- derivation view has something to reconcile AGAINST: a total that is a sum of the same rows cannot
  -- disagree with them, and cannot catch a line that was never written either.
  total_fils        bigint      not null
                      constraint commission_run_total_is_nonneg check (total_fils >= 0),
  line_count        integer     not null
                      constraint commission_run_line_count_is_nonneg check (line_count >= 0),

  computed_at       timestamptz not null default now(),
  computed_by_actor_kind text   not null
                      constraint commission_run_computed_by_kind_known
                        check (computed_by_actor_kind in ('staff', 'system')),
  computed_by_actor_id   uuid,

  constraint commission_run_period_ends_on_or_after_it_starts
    check (period_ends_on >= period_starts_on),
  -- What `commission_line`'s composite foreign key points at. A line cannot name a version its run does
  -- not name, so the pin on the line is the SAME fact rather than a copy of it that drifts.
  constraint commission_run_rule_version_pin unique (id, rule_version_id)
);

comment on table commission_run is
  'One computation of one period under one rule version. Append-only — UPDATE and DELETE raise (ZY072) — '
  'because a run is the evidence behind a payslip. rule_version_id is the pin that makes a recompute '
  'reproduce rather than restate: the version that judged a run is the version stored on it, never the '
  'one in force today. source_as_of is the instant the source figures were read at, and for a locked '
  'period it is the lock''s own locked_at (ZY076), so a late payment or a backdated sale cannot move a '
  'figure that has been paid.';
comment on column commission_run.source_as_of is
  'The instant the source figures were read at. Every earning considered existed at it, so a recompute '
  'sees the same rows. For a locked period this is the lock''s locked_at — the books as filed.';
comment on column commission_run.module_enabled is
  'Whether the commission module was enabled when this ran. Recorded because "no lines because the '
  'module is off" and "no lines because nobody worked" are the same empty table and different facts.';

create index commission_run_period_idx on commission_run (period_starts_on, period_ends_on);
create index commission_run_version_idx on commission_run (rule_version_id);

-- ---------------------------------------------------------------------------------------------
-- commission_line — one appointment's commission, under the run's version
-- ---------------------------------------------------------------------------------------------
create table commission_line (
  id                    uuid        primary key default uuid_generate_v7(),
  run_id                uuid        not null references commission_run (id) on delete restrict,

  -- The acceptance criterion, literally: "every commission_line stores the rule_version_id it was
  -- computed from (NOT NULL constraint)". It is NOT a second statement of the run's version that somebody
  -- keeps in step — the composite foreign key below makes the two the same fact, so a line naming a
  -- different version is `23503` against a named constraint rather than a disagreement nobody notices.
  rule_version_id       uuid        not null,

  -- Who is owed it. A foreign key, unlike `appointment_id` below, because a commission line is about an
  -- EMPLOYMENT record and there is no reading of this table that survives the employee going.
  employee_id           uuid        not null references employee (id) on delete restrict,

  -- Plain uuid, NO foreign key, for `invoice_appointment`'s reason (0063): PostgreSQL refuses `truncate
  -- appointment` while a referencing table is absent from the statement, and four suites truncate it by
  -- list. The UNIQUE below still bites, because it constrains the id.
  appointment_id        uuid        not null,

  -- WHERE the money came from. Two sources and they are priced differently, which is why this is a
  -- vocabulary and not an inference from which id is null: a redemption is commissioned on the value
  -- RECOGNISED when the treatment was delivered, and a till sale on the invoice line.
  source                text        not null
                          constraint commission_line_source_known
                            check (source in ('invoice_line', 'package_redemption')),

  invoice_id            uuid        references invoice (id) on delete restrict,
  package_redemption_id uuid        references package_redemption (id) on delete restrict,

  -- The trading date the appointment belonged to. Materialised from the appointment rather than derived
  -- from a timestamp here: trading runs 11:00-02:00, so a 01:30 treatment belongs to the PREVIOUS trading
  -- date and a truncation moves it into the next month and the next commission period. No foreign key
  -- into `business_day`, because this table is append-only and a reference from it would pin every
  -- trading date it names for ever — 0086 records what that cost.
  trading_date          date        not null,

  -- The figure the rate was applied to, in integer fils: the net or the gross of the source document,
  -- depending on the version's `basis`.
  basis_fils            bigint      not null
                          constraint commission_line_basis_is_nonneg check (basis_fils >= 0),

  -- The band that applied and its rate, snapshotted. Stored rather than looked up at read time so that
  -- "why is this line 1,250 fils" is one row with no join, and so that ZY077 has something to check.
  band_no               smallint    not null
                          constraint commission_line_band_no_starts_at_one check (band_no >= 1),
  rate_bp               integer     not null
                          constraint commission_line_rate_bounded check (rate_bp between 0 and 10000),

  commission_fils       bigint      not null
                          constraint commission_line_is_nonneg check (commission_fils >= 0),

  created_at            timestamptz not null default now(),

  -- One line per appointment per run. Not per appointment outright: the same month may be recomputed, and
  -- a second run of it is a second set of lines whose whole purpose is to be compared with the first.
  constraint commission_line_once_per_run unique (run_id, appointment_id),

  constraint commission_line_pins_its_runs_rule_version
    foreign key (run_id, rule_version_id) references commission_run (id, rule_version_id),

  constraint commission_line_source_names_its_document check (
    (source = 'invoice_line' and invoice_id is not null and package_redemption_id is null) or
    (source = 'package_redemption' and package_redemption_id is not null and invoice_id is null)
  ),

  -- A commission over the value it is computed from is arithmetic nobody meant. `rate_bp <= 10000` makes
  -- this redundant for a correct figure and that is the point: it is the cheapest statement of the bound
  -- that still holds when the trigger below is disabled by a restore.
  constraint commission_line_not_more_than_its_basis check (commission_fils <= basis_fils)
);

comment on table commission_line is
  'One appointment''s commission under one run''s rule version. Append-only — UPDATE and DELETE raise '
  '(ZY072). rule_version_id is NOT NULL and is held EQUAL to the run''s by a composite foreign key, so '
  'the pin is one fact rather than a copy that drifts. The band, the rate and the basis are snapshotted '
  'so that "why is this figure" is one row with no join, and ZY077 holds all three to the version named.';
comment on column commission_line.source is
  'invoice_line or package_redemption. A vocabulary and not an inference from which id is null, because '
  'the two are priced differently: a redemption is commissioned on the value RECOGNISED when the '
  'treatment was delivered, never on the package sale value.';
comment on column commission_line.appointment_id is
  'No foreign key, deliberately, for invoice_appointment''s reason (0063): PostgreSQL refuses `truncate '
  'appointment` while a referencing table is absent from the statement and four suites truncate it by '
  'list. The UNIQUE on (run_id, appointment_id) still bites, because it constrains the id.';

create index commission_line_run_idx on commission_line (run_id);
create index commission_line_employee_day_idx on commission_line (employee_id, trading_date);

-- ---------------------------------------------------------------------------------------------
-- ZY071 / ZY072 — the published version and the run are immutable
-- ---------------------------------------------------------------------------------------------
-- Two functions and not one, because the two refusals have different runbook answers: a rate that is
-- wrong is corrected by PUBLISHING A NEW VERSION, and a run that is wrong is corrected by RUNNING THE
-- PERIOD AGAIN. Telling somebody the first when they meant the second sends them to change a rate.
--
-- BEFORE triggers rather than privileges alone. The revokes below cover the application role, and a
-- migration, a `psql` session and a restore do not connect as it — 0018's wording, and it is the half of
-- "immutable" that a convention cannot hold.
create function refuse_commission_rule_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'CommissionRuleIsImmutable: % is a published commission rule and % is refused. A rate that is wrong '
    'is corrected by publishing a NEW version naming this one as superseded — never by editing this one, '
    'because every commission_line computed from it names it and would stop reproducing.',
    tg_table_name, tg_op
    using errcode = 'ZY071';
end $$;

comment on function refuse_commission_rule_change() is
  'Raises ZY071 for every UPDATE and DELETE on commission_rule and commission_rule_band, for EVERY role '
  'including the owner. Separate from refuse_commission_run_change() because the remedy is different: a '
  'new VERSION, not a new RUN.';

create function refuse_commission_run_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'CommissionRunIsImmutable: % is the evidence behind a payslip and % is refused. A run that is wrong '
    'is corrected by computing the period AGAIN, which is a new run and a new set of lines to compare '
    'with the first — never by editing the figures somebody was already paid.',
    tg_table_name, tg_op
    using errcode = 'ZY072';
end $$;

comment on function refuse_commission_run_change() is
  'Raises ZY072 for every UPDATE and DELETE on commission_run and commission_line, for EVERY role '
  'including the owner.';

create trigger commission_rule_no_update before update on commission_rule
  for each row execute function refuse_commission_rule_change();
create trigger commission_rule_no_delete before delete on commission_rule
  for each row execute function refuse_commission_rule_change();
create trigger commission_rule_band_no_update before update on commission_rule_band
  for each row execute function refuse_commission_rule_change();
create trigger commission_rule_band_no_delete before delete on commission_rule_band
  for each row execute function refuse_commission_rule_change();
create trigger commission_run_no_update before update on commission_run
  for each row execute function refuse_commission_run_change();
create trigger commission_run_no_delete before delete on commission_run
  for each row execute function refuse_commission_run_change();
create trigger commission_line_no_update before update on commission_line
  for each row execute function refuse_commission_run_change();
create trigger commission_line_no_delete before delete on commission_line
  for each row execute function refuse_commission_run_change();

-- ---------------------------------------------------------------------------------------------
-- ZY075 — a run may not be judged by a version that had not commenced
-- ---------------------------------------------------------------------------------------------
-- The failure this refuses is not a typo, it is the shape a "helpful" recompute takes: somebody reruns
-- March, the code picks the newest version because that is the one it can see, and March is restated at
-- June's rates. A version that commenced AFTER the period began cannot have judged it, and that is a fact
-- the database can hold.
--
-- Note what this deliberately does NOT assert: that no LATER version also applies. A version published
-- with a retroactive commencement date is a real thing, and refusing a run that names the older version
-- would make the historical record unwritable. WHICH version governs a date is
-- `commissionRuleFor` in @berelax/core — one definition, in the pure layer, over the versions handed to
-- it — and a run states the answer rather than re-deriving it.
create function assert_commission_run_version_had_commenced() returns trigger
language plpgsql
as $$
declare
  v_effective_from date;
  v_version        integer;
begin
  select effective_from, version into v_effective_from, v_version
    from commission_rule where id = new.rule_version_id;

  if v_effective_from > new.period_starts_on then
    raise exception
      'CommissionRuleNotYetInForce: commission rule version % commences on % and this run covers % to '
      '%. A version that had not commenced when the period began cannot have judged it — which is what '
      'a recompute reaching for "the current rules" produces, and it restates a period that has already '
      'been paid.',
      v_version, v_effective_from, new.period_starts_on, new.period_ends_on
      using errcode = 'ZY075';
  end if;

  return new;
end $$;

comment on function assert_commission_run_version_had_commenced() is
  'Raises ZY075 when a run names a rule version whose effective_from is after the period start. It does '
  'NOT refuse a run naming an older version when a newer one also applies: a retroactive commencement is '
  'real, and refusing that would make the historical record unwritable.';

create trigger commission_run_version_had_commenced before insert on commission_run
  for each row execute function assert_commission_run_version_had_commenced();

-- ---------------------------------------------------------------------------------------------
-- ZY076 — a run over a locked period reads the figures AS FILED
-- ---------------------------------------------------------------------------------------------
-- The trap this unit exists for. A commission run over a closed month must read what the books said when
-- they were closed, not what they say now, and the difference arrives silently: a payment applied after
-- the close, or a sale backdated into the month, makes "completed and paid in March" a larger set than it
-- was — so the recompute is correct arithmetic over facts that postdate the payslip.
--
-- `period_lock_for()` is called and not re-implemented: it is 0018's one definition of "is this date
-- closed", redefined by 0073, and reached by every posting guard in this database. This trigger is not a
-- second reader of the lock, it is another caller of the one reader.
--
-- The period END is what is tested, and deliberately. A commission period is a month and a lock covers a
-- month, so the two coincide; where they do not, the end date is the one that decides whether the figures
-- have been filed — a period whose last day is closed has had its takings counted.
create function assert_commission_run_reads_the_lock() returns trigger
language plpgsql
as $$
declare
  v_period_id text;
  v_locked_at timestamptz;
begin
  v_period_id := period_lock_for(new.period_ends_on);

  if v_period_id is null then
    if new.locked_period_id is not null then
      raise exception
        'CommissionRunNamesNoSuchLock: this run names locked period "%" but no lock covers %. An open '
        'period''s figures are read at the instant the run was computed, and naming a lock would claim '
        'the run reads books that have been filed.',
        new.locked_period_id, new.period_ends_on using errcode = 'ZY076';
    end if;
    return new;
  end if;

  if new.locked_period_id is distinct from v_period_id then
    raise exception
      'CommissionRunIgnoresTheLock: % is inside closed accounting period "%" and this run names %. A run '
      'over a filed period must read the figures as filed, and one that does not name the lock is one '
      'that read them from whatever the rows say today.',
      new.period_ends_on, v_period_id, coalesce('"' || new.locked_period_id || '"', 'no lock')
      using errcode = 'ZY076';
  end if;

  select locked_at into v_locked_at from period_lock where period_id = v_period_id;

  if new.source_as_of <> v_locked_at then
    raise exception
      'CommissionRunReadsAfterTheLock: closed accounting period "%" was filed at % and this run reads '
      'the source figures as at %. A payment applied after the close, or a sale backdated into the '
      'period, then changes a figure that has already been paid — so the run must read the books as '
      'filed, which is source_as_of = the lock''s locked_at.',
      v_period_id, v_locked_at, new.source_as_of using errcode = 'ZY076';
  end if;

  return new;
end $$;

comment on function assert_commission_run_reads_the_lock() is
  'Raises ZY076 when a run over a closed accounting period does not read the source figures as at the '
  'lock''s locked_at, or when an open period''s run names a lock. Calls period_lock_for() — 0018''s one '
  'definition of "is this date closed" — rather than re-reading period_lock, so no second reader exists.';

create trigger commission_run_reads_the_lock before insert on commission_run
  for each row execute function assert_commission_run_reads_the_lock();

-- ---------------------------------------------------------------------------------------------
-- ZY077 — a line's band, rate and figure follow from the version it names
-- ---------------------------------------------------------------------------------------------
-- Everything above makes a line name a version. This is what makes the line AGREE with it. Without it a
-- run could store any figure at all and satisfy every constraint in this file, so "recomputing reproduces
-- the stored line" would be a claim about whichever program wrote it.
--
-- Three separate facts, each raised with its own sentence because each has a different cause: the band is
-- the wrong one for the basis, the rate is not that band's, or the figure is not what that rate and the
-- version's rounding produce.
create function assert_commission_line_follows_its_rule() returns trigger
language plpgsql
as $$
declare
  v_version       integer;
  v_rounding      text;
  v_band_no       smallint;
  v_band_rate     integer;
  v_expected      bigint;
begin
  select r.version, r.rounding_mode into v_version, v_rounding
    from commission_rule r where r.id = new.rule_version_id;

  -- The band the basis falls in: the greatest threshold at or below it. ZY073 guarantees a band at 0, so
  -- this always finds one — and the refusal below is therefore about a band_no that disagrees rather than
  -- about a version with no applicable band.
  select b.band_no, b.rate_bp into v_band_no, v_band_rate
    from commission_rule_band b
   where b.rule_version_id = new.rule_version_id
     and b.from_fils <= new.basis_fils
   order by b.from_fils desc
   limit 1;

  if v_band_no is null then
    raise exception
      'CommissionLineHasNoBand: commission rule version % has no band covering a basis of % fils. ZY073 '
      'holds every version''s bands to starting at 0, so this is a version whose bands were never '
      'checked rather than a basis outside them.',
      v_version, new.basis_fils using errcode = 'ZY077';
  end if;

  if new.band_no <> v_band_no then
    raise exception
      'CommissionLineNamesTheWrongBand: a basis of % fils falls in band % of commission rule version %, '
      'and this line names band %. The band decides the rate, so a line in the wrong band is a rate '
      'nobody published.',
      new.basis_fils, v_band_no, v_version, new.band_no using errcode = 'ZY077';
  end if;

  if new.rate_bp <> v_band_rate then
    raise exception
      'CommissionLineNamesTheWrongRate: band % of commission rule version % pays %bp and this line '
      'carries %bp. The rate is snapshotted so a reader needs no join; a snapshot that disagrees with '
      'the version is worse than no snapshot.',
      v_band_no, v_version, v_band_rate, new.rate_bp using errcode = 'ZY077';
  end if;

  v_expected := commission_fils_for(new.basis_fils, new.rate_bp, v_rounding);

  if new.commission_fils <> v_expected then
    raise exception
      'CommissionLineDoesNotFollowItsRule: %bp of % fils rounded % is % fils and this line carries %. '
      'A line whose figure does not follow from the version it names cannot be reproduced by anything, '
      'which is the one property this whole subject has to have.',
      new.rate_bp, new.basis_fils, v_rounding, v_expected, new.commission_fils
      using errcode = 'ZY077';
  end if;

  return new;
end $$;

comment on function assert_commission_line_follows_its_rule() is
  'Raises ZY077 when a line''s band, rate or figure does not follow from the rule version it names. What '
  'makes "recomputing reproduces the stored line" a property of the database rather than a claim about '
  'the program that wrote it.';

create trigger commission_line_follows_its_rule before insert on commission_line
  for each row execute function assert_commission_line_follows_its_rule();

-- ---------------------------------------------------------------------------------------------
-- ZY074 — the run header equals its lines
-- ---------------------------------------------------------------------------------------------
-- The acceptance criterion is "the derivation view returns per-appointment rows summing exactly to the
-- header total", and a view summing the same rows it reports cannot state that: it would agree with
-- itself whatever was written. The header is an independent figure and this is what holds it.
--
-- DEFERRED, because the header is inserted before its lines — a run with no lines yet is every run for the
-- length of one transaction. The count is checked beside the total because the two fail differently: a
-- total that matches with a line missing is possible (a zero-commission line), and a run that dropped it
-- would report the right money about the wrong number of appointments.
create function assert_commission_run_matches_its_lines() returns trigger
language plpgsql
as $$
declare
  v_run       uuid;
  v_total     bigint;
  v_count     integer;
  v_sum       bigint;
  v_lines     integer;
begin
  -- Fires for a run row and for a line row, so the run id comes from whichever table this is.
  --
  -- An IF and not a CASE expression, and that is mechanical rather than stylistic: plpgsql prepares a CASE
  -- as ONE SQL expression over `new`, so `new.run_id` is resolved even in the branch that is not taken — and
  -- on a `commission_run` row the whole statement fails with "record new has no field run_id" before any
  -- comparison happens. Two assignments in two statements are each prepared only when reached.
  if tg_table_name = 'commission_run' then
    v_run := new.id;
  else
    v_run := new.run_id;
  end if;

  select total_fils, line_count into v_total, v_count
    from commission_run where id = v_run;

  -- Unreachable: nothing can delete a run, and a line's foreign key requires one. Answered rather than
  -- asserted so the message cannot print "expected <NULL>".
  if v_total is null then return null; end if;

  select coalesce(sum(commission_fils), 0), count(*) into v_sum, v_lines
    from commission_line where run_id = v_run;

  if v_sum <> v_total or v_lines <> v_count then
    raise exception
      'CommissionRunDisagreesWithItsLines: run % reports % fils over % line(s) and its lines sum to % '
      'fils over %. The header is an independent figure precisely so the derivation can be reconciled '
      'against it; a header that disagrees is a screen that adds up and a payslip that does not.',
      v_run, v_total, v_count, v_sum, v_lines using errcode = 'ZY074';
  end if;

  return null;
end $$;

comment on function assert_commission_run_matches_its_lines() is
  'Raises ZY074 when a run''s total_fils or line_count disagrees with its commission_line rows. DEFERRED, '
  'because the header row is inserted before its lines. Both figures, because a total that matches with '
  'a zero-commission line missing would report the right money about the wrong set of appointments.';

create constraint trigger commission_run_matches_its_lines
  after insert on commission_run
  deferrable initially deferred
  for each row execute function assert_commission_run_matches_its_lines();

create constraint trigger commission_line_matches_its_run
  after insert on commission_line
  deferrable initially deferred
  for each row execute function assert_commission_run_matches_its_lines();

-- ---------------------------------------------------------------------------------------------
-- commission_derivation — the per-appointment derivation a therapist can read
-- ---------------------------------------------------------------------------------------------
-- A VIEW and not a stored summary, for the reason `leave_balance` (0066) and `invoice_settlement` (0068)
-- are views: there is no second copy of the figures to drift from the lines that produced them.
--
-- It names the employee by `staff_reference` and NEVER by a display name. Nineteen employment records
-- have no name recorded (ADR 0020, Y12-names), and a derivation is exactly the screen on which an invented
-- one would look like a fact about a person.
create view commission_derivation as
  select
    l.run_id,
    l.id                     as line_id,
    l.employee_id,
    e.staff_reference,
    l.appointment_id,
    l.trading_date,
    l.source,
    l.invoice_id,
    l.package_redemption_id,
    l.basis_fils,
    l.band_no,
    l.rate_bp,
    l.commission_fils,
    r.rule_version_id,
    v.version                as rule_version,
    v.basis                  as rule_basis,
    v.rounding_mode          as rule_rounding_mode,
    r.period_starts_on,
    r.period_ends_on,
    r.source_as_of,
    r.locked_period_id,
    r.module_enabled,
    r.total_fils             as run_total_fils,
    r.line_count             as run_line_count
  from commission_line l
  join commission_run r on r.id = l.run_id
  join commission_rule v on v.id = r.rule_version_id
  join employee e on e.id = l.employee_id;

comment on view commission_derivation is
  'One row per appointment a run commissioned, with the basis, the band, the rate and the version that '
  'decided them, beside the run header the rows must sum to (held by ZY074). A view and not a stored '
  'summary, so no second copy of the figures can drift from the lines. The employee is named by '
  'staff_reference and never by a display name: nineteen records have none (ADR 0020).';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 granted the application role select, insert, update and delete on every table in public AND set
-- default privileges extending that to tables created later, so all four tables arrive with UPDATE and
-- DELETE already granted. An append-only table that forgets to revoke them is append-only only for as
-- long as nobody writes the statement.
grant select, insert
  on commission_rule, commission_rule_band, commission_run, commission_line
  to berelax_app;
revoke update, delete
  on commission_rule, commission_rule_band, commission_run, commission_line
  from berelax_app;

-- TRUNCATE fires no row-level DELETE trigger, so the refusals above would not see it. The application
-- role holds no TRUNCATE (it is owner-only and never granted), which is what 0083 and 0093 rely on too —
-- and it is why the integration suites that clear these tables do so as the OWNER.
grant select on commission_derivation to berelax_app;

commit;
