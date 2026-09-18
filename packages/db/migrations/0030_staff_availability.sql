-- 0030 — the therapist side of availability: who may take an appointment, and when they are present.
--
-- B-AVAIL-02 answers "does this start fit the window, the room and the turnaround". It is handed a
-- list of therapist ids and a list of shifts and asks no questions about either (`solve.ts`: "they
-- hand this function a list that is already eligible, which is why there is no therapist-attribute
-- logic here to disagree with theirs"). This migration is where that list comes from.
--
-- ## P-HR does not exist yet, so this is a SEAM rather than a guess at its schema
--
-- Rota, leave approval, contracts, payroll and accrual are P-HR's. Five decisions here exist so that
-- P-HR can be built by EXTENDING these tables rather than by introducing a second source of truth for
-- "is this therapist bookable", which is the failure that produces two answers and a double booking:
--
--   1. **`employee` carries no rota, no leave balance and no contract.** It carries an employment
--      PERIOD and a gender, which are the only two facts availability reads about the person.
--   2. **`shift` and `shift_assignment` are separate.** One rostered span, n employees on it. P-HR's
--      rota generator writes shifts; nothing about the read path changes when it does.
--   3. **Leave is a request with a STATUS**, and availability reads the `employee_approved_leave`
--      view. An approval path with more states (line manager, then HR) adds states to the enum and
--      the view keeps meaning the same thing.
--   4. **Which credentials are mandatory is DATA**, in `regulatory_profile` — the table that already
--      holds every other consequence of the unanswered licence question (0004). A hard-coded list in
--      the query would make "the licence turned out to be healthcare" a code change.
--   5. **Style is NOT a column on `employee`.** See below; it is the one modelling mistake this
--      schema exists to refuse.
--
-- ## Asian/Arabic is a treatment style, and `employee.style` would be the bug
--
-- ADR 0021: style is an attribute of the TREATMENT. `service_skill` (0017) maps a style to the
-- `therapist_skill` a delivery requires, and `employee_skill` records which skills a person holds.
-- So eligibility is `employee_skill.skill = service_skill.required_skill`, a join, and a therapist can
-- hold both skills or neither.
--
-- An `employee.style treatment_style` column would compile, read naturally and be wrong in three ways
-- at once: a therapist trained in both styles cannot be expressed, the catalogue's style enum becomes
-- a property of a person, and — because 0017 says the mapping "carries no price and never will" —
-- the first screen that reads the therapist's style to decide what to charge recouples pricing to
-- assignment, so reassigning a therapist reprices the booking. 0017's own comment asks for this
-- shape: "P-HR's `employee_skill` should reference this type rather than declare its own".
--
-- ## Dates against the TRADING date, instants against the period
--
-- Trading runs 11:00-02:00 (0011), so 01:30 belongs to the PREVIOUS trading date. Two consequences
-- that are easy to get backwards and that this file settles once:
--
--   - **Employment and credential expiry are compared to the trading date**, not to the slot instant.
--     A licence valid through the 18th covers the 18th's 01:30 appointment, whose CALENDAR date is the
--     19th. Comparing `expires_on` to `lower(period)::date` excludes a therapist for the last two
--     hours of every trading day they are otherwise licensed for.
--   - **Shifts and leave are `tstzrange`**, half-open `[)`, matching `resource_block` (0012) and
--     `appointment.period` (0024). A shift ending at 22:00 and a treatment-plus-buffer ending at 22:00
--     are compatible; one starting at 22:00 is not. `packages/core/src/availability/intervals.ts`
--     compares them, and a `'[]'` bound anywhere here would make that comparison disagree.
--
-- ## What this migration deliberately does not do
--
-- `appointment.therapist_id` stays a plain uuid with no foreign key, even though its parent now
-- exists. B-AVAIL-01's NOTE hands the reference here, and the right constraint is not the one that
-- would fit: `employee` holds every employee, so `references employee (id)` would accept a
-- receptionist as the therapist of a massage while reading as though it had proved otherwise. The
-- claim worth enforcing is "an employee holding the skill this appointment's style requires, on shift,
-- not on leave, credentialled" — which is this read model re-applied inside the booking transaction,
-- and that is B-AVAIL-06's. Attaching the weaker constraint now would also require every existing
-- appointment fixture (three integration suites and gate 26q) to invent an employment record for a
-- synthetic uuid, which is a data migration across other units' fixtures rather than a constraint.

begin;

-- ---------------------------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------------------------

-- Recorded because same-gender matching is a HARD constraint on assignment (B-AVAIL-05, Y9-gender),
-- not because anything reports on it. Two labels, matching the fixture's `Gender` union; a third is a
-- migration, which is the right weight for a change that alters who may be assigned to whom.
create type employee_gender as enum ('female', 'male');
comment on type employee_gender is
  'Read by the gender-matching rule of B-AVAIL-05, which defaults to strict. Nullable on employee: a '
  'gender nobody has told the build is not a value to invent (Y8-staff).';

-- The documents an employee file holds. An enum rather than free text because `regulatory_profile`
-- names a SUBSET of these as mandatory, and a mandatory type spelled two ways is a credential check
-- that silently passes: 'health_certificate' in the profile and 'health certificate' on the document
-- match nothing, and the therapist is bookable with no certificate at all.
create type employee_document_type as enum (
  'professional_licence',
  'health_certificate',
  'work_permit',
  'emirates_id',
  'passport',
  'training_certificate'
);
comment on type employee_document_type is
  'Document kinds an employee file holds. Which of them are MANDATORY for a bookable therapist is '
  'data, in regulatory_profile.mandatory_therapist_document_types, because it follows the licence '
  'class nobody has confirmed (Y1-licence).';

-- Pending does not remove a therapist from availability and approved does. That distinction is the
-- whole reason this is a status rather than a boolean: a request keyed on "is there a row" makes
-- asking for leave the same act as being granted it.
create type leave_status as enum ('pending', 'approved', 'rejected', 'cancelled');
comment on type leave_status is
  'Only ''approved'' removes a therapist from availability, through the employee_approved_leave view. '
  'P-HR may add approval stages; every added state is unapproved until it reaches ''approved''.';

create type leave_kind as enum ('annual', 'sick', 'unpaid', 'other');
comment on type leave_kind is
  'What the leave is, for P-HR''s accrual and entitlement rules. Availability reads the period and the '
  'status and never the kind: sick leave and annual leave remove a therapist identically.';

-- ---------------------------------------------------------------------------------------------
-- employee — the minimal person availability reads
-- ---------------------------------------------------------------------------------------------
create table employee (
  id              uuid        primary key default uuid_generate_v7(),
  -- An internal handle for the rota, the scheduler and a seed. NEVER a display name: a therapist has
  -- no display name until an admin sets one, and publishing one needs a recorded photography consent
  -- as well (ADR 0020, Y12-names). There is deliberately no `display_name` column here — a nullable
  -- one is what an admin screen fills in without a consent row, and the guard would be invisible.
  staff_reference text        not null unique
                    constraint employee_staff_reference_not_placeholder
                    check (not is_placeholder_text(staff_reference)),
  -- Nullable, and the null is the honest state. Nineteen photographs and no staff list is the real
  -- handover position (Y8-staff), and a NOT NULL here would have this migration invent nineteen
  -- people's genders. B-AVAIL-05 decides what strict matching does with an unknown one.
  gender          employee_gender,
  -- Employment as a PERIOD rather than an `is_active` flag. A flag answers "now" and nothing else,
  -- and availability is asked about future and past trading dates: a therapist who leaves in March is
  -- not eligible in April and was eligible in February, which one boolean cannot say. NULL
  -- `employed_until` is open-ended employment, not an unknown end date.
  employed_from   date        not null,
  employed_until  date,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- An employment that ends before it starts is not unusual employment; it is a row that makes every
  -- date-range comparison against it false, so the therapist is silently bookable on no date at all.
  constraint employee_employment_period_ordered
    check (employed_until is null or employed_until >= employed_from)
);

comment on table employee is
  'The minimal employee availability reads: an employment period, a gender and (through '
  'employee_skill) the skills held. P-HR extends this table - contract, pay, accrual, manager - '
  'rather than introducing a second source of truth for who is bookable.';
comment on column employee.staff_reference is
  'Internal handle, e.g. "Therapist 07". Never published and never a person''s name: ADR 0020 needs a '
  'display name AND a photography consent before a therapist page exists, and neither is here.';
comment on column employee.employed_from is
  'Compared against the TRADING date, not the calendar date. Trading runs 11:00-02:00, so an '
  'appointment at 01:30 belongs to the previous trading date and a comparison against '
  'lower(period)::date would get the last two hours of every day wrong.';

create trigger employee_updated_at before update on employee
  for each row execute function set_updated_at();

create index employee_employment_idx on employee (employed_from, employed_until);

-- ---------------------------------------------------------------------------------------------
-- employee_skill — which skills the person holds
-- ---------------------------------------------------------------------------------------------
-- `therapist_skill` is 0017's enum, reused exactly as its comment asks. A second
-- `create type employee_skill_kind as enum ('asian_style', ...)` would compile, read identically and
-- be a different Postgres type, so `employee_skill.skill = service_skill.required_skill` would not
-- even typecheck in SQL - and the workaround somebody reaches for is a cast, which is where the two
-- spellings drift apart.
create table employee_skill (
  employee_id      uuid            not null references employee (id) on delete cascade,
  skill            therapist_skill not null,
  -- Provisional rows are assumptions the build made because no answer existed, read by the
  -- Unconfirmed Assumptions panel exactly as service_room_type_compat.is_provisional is (0012).
  is_provisional   boolean         not null default false,
  open_question_id text,
  created_at       timestamptz     not null default now(),
  primary key (employee_id, skill),
  constraint employee_skill_provisional_names_a_question
    check (not is_provisional or open_question_id is not null)
);

comment on table employee_skill is
  'Skills held, one row per skill, so a therapist may hold both styles or neither. This is the table '
  'that keeps style an attribute of the TREATMENT (ADR 0021): the eligibility test is a join to '
  'service_skill.required_skill, never a style column on the person.';

-- ---------------------------------------------------------------------------------------------
-- shift and shift_assignment — rostered presence
-- ---------------------------------------------------------------------------------------------
-- Two tables rather than one `employee_shift`, because a shift is a span the premises rosters and the
-- assignment is who is on it. With one table, "move the evening shift half an hour later" is an
-- update per therapist, and the half that fails leaves two versions of one shift.
create table shift (
  -- The trading date, materialised and foreign-keyed, exactly as appointment.trading_date is (0024).
  -- A shift on a date the premises does not trade has no row to join to, which is the roster error
  -- worth refusing: it would otherwise put a therapist on duty on a closed day.
  id           uuid        primary key default uuid_generate_v7(),
  trading_date date        not null
                 references business_day (trading_date) on update cascade on delete restrict,
  -- The rostered span, '[)' bounds. Crosses midnight on a normal day, which is why it is an instant
  -- range and not a pair of times: 17:00-02:00 as two `time` columns cannot say which date the 02:00
  -- belongs to, and that is the bug that loses the last two hours of every trading day.
  period       tstzrange   not null,
  label        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- An empty range rosters nobody while reading as a shift, so it would sit in the roster looking
  -- like cover and provide none.
  constraint shift_period_nonempty check (not isempty(period)),
  -- An unbounded shift rosters a therapist for ever, and the way that is discovered is that they are
  -- offered for every slot on every date.
  constraint shift_period_bounded
    check (lower(period) is not null and upper(period) is not null),
  -- Half-open, always. A '[]' shift would cover the instant it ends, so a treatment plus buffer
  -- finishing exactly at shift end and one STARTING at shift end would both be accepted.
  constraint shift_period_half_open
    check (lower_inc(period) and not upper_inc(period))
);

comment on table shift is
  'One rostered span on one trading date; shift_assignment says who is on it. Whether the span sits '
  'inside the date''s trading window is deliberately NOT constrained: the solver intersects presence '
  'with the window, so a shift running past close offers nothing past close, and a shift filed under '
  'the wrong trading date covers no candidate of that date. Both roster errors are inert, and a '
  'trigger asserting it would be a second opinion about where a trading day ends.';

create trigger shift_updated_at before update on shift
  for each row execute function set_updated_at();

create index shift_trading_date_idx on shift (trading_date);
-- The overlap lookup for one date's presence. btree_gist (0001) is what allows the date equality and
-- the range overlap in one index.
create index shift_date_period_idx on shift using gist (trading_date, period);

create table shift_assignment (
  shift_id    uuid        not null references shift (id) on delete cascade,
  -- RESTRICT, not CASCADE: an employee who has been rostered has a history, and deleting the person
  -- to erase the roster is the delete this refuses. Ending employment is `employed_until`.
  employee_id uuid        not null references employee (id) on delete restrict,
  created_at  timestamptz not null default now(),
  primary key (shift_id, employee_id)
);

comment on table shift_assignment is
  'Who is on a shift. Two overlapping shifts for one employee are NOT an error - a roster written in '
  'two halves is one presence, which mergePeriods() in @berelax/core unions so that a treatment '
  'crossing the join is not refused.';

create index shift_assignment_employee_idx on shift_assignment (employee_id);

-- ---------------------------------------------------------------------------------------------
-- leave_request, and the view availability actually reads
-- ---------------------------------------------------------------------------------------------
create table leave_request (
  id          uuid         primary key default uuid_generate_v7(),
  employee_id uuid         not null references employee (id) on delete restrict,
  -- An instant range rather than a pair of dates, and that is the decision in this table. A day of
  -- leave stored as a date range starts at midnight, and midnight is the middle of a trading day:
  -- leave "from the 20th" would cut the 19th's session at 00:00 and leave its last two hours
  -- rostered. Storing instants lets P-HR align a day of leave to the trading day (opens_at to
  -- closes_at) or to the calendar day, which is a policy question and theirs (Y8-leave).
  period      tstzrange    not null,
  kind        leave_kind   not null,
  status      leave_status not null default 'pending',
  -- When the decision was taken. NULL exactly while the request is pending, so "approved by nobody at
  -- no time" is not a storable state - the row a leave balance is later reconciled against.
  decided_at  timestamptz,
  reason      text,
  created_at  timestamptz  not null default now(),
  updated_at  timestamptz  not null default now(),
  constraint leave_request_period_nonempty check (not isempty(period)),
  constraint leave_request_period_bounded
    check (lower(period) is not null and upper(period) is not null),
  constraint leave_request_period_half_open
    check (lower_inc(period) and not upper_inc(period)),
  -- A biconditional rather than two one-way checks: pending with a decision instant is as wrong as
  -- approved without one, and one named constraint catches both directions.
  constraint leave_request_decision_has_an_instant
    check ((status = 'pending') = (decided_at is null)),
  -- Two APPROVED leaves overlapping for one person is double-counted leave, and the way it is
  -- discovered is a balance that does not reconcile a year later. Partial on the status, so a pending
  -- request over an approved one - which is what asking to extend leave looks like - is still legal.
  constraint leave_request_no_overlapping_approved
    exclude using gist (employee_id with =, period with &&) where (status = 'approved')
);

comment on table leave_request is
  'Leave, with the approval state that decides whether it removes a therapist from availability. '
  'Availability reads employee_approved_leave, never this table.';
comment on constraint leave_request_no_overlapping_approved on leave_request is
  'SQLSTATE 23P01. Partial on status: two approved leaves may not overlap, a pending request over an '
  'approved one may - that is a request to extend.';

create trigger leave_request_updated_at before update on leave_request
  for each row execute function set_updated_at();

create index leave_request_employee_idx on leave_request (employee_id, status);

-- The view is what availability reads, for the same reason `regulatory_profile_current` is (0004):
-- the predicate cannot then be forgotten. Forgetting it here has a specific and quiet consequence -
-- a PENDING request would remove a therapist from the roster, which presents as "no availability"
-- with no reason attached and is invisible until the therapist asks why they have no bookings.
create view employee_approved_leave as
  select id as leave_request_id, employee_id, period, kind, decided_at
    from leave_request
   where status = 'approved';

comment on view employee_approved_leave is
  'Approved leave only. Every availability consumer reads this, never leave_request: a pending '
  'request must not make a therapist unbookable.';

-- ---------------------------------------------------------------------------------------------
-- employee_document — the credentials, and their expiry
-- ---------------------------------------------------------------------------------------------
create table employee_document (
  id            uuid                   primary key default uuid_generate_v7(),
  employee_id   uuid                   not null references employee (id) on delete cascade,
  document_type employee_document_type not null,
  -- The licence or certificate number. NULL until somebody enters the real one, and a provisional
  -- marker is refused outright: a plausible-looking licence number is indistinguishable from a
  -- configured one, while a NULL is visibly unanswered (is_placeholder_text, 0026).
  reference     text
                  constraint employee_document_reference_not_placeholder
                  check (reference is null or not is_placeholder_text(reference)),
  issued_on     date,
  -- NOT NULL, and a date rather than a timestamptz. A credential expires at the end of a day, which
  -- is what the document itself says; and a nullable expiry would read as "valid for ever", which is
  -- the permissive default that makes an unrenewed licence invisible.
  expires_on    date                   not null,
  created_at    timestamptz            not null default now(),
  updated_at    timestamptz            not null default now(),
  constraint employee_document_expiry_after_issue
    check (issued_on is null or expires_on >= issued_on),
  -- A renewal is a NEW ROW with a later expiry, never an update of the old one, so the file still
  -- shows what was valid last March. This refuses only the exact duplicate; the eligibility read
  -- takes the latest expiry per (employee, type).
  constraint employee_document_one_row_per_expiry
    unique (employee_id, document_type, expires_on)
);

comment on table employee_document is
  'Credentials and their expiry. Which TYPES are mandatory for a bookable therapist is read from '
  'regulatory_profile, not from a list in a query: it follows the licence class (Y1-licence), and a '
  'hard-coded list would make a lawyer''s answer a code change.';
comment on column employee_document.expires_on is
  'Compared against the appointment''s TRADING date, inclusively: a licence valid through the 18th '
  'covers the 18th''s 01:30 appointment, whose calendar date is the 19th.';

create trigger employee_document_updated_at before update on employee_document
  for each row execute function set_updated_at();

create index employee_document_current_idx
  on employee_document (employee_id, document_type, expires_on desc);

-- ---------------------------------------------------------------------------------------------
-- Which credentials are mandatory: data, versioned with the licence answer
-- ---------------------------------------------------------------------------------------------
-- Added to `regulatory_profile` rather than to `app_setting`, because this is a consequence of the
-- same unanswered question every other column there is a consequence of: whether the licence is a
-- commercial wellness activity or a healthcare activity decides which credentials the therapist
-- delivering a treatment must hold (docs/04 section 1, ADR 0020).
--
-- Added WITH a default rather than by superseding the row in force. The table is append-only (ADR
-- 0008) and a change to the profile is a new version; introducing a column is not a change to the
-- profile, and superseding the seeded row to carry it would record a decision nobody took. The
-- default IS the provisional answer, and it is the stricter option, which is what 0004 says an
-- unconfirmed licence resolves to.
--
-- The array is of the enum type, not text[]: `banned_claim_terms` is free words a lint scans for,
-- while these are a closed vocabulary that has to match `employee_document.document_type` exactly.
-- A typo in a text[] is a mandatory type nothing matches, so every therapist passes the check that
-- was supposed to exclude them.
alter table regulatory_profile
  add column mandatory_therapist_document_types employee_document_type[] not null
    default array['professional_licence', 'health_certificate']::employee_document_type[];

comment on column regulatory_profile.mandatory_therapist_document_types is
  'Document types a therapist must hold, unexpired, to be offered in availability. PROVISIONAL '
  '(Y1-licence, Y8-staff): the stricter reading of an unconfirmed licence. An empty array means no '
  'credential gate at all, which is a decision a lawyer takes, not a default.';

-- The view has to be replaced, and this is the line that is easy to miss. `regulatory_profile_current`
-- was created in 0004 as `select *`, and a view's column list is fixed at CREATE time: the star was
-- expanded then, so adding a column to the table does NOT add it to the view. Every consumer reads the
-- view and never the table (0004), so without this the new column is unreadable by exactly the callers
-- it exists for - and the failure is a missing column at runtime rather than at migration time.
--
-- `create or replace` is legal here because the new column is appended: a replacement may add columns
-- to the END of the list and may not reorder or retype the existing ones.
create or replace view regulatory_profile_current as
  select * from regulatory_profile where superseded_at is null;

comment on view regulatory_profile_current is
  'The profile in force. Every consumer reads this, never the table. Replaced by 0030 to pick up '
  'mandatory_therapist_document_types: a view created with select * has a FIXED column list.';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 grants the application role select/insert/update/delete on every table created in `public`
-- afterwards, so these revokes are load-bearing rather than decorative - and stated explicitly
-- because a managed database restored from a dump does not necessarily carry the same defaults.
--
-- An employee is ended, never deleted: `employed_until` is the mechanism, and a DELETE erases the
-- roster, the leave decisions and the subject of every audit row about them at once. Leave is
-- cancelled, never deleted, for the same reason - a withdrawn request that leaves no trace cannot be
-- reconciled against a balance. `shift_assignment.employee_id` already refuses the first of those
-- with ON DELETE RESTRICT; this refuses it for an employee nobody has rostered yet, which is the case
-- the foreign key does not cover.
revoke delete on employee, leave_request from berelax_app;

-- A shift IS deleted - an unpublished roster is rewritten, and a cancelled shift that lingers as a
-- row would keep rostering people. Said here because "never granted" and "considered" are different
-- facts, and the next reader should not have to work out which one this is.

commit;
