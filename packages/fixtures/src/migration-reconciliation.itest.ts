import { randomUUID } from 'node:crypto'
import {
  type Actor,
  createConnection,
  type Sql,
  type SuppressionPepper,
  withUnitOfWork,
} from '@berelax/db'
import {
  clearProbeEntities,
  exactChecksum,
  generateReconciliationReport,
  PROBE_KEY_PREFIX,
  PROBE_REJECTIONS,
  probeImporter,
  QUARANTINE_RELATIONS,
  type ReconciliationReport,
  reconciliationExitStatus,
  recordReconciliationRun,
  renderReconciliationReport,
  reportContentBytes,
  reportFigures,
  runImport,
} from '@berelax/migration'
import { customersImporter } from '@berelax/migration/importers/customers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildContactList,
  contactNormaliser,
  UNREADABLE_REASONS,
  unreadableCells,
} from './customer-import.ts'
import { fixtureSuppressionPeppers } from './suppression.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/**
 * H-MIG-08's five acceptance lines against a real PostgreSQL, each with a control that must fail.
 *
 * ## Every assertion is about THIS execution's runs, and that is not fastidiousness
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind
 * (brief rule 12). The report is a reading of the WHOLE staging ledger, so it necessarily describes
 * `customer-import.itest.ts`'s runs, `package-liability.itest.ts`'s and `framework.itest.ts`'s as well as
 * this file's — and an assertion like "the report has no unexplained variance" would be an assertion
 * about every other suite's fixtures, green or red for reasons that have nothing to do with this unit.
 *
 * So: this file finds its own sources by the file names it invented, asserts their figures, and asserts
 * the planted discrepancy as a DELTA against the same report generated without the plant. The
 * zero-unexplained claim over a database with nothing else in it is H-MIG-09's, which is the only place
 * it can honestly be made — a fresh restore, three times.
 *
 * ## The plant goes in a transaction that is rolled back
 *
 * `imported_staff_row` refuses UPDATE and DELETE for every role (`imported_staff_row_no_update`,
 * `..._no_delete`), so a committed planted row would be permanent and would make every later execution of
 * this file — and H-MIG-09's gate, which reads the same kind of figure — see a discrepancy nobody could
 * remove. The report generator takes an `Sql`, and a transaction handle is one, so the whole case runs
 * inside `withUnitOfWork` and throws to roll back. That is also the reason the generator takes `Sql` and
 * not a pool.
 */

const ACTOR: Actor = { kind: 'system', label: 'H-MIG-08 reconciliation report suite' }

/** Per-execution, so this file's rows hash differently from the last execution's. */
const NONCE = `${process.pid}-${randomUUID().slice(0, 8)}`
/**
 * The synthetic-person band this file draws from.
 *
 * Far above `customer-import.itest.ts`'s 6,000,000 band and `rights.itest.ts`'s 10,700, for that file's
 * recorded reason: `customer.phone_e164` is UNIQUE, so a fixed index makes the second execution resolve
 * every line to the customer the first one created and the `created`/`matched` split stops being about
 * the file.
 */
const BAND = 8_000_000 + (Date.now() % 500) * 4_000

let sql: Sql
let pepper: SuppressionPepper
/** Every number this file created a customer for: the one DELETE it is allowed to make. */
const created: string[] = []

class RollBack extends Error {
  constructor() {
    super('reconciliation case complete — rolling back')
    this.name = 'RollBack'
  }
}

async function inRolledBackTransaction(body: (handle: Sql) => Promise<void>): Promise<void> {
  try {
    await withUnitOfWork(sql, ACTOR, async (uow) => {
      await body(uow.sql)
      throw new RollBack()
    })
  } catch (error) {
    if (error instanceof RollBack) return
    throw error
  }
}

/** A probe file whose rows are unique to this execution, optionally with one malformed line. */
let fileCounter = 0
function probeFile(rows: number, options: { readonly malformedAt?: number } = {}): string {
  fileCounter += 1
  const lines = ['probe_key\tlabel\tamount_fils']
  for (let at = 0; at < rows; at += 1) {
    const key = `${PROBE_KEY_PREFIX}${NONCE}-f${fileCounter}-${at}`
    const amount = options.malformedAt === at ? 'not-a-number' : String(1_000 + at)
    lines.push(`${key}\treconciliation probe ${at}\t${amount}`)
  }
  return `${lines.join('\n')}\n`
}

const cleanFile = probeFile(3)
const CLEAN_SOURCE = `h-mig-08-clean-${NONCE}.tsv`
const rejectedFile = probeFile(4, { malformedAt: 2 })
const REJECTED_SOURCE = `h-mig-08-rejected-${NONCE}.tsv`
const CONTACT_SOURCE = `h-mig-08-contacts-${NONCE}.tsv`

