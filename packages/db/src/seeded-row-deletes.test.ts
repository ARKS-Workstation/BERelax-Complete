import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  commentBlocks,
  crossFileRestatements,
  DECLARED_UNQUALIFIED,
  duplicateDeclarations,
  GUARD_SUITE,
  missingSupportModules,
  NEVER_DECLARABLE,
  scannedFiles,
  sourceFiles,
  sqlLiterals,
  staleDeclarations,
  UNRESOLVED_LIST,
  undeclaredSites,
  unqualifiedInSource,
  unqualifiedSites,
} from './suite-table-ownership.ts'

/**
 * A suite may delete what it created. Anything wider is declared, and the declaration is checked.
 *
 * ## The defect this is against
 *
 * `customer-identity.itest.ts` and `otp-route.itest.ts` both held `delete from customer` with no
 * predicate, in a `beforeEach` and an `afterAll`. That removes the four customers `pnpm seed` creates —
 * not for the rest of the file, but permanently, for every suite that runs afterwards and for every later
 * run against the same database. `sell-package.itest.ts` reads a seeded customer and skipped all 21 of its
 * cases with "the seed creates customers; run `pnpm seed` before the integration suite", and roughly
 * fourteen files read that table.
 *
 * It stayed invisible for a long time because another suite's leaked rows made the offending cleanup raise
 * on an `ON DELETE RESTRICT` foreign key, so the delete never completed. Nine files carried comments
 * describing the hazard and ordering their own cleanup around it. Fixing the leak is what let the delete
 * succeed, which is the ordinary way a masked defect surfaces: the mask was the accident.
 *
 * **A suite may delete what it created. It may not delete what it found.**
 *
 * ## What this file measured, and what it measures now
 *
 * It measured ONE table: `customer`, by name, in one shape — while 67 unqualified `delete`/`truncate`
 * statements stood against `premises`, `business_day`, `app_setting`, `message_template`, `premises_hours`
 * and others. W-SYS-13 is the general answer and this is the same file extended, not a second one: the
 * `customer` line below is now the strictest case of the general rule rather than a separate scan, which is
 * what keeps its allowlist EMPTY by construction — `customer` is in
 * {@link NEVER_DECLARABLE}, so there is no wording that would let a statement through.
 *
 * The rule, the scan and the declarations are in `./suite-table-ownership.ts`; ADR 0050 is the decision.
 * Two claims a static scan cannot make are checked where they can be:
 * `packages/fixtures/src/seeded-tables.itest.ts` derives the seeded tables from the seed's own loaders, and
 * the integration run's `globalSetup` reads the seeded rows before the run and again after it.
 */

/** Every test file, integration or unit, under the roots — excluding this one. */
const FILES = scannedFiles().filter((file) => file !== GUARD_SUITE)
const SITES = unqualifiedSites(FILES)

describe('the seeded customers survive every suite', () => {
  it('finds no unqualified delete of the customer table, and reads enough files to mean it', () => {
    expect(
      FILES.length,
      'the scan found almost no test files, so a pass here would mean nothing',
    ).toBeGreaterThan(200)

    const offenders = SITES.filter((site) => site.tables.includes('customer')).map(
      (site) => `${site.file}:${site.line} ${site.statement}`,
    )
    expect(
      offenders,
      'the-seeded-customers-survive-every-suite: a suite removes every row of `customer`, including the ' +
        'four the seed creates. Scope the delete to the rows this suite created — by its own ' +
        '`phone_match_key`s or its own number band — the way customer-identity.itest.ts and ' +
        'otp-route.itest.ts do',
    ).toEqual([])
  })

  it('keeps the customer allowlist empty, in every wording', () => {
    // The allowlist was empty and had to STAY empty, which a comment cannot enforce. `customer` is in
    // `NEVER_DECLARABLE`, so the general rule refuses a declaration for it rather than trusting nobody to
    // write one. Measured rather than asserted in prose: on a database whose customers a suite had removed,
    // re-running `pnpm seed` left them missing wherever a loader short-circuits on a non-empty table, and
    // `package_sale.customer_id` is `on delete restrict` with `package_sale` refusing DELETE — so one
    // seeded sale pins its customer for the life of the database.
    expect(NEVER_DECLARABLE).toContain('customer')
    const declared = DECLARED_UNQUALIFIED.filter((entry) =>
      entry.tables.some((table) => NEVER_DECLARABLE.includes(table)),
    ).map((entry) => `${entry.file} → ${entry.tables.join(', ')}`)
    expect(
      declared,
      'the-customer-allowlist-stays-empty: a declaration names a table no suite may empty at all. There ' +
        'is no restoring loader for it: the seed cannot put the row back, and the row cannot be deleted ' +
        'once anything references it',
    ).toEqual([])
  })
})

