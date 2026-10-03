# ADR 0100 — a webhook is an UNAUTHENTICATED REQUEST until it verifies, and replay protection is not idempotency

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** Y-PAY-04
- **Covers:** docs/01 decisions — none. It stands on ADR 0005 (a real provider outside production is
  refused), ADR 0007 (integer fils), ADR 0008 (append-only tables, and exactly-once per handler), ADR
  0043 (a refusal is identified by all five characters of its SQLSTATE), ADR 0055/0056 (`payment_intent`'s
  lifecycle, and only a gateway transaction may move it), ADR 0067 (SAQ-A: no card data, defended by a
  scan that fails rather than an assertion that passes) and ADR 0070 (an unattributable figure is a
  refusal, never a zero).

## Decision

**Verification comes before parsing, before any write, before any database connection, and before any log
line, audit payload or error message that could echo the body. A refused delivery returns no part of the
body at all — the refused branch of the verification union does not carry it.**

**The signing secret is absent by default in every environment, and its absence REFUSES with 503. There
is no fall-back to trusting the body.**

**Replay protection and idempotency are two different claims and both live in the database.** The same
event delivered twice lands once (`unique (gateway, event_id)`) and is answered **200**. A different event
under a reused id is **refused** (`ZY672`), audited, and never applied.

Migration 0147 raises `ZY671`–`ZY674`.

## Why the order is the whole design

The body of an unverified delivery is attacker-controlled text that arrives looking exactly like a
payment. Three things go wrong if anything touches it first:

- **Parsing first** makes the parser the attack surface, and a parse error becomes a 500 whose stack trace
  quotes the body.
- **Logging first** copies an unverified payload into a log aggregator read by more people than the
  database is — and under SAQ-A that body is the one place a misconfigured gateway could put a primary
  account number (ADR 0067).
- **Writing first**, even a "received" row, makes an unauthenticated request able to fill a table.

So `verifyWebhookSignature` takes the raw text and a `Headers` bag and returns a discriminated union. The
caller cannot reach the body through the refused branch, and
`packages/payments/src/webhook/verify.test.ts` asserts that by serialising every refusal whole and
looking for a marker — with the control that the verified branch does carry it, so the assertion is about
the refusals rather than about a marker that never arrived.

**The route reads `request.text()` and never `request.json()`.** Re-serialising a parsed object changes
the bytes and breaks every signature; `apps/web/src/payments-webhook.itest.ts` POSTs a body with its keys
in another order and extra whitespace, which only verifies if the raw bytes were signed and checked.

## Why an absent secret is 503 and not 401

`PAYMENT_WEBHOOK_SIGNING_SECRET` is `optional()` and unset everywhere, because no gateway has been chosen
(OPEN-QUESTIONS `Y7-gateway`). The tempting shape is "verify when a secret is configured", which is a
webhook endpoint that trusts every body on the machine where somebody forgot the variable — and that
machine is production, on the day it is rotated.

So the absence is its own refusal. **503, not 401**, and the distinction is not pedantry: 401 says *your
signature is wrong* and the truth is *we cannot check it*. A gateway retries a 503 and gives up on a 401,
so a 401 here would discard events that were perfectly valid while the endpoint looked healthy.

A blank or whitespace-only value is `not_configured` too. An empty string is a perfectly valid HMAC key
and would verify a signature anybody could compute, and `FOO=` is exactly what a misconfigured deployment
looks like.

## Why the timestamp is inside the signature, and why a stale delivery is a REPLAY

The signed payload is `timestamp + '.' + body`, so the timestamp cannot be edited without breaking the
MAC. And **the tolerance is checked AFTER the MAC**, which is what makes the two refusals mean anything:
checked first, a forged old body with a fresh timestamp would get the same answer as the gateway's own
retry and the log could not tell them apart. Checked second,
`timestamp_outside_tolerance` means *this was genuinely ours, and it is old*.

`WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` is **this build's own policy and not a figure from any vendor's
documentation** — there is no vendor. Five minutes, stated once, with its reason: wider than a gateway's
retry jitter and two hosts' clock skew, narrower than the window in which replaying a captured delivery
is worth anything. A caller may narrow it and nothing derives it from anything.

The window makes a replay *expensive*; it does not make one *impossible*. That is the database's claim.

## The two claims the unique constraint cannot both make

A `Set` of seen event ids works in a test, in review, and until the next deploy — at which point it is
empty and the gateway is still retrying everything it has not had a 200 for. The web process restarts on
every release and the worker on every crash, so both claims are rows:

- **Replay protection.** `unique (gateway, event_id)`. The second delivery is answered **200**: a gateway
  that gets a 4xx for a redelivery escalates an incident about an event it processed correctly.