const contactList = buildContactList({
  baseIndex: BAND,
  distinct: 6,
  duplicates: 2,
  claimEvery: 3,
  unreadable: unreadableCells(Date.now()),
})

let report: ReconciliationReport

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  pepper = fixtureSuppressionPeppers(process.env).current
  await clearProbeEntities(sql)

  await runImport({
    sql,
    importer: probeImporter(),
    sourceFile: CLEAN_SOURCE,
    sourceText: cleanFile,
    mode: 'live',
    actor: ACTOR,
  })
  await runImport({
    sql,
    importer: probeImporter(),
    sourceFile: REJECTED_SOURCE,
    sourceText: rejectedFile,
    mode: 'live',
    actor: ACTOR,
  })
  await runImport({
    sql,
    importer: customersImporter({ pepper, normalise: contactNormaliser }),
    sourceFile: CONTACT_SOURCE,
    sourceText: contactList.sourceText,
    mode: 'live',
    actor: ACTOR,
  })
  created.push(...contactList.numbers)

  report = await generateReconciliationReport(sql)
}, 60_000)

afterAll(async () => {
  /*
    The customers this file created, and nothing else.

    `imported_contact` refuses DELETE for every role (ZY272) and so does the whole staging ledger, which
    is the point of them; `clearProbeEntities` is the statement of the probe target's own teardown and
    lives in `conformance/probe-importer.ts` so both H-MIG-01 suites and this one share one copy
    (ADR 0050). The customer rows are mine to remove and have to be: `customer` is the table every other
    suite's counts run over.
  */
  if (sql !== undefined) {
    await clearProbeEntities(sql)
    if (created.length > 0) {
      await sql`delete from customer where phone_e164 = any (${created}::text[])`
    }
  }
  await sql?.end({ timeout: 5 })
})

const sourceFor = (file: string) => {
  const found = report.sources.find((entry) => entry.sourceFile === file)
  expect(found, `the report names ${file}`).toBeDefined()
  if (found === undefined) throw new Error(`no source for ${file}`)
  return found
}

const varianceFor = (subject: string, within: ReconciliationReport = report) => {
  const found = within.variances.find((entry) => entry.subject === subject)
  expect(found, `the report holds a variance for ${subject}`).toBeDefined()
  if (found === undefined) throw new Error(`no variance for ${subject}`)
  return found
}

describe('the report is a reading and not a writer', () => {
  it('leaves every relation it reports on byte-identical', async () => {
    const relations = [
      'import_staging.import_run',
      'import_staging.import_row',
      'import_staging.import_provenance',
      'public.imported_contact',
    ]
    const before = await Promise.all(relations.map((relation) => exactChecksum(sql, relation)))
    await generateReconciliationReport(sql)
    await generateReconciliationReport(sql)
    const after = await Promise.all(relations.map((relation) => exactChecksum(sql, relation)))
    expect(after).toEqual(before)
  })

  it('does not pass vacuously: a real import DOES move those checksums', async () => {
    // The control. Equal-before-and-equal-after is also what a checksum that measured nothing would
    // answer, and that is exactly the failure ADR 0002 is about.
    const before = await exactChecksum(sql, 'import_staging.import_run')
    await runImport({
      sql,
      importer: probeImporter(),
      sourceFile: `h-mig-08-control-${NONCE}.tsv`,
      sourceText: probeFile(1),
      mode: 'live',
      actor: ACTOR,
    })
    expect(await exactChecksum(sql, 'import_staging.import_run')).not.toBe(before)
  }, 30_000)
})

describe('two generations over the same data', () => {
  it('produce byte-identical reports and the same digest', async () => {
    const first = recordReconciliationRun(
      await generateReconciliationReport(sql),
      new Date('2026-10-03T08:00:00.000Z'),
    )
    const second = recordReconciliationRun(
      await generateReconciliationReport(sql),
      new Date('2026-10-04T19:30:00.000Z'),
    )
    expect(reportContentBytes(second.report)).toBe(reportContentBytes(first.report))
    expect(second.contentDigest).toBe(first.contentDigest)
    // The declared run timestamp is the only thing that moves, which is the acceptance line's own wording.
    expect(second.generatedAt).not.toBe(first.generatedAt)
    expect(JSON.stringify(second.report)).toBe(JSON.stringify(first.report))
  }, 30_000)
})

