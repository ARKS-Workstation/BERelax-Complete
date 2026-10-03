# ADR 0125 — A findings register is a REVIEWED FILE, an empty one is not a clean one, and the vulnerable fixture route may not be in the application

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** H-HARD-10
- **Covers:** docs/01 decisions — none; this is ADR 0002 applied to a security review, ADR 0003 applied
  to a scanner, and `go-live-payments.mjs`'s precedent for a gate that is deliberately outside
  `pnpm verify`

## Context

No penetration test has been booked (`Y13-pentest`). The unit's own provisional note says the register
ships live and empty rather than absent, and an automated baseline scan stands in.

Both halves of that are traps. A register that ships empty makes a go-live check green on the day it is
written, and "no findings" is indistinguishable from "nobody looked". A scan that stands in for an
engagement is worth nothing unless it is known to find something, and a scanner reporting zero findings
is indistinguishable from a scanner that does not work.

## Decision 1 — the register is a file in the repository, not a table

The declared file for this unit was a migration. `artifacts/security/findings.json` is the register
instead, for three reasons, of which the first is decisive:

1. **A release gate that reads database state cannot be re-run from the commit.** "Was this build clear
   to ship on the 3rd?" has to be answerable by `git show`, not by whatever rows the database holds
   today — and a findings table is mutable by exactly the person the gate is about.
2. **Closing a finding is a repository fact.** The evidence is a commit, a test reference or a written
   acceptance, so the finding and its remediation belong where a reviewer sees both in one diff.
3. **The gate needs no database**, which matters because it is run before a release, on a machine that
   may have nothing deployed.

There is deliberately **no digest** over this file, which is the opposite of the restore drill's
artefact (ADR 0123). The difference is what the artefact is: a drill report is a measurement, so a hand
edit to it is always a falsification; this is a working document somebody edits on purpose. Its control
is the closing rule plus the review of the diff.

## Decision 2 — an empty register is a NO-GO, so the go-live check is not in `pnpm verify`

`goNoGoVerdict` refuses while `engagement.booked` is false, whatever the findings say. So
`pnpm go-live:security` exits non-zero today, and that is the honest answer rather than a build failure:
it stays out of `pnpm verify` for `go-live-payments.mjs`'s stated reason — a check that fails on a
business fact nobody can fix in code is a check people delete.

What IS in `pnpm verify` is `pnpm findings`, the register's **integrity**: the closed sets and the
closing rule. A malformed register is a defect in the repository whatever the security position is.

## Decision 3 — severity and status are closed, and the four closing statuses need four different evidences

Five severities and seven statuses, with no default anywhere: an import carrying `Critical`, `P1` or
`sev-1` FAILS. Closed because the gate turns on the value, and the default nobody would notice is the
one that lets a critical finding through as a medium.

The four statuses that close a finding each need their own evidence, and collapsing them would make the
register unable to answer the only question an auditor asks about a closed critical finding:

| status | evidence required |
|---|---|
| `fixed` | a commit **or** a test reference — the latter is better evidence, for ADR 0003's reason: a test fails if it comes back |
| `accepted_with_rationale` | a rationale **and** the F07 role that accepted it (a role, never a person — brief rule 10) |
| `false_positive` | a rationale, or it is the finding that comes back next quarter and is dismissed again |
| `duplicate` | the original, or nothing tracks the real finding |

And the direction the acceptance line implies rather than states: remediation on a finding that is still
`open` is also refused. A row carrying a commit and reading `open` is a row somebody fixed and did not
close, which is safe only until the next reader assumes the status is stale.

## Decision 4 — the intentionally vulnerable fixture route is a FIXTURE ORIGIN, not a route in `apps/web`

The acceptance line asks for an intentionally vulnerable fixture route proving the scan examines
something. A route inside `apps/web` would have to bypass `guardAdminRoute` — refused by this
repository's own admin-guard scan — and would be a real hole the first time an environment check went
the wrong way. So the suite starts a plain `node:http` origin serving the same SHAPES: a 200 on an admin
path with no cookie, a readable `/.env`, a published source map, a document with no security headers, a
versioned `Server` header. It proves the same thing about the scanner and cannot ship.
`apps/web/src/checkout.itest.ts` already does this for the gateway's card-entry origin, on a
kernel-assigned port for brief rule 18's reason — so no port band was needed and the one allocated to
this unit is released.

The fixture's first version answered 200 to **every** path, which made every admin route in the registry
leak and both source-map paths publish. A fixture broken nineteen ways proves only that the scanner
reports something; it now leaks exactly one of each, so the suite's assertion is an equality.

## Decision 5 — the admin probe is about the STATUS, and the target list is derived from the registry

An unauthenticated request to an admin path must answer a redirect to the sign-in route, or 401, 403 or
404. A 200 is a finding **whatever the body says**, because `200` with `text/html`, `noindex` and
`no-store` is exactly what the sign-in page answers — a check asserting those passed for weeks in this
repository against a document with nothing to do with its subject.

The paths come from `ROUTES` through `requiresAdminSession`, never from a list in the scanner. A
hand-written list is right the day it is written and then misses the route added next week, which is the
only route worth finding because it is the one nobody has looked at. A gate case proves the derivation
is load-bearing: with `requiresAdminSession` answering false, the scan refuses rather than reporting
that no admin route is reachable.

Dynamic segments are skipped. `[mediaId]` is not a URL and substituting a value would be inventing one.

## The consequence somebody will have to live with

**`pnpm go-live:security` will keep saying no until somebody books an engagement**, and no amount of
remediation will change that, because the thing it is refusing is the absence of a review rather than the
presence of a finding. That is the intended shape and it is uncomfortable on purpose: the alternative is
a green security gate over a system nobody has attacked.

**And the scan is a floor, not a review.** Five probe kinds over the declared routes catch the
deployment mistakes that are cheap to make and cheap to find. They do not look for a logic flaw, an
authorisation bypass between two roles, or anything requiring a session — the scan is unauthenticated by
design, because an authenticated scan needs a credential this repository must not hold. Every finding it
raises enters the register as `open` and as `automated_baseline`, so no reader can mistake it for
something a person found.
