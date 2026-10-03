# ADR 0119 — the CSP is only real if a BROWSER refuses it, and a second ceiling on one endpoint is the defect

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** H-HARD-01
- **Covers:** docs/01 decisions — none directly; this is the enforcement layer over
  [ADR 0013](0013-server-rendered-not-a-spa.md) (no client JavaScript on an admin screen, which is what
  makes a nonce policy affordable here) and
  [ADR 0004](0004-postgres-driver-and-pooling.md) (one PostgreSQL, pooled, and no cache, which is what
  decides where rate-limit state lives), with
  [ADR 0003](0003-every-gate-needs-a-known-bad-fixture.md)'s rule that a gate fails by a named rule

## Context

H-HARD-01 is five acceptance lines about things that are mostly strings: a header set, a policy, a cookie's
attributes, a ceiling. That is what makes the unit dangerous. Every one of those claims can be asserted
against a string and pass while the thing the claim is about does not happen — a `report-only` header is a
header, a nonce in a directive is a nonce whether or not any document carries it, and a ceiling of twenty
is a ceiling whether it fires at twenty or at nineteen.

So each decision below is written against the version of itself that would have passed.

## Decision 1 — the policy is held against a BROWSER, and the report-only spelling is the control

`cspPermitsInlineScript` is this repository's reading of its own policy, and a reading is not an
enforcement. The difference between `content-security-policy` and `content-security-policy-report-only` is
invisible to every assertion that looks at a header value, and it is the entire question: one refuses the
script, the other runs it and posts a note.

So `apps/web/src/security-headers.itest.ts` serves the real `securityHeaders()` output to a real Chromium
and asks whether the script ran. The document under test carries **two** inline scripts — one nonced, one
not — because a suite asserting only "the bare script did not run" would pass against a page that failed to
load at all. And the report-only spelling is served **beside** it as a case that asserts the bare script
**DOES** run: without that control, the enforced case is consistent with a browser refusing inline scripts
for some other reason entirely.

The suite drives a bare `node:http` server rather than `next start`. The document is four lines of HTML and
the subject is the header above it; a build would add minutes to a claim about one directive and would make
the claim weaker, because the policy would be whatever Next and the proxy agreed on rather than exactly what
`securityHeaders()` returns.

What this gives up: the public documents are not proved in a browser, because they cannot be without a
build. `Y13-public-csp` is why that is not merely a gap — see decision 2.

## Decision 2 — the public group's `script-src` is UNCHANGED, labelled, and not quietly weakened

The admin estate gets `script-src 'nonce-…'`, which is affordable for exactly ADR 0013's reason: every admin
document is rendered by code in this repository, so every inline script in it is one of ours and can carry
the nonce. `inlineScriptTag(nonce, source)` is the one way such a script is emitted, and
`scripts/check-headers.mjs` refuses a bare executable `<script>` anywhere in `app/(admin)`.

The public documents keep `'self' 'unsafe-inline'`. Next's App Router emits an un-nonced inline bootstrap
for the RSC payload into every rendered page, and a nonce makes `'unsafe-inline'` **ignored** — so
tightening the public policy without Next's own nonce integration takes the framework's own script down with
the attacker's. Proving otherwise needs `next build` plus a browser.

The two alternatives were both refused. Shipping the strict policy unverified would have taken the public
site down. Shipping it `report-only` would have produced a header that looks complete, reports violations
nobody reads, and refuses nothing — which is the thing decision 1 exists to refuse, with the extra property
that it would have made the unit look finished.

So the weaker directive is a named constant, `PUBLIC_SCRIPT_SRC`, carrying `Y13-public-csp`; the rest of the
public policy (`default-src 'none'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`) is
enforced; and an integration case asserts the CURRENT state, so the day somebody tightens it the case fails
and the open question's row is where they look.

## Decision 3 — the ceiling's state is a ROW, and the row is also the measurement

An in-process counter fails the acceptance line twice over: it is lost on a restart, and with two workers it
is two counters, each permitting the whole limit. Redis is the usual answer and ADR 0004 and docs/05 contract no cache,
so the state is one row per `(scope, key, window)` in PostgreSQL, and the hot path is **one statement** — an
upsert returning the new count — because a read followed by a write is how two workers both see
`hits = limit - 1` and both allow.

A fixed window rather than a token bucket, and the reason is not simplicity. A bucket's state is a level and
a timestamp, from which nothing about the past can be read. A window's state **is the observation**: `hits`
is the traffic and `refusals` is how often the ceiling fired, and those two together are the only way to tell
a limit that is working from one that is too low. *An unmeasured limit is a guess*, and every figure in
`RATE_LIMIT_POLICIES` is a ceiling somebody chose rather than one anybody observed — recorded as
`Y13-rate-limits`, with each number's reason and the direction it fails in written beside it.

The cost is stated rather than discovered: a caller may take `limit` at the end of one window and `limit`
again at the start of the next, so the worst case over a window's length is twice the limit. An integration
case asserts exactly that, because it is the thing somebody will be surprised by.

`UPDATE` is kept for `berelax_app` — the one place in this estate it is, because the counters are the state —
and `DELETE` is revoked, because a caller who could delete their own window could reset their own ceiling.
**ZY861** holds the row's identity immutable and refuses a counter that decreases, so the only thing an
`UPDATE` can do is count.

A null caller address counts **nothing** and refuses nothing. A placeholder key would put every
unidentifiable caller in one bucket and refuse them as one, so a misconfigured proxy would take every public
endpoint down at once — and that consequence is asserted rather than left as a comment.

