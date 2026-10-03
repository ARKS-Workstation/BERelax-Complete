# ADR 0120 — an unsound figure is a refusal, and which checks gate a figure is DERIVED

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** R-REP-07
- **Covers:** docs/01 decisions — none; this is the mechanism behind docs/02 §4's reporting schema and
  docs/03's KPI set, and it stands on
  [ADR 0070](0070-an-unattributable-cost-is-a-refusal-and-never-a-zero.md) (an unattributable cost is a
  refusal and never a zero),
  [ADR 0073](0073-a-forecast-line-is-a-commitment-already-on-file-and-a-projection-is-marked.md) (a projection carries its basis in
  the figure), [ADR 0068](0068-a-kpi-is-an-expression-so-its-formula-cannot-drift-from-its-figure.md) (a KPI is an
  expression and a zero divisor is an answer), [ADR 0060](0060-the-reporting-schema-is-derived-and-keyed-on-business-day.md) (the
  reporting schema is derived and `reporting.refresh_run` is the freshness record),
  [ADR 0090](0090-reconciliation-to-the-fils-is-an-identity-and-a-variance-nobody-can-attribute-is-a-refusal.md)
  (reconciliation to the fils is an identity) and [ADR 0003](0003-every-gate-needs-a-known-bad-fixture.md)

## Context

ADR 0070 settled what a KPI answers when a cost cannot be attributed, and ADR 0073 settled what a
forecast line carries when it is a projection. Both are about the figure's own inputs. Neither says
anything about the case where the inputs are all present and the *data behind them disagrees with
itself* — a sale fact that does not match the journal, a materialised view nobody refreshed, a
reconciliation pass that has never run.

That case is the one with no symptom. An unattributable cost makes the arithmetic refuse; an
unreconciled day makes the arithmetic produce a number, and the number is wrong by whatever the
discrepancy is. On a tile it is indistinguishable from a correct one.

## Decision 1 — the gate EXTENDS `KpiOutcome`; it does not restate it

`GatedFigure<T>` in `packages/core/src/reporting/data-quality.ts` is `KpiOutcome<T>` plus three states.
The four states ADR 0070 decided — `value`, `no_denominator`, `no_data`, `not_attributable` — are not
re-spelled anywhere in this unit.

The obvious alternative is a second union with its own `value` branch, which a dashboard would reach
through a conversion. It fails for the reason the brief states generally and this subject makes acute: a
second answer to *may this be printed* drifts, and the direction it drifts in is the one that prints
something. There would then be two places a figure becomes text, and only one of them would be the one
somebody remembered to put the gate in front of.

The three added states are three and not one, and each distinction is load-bearing:

- **`unreconciled`** — two sides of one figure were compared and they disagree. It carries the variance
  and the checks and **no `value` field at all**, which is `reconcileDispatches`' own arrangement
  (ADR 0090, A-MEAS-07) for the same reason: a caller that could read a number off a refusal would read
  it.
- **`stale`** — the view the figure is read from is older than the window. Not wrong; *old*, which is
  what makes it dangerous.
- **`unattested`** — a check that gates this figure has never run. Deliberately **not** `unreconciled`.
  Folding them would report a build that has reconciled nothing as a build whose reconciliation is
  failing, and the first response to that is to go looking for a discrepancy nothing has claimed exists
  rather than to run the pass. It is the same distinction the acceptance line makes one layer up — *a
  check that has never run reads `unknown`, never `pass`* — and it is why a reading's `observed` is
  `null` rather than `{ left: 0, right: 0 }`: those are the same pair of numbers and different claims.

`publishGatedFigure` takes `Extract<GatedFigure, { state: 'value' }>` and nothing else. There is
therefore no code path from a failing check to a printed number — not a path that is checked at runtime,
a path that does not exist. `packages/ui/src/reporting/kpi-tile.ts` switches over the states with no
`default:`, so a state added to the union is a `pnpm typecheck` failure naming the renderer rather than
a tile that silently renders nothing.

## Decision 2 — dependence is DERIVED from what the figure reads, never declared beside the tile

*Every dependent tile renders the unreconciled state* needs an answer to which tiles depend on which
check. The obvious shape is a list of check ids on the tile, or a map from KPI to checks.

**That list is a second statement of what the KPI reads, and it drifts silently in the worst direction.**
A KPI whose expression starts reading a new dataset keeps its old list and keeps rendering a number. The
failure has no symptom at all: the tile is green, the check is red on another screen, and nothing
connects them.