- **Idempotency.** `payload_sha256` plus `ZY672`. The constraint cannot tell a redelivery from a forgery —
  both are a second row with one id — and treating both as a redelivery accepts a forged payload silently
  and then ignores it silently. So the trigger compares the digest and **deliberately does not raise for a
  matching one**: that case falls through to the unique violation the caller answers 200 to.

The digest is of the **bytes**, computed before the body was parsed, for `settlement_batch.content_sha256`'s
reason one unit along: two bodies that parse the same in a different key order are the same event.

## Exactly-once per HANDLER, and why a boolean would not do

One delivery legitimately has more than one handler: a capture moves the intent **and** settles the
document it paid for, and those can fail independently. A `handled` boolean would mean "something was
done", which is not a claim anybody can retry against. So `payment_webhook_handler_run` carries one row
per (event, handler) and `unique (webhook_event_id, handler)` is ADR 0008's rule as a constraint. A
handler added later re-processes the events it has no row for without re-running the ones it does.

`ZY674` holds the handler name to `payment_webhook_handlers()`, because **a typo is a NEW slot in that
constraint rather than an error** — the event would be processed twice while the constraint reported
success. The set is stated twice, in SQL and as `WEBHOOK_HANDLERS`, with the pairing check in the same
commit.

`ZY673` is what makes `applied` mean something: an `applied` run of the `intent` handler must have its
`payment_intent_transaction` row at COMMIT. Without it the row says the event was applied and nothing
moved — and because the run row exists, no retry will ever look at that event again. **That is a lost
money movement the system believes it has processed**, which is the worst failure available here, and it
is the other half of ADR 0056.

## A capture that arrives before its authorisation is HELD, not refused

ADR 0056's table is strict: a capture on an unauthorised intent is a real defect and `reduceIntent`
throws. But a signed delivery is genuine, and the gateway will not send it again once it has a 200 — so
refusing it loses a money movement.

So the event is stored and the `intent` handler records **no run**, which is precisely "a retry comes back
to this". The delivery that brings the predecessor folds **every event on file for that intent**, sorted
by the gateway's own instant, and applies whatever the stored history is missing. ADR 0056's table stays
strict and the waiting happens in the ingest, which is the only arrangement in which both are true. The
endpoint answers **200** for a held delivery, because it is accepted: stored, deduplicated and on file.

That is why `payment_webhook_event.amount_fils` is a column. Re-folding needs the instant and the amount,
and the body is deliberately **not** kept — under SAQ-A it is the one place a misconfigured gateway could
put card data. The three-way CHECK is `INTENT_EVENT_CARRIES_AMOUNT`, and both directions are refusals.

## An invoice is marked paid only by a webhook-confirmed capture

`recordClientCallback` contains no UPDATE and never reaches `tenderWebhookCapture`. The only path that
writes a `card_online` `payment` row for a gateway capture is the `invoice-settlement` handler, running
from a verified, deduplicated delivery — and it posts the entry too, `Dr` the intent's clearing account
and `Cr 1050 Trade receivables`. **Not revenue**: the supply was recognised when the invoice was raised,
at its own tax point, and crediting revenue here would recognise it twice and move part of it into
whatever month the gateway happened to confirm.

The entry's id is derived from the event id, so ten concurrent deliveries of one event all build the same
entry and nine lose on `journal_entry_pkey` even if they got past the event row's own constraint. That is
the acceptance line "exactly one state transition and exactly one journal entry, asserted by row counts"
made structural rather than asserted.

## What this costs

- **An intent the gateway knows and this build does not is answered 202 and NOT stored.** A row in
  `payment_webhook_event` is evidence a signature verified, and one with no possible handler run would
  read as processed. 202 and not 404, because a 404 tells a gateway to stop retrying a delivery
  reconciliation will need — which is Y-PAY-05's subject, and 0106 already says so.
- **There is no GET and no verification-challenge handler.** Every gateway wants a different one, none has
  been chosen, and a GET that echoed a query parameter back is the shape of an open redirect. An
  unexported method answers 405 from Next's own router.
- **The delivery shape is not an exhaustive model of anybody's format.** The four fields this build needs
  are required and an unknown key is accepted and ignored: a refusal on an unknown field would make every
  one of the vendor's future additions an outage.
- **A verified body this build cannot read is 422, not 401.** It came from the holder of the signing
  secret, so it is a format disagreement rather than an untrusted request — and a 401 would send whoever
  is debugging it to look at the secret.
- **Two servers in the integration suite, from one port band.** `secret_not_configured` is not a request
  anybody can send; it is a deployment somebody forgot to configure, so it needs a second `next start`
  with the variable absent.
