# ADR 0122 — a performance budget is ONE declaration, and an unmeasured figure is absent rather than invented

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** W-SITE-11
- **Covers:** docs/01 decisions — none; this is the mechanism behind docs/08 §8's "three independent
  enforcement layers" and its "any of the three failing is a red build, not a ticket", and it stands on
  [ADR 0003](0003-every-gate-needs-a-known-bad-fixture.md) (every gate needs a known-bad fixture),
  [ADR 0002](0002-typescript-6-not-7.md) (a gate that silently examined nothing) and brief rule 15 (do not invent a
  value the real system will one day hold)

## Context

docs/08 §8 names three enforcement layers and `build/budgets.json` records, in the collector's own
entry, that one of them did not exist: *"Lighthouse CI does not exist in this repository and is
W-SITE-11's to add."* So the question was not how to run Lighthouse. It was how to write a budget that
cannot quietly stop being one.

## Decision 1 — one declaration, and `lighthouserc.cjs` holds no figure

`lighthouse/budget.json` is the only place a figure appears. It is **not** Lighthouse's own budgets
schema, and that is deliberate rather than convenient: three of the nine figures cannot be expressed as
a Lighthouse budget at all (CLS and DOM size are audits rather than budget metrics, and *requests before
LCP* has neither a budget nor an audit), and two of them differ by form factor, which a Lighthouse
budgets file cannot say because a Lighthouse budget carries no form factor.

So every figure is declared once, with its basis and with the mechanism that enforces it, and
`lighthouserc.cjs` **derives** the Lighthouse-native subset and the LHCI assertions from it.
`scripts/check-performance-layers.mjs` refuses a numeric literal in that config file, which is what
makes the derivation a rule rather than a habit. Gate case 200e writes one threshold into the config —
the shape the obvious implementation takes — and the rule fires.

The native budgets file is **emitted and not committed**, for the same reason: a committed copy would be
a second statement of the declaration's numbers, and the symptom of a second statement is a CI job
passing on the one nobody meant.

## Decision 2 — the enforcement is the script, not Lighthouse

A Lighthouse budget breach is a **warning inside the report**, not a non-zero exit. A job that ran
Lighthouse with a budgets file and nothing else would be green over every breach it measured.

So `pnpm perf-layers --reports <dir>` reads the reports a collection wrote and exits non-zero **naming
the metric and the measured value** — *largest-contentful-paint measured 2600 ms, budget 2000 ms*. It
also refuses two things that are not evidence:

- **a report with no document that answered 200.** Lighthouse scores an error page nearly perfectly: no
  images, no scripts, one tiny document, instant paint. A job that passed on a 404 would be the purest
  version of a gate that is not one, which is why the enforcement reads the document request's own
  status code rather than the scores (gate case 200j).
- **a run with no report at all.** Zero breaches over zero evidence is what a collection that silently
  did nothing produces, and it is the failure `pnpm boundaries` cruising zero modules made the general
  argument for (gate case 200k).

## Decision 3 — an unmeasured figure is ABSENT, and is reported on every run

Total blocking time is the acceptance line's INP proxy and the acceptance line gives **no number**.
Nothing in this repository has ever run Lighthouse against this site: the one web build this unit was
budgeted could not be spent, because the container had 1.6 GB free with three other agents building.

A figure invented here would be either so loose it never fires or so tight it fires on correct code, and
the second is how a gate comes to be switched off. So `lab-tbt` carries `basis: "unmeasured"`, no
figure, and `Y5-analytics-basis`; the gate **refuses an unmeasured budget that has acquired a number**
(gate case 200c) and **prints the unenforced budget on every run** so that it cannot be quietly
forgotten. The same shape covers the field layer, which is A-MEAS-04's: the layer is declared with
`enforcedBy: null` and a `blockedOn`, and the gate refuses that marker once the unit is `done`.

That is this record's one general rule, and it is brief rule 15 applied to a threshold rather than to a
TRN: **a budget this build guessed at is worse than a budget it has not written**, because a blank is
visibly unanswered and a plausible number is indistinguishable from a measured one.

## Decision 4 — a route the registry does not serve is DECLARED and not collected

The acceptance line names four route shapes and one of them, the therapist page, does not exist:
W-SITE-06 owns it. A budget that dropped the shape would be a budget the page grows past the day it
lands; a budget that collected it would score the 404.

So the shape is declared with `blockedOn: "W-SITE-06"`, excluded from the collection, and the gate
refuses the marker in **both** directions — on a route the registry does serve, and on a unit the
manifest records as `done`. Gate case 200b removes the marker and the rule fires.

The locale prefix is the same shape one level down: the Arabic cell's `pathPrefix` is `LOCALE_PREFIX`'s
own value, read out of `apps/web/src/i18n/locales.ts` and held equal to it, because a second spelling of
which URL the Arabic document lives at is half the matrix collected against a 404 (gate case 200f).

## Decision 5 — the matrix-coverage gap is committed as DATA, and the rule refuses an addition

The fifth acceptance line asks that every route in the registry be covered by both an axe run and a
visual-regression baseline. Derived from the suites rather than declared — a suite's subject is the
`probePath` it hands `startWebServer`, and it covers that route when the same file both calls
`auditPage(` and takes a screenshot — the measured answer on the day this gate was written is that
**one public document is covered and twelve are not**. `pnpm a11y` audits the design specimen across
the whole matrix and the per-route sweeps live in individual browser suites.

A gate that failed the build on twelve routes would have been switched off within the week. So the
twelve are committed in `matrixCoverage.alreadyUncovered`, and what the rule refuses is an **addition**:
a public document written after this gate is covered or it is refused, and an entry removed from the
baseline while its route is still uncovered is reported as its own violation (gate case 200h). Closing
the gap is a change inside six other units' suites and is recorded as a deferral on W-SITE-11 rather
than done here.

## Consequences somebody has to live with

- **The measured half has never run.** The static half runs in `pnpm verify` on every commit and the
  collection is a CI job of its own, because Lighthouse needs the built application on a port. Every
  figure the enforcement compares is exercised against **recorded** Lighthouse reports in gate block
  200, which is what makes the mechanism proven while the measurement is not; the first real collection
  is CI's.
- **`@lhci/cli` is not a dependency.** It is tens of megabytes of tooling nothing in this repository
  imports, and `pnpm install` runs in every agent's worktree: a dependency here would be paid for on
  every machine to be used on one. CI reaches it with `pnpm dlx`, which makes the job network-dependent
  and therefore CI-only — the same argument `pnpm audit:online` makes, and
  `scripts/check-gate-registry.mjs` carries both as declared CI-only steps.
- **The theme axis is a Chrome flag.** `prefers-color-scheme` is not a Lighthouse setting, so the cell
  is forced with `--blink-settings=preferredColorScheme`, declared in the budget so that the cell and
  the flag cannot disagree. Two cells carrying one flag is two runs of the same theme, and the gate
  refuses it (gate case 200d).
- **Two of the three layers are built.** The CI layer is this unit's and the publish layer is
  `packages/core/src/publication/weight.ts`; gate case 200l shows the first going red with the second
  holding, and asserts that neither module reaches into the other — which is what makes them two layers
  rather than one with two names. The field layer is A-MEAS-04's and is declared unenforced.