So a check declares the **subjects** it attests; a KPI's subjects are computed from the `reads`
declarations of its transitive measures — which `measure-reads-exactly-the-fields-it-declares` (ADR 0068)
already holds equal to what the reducers actually touch, in both directions — and `checksGating`
intersects the two. Nothing is written twice. A KPI that acquires a dataset acquires its checks on the
same commit that widens its expression.

Two rules fall out and both are asserted by name. `every-kpi-dataset-is-attested-by-a-check` is the one
that earns its place: a dataset no check attests is a figure that passes the gate *because nothing looked
at it*, which is the only failure of this unit that looks exactly like success. Gate case 198a narrows
`view_freshness` from every subject to the revenue facts — a change that reads as a tidy-up, leaves every
other rule passing and every tile rendering — and the rule fires.

## Decision 3 — a KPI whose datasets are not all loaded is NOT OFFERED

`packages/db/src/reporting/kpi-input.ts` loads six of `KpiInput`'s eleven datasets and says which six.
R-REP-05's five are a cohort-month grain, and a window of trading dates is not the argument they take.

The dangerous way to write that loader is to return every field with the ones nobody loaded left empty.
`room_closure_minutes` over no closures is zero, so `available_room_minutes` becomes the whole open day
and every room reads as available for all of it. **An empty dataset is a figure of zero in a sum, and an
absent one is not** — ADR 0070's sentence, one subject along.

So `kpisComputableFrom` drops any KPI reading a dataset the loader does not load, and such a KPI is not
rendered as `no_data`: it is not on the dashboard. `KPI_INPUT_LOADED_DATASETS` is the declaration and
`apps/web/src/data-quality.itest.ts` holds it equal to the loader's own keys in both directions, because
a dataset added to the loader and left out of the list makes its KPIs quietly unavailable while one
removed from the loader and left in the list makes them quietly wrong.

## Decision 4 — the checks are IDENTITIES and CENSUSES, never thresholds

Seven checks, and not one of them holds a figure this build chose. Four compare two sides of one quantity
(`ledger_vs_facts`, `rollup_vs_raw`) or count rows that must not exist (`attribution_coverage`,
`ref_capture`, `bot_share`, `dispatch_reconciliation`). The seventh compares an age against the staleness
window, which is **26 hours from R-REP-07's own acceptance line** and stated once, in `core`, with
`packages/db` taking it as an argument so there is no second answer to *when is a view stale*.

The rejected alternative is the one every monitoring tool ships: a coverage percentage with a target, a
bot share with a ceiling. Each is a figure nobody here has measured, and a threshold invented in this
repository would decide which traffic reports counted and which bookings were "attributed enough". ADR
0085 rejected the same shape for the site analyses and ADR 0070 for a pro-rata cost split. An
identity has no such parameter, and when it fails the sentence a reader gets — *the facts carry 19,048
fils and the journal 19,049* — is one somebody can act on.

Two hours over a day rather than exactly 24, and the reason is in the margin rather than in the figure: a
window of exactly a day calls every figure stale for as long as tonight's pass is late, and an alarm that
fires on an ordinary variation is an alarm somebody turns off.

## Consequences somebody has to live with

- **Every rule takes the registry it judges as an ARGUMENT.** The first version of `dataQualityFindings`
  called `checksGating`, which read the *shipped* registry — so the rule about a KPI reaching no check
  could not fire for a deliberately blinded one, which is the only way it was ever going to be seen to
  fire. Gate case 198b restores that defect and requires the rule's own name back.
- **A refusal is not a free pass to an empty screen.** The formula is printed under every state, because
  a reader asking *what would this have been* needs the definition, and the drill-down names the
  offending rows. A check's row count is taken in SQL and the page is a page of it — the capped-reader
  defect the brief records about `settingHistory`, avoided by counting on the other side.
- **The data-quality screen is cited, so its window has no default.** `?from=` and `?to=` are required.
  A page answering for *the last thirty days* answers a different question every day, and this page is
  the evidence that a figure somebody acted on was sound at the time.
- **`reporting.refresh_run` cannot be backdated** (ZY184, append-only), which is what makes the staleness
  claim worth making — and it means a suite proving the staleness path moves the *reading instant* rather
  than the refresh. That is the same arithmetic a nightly pass failing for a day would produce.
- **The report is `report:read` and a refusal is a row.** `audit_event` with `operation = 'denied'`, in
  the same transaction, because a refusal nobody recorded is indistinguishable from a request nobody
  made — and the trail is this build's insider-threat control (docs/06 §D4).
