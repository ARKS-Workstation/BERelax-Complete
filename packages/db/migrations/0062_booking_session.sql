-- 0062 — the public booking flow's session: the verified phone carried from step 4 to step 5.
--
-- B-LIFE-02 stopped exactly here and said so: *"there is no verify endpoint, because a successful
-- verification has to mint a customer session or magic-link token and nothing in the system defines one
-- yet — B-UI-02."* This is that definition, and it is the smallest thing that can be one.
--
-- ## Why a row and not a signed cookie
--
-- Steps 1–3 of `/book` keep every choice in the URL, which is what makes them work with JavaScript off
-- (docs/09 §3). A verified phone cannot join them: `?phone=%2B971501234567&verified=1` is a URL anybody
-- can type, so the one fact that must not be forgeable is the one fact that cannot be in the query string.
--
-- A signed cookie would carry it without a table. It is not enough, and the reason is three of the nine
-- edge states docs/09 §3 enumerates:
--
--   * **session expiry mid-flow** has to be a fact the SERVER decides. A cookie expiry is advisory — the
--     browser is asked to drop it — and a `exp` claim inside a signed value is checked only by whatever
--     remembers to check it. `expires_at` here is read on every request by one function.
--   * **double submission** needs a stable idempotency key across two requests that may arrive in either
--     order. Derived from this row's id it is stable for as long as the attempt is; derived from anything
--     the client holds it is whatever the client sends twice.
--   * **browser back after confirm** needs the server to know that this attempt already produced a
--     booking. `booking_id` below is that knowledge, and a cookie cannot gain it after it was issued.
--
-- ## The token is stored hashed, and there is no column holding it
--
-- Exactly as `otp_challenge` holds no code (0019). The cookie carries 32 random bytes; this table holds
-- their SHA-256. A session token is a bearer credential for somebody's booking history for as long as it
-- lives, so a database dump that contained them would be a dump of live credentials. SHA-256 and not an
-- HMAC under a per-row salt, which is the one place this deliberately differs from `otp_challenge`: a
-- six-digit code has a million values and needs a salt so that two challenges sharing a code do not look
-- identical, while a 256-bit random token has nothing to guess and the lookup has to be by hash — which a
-- per-row salt makes impossible without reading every row.
--
-- Fast on purpose, and for the reason 0019 states about the code hash: no work factor helps a value that
-- cannot be guessed, and spending 100ms per request would put a measurable cost on every page load of the
-- booking flow.
--
-- ## Why `customer_id` and `booking_id` are plain uuids with NO foreign key
--
-- Two reasons, and the second is the one that has cost this build real time.
--
-- The first is the one 0005, 0016, 0024 and 0056 all state: a row that records what somebody did has to
-- outlive the identity it is about. `consent.contact_customer_id` is a plain uuid for exactly this, and
-- 0056's NOTE spells out the consequence of the alternative — a cascade fires `customer`'s row-level
-- refusal trigger and makes `delete from customer` raise for every caller.
--
-- The second is mechanical: PostgreSQL refuses `TRUNCATE` on a table a foreign key points at unless every
-- referencing table is named in the same statement. B-MSG-03 learned this by adding `appointment`'s first
-- referencing key and turning 24 of `booking-constraints.itest.ts`'s 24 cases red in a file it never
-- touched. Four suites truncate `appointment` and four clear `customer`; a key from here would break all
-- eight, and the failure would look nothing like its cause.
--
-- The trade is stated rather than hidden: nothing stops a `customer_id` here naming a row that has been
-- erased. That is the same trade `consent` makes, and the reader of this table is a booking flow that
-- checks the row it is about anyway.
--
-- ## Retention
--
-- No sweep job. A row lives twenty minutes and is read by one flow, so this table's growth is one row per
-- booking attempt and nothing depends on an old one — but nothing prunes them either, and that is
-- recorded rather than implied: the retention schedule docs/04 §8 asks for is a single pass over every
-- table that holds a personal identifier, and a private sweep for this one would be the first of fourteen.
-- `booking_session_expires_at_idx` is the index that pass will use.

