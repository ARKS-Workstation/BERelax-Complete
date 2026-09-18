import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { legalEntity } from './identity.ts'
import { journalEntry } from './ledger.ts'

/**
 * The opening-balance import — the mirror of 0027.
 *
 * This business is already trading, so its books do not start at zero. Every balance sheet the system
 * produces is this one entry plus everything since, which is why the table is guarded three ways: one
 * import per (entity, date), nothing dated before the opening date, and provisional zeros flagged so an
 * unanswered question is visible rather than indistinguishable from a settled one.
 */
export const openingBalanceImport = pgTable(
  'opening_balance_import',
  {
    importId: uuid('import_id').primaryKey().default(sql`uuid_generate_v7()`),
    legalEntityId: smallint('legal_entity_id')
      .notNull()
      .references(() => legalEntity.id),
    /** The date the books open. Every posting must be on or after it. */
    openingDate: date('opening_date').notNull(),
    /**
     * The journal entry this import posted. One entry, not one per account: the opening position is a
     * single balanced document, and a per-account entry would let half of it commit.
     */
    entryId: text('entry_id')
      .notNull()
      .references(() => journalEntry.entryId),
    /**
     * `mode: 'bigint'` because the underlying domain is `fils`, which is `bigint`. The driver returns
     * bigint as a string so a value beyond 2^53 cannot be silently rounded, and `mode: 'number'` would
     * undo that on a money column — which the trial balance discovered the hard way, reporting a
     * four-fils difference for a ledger that balanced.
     */
    totalDebitFils: bigint('total_debit_fils', { mode: 'bigint' }).notNull(),
    totalCreditFils: bigint('total_credit_fils', { mode: 'bigint' }).notNull(),
    /** Y8-opening-balances. True while the figures are the build's assumption, not the owner's answer. */
    isProvisional: boolean('is_provisional').notNull(),
    provisionalNote: text('provisional_note'),
    openQuestionId: text('open_question_id'),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull(),
    importedBy: text('imported_by').notNull(),
  },
  (t) => [
    // The whole protection against a double import — which is undetectable afterwards, because the books
    // still balance and are simply twice the size.
    unique('opening_balance_import_legal_entity_id_opening_date_key').on(
      t.legalEntityId,
      t.openingDate,
    ),
    index('opening_balance_import_provisional_idx').on(t.legalEntityId).where(sql`is_provisional`),
    check(
      'opening_balance_import_provisional_names_a_question',
      sql`not is_provisional or open_question_id is not null`,
    ),
    check('opening_balance_import_balances', sql`total_debit_fils = total_credit_fils`),
  ],
)
