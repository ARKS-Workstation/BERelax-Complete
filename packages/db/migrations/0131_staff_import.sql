-- 0131 — the imported staff record, and what a leave opening balance has to SAY about its own unit.
--
-- H-MIG-06 imports the nineteen employment records this business runs on: the style skills that decide
-- who may give which treatment, the gender that decides who may treat whom, the credential expiries that
-- decide whether anybody is bookable at all, and the annual-leave balance each person brought with them.
-- Four of those are facts the previous arrangement held. The fifth — the leave balance — is a NUMBER
-- WITH A UNIT, and the unit is the whole of this migration.
--
-- ## A leave day in this business covers a trading SESSION, and an imported balance has to say so
--
-- Trading runs 11:00 to 02:00, so a session crosses midnight. `0092_leave_approval.sql` enforces what
-- follows for a REQUEST: `ZY020` refuses a leave period bounded by a midnight that falls inside a
-- session, because "a leave day aligned to the CALENDAR starts in the middle of the previous session and
-- leaves its last two hours rostered — the therapist is still bookable for a 01:30 treatment on a day
-- they are on leave for."
--
-- Nothing said anything about a BALANCE, and a balance is the figure every one of those requests will be
-- spent against. So `leave_movement.day_basis` is a column every opening balance must fill in,
-- `trading_session_day` is the only value an opening balance may carry, and `ZY371` refuses
-- `calendar_day` by name.
--
-- **What that refusal is and is not claiming, stated here because the obvious reading is wrong.** It is
-- NOT a second arithmetic. `0066_leave.sql` settled that the statutory entitlement is counted in calendar
-- days ("a leave day is a calendar day, never a working day") and `leave_movement.hundredths` is in those
-- units throughout this ledger; nothing here changes that, and a migration that did would be
-- contradicting a locked decision. This business opens on every date, so a trading-session day and a
-- calendar day are the SAME QUANTITY today and the basis changes no number.
--
-- What the basis records is that somebody CONFIRMED each day of the balance is a day this business
-- rosters — which is exactly what ZY020 demands of every day that balance will later be spent on. The two
-- quantities diverge the first time a date in the leave year is not a trading session, and the figure
-- that would then be wrong is one nobody could re-derive, because the previous arrangement's records do
-- not say which of its days were working days. The refusal's message therefore COUNTS, from
-- `business_day`, how many dates of the covering leave year this business does not trade: zero means the
-- two readings coincide and the cell is a confirmation, and anything else means the figure is a different
-- number depending on which was meant.
--
-- A column that is read and then refused, rather than no column at all: H-MIG-04's reason for
-- `consent_claim_discarded`, and it holds here too. Without the column a file carrying calendar days
-- either fails to parse — so somebody deletes the distinction along with the cell — or is read as a
-- figure nothing records the basis of, and in both cases nothing afterwards can show that the question
-- was asked. With it, the claim is on the record and the refusal can name it.
--
-- ## Zero is not an answer, it is the absence of one
--
-- `ZY372`: an opening balance of zero must be marked `is_provisional` and must name its open question.
-- docs/11 §7 is explicit that the accrual engine needs a real opening balance rather than a zero, and the
-- failure this prevents is the one `rota_version.forecast_unpriced_employees` already measured one
-- subject along — "a forecast over a rota where no wage is recorded is 0 fils and reads as a free rota".
-- A zero leave balance reads as somebody who has taken all their leave. Nineteen of them read as a
-- business with no leave liability at all, which is a figure that appears in a gratuity and end-of-service
-- calculation and in nothing that would query it.
--
-- It is a trigger and not a CHECK because the message has to carry the remedy. A CHECK violation names the
-- constraint and prints the failing row, which here is the figure itself and says nothing about what to do.
--
-- ## The import record, and the gender that cannot be inferred
--
-- `imported_staff_row` is the row that ALWAYS exists for a staged line — 0119's, 0121's and 0130's
-- arrangement, and the framework's reason: a staged row that reaches `applied` having recorded no entity
-- cannot COMMIT (ZY196), and the line that recorded nothing is the one somebody has to go and look at.
-- `ZY373` makes it append-only.
--
-- `ZY374` is the one that matters, and it is the enforcement half of an acceptance line: an import record
-- claiming an employee must name one with a RECORDED GENDER. `employee.gender` is nullable because
-- migration 0030 refused to have a migration "invent nineteen people's genders", and gender is a hard
-- constraint on assignment (B-AVAIL-05) — so a null one does not fail, it quietly makes that therapist
-- unassignable to every gender-specified request while looking like an ordinary row. The importer
-- quarantines such a line; this trigger is what makes the quarantine unforgeable, which is the difference
-- between a convention and a rule.
--
-- ## What this migration deliberately does NOT add
--
-- **No column for a bank account, an Emirates ID number, a passport number or a visa number, anywhere,
-- and the importer has no cell for one either.** The staging ledger keeps `import_row.payload` for ever
-- and no erasure reaches it (ADR 0072, Y9-import-ledger), so an IBAN in a workbook is an IBAN in that
-- ledger permanently — which is strictly worse than the plaintext column `employee_bank_detail` was built
-- to avoid, because that column does not exist and this one could not be removed. Those fields are
-- entered through the HR screens, which seal them under the envelope scheme 0102 built, and the schema
-- already refuses a plaintext: `employee_document_identity_number_is_encrypted` and
-- `employee_document_visa_number_is_encrypted` refuse a `reference` on an identity type at all, and
-- `employee_bank_detail` has no plaintext column to write to.
--
-- **No change to `employee.is_publishable`.** It is already GENERATED from `display_name` and
-- `photo_consent` (0030), which is decision 23 enforced rather than documented, so an import cannot
-- publish a therapist whatever it writes. The acceptance line is asserted against that generation rather
-- than re-stated here.