begin;

create table booking_session (
  id           uuid        primary key default uuid_generate_v7(),
  -- SHA-256 of the 32 random bytes the cookie carries. There is no column holding the token itself.
  -- UNIQUE because it is what a request is resolved by, and the length is CHECKed so a caller that
  -- stored the token raw (32 ASCII hex characters is 32 octets too — hence the digest check below is
  -- length plus the repository's own hashing, not length alone) is at least storing something of the
  -- right size.
  token_hash   bytea       not null unique
                 constraint booking_session_token_hash_is_a_digest check (octet_length(token_hash) = 32),
  -- The number the code was sent to, normalised by `normalisePhone` in @berelax/core. Not a foreign key
  -- to `customer`, and not nullable: a session exists from the moment a code is requested, which is
  -- before anybody knows whether the number is a customer — the same enumeration-resistance argument
  -- `otp_challenge.phone_e164` makes in 0019.
  phone_e164   text        not null
                 constraint booking_session_phone_is_e164 check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- Set together with `verified_at`, by the verification. A plain uuid; see the header.
  customer_id  uuid,
  verified_at  timestamptz,
  -- Supplied by the caller from an injected clock rather than defaulted, for the reason 0019 gives about
  -- `otp_challenge.expires_at`: every assertion about expiry is made under a frozen clock, and a column
  -- that reads the wall clock cannot be tested without waiting.
  expires_at   timestamptz not null,
  -- The booking this attempt produced. Plain uuid; see the header. Null until the confirm step commits.
  booking_id   uuid,
  created_at   timestamptz not null default now(),
  -- One fact said once. A verified session names a customer and an unverified one does not, and the two
  -- columns drifting apart is how a flow comes to trust a phone nobody proved: `verified_at is not null`
  -- reads as "verified" everywhere, so a row with no customer id would pass that test and then book for
  -- nobody.
  constraint booking_session_verification_names_a_customer
    check ((verified_at is null) = (customer_id is null)),
  -- A booking can only belong to a verified attempt. Without this an unverified session could carry a
  -- booking id, and `back_after_confirm` would be decided from a row that never proved a phone.
  constraint booking_session_booking_requires_verification
    check (booking_id is null or verified_at is not null),
  constraint booking_session_expires_after_it_starts check (expires_at > created_at)
);

comment on table booking_session is
  'The public booking flow''s short-lived session: the phone a code was sent to, the customer it was '
  'verified as, and the booking the attempt produced. The cookie carries 32 random bytes; this table '
  'holds their SHA-256 and no column holds the token. customer_id and booking_id are plain uuids with '
  'no foreign key, so the record outlives an erasure and no TRUNCATE of appointment or customer is '
  'refused because of it (0056 NOTE 4, B-MSG-03''s TRUNCATE finding).';

comment on column booking_session.token_hash is
  'SHA-256 of the cookie token. Not an HMAC under a per-row salt, unlike otp_challenge.code_hash: a '
  '256-bit random token has nothing to guess, and the lookup has to be BY hash.';

comment on column booking_session.expires_at is
  'When the verification stops being trusted. Read on every request, which is what makes "session '
  'expiry mid-flow" (docs/09 §3) a state the server decides rather than a cookie attribute a browser '
  'is asked to honour.';

comment on column booking_session.booking_id is
  'The booking this attempt produced, or null. What makes "browser back after confirm" (docs/09 §3) '
  'answerable: the flow renders the confirmation again instead of the form, so a second slot cannot be '
  'taken for one customer.';

-- The read the flow makes on every request is by `token_hash`, which the UNIQUE constraint indexes. This
-- second index is for the two reads that are not: the resend cooldown asks for this number's live
-- sessions, and the retention pass named in the header asks for the expired ones.
create index booking_session_phone_idx on booking_session (phone_e164, created_at desc);
create index booking_session_expires_at_idx on booking_session (expires_at);

commit;
