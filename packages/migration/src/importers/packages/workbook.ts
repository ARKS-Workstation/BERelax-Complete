import { AppError } from '@berelax/shared'
import type { StagedSourceRow } from '../../framework.ts'

/**
 * The reconstruction workbook: its columns, the file a person is handed, and the parser that reads one back.
 *
 * ## Why there is a workbook at all
 *
 * H-MIG-02's own summary states the constraint: **there is no incumbent export.** Every other migration in
 * this build can, at worst, be re-run against a source system; outstanding packages cannot, because no system
 * holds them. A package sold before this software existed is a promise recorded on a card in a drawer, in a
 * WhatsApp thread, or in nobody's records at all — so the source of every figure here is a human filling in a
 * form, and the form is therefore the schema. There is nothing behind it to re-derive a figure from and
 * nothing to reconcile it against, which is why this module is as strict as it is and why the validator
 * beside it refuses a whole file rather than a row.
 *
 * ## The one statement of the columns, and what each one is for
 *
 * {@link WORKBOOK_COLUMNS} is the only place the columns are named. The generator writes the header from it,
 * the parser reads the header back and REFUSES a file whose header disagrees, and the preamble's per-column
 * hints come from the same array — so a column that is renamed is renamed in the file, in the parser and in
 * the instructions at once. The alternative, a header literal in the generator and a list of expected names
 * in the parser, is the second statement of a fact this repository keeps paying for: the two would agree
 * until the day a column moved, and the symptom would be a workbook that parses into the wrong cells rather
 * than an error.
 *
 * ## Why the generated file carries no timestamp, no run id and no serial number
 *
 * {@link buildPackageWorkbook} is a pure function of the templates and the policy terms it is handed, so
 * generating the workbook twice from an unchanged database produces the SAME BYTES. That is not tidiness. The
 * identity of a source file in this build is the sha-256 of its bytes (`import_run.source_file_hash`,
 * H-MIG-01), H-MIG-03's owner sign-off attests to that hash, and a generator that stamped the time would give
 * every regeneration a different identity — so a person who regenerated the blank workbook before filling it
 * in would hold a file that no sign-off could be about. The cost is that the file does not say when it was
 * produced; the run row does, which is the place that can say it once.
 *
 * ## The preamble is `#` lines, and the parser ignores them
 *
 * A spreadsheet is what this file will be opened in, so the instructions have to survive being opened and
 * re-saved. Lines beginning `#` do: they arrive back as a single-cell row, and the parser drops them. That
 * lets every instruction a person needs — the evidence a balance has to carry, the terms that are still
 * assumptions, the list of templates a row may name — travel WITH the file rather than in an email beside it,
 * which is the copy that gets lost.
 */

/** One column of the workbook, and the sentence that tells a person what to type in it. */
export interface WorkbookColumn {
  /** The cell in the header row. Lower snake case, because a spreadsheet header is not a label. */
  readonly name: string
  /** Printed in the preamble, one line per column. */
  readonly hint: string
}

/**
 * The columns, in order. The ONE statement of the workbook's shape.
 *
 * Two of them exist only so the file can be caught disagreeing with itself, and they are the reason the
 * shape is what it is:
 *
 *   - `sessions_remaining` is arithmetic the validator could do — total minus used — and asking for it anyway
 *     turns a mistyped digit into a refusal instead of into a liability. A reconstructed balance has no
 *     second source, so the only contradiction available is one inside the row, and a form that does not ask
 *     for one cannot find any.
 *   - `expires_on` is asked for rather than derived from the template's validity, because the validity was
 *     provisional when the package was sold and may not have been six months. Deriving it would silently
 *     restate a term the customer agreed to; asking for it makes the person filling the form say what the
 *     card in the drawer actually says.
 *
 * There is deliberately NO check that the price paid matches the template's price and NO check that the
 * expiry matches the purchase date plus the template's validity. Both would refuse real liabilities: a
 * package may have been sold at a discount nobody recorded and under terms this build has never seen. What
 * the price has to reconcile to is cash actually received, which is H-MIG-03's acceptance and needs the whole
 * file rather than a row.
 */
