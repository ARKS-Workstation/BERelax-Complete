import { AppError } from '@berelax/shared'

/**
 * The reconstructed visit history: its nine columns, the file a person is handed, and the reader for one.
 *
 * ADR 0065 — where there is no system to export from, the WORKBOOK is the schema. The columns are stated
 * once in {@link VISIT_COLUMNS}; the generator writes the header from that list, the parser demands it
 * back and refuses a file whose header is not the generated one, and the per-column instructions on the
 * file's face come from the same entries. The alternative — a header literal in the generator and a list
 * of expected names in the parser — is the second statement of a fact this repository keeps paying for:
 * the two agree until the day a column moves, and the symptom is a file that parses into the wrong cells
 * rather than an error.
 *
 * ## Why nine columns, and why one of them is redundant on purpose
 *
 * A visit has to name the person, when it started, when it finished, what the treatment was, who gave it,
 * where, how it ended and what was charged. That is eight facts. The ninth, `duration_minutes`, is
 * derivable from the other two instants — and it is asked for anyway, which is ADR 0065's own rule: *"a
 * row that contradicts ITSELF is refused: `sessions_remaining` is asked for although total minus used
 * would give it, because a reconstructed balance has no second source and this is the only cross-check
 * available."*
 *
 * The same argument holds exactly here, and it is the one decision in this importer that is not obvious.
 * A reconstructed visit has no second source either. Both instants come off the same handwritten diary
 * line, so a wrong date, a wrong hour or an AM/PM slip produces a perfectly importable row whose only
 * symptom is a therapist's utilisation being wrong on a day nobody can check any more. The duration is
 * the one number the person filling the file in knows WITHOUT reading the clock — a sixty-minute massage
 * is a sixty-minute massage — so making it a cell and refusing a row where the two disagree turns the
 * commonest typing error into a named rejection. It also identifies the `service_variant`, which is keyed
 * on the service and its duration, so the cell is load-bearing twice.
 *
 * ## What is deliberately NOT a column
 *
 *   - **no customer name.** ADR 0020: a label that could not be a name cannot be mistaken for one, and
 *     the person is identified by their number, which is their identity (ADR 0014).
 *   - **no therapist name.** `employee.staff_reference` is the column the file names them by. A display
 *     name is set by an admin and is nobody's to type into a history file (brief rule 15, decision 23).
 *   - **no VAT figure and no invoice number.** This system posts nothing for a supply made before its
 *     books opened (ADR 0069), so there is no tax figure on the row for anything to add up, and no
 *     document of this business's to reference.
 *   - **no notes.** Free prose about a person, staged into a ledger nothing can erase, is the estate
 *     `0121_customer_import.sql` exists to keep out.
 *   - **no owner sign-off.** H-MIG-02's workbook asks for one per row because an outstanding package is a
 *     LIABILITY somebody has to accept. A delivered visit is not: nothing is owed on it, nothing posts,
 *     and a signature would be a ceremony over a figure that moves no money.
 *
 * ## The preamble is `#` lines, and the parser ignores them
 *
 * H-MIG-02's reason: a spreadsheet is what this file will be opened in, so the instructions have to
 * survive being opened and re-saved. `#` lines do.
 *
 * {@link buildVisitWorkbook} is a pure function of nothing at all, so it produces the SAME BYTES every
 * time. The identity of a source file in this build is the sha-256 of its bytes (H-MIG-01), so a generator
 * that stamped the time would give every regeneration a different identity — and somebody who regenerated
 * the blank file before filling it in would hold a file no earlier report could be about.
 */

/** One column of the visit history, and the sentence that tells a person what to put in it. */
export interface VisitColumn {
  /** The cell in the header row. Lower snake case, because a spreadsheet header is not a label. */
  readonly name: string
  /** Printed in the preamble, one paragraph per column. */
  readonly hint: string
}

