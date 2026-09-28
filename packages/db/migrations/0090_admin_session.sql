-- 0090 — the admin session: a staff credential, and the session a cookie names.
--
-- W-SYS-11. F07 landed `packages/auth` — scrypt hashing, TOTP and `issueSession` — and the
-- authorisation matrix in `packages/core`. It landed no identity store, so nothing could hold a
-- password or a second-factor seed and no cookie had a row to point at. Every admin route therefore
-- took its reader from a query parameter (`?employee=`, `?role=`) and said so in a comment deferring
-- the session to W-SYS-01, which is `status: done` and built the Next.js app shell. This migration is
-- the storage half of closing that.
--
-- ## There is no new `staff` table, and that is the point
--
-- `employee` (0030, extended by 0050) is already the employment record: a staff reference, an
-- employment period, skills, wages and sealed PII. B-AVAIL-04's NOTE hands every later unit the same
-- seam — "P-HR extends employee ... rather than introducing its own tables" — and a second answer to
-- "who is this member of staff" is exactly what that forbids. So a credential REFERENCES an employment
-- record; it does not describe a person. Nothing below holds a name, a gender, an email address or a
-- date of birth, because none of those is needed to decide whether a password matches.
--
-- ## Why two tables and not one
--
-- A credential is long-lived and a session is not. With one table, logging in is an UPDATE of the row
-- that holds the password hash, so a bug in session handling writes to the credential; and a second
-- concurrent login either overwrites the first session or needs a second set of session columns. Two
-- tables make "log out everywhere" a DELETE of the sessions and not a change to the credential, and
-- they make the join below the only way to reach a role.
--
-- ## The session row holds NO role, and the cookie holds no payload at all
--
-- This is the property the whole unit rests on, so it is structural rather than documented. The cookie
-- carries 32 random bytes and nothing else — no claims, no signature, no role — and `staff_session` has
-- no `role`, `permission` or `field_group` column for one to be copied into. A request's role is
-- reached ONLY by joining a live session to its credential, which means:
--
--   * a tampered cookie names no row, so it is refused rather than read;
--   * a role changed on the credential takes effect on the next request, with nothing to invalidate;
--   * there is no representable state in which a session's authority disagrees with its credential's.
--
-- A signed cookie carrying `{role}` would need none of these tables and would lose all three. The
-- middle one is the one that has bitten other systems: a JWT's claims are a copy of the row taken at
-- login, and demoting somebody does not reach the copies. `apps/web/src/session.itest.ts` asserts the
-- absence of such a column by reading `information_schema`, so adding one fails a test rather than
-- quietly reintroducing the forgeable shape.
--
-- ## The token is stored hashed, exactly as `booking_session` (0062) and `otp_challenge` (0019) are
--
-- The cookie carries the token once; this table holds its SHA-256 and no column holds the token. A
-- session token is a bearer credential for the whole admin estate for as long as the row lives, so a
-- table containing them would be a table of live credentials and a database dump would be a break-in.
--
-- SHA-256 and not an HMAC under a per-row salt, which is the deliberate difference from
-- `otp_challenge.code_hash` and the one 0062 states in the same words: a six-digit code has a million
-- values and needs a salt so two challenges sharing a code do not look identical, while a 256-bit
-- random token has nothing to guess and the lookup HAS to be by hash — a per-row salt would make
-- resolving a cookie a full-table scan. Fast on purpose for the same reason: no work factor helps a
-- value nobody can guess, and 100 ms per request would be 100 ms on every admin page load. The
-- PASSWORD is the value that needs a work factor, and it has one (scrypt N=2^16, `packages/auth`).
--
-- ## What this migration does NOT seed, and why that is the whole security property
--
-- **No credential row.** Not one, in no environment. `Y8-staff` is open — the handover has supplied a
-- headcount and nineteen photographs and nothing else — so a seeded admin account would be an invented
-- person with an invented password (brief rule 15), and it would be the account nobody rotates because
-- nobody knows it exists. The consequence is deliberate and is the acceptance criterion: **a deployment
-- with no `staff_credential` row refuses every login.** There is no bootstrap account, no
-- `APP_ENV=development` branch, no environment variable that stands in for a row, and no "first login
-- creates an owner". Any of those would put a way past authentication into the one part of the system
-- whose entire job is to have none — and each is the kind of thing that is added for a demo and found
-- in production two years later.
--
-- The way in is therefore an operator INSERTing the first credential, which is deployment work with a
-- runbook (docs/runbooks/admin-access.md) and not code. The integration suite creates its own
-- principals (`packages/fixtures/src/admin-principal.ts`) and removes them, which is what lets the
-- login path be proven against a real row without a fixture account existing in any deployment.
--
-- ## The TOTP secret is stored in a readable column, and that is a stated weakness
--
-- TOTP is a SHARED secret: verification recomputes the code, so unlike the password there is no
-- one-way form the server can hold. The options were a readable column or sealing it under
-- `STAFF_PII_KEK` (0050), and this takes the first for a reason worth recording rather than
-- rediscovering. 0050's own header states that `scripts/rotate-kek.mjs` cannot rotate the staff
-- estate — its table list is a literal union of the two clinical tables — so a secret sealed under that
-- key could not be rotated by any command in this repository, and sealing an AUTHENTICATION secret
-- under an unrotatable key trades a readable column for an unfixable one. It would also make
-- `STAFF_PII_KEK` a hard dependency of logging in at all: with the key absent nobody could reach the
-- admin, which is a far larger outage surface than the column is a disclosure surface.
--
-- What remains true: the password hash is the factor that resists a dump, `berelax_readonly` is
-- revoked from this table below, and a dump holding both a scrypt hash and a TOTP seed still requires
-- breaking scrypt before the seed is worth anything. The honest summary is that this table is a
-- credential store and must be treated as one. Sealing the seed is a real improvement and is NOT
-- deferred to a unit here, because no `todo` unit owns the staff-KEK rotation command that would have
-- to exist first; it is reported as a known limitation of W-SYS-11 instead of parked against a unit
-- that would never pick it up. That is the M-TILL-09 mistake this unit exists because of.

