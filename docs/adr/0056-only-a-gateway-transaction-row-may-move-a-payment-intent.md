# ADR 0056 — only a gateway transaction row may move a payment intent, and the database is what enforces it

- **Status:** accepted
- **Date:** 2026-09-29
- **Unit:** Y-PAY-02
- **Covers:** docs/01 decisions — none. This is the storage-shaped consequence of
  [ADR 0055](0055-a-payment-adapter-is-what-the-conformance-suite-accepts.md) and of ADR 0008's append-only
  rule; it locks a mechanism, not a new scope decision.

## Decision

**A `payment_intent`'s state and its three fils figures may change only by advancing
`last_transaction_id` to a NEW `payment_intent_transaction` row belonging to that intent. That table holds one
append-only row per gateway EVENT, no row may be updated or deleted, and the intent's figures are recomputed
from the rows at COMMIT. WHICH state an event reaches stays in `packages/core/src/payments/state.ts` and has
exactly one home; WHETHER anything may move at all is the database's answer.**

Migration 0106 raises `ZY162` for the first half and `ZY161`, `ZY163` and `ZY164` for the rest.

The sentence this exists to make structural is the unit's summary: *the gateway, never the client, is the only
thing that can move an intent*. A browser returning from a hosted-fields checkout is the most ordinary
untrusted input in the system, it arrives saying the money was taken, and it is right almost every time — so
the code that believes it looks correct in review and in every manual test.

## The alternative, and the specific way it fails

The alternative is to check the claim in the route handler: read the callback, ask the gateway whether it
really happened, and only then update the intent. That is what the endpoint does anyway — `recordClientCallback`
looks for a stored movement and writes an audit row either way — and as the ONLY guard it fails in three ways,
all of which this repository has already paid for one layer down.

**It is one `if` away from being skipped, and the skip is invisible.** There is no error, no refusal and no
log line: the intent moves, the invoice is marked paid, and the money was never taken. The evidence of the bug
is precisely the record that is missing, which is ADR 0008's argument for append-only tables restated about
state instead of about history. `payment.posting_account_code` is snapshotted rather than joined for the same
class of reason: the check that matters must not be re-derivable by a later reader who may derive it
differently.

**A second writer does not have to know the rule exists.** Y-PAY-04's webhook endpoint, Y-PAY-05's
reconciliation job and Y-PAY-06's refund screen are three more callers of this table, in three units, written
in three worktrees that cannot see each other. A convention that lives in one handler is a convention two of
the four will implement differently, and the one that gets it wrong is discovered on a payment. That is not
hypothetical for this schema: thirteen private SQLSTATEs stood for two rules each because a convention had no
allocator (ADR 0043), and every one of the thirteen was green.

**And the handler's check has nothing to compare against.** "Ask the gateway" is a network call whose answer
must then be stored, so the handler still ends up writing a row — at which point the row is the evidence and
the check is a restatement of it. Making the row the *precondition* rather than a by-product removes the
ordering in which the two can disagree.

A second alternative, rejected: **restate the (state, event) table in plpgsql**, so the database refuses a
transition the lifecycle does not allow. That is a stronger-sounding rule and it is the wrong one. The table
is 36 cells with four that are genuinely surprising, `state.test.ts` asserts it total over the enum product
against an independently written copy, and a second implementation in another language would be a fourth copy
maintained by whoever last edited a migration. ADR 0043's own subject is what happens when one fact has two
homes: they agree until they do not, and the disagreement is found on a payment. So the database answers the
question it can answer without duplicating anything — *is there a movement behind this?* — and core answers
*which state does this movement reach?*

## The consequences somebody has to live with

- **There is one transaction row per gateway EVENT, not one per movement, and three of the six kinds carry
  zero fils.** This is the direct cost of the rule being TOTAL. `action_required` and `authorisation_failed`
  move an intent's state while moving no money, so a movements-only table left those two transitions with no
  row to name — and the exemption that would have fixed it would itself have been a second copy, in plpgsql,
  of which events move money. A reader looking for a ledger of money will find rows that moved none, and the
  `amount_fils` CHECK is three-way rather than positive-only.

- **Neither table can ever be emptied, by anybody, including the owner.** `ZY161` refuses DELETE on a
  transaction row for every role, and the row references its intent, so an intent that has been moved is
  undeletable too. That is the intended reading of P-HR-07's mechanical test — can the child be deleted to
  release the pin? — with the answer "no, and pinning the parent is the point": an intent that touched money
  is evidence, not a draft. Every suite over these tables therefore asserts a DELTA and never a total (brief
  rule 9), nothing is declarable in `packages/db/src/suite-table-declarations.ts`, and a test that wanted a
  clean table needs a clean database instead.

- **The figures are stored twice and reconciled at COMMIT rather than stored once.** `authorised_fils`,
  `captured_fils` and `refunded_fils` on the header are a cache of the rows, which is a second source of truth
  by construction. `ZY163` is the price of keeping it: a deferred constraint trigger recomputes all three on
  every write — MAX over the `authorised` rows, SUM over `captured` and `refunded` — so every movement costs
  an extra aggregate over one intent's rows. The alternative, deriving the figures in every reader, makes the
  payments screen a GROUP BY per row and makes `captured <= authorised` unstatable as a CHECK.

- **ZY163 is hard to reach, and a test for it has to know why.** A figure changed with no new row is already
  refused by `ZY162`, so the only route to a header/rows disagreement is a genuine new row plus a header that
  lies about it — and the refusal then arrives at COMMIT rather than at the UPDATE. This unit's own first
  probe expected ZY163 and got ZY162, which is the system working and the probe being wrong about which rule
  it had broken.

- **`unique (gateway, gateway_intent_id)` was written, applied and removed, and what it protected is now
  partly Y-PAY-05's.** A gateway intent id is unique within a MERCHANT ACCOUNT; `gateway` holds an adapter
  name, and no provider or account has been chosen (OPEN-QUESTIONS `Y7-mcc`), so the column that would qualify
  the uniqueness cannot be added without inventing a merchant account id — which brief rule 15 refuses,
  because a plausible one is indistinguishable from a configured one. The over-claim was visible on day one
  rather than on the day a second account is opened: the H02 fake numbers its intents from 1 per process, so
  the second run of `payment-intent.itest.ts` against one database collided on ids the first run had stored
  and, because nothing here can be deleted, no teardown could free them. Double-counting WITHIN one intent is
  still shut by `unique (payment_intent_id, gateway_event_id)`. Two local intents against one remote intent is
  not detected by the schema and is left to Y-PAY-05, whose acceptance line already quarantines an intent the
  gateway does not recognise.

- **The idempotency key is claimed before the gateway is called, which makes a crash between the two a real
  state.** `gateway_intent_id` is therefore nullable, and an intent whose key was claimed and whose
  authorisation never returned is a row that exists, holds a key nobody can reuse, and names no gateway
  intent. That is the state Y-PAY-05 reconciles, and it is deliberately preferred to the tidier ordering:
  calling the gateway first and deduplicating on its answer would let two concurrent callers both authorise,
  and it would put a suppressed-duplicate movement on the payments screen for every retry — so the acceptance
  line "the adapter records zero additional calls" would be unprovable.