export const WORKBOOK_COLUMNS: readonly WorkbookColumn[] = Object.freeze([
  Object.freeze({
    name: 'holder_phone_e164',
    hint:
      'Who holds the package, in E.164 (+971…). A phone number and never a name: the customer record is ' +
      'keyed on the number (ADR 0014) and a name cannot be matched to one. Normalising a number that is ' +
      'not already E.164 is H-MIG-04’s, so this column refuses anything else rather than guessing.',
  }),
  Object.freeze({
    name: 'template_key',
    hint:
      'Which package, by template_key, from the list above. A key that names no package_template is ' +
      'refused: the template is what holds the terms, and a balance with no terms is a number.',
  }),
  Object.freeze({
    name: 'purchase_date',
    hint: 'YYYY-MM-DD, the day the customer paid.',
  }),
  Object.freeze({
    name: 'price_paid_fils',
    hint:
      'What was actually paid, VAT-inclusive, in integer fils (ADR 0007): 1,500.00 AED is 150000. Not the ' +
      'template price — what this customer handed over, including any discount nobody recorded.',
  }),
  Object.freeze({
    name: 'sessions_total',
    hint: 'How many sessions the package was sold with.',
  }),
  Object.freeze({
    name: 'sessions_used',
    hint: 'How many have been taken already.',
  }),
  Object.freeze({
    name: 'sessions_remaining',
    hint:
      'How many are left. This must equal sessions_total minus sessions_used — it is asked for twice on ' +
      'purpose, because a reconstructed balance has no second source and a row disagreeing with itself is ' +
      'the only mistake this file can catch.',
  }),
  Object.freeze({
    name: 'expires_on',
    hint:
      'YYYY-MM-DD, the day the balance runs out, as the customer’s own copy states it. Not derived from ' +
      'the template: the validity was an assumption when this was sold.',
  }),
  Object.freeze({
    name: 'evidence_kind',
    hint: 'What the balance rests on. One of the kinds listed above, and nothing else.',
  }),
  Object.freeze({
    name: 'evidence_reference',
    hint:
      'Where that evidence is, in enough words to find it again: a receipt number, the date of the ' +
      'WhatsApp message, the drawer the card is in. Required for every kind including owner_attestation, ' +
      'where it is what the owner actually recalls.',
  }),
  Object.freeze({
    name: 'owner_signed_off',
    hint:
      'yes, once the owner has read this row and accepted the balance as a liability of the business. ' +
      'Per ROW and not once per file: the file-level sign-off H-MIG-03 stores is about the whole ' +
      'reconstruction, and a row nobody looked at individually is how a wrong balance gets signed for.',
  }),
  Object.freeze({
    name: 'notes',
    hint: 'Anything a person reading this row in two years would want to know. Optional.',
  }),
])

/** The header row the generator writes and the parser demands, tab separated. */
export const WORKBOOK_HEADER: string = WORKBOOK_COLUMNS.map((column) => column.name).join('\t')

/**
 * What a reconstructed balance may rest on.
 *
 * A closed set, because "evidence" as free text is a column that fills up with the word `yes`. Every kind
 * below is a thing a person can go and look at — except the last, which is the one that matters most.
 *
 * `owner_attestation` is ACCEPTED and not refused, and that is the decision in this list. Y9-package-thin's
 * provisional answer is "honour once on evidence, logged": a package with a thin paper trail is still money
 * the business took, and refusing it would leave a real liability off the balance sheet and a customer
 * turned away at the desk — which is a worse failure than recording one whose support is a recollection. So
 * the kind is admitted, it is COUNTED separately in the validator's report, and H-MIG-03 is what flags the
 * resulting balance on the customer record and in the liability report. The vocabulary makes the
 * distinction; it does not make the policy.
 */
