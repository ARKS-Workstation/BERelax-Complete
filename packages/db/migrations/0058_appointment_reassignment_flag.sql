-- 0058 — the reassignment flag, and the reconciliation 0054 deferred to this unit.
--
-- Two things, and they belong in one migration because the first is only safe once the second is true.
--
-- ## 1. The profile in force is reconciled with the column DEFAULT
--
-- 0030 put the provisional mandatory-credential answer in the column DEFAULT and said why:
-- "introducing a column is not a change to the profile, and superseding the seeded row to carry it
-- would record a decision nobody took." 0054 revised that default from 0030's
-- `{professional_licence, health_certificate}` — the strictest set the enum of the day could spell —
-- to docs/01 decision 20's six, and deliberately left the ROW in force carrying 0030's two. Its
-- header says what that costs and who pays it:
--
--   "So after this migration the DEFAULT is the stricter six and the ROW IN FORCE still carries
--    0030's two. That divergence is deliberate [...] Reconciling the row in force with this default
--    belongs to P-HR-03, the unit whose whole subject is credential expiry removing a therapist from
--    availability, and it belongs there together with the seeded documents that keep the rest of the
--    suite green."
--
-- This is that unit and this is that line. It is not "recording a decision nobody took": decision 20
-- IS the decision, 0054 already recorded it in the DEFAULT, and a row that lags its own column default
-- means the credential gate ACTUALLY IN FORCE is weaker than the answer the build states everywhere
-- else — including on the admin credentials screen, which reads the row. A gate that is documented as
-- six credentials and enforces two is the quiet failure; P-HR-03's first acceptance line ("expiring a
-- mandatory labour card removes the therapist from availability") is not even expressible until the
-- row names a labour card.
--
-- **How it is written is the point.** The new version names `source_note` and NOTHING ELSE, which is
-- character for character what 0004's own seed did:
--
--     insert into regulatory_profile (source_note) values ('Seeded by migration 0004. ...');
--
-- Every other column therefore takes its DEFAULT. That has three consequences worth having:
--
--   * it cannot restate a value and get it wrong, which is the failure `opening-balances.itest.ts`
--     and `catalogue-compliance.itest.ts` both record from opposite ends (a fixture that restores
--     NEARLY the original row is a fixture that breaks another suite one file later);
--   * "the seeded profile" and "every column at its DEFAULT" become the SAME sentence, which is what
--     lets a test or a gate restore the seeded profile without knowing the values — see the note on
--     `restoreSeededProfile` in `packages/fixtures/src/hr-credentials.itest.ts`;
--   * it reconciles `non_expiring_document_types` in the same statement, to 0054's empty set, which is
--     the strict reading.
--
-- It runs on a database whose in-force row may have been left changed by an integration suite that was
-- killed between its probe and its `finally`. That is not a hazard here, it is the repair: the row this
-- inserts is the seeded one by construction, so applying 0058 to such a database also ends the
-- pollution rather than carrying it forward.
--
-- The nine-plus integration files that seed a therapist with a professional licence and a health
-- certificate and then assert that therapist is offered a slot are changed in the same commit to file
-- the mandatory set IN FORCE rather than a hard-coded pair, which is the other half of what 0054's
-- header hands to this unit. Reading the set from `regulatory_profile_current` rather than naming it is
-- deliberate: the next revision of this answer then needs no edit to any of them.
--
-- ## 2. `appointment_reassignment_flag` — needs_reassignment, and never a cancellation
--
-- P-HR-03's sweep must be able to say "this appointment's therapist may no longer take it" WITHOUT
-- touching `appointment.status`. A status would be wrong three times over: `cancelled_by_salon` tells a
-- customer their booking is gone when the intention is to keep it, `holds_resources` is GENERATED from
-- the status (0024) so any new terminal label would release the therapist and the room and hand the
-- slot to somebody else mid-decision, and `appointment_status_history` would then record a
-- cancellation that never happened. So the flag is a row beside the appointment, and the appointment is
-- untouched.
--
-- P-HR-04 is the unit that ACTS on these rows (the candidate finder and the reassign transaction), and
-- the shared reassignment path it builds is also used by approved leave and therapist archival — which
-- is why the reason is an enum with room in it rather than a boolean called `credential_expired`.

