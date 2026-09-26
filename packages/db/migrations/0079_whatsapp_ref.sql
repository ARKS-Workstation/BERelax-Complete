-- 0079_whatsapp_ref.sql — B-UI-04
--
-- The WhatsApp ref loop, as two tables: the codes A-FIRST will generate, and what the front desk did with
-- one when it took a booking.
--
-- ============================================================================================
-- What this migration is FOR, and the one thing it refuses to make possible
-- ============================================================================================
--
-- docs/03 asks for the click-to-WhatsApp funnel to join up to a booking. The join can only be made by a
-- human at a counter typing four characters, which is why Y12-ref-loop exists and asks whether they will.
-- The build does not know, and this schema is arranged so that the answer being "no" produces an honest
-- gap rather than a wrong number:
--
--   * `booking_whatsapp_ref_capture` holds ONE row per booking taken at the desk, whatever happened — the
--     code matched, the code matched nothing, or no code was offered. So a capture RATE is two counts over
--     one table rather than a matched-count divided by a guess at how many bookings there were.
--   * Two CHECK constraints make an invented attribution unrepresentable. `matched` REQUIRES a
--     `ref_code`, and a `ref_code` requires `matched`; an unmatched row cannot carry one at all. There is
--     no state in which a booking names a conversation nobody proved it came from, and that is a property
--     of the column rather than of whichever handler wrote the row.
--
-- The alternative shape — a nullable `whatsapp_ref` column on `booking` — was rejected for two reasons
-- worth writing down. A null there means BOTH "no code offered" and "a code that matched nothing", which
-- are the two findings Y12-ref-loop needs told apart: "the desk is not pasting" is a training problem and
-- "the desk is pasting codes we have no rows for" is A-FIRST not having written the row. And a column on
-- `booking` would put a `customer`-reachable attribution inside the merge participant registry
-- (C-CRM-05), which is a question this unit has no business answering: the attribution belongs to the
-- BOOKING, not to the person, so a merge of two client records must not move it.
--
-- ============================================================================================
-- Why the outcome is an enum and the CRM vocabularies (0053) are tables
-- ============================================================================================
--
-- 0053 made `customer_lifecycle_state` and `customer_acquisition_source` TABLES because every label is a
-- provisional claim about a person that the owner may correct, and an enum label cannot carry
-- `is_provisional`, an OPEN-QUESTIONS id or a note. None of that applies here. These three outcomes are
-- the exhaustive result of a string comparison against a primary key: there is no fourth answer for
-- somebody to supply, nothing to confirm, and no label anyone could correct. An enum is therefore the
-- right instrument, and adding a member would be a code change in `@berelax/core` either way — the
-- vocabulary is pinned to `REF_CAPTURE_OUTCOMES` in `packages/core/src/booking/ref-capture.ts`.
--
-- ============================================================================================
-- Why `booking_id` is NOT a foreign key
-- ============================================================================================
--
-- It was one, ON DELETE CASCADE, and it had to go. `invoice.booking_id`, `checkout_idempotency.booking_id`
-- and `booking_manage_grant.booking_id` all reference NOTHING for the same reason, and 0067's header
-- records B-UI-05 discovering it exactly as this unit did: six integration suites in three files
-- `truncate booking_idempotency, appointment_status_history, scheduled_step, appointment, booking` by an
-- EXPLICIT list, and PostgreSQL refuses a truncate while a referencing table is absent from the statement.
-- Adding the key turned every case in `booking-constraints.itest.ts` and `catalogue.itest.ts` red, in files
-- this unit never touched, and produced a second wave of `booking_customer_id_fkey` failures in three more
-- suites -- because a truncate that did not happen leaves bookings behind for whoever deletes a customer
-- next.
--
-- The alternative was to add this table to all six lists. That is what those lists are for, and
-- `booking-constraints.itest.ts` says so ("Named rather than reached with CASCADE, so the next table shows
-- up here as a failing test"). It was rejected because the repository has already taken the other branch
-- three times: a fourth table quietly following the same precedent is one decision, where a fourth table
-- editing three other units' test files is six edits and a merge conflict with anybody else holding them.
--
-- What is lost is the cascade, and the cost is bounded rather than absent. In PRODUCTION a booking is never
-- deleted -- it is cancelled, which is a status, and `booking.customer_id` is ON DELETE RESTRICT so a
-- customer cannot be removed while one exists -- so an orphan capture row is unreachable. In TESTS a
-- fixture that deletes its bookings must delete its capture rows first, and both of this unit's suites do,
-- explicitly. `booking_id` stays the PRIMARY KEY, so "one booking, one capture row" is unchanged.
--
-- ============================================================================================
-- Why these two are NOT append-only tables
-- ============================================================================================
--
-- A capture row is evidence, and the obvious move is the ADR 0017 trigger pair. What is wanted is that the
-- application can write a capture row and never rewrite one, and a trigger pair is a heavier instrument
-- than that needs: it would also refuse the fixture cleanup above, which is the only legitimate DELETE
-- there is.
--
-- So the protection is at the PRIVILEGE level: UPDATE, DELETE and TRUNCATE are revoked from `berelax_app`
-- at the foot of this file, while the owner role a migration and a fixture run as keeps them. That is a
-- weaker promise than a trigger and it is stated as the weaker promise rather than dressed up as the
-- stronger one.

-- ---------------------------------------------------------------------------------------------
-- The codes
-- ---------------------------------------------------------------------------------------------

create table whatsapp_ref (
  -- Four characters from A-Z and 2-9, less I, O, 0 and 1. The alphabet and this pattern are one rule
  -- spelled twice; `WHATSAPP_REF_CODE_CLASS` in packages/shared/src/whatsapp-ref.ts is the other spelling
  -- and its own test proves the two describe the same set. The exclusions are the four characters a person
  -- reading a code off a phone screen confuses, and the confusion is not recoverable later: a booking
  -- attributed to the wrong conversation is indistinguishable from one attributed to the right one.
  ref_code          text        primary key check (ref_code ~ '^[A-HJ-NP-Z2-9]{4}$'),

  -- A-FIRST's own handle for the WhatsApp conversation this code was issued into. Opaque here on purpose:
  -- this build has no WhatsApp number at all (Y1-nap records two rival candidates and picks neither), so
  -- any column shaped like a phone number would be a column this migration could not honestly fill. The
  -- handle is whatever the unit that owns the conversation says it is.
  --
  -- Deliberately NOT unique. The manifest's contract is "short code -> session", a many-to-one: a
  -- conversation that comes back next month gets a second code, and both attribute to the same session.
  -- A unique constraint here would refuse a legitimate reissue by a unit that does not exist yet, which is
  -- a guess about A-FIRST's behaviour dressed as a safety rule.
  session_reference text        not null check (btrim(session_reference) <> ''),

  -- When A-FIRST handed the code out. Separate from `created_at` because a backfill of historic
  -- conversations would write rows today for codes issued weeks ago, and a funnel report that could not
  -- tell those apart would attribute a September booking to an October code.
  issued_at         timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

comment on table whatsapp_ref is
  'The short codes A-FIRST issues into a WhatsApp conversation, as the booking side of the funnel join. '
  'This build writes NO rows: it ships empty, so every code the front desk types is `unknown_code` until '
  'the unit that owns the conversation starts generating them - which is the honest state and is visible '
  'on the quick-book screen rather than hidden behind a zero. Y12-ref-loop.';
comment on column whatsapp_ref.ref_code is
  'Four characters from A-Z2-9 less I, O, 0 and 1 - the four a person misreads off a screen. The same rule '
  'as WHATSAPP_REF_CODE_CLASS in @berelax/shared, which is what the page''s input pattern is built from.';
comment on column whatsapp_ref.session_reference is
  'A-FIRST''s opaque handle for the conversation. Not a phone number: Y1-nap has not said which WhatsApp '
  'number is the business, so a column shaped like one could not be honestly filled. Not unique - a '
  'conversation may be issued a second code, and both attribute to it.';
comment on column whatsapp_ref.issued_at is
  'When the code was handed out, which a backfill makes different from created_at.';

-- The funnel reads "which codes were issued in this window", never "which code is this". The primary key
-- serves the lookup the booking path makes.
create index whatsapp_ref_issued_at_idx on whatsapp_ref (issued_at desc);

-- ---------------------------------------------------------------------------------------------
-- What the desk did with one
-- ---------------------------------------------------------------------------------------------

create type whatsapp_ref_capture_outcome as enum (
  -- A code was typed and it equals a row in `whatsapp_ref`. The only outcome that carries an attribution.
  'matched',
  -- Something was typed and it matched nothing. The booking was taken and a warning was shown; what was
  -- typed is KEPT, because "the desk pastes codes we have no rows for" and "the desk does not paste" are
  -- different findings and only the stored text separates them.
  'unknown_code',
  -- The field was left blank. Nothing was claimed, and this is not a failure: the field is optional and
  -- nobody has yet said the desk is supposed to fill it (Y12-ref-loop).
  'not_offered'
);

comment on type whatsapp_ref_capture_outcome is
  'The exhaustive result of comparing what the desk typed against whatsapp_ref. An ENUM and not a table, '
  'unlike the 0053 CRM vocabularies: there is no fourth answer for the owner to supply and no label to '
  'correct, so nothing here needs is_provisional. Pinned to REF_CAPTURE_OUTCOMES in @berelax/core.';

create table booking_whatsapp_ref_capture (
  -- The booking, and the primary key. One booking, one capture row: a second row for one booking would be
  -- two claims about where it came from, and the rate would count it twice.
  --
  -- NO foreign key, exactly as `invoice.booking_id`, `checkout_idempotency.booking_id` and
  -- `booking_manage_grant.booking_id` carry none. See the header: six suites truncate `booking` by an
  -- explicit list, and a referencing table absent from that statement makes the truncate fail.
  booking_id   uuid    primary key,
  outcome      whatsapp_ref_capture_outcome not null,

  -- The attribution. ON UPDATE CASCADE would be meaningless (a code is never renamed) and ON DELETE
  -- RESTRICT is the point: a code a booking is attributed to cannot be removed from under it.
  ref_code     text    references whatsapp_ref (ref_code) on delete restrict,

  -- What the desk typed, when it matched nothing. Normalised where it could be (upper case, trimmed) so a
  -- code A-FIRST issues LATER joins against it; verbatim where it could not be, because the evidence that
  -- the desk IS pasting something is worth more than a tidy column.
  entered_code text,

  recorded_at  timestamptz not null default now(),

  -- The two constraints that make an invented attribution unrepresentable. Written as equalities rather
  -- than as two one-way implications, which is what closes both holes at once: a `matched` row with no
  -- code (an attribution nobody can follow) and a code on an unmatched row (an attribution nobody
  -- proved).
  constraint booking_whatsapp_ref_capture_matched_names_its_ref
    check ((outcome = 'matched') = (ref_code is not null)),
  -- And the mirror for the typed text, so `unknown_code` cannot be recorded with the evidence dropped and
  -- no other outcome can carry a value a reader might mistake for an attribution.
  constraint booking_whatsapp_ref_capture_unknown_keeps_what_was_typed
    check ((outcome = 'unknown_code') = (entered_code is not null))
);

comment on table booking_whatsapp_ref_capture is
  'One row per booking taken at the front desk, recording what happened to the WhatsApp ref field - '
  'matched, matched nothing, or not offered. The denominator of the capture rate is therefore a count of '
  'THIS table and not a guess at how many bookings there were. Two CHECK constraints make an invented '
  'attribution unrepresentable: a ref code and the `matched` outcome imply each other exactly. UPDATE, '
  'DELETE and TRUNCATE are revoked from berelax_app rather than refused by a trigger - see the header for '
  'why a trigger pair would break the booking cascade. Y12-ref-loop.';
comment on column booking_whatsapp_ref_capture.booking_id is
  'The booking, and the key. Keyed on the BOOKING and not the customer on purpose: an attribution is a '
  'property of the booking, so a client-record merge (C-CRM-05) must not move it, and this table '
  'therefore carries no customer id to register there. NOT a foreign key, for the reason '
  'invoice.booking_id and booking_manage_grant.booking_id carry none - six suites truncate `booking` by an '
  'explicit list. See this migration''s header.';
comment on column booking_whatsapp_ref_capture.ref_code is
  'The matched code, and null for every other outcome. ON DELETE RESTRICT: a code a booking is attributed '
  'to cannot be removed from under it.';
comment on column booking_whatsapp_ref_capture.entered_code is
  'What the desk typed when it matched nothing, kept so that "pasting codes we have no rows for" is '
  'distinguishable from "not pasting". Null for every other outcome.';

-- The capture rate is `count(*) filter (where outcome = ...)` over a window. A partial index on `matched`
-- would serve the numerator and not the denominator, and the denominator is the half this unit exists to
-- stop being a guess - so the index is on the outcome, which serves both.
create index booking_whatsapp_ref_capture_outcome_idx
  on booking_whatsapp_ref_capture (outcome, recorded_at desc);
-- The join back the other way: "which bookings came from this conversation's code". Partial, because
-- `ref_code` is null on every row but the matched ones and an index over those nulls would be mostly air.
create index booking_whatsapp_ref_capture_ref_code_idx
  on booking_whatsapp_ref_capture (ref_code)
  where ref_code is not null;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009's `alter default privileges` grants berelax_app select/insert/update/delete on tables created in
-- public afterwards, so these revokes are load-bearing rather than decorative. Stated explicitly because
-- a managed database restored from a dump does not necessarily carry the same defaults.

-- A capture row is written once and never rewritten by the application. DELETE is revoked too: the only
-- legitimate one is a fixture removing its own rows, which runs as the owner.
revoke update, delete, truncate on booking_whatsapp_ref_capture from berelax_app;

-- A code is issued once. It is never edited (there is nothing on the row to correct) and never deleted
-- while a booking is attributed to it - which the ON DELETE RESTRICT above already refuses, and this
-- makes true for a code nothing references as well: a code withdrawn after the fact would silently turn a
-- matched booking into one whose attribution cannot be followed.
revoke update, delete, truncate on whatsapp_ref from berelax_app;
