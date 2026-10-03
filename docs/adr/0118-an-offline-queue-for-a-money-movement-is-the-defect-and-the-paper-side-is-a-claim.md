# ADR 0118 — an offline queue for a money movement is the DEFECT, and the paper side is a claim somebody makes later

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** H-HARD-08
- **Covers:** docs/01 decisions — none; this is the failure-shaped consequence of
  [ADR 0005](0005-non-production-cannot-use-real-providers.md) (a provider refuses rather than degrading)
  and [ADR 0013](0013-server-rendered-not-a-spa.md) (no client JavaScript on an admin screen), with
  [ADR 0107](0107-the-paper-side-is-a-named-persons-claim-and-the-cutover-decision-is-not-a-function-of-it.md)'s
  rule that the paper side is a NAMED PERSON'S CLAIM

## Context

H-HARD-08's premise is a fact rather than a hypothesis: the salon's wifi will drop mid-checkout. The
unit's title is *offline tolerance, honest failure and the paper fallback*, and the first of those three
turned out to be the one that had to be refused rather than built.

The thing that makes this hard is that **the dangerous failure is not the one where nothing happens.** A
submission that cannot reach the server is benign — no row anywhere, and the operator may simply try
again. The one that matters is the submission that arrived and whose answer did not come back: the money
may have moved, and the terminal cannot tell.

## Decision 1 — there is no offline queue, and a scan is what keeps there being none

The obvious design is offline tolerance: hold the payment in the browser, send it when the connection
returns, show the operator a tick. It is refused, and not because of a preference about resilience.

A queued money movement is **a promise this system cannot keep.** The browser holding it can be closed,
the device swapped, the till cashed up and the day closed; when the queue finally drains it authorises a
card for a customer who left two hours ago, against an invoice somebody has since voided, into an
accounting period that may be locked (M-VAT-06). And the tick the operator saw was a claim the terminal
made on behalf of a gateway it never reached — *"paid"* being the one word a till must not say on its own
authority.

"Nobody will build that" is not a check. The diff that introduces it looks like resilience work and
arrives with a changelog entry about the wifi. `tsc` cannot see it, because the DOM lib declares
`localStorage`; dependency-cruiser cannot, because a browser global is not a module; a review cannot,
because it reads as an improvement. So `scripts/check-offline-money.mjs` is the check, with four rules —
a browser store, an offline API, a deferred gateway call, and a failure sentence that promises — scoped to
a declared money path and each with a known-bad fixture in gate block 196.

The path list is scoped rather than repository-wide, and the vacuity guard is the part that matters:
the list is asserted to EXIST on disk, because a tidied list that names nothing passes for ever while the
invoice writer sits somewhere else. Gate 196d is that mutation.

## Decision 2 — there are THREE failure states, and the middle one is why

`TILL_FAILURE_STATES` is `did_not_leave_this_terminal`, `unknown_whether_it_completed` and
`refused_before_the_money_moved`. A design with two — it worked, it did not — collapses the second into
the third, and that collapse is the lie that double-charges: an operator told "it did not work" takes
payment again.

So the sentences are data, in `packages/core/src/checkout/honest-failure.ts`, and
`tillFailureSentenceProblems` runs over the SHIPPED table rather than over a fixture. The forbidden
vocabulary is about claims and not tone: `queue`, `will be sent`, `will retry`, `saved offline`,
`payment succeeded`. Each tells an operator something is in hand when the one thing the module exists to
say is that it is not.

One consequence of writing the list down: two overlapping entries make one offending sentence produce two
reports, so `queued` was removed in favour of `queue`. A list whose entries overlap is a list whose count
means nothing, and the test that asserts each phrase is reported exactly once is what found it.

## Decision 3 — the panel is on the page BEFORE the failure, because afterwards there is no page

This is the constraint that decided the shape of the whole unit, and it follows from ADR 0013.

The checkout is one server-rendered `<form method="post">` and
`checkoutContentSecurityPolicy` emits `script-src 'none'` for the merchant document. There is no code in
that browser. A submission that cannot reach the server therefore ends on the **browser's own error
page** — which this system does not write and cannot change — and a submission whose answer is lost ends
nowhere at all.

So nothing can detect the loss and render a message. The only moment this application is certain to have
the operator's attention is before the submission, and that is when the attempt's reference, the two
sentences the server can never deliver and the paper steps go on the screen. The panel is not a warning
that appears on failure; it is what the operator reads off the screen while the network is already gone.

