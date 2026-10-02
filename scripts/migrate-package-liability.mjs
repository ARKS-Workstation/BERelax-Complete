#!/usr/bin/env node
/**
 * Imports the outstanding package liability out of a signed reconstruction workbook, or rehearses it.
 *
 * ```
 * # 1. the owner signs for the file. The cash figure comes from the business, not from the file.
 * tsx scripts/migrate-package-liability.mjs sign --file packages.tsv \
 *   --signed-by "<as the signer identifies themselves>" --cash-received-fils 415000 \
 *   --opening-date 2026-10-01 --statement "I accept the balances in this workbook as liabilities"
 *
 * # 2. rehearse, then import.
 * tsx scripts/migrate-package-liability.mjs import --file packages.tsv --dry-run
 * tsx scripts/migrate-package-liability.mjs import --file packages.tsv --actor "<who ran it>" \
 *   --report artifacts/migration/package-liability.json
 * ```
 *
 * ## Why this exists beside `scripts/migrate-import.mjs`
 *
 * That command is the generic door and it still runs this importer: `packages` is in `IMPORTERS` and needs
 * no options, because everything it reads it reads inside the transaction the framework hands its `apply`.
 * What that command cannot do is the two things either side of the run:
 *
 *   1. **record the sign-off**, which is a human act with four values nobody may default (brief rule 15),
 *      and which is what the import refuses to proceed without;
 *   2. **print the variance report**, which lists every row contributing to the file's total when the file
 *      and the cash received disagree. `import_sign_off_reconciles_to_the_cash_received` refuses the
 *      SIGNATURE in that case — the figures are held equal in the database, so a non-reconciling
 *      reconstruction cannot be signed for and therefore cannot be imported — but a CHECK can only say
 *      that two figures differ, not which of forty lines somebody mistyped. So the report is printed here,
 *      before the refusal, by `formatOpeningPackageVariance` in `@berelax/core`.
 *
 * It also writes the hand-over artefact H-MIG-07 reads: the package liability and the cash it rests on, so
 * the opening trial balance can tie to both "to the fils" as that unit's acceptance requires.
 *
 * ## Exit codes
 *
 *   0  the sign-off was recorded, or the import completed (or the rehearsal did, having changed nothing).
 *   1  the file was rejected, the figures do not reconcile, or the import refused a row. Nothing was
 *      imported in any of the three cases: a workbook is all-or-nothing, because the artefacts are
 *      liabilities and a half-imported set is a deferred-revenue figure nobody can reconcile.
 *   2  the command could not run: a missing argument, no database.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import {
  filsFrom,
  formatOpeningPackageVariance,
  localDate,
  money,
  reconcileOpeningPackageCash,
} from '../packages/core/src/index.ts'
import { createConnection } from '../packages/db/src/connection.ts'
import {
  readImportedPackageLiability,
  readPackageDeferredRevenueFils,
  readPackageSignOff,
  recordPackageSignOff,
} from '../packages/db/src/services/import-package-liability.ts'
import { readPackageTemplateKeys } from '../packages/db/src/settings/package-templates.ts'
import { withUnitOfWork } from '../packages/db/src/tx.ts'
import { runImport } from '../packages/migration/src/framework.ts'
import { packagesImporter } from '../packages/migration/src/importers/packages/import.ts'
import {
  EVIDENCE_KINDS,
  formatWorkbookRejections,
  validatePackageWorkbook,
} from '../packages/migration/src/importers/packages/index.ts'
import { fileHash } from '../packages/migration/src/provenance.ts'

const IMPORTER = 'packages'
/** H-MIG-02's vocabulary value for "no document of any kind". Read, never respelled. */
const ATTESTATION = EVIDENCE_KINDS.find((kind) => kind === 'owner_attestation')

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}
const present = (name) => process.argv.includes(`--${name}`)

const command = process.argv[2]
const file = flag('file')
const usage =
  'Usage:\n' +
  '  tsx scripts/migrate-package-liability.mjs sign --file <path> --signed-by <who> \\\n' +
  '      --cash-received-fils <n> --opening-date <YYYY-MM-DD> --statement <what is accepted>\n' +
  '  tsx scripts/migrate-package-liability.mjs import --file <path> [--dry-run] [--actor <who>] \\\n' +
  '      [--report <path>]\n'

if ((command !== 'sign' && command !== 'import') || !file) {
  console.error(usage)
  process.exit(2)
}

const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required.')
  process.exit(2)
}

// The BYTES, hashed as they are. The file's identity is what arrived, not what a decoder made of it — and
// that hash is what the owner's signature is about.
const bytes = readFileSync(file)
const sourceText = bytes.toString('utf8')
const sourceFileHash = fileHash(bytes)

