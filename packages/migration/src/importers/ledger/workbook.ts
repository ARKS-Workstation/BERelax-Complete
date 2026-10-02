import { AppError } from '@berelax/shared'

/**
 * The reconstructed opening trial balance: its four columns, the file a person is handed, and the reader.
 *
 * ADR 0065 — where there is no system to export from, the WORKBOOK is the schema. The columns are stated
 * once in {@link OPENING_COLUMNS}; the generator writes the header from that list, the parser demands it
 * back, and the per-column instructions on the file's face come from the same entries.
 *
 * ## Why `opening_date` is a column and not a directive
 *
 * It is one fact about the whole file, repeated on every line, and a file whose lines disagree about it
 * is REFUSED by name. The alternative — a `#` directive the parser reads — looks tidier and is worse in a
 * spreadsheet: a person sorting the rows, inserting one or copying the sheet loses a header line without
 * noticing, and the boundary is the single most consequential value in this import. A repeated column
 * survives every one of those operations, and the disagreement is a named refusal rather than a silent
 * default to whatever the first line said.
 *
 * ## Why there are four columns and not a balance column
 *
 * `debit_fils` and `credit_fils`, with exactly one of them non-zero, rather than one signed `balance`.
 * `journal_line_exactly_one_side` is the same decision in the database and `openingImbalanceFils` reads
 * the same shape: direction is expressed by the SIDE and never by the sign, so a minus typed into the
 * wrong column cannot quietly become a credit. It also means the two totals a person checks against
 * their own books are the two columns of the file.
 *
 * Whole fils, never dirhams and never a decimal. ADR 0007, and H-MIG-05 found what the alternative costs:
 * `Number('250.00')` is 250, an integer, so a cell written as dirhams-and-cents imports as a hundredth of
 * itself on a row that passes every check. {@link wholeFilsOrNaN} is the strict reader.
 *
 * ## What is NOT a column
 *
 *   - **no account name.** The chart holds it, and a name typed here that disagreed with the chart would
 *     be a second statement of what an account is. The code is the identity.
 *   - **no narrative per line.** `journal_line.memo` exists and is left null: a note typed against an
 *     opening figure is prose in an append-only ledger, and the attestation is the import row.
 *   - **no TRN and no legal name.** They are the `legal_entity` singleton's and are `Y1-trn`'s to answer;
 *     a file carrying either would be a second place a registered identity lives (brief rule 15).
 */

/** One column of the opening trial balance, and the sentence that tells a person what to put in it. */
export interface OpeningColumn {
  /** The cell in the header row. Lower snake case, because a spreadsheet header is not a label. */
  readonly name: string
  /** Printed in the preamble, one paragraph per column. */
  readonly hint: string
}

/** The columns, in order. The ONE statement of this file's shape. */
export const OPENING_COLUMNS: readonly OpeningColumn[] = Object.freeze([
  Object.freeze({
    name: 'opening_date',
    hint:
      'The date these books open, as YYYY-MM-DD — the same date on EVERY line, and a file whose lines ' +
      'disagree is refused. It is the most consequential value in this file: once it is imported, ' +
      'nothing may ever be dated before it, because the period behind it is what these figures ' +
      'summarise. A posting into that period would be counted twice and the books would still balance, ' +
      'which is why the database refuses it rather than warning about it.',
  }),
  Object.freeze({
    name: 'account_code',
    hint:
      'The four-digit account code, exactly as the chart of accounts holds it. A code the chart does ' +
      'not hold REFUSES THE WHOLE FILE rather than being skipped: a trial balance missing one account ' +
      'is not a trial balance with a gap, it is a different position that happens to balance. Each ' +
      'code appears once.',
  }),
  Object.freeze({
    name: 'debit_fils',
    hint:
      'The debit balance in whole FILS — so AED 40,000.00 is 4000000. Leave it 0 (or blank) for an ' +
      'account whose balance is a credit. Whole fils and never dirhams-and-cents: a decimal point here ' +
      'is how a figure comes to be a hundred times too small on a row that passes every other check.',
  }),
  Object.freeze({
    name: 'credit_fils',
    hint:
      'The credit balance in whole FILS. Exactly one of debit_fils and credit_fils is non-zero on each ' +
      'line — direction is the SIDE and never a minus sign, so a negative number typed in the wrong ' +
      'column cannot quietly become the other side. The two column totals are what you check against ' +
      'the books you are copying from, and the file is refused unless they are equal to the fils.',
  }),
])

/** The header row the generator writes and the parser demands, tab separated. */
export const OPENING_HEADER: string = OPENING_COLUMNS.map((column) => column.name).join('\t')

/** A four-digit account code, which is `account_code_check`'s own shape. */
export const ACCOUNT_CODE = /^[0-9]{4}$/

/** A date in `YYYY-MM-DD` that is also a real day. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * A cell that is a run of digits, or NaN. An empty cell is 0, which is the ordinary case for one side.
 *
 * NaN rather than a throw, so every cell-shaped refusal is named in one place. This is H-MIG-05's
 * `wholeOrNaN` with one difference stated rather than inherited: a blank is zero HERE, because a line
 * states one side and leaves the other empty, where in a visit history a blank price was a figure nobody
 * filled in. Importing it rather than sharing the function is the whole of that difference.
 */
export const wholeFilsOrNaN = (cell: string): number => {
  const trimmed = cell.trim()
  if (trimmed.length === 0) return 0
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
}

/** One line of the file, as read, before anything is validated. */
export interface OpeningCell {
  /** 1-based, and it is the line in the FILE — the number a person opens the spreadsheet at. */
  readonly lineNumber: number
  readonly openingDate: string
  readonly accountCode: string
  readonly debitFils: number
  readonly creditFils: number
}