begin;

-- ---------------------------------------------------------------------------------------------
-- A leave movement states the unit of its own figure
-- ---------------------------------------------------------------------------------------------

alter table leave_movement
  add column day_basis text;

comment on column leave_movement.day_basis is
  'For an opening balance: what the figure was confirmed to count. `trading_session_day` is the only '
  'value permitted (ZY371) — each day of the balance is a day this business rosters, which is what ZY020 '
  'demands of every day it will be spent on. It is NOT a second arithmetic: 0066 settled that the '
  'entitlement is counted in calendar days and hundredths is in those units, and this business opens on '
  'every date, so the two readings are the same quantity today. Null for every other kind, whose figure '
  'came from this system''s own accrual and has only one possible reading.';

-- Whole or nothing with the kind. An accrual's unit is not in question — it came from
-- `leave_entitlement_rule.monthly_accrual_hundredths`, which this system wrote — so a basis on one would
-- be a second statement of something already settled, and the row that carried the wrong one would look
-- exactly as authoritative.
alter table leave_movement
  add constraint leave_movement_day_basis_matches_kind
    check ((kind = 'opening_balance') = (day_basis is not null));

alter table leave_movement
  add constraint leave_movement_day_basis_is_known
    check (day_basis is null or day_basis in ('trading_session_day', 'calendar_day'));

create or replace function assert_leave_opening_balance_is_sound()
returns trigger
language plpgsql
as $$
declare
  v_closed integer;
