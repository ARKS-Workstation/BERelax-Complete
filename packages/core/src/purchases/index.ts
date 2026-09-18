/**
 * The purchase side: what a supplier bill costs, what of its VAT may be reclaimed, and how overdue
 * what we owe is.
 *
 * Pure, like everything in this package: the gross comes in, the net, the VAT and the recoverable
 * claim come out, and the as-of date of an aging report is an argument rather than a clock read. The
 * writes live in `packages/db/src/services/post-bill.ts`, and the database holds the rule that a
 * supplier with no TRN supports no claim — see the note in `bill.ts` on why that rule is not restated
 * here.
 */

export * from './bill.ts'
export * from './payables-aging.ts'
