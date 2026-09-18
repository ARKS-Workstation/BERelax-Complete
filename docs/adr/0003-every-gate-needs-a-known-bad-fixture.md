# ADR 0003 — every gate needs a known-bad fixture

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** F02
- **Supersedes nothing. Generalises:** [ADR 0002](0002-typescript-6-not-7.md)

## Context

In F01, `pnpm boundaries` reported success while cruising zero modules, because dependency-cruiser
did not support the installed TypeScript. The rule was configured, green, and dead. Only a test that
wrote a deliberate violation and demanded rejection caught it.

That was not a TypeScript problem. It is the general shape of every static gate: **a gate can fail to
examine anything and still report success.** Coverage thresholds pass on an empty suite. An axe run
passes on a page that did not render. A visual-regression diff passes with no baselines. A Lighthouse
budget passes when the URL 404s.

## Decision

Every gate in this build ships with a **known-bad fixture** that proves the gate fails. These live in
`scripts/test-gates.mjs` and `scripts/test-boundaries.mjs`, both wired into `pnpm verify` and CI.

Currently proven to fire:

| Gate | Fixture |
|---|---|
| unit runner | a test asserting `1 === 2` |
| typechecker | `const x: number = "string"` |
| linter | an explicit `any`, which `biome.json` sets to error |
| module boundaries | illegal imports for all three direction rules, asserted **by rule name** |
| core purity | `Date.now()` inside `packages/core` |
| CI completeness | the workflow file is asserted to invoke every gate by name |

Each fixture is written, run, and removed in a `finally`, so a crashed run cannot leave a poisoned
tree.

## Obligation on every future gate

A gate is not considered wired until its known-bad fixture is in `scripts/test-gates.mjs`. This
applies to the ones still to come: axe accessibility, the Lighthouse CI budget, visual regression,
the analytics egress guard, the banned-claims publication lint, and the consent-gating invariants.

The CI-completeness check has a second purpose: it makes **deleting a gate** a build failure. A future
session cannot quietly drop the integration tests to get a green run.

## Cost

Roughly 120 lines of script and a few seconds per verify. It has already caught one dead gate that
would otherwise have let a core-imports-db violation through for the remainder of the build.
