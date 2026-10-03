# ADR 0097 — the alert registry is what the alerting path READS, an SLO carries no invented target, and what is not defended is written down

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** H-HARD-05
- **Covers:** docs/01 decisions — none; this is the mechanism one floor above ADR 0031's heartbeat
  contract (G-AGT-01), and it is the alerting half of the argument `scripts/check-job-registry.mjs`
  makes for crons.
- **Revisit when:** there is a measured baseline (`Y13-alert-slos`), a second principal to route an
  alert to (`Y13-oncall`), or a settlement batch to reconcile (Y-PAY-05).

## Decision

Three things, and the third is the one that is usually left implied.

1. **`ALERT_REGISTRY` in `packages/shared/src/alerts/registry.ts` is the table the alerting path reads,
   not a document beside it.** `ALERT_OBSERVERS` in `packages/db/src/alerts.ts` is a
   `Record<AlertId, AlertObserver>`, so an alert with no reader does not compile and a reader with no
   alert does not either; the worker's pass enumerates the table rather than a list of its own; the
   staff-facing banner evaluates its entry through the same `evaluateAlert` the pass uses. `pnpm alerts`
   proves everything the type cannot: the severity, the surface, the audience roles, the runbook heading,
   the structural threshold's stated authority, the setting threshold's F09 declaration, its provisional
   flag and its upper bound.

2. **`AlertSlo.target` is typed `null`, not `number | null`.** The shape of every objective is recorded —
   what is measured, the `table.column` inputs it is computed from, the window — and no figure is. The
   figure is `Y13-alert-slos` in `docs/OPEN-QUESTIONS.md`, and widening the type is a deliberate edit in
   the commit that answers it.

3. **`UNDEFENDED_BY_DESIGN` records what this build does NOT defend against, and every entry is attached
   to the alert a reader would otherwise believe covers it.** `doesNotCover` is a required field, and the
   two sets are held equal in both directions by the module's own load-time assertion and again by the
   gate.

## Why the registry has to be the thing that is read, and not a list of what is watched

Because the failure this unit exists to remove has already been removed once, one floor down, and the
argument transfers exactly. `check-job-registry.mjs` refuses a cron that names no `agent_definition` and
an agent with no `agent_heartbeat` row, and its own header says why: *a cron nobody watches is the failure
G-AGT-01 exists to remove*. The reason that works is that the watching is STRUCTURAL — not a list of jobs
somebody maintains, but a field the declaration cannot omit and a row a migration has to bring.

An alert registry that is a list nothing reads reproduces the defect one level up, and it does so
invisibly. The list is right the day it is written. The eleventh condition is added to the evaluator and
not to the list; or to the list and not to the evaluator; and nothing fails either way. The first thing
anybody does with a list that has been wrong once is stop trusting it, and an untrusted alert list is
worse than none because it still looks like coverage.

The obvious alternative was a registry plus a test asserting the two sets are equal. That is the shape
ADR 0062 rejected for the crawler lists and ADR 0043 rejected for SQLSTATE classes, and it fails the same
way here: a set-equality test between two hand-written lists passes on the day it is written, is the first
thing deleted when somebody adds a condition in a hurry, and says nothing at all about a THIRD copy. So
the equality is structural — the observer map is keyed by the registry's own id union, and the banner and
the pass both go through `evaluateAlert` — and the gate's job is the claims that reach outside the file.

## Why an SLO here has no number, and why that is the stronger record

An SLO is a number somebody committed to. This build has no production traffic, no observed drain
latency, no observed queue depth and no observed sign-in behaviour, so a target in this repository would
be a figure nobody has agreed to, presented in the place a figure somebody agreed to would appear.

The failure mode is specific and it is worse than an absence. A dashboard that is green against an
invented target answers *are we inside the objective* with a number that was made up, and the answer is
indistinguishable from a real one — which is brief rule 15's argument about a plausible TRN, applied to a
service level. Nobody audits a green panel.

Typing the field `null` rather than leaving it optional is what makes this a decision instead of a
convention. An optional `target?: number` is a field somebody fills in; `target: null` does not accept a
number at all, so the first person who wants one has to edit this type, and that edit is the record of who
committed to what. The gate's `alert-slo-has-a-target` is the backstop for a tree where the type was
widened, which is not a hypothetical: `pnpm boundaries` once reported success over zero modules because
the thing enforcing a rule had quietly stopped applying (ADR 0002).

What IS recorded is everything needed to compute the figure later: `measure` in one sentence,
`measuredFrom` as `table.column` pairs so two people recompute the same number, and `windowDays` so the
measure is not an all-time average. Answering `Y13-alert-slos` is then filling in one field per entry
rather than designing a measurement.

## Why four thresholds are settings, two are not, and one may never be

A threshold is a different thing from an SLO: *when is this abnormal enough to look at*, rather than *what
did we promise*. Two of the six are STRUCTURAL — they point at a figure a migration already owns, and the
gate reads that file and fails when the figure is not in it. One more data subject than the request covers
is a bulk read whatever anybody's opinion is (`rights_export.alerted` is tied to `subject_count` by a
CHECK in 0085), and an obligation one day past its due date is overdue on the trading date the calendar
screen itself uses (0052). Pointing at the authority rather than repeating the number is what stops the
registry becoming a second statement of a fact.

The other four are genuinely judgements with no measured basis, so they are F09 settings flagged
`provisional` against `Y13-alert-thresholds` — which puts each on the Unconfirmed Assumptions panel rather
than letting it read as a figure somebody looked up, and makes the correction one audited settings change
instead of a release. A judgement written as a constant would be a figure nobody can see and nobody can
fix.