const comment = (text: string): string => (text.length === 0 ? '#' : `# ${text}`)

/** Wraps a hint onto `#` lines at a width a person can read in a text editor. */
function commentParagraph(text: string, indent = '  '): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`
    if (candidate.length > 104) {
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
 * The blank opening trial balance: a preamble, the header, and no data rows.
 *
 * Pure, and pure on purpose: the identity of a source file in this build is the sha-256 of its bytes
 * (H-MIG-01), so a generator that stamped the time would give every regeneration a different identity.
 * It takes no arguments — in particular it does NOT print the chart of accounts into the file, although
 * it could. Printing it would invite somebody to file a balance against the nearest code on the list
 * rather than the one their own books use, and the codes are what the two sets of books agree on.
 */
export function buildOpeningWorkbook(): string {
  const lines: string[] = [
    comment('BE RELAX — opening trial balance'),
    comment(''),
    comment(
      'One account per line, tab separated, under the header row below. Lines beginning with',
    ),
    comment('# are ignored, so these instructions can stay in the file.'),
    comment(''),
    comment(
      'WHAT THIS FILE DOES, and it is the one import that cannot be corrected by re-running:',
    ),
    ...commentParagraph(
      'It is the position these books start from. Every balance sheet this system ever produces is ' +
        'this entry plus everything since, so a figure out by a dirham is a balance sheet out by a ' +
        'dirham for ever. Once it is imported, NOTHING may be dated before the opening date — not an ' +
        'invoice, not a payment, not a second opening balance — and a correction is a dated reversal ' +
        'plus a fresh import at a new date, never an edit.',
    ),
    comment(''),
    comment('WHAT IS ALREADY IN THE BOOKS, and must not be entered twice:'),
    ...commentParagraph(
      'The outstanding package liability, if it has been imported from the package workbook, is already ' +
        'posted at the opening date. State the FULL balance of each account here anyway — including it ' +
        '— and the import posts only the difference, so the figures in this file are the ones you can ' +
        'check against your own books. A figure SMALLER than what is already posted is refused by name ' +
        'rather than netted off: that is a disagreement about a liability somebody has already signed ' +
        'for, not a remainder.',
    ),
    comment(''),
    comment('WHAT IT DOES WITH A LINE IT CANNOT READ:'),
    ...commentParagraph(
      'It refuses the WHOLE FILE and imports nothing, naming every bad line at once. There is no ' +
        'quarantine here and that is deliberate: a trial balance with one line held back does not ' +
        'balance, so there is nothing to import.',
    ),
    comment(''),
    comment('THE COLUMNS:'),
  ]
  for (const column of OPENING_COLUMNS) {
    lines.push(comment(`${column.name}`), ...commentParagraph(column.hint))
  }
  lines.push(comment(''), OPENING_HEADER, '')
  return lines.join('\n')
}

/** `account_code` -> index. Derived, so the column order is written once. */
const COLUMN_AT = new Map(OPENING_COLUMNS.map((column, index) => [column.name, index]))

/** A line the parser skips wherever it appears: an instruction, or a spacer in a spreadsheet. */
const isSkippable = (line: string): boolean => line.startsWith('#') || line.trim().length === 0

/** The index of the header row, having checked that it IS the generated header. */
function headerLineAt(lines: readonly string[]): number {
  const headerAt = lines.findIndex((line) => !isSkippable(line))
  if (headerAt === -1) {
    throw new AppError(
      'validation',
      'The opening trial balance has no header row. Every line is a comment or blank, which is a ' +
        'generated file nobody filled in — refused rather than imported as an import of nothing.',
    )
  }
  const header = (lines[headerAt] ?? '').replace(/\r$/, '')
  if (header === OPENING_HEADER) return headerAt

  const found = header.split('\t')
  const expected = OPENING_COLUMNS.map((column) => column.name)
  const missing = expected.filter((name) => !found.includes(name))
  const extra = found.filter((name) => !expected.includes(name))
  throw new AppError(
    'validation',
    `The opening trial balance header on line ${headerAt + 1} is not the generated one, so every row ` +
      'would parse into the wrong columns rather than failing. ' +
      `Missing: ${missing.length === 0 ? 'none' : missing.join(', ')}. ` +
      `Unexpected: ${extra.length === 0 ? 'none' : extra.join(', ')}. ` +
      `Expected, in this order: ${expected.join(', ')}. Regenerate the blank file with ` +
      'scripts/migrate-opening-balances.mjs --template and paste the rows into it.',
    { details: { line: headerAt + 1, missing, extra } },
  )
}

const at = (columns: readonly string[], name: string): string =>
  (columns[COLUMN_AT.get(name) ?? -1] ?? '').trim()

/** Reads a filled opening trial balance, header checked, comments and blank lines dropped. */
export function parseOpeningWorkbook(sourceText: string): readonly OpeningCell[] {
  const lines = sourceText.split('\n')
  const headerAt = headerLineAt(lines)

  const cells: OpeningCell[] = []
  for (const [index, raw] of lines.entries()) {
    if (index <= headerAt) continue
    const line = raw.replace(/\r$/, '')
    if (isSkippable(line)) continue
    const columns = line.split('\t')
    cells.push({
      lineNumber: index + 1,
      openingDate: at(columns, 'opening_date'),
      accountCode: at(columns, 'account_code'),
      debitFils: wholeFilsOrNaN(at(columns, 'debit_fils')),
      creditFils: wholeFilsOrNaN(at(columns, 'credit_fils')),
    })
  }
  return cells
}
