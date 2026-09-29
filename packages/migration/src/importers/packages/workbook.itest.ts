import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createConnection,
  PACKAGE_POLICY_SETTING_KEYS,
  readPackageReconstructionPolicy,
  readPackageTemplateKeys,
  readWorkbookPackageTemplates,
  type Sql,
  unconfirmedAssumptionRows,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PACKAGE_REJECTIONS, validatePackageWorkbook } from './validate.ts'
import {
  buildPackageWorkbook,
  fillPackageWorkbook,
  type PackageWorkbookRow,
  WORKBOOK_HEADER,
} from './workbook.ts'

/**
 * The settings half of H-MIG-02, against a real database: the template keys, the provisional terms, the CLIs.
 *
 * `validate.test.ts` proves every rule the validator applies, with nothing running, because the template keys
 * are an argument. This file proves the three things that argument depends on and that a pure test cannot
 * reach:
 *
 *   1. **The keys handed in are the keys the database holds** — including the two rows the till's sell list
 *      correctly hides, a retired template and a template with no version, which is the whole reason
 *      `readPackageTemplateKeys` exists alongside it.
 *   2. **The three package terms are provisional settings returned by the Unconfirmed Assumptions query**, and
 *      they are the ones the generated workbook prints on its face.
 *   3. **The commands work and their exit codes are the verdict** — which is the acceptance line "the
 *      validator exits non-zero on any rejected row and its report names every rejection with file and line",
 *      and an exit code cannot be asserted by calling a function.
 *
 * ## What this suite writes, and what it therefore deletes
 *
 * ONE `package_template` row, keyed with a nonce, and nothing else. It is deleted in `afterAll` by that key —
 * a scoped delete of a row this suite created, which needs no declaration (ADR 0050). It carries no version,
 * so it pins nothing: `package_template_version` and `package_template_line` are immutable (ZG001) and a
 * `package_sale` can never be deleted, so a suite that created either could not clean up without truncating
 * the family and taking the seeded fixture templates with it. One versionless row answers both of this
 * suite's data-shaped questions and is the only writable thing in the family that is also removable.
 *
 * Nothing else is written at all: the round trip below GENERATES a workbook and VALIDATES it, and validating
 * reads. The import itself is H-MIG-03's.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** From `packages/migration/src/importers/packages` up to the repository root. */
const REPO = join(import.meta.dirname, '..', '..', '..', '..', '..')

let sql: Sql
let scratch: string

/** Snake case, because `package_template_key_is_snake_case` (migration 0078) refuses anything else. */
const PROBE_TEMPLATE_KEY = `hmig02_probe_${randomUUID().replaceAll('-', '').slice(0, 10)}`

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  scratch = mkdtempSync(join(tmpdir(), 'hmig02-workbook-'))
  await sql`insert into package_template (template_key) values (${PROBE_TEMPLATE_KEY})`
})

afterAll(async () => {
  // Scoped to the one key this suite created. Issued before the pool closes and before the scratch
  // directory goes, so a failure in either is still a failure of this file rather than of the next one.
  await sql`delete from package_template where template_key = ${PROBE_TEMPLATE_KEY}`
  await sql.end({ timeout: 5 })
  rmSync(scratch, { recursive: true, force: true })
})

/** A synthetic holder on `+97159`, an unallocated UAE mobile prefix, so it can reach no handset. */
const holder = (index: number): string => `+97159${String(index).padStart(7, '0')}`

function rowsFor(templateKey: string, sessions: number, priceFils: string): PackageWorkbookRow[] {
  return [
    {
      holderPhoneE164: holder(201),
      templateKey,
      purchaseDate: '2025-02-14',
      pricePaidFils: priceFils,
      sessionsTotal: String(sessions),
      sessionsUsed: '0',
      sessionsRemaining: String(sessions),
      expiresOn: '2025-08-14',
      evidenceKind: 'receipt',
      evidenceReference: 'receipt 8102, front-desk folder',
      ownerSignedOff: 'yes',
      notes: '',
    },
    {
      holderPhoneE164: holder(202),
      templateKey,
      purchaseDate: '2025-03-01',
      pricePaidFils: priceFils,
      sessionsTotal: String(sessions),
      sessionsUsed: '1',
      sessionsRemaining: String(sessions - 1),
      expiresOn: '2025-09-01',
      evidenceKind: 'owner_attestation',
      evidenceReference: 'owner recalls the sale; no document of any kind',
      ownerSignedOff: 'yes',
      notes: 'Y9-package-thin',
    },
  ]
}

