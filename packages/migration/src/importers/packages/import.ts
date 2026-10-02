import { randomUUID } from 'node:crypto'
import type { UnitOfWork } from '@berelax/db'
import {
  CustomerUnknown,
  importReconstructedPackage,
  readPackageSignOff,
  readReconstructionTemplate,
  resolveHolder,
  TemplateCannotCarryReconstruction,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { ImporterDefinition, RowVerdict, StagedSourceRow } from '../../framework.ts'
import { contentHash, type ImportedEntity } from '../../provenance.ts'
import {
  createPackageWorkbookValidator,
  type KnownPackageTemplate,
  PACKAGE_REJECTIONS,
} from './validate.ts'
import { type PackageWorkbookRow, parsePackageWorkbook, WORKBOOK_PAYLOAD_KEYS } from './workbook.ts'

/**
 * The `apply` half of the package importer — H-MIG-03, and the highest-risk artefact in this migration.
 *
 * H-MIG-02 built the workbook, the parser and the validator and left three things: this entry in
 * `IMPORTERS`, the owner sign-off that attests to `import_run.source_file_hash`, and the attestation flag
 * on the customer record and in the liability report. `0119_migration_signoff.sql`'s header carries the
 * decision about what a reconstructed sale IS and why; this file is the resolution of names in front of it.
 *
 * ## What `apply` does, and what it refuses
 *
 * Every figure comes from a cell a human filled in. Nothing here invents a customer, a template, a
 * balance, an expiry or an opening date, and each of the five is a REFUSAL instead:
 *
 *   - **the holder** must already be a `customer`. Creating one would go round H-MIG-04's consent floor —
 *     "every imported customer gets marketing_consent = false with no flag able to change it" — so a
 *     reconstruction whose holder is unknown names that unit and stops.
 *   - **the template** must exist, must have a version, and must have exactly ONE line. The last of those
 *     is not a limitation of this code: the workbook states one session count for the whole package and
 *     nothing in it says which line a taken session came from, so a two-line template cannot be
 *     apportioned without inventing which treatments the holder had.
 *   - **the owner's sign-off** must exist for the bytes of the file being imported. It carries the opening
 *     date and the cash figure, so a run without one has no date to file the liability on and no figure to
 *     reconcile against — which is H-MIG-03's fourth acceptance line, refused before anything is applied.
 *   - **the balance, the expiry and the price** are the workbook's and are written as they stand. ZY257
 *     holds the sale equal to them and ZG005 holds the posting to the liability, so this file cannot
 *     quietly round one.
 *
 * ## Why the sign-off is found through the STAGED ROW, and ZY256 is the one that matters
 *
 * `ImporterDefinition.apply` is handed a unit of work and a payload — not the run, not the file, not its
 * hash — so {@link stagedSourceFileHash} finds the run from the only thing in hand, the row's own content
 * hash among the rows still pending. The first version asked instead for "the open run of this importer",
 * and the integration suite found what is wrong with that: a run that fails part-way stays `running` by
 * design, so after one failed import every later import of every other file was refused for a reason that
 * had nothing to do with it.
 *
 * Either way the lookup is a convenience and not the guarantee. The guarantee is ZY256, a DEFERRED trigger
 * that walks from the row this import wrote, through `import_staging.entity_provenance`, to the run that
 * actually produced it, and refuses the COMMIT unless that run's `source_file_hash` is the one the
 * signature names. A wrong answer here cannot commit.
 *
 * ## Why the registry entry needs no options
 *
 * `IMPORTERS` is a module-level frozen array, so a registered importer cannot have read anything when it
 * is constructed. Everything this one needs is therefore read inside `apply`, from the transaction it was
 * handed. The one thing that cannot be is the template list H-MIG-02's validator wants, because
 * `validate` is synchronous and runs at staging time over every row — so `templates` is OPTIONAL:
 *
 *   - supplied (the CLI, which has already read them, and the tests), the two template reasons are
 *     REJECTIONS and the report names every bad line of the file at once;
 *   - omitted, the validator is built from the keys the FILE names — so those two cannot fire at staging —
 *     and the real question is asked at apply time instead, carrying the SAME vocabulary value in the
 *     message.
 *
 * One vocabulary, two enforcement points, and the second one names the first's constant rather than
 * re-wording it. `import.test.ts` asserts that the deferral reaches exactly those two reasons and that
 * every other fixture is still refused by name — which is the case that caught the first version of it.
 */

export const PACKAGES_IMPORTER_NAME = 'packages'

/**
 * The importer's own version, recorded on every run.
 *
 * `2` and not `1`: H-MIG-02 shipped the parser and the validator as version 1 of this importer's reading
 * of a workbook, and the figures a row produces in the ledger — which is what an importer version exists
 * to make investigable (0111) — are this file's. An imported liability that disagrees with what the owner
 * believes has to be traceable to the code that wrote it as well as to the row it was read from.
 */
export const PACKAGES_IMPORTER_VERSION = '2'

/**
 * The tables this importer writes, schema-qualified and complete: ZY194 refuses provenance for anything
 * not in this list, and the report's before/after checksums are taken over exactly it.
 *
 * `journal_line` is deliberately absent although the import writes it. `import_staging.unprovenanced_row_ids`
 * — which the framework's report calls for every declared target — raises ZY199 on a relation without a
 * single-column primary key, and `journal_line` is keyed on `(entry_id, line_no)`. Declaring it would make
 * every run fail on a coverage read rather than on anything about the import. The ENTRY is declared and
 * carries the provenance; its lines are part of it and are held to it by ZL003 at COMMIT.
 */
export const PACKAGES_IMPORTER_TARGETS: readonly string[] = Object.freeze([
  'public.imported_package_sale',
  'public.package_sale',
  'public.package_balance',
  'public.journal_entry',
])

export interface PackagesImporterOptions {
  /**
   * Every template key the database holds, retired ones included, when the caller has already read them.
   *
   * Omitted, the two template reasons move from staging to apply — see the module note. It is not
   * defaulted to `[]`, which would be worse than omitting it: an empty list makes H-MIG-02's validator
   * reject EVERY row as `template-key-names-no-package-template`, so a registry entry built that way
   * would refuse every workbook and name the wrong reason for it.
   */
  readonly templates?: readonly KnownPackageTemplate[]
  /**
   * Allocates the id of the opening journal entry for one row. Injected so the entry ids of a run are
   * reproducible in a test; `randomUUID` otherwise, because the ledger allocates no id of its own (0018).
   */
  readonly entryId?: () => string
}

/** The payload keys the workbook stages, as typed cells. Shared with the validator's own reader. */
function asRow(payload: Readonly<Record<string, unknown>>): PackageWorkbookRow {
  const record: Record<string, string> = {}
  for (const key of WORKBOOK_PAYLOAD_KEYS) {
    const value = payload[key]
    record[key] = typeof value === 'string' ? value.trim() : ''
  }
  return record as unknown as PackageWorkbookRow
}

/**
 * The source file hash of the run this row is being applied by, read inside the row's own transaction.
 *
 * `ImporterDefinition.apply` is handed a unit of work and a payload — not the run, not the file, not its
 * hash — and the sign-off is keyed on the hash, so the run has to be found from the only thing in hand:
 * the payload. It is found through the STAGED ROW, by the content hash the framework computed over the
 * same canonical form, among rows that are still `pending` in a run that is still `running`. For a dry run
 * the whole run is inside the transaction being rolled back, so it is visible here; for a live run the row
 * was committed as `pending` before anything was applied.
 *
 * **It is not "the open run of this importer", which is what this function did first and is a defect the
 * suite found.** A run that fails part-way stays `running` on purpose — that is the framework's resume
 * path (0111) — so after one failed import there are two open runs, after two there are three, and a rule
 * that refused to guess between them refused every later import of every other file. The failure was not
 * even about the file being imported, which is the worst property a refusal can have.
 *
 * Exactly one row must match, and a refusal otherwise. Two would mean the same row CONTENT is pending in
 * two open runs at once, which ZY191 already forbids for two runs over the same file and which is a state
 * worth refusing rather than guessing inside. And this lookup is a convenience, not the guarantee: ZY256
 * walks from the row this import writes, through `import_staging.entity_provenance`, to the run that
 * actually produced it, and refuses the COMMIT unless that run's hash is the one the signature names. A
 * wrong answer here cannot commit.
 */
async function stagedSourceFileHash(
  uow: UnitOfWork,
  payload: Readonly<Record<string, unknown>>,
): Promise<string> {
  const hash = contentHash(payload)
  const runs = await uow.sql<{ sourceFileHash: string; runId: string }[]>`
    select r.source_file_hash as "sourceFileHash", r.id as "runId"
      from import_staging.import_row w
      join import_staging.import_run r on r.id = w.run_id
     where w.row_hash = ${hash}
       and w.state = 'pending'
       and r.importer = ${PACKAGES_IMPORTER_NAME}
       and r.state = 'running'
     order by r.started_at
  `
  const first = runs[0]
  if (first === undefined) {
    throw new AppError(
      'invariant_violated',
      `No pending staged row of the "${PACKAGES_IMPORTER_NAME}" importer carries content hash ${hash}, ` +
        'so this row cannot say which file it came from. `apply` is handed a payload and a unit of work ' +
        "and nothing else, so the staged row is how it finds the owner's sign-off — and reaching here " +
        'means something applied a payload the framework never staged.',
      { details: { contentHash: hash } },
    )
  }
  if (runs.length > 1) {
    throw new AppError(
      'conflict',
      `The same row content (${hash}) is pending in ${runs.length} open runs of the ` +
        `"${PACKAGES_IMPORTER_NAME}" importer (${runs.map((run) => run.runId).join(', ')}). Finish or ` +
        'fail one before importing the other: the owner sign-off is resolved through the run this row ' +
        'came from, and a guess between two of them would attach a liability to a signature for another ' +
        'file.',
      { details: { contentHash: hash, runs: runs.map((run) => run.runId) } },
    )
  }
  return first.sourceFileHash
}

/**
 * Applies one reconstructed package row.
 *
 * The resolutions happen before any write, so a refusal names the cell a person has to go and look at
 * rather than arriving from a constraint half way through. The writes are
 * {@link importReconstructedPackage}'s, in `packages/db`, which is where a `package_sale` has always been
 * written from — this package may import `@berelax/db` and `@berelax/shared` and nothing else first-party.
 */
async function applyPackageRow(
  uow: UnitOfWork,
  payload: Readonly<Record<string, unknown>>,
  options: PackagesImporterOptions,
): Promise<readonly ImportedEntity[]> {
  const row = asRow(payload)
  const where = `Holder ${row.holderPhoneE164}, template ${row.templateKey}, purchased ${row.purchaseDate}.`

  const sourceFileHash = await stagedSourceFileHash(uow, payload)
  const signOff = await readPackageSignOff(uow.sql, PACKAGES_IMPORTER_NAME, sourceFileHash)
  if (signOff === null) {
    throw new AppError(
      'conflict',
      `No owner sign-off is recorded for the file hashing to ${sourceFileHash}. A reconstructed package ` +
        'liability is a figure nobody can defend unless the owner has read the workbook and accepted the ' +
        'balances in it as liabilities of the business — and the sign-off is also where the opening date ' +
        'and the cash actually received come from, so there is nothing to file this liability on and ' +
        'nothing to reconcile it against. Record one and run the import again.',
      { details: { sourceFileHash, importer: PACKAGES_IMPORTER_NAME } },
    )
  }

  const customerId = await resolveHolder(uow.sql, row.holderPhoneE164)
  if (customerId === null) throw new CustomerUnknown(row.holderPhoneE164, where)

  const template = await readReconstructionTemplate(uow.sql, row.templateKey)
  if (template === null) {
    // H-MIG-02's vocabulary value, carried rather than re-worded: a person correcting a workbook reads the
    // same reason whether it was refused at staging or here. See the module note on why both exist.
    throw new TemplateCannotCarryReconstruction(
      row.templateKey,
      `${PACKAGE_REJECTIONS.templateUnknown}: no package_template holds that key, so the row names no ` +
        `terms and there is nothing for the entitlement to be about. ${where}`,
    )
  }
  if (template.lines.length === 0) {
    throw new TemplateCannotCarryReconstruction(
      row.templateKey,
      `${PACKAGE_REJECTIONS.templateWithoutVersion}: the template exists and its current version has no ` +
        `lines, so there is no treatment the holder is entitled to. ${where}`,
    )
  }
  const line = template.lines[0]
  if (template.lines.length > 1 || line === undefined) {
    throw new TemplateCannotCarryReconstruction(
      row.templateKey,
      `has ${template.lines.length} lines, and the workbook states ONE session count for the whole ` +
        'package. Which line a taken session came from is not in the file, so apportioning the drawdown ' +
        'would be inventing which treatments the holder had — and the shares a redemption draws on would ' +
        `be wrong by whatever the two lines are worth differently. ${where}`,
    )
  }

  const imported = await importReconstructedPackage(uow, {
    signOffId: signOff.signOffId,
    openingDate: signOff.openingDate,
    customerId,
    templateVersionId: template.templateVersionId,
    serviceVariantId: line.serviceVariantId,
    validityMonths: template.validityMonths,
    transferable: template.transferable,
    unredeemedBalancePolicy: template.unredeemedBalancePolicy,
    entryId: (options.entryId ?? (() => `pkg-open-${randomUUID()}`))(),
    holderPhoneE164: row.holderPhoneE164,
    templateKey: row.templateKey,
    purchaseDate: row.purchaseDate,
    pricePaidFils: Number.parseInt(row.pricePaidFils, 10),
    sessionsTotal: Number.parseInt(row.sessionsTotal, 10),
    sessionsUsed: Number.parseInt(row.sessionsUsed, 10),
    expiresOn: row.expiresOn,
    evidenceKind: row.evidenceKind,
    evidenceReference: row.evidenceReference,
    notes: row.notes.length === 0 ? null : row.notes,
  })

  /*
    Every entity row this import created, for the framework to record provenance against — and the
    reconstruction record is FIRST because it is the one that always exists. ZY256 reads the provenance of
    exactly that row to find the run the liability came from, so a fully drawn package, which has no sale
    and no posting, is still resolvable to the line of the file it was typed on.

    Returning them rather than recording them is 0111's arrangement: an importer that inserted a row and
    returned `[]` is an importer that forgot, and ZY196 refuses its COMMIT instead of leaving a figure
    nobody can defend.
  */
  const entities: ImportedEntity[] = [
    { table: 'imported_package_sale', id: imported.reconstructionId },
  ]
  if (imported.packageSaleId !== null) {
    entities.push({ table: 'package_sale', id: imported.packageSaleId })
    for (const balanceId of imported.balanceIds) {
      entities.push({ table: 'package_balance', id: balanceId })
    }
  }
  if (imported.entryId !== null) {
    entities.push({ table: 'journal_entry', id: imported.entryId })
  }
  return entities
}

/**
 * The parse-and-validate pair the registry entry uses, when no template list was supplied.
 *
 * ## The deferral is STRUCTURAL and is not a rewritten verdict
 *
 * The first version of this wrapped H-MIG-02's validator and turned `template-key-names-no-package-template`
 * into `{ ok: true }`. `import.test.ts`'s control case found what is wrong with that, and it is the worst
 * kind of wrong: that validator answers the FIRST reason it finds and stops, and the template check sits
 * sixth of sixteen — so rewriting its verdict accepted every row whose real problem came later. A file with
 * a price in dirhams, a negative session count or no owner sign-off validated CLEAN, and the only thing
 * that noticed was the case asserting that every other fixture is still refused by name.
 *
 * So the template list is collected from the FILE instead. `parse` sees the whole workbook before any row
 * is judged, so it records every `template_key` the file names and the validator is built with all of them
 * present and versioned. The two template reasons then cannot fire at staging — there is nothing to defer —
 * and every other rule runs exactly as H-MIG-02 wrote it.
 *
 * Stateful, one instance per importer, which is the arrangement H-MIG-02's own validator already needs for
 * `duplicate-holder-template-and-purchase-date`: that reason is a claim about the file and not about a row.
 *
 * If `validate` were somehow called before `parse` the set would be empty and every row would be REFUSED as
 * naming an unknown template. That is the conservative direction and is deliberately not guarded against:
 * refusing a file nobody parsed is recoverable, and the alternative — accepting it — is the defect above.
 */
function registryParseAndValidate(): {
  parse: (sourceText: string) => readonly StagedSourceRow[]
  validate: (payload: Readonly<Record<string, unknown>>) => RowVerdict
} {
  let validator: { validate(payload: Readonly<Record<string, unknown>>): RowVerdict } | null = null
  let keys: readonly string[] = []
  return {
    parse(sourceText: string): readonly StagedSourceRow[] {
      const rows = parsePackageWorkbook(sourceText)
      const named = new Set<string>()
      for (const row of rows) {
        const key = asRow(row.payload).templateKey
        if (key.length > 0) named.add(key)
      }
      keys = [...named]
      // A new file is a new pass: the duplicate check inside H-MIG-02's validator is stateful, so reusing
      // the instance across two files would refuse the second file's first row as a duplicate of the
      // first's.
      validator = null
      return rows
    },
    validate(payload: Readonly<Record<string, unknown>>): RowVerdict {
      validator ??= createPackageWorkbookValidator({
        templates: keys.map((templateKey) => ({ templateKey, hasVersion: true })),
      })
      return validator.validate(payload)
    },
  }
}

/** Builds the package reconstruction importer. */
export function packagesImporter(options: PackagesImporterOptions = {}): ImporterDefinition {
  const templates = options.templates
  const reading =
    templates === undefined
      ? registryParseAndValidate()
      : {
          parse: (sourceText: string): readonly StagedSourceRow[] =>
            parsePackageWorkbook(sourceText),
          validate: createPackageWorkbookValidator({ templates }).validate,
        }
  return {
    name: PACKAGES_IMPORTER_NAME,
    version: PACKAGES_IMPORTER_VERSION,
    targetTables: PACKAGES_IMPORTER_TARGETS,
    parse: reading.parse,
    validate: reading.validate,
    apply: (uow: UnitOfWork, payload: Readonly<Record<string, unknown>>) =>
      applyPackageRow(uow, payload, options),
  }
}