export const EVIDENCE_KINDS: readonly string[] = Object.freeze([
  'receipt',
  'card_terminal_slip',
  'whatsapp_message',
  'customer_copy',
  'owner_attestation',
])

/** The one value `owner_signed_off` accepts. Lower case, because a spreadsheet will offer `Yes`. */
export const OWNER_SIGN_OFF_VALUE = 'yes'

/** A template a workbook row may name, as the workbook's reference block prints it. */
export interface WorkbookTemplate {
  readonly templateKey: string
  /** From the template's current version: the sum of its lines' session counts. */
  readonly sessionCount: number
  /** The current version's price, integer fils. Printed so a person can see what is configured. */
  readonly priceFils: string
  /** The version's own display name, which may carry a placeholder marker. Printed as it stands. */
  readonly publicDisplayName: string
}

/** The three provisional package terms, as the workbook prints them on its face. */
export interface WorkbookTerms {
  readonly validityMonths: number
  readonly transferable: boolean
  readonly unredeemedBalancePolicy: string
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
}

/** One filled row, cell for cell. Strings, because a cell is what somebody typed. */
export interface PackageWorkbookRow {
  readonly holderPhoneE164: string
  readonly templateKey: string
  readonly purchaseDate: string
  readonly pricePaidFils: string
  readonly sessionsTotal: string
  readonly sessionsUsed: string
  readonly sessionsRemaining: string
  readonly expiresOn: string
  readonly evidenceKind: string
  readonly evidenceReference: string
  readonly ownerSignedOff: string
  readonly notes: string
}

/**
 * `holder_phone_e164` -> `holderPhoneE164`. Derived rather than written out beside the column list.
 *
 * A mapping table would be the third statement of the same twelve names, and its failure mode is the quiet
 * one: a payload key that no longer matches its column reads as an empty cell, so the row is refused for
 * being blank rather than for the rename that emptied it.
 */
const payloadKey = (column: string): string =>
  column.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase())

/** The payload keys, in column order. */
export const WORKBOOK_PAYLOAD_KEYS: readonly string[] = Object.freeze(
  WORKBOOK_COLUMNS.map((column) => payloadKey(column.name)),
)

const CELL_FORBIDS = /[\t\r\n]/

/** The cells of one row, in column order, derived from the payload keys so no order is written twice. */
function workbookRowCells(row: PackageWorkbookRow): readonly string[] {
  const record = row as unknown as Record<string, string>
  return WORKBOOK_PAYLOAD_KEYS.map((key) => record[key] ?? '')
}

/**
 * One row as a line of the file.
 *
 * Throws on a cell containing a tab or a newline rather than quoting it. A quoted TSV is a second dialect to
 * agree on, and the cells here are a phone number, a key, two dates, four integers, a vocabulary word and
 * two free-text fields — of which only the last two could ever hold a separator, and a note with a tab in it
 * is a note somebody pasted a table into.
 */
export function renderWorkbookRow(row: PackageWorkbookRow): string {
  const cells = workbookRowCells(row)
  for (const [index, cell] of cells.entries()) {
    if (CELL_FORBIDS.test(cell)) {
      throw new AppError(
        'validation',
        `The ${WORKBOOK_COLUMNS[index]?.name ?? 'unknown'} cell contains a tab or a newline. The workbook ` +
          'is tab separated and unquoted, so a cell carrying a separator would shift every later column of ' +
          'that row into the wrong field — which parses, and is then a different liability.',
        { details: { column: WORKBOOK_COLUMNS[index]?.name } },
      )
    }
  }
  return cells.join('\t')
}

const comment = (text: string): string => (text.length === 0 ? '#' : `# ${text}`)

