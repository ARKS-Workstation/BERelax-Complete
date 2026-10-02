/**
 * The PaymentGateway port and its state logic (ADR 0055).
 *
 * Types and pure functions only. Every adapter lives in `@berelax/payments`, is constructed by that
 * package's registry and by nothing else, and means "adapter" only once the conformance suite accepts it.
 * `scripts/check-core-purity.mjs` additionally forbids `Date` and `Intl` under this directory, for the
 * ledger's reason: every instant here arrives on an event a caller read from a gateway, and a second
 * opinion about when something happened would move a capture between trading days.
 */

export * from './deposit.ts'
export * from './fee-policy.ts'
export * from './guards.ts'
export * from './minor-units.ts'
export * from './port.ts'
export * from './state.ts'
export * from './transactions.ts'
