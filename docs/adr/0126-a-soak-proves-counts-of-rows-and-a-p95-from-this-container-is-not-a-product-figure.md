# ADR 0126 — A soak proves COUNTS OF ROWS; the p95 it also measures is a figure about the container, and the budget is enforced only for a machine somebody chose

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** H-HARD-11
- **Covers:** docs/01 decisions — none; this is brief rule 23 turned into a field and a rule, ADR 0070's
  "a reading is a reading" applied to a latency, and B-AVAIL-07's committed budget held to the one
  concurrency it was committed at (`Y13-perf-budget`)

## Context

The unit asks for five things: exactly one success out of 200 contenders for the last place, an
availability p95 under the committed budget at the declared concurrency with a breach failing the build,
a 10,000-event backlog draining exactly once per `(event, handler)`, the domain invariants holding
afterwards, and the measured numbers committed so a regression appears as a diff.

Four of those five are counts. One is a wall-clock percentile, and it was measured on a four-core
container shared with several other agents. `packages/fixtures/src/availability-perf.itest.ts` had
already measured the same container six times and written the numbers down: 192 to 231 ms alone and 315
to 417 ms inside a full run, against B-AVAIL-07's 300 ms budget for the CI Postgres. So a p95 from here
separates the container's mood from itself, and in a committed artefact it would be indistinguishable
from a figure about a deployment.

## Decision 1 — the four claims that are counts are enforced unconditionally

Nothing about them depends on the machine:

- **200 attempts in flight for ONE place**: exactly one commits, the other 199 are refused BY NAME, no
  rejection carries a raw SQLSTATE in the 23 (integrity) or 40 (serialisation) classes, and no room ends
  over capacity. That last pair is the acceptance line's "zero unhandled constraint-violation 5xx
  responses" expressed at the service boundary: a rejection with no refusal name IS a raw constraint
  violation reaching a caller, and a 40P01 is a deadlock. Measured there and not over HTTP because the
  declared Playwright spec needs a built application, which this unit's dispatch forbids — and because
  the HTTP layer would add a shell around the claim rather than making it.
- **Exactly one delivery per `(event, handler)` over 10,000 events**, counted as two numbers from the
  table: the delivery rows and the number of DISTINCT pairs. More rows than pairs is a second delivery;
  fewer rows than `events × handlers` is an event a handler never saw. Drained by several `drainOutbox`
  calls at once, because `for update skip locked` is what makes the claim interesting — with one drainer
  it is trivially true.
- **The money invariants against the post-soak database**, run as the named set rather than through a
  glob, which is `pnpm money-invariants`' own argument.

## Decision 2 — `machine.measuredOn` is a FIELD, and the budget is enforced only for `chosen_machine`

Not a comment beside the figure: a field in the artefact, typed to two values. `soakProblems` raises
`soak-availability-budget-breached` only when the reading says `chosen_machine`, and
`budgetVerdict` has THREE states rather than two — within budget, over budget, and **not judged**, with
the reason. "Not judged" has to be distinguishable from "within budget", which is ADR 0070's rule in a
new subject: a reading that was not compared to anything is not a reading that passed.

Both halves have a gate fixture, and that pairing is the decision. A budget rule that can never fire is
decoration; a budget rule that fires on an agent container is a gate that fails on correct work, and a
gate that fails on correct work is one somebody deletes. So case 204e supplies a breaching figure on a
chosen machine and watches the build fail, and 204f supplies the same figure on a container and watches
it be recorded instead.

## Decision 3 — the arithmetic IS enforced on every run, which is what makes the figure the measured one

The report carries every sample, and the gate recomputes the percentile from them. A hand-edited p95
fails. So the number in the artefact is the number that was measured, whatever machine it came off —
which is the half of a committed performance figure that can be checked without knowing anything about
the machine.

And the budget is stated only at the concurrency it was committed at. B-AVAIL-07 named 300 ms for fifty
concurrent queries on the CI Postgres; nobody has committed a figure at any other concurrency and nobody
has observed a peak, so a reading at any other concurrency carries `budgetMs: null` and names
`Y13-perf-budget`. Inventing a budget for 200 concurrent queries is exactly the figure brief rule 15
exists about.

Those two constants are now stated twice — in `packages/core/src/ops/soak.ts` and as literals in
`availability-perf.itest.ts` — so case 204j holds them equal, in the same commit as the second
statement.

## Decision 4 — what the soak found in its own first runs

**A handler that looked as if it had been called twice.** The first reduced run reported 50 calls for
handler A and 51 for handler B over 50 events. `drainOutbox` drains the WHOLE outbox and the second
handler takes `'*'`, so the extra call was a pending event something else had left in the database. For
a moment it read as the exact defect the run exists to detect. Calls for events the run did not publish
are now counted and reported separately, which keeps the interesting number interesting — and the same
fact is why `scripts/soak.mjs` is run deliberately against a database somebody chose rather than being
part of `pnpm verify`: a soak against a shared database publishes other suites' pending events.

## The consequence somebody will have to live with

**The committed p95 will say `not_judged` until somebody runs the soak on a machine they chose**, and
that is the honest state rather than a gap. `pnpm perf-budget` prints the figure, the machine, the core
count and the load average on every run, so the number is visible and a regression in it still appears
as a diff — it is simply not a pass or a fail.

**And the declared Playwright spec is not there.** `apps/web/e2e/last-slot-contention.spec.ts` would need
a built application, and `vitest.integration.config.ts` includes `apps/**/*.itest.ts`, so a `.spec.ts`
is a file nothing runs — H-MIG-10 already hit that and recorded it. The contention claim is made at the
service boundary instead, which is where the row lock is; what is NOT proved is that the HTTP layer
turns a typed refusal into a 409 rather than a 500, and the report says so.
