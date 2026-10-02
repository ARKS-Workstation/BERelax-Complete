-- 0130 — a MIGRATED appointment: reconstructed visit history that the live machine cannot touch.
--
-- H-MIG-05 imports enough of this business's visit history for the retention cohorts and each client's
-- record to be about the whole relationship rather than about the weeks since go-live. Every row it
-- writes is a treatment that was delivered under the previous arrangement, and that is a different kind
-- of thing from a booking: nobody is going to arrive for it, nobody may check it in, and no money is
-- owed on it. One boolean says which kind a row is, and six refusals make the distinction a property of
-- the schema rather than a convention the next writer has to know about.
--
-- ## Why a flag and not a second table
--
-- The obvious alternative — `historic_appointment`, its own table, its own columns — fails on the
-- acceptance line this unit exists for: the imported visits must appear in the customer's record and in
-- the retention cohorts. Those are read from `appointment` (and from `reporting.fact_appointment`, which
-- is a view over it), so a second table means every one of those readers grows a `union all` and the ones
-- that are forgotten are the ones that report a shorter history than this business has. It also throws
-- away the two invariants that matter most here: `appointment_therapist_no_overlap` and
-- `assert_room_capacity` are what make "no double-booked therapist, no room over capacity" true of the
-- imported dataset, and a parallel table is outside both.
--
-- So the rows go in the same table, and the flag is what the status machine and the availability solver
-- read to tell them apart.
--
-- ## The six refusals, and the specific failure behind each
--
-- **ZY361 — the booking facts are immutable.** A migrated appointment is not a booking anybody can
-- change. `recordAppointmentTransition` locks the row, judges the move against the live transition table
-- and writes the new status; nothing in that path knows about reconstruction, so a receptionist
-- completing a 2026-06 visit that is already `completed` is a plausible accident and the result is an
-- `appointment_status_history` chain, an `audit_event` row and an outbox event about a treatment nobody
-- delivered today. The remedy is named in the message: a reconstructed visit is corrected by a fresh
-- import, never by an edit, which is ADR 0061's rule for every imported figure.
--
-- **ZY362 — the flag itself cannot move after the insert.** Separated from ZY361 because the remedy is
-- different and a caller has to be able to branch on which happened. Turning it ON would relabel a live
-- booking as history, which removes it from everything that chases a booking; turning it OFF would put a
-- treatment delivered before this system traded into the live machine, which is ZY361's defect reached
-- the long way round.
--
-- **ZY363 — a migrated row must be attested by an `imported_appointment` record**, at COMMIT. This is
-- 0119's ZY258 shape and the same argument: the flag is what suppresses the row from the P&L and from the
-- live machine, so a row carrying it that no import record stands behind is a visit nobody can defend,
-- and the provenance view cannot answer "which line of which file is this". Deferred, because the
-- appointment row has to exist before the record can name it.
--
-- **ZY364 — `imported_appointment` is append-only.** Same decision as `imported_contact` (0121) and
-- `import_staging.import_row` (0111): the record is the EVIDENCE of what the import decided, and evidence
-- that can be rewritten after the fact is not evidence. A quarantined line that was later resolved is a
-- second record, not an edited one.
--
-- **ZY365 — a record claiming `imported` must name a MIGRATED appointment.** Without it the record could
-- attach itself to a live booking and that booking would then be attested as reconstruction while the
-- live machine went on treating it as a booking — the two halves of the distinction pointing at one row.
-- Deferred for the same reason as ZY363, and it is the direction ZY363 does not cover.
--
-- **ZY366 — a migrated appointment may not END in the future.** This is the one that does the most work
-- for the least code. The availability solver and the reassignment sweep are both forward-looking
-- (`readCommittedAppointments` takes a trading date, `readReassignmentCandidates` takes an instant floor),
-- so a reconstruction that cannot be dated forward can never be offered a slot, flagged for reassignment
-- or asked to transition in the first place. The alternative was `and not a.migrated` in each of those
-- queries, which is a second statement of "history is in the past" in every reader that grows later —
-- and the reader that is forgotten is the one that offers a therapist a slot they worked in June.
--
-- It is a trigger and not a CHECK because `now()` is not immutable and PostgreSQL refuses it in a CHECK.
-- The upper bound and not the lower: a treatment that began before midnight and ran past it is the normal
-- after-midnight case this unit is careful about, and judging the start would refuse the import that is
-- running at the moment a visit from two hours ago is being reconstructed.
--
-- ## What the flag does NOT do, and why
--
-- It does not remove the row from `readCommittedAppointments`. A migrated appointment HELD its therapist
-- and its room for its period, and that is exactly why the exclusion constraint and the capacity trigger
-- are allowed to judge the imported dataset: filtering reconstructions out of the occupancy read would
-- make the imported history double-bookable against itself and the first sign of it would be two
-- therapists in one room on a day nobody can check any more.
--
-- It does not touch the P&L either, and that is by construction rather than by a filter. A financial
-- statement is a directed sum over `journal_line` (ADR 0064); this importer posts no journal entry at
-- all, issues no invoice and writes no payment, so a migrated appointment contributes zero to every line
-- of every statement because it is not in the ledger. `vat_rate_bp = 0` and `vat_fils = 0` are the same
-- decision stated on the row: ADR 0069 refused to post output VAT on a supply made before this system
-- traded, and an appointment carrying a VAT figure for a supply whose tax point is outside these books is
-- a figure somebody will eventually add up.