describe('every unqualified statement is scoped or declared', () => {
  it('leaves no site neither scoped nor declared', () => {
    const offenders = undeclaredSites(SITES)
      .filter(({ table }) => table !== UNRESOLVED_LIST)
      .map(
        ({ site, table }) =>
          `${site.file}:${site.line} → ${table}   (${site.statement.slice(0, 90)})`,
      )
    expect(
      offenders,
      'a-suite-may-delete-only-what-it-created: this statement names a table and no rows. Either scope it ' +
        'to the rows the suite created, or add an entry to DECLARED_UNQUALIFIED in ' +
        'packages/db/src/suite-table-ownership.ts naming the file, the table and why that suite owns it ' +
        '(ADR 0050)',
    ).toEqual([])
  })

  it('leaves no statement whose scope it cannot read undeclared', () => {
    // A `truncate` over an interpolated name has no table names in its text, so the scan can neither approve
    // it nor accuse it — and silence would be the wrong answer, because that is exactly how a suite evades
    // this rule whether or not it means to. It was not hypothetical: the two shared teardowns this
    // repository moved its table lists into are written that way, and adding that module to the scanned set
    // found NOTHING in it until the list could be resolved.
    //
    // A list written as a frozen array of string literals in the same module IS resolved. Anything else
    // lands here and has to be declared with the reason its scope is safe.
    const unreadable = undeclaredSites(SITES)
      .filter(({ table }) => table === UNRESOLVED_LIST)
      .map(({ site }) => `${site.file}:${site.line}   (${site.statement.slice(0, 80)})`)
    expect(
      unreadable,
      'a-statement-whose-scope-cannot-be-read-is-declared: this delete or truncate takes its tables from an ' +
        `interpolation the scan cannot resolve. Declare it against '${UNRESOLVED_LIST}' saying why its ` +
        'scope is safe, or move the table list into a frozen array of string literals in the same module, ' +
        'which the scan does read',
    ).toEqual([])
  })

  it('has no declaration that stopped describing anything', () => {
    // The direction that lets the table SHRINK, and also the FLOOR for every assertion in this file. A
    // scan that broke — a regex that stopped matching, a literal reader that lost its concatenations —
    // reports zero sites, and zero sites makes `undeclaredSites` empty and the case above green over
    // nothing. It cannot make this one green: every declaration would go stale at once. So the floor is
    // derived from the declarations rather than being a number somebody chose (ADR 0002).
    const stale = staleDeclarations(SITES)
    expect(
      stale,
      'declared-owner-still-describes-a-site: a declaration matches no statement in the file it names. ' +
        'Either the statement was scoped — in which case remove the entry, because a declaration left ' +
        'behind is standing permission to put the statement back — or the scan has stopped seeing it, ' +
        'which is worse and is why this is the floor',
    ).toEqual([])
  })

  it('still has every support module it declares', () => {
    // A support module renamed or removed out from under a declaration is how this scan goes quiet: the
    // statement it holds is shared by sixteen suites, and none of them mentions a table any more.
    expect(
      missingSupportModules(),
      'a-support-module-is-still-there: TEST_SUPPORT_MODULES names a file that does not exist, so the ' +
        'statement it held is no longer scanned by anything',
    ).toEqual([])
  })

  it('declares each file and table exactly once, with a reason and a real path', () => {
    expect(
      duplicateDeclarations(),
      'one-declaration-per-file-and-table: two entries for one pair means two reasons for one statement, ' +
        'and a reader cannot tell which one covers the site in front of them',
    ).toEqual([])
    const malformed = DECLARED_UNQUALIFIED.filter(
      (entry) =>
        !existsSync(entry.file) ||
        entry.tables.length === 0 ||
        entry.why.trim().length < 40 ||
        (entry.restoredBy !== undefined && entry.kind !== 'owns'),
    ).map((entry) => `${entry.file} → ${entry.tables.join(', ')}`)
    expect(
      malformed,
      'a-declaration-names-a-file-a-table-and-a-reason: an entry names a file that does not exist, no ' +
        'table, a reason too short to be one, or a restoring loader for a statement that removes nothing',
    ).toEqual([])
  })
})

