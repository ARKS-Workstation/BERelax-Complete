/**
 * C-AUTO-06 — the flow DSL's validator, its canonical form and the static analyser.
 *
 * The vocabulary and the zod schema are in `@berelax/shared` (`schemas/flow.ts`); the pinning rule and
 * the versioned rows are `@berelax/db`'s (`schema/flow.ts`, `repositories/flow.ts`), which reads this
 * validator through an injected function because it may not import this package.
 */
export * from './dsl.ts'
export * from './static-analysis.ts'
