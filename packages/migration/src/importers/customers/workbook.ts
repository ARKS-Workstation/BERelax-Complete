import { AppError } from '@berelax/shared'

/**
 * The reconstructed contact list: its two columns, the file a person is handed, and the reader for one.
 *
 * ## Why there are two columns and not twelve
 *
 * H-MIG-02's workbook asks for eleven cells because an outstanding package is a liability with eleven
 * facts about it. A contact list is not a liability and has one fact: **a number**. Everything else a
 * phone contact or a WhatsApp thread holds — a name, a note, when they last messaged, which list they
 * came off — is either something this system will not store or something it must not invent:
 *
 *   - **no name.** `customer.display_name` is null until an admin enters one, and ADR 0020 is why: a
 *     label that could not be a name cannot be mistaken for one, and a name typed into somebody's phone
 *     is that person's shorthand rather than the name this business may publish or address them by. The
 *     import therefore creates records the UI labels `Customer 0042`. If the business wants the names, it
 *     is a column on this file and a decision about ADR 0020 — recorded as deferred rather than guessed.
 *   - **no locale.** `customer.locale` defaults to `en` and is the person's own choice to correct; a
 *     guess from a contact list would be a preference nobody stated, applied to every message they get.
 *   - **no notes.** Free prose about a person, staged into a ledger nothing can erase, is the estate
 *     `0121_customer_import.sql`'s header exists to keep out.
 *
 * The second column is not a fact about the contact at all. It is `source_claims_marketing_consent`, and
 * it exists so that a claim can be DISCARDED on the record rather than silently dropped — see below.
 *
 * ## Why the consent column exists when its answer is always the same
 *
 * The list this business is handed may well arrive with an opt-in column; the exporter that produced it
 * may even have one. H-MIG-04's first acceptance line is about exactly that file: *"a fixture source file
 * explicitly setting consent true still imports as false with a logged override"*.
 *
 * A column that is read and then refused is strictly better than no column, twice over. Without it, a
 * file carrying the claim either fails to parse (so somebody deletes the column and the claim with it) or
 * is read as data nothing records — and in both cases nothing afterwards can show that the assertion was
 * made and considered. With it, the claim lands in `imported_contact.consent_claim_discarded` and in one
 * audit row, the import report counts it, and the preamble below tells whoever fills the file in, in
 * words, that ticking it grants nothing.
 *
 * ## The preamble is `#` lines, and the parser ignores them
 *
 * H-MIG-02's reason, which is a good one: a spreadsheet is what this file will be opened in, so the
 * instructions have to survive being opened and re-saved. `#` lines do. That matters more here than there,
 * because the instruction that has to travel with this file is the consent sentence.
 *
 * ## Why the generated file carries no timestamp
 *
 * {@link buildContactWorkbook} is a pure function of nothing at all, so it produces the SAME BYTES every
 * time. The identity of a source file in this build is the sha-256 of its bytes (H-MIG-01), so a generator
 * that stamped the time would give every regeneration a different identity — and somebody who regenerated
 * the blank file before filling it in would hold a file no earlier report could be about.
 */

/** One column of the contact list, and the sentence that tells a person what to put in it. */
export interface ContactColumn {
  /** The cell in the header row. Lower snake case, because a spreadsheet header is not a label. */
  readonly name: string
  /** Printed in the preamble, one paragraph per column. */
  readonly hint: string
}

/**
 * The columns, in order. The ONE statement of this file's shape.
 *
 * The generator writes the header from it, the parser reads the header back and REFUSES a file whose
 * header disagrees, and the preamble's per-column hints come from the same array — so a column that is
 * renamed is renamed in the file, in the parser and in the instructions at once. The alternative, a header
 * literal in the generator and a list of expected names in the parser, is the second statement of a fact
 * this repository keeps paying for: the two agree until the day a column moves, and the symptom is a file
 * that parses into the wrong cells rather than an error.
 */