const sql = createConnection({ url, max: 2 })
let exitCode = 0

try {
  const templates = await readPackageTemplateKeys(sql)
  const validation = validatePackageWorkbook({ sourceFile: file, sourceText, templates })
  if (!validation.ok) {
    console.error(
      `${file} has ${validation.rejections.length} rejected row(s) of ${validation.rows}. Nothing is ` +
        'imported until every one is corrected: a half-imported set of package balances is a ' +
        'deferred-revenue figure nobody can reconcile.',
    )
    for (const line of formatWorkbookRejections(validation)) console.error(`  ${line}`)
    process.exit(1)
  }

  /*
    The reconciliation, over the rows the file actually holds.

    The figures are taken from `validation` rather than recomputed, so the total the sign-off records is the
    same total the validator counted — which is what makes the sign-off's `total_price_paid_fils` worth
    comparing against anything.
  */
  const parsed = validation
  const rows = []
  {
    const importer = packagesImporter({ templates })
    for (const staged of importer.parse(sourceText)) {
      const cell = (key) => (typeof staged.payload[key] === 'string' ? staged.payload[key] : '')
      rows.push({
        lineNumber: staged.lineNumber,
        holderPhoneE164: cell('holderPhoneE164'),
        templateKey: cell('templateKey'),
        purchaseDate: localDate(cell('purchaseDate')),
        pricePaid: money(filsFrom(Number.parseInt(cell('pricePaidFils'), 10))),
        sessionsTotal: Number.parseInt(cell('sessionsTotal'), 10),
        sessionsUsed: Number.parseInt(cell('sessionsUsed'), 10),
        expiresOn: localDate(cell('expiresOn')),
        evidenceKind: cell('evidenceKind'),
      })
    }
  }

  if (command === 'sign') {
    const signedBy = flag('signed-by')
    const statement = flag('statement')
    const openingDate = flag('opening-date')
    const cash = flag('cash-received-fils')
    if (!signedBy || !statement || !openingDate || !cash) {
      console.error(
        'sign needs --signed-by, --statement, --opening-date and --cash-received-fils. None of the four ' +
          'is defaulted: a plausible-looking value here is indistinguishable from a true one, and this ' +
          'row is the whole of "who accepted these balances as liabilities of the business".\n' +
          usage,
      )
      process.exit(2)
    }

    const reconciliation = reconcileOpeningPackageCash({
      rows,
      cashReceived: money(filsFrom(Number.parseInt(cash, 10))),
      attestationEvidenceKind: ATTESTATION ?? 'owner_attestation',
    })
    if (!reconciliation.ok) {
      // Printed BEFORE the refusal, because the refusal cannot say which row to look at. The database
      // refuses the signature as well (`import_sign_off_reconciles_to_the_cash_received`), so this is the
      // report and not the enforcement.
      for (const line of formatOpeningPackageVariance(reconciliation, file)) console.error(line)
      process.exit(1)
    }

    const existing = await readPackageSignOff(sql, IMPORTER, sourceFileHash)
    if (existing !== null) {
      console.log(
        `This file is already signed for: sign-off ${existing.signOffId}, by ${existing.signedBy} on ` +
          `${existing.signedOn}. A signature is about the bytes of one file and is immutable (ZY251); a ` +
          'corrected workbook has a different hash and needs its own.',
      )
      process.exit(0)
    }

    const recorded = await withUnitOfWork(
      sql,
      { kind: 'system', label: `package liability sign-off (${signedBy})` },
      (uow) =>
        recordPackageSignOff(uow, {
          importer: IMPORTER,
          sourceFileHash,
          signedBy,
          signedOn: openingDate,
          statement,
          rowsAttested: parsed.rows,
          totalPricePaidFils: Number(parsed.totalPricePaidFils),
          cashReceivedFils: Number.parseInt(cash, 10),
          openingDate,
        }),
    )
    console.log(
      `Sign-off ${recorded.signOffId} recorded for ${file} (sha-256 ${sourceFileHash}): ` +
        `${recorded.rowsAttested} row(s), ${recorded.totalPricePaidFils} fils, opening on ` +
        `${recorded.openingDate}. ${reconciliation.totalOutstanding.fils} fils of that is still ` +
        `outstanding and will be credited to 2050; ${reconciliation.attestedRows} row(s) rest on the ` +
        "owner's recollection alone and are flagged (Y9-package-thin).",
    )
    process.exit(0)
  }

  const mode = present('dry-run') ? 'dry-run' : 'live'
  const actor = flag('actor')
  if (mode === 'live' && !actor) {
    console.error(
      '--actor is required for a live import. It is recorded on the run and on every audit row, so that ' +
        '"who imported this figure" has an answer — and it is not defaulted, because a plausible-looking ' +
        'value is indistinguishable from a true one.',
    )
    process.exit(2)
  }

  const signOff = await readPackageSignOff(sql, IMPORTER, sourceFileHash)
  if (signOff === null) {
    console.error(
      `No owner sign-off is recorded for ${file} (sha-256 ${sourceFileHash}). Record one with the \`sign\` ` +
        'command first: a reconstructed package liability is a figure nobody can defend unless the owner ' +
        'has read the workbook and accepted the balances in it, and the sign-off is also where the ' +
        'opening date and the cash actually received come from.',
    )
    process.exit(1)
  }
  if (Number(parsed.totalPricePaidFils) !== signOff.totalPricePaidFils) {
    console.error(
      `The sign-off for this file attests to ${signOff.totalPricePaidFils} fils over ` +
        `${signOff.rowsAttested} row(s) and the file totals ${parsed.totalPricePaidFils} fils over ` +
        `${parsed.rows}. The signature is about these bytes, so the totals cannot differ — one of them ` +
        'was typed. Re-sign, or correct the file and sign the corrected one.',
    )
    process.exit(1)
  }

  const before = await readPackageDeferredRevenueFils(sql)
  const report = await runImport({
    sql,
    importer: packagesImporter({ templates }),
    sourceFile: file,
    sourceText,
    sourceBytes: bytes,
    mode,
    actor: { kind: 'system', label: actor ?? 'dry-run rehearsal' },
  })
  const after = await readPackageDeferredRevenueFils(sql)
  const liability = await readImportedPackageLiability(sql, signOff.signOffId)

  const artefact = {
    importer: IMPORTER,
    importerVersion: report.importerVersion,
    runId: report.runId,
    mode: report.mode,
    committed: report.committed,
    state: report.state,
    sourceFile: file,
    sourceFileHash,
    signOff: {
      id: signOff.signOffId,
      signedBy: signOff.signedBy,
      signedOn: signOff.signedOn,
      rowsAttested: signOff.rowsAttested,
      totalPricePaidFils: signOff.totalPricePaidFils,
      cashReceivedFils: signOff.cashReceivedFils,
      openingDate: signOff.openingDate,
    },
    // What H-MIG-07 has to tie to, "to the fils": the liability this import credited to 2050, and the cash
    // the owner attests was received for it. The cash is NOT posted here — it is that unit's opening asset,
    // and debiting it twice is the one error in an opening position that is undetectable afterwards.
    openingDeferredRevenueFils: after - before,
    cashReceivedFils: signOff.cashReceivedFils,
    rowsImported: report.applied,
    rowsSkipped: report.skipped,
    attestedRows: liability.filter((row) => row.admittedOnAttestation).length,
    fullyDrawnRows: liability.filter((row) => row.packageSaleId === null).length,
    rejections: report.rejections,
    liability: liability.map((row) => ({
      reconstructionId: row.reconstructionId,
      packageSaleId: row.packageSaleId,
      holderPhoneE164: row.holderPhoneE164,
      templateKey: row.templateKey,
      purchaseDate: row.purchaseDate,
      statedExpiresOn: row.statedExpiresOn,
      pricePaidFils: row.pricePaidFils,
      sessionsTotalAttested: row.sessionsTotalAttested,
      sessionsUsedAttested: row.sessionsUsedAttested,
      remainingValueFils: row.remainingValueFils,
      admittedOnAttestation: row.admittedOnAttestation,
      evidenceKind: row.evidenceKind,
      sourceLine: row.sourceLine,
      contentHash: row.contentHash,
    })),
  }

  const reportPath = flag('report')
  if (reportPath) {
    writeFileSync(reportPath, `${JSON.stringify(artefact, null, 2)}\n`)
    console.log(`Liability report written to ${reportPath}`)
  } else {
    console.log(JSON.stringify(artefact, null, 2))
  }

  console.log(
    `${report.mode} ${report.state}: ${report.applied} applied, ${report.skipped} skipped, ` +
      `${report.rejected} rejected, ${report.pending} pending — run ${report.runId}` +
      `${report.committed ? '' : ' (rolled back: nothing was changed)'}. 2050 Deferred revenue moved by ` +
      `${after - before} fils.`,
  )
  for (const rejection of report.rejections) {
    console.log(`  rejected  ${file}:${rejection.lineNumber}  ${rejection.reason}`)
  }
  exitCode = report.rejected > 0 || report.state === 'failed' ? 1 : 0
} finally {
  await sql.end({ timeout: 5 })
}

process.exit(exitCode)
