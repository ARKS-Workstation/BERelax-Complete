import type { Sql, UnitOfWork } from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { ImporterDefinition, RowVerdict, StagedSourceRow } from '../framework.ts'
import type { ImportedEntity } from '../provenance.ts'

/**
 * The framework's conformance importer, and the only thing that writes `import_staging.import_probe_entity`.
 *
 * ## Why a shipped importer rather than a mock in the suite
 *
 * H-MIG-01's five claims — idempotence, resumability, a dry run that changes nothing, 100% provenance
 * coverage, and a rollback that takes the audit rows and the outbox events with it — are all claims about
 * what happens in PostgreSQL. Every one of them is asserted by comparing checksums produced by
 * `import_staging.content_checksum`, by a DEFERRED constraint trigger firing at COMMIT, and by rows
 * appearing or not appearing in `audit_event` and `outbox_event`. A mock target cannot produce any of that:
 * it would prove the framework calls the functions the test expects, which is the class of test that passes
 * while the thing it is about is broken.
 *
 * So there is a real target table, with a real unique constraint and a real money column, and this is the
 * importer that fills it. It is the arrangement `packages/payments/src/conformance/fixtures` already uses
 * for adapters that are deliberately broken, one level up: a fixture that has to behave like the real thing
 * belongs in the tree, not in a test file, because the suites that need it are in three packages.
 *
 * ## Why {@link probeImporter} can be asked to FORGET provenance
 *
 * `forgetProvenance` applies the row and returns no entities — an importer that inserted something and did
 * not say so. That is a reachable mistake and not a contrived one: `apply` returns what it created, so
 * forgetting a `return` or writing a second row and returning the first is exactly the shape of it. ZY196
 * refuses the COMMIT, which is what the acceptance line "a row without provenance cannot be inserted" means
 * in practice, and it is also how the rollback claim is provoked — the refusal arrives at COMMIT, after the
 * audit row and the outbox event have been written, so it takes all of them with it.
 *
 * Nothing else in this repository may name `import_probe_entity`:
 * `packages/migration/src/write-path.test.ts` is the scan, and it exists because a real importer that put a
 * domain figure in here would be recording a liability where no report looks for it.
 */

export const PROBE_IMPORTER_NAME = 'probe'
export const PROBE_TARGET = 'import_staging.import_probe_entity'

/** The key namespace every probe row lives in, so a suite's teardown can name exactly its own rows. */
export const PROBE_KEY_PREFIX = 'probe-'

/** The rejection reasons, named so a test can assert the one it broke rather than "it failed". */
export const PROBE_REJECTIONS = {
  keyMissing: 'probe-key-must-be-present',
  keyNamespace: 'probe-key-must-use-the-probe-namespace',
  labelMissing: 'label-must-be-present',
  amountNotInteger: 'amount-must-be-integer-fils',
  amountNegative: 'amount-must-not-be-negative',
} as const

export interface ProbeImporterOptions {
  /**
   * Apply the row and report no entity, so ZY196 refuses the COMMIT.
   *
   * The deliberately-broken variant. Never true outside a conformance suite, and there is no configuration
   * anywhere that can set it: the option is an argument to this factory.
   */
  readonly forgetProvenance?: boolean
}

interface ProbePayload {
  readonly probeKey: string
  readonly label: string
  /** The cell as it was typed. A spreadsheet's amount column holds text until something judges it. */
  readonly amountFils: string
}

const asPayload = (payload: Readonly<Record<string, unknown>>): ProbePayload => ({
  probeKey: typeof payload['probeKey'] === 'string' ? payload['probeKey'] : '',
  label: typeof payload['label'] === 'string' ? payload['label'] : '',
  amountFils: typeof payload['amountFils'] === 'string' ? payload['amountFils'] : '',
})

/**
 * Tab-separated, with a header line, which is what a spreadsheet exports.
 *
 * Lenient on purpose: a malformed row must still become a STAGED row, because the report has to name it by
 * line number and the whole point of staging before applying is that a bad row is visible rather than
 * fatal. Judging is {@link ImporterDefinition.validate}'s job, and keeping the two apart is what lets one
 * pass over the file name every problem at once.
 */
