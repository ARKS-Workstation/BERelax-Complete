import { randomUUID } from 'node:crypto'
import { filsFrom, money, reconcileOpeningPackageCash } from '@berelax/core'
import {
  type Actor,
  createConnection,
  readCustomerPackageAttestation,
  readImportedPackageLiability,
  readPackageDeferredRevenueFils,
  readPackageTemplateKeys,
  recordPackageSignOff,
  type Sql,
  savePackageTemplateVersion,
  withUnitOfWork,
} from '@berelax/db'
import { fileHash, runImport } from '@berelax/migration'
import {
  buildPackageWorkbook,
  fillPackageWorkbook,
  packagesImporter,
} from '@berelax/migration/importers/packages'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { truncatePackageFamily } from './invoice-family.ts'
import {
  ATTESTATION_EVIDENCE_KIND,
  asReconstructedPackage,
  assertOpeningPostingAgrees,
  asWorkbookRow,
  expectedOutstandingFils,
  type LiabilityFixtureRow,
} from './package-liability.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * H-MIG-03's five acceptance lines, against a real PostgreSQL, each with a control that must fail.
 *
 * This is the only place they can be asserted. `packages/db` may never import `packages/core` and
 * `packages/migration` may import neither, so the importer, the arithmetic and the posting are in three
 * packages whose own suites can each see one of them; `packages/fixtures` may depend on all three.
 *
 * ## Why every row is unique per EXECUTION
 *
 * Two mechanisms refuse a second import of one row, both of them correctly:
 * `imported_package_sale_one_per_holder_template_purchase` refuses one `(holder, template, purchase date)`
 * twice even across two files, and the framework's idempotence skips a row whose content a COMPLETED run
 * has already applied. A suite re-using one set of holder numbers would therefore pass on its first run
 * and skip everything on its second — green, and measuring nothing. So the holder numbers and the template
 * keys carry a per-execution nonce, which is the arrangement `framework.itest.ts` uses and for the same
 * reason.
 *
 * Holders are on `+97159`, which is not an allocated UAE mobile prefix: a fixture number that could ring a
 * real handset eventually does (`synthetic.ts`, and H-MIG-02's fixtures give the same guarantee).
 *
 * ## The trading year is 2082
 *
 * No other suite and no gate posts into it — 2079, 2080, 2081, 2083 and 2084 upwards are taken, and
 * `package-redemption.itest.ts` lists the holders of the rest. 2078 is this unit's GATE block.
 *
 * ## What is a DELTA and what is a total
 *
 * `2050 Deferred revenue — packages` is read off `journal_line`, which is append-only (ADR 0008, and ZL001
 * refuses the DELETE) — so every assertion about it is a delta across the import and never a total. The
 * suite's own package rows ARE removed, through `truncatePackageFamily`, which is the one statement of that
 * closure and now includes `imported_package_sale`; the sign-off rows and the staging ledger are not,
 * because both are evidence that an import happened and neither is a suite's to clear.
 */

const ACTOR: Actor = { kind: 'system', label: 'H-MIG-03 package liability suite' }

/** The opening date: the business day the liability enters these books. */
const OPENING_DATE = '2082-04-03'

/** Unique per EXECUTION, so a second run of this file imports rows that hash differently. */
const RUN = `${process.pid.toString(36)}${randomUUID().slice(0, 6).replace(/-/g, '')}`

let sql: Sql
let variantId: string
let holderSeq = 0
let templateSeq = 0

/** A holder nobody can ring: `+97159` plus seven digits, inside E.164's 8-to-15 digit shape. */
function nextHolder(): string {
  holderSeq += 1
  const digits = `${(Date.now() % 10_000).toString().padStart(4, '0')}${holderSeq
    .toString()
    .padStart(3, '0')}`
  return `+97159${digits}`
}

beforeAll(async () => {
  sql = createConnection({ url, max: 8 })
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (
      ${OPENING_DATE}::date,
      (${OPENING_DATE}::date + time '11:00') at time zone 'Asia/Dubai',
      (${OPENING_DATE}::date + interval '1 day' + time '02:00') at time zone 'Asia/Dubai',
      'weekly'
    )
    on conflict (trading_date) do nothing
  `
  // A lock over 2082 left behind by another suite would refuse every entry here by ZL002, and every case
  // would report that instead of what it is about — gate 103's, 105's and the redemption pair's reason for
  // the same delete.
  await sql`delete from period_lock where starts_on >= '2082-01-01' and ends_on <= '2082-12-31'`

  const variants = await sql<{ id: string }[]>`
    select v.id from service_variant v join service s on s.id = v.service_id
     where s.archived_at is null
     order by v.id limit 1
  `
  const variant = variants[0]
  if (variant === undefined) throw new Error('the seed creates priced variants; run `pnpm seed`')
  variantId = variant.id
})

afterAll(async () => {
  if (sql !== undefined) await truncatePackageFamily(sql)
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await truncatePackageFamily(sql)
})

/** A single-line template with `sessions` sessions at `priceFils`, under the configured default terms. */
async function template(sessions: number, priceFils: number): Promise<string> {
  templateSeq += 1
  const key = `hmig03_${RUN}_${templateSeq}`
  await withUnitOfWork(sql, ACTOR, (uow) =>
    savePackageTemplateVersion(uow, {
      templateKey: key,
      internalName: `[confirm] H-MIG-03 reconstruction fixture ${templateSeq}; Y9-package-catalogue`,
      publicDisplayName: `[confirm] not a package this business sells; Y9-package-catalogue`,
      priceFils,
      lines: [{ serviceVariantId: variantId, sessionCount: sessions }],
    }),
  )
  return key
}

/** A holder with a customer record, which is what the importer refuses to create for itself. */
async function holder(): Promise<string> {
  const phone = nextHolder()
  await sql`
    insert into customer (phone_e164, created_via) values (${phone}, 'import')
    on conflict (phone_e164) do nothing
  `
  return phone
}

interface Workbook {
  readonly sourceFile: string
  readonly sourceText: string
  readonly sourceFileHash: string
  readonly rows: readonly LiabilityFixtureRow[]
  /** The line in the FILE each row landed on, which is what a variance report prints. */
  readonly lineNumbers: readonly number[]
}

/** Builds and fills a workbook from `rows`, exactly as a person hands one over. */
function workbookOf(rows: readonly LiabilityFixtureRow[]): Workbook {
  const blank = buildPackageWorkbook({
    templates: rows.map((row) => ({
      templateKey: row.templateKey,
      sessionCount: row.sessionsTotal,
      priceFils: String(row.pricePaidFils),
      publicDisplayName: '[confirm] Y9-package-catalogue',
    })),
    terms: {
      validityMonths: 6,
      transferable: false,
      unredeemedBalancePolicy: 'retained',
      isProvisional: true,
      openQuestionId: 'Y9-package-policy',
    },
  })
  const sourceText = fillPackageWorkbook(blank, rows.map(asWorkbookRow))
  const headerAt = sourceText.split('\n').findIndex((line) => !line.startsWith('#'))
  return {
    sourceFile: `artifacts/migration/package-liability-${RUN}.tsv`,
    sourceText,
    sourceFileHash: fileHash(sourceText),
    rows,
    lineNumbers: rows.map((_, index) => headerAt + 2 + index),
  }
}

/** Five reconstructions: untouched, part used, fully drawn, attested, and discounted. */
async function fixtureRows(): Promise<readonly LiabilityFixtureRow[]> {
  const a = await template(5, 100_000)
  const b = await template(3, 60_000)
  return [
    {
      holderPhoneE164: await holder(),
      templateKey: a,
      purchaseDate: '2082-01-11',
      pricePaidFils: 100_000,
      sessionsTotal: 5,
      sessionsUsed: 0,
      expiresOn: '2082-07-11',
      evidenceKind: 'receipt',
      evidenceReference: 'receipt 4417, front-desk folder',
      notes: '',
    },
    {
      holderPhoneE164: await holder(),
      templateKey: a,
      purchaseDate: '2082-02-02',
      pricePaidFils: 100_000,
      sessionsTotal: 5,
      sessionsUsed: 2,
      expiresOn: '2082-08-02',
      evidenceKind: 'whatsapp_message',
      evidenceReference: 'thread with the holder, 2082-02-02',
      notes: 'two sessions taken before this system existed',
    },
    {
      holderPhoneE164: await holder(),
      templateKey: b,
      purchaseDate: '2082-01-20',
      pricePaidFils: 60_000,
      sessionsTotal: 3,
      sessionsUsed: 3,
      expiresOn: '2082-07-20',
      evidenceKind: 'card_terminal_slip',
      evidenceReference: 'terminal batch 2082-01-20',
      notes:
        'fully drawn: nothing outstanding, kept because the history is what the holder asks about',
    },
    {
      holderPhoneE164: await holder(),
      templateKey: b,
      purchaseDate: '2082-01-05',
      pricePaidFils: 60_000,
      sessionsTotal: 3,
      sessionsUsed: 1,
      expiresOn: '2082-07-05',
      evidenceKind: ATTESTATION_EVIDENCE_KIND,
      evidenceReference: 'owner recalls the sale; no document of any kind',
      notes: 'Y9-package-thin: admitted on attestation alone',
    },
    {
      holderPhoneE164: await holder(),
      templateKey: a,
      purchaseDate: '2082-02-19',
      pricePaidFils: 95_000,
      sessionsTotal: 5,
      sessionsUsed: 1,
      expiresOn: '2082-08-19',
      evidenceKind: 'customer_copy',
      evidenceReference: 'holder has the stamped card',
      notes: 'paid less than the configured price; the discount is recorded nowhere else',
    },
  ]
}

const totalPaid = (rows: readonly LiabilityFixtureRow[]): number =>
  rows.reduce((running, row) => running + row.pricePaidFils, 0)

/** Records the owner's attestation for one workbook, with the cash figure a caller supplies. */
async function signOff(book: Workbook, cashReceivedFils: number): Promise<string> {
  const recorded = await withUnitOfWork(sql, ACTOR, (uow) =>
    recordPackageSignOff(uow, {
      importer: 'packages',
      sourceFileHash: book.sourceFileHash,
      signedBy: 'the owner, as recorded by the H-MIG-03 suite',
      signedOn: OPENING_DATE,
      statement:
        'I have read every row of this workbook and accept the balances in it as liabilities of the ' +
        'business.',
      rowsAttested: book.rows.length,
      totalPricePaidFils: totalPaid(book.rows),
      cashReceivedFils,
      openingDate: OPENING_DATE,
    }),
  )
  return recorded.signOffId
}

/** Runs the import with the template list read from the database, as the CLI does. */
async function importWorkbook(book: Workbook, mode: 'live' | 'dry-run' = 'live') {
  const templates = await readPackageTemplateKeys(sql)
  return runImport({
    sql,
    importer: packagesImporter({ templates }),
    sourceFile: book.sourceFile,
    sourceText: book.sourceText,
    mode,
    actor: ACTOR,
  })
}

const movementOf = async (entryId: string): Promise<ReadonlyMap<string, number>> => {
  const lines = await sql<{ accountCode: string; movement: string }[]>`
    select account_code as "accountCode",
           sum(debit_fils - credit_fils)::text as movement
      from journal_line where entry_id = ${entryId}
     group by account_code
  `
  return new Map(lines.map((line) => [line.accountCode, Number(line.movement)]))
}

describe('after import, the package liability equals the deferred-revenue account', () => {
  it('ties the sum of remaining package value to 2050, to the fils', async () => {
    const rows = await fixtureRows()
    const book = workbookOf(rows)
    await signOff(book, totalPaid(rows))

    const before = await readPackageDeferredRevenueFils(sql)
    const report = await importWorkbook(book)
    expect(report.state, JSON.stringify(report.rejections)).toBe('completed')
    expect(report.applied).toBe(5)

    // A DELTA, because `journal_line` only grows (ADR 0008) and other suites post into 2050 too.
    const after = await readPackageDeferredRevenueFils(sql)
    const expected = expectedOutstandingFils(rows)
    expect(expected).toBe(276_000)
    expect(after - before).toBe(expected)

    // And the same figure from the BALANCES, which is the other half of the acceptance line: the two are
    // computed from different rows by different code and the import is only right if they agree.
    const [liability] = await sql<{ remaining: string }[]>`
      select coalesce(sum(b.value_fils - b.released_fils), 0)::text as remaining
        from package_balance b join package_sale s on s.id = b.package_sale_id
       where s.reconstructed
    `
    expect(Number(liability?.remaining ?? '-1')).toBe(expected)

    // The control that makes the equality mean something: it is NOT the total paid, which is what an
    // import that credited the whole consideration would have produced.
    expect(after - before).not.toBe(totalPaid(rows))
  }, 30_000)

  it('posts the entry @berelax/core builds for the same figure, debit included', async () => {
    const rows = (await fixtureRows()).slice(1, 2)
    const book = workbookOf(rows)
    await signOff(book, totalPaid(rows))
    await importWorkbook(book)

    const report = await readImportedPackageLiability(sql, (await signOffIdOf(book)) ?? '')
    const [only] = report
    expect(only).toBeDefined()
    if (only?.journalEntryId == null) throw new Error('the imported row carries no journal entry')
    assertOpeningPostingAgrees({
      posted: await movementOf(only.journalEntryId),
      outstanding: money(filsFrom(only.remainingValueFils)),
      reconstructionId: only.reconstructionId,
      holderPhoneE164: only.holderPhoneE164,
      templateKey: only.templateKey,
      openingDate: OPENING_DATE,
    })
    // The control: the pairing is sensitive to the account, so a wrong counterpart is caught. 6140 is the
    // cash over/short account and is not equity.
    expect(() =>
      assertOpeningPostingAgrees({
        posted: new Map([
          ['6140', only.remainingValueFils],
          ['2050', -only.remainingValueFils],
        ]),
        outstanding: money(filsFrom(only.remainingValueFils)),
        reconstructionId: only.reconstructionId,
        holderPhoneE164: only.holderPhoneE164,
        templateKey: only.templateKey,
        openingDate: OPENING_DATE,
      }),
    ).toThrow(/not the one @berelax\/core builds/)
  }, 30_000)

  it('imports a fully drawn package with no sale, no balance and no posting', async () => {
    const rows = (await fixtureRows()).slice(2, 3)
    const book = workbookOf(rows)
    await signOff(book, totalPaid(rows))

    const before = await readPackageDeferredRevenueFils(sql)
    const report = await importWorkbook(book)
    expect(report.state).toBe('completed')
    expect(report.applied).toBe(1)
    // Nothing is outstanding, so nothing was credited: a fully drawn package owes nothing.
    expect((await readPackageDeferredRevenueFils(sql)) - before).toBe(0)

    const [only] = await readImportedPackageLiability(sql, (await signOffIdOf(book)) ?? '')
    expect(only?.packageSaleId).toBeNull()
    expect(only?.sessionsRemaining).toBe(0)
    expect(only?.remainingValueFils).toBe(0)
    // But the cash it took is still attested, which is why the row exists at all.
    expect(only?.pricePaidFils).toBe(60_000)
  }, 30_000)
})

describe('no output VAT is posted at import', () => {
  it('leaves the VAT accounts and every revenue account untouched', async () => {
    const rows = await fixtureRows()
    const book = workbookOf(rows)
    await signOff(book, totalPaid(rows))

    const movementIn = async (): Promise<ReadonlyMap<string, number>> => {
      // A LEFT JOIN from `account`, so an account with NO lines appears with zero rather than being
      // absent. The first version joined the other way and the floor below caught it: in a database where
      // nothing had posted revenue yet the query returned no rows at all, so "every revenue account is
      // unmoved" was true of the empty set — which is the shape of pass ADR 0002 is about.
      const lines = await sql<{ code: string; movement: string }[]>`
        select a.code, coalesce(sum(l.debit_fils + l.credit_fils), 0)::text as movement
          from account a
          left join journal_line l on l.account_code = a.code
         where a.type = 'revenue' or a.code in ('2030', '2035', '1080')
         group by a.code
      `
      return new Map(lines.map((line) => [line.code, Number(line.movement)]))
    }
    const before = await movementIn()
    await importWorkbook(book)
    const after = await movementIn()

    // Movement measured as debits PLUS credits and not the net, ZG005's reason: an entry crediting 4010
    // and debiting the contra 4095 by the same figure nets to zero and has recognised revenue.
    for (const [code, total] of after) {
      expect(total - (before.get(code) ?? 0), `account ${code} moved`).toBe(0)
    }
    expect(
      after.size,
      'no VAT or revenue account was read, so this case measured nothing',
    ).toBeGreaterThan(5)

    // The control, and the acceptance line's second half: redemption IS the taxable event, which is a
    // claim about where 2030 is moved from. 0083's ZG008 is the rule, and the only writer that can move
    // 2030 for a package is `package_redemption` — asserted structurally, because this suite posts no
    // redemption and a case that asserted "2030 moved" would have to.
    const [vatWriters] = await sql<{ n: string }[]>`
      select count(*)::text as n
        from journal_line l join journal_entry e on e.entry_id = l.entry_id
       where l.account_code = '2030' and e.source = 'opening_balance'
    `
    expect(Number(vatWriters?.n ?? '-1')).toBe(0)
  }, 30_000)
})

describe('the owner sign-off', () => {
  it('refuses the import when nobody has signed for the file', async () => {
    const rows = (await fixtureRows()).slice(0, 1)
    const book = workbookOf(rows)
    // No sign-off recorded.
    await expect(importWorkbook(book)).rejects.toThrow(/No owner sign-off is recorded/)

    // Nothing was applied, and the run is left open rather than completed — so the file can be imported
    // once a signature exists, which is the framework's resume path.
    const [counts] = await sql<{ applied: string }[]>`
      select count(*)::text as applied
        from import_staging.import_row w join import_staging.import_run r on r.id = w.run_id
       where r.source_file_hash = ${book.sourceFileHash} and w.state = 'applied'
    `
    expect(Number(counts?.applied ?? '-1')).toBe(0)
    expect(
      (await sql`select 1 from package_sale where reconstructed`).length,
      'a refused import wrote a reconstructed sale',
    ).toBe(0)

    // The control: the same file imports once the owner has signed for it, so the refusal above is about
    // the signature and not about the file.
    await signOff(book, totalPaid(rows))
    const report = await importWorkbook(book)
    expect(report.state).toBe('completed')
    expect(report.applied).toBe(1)
  }, 30_000)

  it('is stored immutably against the hash of the file it attests to', async () => {
    const rows = (await fixtureRows()).slice(0, 1)
    const book = workbookOf(rows)
    const signOffId = await signOff(book, totalPaid(rows))

    const [stored] = await sql<{ hash: string }[]>`
      select source_file_hash as hash from import_staging.import_sign_off where id = ${signOffId}::uuid
    `
    expect(stored?.hash).toBe(book.sourceFileHash)
    expect(stored?.hash).toBe(fileHash(book.sourceText))

    // Immutably: ZY251 for both events, for every role including the owner this suite connects as.
    await expect(
      sql`update import_staging.import_sign_off set signed_by = 'somebody else' where id = ${signOffId}::uuid`,
    ).rejects.toMatchObject({ code: 'ZY251' })
    await expect(
      sql`delete from import_staging.import_sign_off where id = ${signOffId}::uuid`,
    ).rejects.toMatchObject({ code: 'ZY251' })
  }, 30_000)

  it('refuses a signature for a file whose prices do not sum to the cash received', async () => {
    const rows = await fixtureRows()
    const book = workbookOf(rows)
    // One fils, in either direction. The acceptance line's figure.
    for (const cash of [totalPaid(rows) - 1, totalPaid(rows) + 1]) {
      await expect(signOff(book, cash), `cash ${cash}`).rejects.toMatchObject({ code: '23514' })
    }
    // So no signature exists, and the import is blocked.
    await expect(importWorkbook(book)).rejects.toThrow(/No owner sign-off is recorded/)

    // And the variance report names every contributing row, which the constraint cannot: it knows the two
    // figures disagree and not which of five lines somebody mistyped.
    const reconciliation = reconcileOpeningPackageCash({
      rows: rows.map((row, index) => asReconstructedPackage(row, book.lineNumbers[index] ?? 0)),
      cashReceived: money(filsFrom(totalPaid(rows) - 1)),
      attestationEvidenceKind: ATTESTATION_EVIDENCE_KIND,
    })
    expect(reconciliation.ok).toBe(false)
    expect(reconciliation.varianceFils).toBe(1)
    expect(reconciliation.contributions).toHaveLength(5)

    // The control: the same five rows reconcile when the cash is right, so the refusal is about the figure.
    await expect(signOff(book, totalPaid(rows))).resolves.toBeTruthy()
  }, 30_000)
})

describe('a package admitted on attestation alone is flagged', () => {
  it('flags it in the liability report and on the customer record', async () => {
    const rows = await fixtureRows()
    const book = workbookOf(rows)
    const signOffId = await signOff(book, totalPaid(rows))
    await importWorkbook(book)

    const report = await readImportedPackageLiability(sql, signOffId)
    expect(report).toHaveLength(5)
    const attested = report.filter((row) => row.admittedOnAttestation)
    expect(attested).toHaveLength(1)
    expect(attested[0]?.evidenceKind).toBe(ATTESTATION_EVIDENCE_KIND)
    // The flag is on the ROW that rests on a recollection and on no other, which is the claim — a report
    // that flagged everything would satisfy "the flag is visible" and say nothing.
    expect(report.filter((row) => !row.admittedOnAttestation)).toHaveLength(4)

    // Every row resolves to the line of the file it was typed on, which is what makes the report evidence.
    for (const row of report) {
      expect(row.sourceFile).toBe(book.sourceFile)
      expect(row.sourceLine).toBeGreaterThan(0)
      expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/)
      expect(row.signedBy).toContain('the owner')
    }

    // On the customer record: the holder of the attested package, and nobody else.
    const attestedHolder = attested[0]?.customerId
    expect(attestedHolder).toBeTruthy()
    const flags = await readCustomerPackageAttestation(sql, attestedHolder ?? '')
    expect(flags?.hasAttestedPackage).toBe(true)
    expect(flags?.attestedPackageCount).toBe(1)
    expect(flags?.importedPackageCount).toBe(1)

    const documented = report.find((row) => !row.admittedOnAttestation && row.customerId !== null)
    const otherFlags = await readCustomerPackageAttestation(sql, documented?.customerId ?? '')
    expect(otherFlags?.hasAttestedPackage).toBe(false)
    expect(otherFlags?.attestedPackageCount).toBe(0)
  }, 30_000)
})

describe('the import rehearses and resumes', () => {
  it('changes nothing in a dry run and imports the same rows afterwards', async () => {
    const rows = await fixtureRows()
    const book = workbookOf(rows)
    await signOff(book, totalPaid(rows))

    const before = await readPackageDeferredRevenueFils(sql)
    const rehearsal = await importWorkbook(book, 'dry-run')
    expect(rehearsal.state).toBe('completed')
    expect(rehearsal.applied).toBe(5)
    expect(rehearsal.committed).toBe(false)
    // The rehearsal rolled back, including its own run row — so the live run below applies the same rows
    // for the first time rather than skipping them as already imported.
    expect(await readPackageDeferredRevenueFils(sql)).toBe(before)
    expect((await sql`select 1 from package_sale where reconstructed`).length).toBe(0)

    const live = await importWorkbook(book)
    expect(live.applied).toBe(5)
    expect(await readPackageDeferredRevenueFils(sql)).toBe(before + expectedOutstandingFils(rows))
  }, 30_000)

  it('refuses a row whose holder is not a customer, naming H-MIG-04', async () => {
    const [first] = await fixtureRows()
    if (first === undefined) throw new Error('no fixture row')
    const unknown: LiabilityFixtureRow = { ...first, holderPhoneE164: nextHolder() }
    const book = workbookOf([unknown])
    await signOff(book, unknown.pricePaidFils)
    await expect(importWorkbook(book)).rejects.toThrow(/CustomerUnknown/)
    // The control: the row imports once the customer exists, so the refusal is about the record and not
    // about the row.
    await sql`
      insert into customer (phone_e164, created_via) values (${unknown.holderPhoneE164}, 'import')
    `
    expect((await importWorkbook(book)).applied).toBe(1)
  }, 30_000)
})

/** The sign-off for a workbook, read back rather than carried, so the query under test is the view's. */
async function signOffIdOf(book: Workbook): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    select id from import_staging.import_sign_off
     where importer = 'packages' and source_file_hash = ${book.sourceFileHash}
  `
  return rows[0]?.id ?? null
}
