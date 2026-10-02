import { AppError } from '@berelax/shared'

/**
 * The reconstructed staff file: its ten columns, the file a person is handed, and the reader for one.
 *
 * ADR 0065 — where there is no system to export from, the WORKBOOK is the schema. The columns are stated
 * once in {@link STAFF_COLUMNS}; the generator writes the header from that list, the parser demands it
 * back, and the per-column instructions on the file's face come from the same entries.
 *
 * ## What is NOT a column, and each absence is a decision
 *
 *   - **no name.** `employee.display_name` is NULL until an admin enters one and
 *     `employee.is_publishable` is GENERATED from it together with a recorded photography consent
 *     (decision 23, ADR 0020). A name typed into a staff file would be published by the first person who
 *     set the consent, so the file names people by their STAFF REFERENCE.
 *   - **no bank account, Emirates ID number, passport number or visa number.** The staging ledger keeps
 *     `import_row.payload` for ever and no erasure reaches it (ADR 0072, Y9-import-ledger), so an IBAN in
 *     this file is an IBAN in that ledger permanently — strictly worse than the plaintext column
 *     `employee_bank_detail` was built to avoid, because that column does not exist and this one could
 *     not be removed afterwards. Those fields are entered through the HR screens, which seal them, and
 *     `employee_document_identity_number_is_encrypted` refuses a plaintext identity reference outright.
 *     What this file DOES carry about a credential is its type and its expiry, which is the half that
 *     gates availability; a document number is not in that path at all.
 *   - **no wage, no allowance and no contract type.** `employee.basic_wage_fils` is NULL for every
 *     employment record and `Y8-staff` and `Y8-wps` are the open questions. A figure here would be a wage
 *     somebody is paid against, and brief rule 15 is sharpest where the consequence is a payment.
 *   - **no issuing authority.** Nothing in the handover names the authority that issued any credential
 *     and `employee_document_issuing_authority_not_placeholder` refuses a marker, so the honest value is
 *     the absent one.
 *
 * ## Three multi-valued cells, and one convention for all three
 *
 * `style_skills`, `languages` and `credential_expiries` each hold several values, separated by `;`. One
 * convention rather than three, stated once in {@link SEPARATOR} and explained once in the preamble: a
 * file with three separator rules is a file whose second rule is the one that gets typed wrongly. A
 * credential pair is `type=YYYY-MM-DD`, which is the only place a second separator appears, and it
 * appears because the pair is genuinely two things.
 *
 * A second FILE — one line per credential — was the alternative and is worse here. The owner holds one
 * row per person, so a per-credential file means re-keying the staff reference on every line, and a
 * reference mistyped on one of six lines attaches a lapse date to somebody else.
 *
 * ## The preamble is `#` lines, and the generated file is the same bytes every time
 *
 * H-MIG-02's reason for the first (a spreadsheet is what this file will be opened in, so the
 * instructions have to survive being re-saved) and H-MIG-01's for the second (the identity of a source
 * file is the sha-256 of its bytes, so a generator that stamped the time would give every regeneration a
 * different identity).
 */

/** One column of the staff file, and the sentence that tells a person what to put in it. */
export interface StaffColumn {
  /** The cell in the header row. Lower snake case, because a spreadsheet header is not a label. */
  readonly name: string
  /** Printed in the preamble, one paragraph per column. */
  readonly hint: string
}

/** The one separator for every multi-valued cell in this file. */
export const SEPARATOR = ';'

/** The genders `employee.gender` admits. A blank cell is QUARANTINED and never defaulted. */
export const STAFF_GENDERS: readonly string[] = Object.freeze(['female', 'male'])

/** The style skills `therapist_skill` admits. */
export const STAFF_SKILLS: readonly string[] = Object.freeze(['asian_style', 'arabic_style'])

/** The languages `staff_language` admits. */
export const STAFF_LANGUAGES: readonly string[] = Object.freeze(['english', 'arabic'])

