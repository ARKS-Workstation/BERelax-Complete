-- 0067 — the manage-booking grant: the magic link a reminder carries (B-UI-05).
--
-- B-UI-02 and B-MSG-03 both stopped here and both said the same thing: `MagicLinkBuilder` answers null,
-- a due reminder is SKIPPED with `content_unavailable`, and the confirmation renders the manage region as
-- a named designed state with the desk telephone number — because *"a link to a 404 in a reminder is a
-- customer who thinks the salon has lost their booking"*. This is the table that makes the link real.
--
-- ## The shape is the third of three, and it is not a third shape
--
-- `booking_session` (0062) holds the SHA-256 of 32 CSPRNG bytes and no column holds the token.
-- `optout_grant` (0064) does the same with an expiry on the row and revocation by DELETE. This table is
-- both of those: 32 bytes, only the digest, expiry on the row, DELETE is the revocation. Nothing here is
-- re-argued — the three reasons M-VAT-11 recorded for a stored grant rather than a signature (no eighth
-- signing secret with a rotation section somebody follows at 02:00; revocable without breaking every
-- other link; the row records that the link existed) hold unchanged.
--
-- The one difference from `optout_grant` is the digest's column type, and it is deliberate: `text` with a
-- `~ '^[a-f0-9]{64}$'` CHECK, matching 0064, rather than 0062's `bytea`. The lookup is by digest from a
-- Node caller that has just produced it with `createHash('sha256').digest('hex')`, and a `bytea`
-- round-trip through the driver is one more representation for the two sides to disagree about.
--
-- ## Why the TTL is on the ROW and computed from the appointment
--
-- Neither of the other two tables could do this. A booking session lives twenty minutes because somebody
-- is filling in a form; an opt-out grant lives thirty days because somebody is reading a three-week-old
-- SMS. This link's life is a property of the thing it is about: it dies 24 hours after the appointment
-- ENDS, so a booking taken six weeks out gets a link that works on the night without being a credential
-- that is valid for six weeks, and the customer who reads the reminder after the treatment still gets a
-- page rather than a 404. `bookingTokenExpiry` in @berelax/core is the arithmetic; `expires_at` is what
-- was decided, stored, so an expiry assertion is made against a row under a frozen clock rather than
-- recomputed by the reader.
--
-- `expires_at` is supplied and never defaulted, for the reason 0062 and 0064 both give about theirs:
-- every assertion about expiry is made under a frozen clock, and a column that reads the wall clock
-- cannot be tested without waiting.
--
-- ## Why `booking_id` is a plain uuid with NO foreign key
--
-- It was written as a real foreign key with `ON DELETE CASCADE` first, and the argument was that this row
-- is a live CAPABILITY rather than a record of what somebody did — so a grant naming an erased booking is a
-- credential pointing at nothing, and a cascade is the correct semantics. That argument rested on a claim
-- about this repository that is simply false: "no suite truncates `booking`".
--
-- Four do. `booking-constraints.itest.ts` (three sites), `catalogue.itest.ts`,
-- `catalogue-compliance.itest.ts` and `repositories/catalogue.itest.ts` all run
-- `truncate booking_idempotency, appointment_status_history, scheduled_step, appointment, booking`, and
-- PostgreSQL refuses a TRUNCATE while a referencing table is absent from the statement. The key turned all
-- 24 of `booking-constraints.itest.ts`'s 24 cases red — in a file this unit never touched, with a message
-- naming neither the migration nor the key. That is B-MSG-03's `scheduled_step` finding arriving a second
-- time, from the other table.
--
-- B-MSG-03 answered it by NAMING the new table in each truncate list. This one does not, because three
-- tables have since made the opposite decision and written down why: `invoice.booking_id`,
-- `checkout_idempotency` and 0051's own `appointmentId` are each a plain uuid with a comment saying "no
-- foreign key, deliberately: four integration suites truncate appointment and booking by an explicit
-- list". Four call sites edited in four other units' files, against a convention those units established,
-- is the wrong side of that trade for one column.
--
-- What the absence costs is stated rather than hidden: a `delete from booking` leaves a live grant row
-- behind. It grants nothing — the page reads the booking the grant names and answers the same 404 as an
-- unknown token when there is no row — so the cost is a dead row in a table with no sweep, which is the
-- same cost 0062 accepts for `booking_session` and for the same reason. The retention pass docs/04 §8 asks
-- for will find it through `booking_manage_grant_expiry_idx`, and a cancellation still revokes by DELETE,
-- which is the path that matters: a booking is cancelled far more often than it is erased.
--
-- The grant is per BOOKING and not per appointment, and that is the acceptance criterion read exactly:
-- *"a token grants access to exactly one booking"*. A couples booking is two appointment rows over one
-- commercial record, and a link per appointment would send two links for one evening — one of which moves
-- half a couple.
--
-- ## Retention, and the sweep this table does not have
--
-- No sweep job, stated rather than implied, exactly as 0062 states it. A grant is dead 24 hours after its
-- appointment ends and nothing reads a dead one, but nothing prunes them either: the retention schedule
-- docs/04 §8 asks for is a single pass over every table holding a personal identifier, and a private
-- sweep for this one would be the first of fifteen. `booking_manage_grant_expiry_idx` is the index that
-- pass will use, and it is the same index the revocation-on-cancellation path reads.

