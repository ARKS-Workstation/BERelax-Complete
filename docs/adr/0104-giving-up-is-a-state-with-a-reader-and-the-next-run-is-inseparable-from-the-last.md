# ADR 0104 — giving up is a state with a named reader, and the next run is inseparable from the last

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** A-MEAS-06
- **Covers:** docs/01 decisions — none. This is a mechanism under docs/10 §6 (a pg-boss job failure is not
  evidence anybody has seen), beside ADR 0091 (the dispatch consumer decides only whether the transport
  worked), ADR 0092 (a corrected conversion value is a new statement), ADR 0093 (an unreconciled day has
  no revenue figure), ADR 0016 (two TDRA sender identities, separately registered), ADR 0043 (a SQLSTATE
  is an identity) and ADR 0002 (a pass over nothing must not answer "all sent").

## Context

0021 inverted the contract for scheduled work: an agent declares how often it expects to succeed, and a
watchdog alerts when it has not — *"the absence of a success is the signal, not the presence of an
error."* It gave `agent_heartbeat` six columns and the watchdog an alert ledger, and G-AGT-01 built the
pass.

Three things were still invisible, and each of them is a failure that looks exactly like health.

## Decision

### `next_run_at` is the fourth field, and the CHECK is what makes "on every run" true

"Last run two minutes ago" says nothing without "next run in three". So `next_run_at` is added, and it is
paired to `last_run_at` by a CHECK **in both directions**.

That pairing is the decision rather than tidiness. The acceptance line — *both analytics agents write all
four fields on every run, on the success and the failure path* — is a claim about a WRITER, and a claim
about a writer is a thing somebody forgets. With `(last_run_at is null) = (next_run_at is null)` a writer
that recorded an attempt without saying when the next one is due is REFUSED, so the claim holds for the
two analytics agents, for the other eleven, and for a psql session.

The value is `last_run_at` plus the agent's own `expected_interval_seconds` — the same figure the watchdog
doubles. A cron expression is deliberately not consulted: `pnpm jobs` already holds the registry's
expression and that interval equal, and a third derivation would be a third answer to when the next run is
due. The one a console shows would then differ from the one the watchdog alerts on.

The cost is real and is paid by fixtures: two integration suites set a heartbeat directly to control what
the watchdog sees, and both now have to write the field the schema requires. ADR 0066 records the same
cost for a session fixture that has to be calendar-consistent, for the same reason.

### Giving up is a STATE, not an attempt count a reader has to decode

0137 gave the consumer a retry ladder, and the way a dispatch gave up was that its attempt counter passed
the end of it: `dueAnalyticsDispatches` then never selected it again. 0137's own comment calls that *"a
state somebody can see"*, and it is not one — the row still says `failed`, exactly like a row due for
retry in four minutes, and the only way to tell them apart is to compare `attempts` against a ladder that
lives in `@berelax/analytics`. A console cannot do that. A `where` clause cannot do that. An operator
reading the table certainly cannot.

So `dead_letter` is a state. Terminal in the same sense `sent` is — the consumer will not pick it up — with
the reason and the last thing the provider said on the row beside it.

**It is reached by exhausting the BUDGET and not by the kind of refusal**, and those are different
questions. A malformed payload is refused identically next time and is *non-retryable by kind*, but it is
still inside its budget, so the row stays `failed` and a later pass tries again — which is 0137's
behaviour and is left alone. Only the last attempt the budget allows produces a dead letter, because that
is the one condition under which nothing will ever pick the row up again.

**A dead letter can still be re-queued, and that is deliberate.** The ZY312 consent gate fires on the
UPDATE back to `queued` (ADR 0091), so an operator who fixes a destination and re-opens one is re-judged
against the visitor's consent as it stands THEN. A terminal state that could not be re-opened would make
the only remedy a second row, and the unique `(event_id, destination)` index refuses that — so the
conversion would be unsendable for ever by a rule nobody chose.

### ZY711: the row may not be deleted, and that is a schema rule rather than a test

The acceptance line asks that *"a test asserts the row is never deleted"*. A trigger is the same claim in
the form a test cannot go stale against, and it holds for the owner and for a psql session as well as for
the application role.

