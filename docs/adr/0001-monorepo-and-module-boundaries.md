# ADR 0001 — pnpm monorepo with enforced module boundaries

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** F01

## Context

Nine modules (booking, money, CRM, people, analytics, reporting, web, agents, payments) in one
codebase. The failure mode is a ball of mud where domain logic reaches into the database, the database
reaches back into domain logic, and nothing is testable in isolation.

## Decision

A pnpm workspace with one Next.js app (added in F03) and layered packages, with the dependency
direction **enforced by a tool in CI**, not by convention:

```
apps/*  ->  core, db, shared
db      ->  shared
core    ->  shared        (pure: no db, no I/O, no framework, no clock)
shared  ->  nothing internal
```

Enforced by `dependency-cruiser` (`.dependency-cruiser.cjs`) with five rules plus a
circular-dependency ban.

`packages/core` holds every calculation where a bug costs money or breaks the law — availability,
pricing, VAT, leave accrual, commission, ledger. Keeping it pure is what makes those testable as
functions, which is why `core-must-be-pure` also forbids `node:fs`, `next`, `react`, `drizzle-orm`
and `pg`.

## Consequence worth naming

**A lint rule nobody has watched fail might not work.** So `scripts/test-boundaries.mjs` writes a
deliberately illegal import, asserts dependency-cruiser rejects it *by rule name*, and removes the
fixture. It runs in `pnpm verify`.

This paid for itself immediately — see ADR 0002.

## Alternatives rejected

- **Convention plus code review.** No reviewer on this build (Claude is the sole builder), so a rule
  that is not mechanical is not a rule.
- **Separate repos per module.** Enormous coordination cost for a single-location business.
- **ESLint with `eslint-plugin-boundaries`.** Viable, but dependency-cruiser also gives circular
  dependency detection and orphan detection, and reports by rule name, which the fixture test needs.
