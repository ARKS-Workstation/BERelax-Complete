# ADR 0002 — TypeScript 6, not 7

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** F01
- **Covers:** docs/01 decisions — none; this is a build-process decision
- **Revisit when:** dependency-cruiser declares TypeScript 7 support, and the Next.js / Drizzle /
  Payload stack is known-good on it.

## Context

TypeScript 7.0.2 is the current latest release. The initial scaffold pinned it.

## What actually happened

With TypeScript 7 installed, `pnpm boundaries` reported:

```
✔ no dependency violations found (0 modules, 0 dependencies cruised)
‼ missing-typescript-transpiler: dependency-cruiser detected a TypeScript environment,
  but not a compatible TypeScript compiler (typescript: >=2.0.0 <7.0.0)
  => Support for typescript@>=7 will follow when its API is published and stable.
```

**Zero modules cruised, and a green tick.** The boundary gate was passing because it was doing
nothing. `pnpm boundaries:test` then failed all three rules — *"violation NOT rejected"* — which is
the only reason this was caught rather than shipped.

## Decision

Pin **TypeScript 6.0.3**. Current, stable, one major behind, and fully supported by the toolchain.
After the downgrade: 5 modules cruised, 4 dependencies, all three boundary rules provably rejecting.

## Reasoning

The plan's stated preference is boring, well-supported technology
([01-scope-and-decisions.md](../01-scope-and-decisions.md)). Being on the newest compiler bought
nothing and silently disabled a correctness gate. The rest of the intended stack — Next.js, Drizzle,
Payload — is also more likely to be validated against TypeScript 6 than 7 at this point, so the
downgrade probably avoids more than one instance of this.

## The general lesson, which applies beyond TypeScript

**A passing check that examined nothing is worse than a failing check.** Every gate in this build needs
a test that proves the gate itself fires. This applies next to the axe accessibility run, the
Lighthouse budget, the visual-regression diff and the palette gate — each needs a known-bad fixture.