begin
  if new.kind <> 'opening_balance' then
    return new;
  end if;

  if new.day_basis = 'calendar_day' then
    -- The bounds come from `business_day`, which is the only thing that knows which dates this business
    -- trades. Counted over the leave year the balance opens, so the message can say whether the two
    -- readings coincide — zero closed dates means the cell is a confirmation and the figure is unchanged,
    -- and anything else means the balance is a different number depending on which was meant.
    select count(*) into v_closed
      from generate_series(
             new.leave_year_start,
             (new.leave_year_start + interval '1 year' - interval '1 day')::date,
             interval '1 day'
           ) as d(day)
     where not exists (
       select 1 from business_day bd where bd.trading_date = d.day::date
     );

    raise exception
      'LeaveOpeningBalanceInCalendarDays: employee %''s opening balance of % hundredths of a day is '
      'stated in CALENDAR days. A leave day in this system covers its TRADING SESSION — trading runs '
      '11:00 to 02:00, so a session crosses midnight and ZY020 refuses a leave request bounded by a '
      'midnight inside one. The leave year opening % holds % date(s) this business does not trade: at '
      'zero the two readings are the same quantity and this cell is the confirmation nobody has given, '
      'and above zero they are different numbers and the previous arrangement''s records do not say '
      'which it meant.',
      new.employee_id, new.hundredths, new.leave_year_start, v_closed
      using errcode = 'ZY371',
            hint = 'State the balance as trading_session_day once each day of it has been confirmed to '
                   'be a day this business rosters. Converting a calendar figure here would be this '
                   'code deciding how much leave somebody is owed, and 0066 already settled that the '
                   'entitlement is counted in calendar days — so there is no conversion to apply, only '
                   'a confirmation to obtain.';
  end if;

  if new.hundredths = 0 and not new.is_provisional then
    raise exception
      'LeaveOpeningBalanceOfZeroIsNotAnAnswer: employee %''s opening balance is zero and is not marked '
      'provisional. docs/11 section 7 says the accrual engine needs a real opening balance rather than a '
      'zero: a zero reads as somebody who has already taken all their leave, and nineteen of them read '
      'as a business with no leave liability at all — a figure that reaches an end-of-service '
      'calculation and nothing that would query it.',
      new.employee_id
      using errcode = 'ZY372',
            hint = 'Set is_provisional and name the open question (Y8-leave), or supply the real figure. '
                   'A zero that is marked provisional appears in the Unconfirmed Assumptions panel; a '
                   'zero that is not is indistinguishable from an answer.';
  end if;

  return new;
end
$$;

comment on function assert_leave_opening_balance_is_sound() is
  'Raises ZY371 for an opening balance in calendar days and ZY372 for an unmarked zero. A trigger rather '
  'than two CHECKs because each message has to carry its remedy — a CHECK violation names the constraint '
  'and prints the failing figure, which is the one thing that says nothing about what to do.';

create trigger leave_movement_opening_balance_is_sound
  before insert on leave_movement
  for each row execute function assert_leave_opening_balance_is_sound();

-- ---------------------------------------------------------------------------------------------
-- The import record: the row that ALWAYS exists for a staged line
-- ---------------------------------------------------------------------------------------------