export const CONTACT_COLUMNS: readonly ContactColumn[] = Object.freeze([
  Object.freeze({
    name: 'phone_as_listed',
    hint:
      'The number, exactly as the contact list or the chat thread has it. Do NOT tidy it up: ' +
      // The example is on `059`, which is not an allocated UAE mobile prefix and therefore cannot ring
      // anybody (`packages/fixtures/src/synthetic.ts` gives the same guarantee for every fixture number).
      // A real number as an illustration is a number somebody eventually leaves in the file.
      '059 000 0042, 0590000042, +971 59 000 0042, ٠٥٩٠٠٠٠٠٤٢ and a number pasted out of WhatsApp with ' +
      'invisible spaces in it all arrive at the same record, and the importer is what proves that rather ' +
      'than whoever retypes the column. A number it cannot read is QUARANTINED with the reason and ' +
      'nothing is guessed — so a cell you are unsure of should be left as it is rather than corrected ' +
      'into something that looks right.',
  }),
  Object.freeze({
    name: 'source_claims_marketing_consent',
    hint:
      'yes, if the list you are copying from claims this person agreed to marketing. It changes NOTHING ' +
      'about what is imported: every contact arrives with no marketing consent at all, and this column ' +
      'is recorded as a claim that was discarded. It is here so the claim is on the record rather than ' +
      'dropped — a list rebuilt from WhatsApp history and phone contacts is not an opt-in, whatever the ' +
      'list says, and the proof TDRA asks for is the exact wording the person was shown. Leave it blank ' +
      'if the list says nothing.',
  }),
])

/** The header row the generator writes and the parser demands, tab separated. */
export const CONTACT_HEADER: string = CONTACT_COLUMNS.map((column) => column.name).join('\t')

/**
 * The cells that read as a claim of consent, lower-cased.
 *
 * Deliberately GENEROUS, and the asymmetry is the reason. The claim is discarded whichever way it reads,
 * so reading it loosely costs one thing — a larger count of claims recorded — while reading it strictly
 * costs the evidence this column exists to keep: a list that said `TRUE` or `Y` would be imported as a
 * list that claimed nothing, and the record would show an assertion that was never made.
 *
 * H-MIG-02's `owner_signed_off` takes `yes` and nothing else, and that is right there for the opposite
 * reason: a sign-off is a person accepting a liability, and a loose reading of THAT cell would admit a
 * balance nobody attested to.
 */
export const CONSENT_CLAIM_VALUES: readonly string[] = Object.freeze(['yes', 'y', 'true', '1'])