describe('the package templates the workbook is generated from', () => {
  it('returns every template key, including the one the sell list hides', async () => {
    const keys = await readPackageTemplateKeys(sql)
    const sellable = await readWorkbookPackageTemplates(sql)
    expect(keys.length, 'no package templates at all — the database is not seeded').toBeGreaterThan(
      0,
    )

    // The row this suite created: it EXISTS and has no version, which is a different answer from unknown.
    const probe = keys.find((row) => row.templateKey === PROBE_TEMPLATE_KEY)
    expect(probe, `${PROBE_TEMPLATE_KEY} was inserted and is not returned`).toBeDefined()
    expect(probe?.hasVersion).toBe(false)
    // And the sell list does NOT offer it, which is what makes the two reads different questions rather
    // than one query written twice.
    expect(sellable.map((row) => row.templateKey)).not.toContain(PROBE_TEMPLATE_KEY)
    // The control: the seeded templates DO have versions and ARE offered, so the assertions above are
    // separating two populations rather than answering the same way for everything.
    const seeded = keys.filter((row) => row.templateKey !== PROBE_TEMPLATE_KEY)
    expect(seeded.length).toBeGreaterThan(0)
    expect(seeded.every((row) => row.hasVersion)).toBe(true)
    expect(sellable.length).toBe(seeded.length)
  })

  it('keeps returning a RETIRED template, because the balances under it are still owed', async () => {
    await sql`
      update package_template set retired_at = now() where template_key = ${PROBE_TEMPLATE_KEY}
    `
    const retired = (await readPackageTemplateKeys(sql)).find(
      (row) => row.templateKey === PROBE_TEMPLATE_KEY,
    )
    expect(retired?.retired).toBe(true)
    // The point of the whole distinction: a retired template is still a template a reconstruction row may
    // name. Refusing it would leave a real outstanding liability unrecordable.
    expect(retired).toBeDefined()
    const sellable = await readWorkbookPackageTemplates(sql)
    expect(sellable.map((row) => row.templateKey)).not.toContain(PROBE_TEMPLATE_KEY)
    await sql`update package_template set retired_at = null where template_key = ${PROBE_TEMPLATE_KEY}`
    const live = (await readPackageTemplateKeys(sql)).find(
      (row) => row.templateKey === PROBE_TEMPLATE_KEY,
    )
    expect(live?.retired).toBe(false)
  })

  it('projects the four columns a person reads and drops the drawdown this system recorded', async () => {
    const [template] = await readWorkbookPackageTemplates(sql)
    expect(template).toBeDefined()
    expect(Object.keys(template ?? {}).sort()).toEqual([
      'priceFils',
      'publicDisplayName',
      'sessionCount',
      'templateKey',
    ])
    // Fils as digits, never a float (ADR 0007), and a real session count.
    expect(template?.priceFils).toMatch(/^\d+$/)
    expect(template?.sessionCount).toBeGreaterThan(0)
  })
})