It carries no control of any kind, which is the Google re-auth banner's argument in a second subject and
sharper here: a control could not work, because no script runs.

## Decision 4 — the reference is DERIVED from the idempotency key, and is the whole offline story

`tillAttemptReference` groups twelve characters of the attempt's existing idempotency key into fours. One
value, not two: the thing written on paper and the thing that makes a repeat safe are the same, so there
is no second identifier to read out wrongly.

That key is what replaces the queue. The operator writes it down, takes payment the way the salon took
payment before this system existed, and — when the connection is back — looks it up BEFORE taking payment
again. A repeat of the same attempt replays rather than charging twice, which
`apps/web/src/offline-checkout.itest.ts` drives directly.

The last paper step is the one a queue design does not have: somebody RECORDS, later, what actually
happened, as a claim with their name on it. ADR 0107 already models that — `parallel_run_paper_count`
(0153) with ZY742 demanding an audit row whose actor is `staff` in the same transaction — so this unit
adds no table. The paper side is a named person's claim and nothing here fabricates one.

## Decision 5 — a lost connection PROPAGATES; it is not reported as a refusal

`authoriseCheckout` already says why in a comment and this unit is what holds it open: reporting every
error as `write_refused` would turn a lost connection into *"the ledger refused the write"*, which sends
somebody to look at the wrong thing — and puts a refusal on the screen for a payment that may have been
taken. The route answers **503 and plain text**, which says the check could not be made rather than that
the payment was declined. Gate 196g plants the swallow.

The rows are the other half, and they are asserted as a delta around the call: zero payment intents, zero
invoices, zero journal entries. The probe is a gateway whose `authorise` throws the way a closing socket
throws, which is a stronger test than a browser going offline — a browser that cannot reach the server
proves nothing about the server, because the request never arrives.

## Decision 6 — the day sheet holds no instant, and that is the only screen in this build that does not

The acceptance line is *byte-identical across two runs*, and a "printed at" line makes that impossible.
Every other admin screen prints the instant it was read at, deliberately, because a figure with no reading
time is a figure somebody quotes next week. This document is the exception for ADR 0105's reason: the run
instant lives OUTSIDE the compared content, so two copies of a sheet can be compared with each other.
Whoever prints it writes the time on, which is what a person does with paper.

It reads `readCalendarDay` and adds no reader. That query already joins on `appointment.trading_date` —
the STORED column that resolves the 01:30 case — so an after-midnight treatment is on the sheet, and it
already orders by `(starts_at, id)` for exactly this reason. A second reader would have re-derived where a
trading day ends, and a fallback showing a different set from the screen it replaces is worse than no
fallback. Gate 196f keys the marker on a constant and the suite's one-of-two assertion catches it.

**It names no customer.** A list of who is coming, when, for what treatment is the most sensitive artefact
this business could leave face-up, and the sheet is printed precisely so it is lying around. The columns
are the time, the room, the therapist's handle (ADR 0020), the treatment and an eight-character
appointment reference a till entry is reconciled against. The "paid" column is deliberately blank: a
figure this system filled in would be a claim it cannot make while the network is down.

## Decision 7 — an adapter answers a typed failure or a diverted result, never a bare success

ADR 0005 is about not reaching a real provider by accident. This extends it to the other direction: not
REPORTING that you did. `packages/fixtures/src/adapter-honesty.test.ts` reads the three adapter
directories off the filesystem and fails when a module is not probed, which is what makes the claim about
all of them rather than about the five somebody recalled.

Two findings from writing it are worth recording, because both read as defects and are not. The manual
till's `eventsSince` answers an EMPTY LIST rather than throwing, and that is right: `emitsEvents` is false
for cash, the behaviour matches the declared capability, and a thrown refusal would make a reconciliation
pass over every gateway fail on the one with nothing to reconcile. And the SMS fake's undeliverable
recipient makes the DELIVERY RECEIPT fail rather than the send, which is also right — an absent subscriber
is discovered by the network and not by the API — so the probe for a typed transport failure is a
promotional body from the transactional identity, which the provider's own sender-ID rule throws on.

The file imports no provider, because `messaging-providers-only-inside-a-transport` refuses it and that
rule is the hard half of the send choke point. Widening it so a test could enumerate failure modes would
have traded the guard for a second enumeration.
