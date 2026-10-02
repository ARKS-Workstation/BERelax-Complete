import { sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { employee } from './staff.ts'

/**
 * Drizzle mirror of 0131_staff_import.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * One row per LINE of a reconstructed staff file, whether or not the line produced an employment record
 * — `imported_contact`'s arrangement (0121) and `imported_appointment`'s (0130), for the framework's
 * reason: a staged row that reaches `applied` having recorded no entity cannot COMMIT (ZY196), and the
 * line that recorded nothing is the one somebody has to go and look at.
 *
 * Two things this mirror cannot say:
 *
 *   - **it is append-only.** ZY373 raises on UPDATE and on DELETE for every role, and the application
 *     role holds neither privilege. A line that was quarantined and has since been corrected is a NEW
 *     record from a new run.
 *   - **an `imported` record must name an employee with a RECORDED GENDER.** ZY374, at COMMIT. Gender is
 *     a hard constraint on assignment (B-AVAIL-05), so a null one does not fail — it quietly makes that
 *     therapist unassignable to every gender-specified request while looking like an ordinary row, and
 *     0030 refused to have a migration invent nineteen people's genders. The importer quarantines such a
 *     line; this is what makes the quarantine unforgeable.
 *
 * There is NO column here, and no cell in the workbook behind it, for a bank account, an Emirates ID
 * number, a passport number or a visa number. The staging ledger keeps `import_row.payload` for ever and
 * no erasure reaches it (ADR 0072), so an IBAN in a workbook is an IBAN in that ledger permanently —
 * strictly worse than the plaintext column `employee_bank_detail` was built to avoid, because that
 * column does not exist and this one could not be removed. Those fields are entered through the HR
 * screens, which seal them under 0102's envelope scheme.
 */
export const importedStaffRow = pgTable(
  'imported_staff_row',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** The staff reference the line named, kept whether or not it resolved. Never a person's name. */
    staffReference: text('staff_reference').notNull(),
    /** `imported` | `quarantined`, held to the employee it names by ZY374. */
    outcome: text('outcome').notNull(),
    /**
     * A short lower-case name from `STAFF_QUARANTINES`, present exactly when `outcome` is
     * `quarantined`. The database holds the SHAPE and `packages/migration` the vocabulary.
     */
    quarantineReason: text('quarantine_reason'),
    /** The employment record, present exactly when `outcome` is `imported`. */
    employeeId: uuid('employee_id').references(() => employee.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // Partial, matching the migration: NULL is the ordinary case for a quarantined line, and a total
    // unique index would permit exactly one of them.
    uniqueIndex('imported_staff_row_one_per_employee')
      .on(t.employeeId)
      .where(sql`${t.employeeId} is not null`),
    index('imported_staff_row_quarantined_idx')
      .on(t.createdAt)
      .where(sql`${t.outcome} = 'quarantined'`),
    index('imported_staff_row_reference_idx').on(t.staffReference),
  ],
)