/** Wraps a hint onto `#` lines at a width a person can read in a text editor. */
function commentParagraph(text: string, indent = '  '): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`
    if (candidate.length > 108) {
      lines.push(comment(`${indent}${current}`))
      current = word
      continue
    }
    current = candidate
  }
  if (current.length > 0) lines.push(comment(`${indent}${current}`))
  return lines
}

/**
 * The blank workbook: a preamble, the header, and no data rows.
 *
 * Pure, and pure on purpose — see the module note on why the file carries no timestamp. `templates` is what
 * the database holds, so a workbook generated against a database with no package templates has an EMPTY
 * reference block and says so in words, which is the honest output: no package can be reconstructed before
 * the template that holds its terms exists, and a generator that invented a key to put in the list would be
 * inventing the product.
 */
export function buildPackageWorkbook(options: {
  readonly templates: readonly WorkbookTemplate[]
  readonly terms: WorkbookTerms
}): string {
  const { templates, terms } = options
  const lines: string[] = [
    comment('BE RELAX — outstanding package reconstruction workbook'),
    comment(''),
    comment(
      'There is no incumbent system to export these from. Every row below is a liability of the business',
    ),
    comment(
      'reconstructed by hand, so this file IS the evidence: it is hashed, the hash is what the owner signs',
    ),
    comment(
      'off against, and every imported balance resolves back to its line in it. Generated by',
    ),
    comment('scripts/gen-package-workbook.mjs (H-MIG-02, open question Y8-packages).'),
    comment(''),
    comment('HOW IT IS READ'),
    comment(''),
    ...commentParagraph(
      'Lines starting with # are ignored. The first line that does not is the header, and it must be left ' +
        'exactly as generated — a header that has been edited is refused, because a renamed or reordered ' +
        'column parses into the wrong field rather than failing.',
    ),
    ...commentParagraph(
      'The file is validated as a WHOLE. If any row is rejected, nothing is imported and the report names ' +
        'every rejected line so the file can be corrected in one pass. A half-imported set of package ' +
        'balances is worse than none: it is a deferred-revenue figure nobody can reconcile.',
    ),
    ...commentParagraph(
      'Do not invent a figure. A cell nobody can answer is left blank and the row is refused, which is ' +
        'visible; a plausible number is indistinguishable from a true one once it is in the ledger.',
    ),
    comment(''),
    comment('THE TERMS THESE PACKAGES ARE ASSUMED TO CARRY'),
    comment(''),
    ...commentParagraph(
      `validity ${String(terms.validityMonths)} months; ` +
        `${terms.transferable ? 'transferable' : 'non-transferable'}; ` +
        `unredeemed balance ${terms.unredeemedBalancePolicy}.`,
    ),
    ...commentParagraph(
      terms.isProvisional
        ? `NONE OF THE THREE IS CONFIRMED (${terms.openQuestionId ?? 'open question unrecorded'}). They ` +
            'are this build’s assumptions, they appear on the Unconfirmed Assumptions panel, and they ' +
            'are the DEFAULT a new template is created with — not what any package below was sold under. ' +
            'Each row states its own expiry and session count for exactly that reason.'
        : 'All three are confirmed settings. They remain the default a new template is created with, not ' +
            'what any package below was sold under; each row states its own expiry and session count.',
    ),
    comment(''),
    comment('WHAT A BALANCE MAY REST ON (evidence_kind)'),
    comment(''),
    ...EVIDENCE_KINDS.flatMap((kind) => commentParagraph(kind)),
    ...commentParagraph(
      'owner_attestation means there is no document at all and the owner accepts the balance from memory. ' +
        'It is allowed — a package with a thin paper trail is still money the business took — and it is ' +
        'counted separately in the report and flagged on the customer record. Use it only when it is true.',
    ),
    comment(''),
    comment('PACKAGES A ROW MAY NAME (template_key)'),
    comment(''),
    ...(templates.length === 0
      ? commentParagraph(
          'NONE. This database holds no package template with a version, so no row here can be imported ' +
            'yet. Configure the packages the business sells first; the terms live on the template and a ' +
            'balance with no terms is a number.',
        )
      : templates.flatMap((template) =>
          commentParagraph(
            `${template.templateKey}  —  ${String(template.sessionCount)} session(s), ` +
              `${template.priceFils} fils configured  —  ${template.publicDisplayName}`,
          ),
        )),
    comment(''),
    comment('THE COLUMNS'),
    comment(''),
    ...WORKBOOK_COLUMNS.flatMap((column) => [
      comment(`  ${column.name}`),
      ...commentParagraph(column.hint, '      '),
    ]),
    comment(''),
    WORKBOOK_HEADER,
  ]
  return `${lines.join('\n')}\n`
}

/** Appends filled rows to a generated workbook. The round-trip acceptance line is this plus the parser. */
export function fillPackageWorkbook(workbook: string, rows: readonly PackageWorkbookRow[]): string {
  const body = rows.map((row) => renderWorkbookRow(row)).join('\n')
  return rows.length === 0 ? workbook : `${workbook}${body}\n`
}

/**
 * Reads a workbook back into staged rows, and refuses a file whose header is not the generated one.
 *
 * ## Lenient about CELLS, strict about the HEADER
 *
 * A malformed cell must still become a STAGED row, exactly as the framework's conformance importer is
 * lenient: the report has to be able to name the bad row by line number, and staging before judging is what
 * lets one pass over the file name every problem at once. Judging is the validator's.
 *
 * The header is the opposite, and the asymmetry is the point. A bad cell is a fact about one row; a bad
 * header is a fact about the whole file, and its failure mode is not an error — a reordered header parses
 * every row into the wrong columns, so `sessions_used` reads a price and the file validates or does not for
 * reasons that have nothing to do with what anybody typed. That cannot be reported per row, so it is refused
 * before a run is opened at all.
 *
 * `line_number` is the line in the FILE, preamble included, because it is the number a person opens the
 * spreadsheet at.
 */
export function parsePackageWorkbook(sourceText: string): readonly StagedSourceRow[] {
  const lines = sourceText.split('\n')
  let headerAt = -1
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('#') || line.trim().length === 0) continue
    headerAt = index
    break
  }
  if (headerAt === -1) {
    throw new AppError(
      'validation',
      'The workbook has no header row. Every line is a comment or blank, which is a generated workbook ' +
        'nobody filled in — refused rather than imported as an import of nothing, because a run that ' +
        'applied zero rows and completed would make the next run of the filled file look like a re-import.',
    )
  }
  const header = lines[headerAt] ?? ''
  if (header.replace(/\r$/, '') !== WORKBOOK_HEADER) {
    const found = header.replace(/\r$/, '').split('\t')
    const expected = WORKBOOK_COLUMNS.map((column) => column.name)
    const missing = expected.filter((name) => !found.includes(name))
    const extra = found.filter((name) => !expected.includes(name))
    throw new AppError(
      'validation',
      `The workbook header on line ${headerAt + 1} is not the generated one, so every row would parse ` +
        'into the wrong columns rather than failing. ' +
        `Missing: ${missing.length === 0 ? 'none' : missing.join(', ')}. ` +
        `Unexpected: ${extra.length === 0 ? 'none' : extra.join(', ')}. ` +
        `Expected, in this order: ${expected.join(', ')}. Regenerate the blank workbook with ` +
        'scripts/gen-package-workbook.mjs and paste the rows into it.',
      { details: { line: headerAt + 1, missing, extra } },
    )
  }

  const rows: StagedSourceRow[] = []
  for (const [index, raw] of lines.entries()) {
    if (index <= headerAt) continue
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('#') || line.trim().length === 0) continue
    const cells = line.split('\t')
    const payload: Record<string, string> = {}
    for (const [column, key] of WORKBOOK_PAYLOAD_KEYS.entries()) {
      payload[key] = (cells[column] ?? '').trim()
    }
    rows.push({ lineNumber: index + 1, payload })
  }
  return rows
}
