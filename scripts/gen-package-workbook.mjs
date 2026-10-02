#!/usr/bin/env node
/**
 * Generates the blank outstanding-package reconstruction workbook from what the database holds.
 *
 * ```
 * tsx scripts/gen-package-workbook.mjs                                   # to stdout
 * tsx scripts/gen-package-workbook.mjs --out artifacts/migration/packages.tsv
 * ```
 *
 * ## Why the workbook is generated rather than kept in the repository
 *
 * Its face carries two things only the database knows: the templates a row may name, and whether the three
 * package terms are still assumptions. A committed blank would be a copy of both — the second statement of a
 * fact this repository keeps paying for — and the failure would be the quiet one: a person fills in a stale
 * copy, names a template that has been re-keyed since, and the validator refuses every row in the file for a
 * reason that is about the copy rather than about anything they typed.
 *
 * ## The same bytes every time
 *
 * `buildPackageWorkbook` is pure: no timestamp, no run id, no serial number. Regenerating against an
 * unchanged database produces an IDENTICAL file, which matters because the identity of a source file in this
 * build is the sha-256 of its bytes (`import_run.source_file_hash`) and H-MIG-03's owner sign-off attests to
 * that hash. A generator that stamped the time would give every regeneration a different identity, so a
 * person who regenerated the blank before filling it in would hold a file no sign-off could be about.
 *
 * ## A database with no package template still produces a workbook
 *
 * It produces one whose reference block says NONE, in words, and every row written into it is then refused by
 * name. That is deliberate: the alternative is a generator that invents a template key to put in the list,
 * and what this business sells as a package is a fact nobody has stated (Y9-package-catalogue, brief rule
 * 15).
 *
 * Validating a filled copy is `scripts/validate-package-workbook.mjs`. It is a separate command because it is
 * a separate act: one is run once, by whoever sets the import up, and the other is run repeatedly by whoever
 * is correcting the spreadsheet, and its exit code is the verdict.
 */
import { writeFileSync } from 'node:fs'
import { createConnection } from '../packages/db/src/connection.ts'
import {
  readPackageReconstructionPolicy,
  readWorkbookPackageTemplates,
} from '../packages/db/src/settings/package-templates.ts'
import { buildPackageWorkbook } from '../packages/migration/src/importers/packages/workbook.ts'

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required: the workbook is generated from the templates it holds.')
  process.exit(2)
}

const sql = createConnection({ url, max: 2 })
let workbook
let templateCount = 0
try {
  const [templates, policy] = await Promise.all([
    readWorkbookPackageTemplates(sql),
    readPackageReconstructionPolicy(sql),
  ])
  templateCount = templates.length
  workbook = buildPackageWorkbook({ templates, terms: policy.terms })
} finally {
  await sql.end({ timeout: 5 })
}

const out = flag('out')
if (out) {
  writeFileSync(out, workbook)
  console.error(
    `Workbook written to ${out}: ${templateCount} template(s) a row may name. Fill it in, then run ` +
      `tsx scripts/validate-package-workbook.mjs --file ${out}`,
  )
} else {
  process.stdout.write(workbook)
}

// Non-zero when there is nothing to reconstruct against. The file is still written — it is the thing that
// says so — but a generator that exited zero over an empty reference block would be read by a script, or by
// a person skimming, as "the workbook is ready".
if (templateCount === 0) {
  console.error(
    'This database holds no package template with a version, so the workbook names none and no row ' +
      'written into it can be imported. Configure the packages the business sells first: the terms live on ' +
      'the template, and a balance with no terms is a number.',
  )
  process.exit(1)
}
