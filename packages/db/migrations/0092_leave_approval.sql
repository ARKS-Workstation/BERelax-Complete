-- 0092 — approving leave: who may decide it, what it costs the floor, and what it does to a booking.
--
-- P-HR-09's subject is a DECISION. 0030 created `leave_request` with a `tstzrange` period, a status and the
-- `employee_approved_leave` view every availability consumer reads; 0066 built the entitlement arithmetic and
-- said in its own header that "writing and approving that period is P-HR-09's". Nothing had written one: this
-- file and `packages/db/src/repositories/leave-request.ts` are the first writers of `leave_request` in the
-- build, which is why the period rule finally has a caller.
--
-- ## What this migration deliberately does NOT do
--
-- **It does not decide when a leave day starts or ends.** `leaveCoveragePeriod()` in
-- `packages/core/src/hr/leave-accrual.ts` does, once: a leave day covers its TRADING session, so a day of
-- leave on the 17th runs 11:00 on the 17th to 02:00 on the 18th and therefore covers the 01:30 appointment in
-- the tail. 0066's header states the same thing and states why it is not in SQL — a second reading of where a
-- trading day ends, when `resolveTradingDate` is the one. This file stores the instants that function
-- produced and adds no arithmetic of its own; `leave_approval_matches_request` (ZY005) is a comparison, not
-- a derivation.
--
-- **It does not store the conflict report.** The report is a READ — `readLeaveApprovalConflicts` — over
-- `appointment` joined to the request's period, and it is recomputed on every attempt because that is the
-- only version that is true when the approval commits. A stored report would be a snapshot of a world a
-- reassignment has since changed, and the approval would then commit against rows nobody looked at. What IS
-- stored is the one thing a read cannot recover: the DECISION a human took about a conflict they chose not to
-- resolve (`leave_conflict_override`).
--
-- **It does not move a leave balance.** 0066 is explicit: a request reserves when it is MADE and an approval
-- only makes the reservation final, so an approval writes no `leave_movement` row and nothing here does. The
-- reservation itself belongs to the submission path, which is P-HR-14's (its acceptance line: "a leave
-- request submitted from the portal enters the same validator as the admin path"), and this unit writes
-- neither a `reserved` nor a `released` movement — symmetrically, because a release with no reservation
-- would create leave out of nothing, which is exactly what `decideRequest` in @berelax/core refuses.
--
-- **It does not touch an appointment.** That is the boundary ADR 0041 records. An approval reassigns through
-- P-HR-04's transaction or records an override; no statement in this file, and none in this unit's
-- repository, writes `appointment.status`.
--
-- ## The five tables, and why each is a table
--
-- `leave_approval_delegation` — the only mutable one, and the only one that is not evidence. A delegation is
-- withdrawn (`revoked_at`), and withdrawing it must not erase that it existed, which is why the withdrawal is
-- a stamp rather than a DELETE. It carries a period rather than a pair of dates for `leave_request.period`'s
-- reason: "from Monday" is an instant, and a delegation that began at midnight would cover the two hours of
-- the previous trading session the delegator was still on the floor for.
--
-- `leave_approval` — one row per approved request, carrying the approver, the authority they acted under and
-- the coverage rule VERSION that judged the floor. The version is the point, and it is 0081's argument
-- repeated because it is exactly as true here: "was the floor covered when this leave was approved?" is a
-- question about a decision taken months ago, and raising the floor minimum in April must not make March's
-- approval retroactively wrong. A plain `approved_at` on `leave_request` cannot say what was judged.
--
-- `leave_conflict_override` — one row per appointment a human decided to leave standing inside approved
-- leave. `actor_role` is refused unless it is one that may (ZY002) rather than validated in TypeScript alone,
-- because the refusal has to hold for a `psql` session too, and the reason is refused blank, placeholder and
-- under eight characters for `attendance_correction.reason`'s reason (0086): a reason nobody wrote is not an
-- audited decision.
--
-- `leave_approval_notice` — the staff notification, modelled on `rota_publication_notice` (0081) and for its
-- reason: every seeded employee has no recipient on file, so a notice table that could only record a send
-- would have to either lie or write nothing, and writing nothing is indistinguishable from a notification
-- path that does not exist.
--
-- `leave_approval_cancellation` — the other half of the round trip. Cancelling approved leave sets
-- `leave_request.status = 'cancelled'`, which removes the row from `employee_approved_leave` and restores
-- availability by itself; this row is what makes the APPROVAL stop being live, and `leave_approval_live` is
-- the view that joins the two so nothing has to remember the `not exists`. `employee_approved_leave` is the
-- precedent (0030): a predicate held in a view cannot be forgotten by the next reader.
--
-- `leave_coverage_lock` — one row per trading date, and the reason it is a TABLE rather than an advisory
-- lock. Two approvals for two DIFFERENT therapists on one day do not conflict on any row, so nothing in the
-- schema serialises them: each transaction reads a floor that still has the other therapist on it, both
-- coverage checks pass, and the floor ends up one short with every check having said yes. The second
-- transaction must therefore BLOCK until the first commits and then re-read — which is what
-- `select ... for update` over these rows does. An advisory lock would do the same and be invisible in the
-- schema; ADR 0023's row-locked counter is the precedent, and the reason is the same: a lock you can see is
-- a lock the next person knows not to remove. No foreign key into `business_day`, for 0081's reason —
-- `business_day` is generated and `business-days.itest.ts` empties it, so a RESTRICT reference would pin
-- every date it named for ever.
--
-- ## Private SQLSTATEs
--
--   ZY001  an approval record is append-only; UPDATE or DELETE refused (four tables, one rule)
--   ZY002  a conflict override needs the owner or a manager and a written reason
--   ZY003  a delegation's window is not usable
--   ZY004  an approval does not name a delegation that authorises it
--   ZY005  an approval's period or status does not match the request it approves
--   ZY006  a leave period is bounded by a midnight inside an open session, so a tail would stay rostered
--
-- Class `ZY` because it is UNOWNED. `packages/db/src/sqlstate-uniqueness.test.ts` records thirteen codes that
-- already stand for two unrelated rules each, and `ZA` through `ZX` are all taken — only `ZY` and `ZZ` were
-- free. A code that stands for two rules makes one file's translator report the other file's refusal and
-- makes a probe asserting the code pass when the statement bounced off something else, so taking a fresh
-- class matters more than taking a memorable one. 0077's reasoning, verbatim.
--
-- See docs/adr/0041-leave-approval-never-cancels-an-appointment.md, docs/OPEN-QUESTIONS.md Y9-coverage, and
-- packages/core/src/hr/leave-approval.ts.