begin;

-- ---------------------------------------------------------------------------------------------
-- staff_credential — what a member of staff signs in with, and the role they sign in as
-- ---------------------------------------------------------------------------------------------
create table staff_credential (
  id                uuid        primary key default uuid_generate_v7(),

  -- The employment record this credential belongs to. UNIQUE: one sign-in per member of staff, because
  -- two credentials for one person are two passwords to rotate and two rows to revoke, and an
  -- offboarding that found one of them would look complete.
  --
  -- ON DELETE RESTRICT and not CASCADE. A credential is the evidence that somebody had access, and
  -- `employee` rows are not deleted in this system anyway (employment is a PERIOD — 0030 chose
  -- `employed_until` over an `is_active` flag precisely so that leaving is recorded rather than
  -- erased). RESTRICT makes an attempted deletion raise instead of silently taking the access record
  -- with it; revoking access is `delete from staff_credential`, which is a different act.
  employee_id       uuid        not null unique
                      references employee (id) on delete restrict,

  -- The role, and therefore every permission. `text` with a CHECK rather than a Postgres enum, matching
  -- `cms_user.role` (which is a Payload `select` over the same list) so the two spellings of "which
  -- roles exist" are both constrained rather than one being free text.
  --
  -- The list mirrors `ROLES` in `@berelax/core/access`, which is the matrix `can(role, permission)`
  -- reads. It is duplicated here because a CHECK cannot import TypeScript, and the duplication is
  -- CHECKED rather than trusted: `apps/web/src/session.itest.ts` asserts this constraint accepts
  -- exactly the eight values `ROLES` declares and refuses a ninth, so the two cannot drift. Without
  -- that test this list is the kind of copy that silently falls behind and produces accounts the matrix
  -- denies everything to — which presents as "the admin is broken for this person" and not as a drift.
  role              text        not null
                      constraint staff_credential_role_is_a_known_role
                      check (role in ('owner', 'manager', 'accountant', 'receptionist',
                                      'therapist', 'marketer', 'auditor', 'system')),

  -- scrypt, from `hashPassword` in @berelax/auth: `scrypt$N$r$p$salt$derived`, base64 for the last two.
  -- The prefix is CHECKed so a caller that stored a plaintext password, or a digest from some other
  -- scheme, is refused by the database rather than discovered by a login that never matches. It cannot
  -- check the work factor, which is `packages/auth`'s to choose and `auth.test.ts`'s to assert.
  password_hash     text        not null
                      constraint staff_credential_password_is_scrypt
                      check (password_hash like 'scrypt$%'),

  -- The base32 TOTP seed, or NULL for "not enrolled". Nullable is load-bearing: `resolveLoginStage` in
  -- @berelax/auth distinguishes `totp_enrolment_required` from `totp_required`, and the first of those
  -- is the state a role that MUST have a second factor is in before it has one. A NOT NULL here would
  -- make that state unrepresentable and force enrolment to happen outside the login, which is where a
  -- "temporarily skip TOTP" branch comes from.
  --
  -- See the header: this column is readable by the application and by the owner, and that is a stated
  -- weakness rather than an oversight.
  totp_secret       text
                      constraint staff_credential_totp_secret_is_base32
                      check (totp_secret is null or totp_secret ~ '^[A-Z2-7]+$'),

  -- The newest TOTP counter this credential has accepted, so a code cannot be used twice inside its own
  -- 30-second window. `verifyTotp` takes it as `lastUsedCounter` and returns `replayed` rather than
  -- `valid` for a counter at or below it. Without this column the second factor stops being a second
  -- factor for thirty seconds after every successful login, which is exactly long enough for somebody
  -- reading the code over a shoulder.
  totp_last_counter bigint
                      constraint staff_credential_totp_counter_needs_a_secret
                      check (totp_last_counter is null or totp_secret is not null),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table staff_credential is
  'What a member of staff signs in with: a scrypt password hash, an optional TOTP seed and the role '
  'every permission is decided from. One row per employee, referencing the employment record rather '
  'than describing a person. NO ROW IS SEEDED in any environment (Y8-staff): a deployment with no row '
  'here refuses every login, and there is deliberately no bootstrap account or development bypass.';

comment on column staff_credential.role is
  'Mirrors ROLES in @berelax/core/access, which is the matrix can(role, permission) reads. The CHECK '
  'is a copy a constraint cannot avoid making; apps/web/src/session.itest.ts asserts it accepts '
  'exactly those eight values and refuses a ninth, so the copy cannot drift unnoticed.';

comment on column staff_credential.totp_secret is
  'Base32 TOTP seed, NULL when not enrolled. NULL is a real state: requiresTotp(role) plus this being '
  'null is totp_enrolment_required, which is what stops enrolment being handled outside the login. '
  'Readable by the application — TOTP is a shared secret and has no one-way form; see the migration '
  'header for why it is not sealed under STAFF_PII_KEK.';

comment on column staff_credential.totp_last_counter is
  'The newest TOTP counter accepted, so a code cannot be replayed inside its own 30-second window. '
  'Passed to verifyTotp as lastUsedCounter, which answers "replayed" rather than "valid".';

create trigger staff_credential_updated_at before update on staff_credential
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- staff_session — the row a cookie names
-- ---------------------------------------------------------------------------------------------
create table staff_session (
  id            uuid        primary key default uuid_generate_v7(),

  -- ON DELETE CASCADE, and the opposite choice from `staff_credential.employee_id` above for a reason
  -- that is not symmetry. Revoking access has to end the sessions it granted; a session outliving its
  -- credential is precisely the state where somebody removed from the admin is still signed in. The
  -- credential row is the access record worth keeping, and a session row is not a record of anything
  -- once it is over — `audit_event` holds what was done.
  credential_id uuid        not null references staff_credential (id) on delete cascade,

  -- SHA-256 of the 32 random bytes the cookie carries. There is no column holding the token. UNIQUE
  -- because it is what a request is resolved by, and the octet length is CHECKed so a caller that
  -- stored a hex digest as text, or a truncated one, is refused here rather than at a login that never
  -- matches.
  token_hash    bytea       not null unique
                  constraint staff_session_token_hash_is_a_digest
                  check (octet_length(token_hash) = 32),

  -- Supplied by the caller from an injected clock rather than defaulted, for the reason 0019 and 0062
  -- both give: every assertion about expiry is made under a frozen clock, and a column that reads the
  -- wall clock cannot be tested without waiting. 30 minutes, matching SESSION_TTL.accessMs.
  expires_at    timestamptz not null,

  -- Set by signing out. A row is kept rather than deleted so that "this session ended because somebody
  -- signed out" is distinguishable from "this token never existed" — the first is a reader who will log
  -- in again, the second is a reader sending a token nobody issued, and only the second is interesting.
  revoked_at    timestamptz,

  created_at    timestamptz not null,

  constraint staff_session_expires_after_it_starts check (expires_at > created_at),
  constraint staff_session_revoked_after_it_starts
    check (revoked_at is null or revoked_at >= created_at)
);

comment on table staff_session is
  'The admin session a cookie names. The cookie carries 32 random bytes and NO payload; this table '
  'holds their SHA-256 and NO role. A request''s role is reached only by joining a live row here to '
  'its staff_credential, which is what makes a tampered cookie unreadable rather than forgeable and '
  'what stops a session''s authority ever disagreeing with its credential''s.';

comment on column staff_session.token_hash is
  'SHA-256 of the cookie token. Not an HMAC under a per-row salt, unlike otp_challenge.code_hash: a '
  '256-bit random token has nothing to guess and the lookup has to be BY hash. Fast on purpose — the '
  'password is the value that needs a work factor, and scrypt gives it one.';

comment on column staff_session.expires_at is
  'When the session stops being trusted, compared on every request. What makes expiry a fact the '
  'SERVER decides rather than a cookie Max-Age the browser is asked to honour.';

-- The read on every admin request is by `token_hash`, which the UNIQUE constraint already indexes.
-- These two are for the reads that are not: ending every session for one credential (offboarding, a
-- password change) and the retention pass over expired rows that docs/04 §8 asks for.
create index staff_session_credential_idx on staff_session (credential_id, created_at desc);
create index staff_session_expires_at_idx on staff_session (expires_at);

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009's `alter default privileges` grants berelax_app select/insert/update/delete AND berelax_readonly
-- select on every table created in public afterwards, so the revokes below are load-bearing rather than
-- decorative — and they are stated explicitly because a managed database restored from a dump does not
-- necessarily carry the same defaults.
--
-- The reporting role has no business in either table. `staff_credential` holds a password hash and a
-- TOTP seed, which is the one pair that turns a reporting credential into an admin one;
-- `staff_session` holds who is signed in right now, which is not a reportable fact and is a list of
-- accounts worth attacking.
--
-- TABLE-level and not column-level, and that distinction is the fact 0050 paid to learn: a column-level
-- REVOKE does not subtract from a TABLE-level grant, so `revoke select (totp_secret) on ...` reads as a
-- protection and is a no-op while `has_column_privilege` still answers true. Revoking the table is what
-- actually removes the privilege. `apps/web/src/session.itest.ts` asserts both with has_table_privilege
-- so the next reader sees the fact rather than a comment claiming a protection that is not there.
revoke select on staff_credential from berelax_readonly;
revoke select on staff_session from berelax_readonly;

-- berelax_clinical is NOT mentioned, and that is correct rather than forgotten: 0009 grants it
-- `select on all tables in schema public` as a one-time grant with no `alter default privileges`
-- alongside it, so a table created by this migration is unreachable to it already. Asserted rather
-- than assumed, in the same suite, exactly as packages/hr/src/employee.itest.ts does for 0050.

commit;
