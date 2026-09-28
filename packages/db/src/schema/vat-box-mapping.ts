import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { account } from './ledger.ts'

/**
 * The VAT201 box mapping, mirroring `0089_vat201_mapping.sql` (M-VAT-07).
 *
 * Migrations are SQL-first (ADR 0006): the hand-written `.sql` is the schema and this is a mirror that
 * `pnpm db:drift` compares against the live database in both directions. Nothing writes through Drizzle —
 * the mapping has no application write path at all, because a classification is a migration and not a
 * settings screen (`account`'s own argument, 0018) — so what is mirrored here is the SHAPE, and a drifting
 * column fails the build rather than a return at quarter end.
 *
 * Four things this mirror cannot express, which therefore live only in the migration:
 *
 *   - `vat201_mapping_is_complete()` and its two DEFERRED constraint triggers, which raise **ZY009** when
 *     an account feeds the return or does not and nothing says which;
 *   - `vat201_measure_matches_the_account()`, which raises **ZY010** because a revenue account cannot
 *     hold tax — mapping 4010 as `measure = 'tax'` would report the net as VAT, about twenty-one times
 *     the right figure, on a return whose drill-down still reconciles to it;
 *   - the seven functions that ARE the return engine: `vat201_box_line()` (the drill-down),
 *     `vat201_box_total()` (an aggregate over it, never a second query), `vat201_unboxed_total()`,
 *     `vat201_partition_census()`, `vat201_mapping_disagreement()` and the two document resolvers;
 *   - the grants, which are what make "no application write path" true rather than merely intended.
 *
 * All four are proved against a real PostgreSQL in `packages/fixtures/src/vat201.itest.ts` and by gate
 * block 116, because a deferred trigger and a grant cannot be tested against a mock.
 */

/**
 * One row per box on the return form.
 *
 * [UNVERIFIED] Every row is provisional against Y11-vat201-boxes: 1, 3 and 10 are that question's
 * RECORDED provisional answer and not a confirmed layout. `label` is constrained to carry a marker
 * `is_placeholder_text()` recognises (0026) for exactly as long as `is_provisional` is set, in both
 * directions — so a working paper cannot print the number as settled, and the flag cannot be cleared
 * while the marker is still in the label.
 */
export const vat201Box = pgTable(
  'vat201_box',
  {
    /** The number printed on the form. The authority's value, never a serial. */
    boxNo: integer('box_no').primaryKey(),
    label: text('label').notNull(),
    /** 'output' | 'input'. Carried rather than inferred from box_no: the numbering is the unknown. */
    side: text('side').notNull(),
    /** Report order, stated so answering Y11-vat201-boxes cannot silently reorder the working paper. */
    displayOrder: integer('display_order').notNull().unique(),
    /** The provenance trio `unconfirmedAssumptionRows()` reads (docs/12 §2). */
    isProvisional: boolean('is_provisional').notNull(),
    openQuestionId: text('open_question_id'),
    provisionalNote: text('provisional_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('vat201_box_box_no_check', sql`${t.boxNo} between 1 and 99`),
    check('vat201_box_label_check', sql`btrim(${t.label}) <> ''`),
    check('vat201_box_side_check', sql`${t.side} in ('output', 'input')`),
    check('vat201_box_display_order_check', sql`${t.displayOrder} >= 1`),
    check(
      'vat201_box_provisional_trio',
      sql`${t.isProvisional} = (${t.openQuestionId} is not null and ${t.provisionalNote} is not null)`,
    ),
    check(
      'vat201_box_provisional_label_is_marked',
      sql`${t.isProvisional} = is_placeholder_text(${t.label})`,
    ),
  ],
)

/**
 * Account → box, column and direction. One row per account, enforced by the primary key.
 *
 * Keyed on the ACCOUNT and not on `account.vat_box`, which M-VAT-03 recorded the reason for: 2035
 * Reverse-charge VAT payable and 6075 Software and imported services share the `reverse_charge` grouping
 * and belong in different COLUMNS of the box on opposite SIDES of the arithmetic, and a sum over the
 * grouping alone put the rent expense into the input VAT figure (2,006,706 fils where the claim was
 * 6,706).
 */
export const vat201BoxMapping = pgTable(
  'vat201_box_mapping',
  {
    accountCode: text('account_code')
      .primaryKey()
      .references(() => account.code),
    /** 'box' | 'unallocated' | 'out_of_scope'. The absence of a ROW is what ZY009 refuses. */
    disposition: text('disposition').notNull(),
    boxNo: integer('box_no').references(() => vat201Box.boxNo),
    /** 'net_supplies' (the value of the supply) | 'tax' (the VAT on it). */
    measure: text('measure'),
    /** 'credit_less_debit' (output side) | 'debit_less_credit' (input side). */
    contribution: text('contribution'),
    /** Why. NOT NULL: an attribution with no stated reason is one a tax agent cannot review. */
    note: text('note').notNull(),
    openQuestionId: text('open_question_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('vat201_box_mapping_box_idx').on(t.boxNo, t.accountCode).where(sql`box_no is not null`),
    check(
      'vat201_box_mapping_disposition_check',
      sql`${t.disposition} in ('box', 'unallocated', 'out_of_scope')`,
    ),
    check('vat201_box_mapping_measure_check', sql`${t.measure} in ('net_supplies', 'tax')`),
    check(
      'vat201_box_mapping_contribution_check',
      sql`${t.contribution} in ('credit_less_debit', 'debit_less_credit')`,
    ),
    check('vat201_box_mapping_note_check', sql`btrim(${t.note}) <> ''`),
    check(
      'vat201_box_mapping_shape',
      sql`case ${t.disposition}
      when 'box' then ${t.boxNo} is not null and ${t.measure} is not null and ${t.contribution} is not null
      when 'unallocated' then ${t.boxNo} is null and ${t.measure} is not null and ${t.contribution} is not null
      when 'out_of_scope' then ${t.boxNo} is null and ${t.measure} is null and ${t.contribution} is null
      else false
    end`,
    ),
    check(
      'vat201_box_mapping_unallocated_names_its_question',
      sql`(${t.disposition} = 'unallocated') = (${t.openQuestionId} is not null)`,
    ),
  ],
)
