---
id: payment-gateway-outage
title: Payment gateway outage
unit: H-HARD-06
trigger_kind: external
trigger: The payment gateway is refusing requests, timing out, or has stopped delivering webhooks, so a customer's card cannot be charged or a charge's outcome is unknown.
first_action_heading: 1-the-unknown-charge-is-the-emergency-not-the-refused-one
first_action: Separate the refused charges from the charges whose outcome is unknown, because a refusal is safe and an unknown outcome is money that may already have moved.
owner: owner
escalation: No acquirer is contracted and no gateway is configured in this build, so there is no support path to escalate to; what escalation means here is refusing to guess an outcome and quarantining the divergence instead.
alerts: (none)
env: PAYMENT_PROVIDER, PAYMENT_WEBHOOK_SIGNING_SECRET
---

# Runbook — payment gateway outage

## What is true before you start

- **No acquirer is contracted and no gateway is live.** `PAYMENT_PROVIDER` defaults to `fake` and
  `pnpm go-live:payments` is the check that says what is still missing. So this runbook describes the
  procedure for a gateway that is wired up, and today every path in it is reachable only through the
  armed fake in `packages/providers/src/failure.ts`.
- **No card number can reach this build.** `pnpm saq-a` is the scan that keeps it that way. Nothing in
  this runbook involves re-entering card details, because there are none here to re-enter.
- **Our records and the gateway's are reconciled, not merged.** `payment_intent` holds our view,
  `gateway_state_observation` holds what the gateway said and the instant we asked, and
  `apps/worker/src/jobs/payment-reconciliation.ts` compares them. A repair is an applied event and
  never an overwrite (ADR 0101).

## 1. The unknown charge is the emergency, not the refused one

```
psql "$DATABASE_URL" -c "select state, count(*) from payment_intent group by 1 order by 2 desc"
```

- **Refused, declined, or never attempted.** Nothing moved. The customer was not charged and the invoice
  is unpaid, which is a true statement of the world. No action beyond telling the customer.
- **Authorised or captured with no webhook.** The money may have moved and this system does not know.
  This is the case the whole payments estate is built around, because from inside the system a lost
  webhook is **indistinguishable from an event that never happened**.

Everything below is about the second case.

## 2. Do not re-charge, and do not mark anything paid

Both are one statement and both are unrecoverable:

- **Re-charging** a customer whose first charge actually succeeded takes the money twice, and the refund
  is a second transaction with its own fees and its own dispute window.
- **Marking an invoice paid** by hand is impossible on purpose, and it is worth knowing why rather than
  discovering it: the settlement figures are recomputed from append-only transaction rows at commit, so
  an `UPDATE` would have to fabricate a transaction row — a lie about a third party in the one table a
  dispute is answered from. `pnpm no-invoice-mutation` refuses it in the repository and a trigger
  refuses it in the database.

## 3. Let the reconciliation find out

`apps/worker/src/jobs/payment-reconciliation.ts` asks the gateway about each intent, records the answer
with the instant it was given, and applies any events it had not seen through the same code path the
webhook uses. Two consequences worth knowing while you are waiting:

- **It is idempotent.** The repairs are keyed on `(payment_intent_id, gateway_event_id)`, so running it
  again produces no second repair.
- **A pass that died does not skip its window.** The watermark is the cursor of the last *finished* run
  (`payment_reconciliation_watermark`), so an interrupted pass leaves its row open and the next one
  re-reads the window.

If the gateway is still down, the reconciliation cannot ask and will not guess. It records the
observation it could not make rather than an outcome it invented.

## 4. A divergence that the event stream does not explain is QUARANTINED

Not corrected. A few fils between two ledgers is either a missed event or money that went somewhere, and
those are the same number — so the row is quarantined with the divergence named, and it waits for a
person. That is ADR 0070's rule in the payments subject, and it is the reason this runbook has no step
that makes the figures agree.

## 5. Webhooks that arrive late

A webhook is an unauthenticated request until its signature verifies
(`PAYMENT_WEBHOOK_SIGNING_SECRET`, ADR 0100's subject). A backlog of webhooks delivered after the outage
is normal and is handled: `payment_webhook_event` is keyed so a replayed delivery lands once, and
`payment_webhook_handler_run` records each handler's attempt. There is nothing to do but let them arrive.

What needs checking afterwards is the reverse: a webhook the gateway says it sent and this system has no
row for. That is the lost-webhook case, and section 3 is how it is found.

## 6. After it recovers

1. Run the reconciliation and read its report rather than its exit status: a clean run and a run that
   could not reach the gateway are different answers.
2. Check `payment_reconciliation_run` for quarantined rows and resolve each by hand, with the
   gateway's own record as the evidence.
3. `pnpm money-invariants` over the whole estate. It re-adds every money identity over every row the
   database holds rather than over one fixture, which is the question an outage raises.

## What this build cannot tell you

**Whether the gateway is down.** There is no status probe and no health check, and there is no acquirer
to have one for (`Y7-mcc`, `Y13-pentest` for the security review that precedes going live). The first
signal of a payment outage in this build is a customer saying their card did not work.