/** The columns, in order. The ONE statement of this file's shape. */
export const STAFF_COLUMNS: readonly StaffColumn[] = Object.freeze([
  Object.freeze({
    name: 'staff_reference',
    hint:
      'The reference this person is known by internally — a payroll number, a badge number, whatever ' +
      'the old records used. NOT their name: a name is entered by an admin in the backend and a ' +
      'therapist page publishes only once a name AND a recorded photography consent both exist, so a ' +
      'name typed here would be published by the first person who sets the consent. A reference ' +
      'somebody already holds is quarantined rather than merged.',
  }),
  Object.freeze({
    name: 'gender',
    hint:
      'female or male. LEAVE IT BLANK IF YOU DO NOT KNOW: a blank is quarantined with that reason and ' +
      'nothing is guessed. This is not a formality — a customer may ask for a female therapist, the ' +
      'booking rules enforce it, and a guessed value decides who may treat whom. It is the one cell in ' +
      'this file where a wrong answer is worse than no answer.',
  }),
  Object.freeze({
    name: 'employed_from',
    hint:
      'The date this person started, as YYYY-MM-DD. It anchors the leave year and the probation period, ' +
      'so it is the date on the contract and not the date they first appeared on a rota.',
  }),
  Object.freeze({
    name: 'employed_until',
    hint:
      'The date employment ended, as YYYY-MM-DD, or BLANK for somebody still employed. Blank is the ' +
      'ordinary case. A date here does not delete anything: the person keeps their history, which is ' +
      'why this is a date and not a removal.',
  }),
  Object.freeze({
    name: 'style_skills',
    hint:
      'Which styles this therapist gives, from asian_style and arabic_style, separated by a semicolon ' +
      '— asian_style;arabic_style for somebody who gives both. A therapist with no style here can be ' +
      'assigned to no treatment at all, which is loud rather than silent, so leave it blank only if ' +
      'that is true.',
  }),
  Object.freeze({
    name: 'languages',
    hint:
      'Which of english and arabic this person speaks, separated by a semicolon. It is used to match a ' +
      'customer who asks, and nothing else; a blank costs nothing but the match.',
  }),
  Object.freeze({
    name: 'credential_expiries',
    hint:
      'The credentials this person holds and when each LAPSES, as type=YYYY-MM-DD pairs separated by a ' +
      'semicolon: labour_card=2027-03-31;emirates_id=2028-01-15. Only the type and the date — do NOT ' +
      'put a document number, an IBAN or an identity number anywhere in this file, because the import ' +
      'ledger keeps every line for ever and nothing can erase it; those are entered in the backend, ' +
      'where they are encrypted. An expiry already in the past is imported as it stands and that ' +
      'therapist stops being bookable immediately, which is the correct behaviour and not a mistake. A ' +
      'type this system does not know is quarantined.',
  }),
  Object.freeze({
    name: 'leave_opening_day_hundredths',
    hint:
      'The annual-leave balance this person brought with them, in HUNDREDTHS of a day: 250 is two and a ' +
      'half days, 1400 is fourteen days. Whole numbers only, because that is the unit the whole leave ' +
      'ledger is in and a decimal point in a spreadsheet cell is how a figure comes to be a hundred ' +
      'times too small. A zero is accepted and recorded as PROVISIONAL rather than as an answer — the ' +
      'accrual engine needs a real opening balance, and a zero reads as somebody who has already taken ' +
      'all their leave.',
  }),
  Object.freeze({
    name: 'leave_opening_basis',
    hint:
      'trading_session_day, once you have checked that every day of that balance is a day this ' +
      'business opens. Trading runs 11:00 to 02:00, so a working day here crosses midnight, and a leave ' +
      'day covers its whole session — a balance counted in calendar days is quarantined with that ' +
      'reason rather than converted, because converting it would be this system deciding how much leave ' +
      'somebody is owed. Put calendar_day if that is what the old figure counted; the line is then ' +
      'quarantined and the claim is on the record, which is better than a figure nobody can defend.',
  }),
  Object.freeze({
    name: 'leave_balance_as_at',
    hint:
      'The date that balance was measured, as YYYY-MM-DD. Usually the day before this system goes live. ' +
      'It is what the balance is filed on, and the leave year it falls in is what accrual then runs ' +
      'forward from.',
  }),
])

/** The header row the generator writes and the parser demands, tab separated. */
export const STAFF_HEADER: string = STAFF_COLUMNS.map((column) => column.name).join('\t')

