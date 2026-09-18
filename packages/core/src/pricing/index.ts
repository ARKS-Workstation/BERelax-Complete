/**
 * The price resolution chain (B-CAT-04, ADR 0021).
 *
 * Pure: the effective date is an argument, never a clock read, because the same appointment is priced
 * from three different dates in its life — quoted today, rescheduled next week, re-rendered on an
 * invoice next year — and only the caller knows which one it is asking about.
 */

export * from './resolve-price.ts'