begin;

-- ---------------------------------------------------------------------------------------------
-- A leave period may not be bounded by a midnight the premises is open across
-- ---------------------------------------------------------------------------------------------
-- The acceptance line is "leave periods are stored over business_day open/close instants", and until this
-- trigger the only thing making that true was the caller having used `leaveCoveragePeriod()`. That is not
-- enough: `leave_request` takes a bare `tstzrange` (0030), the submission path is P-HR-14's, and a caller
-- that wrote two calendar midnights would produce a row that looks completely ordinary and silently leaves
-- two tails rostered — the previous session's last two hours at the start, and the leave's own at the end.
--
-- ## What the rule is, and the two readings that are wrong
--
-- It forbids one thing: a bound at LOCAL MIDNIGHT falling strictly inside an open trading session. That is
-- exactly the calendar-alignment mistake — trading runs 11:00–02:00, so midnight is the middle of a session
-- — and it is the narrowest rule that catches it.
--
-- *"The lower bound must equal some `business_day.opens_at`"* is wrong in the strict direction twice. It
-- would refuse leave over a date the premises does not trade on, where `leaveCoveragePeriod` correctly falls
-- back to a calendar midnight because there is no session to align to. And it would refuse a PARTIAL day,
-- which is a real thing: a half day off is stored as 11:00–15:00, and `tp_net` in `eligibility.ts` subtracts
-- the fragment exactly as it subtracts a whole session.
--
-- *"No bound may fall strictly inside a session"* is the same mistake in a more plausible costume, and it is
-- the rule this trigger shipped with for an hour. It forbids every partial day — five existing suites store
-- one (11:00–15:00, 12:00–14:00, 15:00–17:00, 18:00–19:00) — and `availability-perf.itest.ts` is the file
-- that said so, from a gate run, about a suite this unit never touched.
--
-- `at time zone 'Asia/Dubai'` is written out here, which the schema already does for this exact question:
-- `business_day.crosses_midnight` is `(closes_at at time zone 'Asia/Dubai')::date > trading_date` (0011). The
-- zone is a fact about the premises rather than about a session, so it cannot be read off the row.
--
-- ## A trigger on a table this migration did not create
--
-- Flagged rather than done quietly. 0030 created `leave_request` and left the alignment decision to P-HR;
-- 0066 took it in core and said the writing and approving were P-HR-09's. This is that decision arriving in
-- the schema, and it constrains every future writer of the table — which is the point, since a second writer
-- is exactly how the first writer's rule gets lost.
create function assert_leave_period_is_not_calendar_bounded() returns trigger
language plpgsql
as $$
declare
  breached record;
  at_midnight constant time := time '00:00';