Every one of the four is BOUNDED in its schema, and that is the load-bearing part rather than tidiness: an
alert whose threshold can be set to a million is an alert that can be turned off from a settings screen
with nothing recording that anything was turned off. The gate proves the bound by asking the schema to
parse `Number.MAX_SAFE_INTEGER` rather than by looking for `.max(` in the source — the text scan was
written first, could not find the definitions because the registry imports its keys as constants, and
passed for every key including an unbounded one.

**And the client-list export has no setting at all.** The acceptance line asks that neither its audit
write nor its alert can be disabled by a setting, and a figure on the Unconfirmed Assumptions panel can be
set to a million. So its threshold is the CHECK in 0085, and the integration suite asserts the absence of
a governing setting rather than trusting it.

## Why the pass runs inside the watchdog's job rather than on a cron of its own

Because a cron of its own would be a cron nobody watches. A scheduled job must name an
`agent_definition`, and a new agent must bring its own `agent_heartbeat` row in a migration — 0031 says
so in as many words, and `pnpm jobs` refuses both omissions. This unit holds no migration number, so the
honest choice was between an agent row nobody allocated and running inside a pass that is already watched.
`agent.watchdog` is that pass: every fifteen minutes, with a declared interval, a budget and a heartbeat
row, and its whole subject is finding the things nothing else is looking at.

What that buys is that the alerting path inherits the heartbeat contract: if the pass stops, the
watchdog's `last_success_at` goes stale and the evidence is a row rather than an absence. What it does not
buy is an alert about its own absence, and that is `the-pass-cannot-report-its-own-absence` in
`UNDEFENDED_BY_DESIGN` rather than a comment nobody reads.

## Why there is no alert table

`agent_alert` (0021) stores a row per unbroken silence because the thing it watches is an ABSENCE — there
is no row saying "no run happened", so the alert has to be the evidence. Every alert here is the opposite:
each is a measurement over rows that already exist, so the firing state is DERIVED and clears itself. A
table holding *is this alert on* would be a second statement of a fact with the drifting copy on the row
an operator reads, and clearing it would need a writer nobody would remember to call.

What needs deduplicating is the NOTIFICATION, and `outbox_event.idempotency_key` already does that. The
incident key is derived from the observation and never from the clock, which is the whole trick: every
pass inside one incident computes the same key and the second insert does nothing. `agent_alert`'s comment
says it from the other side — a fifteen-minute pass would otherwise raise ninety-six notifications for one
broken agent, and the ninety-sixth is the one nobody reads.

That makes every `order by … limit 1` in the observers a TOTAL order, with `id` last. A tie leaves the row
PostgreSQL returns undefined, and the row IS the incident key, so a tie is a key that flaps between passes
and raises a second notification for one situation. This was found by running the suite twice rather than
by reading the queries.

## The insider-threat exception, and why recording it beats implying coverage

docs/06 §D4 is explicit that the realistic breach for this business is somebody inside it reading or
exporting the client list, and the audit trail is the control: reads are recorded and not only writes, and
an export is indexed separately so an unusually large one is cheap to find.

The part usually left implied is that **the trail cannot constrain the role that can read everything.**
This is a single-owner business. The owner holds the widest grant in the F07 matrix and the database
credential, and there is no separation of duties to arrange. So every control here is a DETECTION control
for that role and not a prevention one, and an alert routed to the owner about the owner is a notification
to the person it is about.

Writing an alert that implied otherwise would be worse than writing none, which is why the four cases are
data with four required fields each — what is not prevented, who can do it, why it is not defended here,
and what would actually defend it, named concretely so the cost of closing it is visible. Three of the
four would need a second person; this business has one, and the `auditor` role exists in the matrix with
nobody in it.

`doesNotCover` is required rather than optional because the value of an exception list is entirely in its
being attached to the thing a reader would otherwise believe. An exception on a page of its own is a page
nobody opens. The equality is held in both directions, and `job_failure_rate` deliberately names NONE —
naming the pass's own blind spot on every entry would make the set-equality check pass while saying
nothing.

## The consequences somebody has to live with

- **A seventh condition is a row here plus an observer, or it does not compile.** It also needs a runbook
  heading that resolves, a severity, an audience of real F07 roles, a threshold that is either a pointer
  at a migration's figure or a bounded provisional setting, and an SLO shape. That is the intended cost:
  an alert with no procedure is a notification somebody invents a response to at 02:00.
- **The unreconciled settlement batch is NOT in the registry**, and it is absent rather than
  present-and-unobservable. Nothing in this schema records a settlement batch or its reconciliation
  state; Y-PAY-05 owns that and is `todo`. An entry whose observer could only ever answer *nothing to see*
  is the green dashboard this ADR refuses, so the obligation is handed to that unit in the manifest.
- **A refused admin sign-in now writes an `audit_event` row**, which is what makes the alert possible and
  also means an unauthenticated caller can make this system write rows. It is bounded to references that
  resolve to a real credential, and the residual is
  `refused-sign-ins-are-unmetered` — H-HARD-01's per-endpoint limit is not built.
- **`alert.raised` has no consumer**, deliberately. `drainOutbox` publishes an event once every
  INTERESTED handler has succeeded, so an event with no handler does not accumulate. Delivery to a person
  is R-REP-08's, and inventing a channel here would mean inventing a contact (`Y13-oncall`).
- **The send-backlog banner is chrome on every admin document**, so a database carrying more queued
  messages than the threshold will show it on every admin screenshot. That is correct behaviour and it is
  a real constraint on suites: a file that queues messages must delete the ones it queued.