function parseProbeFile(sourceText: string): readonly StagedSourceRow[] {
  const rows: StagedSourceRow[] = []
  const lines = sourceText.split('\n')
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    if (line.trim().length === 0) continue
    const cells = line.split('\t')
    // The header, recognised by its first cell rather than by position: a file with the header repeated
    // half way down — which happens when two exports are pasted together — would otherwise stage it as a
    // row and reject it, and a rejection stops the whole run.
    if (cells[0]?.trim() === 'probe_key') continue
    rows.push({
      lineNumber,
      payload: {
        probeKey: (cells[0] ?? '').trim(),
        label: (cells[1] ?? '').trim(),
        amountFils: (cells[2] ?? '').trim(),
      },
    })
  }
  return rows
}

function validateProbeRow(payload: Readonly<Record<string, unknown>>): RowVerdict {
  const row = asPayload(payload)
  if (row.probeKey.length === 0) return { ok: false, reason: PROBE_REJECTIONS.keyMissing }
  if (!row.probeKey.startsWith(PROBE_KEY_PREFIX)) {
    return { ok: false, reason: PROBE_REJECTIONS.keyNamespace }
  }
  if (row.label.length === 0) return { ok: false, reason: PROBE_REJECTIONS.labelMissing }
  if (!/^-?\d+$/.test(row.amountFils)) {
    return { ok: false, reason: PROBE_REJECTIONS.amountNotInteger }
  }
  if (Number.parseInt(row.amountFils, 10) < 0) {
    return { ok: false, reason: PROBE_REJECTIONS.amountNegative }
  }
  return { ok: true }
}

/**
 * Removes every conformance row, so a suite starts from an empty target and the next run of it is clean.
 *
 * Here and not in either suite, because BOTH of H-MIG-01's integration files need it and a statement written
 * twice is a statement that will differ once — which is the argument `packages/fixtures/src/invoice-family.ts`
 * makes about table lists, one table long. This module is therefore named in `TEST_SUPPORT_MODULES` in
 * `packages/db/src/suite-table-ownership.ts`, so the "a suite may delete only what it created" scan reads the
 * statement where it actually lives rather than stopping at the filename (ADR 0050).
 *
 * It is SCOPED to the key namespace and needs no declaration in `DECLARED_UNQUALIFIED`, which is not a
 * technicality: this importer is the only thing in the repository that writes that table — held by
 * `packages/migration/src/write-path.test.ts` — so the predicate names exactly the rows these suites created,
 * including the ones an earlier execution of them left behind.
 */
export async function clearProbeEntities(sql: Sql): Promise<number> {
  const removed = await sql`
    delete from import_staging.import_probe_entity where probe_key like ${`${PROBE_KEY_PREFIX}%`}
  `
  return removed.count
}

/** Builds the conformance importer. See the module comment for `forgetProvenance`. */
export function probeImporter(options: ProbeImporterOptions = {}): ImporterDefinition {
  return {
    name: PROBE_IMPORTER_NAME,
    version: '1',
    targetTables: [PROBE_TARGET],
    parse: parseProbeFile,
    validate: validateProbeRow,
    async apply(
      uow: UnitOfWork,
      payload: Readonly<Record<string, unknown>>,
    ): Promise<readonly ImportedEntity[]> {
      const row = asPayload(payload)
      const inserted = await uow.sql<{ id: string }[]>`
        insert into import_staging.import_probe_entity (probe_key, label, amount_fils)
        values (${row.probeKey}, ${row.label}, ${Number.parseInt(row.amountFils, 10)})
        returning id
      `
      const id = inserted[0]?.id
      if (id === undefined) {
        throw new AppError('invariant_violated', 'The probe insert returned no row.')
      }
      if (options.forgetProvenance === true) return []
      return [{ schema: 'import_staging', table: 'import_probe_entity', id }]
    },
  }
}