begin;

-- ---------------------------------------------------------------------------------------------
-- The flag
-- ---------------------------------------------------------------------------------------------

alter table appointment
  add column migrated boolean not null default false;

comment on column appointment.migrated is
  'True for a visit reconstructed by H-MIG-05 out of the previous arrangement''s records. The row is in '
  'the customer''s history and in the retention cohorts, it holds its therapist and its room so the '
  'domain invariants can judge it, and it is outside the live status machine (ZY361), outside the future '
  '(ZY366) and outside the ledger (it posts nothing).';

-- A reconstructed visit is OVER. The four terminal labels are written out rather than derived from
-- `holds_resources`, because that column is generated from three of them plus `rescheduled` and the claim
-- here is not "it holds no resources" — a completed visit does hold its room, which is the point of the
-- paragraph above. `rescheduled` is absent deliberately: it means a successor row exists, and a
-- reconstruction has no successor to point at.
alter table appointment
  add constraint appointment_migrated_is_finished
    check (
      not migrated
      or status in ('completed', 'no_show', 'cancelled_by_customer', 'cancelled_by_salon')
    );

-- No output VAT on a supply made before these books opened (ADR 0069, one subject along). With
-- `appointment_price_split_exact` already holding net + vat = gross, this makes the net the whole gross
-- and leaves no tax figure on the row for anything to pick up.
alter table appointment
  add constraint appointment_migrated_posts_no_vat
    check (not migrated or (vat_rate_bp = 0 and vat_fils::bigint = 0));

-- ---------------------------------------------------------------------------------------------
-- How a reconstructed booking says it arrived
-- ---------------------------------------------------------------------------------------------
--
-- `booking.source` was `online | front_desk | phone | walk_in` (0023), which are the four ways a booking
-- reaches this system. A visit reconstructed from the previous arrangement's records reached it through
-- none of them, and the records do not say which one it originally came through — so every one of the
-- four would be an invented fact about how a real customer booked, on a row the CRM reads. Brief rule 15
-- is about exactly this: a plausible value is indistinguishable from a recorded one.
--
-- `import` is therefore a fifth source, and it is the same decision `customer.created_via = 'import'`
-- already made one table along (0121).