describe('the provisional package terms on the workbook’s face', () => {
  it('are the three settings the Unconfirmed Assumptions query returns', async () => {
    const policy = await readPackageReconstructionPolicy(sql)
    // The acceptance line, asserted against the query itself rather than against a flag derived elsewhere.
    expect(policy.terms.isProvisional).toBe(true)
    expect(policy.unconfirmed.map((row) => row.key).sort()).toEqual(
      [...PACKAGE_POLICY_SETTING_KEYS].sort(),
    )
    for (const row of policy.unconfirmed) {
      expect(row.openQuestionId, `${row.key} is flagged and names no open question`).toBe(
        'Y9-package-policy',
      )
    }
    // And on the panel that reads settings AND data, which is a separate query with a separate clause.
    const panel = await unconfirmedAssumptionRows(sql)
    const onPanel = panel.filter((row) => row.source === 'app_setting').map((row) => row.reference)
    for (const key of PACKAGE_POLICY_SETTING_KEYS) expect(onPanel).toContain(key)
    // The control: the panel is not simply returning every setting there is. It reads `where
    // is_provisional`, so a CONFIRMED setting is absent from it — and without this line "all three are
    // there" would be satisfied by a query that returned the whole table.
    const settings = await sql<{ key: string }[]>`select key from app_setting`
    expect(settings.length).toBeGreaterThan(onPanel.length)
    expect(settings.map((row) => row.key).filter((key) => !onPanel.includes(key))).not.toEqual([])
  })

  it('are printed on the generated workbook, with the question id a reader can look up', async () => {
    const [templates, policy] = await Promise.all([
      readWorkbookPackageTemplates(sql),
      readPackageReconstructionPolicy(sql),
    ])
    const workbook = buildPackageWorkbook({ templates, terms: policy.terms })
    expect(workbook).toContain(`validity ${String(policy.terms.validityMonths)} months`)
    expect(workbook).toContain(policy.terms.unredeemedBalancePolicy)
    expect(workbook).toContain('NONE OF THE THREE IS CONFIRMED')
    expect(workbook).toContain('Y9-package-policy')
    expect(workbook).toContain('Y8-packages')
    for (const template of templates) expect(workbook).toContain(template.templateKey)
  })
})

describe('the round trip, against the templates the database holds', () => {
  it('generates a workbook, fills it, and validates it clean', async () => {
    const [templates, policy, keys] = await Promise.all([
      readWorkbookPackageTemplates(sql),
      readPackageReconstructionPolicy(sql),
      readPackageTemplateKeys(sql),
    ])
    const [template] = templates
    if (template === undefined) expect.unreachable('the seeded database holds no package template')
    const filled = fillPackageWorkbook(
      buildPackageWorkbook({ templates, terms: policy.terms }),
      rowsFor(template.templateKey, template.sessionCount, template.priceFils),
    )
    const report = validatePackageWorkbook({
      sourceFile: 'generated.tsv',
      sourceText: filled,
      templates: keys,
    })
    expect(report.rejections).toEqual([])
    expect(report.accepted).toBe(2)
    expect(report.attested).toBe(1)
  })

  it('refuses a row naming a template the database does not hold, and says which', async () => {
    const [templates, policy, keys] = await Promise.all([
      readWorkbookPackageTemplates(sql),
      readPackageReconstructionPolicy(sql),
      readPackageTemplateKeys(sql),
    ])
    const missing = 'no_such_package_hmig02'
    expect(keys.map((row) => row.templateKey)).not.toContain(missing)
    const filled = fillPackageWorkbook(
      buildPackageWorkbook({ templates, terms: policy.terms }),
      rowsFor(missing, 5, '100000'),
    )
    const report = validatePackageWorkbook({
      sourceFile: 'generated.tsv',
      sourceText: filled,
      templates: keys,
    })
    // Acceptance: no package row imports before its package_template row exists, and the attempt fails
    // naming the missing template. Both rows are refused and every one is refused BY THE TEMPLATE.
    expect(report.accepted).toBe(0)
    expect(report.rejections.map((entry) => entry.reason)).toEqual([
      PACKAGE_REJECTIONS.templateUnknown,
      PACKAGE_REJECTIONS.templateUnknown,
    ])
    // And the row that names the versionless template this suite created is refused differently, because
    // the template is there and the terms are not.
    const versionless = validatePackageWorkbook({
      sourceFile: 'generated.tsv',
      sourceText: fillPackageWorkbook(
        buildPackageWorkbook({ templates, terms: policy.terms }),
        rowsFor(PROBE_TEMPLATE_KEY, 5, '100000'),
      ),
      templates: keys,
    })
    expect(versionless.rejections.map((entry) => entry.reason)).toEqual([
      PACKAGE_REJECTIONS.templateWithoutVersion,
      PACKAGE_REJECTIONS.templateWithoutVersion,
    ])
  })
})