begin
  select bd.trading_date, bd.opens_at, bd.closes_at into breached
    from business_day bd
   where (
           lower(new.period) > bd.opens_at
           and lower(new.period) < bd.closes_at
           and (lower(new.period) at time zone 'Asia/Dubai')::time = at_midnight
         )
      or (
           upper(new.period) > bd.opens_at
           and upper(new.period) < bd.closes_at
           and (upper(new.period) at time zone 'Asia/Dubai')::time = at_midnight
         )
   order by bd.trading_date
   limit 1;
  if found then
    raise exception
      'Leave period % is bounded by a midnight that falls inside trading date %''s session (% to %). '
      'Trading crosses midnight, so a leave day aligned to the CALENDAR starts in the middle of the previous '
      'session and leaves its last two hours rostered — the therapist is still bookable for a 01:30 '
      'treatment on a day they are on leave for. A leave day covers its trading session, and '
      'leaveCoveragePeriod() in @berelax/core is the one function that computes those bounds. A PARTIAL day '
      'is not this: it is any other pair of instants, and it is permitted.',
      new.period, breached.trading_date, breached.opens_at, breached.closes_at
      using errcode = 'ZY006';
  end if;
  return new;
end $$;

comment on function assert_leave_period_is_not_calendar_bounded() is
  'Raises ZY006 (LeavePeriodCalendarBounded) for a leave period bounded by a local midnight inside an open '
  'trading session — the calendar-alignment mistake, and nothing else. A partial day is permitted, and so is '
  'a midnight on a date the premises does not trade on, where there is no session to align to.';

create trigger leave_request_period_is_not_calendar_bounded
  before insert on leave_request
  for each row execute function assert_leave_period_is_not_calendar_bounded();