alter table booking drop constraint booking_source_check;
alter table booking
  add constraint booking_source_check
    check (source in ('online', 'front_desk', 'phone', 'walk_in', 'import'));

-- ---------------------------------------------------------------------------------------------
-- The import record: the row that ALWAYS exists for a staged line
-- ---------------------------------------------------------------------------------------------
--
-- 0119's and 0121's arrangement, for the reason 0121 states: a line that produced no entity still has to
-- produce something, or ZY196 refuses the COMMIT of a staged row that recorded nothing — and the line
-- that produced nothing is precisely the line somebody needs to go and look at.

create table imported_appointment (
  id                uuid        primary key default uuid_generate_v7(),
  /*
    The keyed digest of the customer cell this visit was about. NEVER the number.

    Identical mechanism, key kinds and reason as `imported_contact.contact_hmac` (0121): `suppressionKey`
    in `packages/db/src/repositories/suppression.ts` is the one implementation, the kind is in the HMAC
    input so a cell that reads like a number cannot key the same as a number, and the `_hmac` suffix is
    what makes `CREDENTIAL_COLUMN_PATTERN` enumerate the column so the erasure engine refuses until
    `rights-policy.ts` has classified it.

    It is here and not a `customer_id` for 0119's recorded reason: a merge re-points the one copy that
    exists, and this record is evidence about a file rather than a row about a person. It also means a
    line whose customer could not be resolved at all still records WHO the missing history was about,
    which is the first question the owner asks about a quarantine.
  */
  contact_hmac      text        not null
                      constraint imported_appointment_hmac_is_keyed
                        check (contact_hmac ~ '^[a-f0-9]{64}$'),
  -- The LABEL of the pepper, never the pepper. `imported_contact`'s reason: a digest nothing can
  -- attribute to the pepper that keyed it cannot be recomputed after a rotation.
  pepper_version    text        not null
                      constraint imported_appointment_pepper_version_is_stated
                        check (btrim(pepper_version) <> '' and length(pepper_version) <= 64),
  /*
    What happened to this line, and there are exactly two answers.

    `imported` — the visit is in `appointment`, marked migrated. `quarantined` — something the line names
    could not be resolved and NOTHING was guessed: no placeholder therapist, no placeholder room, no
    nearest service. The acceptance line is "quarantined with a reason rather than assigned to a
    placeholder", and a placeholder therapist is the specific thing it forbids — it would put a treatment
    somebody else performed into that person's commission base and their utilisation.
  */
  outcome           text        not null
                      constraint imported_appointment_outcome_check
                        check (outcome in ('imported', 'quarantined')),
  -- A short lower-case NAME from the importer's own closed vocabulary, not prose. The shape is held here
  -- and the vocabulary in `packages/migration/src/importers/appointments/import.ts`; naming the values in
  -- both places would be the second statement of a list that drifts.
  quarantine_reason text
                      constraint imported_appointment_reason_is_a_named_reason
                        check (quarantine_reason is null or quarantine_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  appointment_id    uuid        references appointment (id) on delete restrict,
  created_at        timestamptz not null default now(),
  constraint imported_appointment_reason_iff_quarantined
    check ((outcome = 'quarantined') = (quarantine_reason is not null)),
  constraint imported_appointment_appointment_iff_imported
    check ((outcome = 'imported') = (appointment_id is not null))
);

comment on table imported_appointment is
  'One row per line of a reconstructed visit-history file, whether or not it produced an appointment. A '
  'quarantined line is the evidence of what could not be resolved; ZY363 is what makes a migrated '
  'appointment without one unable to COMMIT. UPDATE and DELETE raise ZY364: the record is evidence of '
  'what one line of one file was decided to be, and evidence that can be rewritten is not evidence.';

-- One record per appointment. A second record naming the same row would be a second claim about where
-- that visit came from, and `import_provenance_one_per_target` makes the same refusal one layer up.
create unique index imported_appointment_one_per_appointment
  on imported_appointment (appointment_id) where appointment_id is not null;

create index imported_appointment_quarantined_idx
  on imported_appointment (created_at) where outcome = 'quarantined';

create index imported_appointment_hmac_idx on imported_appointment (contact_hmac);

-- ---------------------------------------------------------------------------------------------
-- The refusals
-- ---------------------------------------------------------------------------------------------

create or replace function refuse_migrated_appointment_change()
returns trigger
language plpgsql
as $$
begin
  -- The flag first, because "you may not relabel this row" has to be answerable even when the statement
  -- also changes something ZY361 covers, and a caller branching on the code needs the specific one.
  if old.migrated is distinct from new.migrated then
    raise exception
      'MigratedFlagIsImmutable: appointment % may not have its `migrated` flag changed from % to %. A '
      'live booking cannot be relabelled as reconstructed history and history cannot be relabelled as a '
      'booking; import the visit again (ADR 0061) rather than editing the row.',
        old.id, old.migrated, new.migrated
      using errcode = 'ZY362',
            hint = 'Re-run the appointment import. The flag is set by the insert and never afterwards.';
  end if;

  if not old.migrated then
    return new;
  end if;

  -- The booking FACTS, and not every column. `updated_at` is set by `set_updated_at` on the way through,
  -- and `trading_date` is reachable by the ON UPDATE CASCADE from `business_day` — a trading date
  -- corrected in the calendar must still cascade, or the foreign key could not be maintained at all.
  if new.status           is distinct from old.status
     or new.period        is distinct from old.period
     or new.therapist_id  is distinct from old.therapist_id
     or new.room_id       is distinct from old.room_id
     or new.service_variant_id is distinct from old.service_variant_id
     or new.gross_price_fils   is distinct from old.gross_price_fils
     or new.net_fils      is distinct from old.net_fils
     or new.vat_fils      is distinct from old.vat_fils
  then
    raise exception
      'MigratedAppointmentIsNotLive: appointment % is reconstructed history (migrated), so its status, '
      'period, therapist, room, service and price are fixed. It was delivered under the previous '
      'arrangement and no transition of the live machine applies to it.',
        old.id
      using errcode = 'ZY361',
            hint = 'Correct a reconstructed visit by importing the corrected file, never by an edit.';
  end if;

  return new;
end
$$;

comment on function refuse_migrated_appointment_change() is
  'Raises ZY361 for a change to a migrated appointment''s booking facts and ZY362 for a change to the '
  'flag itself. Two codes because the remedies differ: the first is a fresh import, the second is that '
  'the question is wrong.';

create trigger appointment_migrated_is_not_live
  before update on appointment
  for each row execute function refuse_migrated_appointment_change();

create or replace function refuse_future_migrated_appointment()
returns trigger
language plpgsql
as $$
begin
  if not new.migrated then
    return new;
  end if;
  if upper(new.period) <= now() then
    return new;
  end if;
  raise exception
    'MigratedAppointmentIsNotHistory: appointment % is marked migrated but ends at %, which is in the '
    'future. A reconstructed visit was delivered under the previous arrangement; a row dated forward '
    'would be offered to the availability solver and swept for reassignment as though it were a booking.',
      new.id, upper(new.period)
    using errcode = 'ZY366',
          hint = 'Check the date columns of the file being imported. A visit still to happen is a booking, '
                 'taken through the booking path.';
end
$$;

comment on function refuse_future_migrated_appointment() is
  'Raises ZY366. A trigger and not a CHECK because now() is not immutable; the UPPER bound and not the '
  'lower, so a treatment that ran past midnight two hours ago still imports.';

create trigger appointment_migrated_is_in_the_past
  before insert or update on appointment
  for each row execute function refuse_future_migrated_appointment();

create or replace function refuse_imported_appointment_change()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'ImportedAppointmentIsAppendOnly: an imported-appointment record may not be %d. It is the evidence '
    'of what one line of one file was decided to be, and evidence that can be rewritten is not evidence.',
      lower(tg_op)
    using errcode = 'ZY364',
          hint = 'A line that was quarantined and has since been resolved is a NEW record, from a new '
                 'import run. Nothing removes the first one.';
end
$$;

comment on function refuse_imported_appointment_change() is
  'Raises ZY364. `imported_contact`''s decision (0121) and `import_row`''s (0111), for the same reason.';

create trigger imported_appointment_no_update
  before update on imported_appointment
  for each row execute function refuse_imported_appointment_change();

create trigger imported_appointment_no_delete
  before delete on imported_appointment
  for each row execute function refuse_imported_appointment_change();

create or replace function assert_imported_appointment_outcome()
returns trigger
language plpgsql
as $$
declare
  v_migrated boolean;
begin
  if new.appointment_id is null then
    return null;
  end if;
  select migrated into v_migrated from appointment where id = new.appointment_id;
  -- Null means the appointment has gone in this same transaction, which `on delete restrict` already
  -- refuses; treating it as "not migrated" keeps the message true either way.
  if coalesce(v_migrated, false) then
    return null;
  end if;
  raise exception
    'ImportedAppointmentNamesALiveBooking: imported-appointment record % names appointment %, which is '
    'not marked migrated. The record would attest a live booking as reconstructed history while the live '
    'machine went on treating it as a booking.',
      new.id, new.appointment_id
    using errcode = 'ZY365',
          hint = 'An import record names the row the import inserted. A booking taken through the '
                 'booking path has no import record.';
end
$$;

comment on function assert_imported_appointment_outcome() is
  'Raises ZY365 at COMMIT. The direction ZY363 does not cover: ZY363 refuses a migrated appointment with '
  'no record, this refuses a record pointing at a row that is not one.';

create constraint trigger imported_appointment_names_a_migrated_row
  after insert on imported_appointment
  deferrable initially deferred
  for each row execute function assert_imported_appointment_outcome();

create or replace function assert_migrated_appointment_attested()
returns trigger
language plpgsql
as $$
begin
  if not new.migrated then
    return null;
  end if;
  if exists (select 1 from imported_appointment where appointment_id = new.id) then
    return null;
  end if;
  raise exception
    'MigratedAppointmentIsUnattested: appointment % is marked migrated and no imported-appointment '
    'record names it. The flag is what keeps the row out of the live machine and out of the ledger, so a '
    'row carrying it that no import stands behind is a visit nobody can trace to a file and a line.',
      new.id
    using errcode = 'ZY363',
          hint = 'Insert the appointment through packages/migration''s appointment importer, which writes '
                 'the record in the same transaction.';
end
$$;

comment on function assert_migrated_appointment_attested() is
  'Raises ZY363 at COMMIT. 0119''s ZY258 shape: the mark that exempts a row from the ordinary rules may '
  'only be carried by a row an import attests to.';

create constraint trigger appointment_migrated_is_attested
  after insert or update of migrated on appointment
  deferrable initially deferred
  for each row execute function assert_migrated_appointment_attested();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
--
-- 0009 granted the application role all four verbs on every table in `public` and set default privileges
-- extending that to tables created later, so this table ARRIVED with UPDATE and DELETE granted. The
-- table-level REVOKE has to come first and cannot be narrowed by a column-list grant; 0121 records the
-- run this cost when it was left out.
revoke update, delete, truncate on imported_appointment from berelax_app;

-- `berelax_readonly` may not read it, which is `imported_contact`'s decision and the same argument: the
-- column is a keyed digest of contact details and a reader who can also compute the HMAC can test any
-- number against it. "Which visits is this person's history reconstructed from" is answered through the
-- application, and the aggregate questions the reporting connection asks are answered from
-- `appointment.migrated`, which it may read.
revoke select on imported_appointment from berelax_readonly;

commit;