The key is an IP address, which is personal data, so the retention is bounded at
`RATE_LIMIT_RETENTION_DAYS` and `deleteRateLimitWindowsBefore` is the sweep. **Nothing schedules it yet**,
and the module says so rather than implying a cron that does not exist.

## Decision 4 — one ceiling per OPERATION, which is why this unit took one out

The acceptance line names four endpoints, and `/api/v1/otp` is the one that is **not** in
`RATE_LIMIT_POLICIES`. A-FIRST-02 already holds both of its ceilings — `OTP_MAX_REQUESTS_PER_PHONE = 3` and
`OTP_MAX_REQUESTS_PER_IP = 10`, counted over `otp_challenge` rows inside `issueOtpChallenge`'s transaction,
with an `otp.rate_limited` audit row and an integration test per ceiling. That state is in PostgreSQL and
survives a restart, which is what the acceptance line asks for.

This unit added a second per-IP counter of **ten per ten minutes** before anybody looked: the same figure,
in a second table, under a second window definition. Two counters that agree today disagree the first time
one is tuned, and the loser is whichever is stricter — after which `OTP_MAX_REQUESTS_PER_IP` would still
have a passing test and would no longer decide anything. It was removed, and the same rule is why
`/api/v1/book` and `/api/v1/bookings` share the `booking` scope: they are one operation under two spellings,
and two ceilings over one operation is two ways to be wrong about it.

The scan classifies that endpoint `own_rate_limit` and **names the constant**, so the exemption is checked
rather than remembered: gate 197g renames it and requires the gate to refuse.

`/api/collect` is the opposite case and is limited here. Its existing limiter is per-VISITOR, in-process,
and 50 requests per second — a burst control whose state does not survive a restart, keyed deliberately on
the visitor cookie rather than an address (A-FIRST-03's PDPL argument). A per-IP window beside it is a
different claim, not a duplicate.

## Decision 5 — the cookie's PROPERTIES are asserted, because the prefix could not be taken

The acceptance line asks for session cookies that are *HttpOnly, Secure, SameSite=Lax and host-prefixed*.
The `__Host-` prefix was applied, driven at a real Chromium, refused, and reverted — and the finding is one
hostname wide.

Chromium stores **neither** a `Secure` cookie nor a `__Host-` one from a `Set-Cookie` at
`http://127.0.0.1`, and stores **both** at `http://localhost`. The exception permitting a `Secure` cookie
over plain HTTP is written against the hostname, not the loopback address — and `startWebServer` hands every
integration suite the address. Twelve admin suites in other worktrees acquire their session at that origin,
so the prefix would have logged all of them out with nothing naming the cause.

This also corrects a sentence written in three files: `adminSessionCookie`, `visitorCookie` and
`analyticsConsentCookie` each set `Secure` unconditionally and justify it by saying browsers treat
`127.0.0.1` as a secure context so the suites need nothing dropped. For cookies in Chromium that is false.
The **decision** survives unchanged and its argument is now the measured one: no suite relies on a browser
storing these cookies from a response — `installAdminCookie` adds a request header, which no cookie rule
governs, and `installAdminBrowserCookie` reaches the jar over CDP, which is not held to the scheme rule.

So the name is unprefixed and the three properties the prefix would have **enforced** are asserted directly,
off the cookie a browser actually stored: `Secure`, `Path=/`, and the absence of `Domain`. The remedy is
measured rather than guessed — one constant in the harness — and an integration case fails the day it
changes.

## Decision 6 — the cookie table is one list, and its exceptions carry arguments

The acceptance line's claim is about a SET: *no cookie in the app escapes those flags*. Five assertions
beside five builders cannot make it, because the sixth cookie — written next month by a unit that never
opens `security/cookies.ts` — is the one the claim is about.

So `COOKIE_DECLARATIONS` is one table of every cookie, its purpose, its builder, the flags it carries and,
for each flag it does not, **why**. Three of the five are missing at least one flag deliberately: the consent
cookie has no `HttpOnly` because the browser writes and reads it; the Google OAuth state cookie has
`Path=/settings/integrations/google`, which is narrower and therefore stronger; and the booking cookie's
`Secure` is a parameter dropped outside production, which this unit reports as a defect rather than editing
another estate's session cookie unverified.

A scan that demanded four flags of all five would be wrong three times, and the way that ends is with the
scan deleted. The reasons are length-checked, because "legacy" is how an exception table becomes a list of
everything; one flag no reason excuses, which is `HttpOnly` on a session cookie. The checks run in **both
directions** — a declared flag the header lacks, and a flag the header carries that the declaration does not
claim — because a cookie that silently GAINED `HttpOnly` would break the consent gate in the browser, and
the only symptom would be a tag that stopped loading.

## Consequences

- **Every admin document's inline script must carry the nonce**, which the proxy mints per response and
  hands to the route on a request header. `adminChromeFor` is the one place that reads it, so no document has
  to remember to; `cspNonce` on `AdminChrome` is optional, with a written reason — a missing nonce fails
  closed and loudly, and making it required meant editing 51 call sites to add a field a scan can enforce.
- **A new unauthenticated endpoint fails a gate** until it is classified, which is a step somebody adding a
  route will hit. The alternative is discovering it from a bill.
- **The public estate is one class unprotected** — injected inline script — and says so in a register row
  rather than in a comment.
- **`rate_limit_window` grows and nothing sweeps it yet.** The mechanism exists and is proved; the schedule
  is `Y13-rate-limits`' second half.
- **The `__Host-` prefix is one harness constant away.** The proof that it would work, and the proof that it
  would break the suites today, are both integration cases.
