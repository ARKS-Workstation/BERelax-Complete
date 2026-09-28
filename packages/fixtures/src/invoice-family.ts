import type { Sql } from '@berelax/db'

/**
 * Emptying the invoice family, in ONE place, because ten suites were each saying it.
 *
 * ## Why a truncate at all
 *
 * `invoice` refuses DELETE for every role including the owner (ZI003, migration 0056): a filed invoice is a
 * statement made on a date, and the answer to a wrong one is a credit note rather than a deletion. So a suite
 * that writes invoices cannot tidy up row by row, and TRUNCATE — which is a table-level privilege and not a
 * DELETE — is the only legal removal. It has to name every table holding a foreign key into the family,
 * because PostgreSQL refuses to truncate a table another table references unless that table is in the same
 * statement.
 *
 * ## Why it moved here
 *
 * Ten suites carried the identical statement `truncate refund, checkout_finalisation, payment,
 * invoice_appointment, invoice_line, invoice`, and P-HR-11's `commission_line` then took a foreign key to
 * `invoice`. Nine of the ten went on passing — the tenth, `till.itest.ts`, failed in its own teardown with
 * `cannot truncate a table referenced in a foreign key constraint` after seventeen green assertions, which is
 * the least useful place in a run for that sentence to appear. Ten statements of one fact is the drift this
 * repository keeps paying for; this is the one statement, and `invoice-family.itest.ts` derives the same set
 * from `pg_constraint` and fails when the two disagree, so the ELEVENTH table is named in a check about the
 * list rather than in whichever suite happened to run last.
 *
 * The list is still WRITTEN rather than derived at runtime, deliberately: a teardown that discovered its own
 * scope would quietly widen when a future migration pointed something unexpected at `invoice`, and a test
 * fixture that truncates whatever it finds is how a suite comes to empty a table it does not own.
 */
export const INVOICE_FAMILY_TABLES: readonly string[] = Object.freeze([
  // Referencing tables first for readability; TRUNCATE takes them as one set, so the order is not load-bearing.
  'refund',
  'checkout_finalisation',
  'payment',
  'commission_line',
  'invoice_appointment',
  'invoice_line',
  'invoice',
])

/**
 * Empties the invoice family as the OWNER.
 *
 * `sql.unsafe` because TRUNCATE takes identifiers rather than parameters, and the identifiers are this
 * module's own frozen list — nothing here comes from a caller.
 */
export async function truncateInvoiceFamily(sql: Sql): Promise<void> {
  await sql.unsafe(`truncate ${INVOICE_FAMILY_TABLES.join(', ')}`)
}