-- ---------------------------------------------------------------------------------------------
-- leave_approval_delegation — time-bounded authority to decide somebody else's leave
-- ---------------------------------------------------------------------------------------------
create table leave_approval_delegation (
  id                    uuid        primary key default uuid_generate_v7(),
  -- Who handed the authority over. RESTRICT for 0030's reason: deleting a person to erase what they
  -- delegated is the delete this refuses.
  delegator_employee_id uuid        not null references employee (id) on delete restrict,
  -- Who holds it. The DEPUTY is named, never a role: the acceptance line is that an undelegated peer of the
  -- same role cannot approve, and a delegation to a role would make every holder of that role a deputy,
  -- which is the opposite claim.
  deputy_employee_id    uuid        not null references employee (id) on delete restrict,
  -- The window, as instants. A pair of dates would start at midnight, and midnight is the middle of a
  -- trading session (0030's argument on `leave_request.period`).
  period                tstzrange   not null,
  -- Why the authority was handed over, in words. Refused blank and refused placeholder: a delegation with no
  -- stated reason is indistinguishable from one somebody created by accident.
  reason                text        not null,
  -- Withdrawn rather than deleted, so "who could approve leave in March" stays answerable in April.
  revoked_at            timestamptz,
  revoked_reason        text,
  created_by            text        not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint leave_delegation_period_nonempty check (not isempty(period)),
  constraint leave_delegation_period_bounded
    check (lower(period) is not null and upper(period) is not null),
  -- Half-open, matching appointment, shift, resource_block and leave_request. Mixing bound kinds across
  -- tables is how one instant comes to be inside two windows or neither.
  constraint leave_delegation_period_half_open
    check (lower_inc(period) and not upper_inc(period)),
  constraint leave_delegation_is_to_somebody_else
    check (delegator_employee_id <> deputy_employee_id),
  constraint leave_delegation_reason_is_written
    check (length(btrim(reason)) >= 8 and not is_placeholder_text(reason)),
  constraint leave_delegation_created_by_not_placeholder
    check (not is_placeholder_text(created_by)),
  -- A biconditional rather than two one-way checks, for `leave_request_decision_has_an_instant`'s reason:
  -- revoked with no reason is as wrong as a reason with no revocation, and one named constraint catches
  -- both directions.
  constraint leave_delegation_revocation_is_whole
    check ((revoked_at is null) = (revoked_reason is null)),
  constraint leave_delegation_revocation_reason_is_written
    check (revoked_reason is null
           or (length(btrim(revoked_reason)) >= 8 and not is_placeholder_text(revoked_reason))),
  -- Two LIVE delegations from one person to one deputy overlapping is not two grants, it is an ambiguity:
  -- the approval records which delegation it was taken under, and there would be no answer. Partial on the
  -- revocation, so re-delegating a window somebody withdrew is legal.
  constraint leave_delegation_no_overlapping_live
    exclude using gist (delegator_employee_id with =, deputy_employee_id with =, period with &&)
      where (revoked_at is null)
);

comment on table leave_approval_delegation is
  'Time-bounded authority for a named deputy to decide another employee''s leave. The deputy is a PERSON '
  'and never a role: a delegation to a role would make every holder of it a deputy, which is the opposite '
  'of what a delegation is. Withdrawn by stamping revoked_at, never deleted.';
comment on column leave_approval_delegation.period is
  'The window the deputy may decide inside, half-open instants. Instants and not dates, for '
  'leave_request.period''s reason: a window "from Monday" that began at midnight would cover the two hours '
  'of the previous trading session.';
comment on constraint leave_delegation_no_overlapping_live on leave_approval_delegation is
  'SQLSTATE 23P01. Two live delegations between the same pair may not overlap: leave_approval names the '
  'delegation it was taken under, and two candidates would leave that question unanswerable.';

create trigger leave_approval_delegation_updated_at before update on leave_approval_delegation
  for each row execute function set_updated_at();

create index leave_delegation_deputy_idx
  on leave_approval_delegation (deputy_employee_id) where revoked_at is null;

-- The window has to be usable before it is used, and an unusable one is the failure that looks like a
-- working delegation: a period the deputy can never be inside refuses every approval they attempt, and the
-- refusal names the window rather than the mistake.
create function refuse_unusable_leave_delegation() returns trigger
language plpgsql
as $$
begin
  if upper(new.period) <= lower(new.period) then
    raise exception
      'A leave-approval delegation from % to % ends when or before it starts, so there is no instant the '
      'deputy may approve in. Every approval they attempted would be refused naming the window rather '
      'than the mistake.',
      new.delegator_employee_id, new.deputy_employee_id
      using errcode = 'ZY003';
  end if;
  return new;
end $$;

comment on function refuse_unusable_leave_delegation() is
  'Raises ZY003 (LeaveDelegationUnusable) for a window no instant can be inside.';

create trigger leave_approval_delegation_is_usable
  before insert or update on leave_approval_delegation
  for each row execute function refuse_unusable_leave_delegation();

-- ---------------------------------------------------------------------------------------------
-- leave_approval — the decision, the authority it was taken under, and the version that judged it
-- ---------------------------------------------------------------------------------------------
create table leave_approval (
  -- The request is the identity of the approval: one request is approved at most once, and a second
  -- approval of the same request is a primary-key violation rather than a second row a reader has to
  -- choose between. Re-approving a cancelled request would be a NEW request.
  leave_request_id              uuid        primary key references leave_request (id) on delete restrict,
  approved_by_employee_id       uuid        not null references employee (id) on delete restrict,
  -- The role the approver acted in, stored because it is the thing that made the approval lawful and
  -- because a role granted in April does not describe a decision taken in March.
  approver_role                 text        not null,
  -- 'own_authority' or 'delegation'. A closed set in a CHECK rather than an enum type, because it is a
  -- fact about THIS decision rather than a vocabulary other tables share.
  approved_via                  text        not null,
  delegation_id                 uuid        references leave_approval_delegation (id) on delete restrict,
  -- The `rota_coverage_rule` version whose floor minimum judged this approval. A plain date and not a
  -- foreign key, for 0081's reason: the rule table is versioned by INSERT and nothing deletes a version,
  -- but a RESTRICT reference from a row that can never be deleted pins the parent for ever.
  coverage_rule_effective_from  date        not null,
  -- The period approved, snapshotted. Equal to the request's period at approval time and held so by
  -- ZY005 — a comparison rather than a second derivation of it.
  period                        tstzrange   not null,
  -- What the approval had to step over. Counts and not ids: the ids are `leave_conflict_override` rows and
  -- `appointment_status_history` rows, and a second list of them here would be the copy that drifts.
  conflicts_overridden          smallint    not null,
  conflicts_reassigned          smallint    not null,
  decided_at                    timestamptz not null default now(),

  constraint leave_approval_via_is_known
    check (approved_via in ('own_authority', 'delegation')),
  -- A biconditional: an approval claiming a delegation must name one, and an approval taken on the
  -- approver's own authority must not name one. Either half alone lets the record say something it cannot
  -- support.
  constraint leave_approval_delegation_matches_via
    check ((approved_via = 'delegation') = (delegation_id is not null)),
  constraint leave_approval_role_not_placeholder
    check (length(btrim(approver_role)) > 0 and not is_placeholder_text(approver_role)),
  constraint leave_approval_period_nonempty check (not isempty(period)),
  constraint leave_approval_period_half_open
    check (lower_inc(period) and not upper_inc(period)),
  constraint leave_approval_conflict_counts_are_whole
    check (conflicts_overridden >= 0 and conflicts_reassigned >= 0)
);

comment on table leave_approval is
  'One approved leave request: who decided it, under what authority, and which coverage rule version '
  'judged the floor. Append-only: UPDATE and DELETE raise ZY001 for every role including the owner, '
  'because an approval that can be edited is not a record of what was decided. Cancellation is a '
  'leave_approval_cancellation row, and leave_approval_live is the view that joins the two.';
comment on column leave_approval.coverage_rule_effective_from is
  'The rota_coverage_rule version that judged the floor. Stored for 0081''s reason: "was the floor covered '
  'when this was approved?" is a question about a past decision, and raising the minimum in April must not '
  'make March''s approval retroactively wrong.';
comment on column leave_approval.period is
  'The approved period, snapshotted from leave_request.period and held equal to it by ZY005. Computed by '
  'leaveCoveragePeriod() in @berelax/core, which is the one place that decides a leave day covers its '
  'trading session rather than its calendar day.';

create index leave_approval_employee_idx on leave_approval (approved_by_employee_id);

-- ---------------------------------------------------------------------------------------------
-- leave_conflict_override — the appointment a human decided to leave standing
-- ---------------------------------------------------------------------------------------------
create table leave_conflict_override (
  id               uuid        primary key default uuid_generate_v7(),
  leave_request_id uuid        not null references leave_request (id) on delete restrict,
  -- A PLAIN column and not a foreign key, which is the one referential decision in this file that looks
  -- like an omission and is not. 0081 records both halves of why neither action works for an append-only
  -- row: `ON DELETE SET NULL` arrives as an UPDATE, which ZY001 refuses, and `ON DELETE RESTRICT` pins the
  -- parent for ever because nothing here can be deleted to release it. In production an appointment is
  -- cancelled or rescheduled and never deleted, so RESTRICT would cost nothing there — but it made every
  -- fixture appointment this unit overrode permanently undeletable, which surfaced as an integration suite
  -- that could not sweep its own rows and then ran against three runs' worth of shifts. 0077 took the same
  -- decision for `pipeline_stage_transition.customer_id` for the same reason.
  --
  -- What holds the reference honest instead: `recordLeaveConflictOverride` refuses an appointment that is
  -- not one the leave overlaps for that therapist, which is a stronger check than existence — a foreign key
  -- would accept any appointment in the diary.
  appointment_id   uuid        not null,
  -- The role that took the decision, refused unless it is one that may (ZY002). A trigger and not a
  -- TypeScript guard alone, because the refusal has to hold for the INSERT somebody runs in psql.
  actor_role       text        not null,
  actor_label      text        not null,
  reason           text        not null,
  created_at       timestamptz not null default now(),

  -- One override per (request, appointment). A second row would be a second decision about one conflict,
  -- and the approval's `conflicts_overridden` count would disagree with the rows.
  constraint leave_conflict_override_once unique (leave_request_id, appointment_id),
  constraint leave_conflict_override_actor_label_written
    check (length(btrim(actor_label)) > 0 and not is_placeholder_text(actor_label))
);

comment on table leave_conflict_override is
  'One appointment left standing inside approved leave, by a named decision. Append-only: UPDATE and '
  'DELETE raise ZY001 for every role including the owner. It is the alternative to a P-HR-04 reassignment '
  'and it is NEVER a cancellation — see ADR 0041.';
comment on column leave_conflict_override.reason is
  'Why this appointment was left with a therapist who is on leave. Refused blank, placeholder or under '
  'eight characters by ZY002, for attendance_correction.reason''s reason (0086): a reason nobody wrote is '
  'not an audited decision.';

create index leave_conflict_override_request_idx
  on leave_conflict_override (leave_request_id);

-- The role and the reason together, because they are one rule: an override is a decision only an owner or
-- a manager may take, and only in writing. Y9-coverage's provisional answer states both halves, and both
-- are refused here rather than in the caller so a `psql` session meets the same refusal.
create function refuse_unauthorised_leave_override() returns trigger
language plpgsql
as $$
begin
  if new.actor_role not in ('owner', 'manager') then
    raise exception
      'A leave-conflict override may be taken by the owner or a manager and not by a %. Leaving an '
      'appointment standing inside approved leave is a decision about somebody else''s booking, and the '
      'provisional answer to Y9-coverage names those two roles.',
      new.actor_role
      using errcode = 'ZY002';
  end if;
  if length(btrim(coalesce(new.reason, ''))) < 8 or is_placeholder_text(new.reason) then
    raise exception
      'A leave-conflict override for appointment % carries no written reason. An override with a blank or '
      'placeholder reason is indistinguishable from a conflict nobody looked at, and this row is the only '
      'record that anybody did.',
      new.appointment_id
      using errcode = 'ZY002';
  end if;
  return new;
end $$;

comment on function refuse_unauthorised_leave_override() is
  'Raises ZY002 (LeaveOverrideNotPermitted) for a role that may not override and for a reason nobody '
  'wrote. Both halves of Y9-coverage''s provisional answer, in the database rather than only in a caller.';

create trigger leave_conflict_override_is_authorised
  before insert on leave_conflict_override
  for each row execute function refuse_unauthorised_leave_override();

-- ---------------------------------------------------------------------------------------------
-- leave_approval_notice — the staff notification the approval owes the employee
-- ---------------------------------------------------------------------------------------------
create table leave_approval_notice (
  id               uuid        primary key default uuid_generate_v7(),
  leave_request_id uuid        not null references leave_request (id) on delete restrict,
  employee_id      uuid        not null references employee (id) on delete restrict,
  template_key     text        not null,
  -- 'sent' or 'skipped', with the reason on the second. Modelled on rota_publication_notice (0081) and
  -- for its reason: every seeded employee has no recipient on file.
  outcome          text        not null,
  skipped_reason   text,
  message_id       uuid        references message (id),
  created_at       timestamptz not null default now(),

  constraint leave_approval_notice_once unique (leave_request_id, employee_id),
  constraint leave_approval_notice_outcome_is_known check (outcome in ('sent', 'skipped')),
  constraint leave_approval_notice_skip_has_a_reason
    check ((outcome = 'skipped') = (skipped_reason is not null)),
  constraint leave_approval_notice_send_has_a_message
    check ((outcome = 'sent') = (message_id is not null)),
  constraint leave_approval_notice_template_not_placeholder
    check (length(btrim(template_key)) > 0 and not is_placeholder_text(template_key))
);

comment on table leave_approval_notice is
  'One staff notification per approved leave request. Append-only: UPDATE and DELETE raise ZY001 for '
  'every role including the owner — a record that somebody was told their leave was approved is not '
  'evidence if it can be edited, which is rota_publication_notice''s argument (0081). NOT cleared when '
  'the leave is cancelled: a notification that was sent cannot be unsent.';

create index leave_approval_notice_request_idx on leave_approval_notice (leave_request_id);

-- ---------------------------------------------------------------------------------------------
-- leave_approval_cancellation — the other half of the round trip
-- ---------------------------------------------------------------------------------------------
create table leave_approval_cancellation (
  leave_request_id uuid        primary key references leave_request (id) on delete restrict,
  cancelled_by     text        not null,
  actor_role       text        not null,
  reason           text        not null,
  created_at       timestamptz not null default now(),

  constraint leave_approval_cancellation_reason_is_written
    check (length(btrim(reason)) >= 8 and not is_placeholder_text(reason)),
  constraint leave_approval_cancellation_actor_is_written
    check (length(btrim(cancelled_by)) > 0 and not is_placeholder_text(cancelled_by)
           and length(btrim(actor_role)) > 0)
);

comment on table leave_approval_cancellation is
  'An approved leave request withdrawn. Append-only: UPDATE and DELETE raise ZY001 for every role '
  'including the owner. Its presence is what makes an approval stop being live, and it is a separate row '
  'rather than a column on leave_approval because that table is append-only for the same reason.';

-- The view is what a reader asks "is this leave still approved by a live decision", for the reason
-- `employee_approved_leave` is a view (0030): a predicate held in a view cannot be forgotten. Forgetting
-- the `not exists` here has a specific consequence — a cancelled leave's approval would still name the
-- coverage version and the overrides as live, so a screen would show a therapist as blocked after their
-- holiday had been withdrawn, with nothing saying why.
create view leave_approval_live as
  select a.leave_request_id,
         a.approved_by_employee_id,
         a.approver_role,
         a.approved_via,
         a.delegation_id,
         a.coverage_rule_effective_from,
         a.period,
         a.conflicts_overridden,
         a.conflicts_reassigned,
         a.decided_at
    from leave_approval a
   where not exists (
     select 1 from leave_approval_cancellation c where c.leave_request_id = a.leave_request_id
   );

comment on view leave_approval_live is
  'Approvals not withdrawn. Every reader asking whether leave is approved by a live decision reads this, '
  'never leave_approval: a cancelled approval left in the answer shows a therapist as blocked after '
  'their holiday was withdrawn.';

-- ---------------------------------------------------------------------------------------------
-- leave_coverage_lock — what makes two concurrent approvals a refusal rather than a race
-- ---------------------------------------------------------------------------------------------
create table leave_coverage_lock (
  -- One row per trading date. No foreign key into `business_day`, for 0081's reason: it is generated and
  -- `business-days.itest.ts` empties it, so a RESTRICT reference would pin every date named here for ever.
  trading_date date        primary key,
  created_at   timestamptz not null default now()
);

comment on table leave_coverage_lock is
  'One lockable row per trading date. Two leave approvals for two DIFFERENT therapists on one day conflict '
  'on no row, so nothing in the schema serialises them: each transaction reads a floor that still holds the '
  'other therapist, both coverage checks pass, and the floor ends up short with every check having said '
  'yes. approveLeaveRequest takes `select ... for update` over these rows in trading-date order, so the '
  'second transaction BLOCKS until the first commits and then re-reads. Mutable on purpose — the row is a '
  'lock and carries no history.';

-- ---------------------------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------------------------
-- A trigger that RAISES rather than `create rule ... do instead nothing`, for 0066's reason: a rule reports
-- success, so code that UPDATEd an approval would believe it had changed a decision. One function for the
-- four tables, because it is ONE rule — "a record of a decision is not editable" — and `tg_table_name` says
-- which table met it. Four functions would be four places to forget the same word.
create function refuse_leave_approval_record_edit() returns trigger
language plpgsql
as $$
begin
  raise exception
    'A leave approval record is append-only; % on % is refused. An approval is the record of a decision '
    'somebody took about somebody else''s time off, and a record that can be edited is not evidence the '
    'decision was taken. Withdrawing an approval is a leave_approval_cancellation row; correcting an '
    'override is a further row, and leave_approval_live is how a reader asks what is still true.',
    tg_op, tg_table_name
    using errcode = 'ZY001';
end $$;

comment on function refuse_leave_approval_record_edit() is
  'Raises ZY001 (LeaveApprovalRecordImmutable) for leave_approval, leave_conflict_override, '
  'leave_approval_notice and leave_approval_cancellation, for every role including the owner.';

create trigger leave_approval_no_update before update on leave_approval
  for each row execute function refuse_leave_approval_record_edit();
create trigger leave_approval_no_delete before delete on leave_approval
  for each row execute function refuse_leave_approval_record_edit();
create trigger leave_conflict_override_no_update before update on leave_conflict_override
  for each row execute function refuse_leave_approval_record_edit();
create trigger leave_conflict_override_no_delete before delete on leave_conflict_override
  for each row execute function refuse_leave_approval_record_edit();
create trigger leave_approval_notice_no_update before update on leave_approval_notice
  for each row execute function refuse_leave_approval_record_edit();
create trigger leave_approval_notice_no_delete before delete on leave_approval_notice
  for each row execute function refuse_leave_approval_record_edit();
create trigger leave_approval_cancellation_no_update before update on leave_approval_cancellation
  for each row execute function refuse_leave_approval_record_edit();
create trigger leave_approval_cancellation_no_delete before delete on leave_approval_cancellation
  for each row execute function refuse_leave_approval_record_edit();

-- ---------------------------------------------------------------------------------------------
-- The approval must describe the request it approves
-- ---------------------------------------------------------------------------------------------
-- Two facts, checked together because they are one claim: this row is the approval OF THAT REQUEST. A
-- period that differs is an approval of a period nobody asked for — and since availability reads
-- `leave_request.period` and a screen reads this one, the two would disagree about which hours a therapist
-- is away for, with each looking right on its own.
--
-- The delegation half is here rather than in a CHECK because it is a claim about another row: a delegation
-- named by an approval must be live at the approval instant and must be held by the approver. A CHECK
-- cannot see another table.
create function assert_leave_approval_matches_request() returns trigger
language plpgsql
as $$
declare
  request     leave_request%rowtype;
  delegation  leave_approval_delegation%rowtype;
begin
  select * into request from leave_request where id = new.leave_request_id;
  if request.status <> 'approved' then
    raise exception
      'leave_request % is % and cannot carry an approval record. The status and the record are two '
      'statements of one decision, and a reader that found one without the other would report leave as '
      'approved on one screen and pending on the next.',
      new.leave_request_id, request.status
      using errcode = 'ZY005';
  end if;
  if request.period <> new.period then
    raise exception
      'The approval of leave_request % names the period % and the request holds %. Availability reads the '
      'request''s period and a screen reads the approval''s, so two spellings are two answers to "which '
      'hours is this therapist away for".',
      new.leave_request_id, new.period, request.period
      using errcode = 'ZY005';
  end if;
  if new.delegation_id is not null then
    select * into delegation from leave_approval_delegation where id = new.delegation_id;
    if delegation.deputy_employee_id <> new.approved_by_employee_id then
      raise exception
        'Approval of leave_request % claims delegation %, which names another deputy. An approval that '
        'cites somebody else''s authority records a decision nobody was entitled to take.',
        new.leave_request_id, new.delegation_id
        using errcode = 'ZY004';
    end if;
    if not (delegation.period @> new.decided_at) then
      raise exception
        'Approval of leave_request % was decided at %, outside delegation %''s window %. A delegation is '
        'time-bounded, and an approval outside the window is the case the bound exists for.',
        new.leave_request_id, new.decided_at, new.delegation_id, delegation.period
        using errcode = 'ZY004';
    end if;
    if delegation.revoked_at is not null and delegation.revoked_at <= new.decided_at then
      raise exception
        'Approval of leave_request % cites delegation %, which was withdrawn at %. A withdrawn delegation '
        'confers nothing from the instant it was withdrawn.',
        new.leave_request_id, new.delegation_id, delegation.revoked_at
        using errcode = 'ZY004';
    end if;
  end if;
  return new;
end $$;

comment on function assert_leave_approval_matches_request() is
  'Raises ZY005 when an approval does not describe the request it approves, and ZY004 when it cites a '
  'delegation that does not authorise it. Cross-row, so it cannot be a CHECK.';

create trigger leave_approval_matches_request
  before insert on leave_approval
  for each row execute function assert_leave_approval_matches_request();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 grants the application role select/insert/update/delete on every table created in `public`
-- afterwards and extends it by default privileges, so these revokes are load-bearing rather than
-- decorative. The triggers above already refuse for every role; these are the second layer, and TRUNCATE
-- is the operation no row trigger can see — a truncated leave_approval table takes every decision with it
-- and every notice that proves anybody was told.
revoke update, delete, truncate on leave_approval from berelax_app;
revoke update, delete, truncate on leave_conflict_override from berelax_app;
revoke update, delete, truncate on leave_approval_notice from berelax_app;
revoke update, delete, truncate on leave_approval_cancellation from berelax_app;
-- The delegation table IS mutable: withdrawal is an UPDATE of `revoked_at`. DELETE is not, because
-- deleting a delegation erases that the authority ever existed, which is the question asked after a
-- decision somebody disputes.
revoke delete, truncate on leave_approval_delegation from berelax_app;

commit;
