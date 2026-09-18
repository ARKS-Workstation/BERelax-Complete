/**
 * Tax classification: which input VAT may be reclaimed, and which the law blocks.
 *
 * Pure, like everything in this package. The figures a bill produces are `../purchases/bill.ts`; what
 * the ledger does with them is `@berelax/db`. This module holds only the classification — a property of
 * the account, stated on every account with no default, and recorded onto the line when a bill is posted
 * so that a return can never be restated by a change of interpretation.
 */

export * from './recoverability.ts'
