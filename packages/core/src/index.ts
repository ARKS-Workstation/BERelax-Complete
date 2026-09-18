/**
 * @berelax/core — pure domain logic. Availability, pricing, VAT, leave accrual,
 * commission, ledger rules.
 *
 * Hard constraints, enforced by `pnpm boundaries`:
 *   - may import @berelax/shared only
 *   - MUST NOT import @berelax/db, any app, any framework, or any I/O
 *   - MUST NOT read the clock directly; time is always injected
 */
export { assertNever } from './assert-never.ts'