/** The columns, in order. The ONE statement of this file's shape. */
export const VISIT_COLUMNS: readonly VisitColumn[] = Object.freeze([
  Object.freeze({
    name: 'customer_phone_as_listed',
    hint:
      'The number, exactly as the diary or the old records have it. Do NOT tidy it up — the importer ' +
      'reads 059 000 0042, 0590000042 and +971 59 000 0042 as one person. The number is the only thing ' +
      'that says whose visit this was, so a line whose number is not already in the imported customer ' +
      'list is QUARANTINED and nothing is guessed: import the contact list first.',
  }),
  Object.freeze({
    name: 'started_at',
    hint:
      'When the treatment began, as a date and time with the offset: 2026-06-02T22:30:00+04:00. The ' +
      'offset matters and is not decoration. This business trades 11:00 to 02:00, so a treatment that ' +
      'began at 01:30 belongs to the PREVIOUS trading day, and the importer works that out from the ' +
      'trading calendar rather than from the calendar date — you do not need to adjust anything. An ' +
      'instant that falls in no trading session at all is quarantined with that reason.',
  }),
  Object.freeze({
    name: 'finished_at',
    hint:
      'When the treatment finished, in the same form. It must be after started_at, and the treatment ' +
      'plus the room changeover after it must fit inside the session: a line that would end after the ' +
      'session closed is quarantined rather than imported, because an appointment past close is the ' +
      'shape of a mistyped hour.',
  }),
  Object.freeze({
    name: 'duration_minutes',
    hint:
      'How long the treatment was, in whole minutes — 60 for a sixty-minute massage. This is asked for ' +
      'ALTHOUGH started_at and finished_at would give it, and a row where the two disagree is REFUSED ' +
      'by name. It is the only cross-check there is on the two instants: both come off the same diary ' +
      'line, so a wrong hour or an AM/PM slip imports perfectly and shows up only as somebody’s ' +
      'utilisation being wrong on a day nobody can check. It also chooses which length of the service ' +
      'this was.',
  }),
  Object.freeze({
    name: 'service_slug',
    hint:
      'The service, by the slug this system already holds for it. A slug and a duration that match no ' +
      'service in the catalogue are quarantined: the nearest service is not imported in its place, ' +
      'because a treatment filed as something else is a figure in the wrong revenue line for ever.',
  }),
  Object.freeze({
    name: 'therapist_staff_reference',
    hint:
      'The therapist, by their staff reference. Not their name: a display name is set by an admin and ' +
      'is not typed into a history file. A reference nothing holds is quarantined, and so is one held ' +
      'by somebody who was not employed here on that date — a reused reference would file one ' +
      'person’s work against another. No placeholder therapist is ever assigned.',
  }),
  Object.freeze({
    name: 'room_code',
    hint:
      'The room, by its code. A code no room carries is quarantined. A default room is not substituted: ' +
      'the imported rows are judged for double-booking and room capacity exactly as live ones are, so a ' +
      'guessed room is a conflict reported against a room nobody used.',
  }),
  Object.freeze({
    name: 'outcome',
    hint:
      'How the visit ended: completed, no_show, cancelled_by_customer or cancelled_by_salon. A ' +
      'reconstructed visit is OVER — there is no requested, confirmed or in_progress here, because ' +
      'nobody is going to arrive for a treatment that happened in June and the importer refuses to put ' +
      'one into the live appointment machine.',
  }),
  Object.freeze({
    name: 'gross_charged_fils',
    hint:
      'What was actually charged for this visit, VAT-inclusive, in whole FILS — so AED 250.00 is ' +
      '25000. Leave nothing out and round nothing: a line with no figure is refused rather than ' +
      'imported at zero, because zero would read as a treatment given away. The figure is recorded as ' +
      'history and posts NOTHING: no invoice, no payment and no journal entry, so it changes no revenue ' +
      'figure, no VAT return and no balance. It is there so the visit in the customer’s record ' +
      'carries what they paid.',
  }),
])

/** The header row the generator writes and the parser demands, tab separated. */
export const VISIT_HEADER: string = VISIT_COLUMNS.map((column) => column.name).join('\t')

/**
 * The four labels a reconstructed visit may end on.
 *
 * The same four `appointment_migrated_is_finished` admits, and the agreement between this list and that
 * CHECK is asserted in `packages/migration/src/importers/appointments/import.itest.ts` by reading
 * `pg_constraint` — a list in TypeScript and a predicate in SQL is the second statement of a fact, and the
 * one that drifts is the one nothing reads.
 *
 * `rescheduled` is absent on purpose: it means a successor row exists, and a reconstruction has none to
 * point at.
 */
export const VISIT_OUTCOMES: readonly string[] = Object.freeze([
  'completed',
  'no_show',
  'cancelled_by_customer',
  'cancelled_by_salon',
])