describe('per source file', () => {
  it('states the source count against the imported count with a variance of zero on a clean run', () => {
    const clean = sourceFor(CLEAN_SOURCE)
    expect(clean.sourceRows).toBe(3)
    expect(clean.appliedRows).toBe(3)
    expect(clean.importedRows).toBe(3)
    expect(clean.recordRelation).toBe('import_staging.import_probe_entity')
    const variance = varianceFor(`probe/${clean.sourceFileHash}/rows`)
    expect(variance.variance).toBe(0)
    expect(variance.unexplained).toBe(0)
    expect(variance.explained).toEqual([])
  })

  it('ties a failed run’s whole variance to named causes', async () => {
    /*
      A run with any rejection applies NOTHING and ends `failed` (ADR 0065: a workbook is all-or-nothing
      on validity), so the four staged rows are one rejected and three left pending. The variance is
      therefore the whole file, and every row of it is accounted for by a state the framework recorded —
      which is the difference between a variance that is explained and one that is merely annotated.
    */
    const failed = sourceFor(REJECTED_SOURCE)
    expect(failed.state).toBe('failed')
    expect(failed.sourceRows).toBe(4)
    expect(failed.rejectedRows).toBe(1)
    expect(failed.pendingRows).toBe(3)
    expect(failed.appliedRows).toBe(0)
    expect(failed.importedRows).toBe(0)
    const variance = varianceFor(`probe/${failed.sourceFileHash}/rows`)
    expect(variance.variance).toBe(4)
    expect(variance.explained.map((entry) => [entry.cause, entry.figure])).toEqual([
      ['rejected_rows', 1],
      ['pending_rows', 3],
    ])
    expect(variance.unexplained).toBe(0)

    // And the rejection is the one the file was built to provoke, asserted BY NAME (ADR 0003): a count
    // of one rejection is satisfied by any rejection at all, including one the fixture did not plant.
    const staged = await sql<{ reason: string }[]>`
      select coalesce(w.outcome_detail, '') as "reason"
        from import_staging.import_row w
       where w.run_id = ${failed.runId}::uuid and w.state = 'rejected'
    `
    expect(staged.map((row) => row.reason)).toEqual([PROBE_REJECTIONS.amountNotInteger])
  })

  it('reports no money total for a source that states none, rather than zero', () => {
    const clean = sourceFor(CLEAN_SOURCE)
    // ADR 0070: `none_by_construction` is not `measured 0`. A probe file and a reconstruction workbook
    // with every price at nil would otherwise read identically.
    expect(clean.totalBasis).toBe('none_by_construction')
    expect(clean.sourceTotalFils).toBeNull()
    expect(clean.importedTotalFils).toBeNull()
    expect(clean.unreadableMoneyCells).toBe(0)
    // And no fils variance is stated for it at all, which is the other half of the same claim.
    expect(
      report.variances.some((entry) => entry.subject === `probe/${clean.sourceFileHash}/fils`),
    ).toBe(false)
  })
})

describe('the liability, the leave balance and the dedup counts', () => {
  it('states the package liability against what the ledger carries', () => {
    const variance = varianceFor('liability/package-deferred-revenue/fils')
    expect(variance.measure).toBe('fils')
    // Computed from different rows by different code, so the import is only right if they agree. No
    // named cause exists for a difference here by construction.
    expect(variance.explained).toEqual([])
    expect(report.liability.outstandingPackageLiabilityFils).toBe(variance.sourceFigure)
    expect(report.liability.packageDeferredRevenueFils).toBe(variance.importedFigure)
  })

  it('states the leave balance in days and refuses to state it in money', async () => {
    expect(report.liability.leaveLiabilityFils).toBeNull()
    expect(report.liability.leaveLiabilityBasis).toBe('unattributable')
    expect(report.liability.leaveLiabilityOpenQuestionId).toBe('Y8-staff')
    expect(report.liability.leaveOpeningBalanceHundredths).toBeTypeOf('number')
    // The control on the reason: every employment record is unpriced, so a money figure would be a sum
    // over an empty wage set reading as a workforce owed nothing (ADR 0070).
    const wages = await sql<{ priced: number }[]>`
      select count(*) filter (where basic_wage_fils is not null)::int as "priced" from employee
    `
    expect(wages[0]?.priced).toBe(0)
  })

  it('counts the lines a later line repeated as matched rather than created', () => {
    // The dedup figure the acceptance line asks for. `buildContactList` interleaves the repeats, and a
    // repeat is a DIFFERENT spelling of a number already in the file, so it is only visible to the
    // normaliser.
    expect(report.dedup.contactsCreated).toBeGreaterThanOrEqual(contactList.numbers.length)
    expect(report.dedup.contactsMatched).toBeGreaterThanOrEqual(contactList.duplicates)
    expect(report.dedup.contactRecords).toBe(
      report.dedup.contactsCreated +
        report.dedup.contactsMatched +
        report.dedup.contactsQuarantined,
    )
    expect(report.dedup.repeatedContactKeys).toBe(
      report.dedup.contactRecords - report.dedup.distinctContactKeys,
    )
    expect(report.dedup.consentClaimsDiscarded).toBeGreaterThanOrEqual(1)
  })
})

