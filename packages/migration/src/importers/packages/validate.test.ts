import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  CLEAN_FIXTURE,
  FILE_LEVEL_FIXTURES,
  FIXTURE_VALIDATOR_TEMPLATES,
  FIXTURE_WORKBOOK_TEMPLATES,
  FIXTURE_WORKBOOK_TERMS,
  MALFORMED_FIXTURES,
  readFixture,
  SYNTHETIC_PACKAGE_ROWS,
} from './fixtures/index.ts'
import {
  createPackageWorkbookValidator,
  formatWorkbookRejections,
  PACKAGE_REJECTION_REASONS,
  PACKAGE_REJECTIONS,
  validatePackageWorkbook,
} from './validate.ts'
import {
  buildPackageWorkbook,
  EVIDENCE_KINDS,
  fillPackageWorkbook,
  parsePackageWorkbook,
  renderWorkbookRow,
  WORKBOOK_COLUMNS,
  WORKBOOK_HEADER,
} from './workbook.ts'

/**
 * The reconstruction workbook's validator: every named rejection shown to fire, and the round trip.
 *
 * A unit test and not an integration one, because nothing here needs a database: the template keys are an
 * ARGUMENT to the validator (see `validate.ts` on why), so every rule can be exercised against a real file
 * with nothing running. What DOES need a database — that the keys handed in are the keys the database holds,
 * and that the three terms printed on the workbook's face are the ones the Unconfirmed Assumptions query
 * returns — is `workbook.itest.ts`.
 *
 * ## The shape of the coverage claim, and why it is asserted in both directions
 *
 * `MALFORMED_FIXTURES` pairs a file with the reason it must produce, and this file iterates the pairing rather
 * than asserting that each file "fails". Three things make that a claim about the rules rather than about the
 * files, and all three come from the same place: a verdict carries ONE reason, so a case that only checks for
 * failure is satisfied by any rejection at all, including one from a cell the fixture broke by accident.
 *
 *   1. Each file must produce EXACTLY ONE rejection, carrying the named reason.
 *   2. Every reason in the vocabulary must have a fixture, and every fixture's reason must be in the
 *      vocabulary. A reason with no fixture is a refusal nobody has seen fire (ADR 0003); a fixture naming a
 *      reason the vocabulary lost is a report nobody can read.
 *   3. The clean file must validate clean. Without it every case above is satisfied by a validator that
 *      refuses everything.
 */

const templates = FIXTURE_VALIDATOR_TEMPLATES

const validate = (file: string) =>
  validatePackageWorkbook({ sourceFile: file, sourceText: readFixture(file), templates })

/**
 * Allocated UAE mobile prefixes. A fixture holder on one of these could reach a real handset.
 *
 * Restated here rather than imported from `packages/fixtures/src/synthetic.ts`, and the reason is a package
 * boundary: `@berelax/migration` may import `@berelax/db` and `@berelax/shared` and nothing else first-party
 * (see `packages/migration/src/index.ts`). The fact is held equal by the assertion below testing BOTH
 * directions — every fixture number must be outside this list, and a number on `+97150` must be caught — so a
 * copy that had drifted could not report every fixture as safe, which is the only way this restatement could
 * cost anything.
 */
const ALLOCATED_UAE_MOBILE_PREFIXES = ['50', '52', '54', '55', '56', '58']

const reachesAHandset = (cell: string): boolean => {
  const match = /^\+971(\d{2})/.exec(cell)
  return match?.[1] !== undefined && ALLOCATED_UAE_MOBILE_PREFIXES.includes(match[1])
}