/** One line of the file, as read, before anything is normalised. NEVER staged — see `./import.ts`. */
export interface VisitCell {
  /** 1-based, and it is the line in the FILE — the number a person opens the spreadsheet at. */
  readonly lineNumber: number
  readonly phoneAsListed: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMinutes: string
  readonly serviceSlug: string
  readonly therapistStaffReference: string
  readonly roomCode: string
  readonly outcome: string
  readonly grossChargedFils: string
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
 * The blank visit-history file: a preamble, the header, and no data rows.
 *
 * Pure, and pure on purpose — see the module note on why the file carries no timestamp. It takes no
 * arguments, unlike H-MIG-02's generator, because the two things a person filling this in has to choose
 * from — the service slugs and the staff references — are already in front of them in the old records,
 * and printing this system's current catalogue into the file would invite them to retype a visit as the
 * nearest thing on today's menu.
 */
export function buildVisitWorkbook(): string {
  const lines: string[] = [
    comment('BE RELAX — reconstructed visit history'),
    comment(''),
    comment('One visit per line, tab separated, under the header row below. Lines beginning with'),
    comment('# are ignored, so these instructions can stay in the file.'),
    comment(''),
    comment('WHAT THIS IMPORT IS FOR:'),
    ...commentParagraph(
      'So that each client’s record and the retention figures are about the whole relationship ' +
        'rather than about the weeks since this system started. Every visit imported here is marked as ' +
        'reconstructed history.',
    ),
    comment(''),
    comment('WHAT IT DOES NOT DO, which is the point of it:'),
    ...commentParagraph(
      'It moves no money. An imported visit writes no invoice, no payment and no journal entry, so it ' +
        'changes no revenue figure, no VAT return and no balance — the figures for the period ' +
        'before this system started are the opening balances, and counting these visits as well would ' +
        'count that period twice. It also puts nothing into the live diary: an imported visit cannot be ' +
        'checked in, completed or cancelled, because it already happened, and the database refuses the ' +
        'attempt by name.',
    ),
    comment(''),
    comment('WHAT IT DOES WITH A LINE IT CANNOT RESOLVE:'),
    ...commentParagraph(
      'The line is QUARANTINED with the reason and no visit is created. Nothing is guessed — no ' +
        'placeholder therapist, no default room, no nearest service. The quarantined lines are listed ' +
        'by file and line number in the import report, so they can be checked against this file and ' +
        'corrected in it. A line whose own text is wrong is different: the whole file is refused and ' +
        'nothing at all is imported, so one pass over the report corrects every bad line.',
    ),
    comment(''),
    comment('THE COLUMNS:'),
  ]
  for (const column of VISIT_COLUMNS) {
    lines.push(comment(`${column.name}`), ...commentParagraph(column.hint))
  }
  lines.push(comment(''), VISIT_HEADER, '')
  return lines.join('\n')
}

/** `started_at` -> index. Derived, so the column order is written once. */
const COLUMN_AT = new Map(VISIT_COLUMNS.map((column, index) => [column.name, index]))

/** A line the parser skips wherever it appears: an instruction, or a spacer in a spreadsheet. */
const isSkippable = (line: string): boolean => line.startsWith('#') || line.trim().length === 0

/**
 * The index of the header row, having checked that it IS the generated header.
 *
 * Separated from the row loop because the two refusals are the whole of this function's judgement and the
 * loop below is mechanical — H-MIG-04's reason, which was that a high cognitive complexity in a parser is
 * the shape where a `continue` in the wrong branch silently drops a line.
 */
function headerLineAt(lines: readonly string[]): number {
  const headerAt = lines.findIndex((line) => !isSkippable(line))
  if (headerAt === -1) {
    throw new AppError(
      'validation',
      'The visit history has no header row. Every line is a comment or blank, which is a generated file ' +
        'nobody filled in — refused rather than imported as an import of nothing, because a run that ' +
        'applied zero rows and completed would make the next run of the filled file look like a ' +
        're-import.',
    )
  }
  const header = (lines[headerAt] ?? '').replace(/\r$/, '')
  if (header === VISIT_HEADER) return headerAt

  const found = header.split('\t')
  const expected = VISIT_COLUMNS.map((column) => column.name)
  const missing = expected.filter((name) => !found.includes(name))
  const extra = found.filter((name) => !expected.includes(name))
  throw new AppError(
    'validation',
    `The visit history header on line ${headerAt + 1} is not the generated one, so every row would ` +
      'parse into the wrong columns rather than failing. ' +
      `Missing: ${missing.length === 0 ? 'none' : missing.join(', ')}. ` +
      `Unexpected: ${extra.length === 0 ? 'none' : extra.join(', ')}. ` +
      `Expected, in this order: ${expected.join(', ')}. Regenerate the blank file with ` +
      'scripts/migrate-visits.mjs --template and paste the rows into it.',
    { details: { line: headerAt + 1, missing, extra } },
  )
}

const at = (columns: readonly string[], name: string): string =>
  (columns[COLUMN_AT.get(name) ?? -1] ?? '').trim()

/**
 * Reads a filled visit history, header checked, comments and blank lines dropped.
 *
 * It returns the cells as typed and nothing else. The normalisation, the keyed digest and the staged
 * payload are `./import.ts`'s, deliberately: the raw number must never reach `StagedSourceRow`, because
 * that is what the framework writes into `import_row.payload` and keeps for ever (ADR 0072).
 */
export function parseVisitWorkbook(sourceText: string): readonly VisitCell[] {
  const lines = sourceText.split('\n')
  const headerAt = headerLineAt(lines)

  const cells: VisitCell[] = []
  for (const [index, raw] of lines.entries()) {
    if (index <= headerAt) continue
    const line = raw.replace(/\r$/, '')
    if (isSkippable(line)) continue
    const columns = line.split('\t')
    cells.push({
      lineNumber: index + 1,
      // NOT trimmed, for `parseContactWorkbook`'s reason: a cell that cannot be read is keyed exactly as
      // it stands, and a trim here would make two different cells one digest.
      phoneAsListed: columns[COLUMN_AT.get('customer_phone_as_listed') ?? 0] ?? '',
      startedAt: at(columns, 'started_at'),
      finishedAt: at(columns, 'finished_at'),
      durationMinutes: at(columns, 'duration_minutes'),
      serviceSlug: at(columns, 'service_slug'),
      therapistStaffReference: at(columns, 'therapist_staff_reference'),
      roomCode: at(columns, 'room_code'),
      outcome: at(columns, 'outcome').toLowerCase(),
      grossChargedFils: at(columns, 'gross_charged_fils'),
    })
  }
  return cells
}
