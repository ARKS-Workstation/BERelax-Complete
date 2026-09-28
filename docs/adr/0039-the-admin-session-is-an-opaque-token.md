# ADR 0039 — the admin session is an opaque token, and the role is never in the cookie

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** W-SYS-11
- **Covers:** docs/01 decisions — none; this is the mechanism behind ADR 0009's mandatory second factor
  and F07's authorisation matrix, and it is the session half of what 56 manifest references had deferred
  to W-SYS-01

## Decision

**The admin session cookie carries 32 random bytes and nothing else. The reader's role is reached on every
request by joining a live `staff_session` row to its `staff_credential`. No claim, no signature and no
expiry lives in the cookie.**

Migration 0090 is the storage: `staff_credential` holds a scrypt password hash, an optional base32 TOTP
seed and the role; `staff_session` holds the SHA-256 of the token and an `expires_at`, and has **no role
column**. `apps/web/src/session.ts` resolves one to the other and narrows the role to `Role` at the
boundary where `@berelax/core`'s matrix is in scope.

## Why not a signed cookie carrying the role

A signed cookie — a JWT or an HMAC over `{employeeId, role, exp}` — needs neither table and is the
default answer. It was rejected for three reasons, and the third is the one that decided it.

**A tampered cookie is refused for a different reason.** With an opaque token, an edited cookie hashes to a
value no row has, so it names nothing: the refusal is structural. With a signed cookie the refusal holds
exactly as long as the signature check is correct and present on every path that reads it, and "every path"
grows. There is nothing in an opaque token for an attacker to aim at, because there is no field in it.

**Expiry is decided by the server.** A cookie's `Max-Age` is a request to the browser and an `exp` claim is
checked by whatever remembers to check it. `expires_at` is compared on every resolution by one function,
against an instant the caller passes — which is also what makes expiry assertable in a test with a frozen
clock instead of by waiting thirty minutes. `booking_session` (0062) made the same argument for the public
flow and it is the same argument here.

**A demotion must take effect.** A JWT's claims are a copy of the row taken at login. Changing somebody's
role, or revoking their access entirely, does not reach the copies — so the remedy is a revocation list,
which is a session table with extra steps and a second source of truth for who is signed in. With the role
reached by join there is no copy: the next request sees the new role, and `delete from staff_credential`
ends every session it granted through the CASCADE.

The cost is one indexed read per admin request. That is the right price for a back-office estate used by a
handful of staff, and it is why the token hash is a bare SHA-256 rather than something with a work factor:
no work factor helps a 256-bit random value nobody can guess, and 100 ms per request would be 100 ms on
every admin page. The password is the value that needs a work factor and scrypt at N = 2^16 gives it one.

## Why the reader is `staff_reference` and not an email address

`employee` has no email column, and the handover has supplied no staff contact details (`Y8-staff`).
Inventing an address to sign in with would be inventing exactly the kind of value brief rule 15 forbids —
plausible and indistinguishable from configured. `staff_reference` already exists, is UNIQUE, is what the
rota and the scheduler call somebody, and is deliberately never a person's name: 0030 refuses a display
name on that column and ADR 0020 says why.

## Why no account is seeded, in any environment

**A deployment with no `staff_credential` row refuses every login.** There is no bootstrap account, no
`APP_ENV` branch, no environment variable standing in for a row, and no "first login creates an owner".

This is the consequence that matters most and it is deliberate. A seeded admin account would be an invented
person with an invented password, and it would be the account nobody rotates because nobody knows it
exists. A development bypass is worse: it is added for a demo and found in production two years later, and
it puts a way past authentication into the one part of the system whose whole job is to have none.

The way in is an operator inserting the first credential — deployment work with a procedure
(`docs/runbooks/admin-access.md`) and a record of who did it. The integration suite creates its own
principals and removes them (`packages/fixtures/src/admin-principal.ts`), which is what lets the login path
be proven against a real row while no fixture account exists in any deployment.

## Two layers, and neither is the other's backup

`apps/web/proxy.ts` refuses an admin path carrying no session cookie, before any route runs. That is what
makes a route added later refused **by default** rather than refused once somebody remembers a guard.

It is **not** the authentication. The proxy cannot reach the database — it is Next middleware, and
`src/session-cookie.ts` exists precisely so that the cookie parse can be imported there without pulling a
database driver into that bundle — so all it can see is whether a cookie is present. A syntactically valid
cookie naming no row passes it, and is refused by `requireAdminPrincipal` inside the handler.

Relying on middleware for authorisation is how CVE-2025-29927 worked. The reason a bypass of this edge is
uninteresting is that the edge was never the thing deciding.

## What this does not decide

**The TOTP seed is in a readable column.** TOTP is a shared secret and has no one-way form, so the choice
was a readable column or sealing it under `STAFF_PII_KEK` (0050). 0050's own header states that
`scripts/rotate-kek.mjs` cannot rotate the staff estate, so sealing an authentication secret there would
trade a readable column for an unrotatable one — and would make that key a hard dependency of logging in at
all, so an absent key would lock everybody out of the admin. `berelax_readonly` is revoked from both tables
at table level (a column-level revoke does not subtract from a table-level grant — 0050 paid to learn that),
and a dump holding a scrypt hash and a seed still needs scrypt broken before the seed is worth anything.
Sealing it remains a real improvement and is recorded as a limitation of W-SYS-11 rather than parked against
a unit that would never pick it up.

**Field-level authorisation at the edge is barely exercised**, because no admin screen performs a
role-based field check: all 25 were built with no session to check against, and nothing under `(admin)`
references `canReadFieldGroup`, `payroll:read` or `employee.salary`. The matrix decides correctly and is
tested in `@berelax/core`; what is measured at the edge today is the clinical crossing, where a marketer is
refused by name and a receptionist is served. R-REP-08 is the first unit that has to filter fields by role.

**P-HR-14's therapist portal needs a staff session too**, and should read it through `readStaffSession`
rather than build a second one. A second session is a second answer to who is signed in.
