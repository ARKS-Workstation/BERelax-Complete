/**
 * @berelax/fixtures — the deterministic fixture salon.
 *
 * One seed, one frozen clock, one dataset, byte for byte, on every machine. See `salon.ts` for why
 * this is a generator rather than a SQL file, and `synthetic.ts` for the rules that keep it
 * unmistakably fake and physically undialable.
 */
export * from './cash-up.ts'
export * from './checkout.ts'
export * from './clock.ts'
export * from './credit-note.ts'
export * from './duplicate-queue.ts'
export * from './load.ts'
export * from './media.ts'
export * from './message-lifecycle.ts'
export * from './package.ts'
export * from './purchases.ts'
export * from './recurring-costs.ts'
export * from './reports.ts'
export * from './rng.ts'
export * from './salon.ts'
export { canonicalJson, digest } from './serialise.ts'
export * from './suppression.ts'
export * from './synthetic.ts'