The reason is A-MEAS-07. It reconciles internal truth against what was PUSHED, so a deleted dead letter
makes a conversion the platform never heard about indistinguishable from one nobody enqueued — and the day
then reconciles while the money is short. The rule is scoped to the STATE and not to the table: a `failed`
row is still deletable, which is what makes ZY711 a claim about a permanent failure rather than about
`analytics_dispatch`.

### A dead-letter queue nothing reads is the same defect one level down

So the readers are named in the migration itself, and both exist:
`apps/web/app/(admin)/agents/queries.ts` lists the rows with the provider's own last words on each, and the
watchdog puts the COUNT on every alert it raises — so somebody woken about a silent dispatcher is told in
the same breath how many conversions have given up. The count is taken once per pass rather than once per
agent: it is a property of the queue, not of an agent, and a per-agent read would be a dozen identical
queries whose answers could differ while the pass was running.

### The alert's class is declared, and the `AD-` sender is unreachable for it by construction

An agent alert is operational traffic about a system fault. `AGENT_ALERT_MESSAGE_CLASS` is the one
statement that it is `transactional`, and `agentAlertSenderIdentity` reads it from that constant — there is
no parameter for a class, so a call site cannot name one. `SENDER_IDENTITY_ROUTES` is then what makes the
promotional sender unreachable: the promotional identity is registered with the `AD-` prefix, and
`assertSenderIdRegistry` refuses a registry whose transactional slot carries one
(`transactional_carries_ad_prefix`). `resolveSenderIdentity` does not fall back to the other slot either,
which is the outcome `sender-identity.ts` exists to prevent.

Nothing in this build SENDS an agent alert to a person: there is no on-call contact on file
(`Y13-oncall`), and an alert is an `agent_alert` row plus an outbox event. The class is declared anyway,
because a decision taken at the point a send exists is a decision taken under pressure and this one has an
answer now.

### The offline upload gets its own agent

A-MEAS-05 recorded the handover and the reason: it shared `analytics_dispatch`' agent, the two passes are
one pipeline, *but* the consumer writes a heartbeat every five minutes — so the shared row was never more
than five minutes old however long the daily upload had been broken, and the half that was working reported
health for the half that was not. That is 0033's argument, restated by 0110 and by the two analytics
partition jobs. `offline_conversions` declares 86400 seconds, which is its own cron held equal to it by
`pnpm jobs`, and the watchdog's 2× window is now measured against its real cadence.

## Consequences

**A monotonicity trigger on `last_success_at` was written, applied to a database and REMOVED, and the
removal is part of the decision.** ZY712 would have refused a heartbeat whose last success moved
BACKWARDS, by exactly ZY452's argument about the attempt counter: the watchdog measures silence from
`greatest(last_success_at, enabled_since)`, so a backwards move manufactures a silence that did not happen.
Sixteen cases of the existing watchdog suite failed the moment it applied, because every one of them
simulates silence by moving that column back.

That is not a test problem, and rewriting the fixtures would have been the wrong repair. `agent_heartbeat`
is not a ledger: it is the CURRENT state of an agent, and the only direction an earlier instant moves the
answer is towards OVERDUE — the safe direction, and the one that makes somebody look. The rule would have
protected a column whose single consumer already treats "earlier" as "more alarming", at the cost of the
suite that proves the watchdog works at all. ZY712 through ZY720 are released unused.

**The three frozen-clock claims were already proved and are not restated.** The 2× boundary, the disabled
agent and the agent that has never succeeded are each proved against the real table by G-AGT-01's suite,
and against `nightly_rollups` — one of the two agents this unit's acceptance line names. What this unit
added beside them is the half that was genuinely new: that BOTH analytics agents are in the set the
watchdog evaluates, and that all four fields are written on the success path and the failure path for each,
through `withAgentRun` rather than through `recordHeartbeat`, because the acceptance is about a RUN and a
test that called the writer directly would prove nothing about the wrapper meant to call it either way.

**The console is a query module and not a route.** `apps/web/src/routes/registry.ts` is in exact bijection
with the filesystem and requires every document in both locales, and there is no agent console document
yet — so these are the functions the screen that arrives will call, which is A-MEAS-07's recorded
precedent for `revenue-by-source.ts`. Its own suite lives on the web side, because `apps/worker` does not
import from `apps/web`.

**Every dead-letter fixture has to be rolled back.** ZY711 means a row that reached the state on a shared
database could never be removed, so each case opens a transaction and throws. That is the rule working
rather than a difficulty, and it is what lets both suites run twice in a row.