/** One line of the file, as read, before anything is validated. */
export interface StaffCell {
  /** 1-based, and it is the line in the FILE — the number a person opens the spreadsheet at. */
  readonly lineNumber: number
  readonly staffReference: string
  readonly gender: string
  readonly employedFrom: string
  readonly employedUntil: string
  readonly styleSkills: readonly string[]
  readonly languages: readonly string[]
  /** `type=YYYY-MM-DD` pairs, as typed. Parsed into a pair by `./import.ts`, never here. */
  readonly credentialExpiries: readonly string[]
  readonly leaveOpeningDayHundredths: string
  readonly leaveOpeningBasis: string
  readonly leaveBalanceAsAt: string
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

/** The blank staff file: a preamble, the header, and no data rows. Pure, and pure on purpose. */
export function buildStaffWorkbook(): string {
  const lines: string[] = [
    comment('BE RELAX — reconstructed staff file'),
    comment(''),
    comment('One person per line, tab separated, under the header row below. Lines beginning with'),
    comment('# are ignored, so these instructions can stay in the file.'),
    comment(''),
    comment('WHAT MUST NOT GO IN THIS FILE, which is the most important instruction here:'),
    ...commentParagraph(
      'No bank account or IBAN. No Emirates ID number, passport number or visa number. No wage. The ' +
        'import keeps a copy of every line for ever, as the evidence of what was imported, and nothing ' +
        'can erase a line from it — so a number written here is a number that stays. Those fields are ' +
        'entered in the backend, where they are encrypted and where only the roles that need them can ' +
        'read them. This file carries which credentials somebody holds and when each lapses, which is ' +
        'the part that decides whether they can be booked.',
    ),
    comment(''),
    comment('MULTI-VALUED CELLS:'),
    ...commentParagraph(
      `Three cells hold more than one value and all three use a semicolon (${SEPARATOR}) between them. ` +
        'A credential is a pair, type=YYYY-MM-DD, which is the only place a second separator appears.',
    ),
    comment(''),
    comment('WHAT IT DOES WITH A LINE IT CANNOT ACCEPT:'),
    ...commentParagraph(
      'The line is QUARANTINED with the reason and nothing about that person is imported. Nothing is ' +
        'inferred — no guessed gender, no converted leave balance, no substituted credential. The ' +
        'quarantined lines are listed by file and line number in the import report. A line whose own ' +
        'text is wrong is different: the whole file is refused and nothing at all is imported, so one ' +
        'pass over the report corrects every bad line.',
    ),
    comment(''),
    comment('THE COLUMNS:'),
  ]
  for (const column of STAFF_COLUMNS) {
    lines.push(comment(`${column.name}`), ...commentParagraph(column.hint))
  }
  lines.push(comment(''), STAFF_HEADER, '')
  return lines.join('\n')
}

/** `gender` -> index. Derived, so the column order is written once. */
const COLUMN_AT = new Map(STAFF_COLUMNS.map((column, index) => [column.name, index]))

/** A line the parser skips wherever it appears: an instruction, or a spacer in a spreadsheet. */
const isSkippable = (line: string): boolean => line.startsWith('#') || line.trim().length === 0

/** The index of the header row, having checked that it IS the generated header. */
function headerLineAt(lines: readonly string[]): number {
  const headerAt = lines.findIndex((line) => !isSkippable(line))
  if (headerAt === -1) {
    throw new AppError(
      'validation',
      'The staff file has no header row. Every line is a comment or blank, which is a generated file ' +
        'nobody filled in — refused rather than imported as an import of nothing, because a run that ' +
        'applied zero rows and completed would make the next run of the filled file look like a ' +
        're-import.',
    )
  }
  const header = (lines[headerAt] ?? '').replace(/\r$/, '')
  if (header === STAFF_HEADER) return headerAt

  const found = header.split('\t')
  const expected = STAFF_COLUMNS.map((column) => column.name)
  const missing = expected.filter((name) => !found.includes(name))
  const extra = found.filter((name) => !expected.includes(name))
  throw new AppError(
    'validation',
    `The staff file header on line ${headerAt + 1} is not the generated one, so every row would parse ` +
      'into the wrong columns rather than failing. ' +
      `Missing: ${missing.length === 0 ? 'none' : missing.join(', ')}. ` +
      `Unexpected: ${extra.length === 0 ? 'none' : extra.join(', ')}. ` +
      `Expected, in this order: ${expected.join(', ')}. Regenerate the blank file with ` +
      'scripts/migrate-staff.mjs --template and paste the rows into it.',
    { details: { line: headerAt + 1, missing, extra } },
  )
}

const at = (columns: readonly string[], name: string): string =>
  (columns[COLUMN_AT.get(name) ?? -1] ?? '').trim()

/** A multi-valued cell, split and tidied. An empty cell is an empty list and never `['']`. */
const many = (cell: string): readonly string[] =>
  cell
    .split(SEPARATOR)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

/**
 * Reads a filled staff file, header checked, comments and blank lines dropped.
 *
 * It returns the cells as typed and nothing else. Every verdict is `./import.ts`'s, so there is one place
 * a reason is named and one place a reason is asserted by name.
 */
export function parseStaffWorkbook(sourceText: string): readonly StaffCell[] {
  const lines = sourceText.split('\n')
  const headerAt = headerLineAt(lines)

  const cells: StaffCell[] = []
  for (const [index, raw] of lines.entries()) {
    if (index <= headerAt) continue
    const line = raw.replace(/\r$/, '')
    if (isSkippable(line)) continue
    const columns = line.split('\t')
    cells.push({
      lineNumber: index + 1,
      staffReference: at(columns, 'staff_reference'),
      gender: at(columns, 'gender').toLowerCase(),
      employedFrom: at(columns, 'employed_from'),
      employedUntil: at(columns, 'employed_until'),
      styleSkills: many(at(columns, 'style_skills').toLowerCase()),
      languages: many(at(columns, 'languages').toLowerCase()),
      credentialExpiries: many(at(columns, 'credential_expiries').toLowerCase()),
      leaveOpeningDayHundredths: at(columns, 'leave_opening_day_hundredths'),
      leaveOpeningBasis: at(columns, 'leave_opening_basis').toLowerCase(),
      leaveBalanceAsAt: at(columns, 'leave_balance_as_at'),
    })
  }
  return cells
}
