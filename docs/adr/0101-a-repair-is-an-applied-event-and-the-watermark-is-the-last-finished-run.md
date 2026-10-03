# ADR 0101 — a repair is an APPLIED EVENT, and the watermark is the last FINISHED run

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** Y-PAY-05
- **Covers:** docs/01 decisions — none. It stands on ADR 0007 (integer fils), ADR 0008 (append-only
  tables), ADR 0017 (the journal has no edit), ADR 0043 (a refusal is identified by all five characters
  of its SQLSTATE), ADR 0056 (only a gateway transaction may move a payment intent, and the lifecycle
  table decides which state an event reaches), ADR 0057 (a live figure is a derivation over rows nobody
  has edited), ADR 0070 (an unattributable figure is a refusal, never a zero) and ADR 0100 (a delivered
  webhook lands exactly once).

## Decision

**The diff needs BOTH sides on file, each with its own instant.** `gateway_state_observation` holds what
the gateway said and the instant we asked at. A job reading only `payment_intent` would be comparing our
records with our records, and the one thing it could never find is the event that never arrived.

**A repair is an APPLIED EVENT and never an overwrite.** `payment_intent`'s figures are a projection of
append-only transaction rows held equal to them at commit (`ZY163`), so there is no UPDATE that could
write them without fabricating a gateway event. `ZY682` makes a recorded repair name the events that
justified it.

**A divergence nothing explains is QUARANTINED and alerted, never corrected** (`ZY683`), and never
deleted.

**The watermark is the cursor of the last FINISHED run** (`ZY684`), which is what makes an interrupted
pass re-read its own window instead of skipping it.

Migration 0148 raises `ZY681`–`ZY684` and brings the `payment_reconciliation` agent with its heartbeat row.

## Why this unit exists at all

ADR 0100 makes a delivered event land exactly once. It can do nothing about an event that was never
delivered: a gateway outage, a deploy window, a 500 the endpoint answered for an unrelated reason, a
retry budget that ran out. From inside the system those are indistinguishable from an event that never
happened, and the symptom is the quietest failure in the whole payments estate — **a capture nobody
recorded.** The money is at the acquirer, the invoice reads unpaid, the customer is chased for it, and
nothing anywhere is wrong.

So the pass reads the gateway's own event stream from a durable watermark, and the gateway's own answer
for each intent. The acceptance line's fuzz run drops 30% of the **deliveries** rather than 30% of the
fake's stream, and that is the shape of the thing: a lost webhook is an event the gateway SENT and
nothing received, so the gateway still has it — which is the only reason anything can be repaired.

## Why a repair cannot be an overwrite

"The gateway is the authority, so write its figures over ours" is one UPDATE and it is impossible.
`authorised_fils`, `captured_fils` and `refunded_fils` are a cache of the `payment_intent_transaction`
rows, and `ZY163` recomputes all three at commit — so the UPDATE would have to fabricate a transaction
row to go with it, which is a lie about what a third party did, in the one table a dispute is answered
from.

What a repair IS, therefore, is applying the events we are missing, through the same `applyGatewayEvents`
the webhook uses and the same `reduceIntent` fold. That makes it **reproducible from the stored rows years
later**: the same events, in the gateway's own instant order, reaching the same state. `planReconciliation`
computes the after-state by FOLDING rather than by trusting the gateway's `state` field, which is ADR
0056's division — the gateway says what happened and the table says which state that reaches, and a plan
that believed the snapshot would silently accept an un-capture from a gateway that disagreed with us.

**A divergence the stream does not explain is quarantined.** ADR 0070's rule in a third subject: the
difference exists either way, and only one of the two spellings of it can be investigated afterwards. A
few fils between a gateway's ledger and ours is either a missed event or money that went somewhere, and
those are the same number.

## Why the watermark is a row per run

The obvious implementation is one row with a cursor somebody UPDATEs, and it fails in exactly the case
the acceptance line is about. The cursor advances, the process dies before the repairs commit, and the
events between the old cursor and the new one are **never read again.** They are lost for good and
nothing says so.

So each pass is an append-only row, `payment_reconciliation_watermark` reads only runs with a
`finished_at`, and a pass that died leaves its row open with its cursor excluded. The next pass re-reads
the same window; the repairs already made are no-ops, because the events are keyed on
`unique (payment_intent_id, gateway_event_id)`; and the second pass therefore records no exception for
them, which is the idempotence acceptance line.

`ZY684` then refuses a finished run closing behind the watermark. Not because of double-counting — the
unique constraint makes that harmless — but because the watermark would stop saying what has been read,
which is the one thing it is for.

**One transaction per intent**, and the grain is deliberate. Per pass, an interruption rolls back every
repair already made, so the kill-mid-run acceptance line would be satisfied by a pass that did nothing —
which proves nothing. Per statement, an intent could commit its observation and die before its exception,
leaving a repaired figure with nothing explaining it. Per intent is the grain at which the work is
actually idempotent.

## What this costs

- **An intent in step is NOT recorded.** A row per intent examined would make `reconciliation_exception` a
  log of runs rather than a register of divergences, and "a second consecutive run produces zero repairs"
  would be unassertable. The run row carries the counts.
- **An unrecognised intent gets an observation with nought figures and `recognised` false.** A row rather
  than an absence, because "we asked and it said no" and "we never asked" are different facts and only
  the first justifies a quarantine; and the noughts are a MEASURED nothing rather than a stand-in, which
  is what `gateway_state_observation_unrecognised_holds_nothing` says.
- **A network failure is re-thrown, not treated as "unrecognised".** A network error is not a statement
  about an intent, and treating one as an answer would quarantine the whole population during an outage.
  Only a genuine not-found becomes `null`.
- **`payment_reconciliation_run` is the one table in the family with a legal UPDATE**, and it is narrow:
  the close, written once while `finished_at` was null. Everything else raises `ZY681`, so a run cannot be
  re-attributed to another gateway or re-dated.
- **A finished run over an EMPTY window has no cursor**, and the constraint says so. The first version
  required a finished run to carry one and refused exactly that run — which would have forced the pass to
  invent a bookmark the gateway never issued. The constraint that replaced it makes the real claim: a
  finished run never reports a cursor behind where it resumed from.
- **The pass posts no journal entry.** It moves an intent's rows; the document side — marking an invoice
  paid — is ADR 0100's `invoice-settlement` handler, and a reconciliation that also tendered would be a
  second path to the same posting. That is why the idempotence acceptance line can assert zero journal
  entries at all.
- **`@berelax/worker` now depends on `@berelax/payments`.** The pass needs `applyGatewayEvents` and the
  diff, and both live there; `pnpm deps` and `pnpm boundaries` were run for that reason and are clean.