describe('the commands', () => {
  const tsx = (script: string, args: readonly string[]) =>
    execFileSync('pnpm', ['exec', 'tsx', script, ...args], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  /** `execFileSync` throws on a non-zero exit; this returns the status and both streams instead. */
  const tsxExpectingFailure = (
    script: string,
    args: readonly string[],
  ): { status: number; output: string } => {
    try {
      tsx(script, args)
      return { status: 0, output: '' }
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string }
      return { status: err.status ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    }
  }

  it('generate a workbook and then validate a clean copy of it, exiting zero', async () => {
    const path = join(scratch, 'packages.tsv')
    tsx('scripts/gen-package-workbook.mjs', ['--out', path])
    const blank = readFileSync(path, 'utf8')
    expect(blank).toContain(WORKBOOK_HEADER)

    const [template] = await readWorkbookPackageTemplates(sql)
    if (template === undefined) expect.unreachable('the seeded database holds no package template')
    writeFileSync(
      path,
      fillPackageWorkbook(
        blank,
        rowsFor(template.templateKey, template.sessionCount, template.priceFils),
      ),
    )
    const clean = tsx('scripts/validate-package-workbook.mjs', ['--file', path])
    expect(clean).toContain('clean:')
    expect(clean).toContain('2 accepted')
    expect(clean).toContain("rest on the owner's attestation alone")
    // Two cold `tsx` starts against a real database. The budget is explicit because the default is 5,000 ms
    // and this test's being slow is not a defect (brief rule 21).
  }, 90_000)

  it('exit non-zero on a rejected row and name every rejection with its file and line', async () => {
    const path = join(scratch, 'bad.tsv')
    const [template] = await readWorkbookPackageTemplates(sql)
    if (template === undefined) expect.unreachable('the seeded database holds no package template')
    const rows = rowsFor(template.templateKey, template.sessionCount, template.priceFils)
    const [first, second] = rows
    if (first === undefined || second === undefined) expect.unreachable('two rows were built')
    writeFileSync(
      path,
      fillPackageWorkbook(
        buildPackageWorkbook({
          templates: [template],
          terms: (await readPackageReconstructionPolicy(sql)).terms,
        }),
        [
          { ...first, sessionsUsed: String(template.sessionCount + 1) },
          { ...second, ownerSignedOff: '' },
        ],
      ),
    )
    const refused = tsxExpectingFailure('scripts/validate-package-workbook.mjs', ['--file', path])
    expect(refused.status).toBe(1)
    // Every rejection, with the file and the line. Both of them: a report that stopped at the first would
    // cost a second correcting pass over the spreadsheet, which is what the all-or-nothing rule is for.
    expect(refused.output).toContain(`${path}:`)
    expect(refused.output).toContain(PACKAGE_REJECTIONS.sessionsUsedExceedsTotal)
    expect(refused.output).toContain(PACKAGE_REJECTIONS.ownerSignOffMissing)
    expect(refused.output).toContain('REFUSED')
    expect(refused.output).toContain('Nothing would be imported')
  }, 90_000)

  it('refuse an edited header as a fact about the FILE, with a non-zero exit', async () => {
    const path = join(scratch, 'header.tsv')
    const [template] = await readWorkbookPackageTemplates(sql)
    if (template === undefined) expect.unreachable('the seeded database holds no package template')
    const policy = await readPackageReconstructionPolicy(sql)
    const filled = fillPackageWorkbook(
      buildPackageWorkbook({ templates: [template], terms: policy.terms }),
      rowsFor(template.templateKey, template.sessionCount, template.priceFils),
    )
    writeFileSync(
      path,
      filled.replace(WORKBOOK_HEADER, WORKBOOK_HEADER.replace('notes', 'remarks')),
    )
    const refused = tsxExpectingFailure('scripts/validate-package-workbook.mjs', ['--file', path])
    expect(refused.status).toBe(1)
    expect(refused.output).toContain('not the generated one')
    expect(refused.output).toContain('gen-package-workbook.mjs')
  }, 90_000)
})
