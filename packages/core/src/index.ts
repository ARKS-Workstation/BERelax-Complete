/**
 * @berelax/core — pure domain logic. Availability, pricing, VAT, leave accrual,
 * commission, ledger rules.
 *
 * Hard constraints, enforced by `pnpm boundaries`:
 *   - may import @berelax/shared only
 *   - MUST NOT import @berelax/db, any app, any framework, or any I/O
 *   - MUST NOT read the clock directly; time is always injected
 */

export * from './access/permissions.ts'
export * from './agents/index.ts'
export { assertNever } from './assert-never.ts'
export * from './availability/index.ts'
export * from './business-day/index.ts'
export * from './checkout/index.ts'
export * from './compliance/index.ts'
export * from './crm/index.ts'
export * from './documents/invoice-template.ts'
export * from './google/index.ts'
export * from './hr/employee.ts'
export * from './identity/index.ts'
export * from './ledger/index.ts'
export * from './lifecycle/index.ts'
export * from './messaging/retry.ts'
export * from './money/recurring-schedule.ts'
export * from './money/vat.ts'
export * from './money.ts'
export * from './pricing/index.ts'
export * from './purchases/index.ts'
export * from './reviews/index.ts'
export * from './seo/index.ts'
export * from './tax/index.ts'
export * from './text/index.ts'
export * from './time.ts'