describe('the reconstruction workbook validator', () => {
  it('accepts the clean fixture and reports what the file is worth', () => {
    const report = validate(CLEAN_FIXTURE)
    expect(report.rejections, formatWorkbookRejections(report).join('\n')).toEqual([])
    expect(report.ok).toBe(true)
    // The floor (ADR 0002). A parser that returned nothing would satisfy "no rejections" for ever, and
    // every malformed case below would pass against an empty file.
    expect(report.rows).toBeGreaterThan(4)
    expect(report.accepted).toBe(report.rows)
    // The figures H-MIG-03 reconciles to cash. Asserted as the sum of the file rather than as a constant:
    // a literal here would be a second statement of the fixture.
    const expectedPrice = SYNTHETIC_PACKAGE_ROWS.reduce(
      (total, row) => total + BigInt(row.pricePaidFils),
      0n,
    )
    expect(report.totalPricePaidFils).toBe(expectedPrice.toString())
    expect(report.totalSessionsRemaining).toBe(
      SYNTHETIC_PACKAGE_ROWS.reduce((total, row) => total + Number(row.sessionsRemaining), 0),
    )
  })

  it('counts every evidence kind, and counts the attested rows separately', () => {
    const report = validate(CLEAN_FIXTURE)
    // Every kind is exercised by the clean fixture, so a kind that stopped being accepted is caught here
    // rather than in a real workbook. Y9-package-thin's population is the one that has to be countable on
    // its own: H-MIG-03 flags those balances on the customer record.
    for (const kind of EVIDENCE_KINDS) {
      expect(report.evidence[kind], `no clean fixture row uses ${kind}`).toBeGreaterThan(0)
    }
    expect(report.attested).toBe(report.evidence['owner_attestation'])
    expect(report.attested).toBeGreaterThan(0)
    // And it is a SUBSET, not the whole file: a counter that answered `rows` would pass the line above.
    expect(report.attested).toBeLessThan(report.accepted)
  })

  it.each(MALFORMED_FIXTURES)(
    'refuses $file with exactly $rejection',
    ({ file, rejection, why }) => {
      const report = validate(file)
      // The rejection is named in the MESSAGE and not only in the case title, and that is not decoration:
      // vitest's reporter truncates a long test name, so a gate case asserting that this suite failed by the
      // name of the rule it broke would match a `sessions-remaining-must-equal-total-min…` that had been cut
      // off. An assertion message is printed whole.
      expect(
        report.ok,
        `${file} must be refused by ${rejection} (${why}) and validated clean`,
      ).toBe(false)
      // EXACTLY one, and the named one. A fixture that broke two cells would report one reason and the
      // rule this case names would go unexercised — see the module note.
      expect(
        report.rejections.map((entry) => entry.reason),
        `${file} should be refused only by ${rejection}: ${formatWorkbookRejections(report).join('; ')}`,
      ).toEqual([rejection])
      // The line is a line of the FILE, so `<file>:<line>` opens the spreadsheet at the row.
      const [only] = report.rejections
      expect(only?.lineNumber).toBeGreaterThan(1)
      expect(formatWorkbookRejections(report)).toEqual([
        `${file}:${String(only?.lineNumber)}  ${rejection}`,
      ])
    },
  )

  it('has a fixture for every rejection and a rejection for every fixture', () => {
    const covered = MALFORMED_FIXTURES.map((fixture) => fixture.rejection)
    expect([...covered].sort()).toEqual([...PACKAGE_REJECTION_REASONS].sort())
    expect(new Set(covered).size, 'two fixtures claim the same rejection').toBe(covered.length)
    expect(new Set(MALFORMED_FIXTURES.map((f) => f.file)).size).toBe(MALFORMED_FIXTURES.length)
    // The acceptance line names eight by hand. Named here so that losing one is a failure about that line
    // rather than a smaller number in the count above.
    for (const named of [
      PACKAGE_REJECTIONS.sessionsUsedExceedsTotal,
      PACKAGE_REJECTIONS.sessionsNegative,
      PACKAGE_REJECTIONS.templateUnknown,
      PACKAGE_REJECTIONS.holderPhoneNotE164,
      PACKAGE_REJECTIONS.priceNotIntegerFils,
      PACKAGE_REJECTIONS.expiryBeforePurchase,
      PACKAGE_REJECTIONS.duplicateHolderTemplatePurchase,
      PACKAGE_REJECTIONS.ownerSignOffMissing,
    ]) {
      expect(covered, `the acceptance list names ${named} and no fixture produces it`).toContain(
        named,
      )
    }
    expect(MALFORMED_FIXTURES.length).toBeGreaterThanOrEqual(8)
  })

  it('names the missing template rather than reporting a bad row', () => {
    // Acceptance: "no package row imports before its package_template row exists; the attempt fails naming
    // the missing template". The row is refused with a reason that is about the TEMPLATE, and the
    // distinction from a template that exists without terms is asserted as well — reporting the second as
    // "unknown" would send somebody to create a template that is already there.
    expect(validate('template-unknown.tsv').rejections[0]?.reason).toBe(
      PACKAGE_REJECTIONS.templateUnknown,
    )
    expect(validate('template-without-version.tsv').rejections[0]?.reason).toBe(
      PACKAGE_REJECTIONS.templateWithoutVersion,
    )
    // And the same file validates clean once the template is known: the refusal is about the template list
    // it was handed, not about the row.
    const promoted = validatePackageWorkbook({
      sourceFile: 'template-unknown.tsv',
      sourceText: readFixture('template-unknown.tsv'),
      templates: [...templates, { templateKey: 'no_such_package_hmig02', hasVersion: true }],
    })
    expect(promoted.ok, formatWorkbookRejections(promoted).join('\n')).toBe(true)
  })

  it('refuses the FILE, not a row, when the header has been edited or nothing was filled in', () => {
    // A reordered header parses every row into the wrong field rather than failing, which cannot be
    // reported per line — so it is refused before any row has a verdict.
    expect(() => validate(FILE_LEVEL_FIXTURES.headerMismatch)).toThrow(AppError)
    expect(() => validate(FILE_LEVEL_FIXTURES.headerMismatch)).toThrow(/not the generated one/)
    // It says WHICH line, and what the header should have been, because the remedy is to regenerate.
    try {
      validate(FILE_LEVEL_FIXTURES.headerMismatch)
      expect.unreachable('a transposed header must be refused')
    } catch (error) {
      expect((error as AppError).message).toContain('gen-package-workbook.mjs')
      expect((error as AppError).message).toContain(WORKBOOK_COLUMNS[0]?.name ?? '')
    }
    expect(() => validate(FILE_LEVEL_FIXTURES.noRows)).toThrow(/no header row/)
  })

  it('refuses a duplicate on the SECOND occurrence and lets the first stand', () => {
    const report = validate('duplicate-holder-template-purchase.tsv')
    expect(report.accepted).toBe(1)
    expect(report.rejections).toHaveLength(1)
    // The second line, not the first: the first occurrence is the row that imports, and a validator that
    // refused both would refuse a package that is genuinely owed.
    const lines = readFixture('duplicate-holder-template-purchase.tsv').split('\n')
    const firstDataLine = lines.findIndex((line) => line.startsWith('+')) + 1
    expect(report.rejections[0]?.lineNumber).toBe(firstDataLine + 1)
  })

  it('keeps its duplicate memory per validator, so a second file starts clean', () => {
    // One instance per run. A module-level set would make the second import of a corrected workbook refuse
    // every row as a duplicate of the run that rejected it.
    const first = createPackageWorkbookValidator({ templates })
    const second = createPackageWorkbookValidator({ templates })
    const [row] = SYNTHETIC_PACKAGE_ROWS
    if (row === undefined) expect.unreachable('the clean fixture has no rows')
    const payload = { ...row }
    expect(first.validate(payload).ok).toBe(true)
    expect(first.validate(payload)).toEqual({
      ok: false,
      reason: PACKAGE_REJECTIONS.duplicateHolderTemplatePurchase,
    })
    expect(second.validate(payload).ok).toBe(true)
  })

  it('holds every fixture holder off an allocated mobile prefix, and can tell one', () => {
    const numbers = [CLEAN_FIXTURE, ...MALFORMED_FIXTURES.map((f) => f.file)].flatMap((file) =>
      readFixture(file)
        .split('\n')
        .filter((line) => !line.startsWith('#'))
        .flatMap((line) => line.split('\t'))
        .filter((cell) => cell.startsWith('+')),
    )
    expect(numbers.length, 'no fixture phone numbers were found at all').toBeGreaterThan(4)
    expect(numbers.filter((cell) => reachesAHandset(cell))).toEqual([])
    // The control. Without it the predicate could answer `false` for everything and the line above would
    // pass for ever — which is the shape of this defect, because a fixture number that CAN ring somebody
    // looks exactly like one that cannot.
    expect(reachesAHandset('+971500000101')).toBe(true)
    expect(reachesAHandset('+971590000101')).toBe(false)
  })
})