-- ---------------------------------------------------------------------------------------------
-- The reason vocabulary — OUTSIDE the transaction, for 0054's reason
-- ---------------------------------------------------------------------------------------------
-- An enum rather than a vocabulary TABLE, which is the opposite of the choice 0053 made for the CRM
-- lifecycle labels, and the difference is whether the labels are provisional. 0053's are: nobody has
-- confirmed what a customer lifecycle looks like, so each label carries `is_provisional` and an
-- OPEN-QUESTIONS id and an enum could not hold either. These two are not provisional and are not ours
-- to choose — they are `credential_missing` and `credential_expired` from
-- `ELIGIBILITY_EXCLUSION_REASONS` in `@berelax/core`, the port's own closed union, mirrored word for
-- word by `EXCLUSION_REASONS` in `packages/db/src/repositories/eligibility.ts`. A third spelling of
-- those two reasons in a table of rows is a third thing to keep in step.
--
-- `if not exists` on the type, and the labels added separately with `if not exists`, so a re-run
-- reaches statements that are already true rather than statements that fail.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'appointment_reassignment_reason') then
    create type appointment_reassignment_reason as enum ('credential_missing', 'credential_expired');
  end if;
end $$;

begin;

comment on type appointment_reassignment_reason is
  'Why an appointment needs a different therapist. The two labels are the credential half of '
  'ELIGIBILITY_EXCLUSION_REASONS in @berelax/core, spelled identically on purpose: a reason a caller '
  'cannot match to the availability answer is a reason nobody can act on. P-HR-04 adds the labels for '
  'approved leave and therapist archival, which reach the same queue through the same table.';

-- ---------------------------------------------------------------------------------------------
-- The profile in force, reconciled. Clause 1 of the header.
-- ---------------------------------------------------------------------------------------------
update regulatory_profile set superseded_at = now() where superseded_at is null;

insert into regulatory_profile (source_note)
values (
  'Reconciled by migration 0058 (P-HR-03). The row in force now carries every column''s DEFAULT, '
  'which is exactly what 0004''s own seed wrote and which 0054 revised to docs/01 decision 20''s six '
  'mandatory therapist credentials. Before this the DEFAULT said six and the row said 0030''s two, so '
  'the credential gate in force was weaker than the answer the build states. Still PROVISIONAL against '
  'Y1-licence: a lawyer''s answer supersedes this row, it does not edit it.'
);

