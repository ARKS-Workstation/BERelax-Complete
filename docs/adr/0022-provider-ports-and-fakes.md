# ADR 0022 — every external service behind a port, with a fake that fails on demand

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** H02
- **Covers:** docs/01 decision 32

## What this is for

The owner's instruction was *for the things you can't do now, keep the scope of it and continue*.
"Keep the scope" is not "leave a TODO". docs/12 §1 spells out what it means; this is the
implementation, and the three rules below are asserted for every provider at once by
`packages/providers/src/conformance.test.ts` — which walks the registry, so a provider added in a
later unit is held to them without anyone remembering.

## Rule 1 — no fake returns success without writing to a visible call log

A stub that returns `{ ok: true }` is worse than no stub. It makes a broken system demo perfectly,
and the day it is swapped for the real thing is the day every error path is met for the first time,
in production.

So every fake records what it *would* have done in a shared call log before returning. That log is
the admin Messages inbox, the review autoresponder's draft queue and the payment reconciliation
screen. A screenshot of this system working is a screenshot of what it would have sent — which is a
different and more honest artifact than a screenshot of a green tick.

The conformance test asserts it per provider, including that the human-readable summary is not empty:
a blank row on an inbox is the same lie in a different font.

## Rule 2 — every declared failure can be armed

*A fake that only ever succeeds hides every error path, and the error paths are most of the work.*

Seven modes, none invented: `rate_limited`, `rejected`, `invalid_grant`, `quota_exhausted`,
`access_not_granted`, `timeout`, `server_error`. Each is a documented failure of the service it
stands in for, each carries its retryability in the error's details so a retry policy can branch on
it without parsing prose, and each is asserted for every provider.

Failures are **scripted, not random**. `failNext(mode, 2)` arms two calls so a retry path can be
tested; `failAlways` arms a dead end. A fake that failed 5% of the time would make the suite flaky,
which trains everyone to re-run it — the opposite of what an error path is for.

## Rule 3 — selection is configuration, and `real` refuses rather than degrading

`SMS_PROVIDER`, `EMAIL_PROVIDER`, `GOOGLE_PROVIDER`, `PAYMENT_PROVIDER` and `LLM_PROVIDER` decide
what the registry builds. Nothing else in the codebase constructs a provider.

Two things hold by construction. `parseConfig` refuses `real` outside production
([ADR 0005](0005-non-production-cannot-use-real-providers.md)), so no staging run can reach a real
customer however it is configured. And `real` **today resolves to a named adapter that throws**,
naming the unit that will build it and the prerequisite it waits on.

That last part is the one worth arguing. A registry that quietly fell back to the fake would produce
a production deploy that looks connected and sends nothing — a failure that surfaces as customers not
receiving confirmations, days later, with no error anywhere. The adapter throws at construction
rather than at first use, so the failure lands at boot where a deploy fails and someone is watching,
not at 22:00 on the one code path that needed it.

## What each fake gets right, and why that one thing

A fake that satisfies the three rules and behaves nothing like its counterpart is an expensive way of
returning success. Each models the specific behaviour that changes the code around it:

- **SMSala** — sender-ID class enforcement, because promotional content from the transactional
  identity risks the suspension that stops every booking confirmation (ADR 0016); and real segment
  counting, because **Arabic is 70 characters per segment against English's 160**, so the same
  campaign costs over twice as much in Arabic. That number belongs in the budget screen, not in
  somebody's estimate.
- **Resend** — suppression is the provider's and it is terminal. A hard bounce or a complaint means
  the address is refused regardless of what our own consent record says.
- **Google OAuth** — `invalid_grant`, including the seven-day refresh-token death that applies to
  every connection while the consent screen is in Testing status. The re-auth banner is built against
  it rather than against a hypothetical.
- **Business Profile** — reviews at every star rating **including star-only with no text**, which is
  the majority case and the one an autoresponder handles worst; plus `access_not_granted`, because
  access is granted by application review and the wait is weeks.
- **Search Console** — the rare-query gap. Summed rows deliberately total less than the site total,
  so a report that reconciles the two finds the discrepancy here rather than in a meeting.
- **Card gateway** — 3DS as a round trip the customer can abandon, partial refunds that accumulate,
  webhook replay, and a dispute arriving against an intent nobody is watching.
- **LLM** — deterministic by prompt hash, so the screenshot harness does not diff on every run; and
  it **refuses** a review alleging a double charge. Not because a model would write something
  offensive, but because a public reply to an allegation about money is a legal statement and belongs
  in front of a person.

## The one adapter that is not a fake

**Cash and card-terminal payments.** The customer pays at the desk and the system records it; there
is no external service, so there is nothing to stub. It is real in every environment, because a fake
till would make the ledger fictional. It still writes to the call log, because a cash payment nobody
can tie to a ledger entry is a reconciliation problem.

## Consequences

- The system is buildable, testable and demoable with **zero external credentials**.
- No non-production environment can physically reach a real customer, because no real transport is
  wired to reach one.
- Three new provisional values are recorded in `docs/OPEN-QUESTIONS.md` rather than guessed silently:
  the SMSala per-segment rate, the card gateway and its MCC, and the monthly LLM token budget.
