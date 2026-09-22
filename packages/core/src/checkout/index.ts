/**
 * The checkout basket (M-TILL-05).
 *
 * Lines built from completed appointments at their snapshotted prices, discounts that must say why,
 * tips that never touch revenue, and package redemptions that carry no price. Everything here is a pure
 * function of its arguments: no clock, no I/O, no framework. `scripts/check-core-purity.mjs` also
 * forbids `Date` and `Intl` under this directory — the basket takes no date at all, and a date
 * re-derived here would be a second opinion about the trading day the caller already resolved.
 *
 * Finalising a checkout — the invoice, the journal entry and the tenders, in one transaction — is
 * M-TILL-06's, in `packages/db`. This module decides the figures; nothing here writes anything.
 */

export * from './basket.ts'
export * from './discount.ts'
export * from './line.ts'
export * from './tip.ts'