-- ---------------------------------------------------------------------------------------------
-- appointment_reassignment_flag
-- ---------------------------------------------------------------------------------------------
create table appointment_reassignment_flag (
  id                      uuid  primary key default uuid_generate_v7(),
  -- NO foreign key to `appointment`, and this is the third time this estate has made that choice for
  -- this exact reason. PostgreSQL refuses `truncate appointment` while a referencing table is not named
  -- in the same statement, and three files truncate it by an explicit list they inherited from one
  -- another (`packages/db/src/schema/booking-constraints.itest.ts`,
  -- `packages/db/src/repositories/catalogue.itest.ts`,
  -- `packages/fixtures/src/catalogue-compliance.itest.ts`). 0055 declined a foreign key here in so many
  -- words, 0021 declined one from `agent_run.job_id`, and 0024 declined one from
  -- `appointment.therapist_id`. A flag left pointing at a truncated appointment is invisible — every
  -- reader joins to `appointment` — where a foreign key would be three other units' files failing on a
  -- statement that has nothing to do with credentials.
  appointment_id          uuid  not null,
  -- The therapist the appointment was sold with. Copied rather than joined, because the queue is read
  -- per therapist and because a reassignment REPLACES `appointment.therapist_id` (P-HR-04) — after
  -- which the join no longer answers "who was it taken away from".
  therapist_id            uuid  not null,
  -- The appointment's TRADING date, copied for the same reason and for one more: the credential
  -- judgement was made against this date and not against the appointment's calendar date. Trading runs
  -- 11:00-02:00, so a licence valid through the 18th covers the 18th's 01:30 appointment, whose
  -- calendar date is the 19th (0011, 0024). A reader recomputing the date from `period` gets that
  -- wrong; a reader recomputing it from `appointment.trading_date` is reading a column a reschedule may
  -- since have moved.
  appointment_trading_date date not null,
  reason                  appointment_reassignment_reason not null,
  -- WHICH credential. The acceptance criterion is that the notification names the document type that
  -- expired, and "a credential lapsed" is the message the recipient cannot act on.
  document_type           employee_document_type not null,
  -- The expiry the judgement was made against. NULL for `credential_missing`, where there is no
  -- document and therefore no date — whole-or-nothing with `reason` below, the shape 0046's
  -- `attribution_is_whole` and 0049's `late_cancellation_is_whole` both take.
  document_expires_on     date,
  -- The `regulatory_profile` version whose mandatory set produced this flag. The set is PROVISIONAL
  -- (Y1-licence) and versioned, so a flag raised under one answer has to be explainable after the next
  -- one supersedes it: without this column "why was this flagged?" is unanswerable the day the policy
  -- changes, which is the day somebody asks.
  regulatory_profile_version integer not null,
  -- The TRADING date of the sweep that raised it, not a calendar date and not `now()::date`: the sweep
  -- runs after trading closes at 02:00, so its own calendar date is the day after the session it swept.
  detected_on             date  not null,
  flagged_at              timestamptz not null default now(),
  -- Cleared by a later sweep once the therapist is eligible again for this appointment's trading date —
  -- a renewal, or a profile that no longer demands the document. NOT deleted: the flag is the evidence
  -- that the check ran and what it said, and a row that vanishes on renewal makes "was this appointment
  -- ever at risk" unanswerable.
  cleared_at              timestamptz,
  cleared_on              date,
  -- The single definition of "this appointment is in the reassignment queue", so the partial unique
  -- index below, P-HR-04's candidate finder and every screen read one column instead of three
  -- restatements of `cleared_at is null`. Generated and stored, exactly as `appointment.holds_resources`
  -- is and for the same stated reason.
  needs_reassignment      boolean not null generated always as (cleared_at is null) stored,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- Half a clearance cannot answer the question the pair exists for: when it was cleared, and on which
  -- trading day the sweep that cleared it ran.
  constraint appointment_reassignment_flag_clearance_is_whole
    check ((cleared_at is null) = (cleared_on is null)),
  constraint appointment_reassignment_flag_cleared_after_flagged
    check (cleared_at is null or cleared_at >= flagged_at),
  -- An expiry date belongs to an expired document and to nothing else. A `credential_missing` flag
  -- carrying a date would be describing a document that is not on file.
  constraint appointment_reassignment_flag_expiry_matches_reason
    check ((reason = 'credential_expired') = (document_expires_on is not null))
);

comment on table appointment_reassignment_flag is
  'An appointment whose therapist may no longer take it. NEVER a cancellation and never a silent '
  'unassignment: `appointment.status` is untouched, so `holds_resources` stays true and the slot is not '
  'handed to somebody else while a human decides (0024). One LIVE row per appointment '
  '(appointment_reassignment_flag_one_live_per_appointment); a clearance stamps cleared_at rather than '
  'deleting, because the flag is the evidence the check ran. P-HR-03 raises and clears these; P-HR-04 '
  'acts on them.';

comment on column appointment_reassignment_flag.needs_reassignment is
  'True while the flag is live. GENERATED from cleared_at so the partial unique index, the candidate '
  'finder and every screen read one column rather than three copies of `cleared_at is null`.';

