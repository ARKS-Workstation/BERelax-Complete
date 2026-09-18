# ADR 0009 — the authorisation matrix lives in core; TOTP is unrepresentable to skip

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** F07
- **Covers:** docs/01 decision 5

## The matrix is pure, and lives in `packages/core`

Deciding *"may this role do this?"* needs no database, no session and no request. Putting the matrix in
`packages/core/src/access` means the entire thing is testable as a table of pure assertions, and it is
why the F07 suite can enumerate every role against every permission rather than exercising a few
routes and hoping.

Crypto cannot live there — `node:crypto` is banned by the purity gate — so `packages/auth` holds
password hashing, TOTP and session tokens. The split is along the line that matters: **policy is
pure, secrets are not.**

## Three properties, in order of importance

**1. Deny by default.** An unlisted permission is refused, including an unknown permission *string* —
so a typo grants nothing rather than bypassing a check. `owner` is the only holder of `'all'`, and
that is written out deliberately.

**2. Field level, not route level.** A receptionist legitimately needs the client record to take a
booking and must not see the clinical notes on it. No route-level scheme expresses that, so sensitive
fields are grouped (`clinical.notes`, `employee.salary`, `employee.bank`, `customer.contact`, …) and
granted separately. `redactForRole` strips denied groups at the point a record leaves the data layer,
so a forgotten check cannot leak a salary into a JSON response.

**3. Tested as a matrix, not as examples.** Several tests iterate *all* roles and assert a global
property rather than a specific grant:

- Every role that can read salary or bank details, or post to the ledger, or run payroll, **requires
  TOTP**.
- `settings:write_compliance` is held by exactly one role.
- The `auditor` holds no permission ending in `:write`, `:send`, `:publish` or `:run`.
- No role grants a permission outside the declared catalogue.

These catch the realistic mistake — adding a permission to a role without thinking about what else
that role can now reach — which a per-case test never would.

## Deliberate grants worth recording

- **The marketer cannot read an individual customer.** Segments and counts only. This is the
  insider-export path from [docs/06 §D4](../06-blind-spots-and-risks.md) closed at the matrix rather
  than by policy.
- **The therapist reads clinical notes; the receptionist reads only the flags.** The therapist is
  treating the person in front of them and the note is their own record of treatment. The receptionist
  needs to know a contraindication *exists* in order to route a booking, and nothing more.
- **The accountant sees every financial record and no clinical data at all**, including no
  contraindication flags.
- **Floor roles do not require TOTP**, because they log in on shared front-desk hardware many times a
  day and a second factor there produces shared secrets, which is worse. Any floor member who *has*
  enrolled must still complete it.

## Login incompleteness is a type, not a flag

`resolveLoginStage` returns `password_required | totp_required | totp_enrolment_required |
authenticated`. `password_verified` is deliberately **not** an authenticated state for a role that
requires a second factor, and `assertAuthenticated` throws on anything but `authenticated`.

Modelling the stages makes "logged in without TOTP" *unrepresentable* rather than merely discouraged —
there is no boolean anybody can set. A privileged user without an enrolled authenticator is pushed to
enrolment rather than let through.

## TOTP details that matter

- **Replay is rejected.** `verifyTotp` returns the matched counter so the caller can persist it;
  a code already used within its 30-second window is refused with `reason: 'replayed'`. Accepting the
  same code twice defeats much of the point of a second factor, and is the part most implementations
  omit.
- **One window of drift each way**, no more, because phone clocks drift but a wider window is a
  weaker factor.
- **Constant-time comparison** and a malformed-code short-circuit before any HMAC work.
- Implemented directly rather than taken from a dependency: sixty lines of well-specified arithmetic
  against a supply chain on an auth primitive is a poor trade.

## Passwords

scrypt from the standard library, not argon2id — an auth primitive needing a native build step is a
deployment failure waiting to happen on App Platform. `N=2^16`, and the cost parameters are stored in
the hash string so they can be raised later without invalidating existing rows. `verifyPassword`
returns `false` for a malformed stored hash rather than throwing, so a corrupt row is
indistinguishable from a wrong password by either timing or error message.

## Two lint-rule conflicts resolved rather than suppressed case by case

- **Biome `useLiteralKeys` vs TypeScript `noPropertyAccessFromIndexSignature`.** They demand opposite
  things for `process.env.X`. Biome's rule is now off: the TypeScript one is more valuable because it
  forces an explicit acknowledgement that environment variables are untyped.
- **Biome `noNonNullAssertion` vs `noUncheckedIndexedAccess`.** Indexing a `Buffer` under strict
  settings yields `number | undefined`, which invites `!`. Resolved with a `byteAt` helper that throws
  on a short digest — both rules satisfied, and a corrupt buffer becomes a real error instead of a
  silent zero.

`exactOptionalPropertyTypes` also earned its place here, rejecting an explicit `undefined` for
`lastUsedCounter` — where conflating "no counter recorded" with "counter 0" would have quietly
disabled replay protection for the first window.
