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
 * ## Every table in both lists is append-only, and TRUNCATE is deliberately the only removal
 *
 * Y-PAY-01 raised this at merge and it is worth answering here rather than in nine teardowns: `TRUNCATE` does
 * not fire row-level BEFORE DELETE triggers, so emptying `commission_line` this way does not go through
 * `commission_line_no_delete` (ZY072) — and the same is true of `invoice` (ZI003), `payment` and `refund`,
 * which these statements have emptied since long before commission existed. It is not a bypass smuggled in
 * with a new table: it is the reason a truncate is here at all. A filed document refuses DELETE for every
 * role INCLUDING the owner, so a suite that writes one cannot tidy up row by row, and `TRUNCATE` — a
 * table-level privilege the application role does not hold — is the only legal removal. What the triggers
 * guarantee is that nothing reaches those rows through the application, and revoking the privilege is what
 * holds for a `psql` session; neither is weakened by a fixture emptying the whole table between runs. Stating
 * it once, here, is the point of having one statement of the list.
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

/**
 * The package family, on the same terms, and it broke in the same merge for the same reason.
 *
 * Six suites carried the identical `truncate package_redemption, payment, package_balance, package_sale,
 * package_template_line, package_template_version, package_template`, and P-HR-11's `commission_line` took a
 * foreign key to `package_redemption` as well as to `invoice` — a commission line is earned on a treatment
 * that was either invoiced or drawn down from a package, so it points at both. Four suites then failed in
 * teardown, and the first fix (adding `commission_line` to the invoice family only) moved the failure from one
 * statement to the other rather than removing it: the two families overlap in `payment` and now in
 * `commission_line`, and a list per suite cannot be kept in step with a schema.
 *
 * `payment` is in BOTH lists deliberately. It references `invoice` and `package_sale`, so whichever family is
 * emptied first has to take it, and naming it twice is how each statement stays legal on its own. TRUNCATE is
 * idempotent over an empty table.
 */
export const PACKAGE_FAMILY_TABLES: readonly string[] = Object.freeze([
  'commission_line',
  'package_redemption',
  // 0119's reconstruction record, which references `package_sale` — so whichever suite empties the family
  // has to take it, or TRUNCATE refuses the whole statement. `import_staging.import_sign_off` is its
  // PARENT and is deliberately absent: the staging ledger is append-only and holds no DELETE grant (0111),
  // and a signature is evidence that an import happened, which is not a suite's to remove.
  'imported_package_sale',
  'payment',
  'package_balance',
  'package_sale',
  'package_template_line',
  'package_template_version',
  'package_template',
])

/**
 * Empties the package family, templates included, as the OWNER.
 *
 * Templates are in the set because the suites that seed their own templates must leave none behind: 0078 pins
 * a sale to its template version with `on delete restrict`, so a template that outlives its sales is a row the
 * next run cannot remove and cannot reuse.
 */
export async function truncatePackageFamily(sql: Sql): Promise<void> {
  await sql.unsafe(`truncate ${PACKAGE_FAMILY_TABLES.join(', ')}`)
}

/**
 * The credit-note family, and why it is separate from the invoice one.
 *
 * `credit_note` carries NO foreign key to `invoice` — 0072's header says why: a credit note names the document
 * it corrects by its display number, not by its id, because the two are independently numbered statements and
 * a key would make one deletable only with the other. So the two closures touch in exactly one table,
 * `refund`, which references `invoice` AND `credit_note` (the reference 0068 deferred and 0072 added).
 *
 * That is why this list is stated apart and then UNIONED below rather than merged by hand: a suite that writes
 * credit notes writes invoices too, and the statement it needs is both closures at once.
 */
export const CREDIT_NOTE_FAMILY_TABLES: readonly string[] = Object.freeze([
  'credit_note_line',
  'credit_note',
  'refund',
])