begin;

create table booking_manage_grant (
  id            uuid        primary key default uuid_generate_v7(),
  -- The sha256 of the token, lower-case hex, never the token. UNIQUE because it is what a request is
  -- resolved BY, which is also why there is no per-row salt: a salted digest cannot be looked up without
  -- reading every row, and a 256-bit random token has nothing to guess (0062 states the same trade
  -- against `otp_challenge.code_hash`, which IS salted because six digits have a million values).
  token_sha256  text        not null unique
                  constraint booking_manage_grant_token_shape
                    check (token_sha256 ~ '^[a-f0-9]{64}$'),
  -- The booking the link manages. A plain uuid with NO foreign key — see the header: four integration
  -- suites truncate `booking` by an explicit list, and this is the decision `invoice.booking_id` and
  -- `checkout_idempotency` already made for the same reason.
  booking_id    uuid        not null,
  -- SINGLE PURPOSE, and a column although only one value is legal today. The realistic second purpose is
  -- near — a clinical-intake link, a receipt link — and a token whose purpose was implicit would be valid
  -- for both of them retroactively, which is how a link that moves an appointment becomes a link that
  -- hands over an intake form. Pinned to BOOKING_TOKEN_PURPOSES in @berelax/core by
  -- apps/web/src/manage-booking.itest.ts.
  purpose       text        not null
                  constraint booking_manage_grant_purpose_known
                    check (purpose in ('manage_booking')),
  -- Supplied, never defaulted; see the header.
  issued_at     timestamptz not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  -- A grant that has already expired when it is written is a link that reads as simply broken. The same
  -- constraint 0064 carries, and here it also catches the one arithmetic mistake this table's TTL invites:
  -- anchoring the expiry to the appointment's START, which for a booking minted mid-treatment would be in
  -- the past.
  constraint booking_manage_grant_expires_after_issue check (expires_at > issued_at)
);

comment on table booking_manage_grant is
  'An expiring capability to manage ONE booking with no login: the magic link a reminder carries '
  '(B-UI-05, docs/06 D2). Only the sha256 of the token is stored and no column holds the token. A '
  'stored grant rather than an HMAC over the URL, for M-VAT-11''s three reasons; revocation is a DELETE '
  'and the audit_event for the minting survives it, so this table is deliberately NOT append-only.';

comment on column booking_manage_grant.token_sha256 is
  'Lower-case hex sha256 of the token. The token itself is 32 CSPRNG bytes rendered as 64 lower-case hex '
  'characters, and hex rather than base64url because the token is a PATH segment: the site''s canonical '
  'redirect lower-cases every path, so a mixed-case token would be destroyed by an ordinary 301.';

comment on column booking_manage_grant.expires_at is
  'Twenty-four hours after the appointment ENDS, not a fixed TTL from issue. A fixed TTL long enough for '
  'a booking taken six weeks out would be a credential valid for six weeks; anchoring to the end makes '
  'the link alive for as long as there is anything to change, plus a day for the customer reading the '
  'reminder afterwards.';

comment on column booking_manage_grant.booking_id is
  'The booking this link manages. A plain uuid with NO foreign key, exactly as invoice.booking_id and '
  'checkout_idempotency.booking_id are: four integration suites truncate booking by an explicit list and '
  'PostgreSQL refuses a truncate while a referencing table is absent from it. A grant left behind by an '
  'erased booking grants nothing - the page answers the same 404 as an unknown token.';

-- The read the page makes is by `token_sha256`, which the UNIQUE constraint indexes. These two are for
-- the reads that are not: revocation on cancellation asks for a booking's live grants, and the retention
-- pass named in the header asks for the expired ones.
create index booking_manage_grant_booking_idx on booking_manage_grant (booking_id, expires_at desc);
create index booking_manage_grant_expiry_idx on booking_manage_grant (expires_at);

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009's `alter default privileges` grants berelax_app select/insert/update/delete on tables created in
-- public afterwards. DELETE stays granted and IS the revocation path — a cancellation removes the
-- booking's live links, and a link minted for the wrong booking is removed the same way. TRUNCATE is
-- revoked because "remove every live link in the salon" is not an operation any request should be able to
-- perform, and UPDATE is revoked because there is no legitimate edit to a capability: a different expiry
-- or a different booking is a different grant, and an UPDATE here would move a live link onto somebody
-- else's booking in one statement.
revoke update, truncate on booking_manage_grant from berelax_app;

-- `berelax_readonly` may NOT read this table, for the reason 0064 gives about `optout_grant`'s
-- neighbours: a reporting connection has no question that needs the digests, and a reader who holds them
-- holds the lookup key for every live link in the salon. 0009 grants select on every future public table
-- through `alter default privileges`, so this revoke is what makes that not true here.
revoke select on booking_manage_grant from berelax_readonly;

commit;
