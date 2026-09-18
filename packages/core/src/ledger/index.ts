/**
 * The pure double-entry ledger kernel (ADR 0017).
 *
 * Append-only journal, corrections by dated reversal, and no capability anywhere in this codebase to
 * file a tax return. Everything here is a pure function of its arguments: no clock, no I/O, no
 * framework. `scripts/check-core-purity.mjs` additionally forbids `Date` and `Intl` under this
 * directory, because a ledger that could re-derive a date from a clock would quietly disagree with
 * the `business_day` its caller resolved.
 */

export * from './account.ts'
export * from './chart-of-accounts.ts'
export * from './entry.ts'
export * from './reverse.ts'