/**
 * What a suite that writes both documents empties: the two closures above, each table once.
 *
 * Five suites carried the same nine-table statement character for character and all five missed
 * `commission_line` when P-HR-11 pointed it at `invoice`; each then failed in `beforeEach` with `cannot
 * truncate a table referenced in a foreign key constraint`, a sentence about PostgreSQL and not about the
 * thing under test. This is the fifth statement of the list becoming the only one.
 *
 * ## Why it is written out and not spread from the two arrays above
 *
 * It was `[...CREDIT_NOTE_FAMILY_TABLES, ...INVOICE_FAMILY_TABLES.filter(…)]` first, which is shorter and
 * obviously correct — and it made the statement UNREADABLE to `suite-table-ownership.ts`, which resolves a
 * `truncate ${LIST.join(', ')}` by reading frozen string literals in the same module. A computed list gives
 * it `<unresolved-list>`: the one statement five suites share would have been the one statement nothing
 * could check the scope of, which is worse than five checkable copies (ADR 0002). So the names are literals
 * here, and `invoice-family.itest.ts` holds this array equal to the UNION of the two closures it derives
 * from `pg_constraint` — the derivation is in the check, where a derivation belongs, and the statement stays
 * something a scanner can read.
 *
 * `refund` is in both closures and is named ONCE: PostgreSQL refuses a truncate that names a table twice.
 */
export const DOCUMENT_FAMILY_TABLES: readonly string[] = Object.freeze([
  'credit_note_line',
  'credit_note',
  'refund',
  'checkout_finalisation',
  'payment',
  'commission_line',
  'invoice_appointment',
  'invoice_line',
  'invoice',
])

/** Empties both document closures as the OWNER, for a suite that writes invoices and credit notes. */
export async function truncateDocumentFamily(sql: Sql): Promise<void> {
  await sql.unsafe(`truncate ${DOCUMENT_FAMILY_TABLES.join(', ')}`)
}

/**
 * The cash family, and the table that broke four more teardowns the same way.
 *
 * Four suites each wrote out the same three cash tables. P-HR-12's `employee_tip` then took a foreign key to
 * `cash_session`, because a tip declared at the till is counted in the drawer it was declared at and paid
 * through payroll, and every one of those statements became illegal at once.
 *
 * The cost of that one key was not four teardowns. One of the four threw in its `afterAll` three lines before
 * the statement that removed the probe service it had published, so the probe survived the run — and the next
 * fixture loader to publish a catalogue was refused by `service_publish_without_compat_row` on a row it had
 * never heard of. Eighteen files failed for one line in a nineteenth, and not one of the eighteen messages
 * mentioned a drawer.
 *
 * A truncate is forced here rather than chosen, exactly as it is for the invoice family: a closed
 * `cash_session` refuses DELETE for every role including the owner, so a counted drawer cannot be removed a
 * row at a time.
 */
export const CASH_FAMILY_TABLES: readonly string[] = Object.freeze([
  'cash_session_adjustment',
  'cash_drop',
  'employee_tip',
  'cash_session',
])

/** Empties the cash family as the OWNER, drawer counts and declared tips included. */
export async function truncateCashFamily(sql: Sql): Promise<void> {
  await sql.unsafe(`truncate ${CASH_FAMILY_TABLES.join(', ')}`)
}

/**
 * The commission family, and the fourth table one migration broke.
 *
 * The commission suite wrote out sixteen tables in one statement: its own four, and then the whole invoice and
 * package families, because `commission_line` references `invoice` and `package_redemption`.
 *
 * P-HR-12's `payslip` then took a foreign key to `commission_run` — a payslip discharges the commission a run
 * computed — and all twenty-two of that suite's cases went to SKIPPED. That is how a `beforeAll` failure
 * presents, and it is the least visible of the four ways this one list has now broken: a skipped case reports
 * neither a pass nor a failure, and a run that skips a whole file still exits green in a summary somebody
 * scrolls past.
 *
 * Emptied as its own statement rather than merged into the other two: nothing outside this closure references
 * any of the five, so `truncate` over them is legal alone, and the invoice statement that follows may then
 * name an already-empty `commission_line` — TRUNCATE is idempotent over an empty table. Three legal statements
 * in a row beat one hand-merged union that no derivation checks.
 */
export const COMMISSION_FAMILY_TABLES: readonly string[] = Object.freeze([
  'payslip',
  'commission_line',
  'commission_run',
  'commission_rule_band',
  'commission_rule',
])

/** Empties the commission family as the OWNER, the payslips that discharge a run included. */
export async function truncateCommissionFamily(sql: Sql): Promise<void> {
  await sql.unsafe(`truncate ${COMMISSION_FAMILY_TABLES.join(', ')}`)
}
