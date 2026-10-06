/**
 * @berelax/fixtures — the deterministic fixture salon.
 *
 * One seed, one frozen clock, one dataset, byte for byte, on every machine. See `salon.ts` for why
 * this is a generator rather than a SQL file, and `synthetic.ts` for the rules that keep it
 * unmistakably fake and physically undialable.
 */
export * from './admin-document.ts'
export * from './admin-principal.ts'
export * from './cash-up.ts'
export * from './checkout.ts'
export * from './clock.ts'
export * from './credit-note.ts'
export * from './customer-import.ts'
export * from './duplicate-queue.ts'
// `invoice.ts` joined the barrel for M-TILL-13: `FIXTURE_ISSUER` and `FIXTURE_HOURS` are what
// `checkoutMapping` defaults to, so a test comparing the till's transcription against it has to be able to
// pass the same two values in. There is nothing test-only about them that the rest of this barrel is not.
export * from './invoice.ts'
export * from './invoice-family.ts'
export * from './load.ts'
export * from './media.ts'
export * from './message-lifecycle.ts'
export * from './month-reconciliation.ts'
export * from './package.ts'
export * from './package-redemption.ts'
export * from './package-seed.ts'
export * from './partition-window.ts'
export * from './probe-services.ts'
export * from './purchases.ts'
export * from './recurring-costs.ts'
export * from './reports.ts'
export * from './rng.ts'
export * from './salon.ts'
export { canonicalJson, digest } from './serialise.ts'
export * from './soak.ts'
export * from './suppression.ts'
export * from './synthetic.ts'
export * from './till-receipt.ts'
export * from './vat201.ts'