/** One line of the file, as read, before anything is normalised. NEVER staged — see `./dedup.ts`. */
export interface ContactCell {
  /** 1-based, and it is the line in the FILE — the number a person opens the spreadsheet at. */
  readonly lineNumber: number
  readonly phoneAsListed: string
  /** Whether the source asserted a marketing consent. Recorded as discarded; never honoured. */
  readonly sourceConsentClaim: boolean
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
 * The blank contact list: a preamble, the header, and no data rows.
 *
 * Pure, and pure on purpose — see the module note on why the file carries no timestamp. It takes no
 * arguments at all, unlike H-MIG-02's generator, because there is nothing in the database a person filling
 * this in has to choose from: a contact list names no templates, no terms and no prices.
 */
export function buildContactWorkbook(): string {
  const lines: string[] = [
    comment('BE RELAX — reconstructed customer contact list'),
    comment(''),
    comment(
      'Paste one contact per line, tab separated, under the header row below. Lines beginning',
    ),
    comment('with # are ignored, so these instructions can stay in the file.'),
    comment(''),
    comment('WHAT THIS IMPORT DOES NOT DO, which is the point of it:'),
    ...commentParagraph(
      'Every contact imported from this file arrives with NO marketing consent — not a false flag, no ' +
        'consent record at all, because nobody was ever asked and nobody withdrew anything. ' +
        'Transactional messages are unaffected: a booking confirmation and a reminder for an ' +
        'appointment they actually make are permitted, today, for every contact here. A promotional ' +
        'message is refused at the send gate until the person has given consent at a booking and the ' +
        'exact wording they were shown has been recorded. There is no option anywhere in the importer ' +
        'that changes this and the database refuses a consent record captured by an import.',
    ),
    comment(''),
    comment('WHAT IT DOES WITH A NUMBER IT CANNOT READ:'),
    ...commentParagraph(
      'The line is quarantined with the reason and no customer is created. Nothing is guessed — a ' +
        'repaired number is a record that may belong to somebody else. The quarantined lines are ' +
        'listed by file and line number in the import report, so they can be checked against this file ' +
        'and corrected in it.',
    ),
    comment(''),
    comment('THE COLUMNS:'),
  ]
  for (const column of CONTACT_COLUMNS) {
    lines.push(comment(`${column.name}`), ...commentParagraph(column.hint))
  }
  lines.push(comment(''), CONTACT_HEADER, '')
  return lines.join('\n')
}

/** `phone_as_listed` -> index. Derived, so the column order is written once. */
const COLUMN_AT = new Map(CONTACT_COLUMNS.map((column, index) => [column.name, index]))

/**
 * Reads a filled contact list, header checked, comments and blank lines dropped.
 *
 * It returns the cells as typed and nothing else. The normalisation, the keyed digest and the staged
 * payload are `./dedup.ts`'s, deliberately: the RAW number must never reach `StagedSourceRow`, because
 * that is what the framework writes into `import_row.payload` and keeps for ever.
 */
/** A line the parser skips wherever it appears: an instruction, or a spacer in a spreadsheet. */
const isSkippable = (line: string): boolean => line.startsWith('#') || line.trim().length === 0

/**
 * The index of the header row, having checked that it IS the generated header.
 *
 * Separated from the row loop because the two refusals are the whole of this function's judgement and the
 * loop below is mechanical — and because a 21-point cognitive complexity in a parser is the shape where a
 * `continue` in the wrong branch silently drops a line.
 */
function headerLineAt(lines: readonly string[]): number {
  const headerAt = lines.findIndex((line) => !isSkippable(line))
  if (headerAt === -1) {
    throw new AppError(
      'validation',
      'The contact list has no header row. Every line is a comment or blank, which is a generated file ' +
        'nobody filled in — refused rather than imported as an import of nothing, because a run that ' +
        'applied zero rows and completed would make the next run of the filled file look like a ' +
        're-import.',
    )
  }
  const header = (lines[headerAt] ?? '').replace(/\r$/, '')
  if (header === CONTACT_HEADER) return headerAt

  const found = header.split('\t')
  const expected = CONTACT_COLUMNS.map((column) => column.name)
  const missing = expected.filter((name) => !found.includes(name))
  const extra = found.filter((name) => !expected.includes(name))
  throw new AppError(
    'validation',
    `The contact list header on line ${headerAt + 1} is not the generated one, so every row would ` +
      'parse into the wrong columns rather than failing. ' +
      `Missing: ${missing.length === 0 ? 'none' : missing.join(', ')}. ` +
      `Unexpected: ${extra.length === 0 ? 'none' : extra.join(', ')}. ` +
      `Expected, in this order: ${expected.join(', ')}. Regenerate the blank file with ` +
      'scripts/migrate-contacts.mjs --template and paste the rows into it.',
    { details: { line: headerAt + 1, missing, extra } },
  )
}

export function parseContactWorkbook(sourceText: string): readonly ContactCell[] {
  const lines = sourceText.split('\n')
  const headerAt = headerLineAt(lines)

  const phoneAt = COLUMN_AT.get('phone_as_listed') ?? 0
  const claimAt = COLUMN_AT.get('source_claims_marketing_consent') ?? 1
  const cells: ContactCell[] = []
  for (const [index, raw] of lines.entries()) {
    if (index <= headerAt) continue
    const line = raw.replace(/\r$/, '')
    if (isSkippable(line)) continue
    const columns = line.split('\t')
    const claim = (columns[claimAt] ?? '').trim().toLowerCase()
    cells.push({
      lineNumber: index + 1,
      // NOT trimmed. The cell is kept exactly as the file holds it, because a cell that cannot be read
      // is keyed as it stands and a trim here would make two different cells one digest. `phoneTokens`
      // in `@berelax/core` removes every kind of whitespace anyway, including the non-breaking ones a
      // WhatsApp paste carries, so trimming would buy nothing on the path that parses.
      phoneAsListed: columns[phoneAt] ?? '',
      sourceConsentClaim: CONSENT_CLAIM_VALUES.includes(claim),
    })
  }
  return cells
}