comment on column appointment_reassignment_flag.detected_on is
  'The TRADING date of the sweep that raised the flag, read from business_day and never truncated from '
  'the instant: the sweep runs after trading closes at 02:00, so its calendar date is the day after the '
  'session it swept (0011).';

comment on column appointment_reassignment_flag.regulatory_profile_version is
  'The profile version whose mandatory_therapist_document_types produced this flag. The set is '
  'PROVISIONAL (Y1-licence) and versioned, so without this column "why was this flagged" stops being '
  'answerable on the day the answer changes.';

-- One LIVE flag per appointment, which is what makes a nightly sweep idempotent in the DATABASE rather
-- than in the job's memory. `recurring_cost_alert_once_per_period_and_kind` is the same mechanism and
-- 0031 records the reason: a job that remembered "already flagged" in its own state would raise a
-- second copy the first time that state was lost.
--
-- Partial, on `cleared_at is null`, because a cleared flag is history: a credential that lapses again
-- after a renewal must be able to raise a second flag, and a total unique index would refuse it.
create unique index appointment_reassignment_flag_one_live_per_appointment
  on appointment_reassignment_flag (appointment_id)
  where cleared_at is null;

comment on index appointment_reassignment_flag_one_live_per_appointment is
  'The idempotency of the nightly sweep, in the database. Partial so a credential that lapses again '
  'after a renewal can raise a second flag while the first stays on file as history.';

-- The queue's own read: every live flag, worst date first. P-HR-04 reads this and so does the HR
-- screen; without it the queue is a sequential scan that grows with every flag ever raised.
create index appointment_reassignment_flag_queue_idx
  on appointment_reassignment_flag (appointment_trading_date, therapist_id)
  where cleared_at is null;

-- Per therapist, including cleared rows: "has this person's file ever taken an appointment off the
-- rota" is an HR question and is asked of the whole history.
create index appointment_reassignment_flag_therapist_idx
  on appointment_reassignment_flag (therapist_id, flagged_at desc);

create trigger appointment_reassignment_flag_updated_at
  before update on appointment_reassignment_flag
  for each row execute function set_updated_at();

-- 0009's default privileges cover a table created later only if the dump they were restored from
-- carried them, so every migration since 0051 restates the grant rather than relying on it. No DELETE:
-- a flag is cleared, never removed, and the one legitimate removal — the appointment itself going —
-- cannot cascade here because there is deliberately no foreign key (see `appointment_id` above), so it
-- is a housekeeping statement performed as the table owner.
grant select, insert, update on appointment_reassignment_flag to berelax_app;
revoke delete, truncate on appointment_reassignment_flag from berelax_app;

-- ---------------------------------------------------------------------------------------------
-- The agent the nightly sweep reports to
-- ---------------------------------------------------------------------------------------------
-- `assertRegistry` refuses a cron job that names no `agent_definition` (G-AGT-01), and
-- `agent-watchdog.itest.ts` asserts the named row exists. A cron with no agent row has no declared
-- interval and no budget, so nothing is watching it and nothing is capping it.
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('credential_sweep', 'Credential expiry sweep',
   'Nightly: re-applies the credential gate to every FUTURE appointment and flags the ones whose '
   'therapist may no longer take them (needs_reassignment), clearing the flag again once the document '
   'is renewed. Never cancels and never unassigns (P-HR-03, docs/04 SS7).',
   24 * 60 * 60, 0)
on conflict (agent_key) do nothing;

-- `agentsWithHeartbeat` INNER joins definition to heartbeat, so an agent with no heartbeat row never
-- appears in the watchdog's list at all — which is worse than unwatched, because the
-- registry-completeness check would report it present (0033's note).
insert into agent_heartbeat (agent_key) values ('credential_sweep')
on conflict (agent_key) do nothing;

commit;