describe('every quarantined row', () => {
  it('is enumerated with its reason and its provenance', () => {
    const mine = report.quarantine.filter((row) => row.sourceFile === CONTACT_SOURCE)
    expect(mine).toHaveLength(contactList.quarantined)
    for (const row of mine) {
      expect(row.relation).toBe('public.imported_contact')
      expect(UNREADABLE_REASONS).toContain(row.reason)
      // The provenance, which is what makes the row actionable: the file, the line a person opens the
      // spreadsheet at, and the content hash that survives the file being re-saved.
      expect(row.sourceLine).toBeGreaterThan(0)
      expect(row.contentHash).toMatch(/^[a-f0-9]{64}$/)
      expect(row.runId).toMatch(/^[0-9a-f-]{36}$/)
      expect(row.importer).toBe('customers')
    }
    // Every planted reason appears, so the enumeration is not three of four.
    expect([...new Set(mine.map((row) => row.reason))].sort()).toEqual(
      [...UNREADABLE_REASONS].sort(),
    )
  })

  it('reconciles with the count the relation itself holds', () => {
    for (const relation of QUARANTINE_RELATIONS) {
      const entry = report.quarantineCounts.find((row) => row.relation === relation)
      expect(entry, relation).toBeDefined()
      expect(entry?.enumerated, relation).toBe(entry?.counted)
      expect(varianceFor(`quarantine/${relation}/rows`).unexplained, relation).toBe(0)
    }
  })
})

describe('a planted single-row discrepancy', () => {
  it('appears in the variance section and makes the exit status non-zero', async () => {
    const relation = 'public.imported_staff_row'
    const baseline = varianceFor(`quarantine/${relation}/rows`)
    expect(baseline.unexplained).toBe(0)

    await inRolledBackTransaction(async (handle) => {
      /*
        ONE row, quarantined, that no staged row explains.

        This is the discrepancy that cannot be planted any other way: `import_row` is immutable (ZY192)
        and `import_provenance` is append-only (ZY195), so a row cannot be taken OUT of the ledger — the
        only way a record and the ledger can disagree is a record that arrived from outside it, which is
        exactly what a hand-inserted row is. `employee_id` is null, so the `..._names_a_gendered_employee`
        constraint trigger has nothing to check and the row is legitimate as far as the schema goes.
      */
      await handle`
        insert into imported_staff_row (staff_reference, outcome, quarantine_reason)
        values (${`H-MIG-08-PLANTED-${NONCE}`}, 'quarantined', 'gender_not_recorded')
      `
      const planted = await generateReconciliationReport(handle)
      const variance = varianceFor(`quarantine/${relation}/rows`, planted)
      expect(variance.sourceFigure).toBe(baseline.sourceFigure + 1)
      expect(variance.importedFigure).toBe(baseline.importedFigure)
      // The whole unit in two assertions: one row, no named cause, and the report fails.
      expect(variance.unexplained).toBe(1)
      expect(variance.explained).toEqual([])
      expect(planted.unexplainedVariances).toBe(report.unexplainedVariances + 1)
      expect(reconciliationExitStatus(planted)).toBe(1)
      // And it is VISIBLE, not merely counted: the human-readable form names the subject and the figure.
      const text = renderReconciliationReport(planted)
      expect(text).toContain(`quarantine/${relation}/rows`)
      expect(text).toContain('VERDICT:')
      expect(text).toContain('no named cause accounts for')
    })

    // Rolled back: the relation is as it was, so no later execution of this file sees the plant.
    const after = await generateReconciliationReport(sql)
    expect(varianceFor(`quarantine/${relation}/rows`, after).unexplained).toBe(0)
  }, 30_000)
})

describe('the two forms of a real report', () => {
  it('carry the same figures', () => {
    const text = renderReconciliationReport(report)
    const figures = reportFigures(report)
    expect(figures.length).toBeGreaterThan(20)
    for (const figure of figures) {
      expect(text, figure.path).toContain(`${figure.path} = ${figure.value}`)
    }
    // The control: a figure this report does not hold is not in the text.
    expect(text).not.toContain('liability.leaveLiabilityFils = 0')
  })
})