describe('the scan reads code and not prose', () => {
  /**
   * A `${…}` interpolation as TEXT, assembled rather than written.
   *
   * `noTemplateCurlyInString` refuses those two characters inside a quoted string, which is right
   * everywhere else and awkward here: the strings below are SQL source for the scanner to read, and the
   * interpolation is the thing under test. Assembling it in a template literal says so.
   */
  const interp = (expression: string): string => `$\{${expression}}`

  it('reads a bare statement and not a sentence about one', () => {
    // Both directions on strings this case owns, which is what stops the whole file passing over nothing.
    expect(unqualifiedInSource('await sql`delete from customer`').flatMap((s) => s.tables)).toEqual(
      ['customer'],
    )
    // A comment quoting the statement. Nine files did exactly this while describing the defect.
    expect(unqualifiedInSource('// `delete from customer` is what it used to do\n')).toEqual([])
    // A test NAME quoting it, which the comment stripper cannot help with — the keyword is not where a
    // statement starts, and that is the whole test.
    expect(unqualifiedInSource("it('refuses DELETE from the application role', () => {})")).toEqual(
      [],
    )
    // A privilege, not a statement. `revoke truncate on ${table} from berelax_app` is real SQL in which
    // `truncate` is a grant name; a scan keying on the word alone reported it as a truncate of `on`.
    expect(
      unqualifiedInSource('await sql.unsafe(`revoke truncate on x from berelax_app`)'),
    ).toEqual([])
  })

  it('sees a predicate wherever the author put it', () => {
    // The `where` on the next line. The first version of this check ended its pattern at the end of a
    // LINE, so a correctly scoped delete was reported as an offence — and C-AUTO-07 reformatted its own
    // SQL onto one line rather than argue with it. A check that makes people write worse code is wrong.
    expect(
      unqualifiedInSource(
        `await sql\`delete from customer\n  where phone_match_key = any (${interp('keys')})\``,
      ),
    ).toEqual([])
    // An alias between the table and the predicate, which PostgreSQL allows and two suites use.
    expect(
      unqualifiedInSource(
        `await sql\`delete from outbox_event e where e.event_type = ${interp('kind')}\``,
      ),
    ).toEqual([])
  })

  it('reads a concatenated table list as one statement, and a schema-qualified name as one name', () => {
    // Every suite that truncates the invoice family writes it over two string literals, because the list
    // does not fit in a hundred columns. Reading the halves separately finds the first three tables and
    // misses `invoice` — the one table in the statement whose rows cannot be re-inserted.
    const concatenated =
      "await sql.unsafe('truncate refund, checkout_finalisation, payment, ' +\n" +
      "  'invoice_appointment, invoice_line, invoice')"
    expect(unqualifiedInSource(concatenated).flatMap((s) => s.tables)).toEqual([
      'refund',
      'checkout_finalisation',
      'payment',
      'invoice_appointment',
      'invoice_line',
      'invoice',
    ])
    expect(
      unqualifiedInSource('await tx`delete from clinical.treatment_note`').flatMap((s) => s.tables),
    ).toEqual(['clinical.treatment_note'])
    // And the same name WITH a predicate is not a site, which is how the clinical suites are written.
    expect(
      unqualifiedInSource('await tx`delete from clinical.treatment_note where false`'),
    ).toEqual([])
  })

  it('reads an interpolation as a placeholder rather than splicing the words either side together', () => {
    const literals = sqlLiterals(
      `await sql\`delete from customer where id = ${interp('id')} and x = ${interp('y')}\``,
    )
    // ` ?id ` and not ` ? `: the placeholder keeps the interpolation's first IDENTIFIER, which is what lets
    // `truncate ${LIST}` be recognised as a statement whose table list has to be resolved rather than
    // silently read as a statement with no tables. Spaced both sides, because collapsing an interpolation to
    // nothing could splice the identifiers either side of it into one word.
    expect(literals[0]?.text).toBe('delete from customer where id =  ?id  and x =  ?y ')
  })

  it('resolves a table list written as a frozen array in the same module', () => {
    // The mechanism the two shared teardowns depend on, both directions, on strings this case owns.
    const module = [
      "const FAMILY: readonly string[] = Object.freeze(['refund', 'payment', 'invoice'])",
      `await sql.unsafe(\`truncate ${interp("FAMILY.join(', ')")}\`)`,
    ].join('\n')
    expect(unqualifiedInSource(module).flatMap((site) => site.tables)).toEqual([
      'refund',
      'payment',
      'invoice',
    ])
    // And a list the scan CANNOT read is reported as unreadable rather than passed over in silence.
    const opaque = `await sql.unsafe(\`truncate ${interp('whateverThisIs')}\`)`
    expect(unqualifiedInSource(opaque).flatMap((site) => site.tables)).toEqual([UNRESOLVED_LIST])
  })
})

describe('a comment states its own suite, not another file', () => {
  it('leaves no comment documenting what another file removes', () => {
    const restatements = crossFileRestatements(sourceFiles(), SITES).map(
      (finding) => `${finding.file}:${finding.line} names ${finding.names} — ${finding.excerpt}`,
    )
    expect(
      restatements,
      'a-comment-states-its-own-suite: this comment describes another file’s cleanup. It has already ' +
        'drifted once — nine files ordered their own cleanup around two suites clearing the `customer` ' +
        'table, both were scoped, and every one of those sentences then described something that does not ' +
        'happen. State this file’s own reason, which does not change when another file is fixed',
    ).toEqual([])
  })

  it('fires on a restatement and stays quiet on a local reason', () => {
    // The control, on this case's own strings. Without it the assertion above is satisfied by a detector
    // that has stopped detecting, which is exactly how the customer line went quiet for weeks.
    const blocks = commentBlocks(
      '// `otp-route.itest.ts` clears the whole `customer` table between its cases, so this file re-ensures.\n' +
        'const x = 1\n' +
        '// This file re-ensures its own contact, because nothing guarantees an earlier one survived.\n',
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.text).toContain('otp-route.itest.ts')
    expect(blocks[1]?.text).not.toContain('.itest.ts')
    // A wrapped phrase is one block, which is why the scan joins before it splits: four of the nine files
    // wrapped "clears the whole `customer`" and "table between its cases" onto separate lines, and a
    // line-at-a-time scan found neither half.
    const wrapped = commentBlocks(' * clears the whole `customer`\n * table between its cases\n')
    expect(wrapped[0]?.text).toBe('clears the whole `customer` table between its cases')
  })
})
