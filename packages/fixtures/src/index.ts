/**
 * @berelax/fixtures — the deterministic fixture salon.
 *
 * One seed, one frozen clock, one dataset, byte for byte, on every machine. See `salon.ts` for why
 * this is a generator rather than a SQL file, and `synthetic.ts` for the rules that keep it
 * unmistakably fake and physically undialable.
 */
export * from './checkout.ts'
export * from './clock.ts'
export * from './load.ts'
export * from './media.ts'
export * from './message-lifecycle.ts'
export * from './purchases.ts'
export * from './recurring-costs.ts'
export * from './reports.ts'
export * from './rng.ts'
export * from './salon.ts'
export { canonicalJson, digest } from './serialise.ts'
export * from './synthetic.ts'