create table imported_staff_row (
  id                uuid        primary key default uuid_generate_v7(),
  /*
    The staff reference the line named, kept whether or not it resolved.

    An internal identifier and not a person's name, so it is the one thing about a quarantined line that
    can be recorded without inventing anything (ADR 0020, Y12-names). It is also what makes a quarantine
    actionable: "line 7, THP-0014, no gender recorded" is a sentence somebody can act on, where a line
    number alone sends them back to the file to work out who it was about.

    No foreign key to `employee.staff_reference`: the whole point of a quarantined line is that it names
    a reference nothing holds yet.
  */
  staff_reference   text        not null
                      constraint imported_staff_row_reference_is_stated
                        check (btrim(staff_reference) <> '' and length(staff_reference) <= 64)
                      constraint imported_staff_row_reference_not_placeholder
                        check (not is_placeholder_text(staff_reference)),
  /*
    What happened to this line, and there are exactly two answers.

    `imported` — the employment record is in `employee`, with its skills, its languages and its credential
    expiries. `quarantined` — something the line states cannot be accepted and NOTHING was inferred: no
    guessed gender, no guessed style skill, no converted leave balance.
  */
  outcome           text        not null
                      constraint imported_staff_row_outcome_check
                        check (outcome in ('imported', 'quarantined')),
  -- A short lower-case NAME from the importer's own closed vocabulary, not prose. The shape is held here
  -- and the vocabulary in `packages/migration/src/importers/staff/import.ts`; naming the values in both
  -- would be the second statement of a list that drifts.
  quarantine_reason text
                      constraint imported_staff_row_reason_is_a_named_reason
                        check (quarantine_reason is null or quarantine_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  employee_id       uuid        references employee (id) on delete restrict,
  created_at        timestamptz not null default now(),
  constraint imported_staff_row_reason_iff_quarantined
    check ((outcome = 'quarantined') = (quarantine_reason is not null)),
  constraint imported_staff_row_employee_iff_imported
    check ((outcome = 'imported') = (employee_id is not null))
);

comment on table imported_staff_row is
  'One row per line of a reconstructed staff file, whether or not it produced an employment record. A '
  'quarantined line is the evidence of what could not be accepted. UPDATE and DELETE raise ZY373: the '
  'record is evidence of what one line of one file was decided to be, and evidence that can be rewritten '
  'is not evidence. It carries NO bank account, identity number or visa number and the importer has no '
  'cell for one — the staging ledger keeps every payload for ever, so an IBAN in a workbook is an IBAN '
  'nothing can erase.';

-- One record per employee. A second naming the same person would be a second claim about where that
-- employment record came from, and `import_provenance_one_per_target` makes the same refusal one layer up.
create unique index imported_staff_row_one_per_employee
  on imported_staff_row (employee_id) where employee_id is not null;

create index imported_staff_row_quarantined_idx
  on imported_staff_row (created_at) where outcome = 'quarantined';

create index imported_staff_row_reference_idx on imported_staff_row (staff_reference);

create or replace function refuse_imported_staff_row_change()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'ImportedStaffRowIsAppendOnly: an imported-staff record may not be %. It is the evidence of what one '
    'line of one file was decided to be, and evidence that can be rewritten is not evidence.',
      lower(tg_op)
    using errcode = 'ZY373',
          hint = 'A line that was quarantined and has since been corrected is a NEW record, from a new '
                 'import run. Nothing removes the first one.';
end
$$;

comment on function refuse_imported_staff_row_change() is
  'Raises ZY373. `imported_contact`''s decision (0121) and `imported_appointment`''s (0130), for the same '
  'reason.';

create trigger imported_staff_row_no_update
  before update on imported_staff_row
  for each row execute function refuse_imported_staff_row_change();

create trigger imported_staff_row_no_delete
  before delete on imported_staff_row
  for each row execute function refuse_imported_staff_row_change();

create or replace function assert_imported_staff_has_a_gender()
returns trigger
language plpgsql
as $$
declare
  v_gender employee_gender;
  v_reference text;
begin
  if new.employee_id is null then
    return null;
  end if;
  select gender, staff_reference into v_gender, v_reference
    from employee where id = new.employee_id;
  if v_gender is not null then
    return null;
  end if;
  raise exception
    'ImportedStaffHasNoGender: imported-staff record % names employee % (%), whose gender is not '
    'recorded. Gender is a hard constraint on assignment (B-AVAIL-05), so a null one does not fail — it '
    'quietly makes that therapist unassignable to every gender-specified request while looking like an '
    'ordinary row, and migration 0030 refused to have a migration invent nineteen people''s genders.',
      new.id, new.employee_id, coalesce(v_reference, new.staff_reference)
    using errcode = 'ZY374',
          hint = 'The importer quarantines a line with no gender cell. A record that reached here names '
                 'an employment record something other than this importer wrote.';
end
$$;

comment on function assert_imported_staff_has_a_gender() is
  'Raises ZY374 at COMMIT. The enforcement half of "a therapist row without a recorded gender is '
  'quarantined": the importer declines the line, and this is what makes the decline unforgeable.';

create constraint trigger imported_staff_row_names_a_gendered_employee
  after insert on imported_staff_row
  deferrable initially deferred
  for each row execute function assert_imported_staff_has_a_gender();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
--
-- 0009 granted the application role all four verbs on every table in `public` and set default privileges
-- extending that to tables created later, so this table ARRIVED with UPDATE and DELETE granted. The
-- table-level REVOKE has to come first and cannot be narrowed by a column-list grant; 0121 records the
-- run this cost when it was left out.
revoke update, delete, truncate on imported_staff_row from berelax_app;

-- `berelax_readonly` MAY read this one, unlike `imported_contact` and `imported_appointment`. Those hold
-- a keyed digest of a customer's number, which anybody with the pepper can test a guess against; this
-- holds a staff reference and an outcome, which is the same information `employee.staff_reference`
-- already exposes to the reporting connection. "How many staff lines quarantined, and why" is a question
-- a report should be able to answer without going through the application.

commit;