describe('the generated workbook', () => {
  const blank = buildPackageWorkbook({
    templates: FIXTURE_WORKBOOK_TEMPLATES,
    terms: FIXTURE_WORKBOOK_TERMS,
  })

  it('round-trips: a filled copy of the generated file validates clean', () => {
    // The acceptance line. Generate the workbook, fill it with the synthetic fixture set, validate it.
    const filled = fillPackageWorkbook(blank, SYNTHETIC_PACKAGE_ROWS)
    const report = validatePackageWorkbook({
      sourceFile: 'generated.tsv',
      sourceText: filled,
      templates,
    })
    expect(report.rejections, formatWorkbookRejections(report).join('\n')).toEqual([])
    expect(report.accepted).toBe(SYNTHETIC_PACKAGE_ROWS.length)
    // And it is the SAME rows as the committed clean fixture, read back through the parser — so the round
    // trip is proved against the file a person would open rather than against a second copy of the rows.
    expect(parsePackageWorkbook(filled).map((row) => row.payload)).toEqual(
      parsePackageWorkbook(readFixture(CLEAN_FIXTURE)).map((row) => row.payload),
    )
  })

  it('is byte-identical when generated twice, because a hash is the file’s identity', () => {
    // No timestamp, no run id, no serial. `import_run.source_file_hash` is the sha-256 of the bytes and
    // H-MIG-03's owner sign-off attests to that hash, so a regenerated blank must be the same file.
    expect(
      buildPackageWorkbook({
        templates: FIXTURE_WORKBOOK_TEMPLATES,
        terms: FIXTURE_WORKBOOK_TERMS,
      }),
    ).toBe(blank)
    expect(blank).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/)
  })

  it('prints the terms and templates it was HANDED, not constants of its own', () => {
    // The fixture terms are deliberately not the configured defaults (three months, transferable,
    // forfeited), so a generator printing a constant could not pass this.
    expect(blank).toContain('validity 3 months')
    expect(blank).toContain('transferable')
    expect(blank).toContain('forfeited')
    expect(blank).toContain('Y9-package-policy')
    expect(blank).toContain('NONE OF THE THREE IS CONFIRMED')
    for (const template of FIXTURE_WORKBOOK_TEMPLATES) {
      expect(blank).toContain(template.templateKey)
    }
    // The versionless template is NOT offered: the reference block is what a person chooses from.
    expect(blank).not.toContain('fixture_template_without_version')
    // Every column is explained on the file's face, so the instructions travel with it.
    for (const column of WORKBOOK_COLUMNS) expect(blank).toContain(column.name)
    // And the file is a workbook, not a filled one.
    expect(parsePackageWorkbook(blank)).toEqual([])
  })

  it('says so, in words, when the database holds no template a row may name', () => {
    const empty = buildPackageWorkbook({ templates: [], terms: FIXTURE_WORKBOOK_TERMS })
    expect(empty).toContain('NONE.')
    expect(empty).toContain(WORKBOOK_HEADER)
    // A workbook is still produced: it is the thing that says nothing can be reconstructed yet. Inventing
    // a key to fill the list would be inventing the product (Y9-package-catalogue, brief rule 15).
    expect(empty.split('\n').filter((line) => line === WORKBOOK_HEADER)).toHaveLength(1)
  })

  it('states the columns once: the header, the parser and the hints cannot disagree', () => {
    expect(WORKBOOK_HEADER).toBe(WORKBOOK_COLUMNS.map((column) => column.name).join('\t'))
    // The committed fixtures carry the generated header, so a renamed column fails them all rather than
    // silently reading a different cell.
    for (const file of [CLEAN_FIXTURE, ...MALFORMED_FIXTURES.map((f) => f.file)]) {
      expect(
        readFixture(file).split('\n'),
        `${file} does not carry the generated header`,
      ).toContain(WORKBOOK_HEADER)
    }
    // Every column has a hint a person can act on, not a restatement of its name.
    for (const column of WORKBOOK_COLUMNS) {
      expect(column.hint.length, `${column.name} has no hint`).toBeGreaterThan(30)
    }
  })

  it('refuses to render a cell carrying a separator rather than quoting it', () => {
    const [row] = SYNTHETIC_PACKAGE_ROWS
    if (row === undefined) expect.unreachable('the clean fixture has no rows')
    expect(() => renderWorkbookRow({ ...row, notes: 'pasted\tfrom a table' })).toThrow(AppError)
    // The control: the same row renders, and renders back to the cells it came from.
    expect(renderWorkbookRow(row).split('\t')[0]).toBe(row.holderPhoneE164)
  })
})
