---
id: messaging-outage
title: SMS or email provider outage
unit: H-HARD-06
trigger_kind: alert
trigger: Messages are not reaching recipients: the send backlog alert has fired, or the provider is returning rate limits, rejections or 5xx responses for every attempt.
first_action_heading: 1-do-not-retry-by-hand
first_action: Do not retry sends by hand, because every message goes through one choke point that is idempotent per outbox event and a hand-made send is the one that is not.
owner: owner
escalation: There is no provider support contact on file and no on-call rota (Y13-oncall), so escalation is the provider's own status page and dashboard; nothing in this build can tell you whether the outage is yours or theirs.
alerts: send_backlog
env: SMS_PROVIDER, EMAIL_PROVIDER, OUTBOUND_ALLOWLIST
---

# Runbook — SMS or email provider outage

## What is true before you start

- **Nothing is lost.** Every outbound message is an `outbox_event` row with an `idempotency_key`, and a
  send that failed is a row that is still there. The queue is durable; the provider is not.
- **Every send goes through one function.** `pnpm send-chokepoint` is the gate that keeps it that way,
  and it is why there is no second path to go looking for. A message that was not sent was not sent by
  that one path.
- **The failure classes are known and are not invented.** `packages/providers/src/failure.ts` lists
  them against their real counterparts: `rate_limited` is SMSala throttling or Resend's per-second cap,
  `rejected` is an invalid recipient or a suspended sender id, `timeout` is the request that neither
  succeeds nor fails, `server_error` is the provider's own 5xx. Which one you are in decides what to do.

## 1. Do not retry by hand

A hand-made send is outside the choke point, so it is not deduplicated against the outbox event it is
standing in for, it is not recorded as a delivery, and it does not re-evaluate consent. The consequence
is the one that matters: a customer who withdrew consent, or who is on the suppression list, is messaged
anyway — and `pnpm send-chokepoint` exists precisely because that path must not be reachable.

If a message has to go out tonight and the provider is down, it goes out by a person picking up a phone,
and it is **not** recorded as a delivery in this system.

## 2. Tell the three failures apart

```
psql "$DATABASE_URL" -c "select published_at is not null as published, count(*), max(attempts) from outbox_event group by 1"
psql "$DATABASE_URL" -c "select handler, count(*), max(attempts), max(last_error) from outbox_delivery group by 1"
```

| Pattern | What it is | What to do |
|---|---|---|
| `last_error` climbing, every one a rate limit | The provider is throttling. | Nothing. The retry ladder is the answer; see section 3. |
| `last_error` a 5xx or a timeout, attempts climbing | The provider is down. | Section 3, and check their status page. |
| One recipient, a rejection, not retried | A bad address or a suppressed sender. | Section 4. This is not an outage. |
| Nothing moving at all, `attempts` not climbing | Not the provider. The worker is not draining. | [The job backlog runbook](job-backlog.md). |

The last row is the one that gets misdiagnosed: a stopped worker and a dead provider look identical from
the recipient's side and are opposite from here.

## 3. While the provider is down

- **Leave the ladder alone.** `outbox_event.attempts` and `outbox_delivery.attempts` are the ladder, and
  a budget that is exhausted ends in a state with a READER rather than a silent drop —
  `apps/worker/src/jobs/agent-watchdog.ts` is what reads it, and a given-up row can be re-queued, at
  which point consent is judged again.
- **Do not widen `OUTBOUND_ALLOWLIST`** to route around the outage. It is the guard that stops a
  non-production deployment sending to real people, and an outage is the worst moment to be editing it.
- **Do not switch the provider mode to `fake`.** `SMS_PROVIDER=fake` does not queue anything for later:
  it makes the send succeed against a fake, which marks the outbox event delivered. The message is then
  gone, recorded as sent, and nobody will ever know.

That last point is the one trap in this runbook that looks like a workaround and is a data loss.

## 4. A single rejection is not an outage

`rejected` is final and is not retried, because retrying a hard bounce is how a sender reputation is
lost. The row to look at is the recipient's: a number that has been reformatted, a landline where a
mobile is needed, or an address on the suppression list. The suppression list is checked before the
provider is reached, so a suppressed recipient never produces a provider rejection at all — it produces
a refusal inside the choke point, which is the system working.

## 5. After the provider recovers

1. Confirm the worker is draining: attempt counts move and `outbox_event` leaves its pending state.
2. Re-queue anything in `dead_letter` that is still worth sending. Consent and suppression are
   re-evaluated on the way back through, so a row that should no longer go out will refuse again.
3. Check `message_delivery_receipt`: a provider that accepted a message is not a provider that delivered
   it, and `apps/worker/src/jobs/reconcile-dlr.ts` is what reconciles the two.

## What this build cannot tell you

**Whether the outage is theirs.** There is no synthetic probe, no status-page poll and no provider
health check: `pnpm processors` holds the register of which providers are wired up, and every live
provider in this build is a fake (`SMS_PROVIDER` and `EMAIL_PROVIDER` default to `fake`). Until a real
account exists, every failure mode in this runbook is reachable only through the armed fakes in
`packages/providers/src/failure.ts` — which is deliberate, and is also the reason none of the figures
here is a latency.
