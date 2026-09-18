import { sql } from 'drizzle-orm'
import { bigint, check, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * The statutory numbering counters — one row per independent document series.
 *
 * The row **is** the counter. Allocation is `update document_series set next_number = next_number + 1
 * ... returning`, run inside the same transaction as the document insert, so a rolled-back document
 * returns its number instead of leaving a hole. A Postgres `SEQUENCE` cannot do this: `nextval` is
 * non-transactional by design and consumes a number on every rollback, which is exactly the gap a tax
 * authority asks about. See [ADR 0023](../../../../docs/adr/0023-gapless-numbering-row-locked-counter.md).
 *
 * `prefix`, `padding` and `reset_policy` are format, and format is data: changing them changes only
 * what is issued next. The formatted string is stored on the document at issue and never re-derived,
 * so renaming a prefix cannot renumber an invoice that has already been filed.
 *
 * `next_number` and `period_key` are mirrored here so the drift check can see them, but no query in
 * this package writes them: the application role holds no UPDATE privilege on those columns, and
 * `allocate_document_number()` is the only path to the counter. See
 * `packages/db/src/repositories/numbering.ts`.
 */
export const documentSeries = pgTable(
  'document_series',
  {
    /** 'TAX-INV', 'SIMPL-INV', 'CR-NOTE'. Stable: it appears in the gap report and in exports. */
    code: text('code').primaryKey(),
    documentKind: text('document_kind').notNull(),
    /** Used verbatim and carrying its own separator, e.g. 'TI-' renders 'TI-2026-00001'. */
    prefix: text('prefix').notNull(),
    /** Minimum zero-padded width, not a fixed width: a wider number is rendered in full. */
    padding: smallint('padding').notNull(),
    /** 'never' or 'annual'. */
    resetPolicy: text('reset_policy').notNull(),
    /**
     * The number the next allocation will issue, so a fresh series issues 1.
     *
     * `mode: 'bigint'` rather than `'number'`: the driver returns bigint as a string precisely so a
     * count cannot silently lose precision past 2^53 (see connection.ts), and a mirror that
     * re-introduced a JS number here would undo that for the one column the tax authority counts.
     */
    nextNumber: bigint('next_number', { mode: 'bigint' }).notNull(),
    /** The reset period the counter currently belongs to: '' under 'never', 'YYYY' under 'annual'. */
    periodKey: text('period_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // Named `..._allowed` rather than the anonymous name PostgreSQL gave the original, because 0028
    // dropped and re-added it to admit a fourth kind: the next unit that adds one extends it by name
    // instead of guessing what the constraint was called.
    check(
      'document_series_document_kind_allowed',
      sql`${t.documentKind} in ('tax_invoice', 'simplified_invoice', 'credit_note', 'supplier_bill')`,
    ),
    check('document_series_prefix_check', sql`${t.prefix} <> ''`),
    check('document_series_padding_check', sql`${t.padding} between 1 and 18`),
    check('document_series_reset_policy_check', sql`${t.resetPolicy} in ('never', 'annual')`),
    check('document_series_next_number_check', sql`${t.nextNumber} >= 1`),
  ],
)
