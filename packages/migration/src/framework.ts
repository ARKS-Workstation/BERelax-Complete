import { type Actor, type Sql, type UnitOfWork, withUnitOfWork } from '@berelax/db'
import { AppError } from '@berelax/shared'
import { contentChecksum, exactChecksum } from './checksum.ts'
import {
  assertRelationName,
  contentHash,
  fileHash,
  type ImportedEntity,
  recordProvenance,
  unprovenancedRowIds,
} from './provenance.ts'

/**
 * The import framework: one run, one source file, resumable, idempotent, and rehearsable.
 *
 * Every H-MIG importer (H-MIG-02 .. H-MIG-11) is a {@link ImporterDefinition} handed to {@link runImport},
 * and the four properties the unit exists to provide are properties of THIS function rather than of each
 * importer — because an importer that has to remember them is an importer that will not.
 *
 * ## One transaction per ROW, and why that is the whole of resumability
 *
 * An import that cannot be resumed is an import that is run twice. A killed process leaves some rows in the
 * target tables and some not, and with nothing recording which is which the only safe action is to start
 * again into a database that already holds half of them.
 *
 * So in `live` mode each row is applied in its OWN `withUnitOfWork`: the entity insert, its provenance row,
 * the audit row, the outbox event and the `pending` -> `applied` transition commit together or not at all.
 * Progress is therefore durable at row granularity, and a resumed run is the SAME `import_run` row
 * continuing with the rows still `pending`. Nothing is written outside a row's transaction while rows are
 * being applied, which is what makes an abort and a `kill -9` leave the identical state — the database is
 * the only thing that records progress, so there is nothing for a process to fail to flush.
 *
 * A batch of rows in one transaction would be faster and would make the failure window a batch wide: a kill
 * loses up to a batch of work, which is recoverable, but the report then cannot say which rows were applied
 * without re-reading the target tables. The row is the unit the provenance is about, so it is the unit the
 * transaction is about.
 *
 * ## `dry-run` is ONE transaction, rolled back, with the constraints forced
 *
 * A dry run stages, validates and applies everything inside a single transaction and then rolls it back, so
 * nothing it did survives — including its `import_run` row, its audit rows and its outbox events (ADR 0008:
 * they share the transaction, so they share its fate).
 *
 * The trap, and the one line in this file that is easiest to leave out: **every constraint trigger in
 * `import_staging` is DEFERRED, so a transaction that never commits never fires them.** A dry run would
 * report success over exactly the defect ZY196 exists to find — an applied row with no provenance. So the
 * dry run issues `set constraints all immediate` before rolling back, which fires every deferred check as
 * though it were committing. Without it the rehearsal is weaker than the run it rehearses, which is the
 * opposite of the point.
 *
 * ## Idempotence is decided on the row's CONTENT hash
 *
 * A row is skipped when a COMPLETED run of the same importer has already applied a row with the same
 * `row_hash`. Not "the same line of the same file": the file will be re-saved, re-sent and re-exported, and
 * every one of those rewrites the bytes without changing a value (see `./provenance.ts`). Not "the same
 * target row" either: the framework cannot know an importer's natural key, and an importer that knew it
 * would be deciding idempotence in nine places.
 *
 * Only COMPLETED runs count, and ZY198 is what makes that safe: a run cannot reach `completed` while any of
 * its rows is still `pending`, so "a completed run applied this content" cannot mean "a completed run was
 * going to apply this content".
 *
 * ## A rejected row stops the run before anything is applied
 *
 * Validation happens at STAGING time, over every row, and a run with any rejection ends `failed` having
 * applied nothing. All-or-nothing on validity, because the artefacts being imported are liabilities: a
 * package balance that half-imported is worse than one that did not import, and the report has to be able
 * to name every bad row at once so the spreadsheet can be corrected in one pass rather than nine.
 *
 * The rejected rows are COMMITTED as rejected, which is deliberate: they are the evidence of what was
 * wrong, and the report that names them is read after the process has gone.
 */

export type ImportMode = 'live' | 'dry-run'

/** One row of the source file, as the importer's parser read it. */
export interface StagedSourceRow {
  /** 1-based, and it is the line in the FILE — the number a person will look at in a spreadsheet. */
  readonly lineNumber: number
  readonly payload: Readonly<Record<string, unknown>>
}

export type RowVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export interface ImporterDefinition {
  /** Stable. It is half of the idempotence key and half of the resume key. */
  readonly name: string
  /**
   * The importer's own version, recorded on every run.
   *
   * An imported figure that disagrees with what the owner believes may be wrong because of a typed digit or
   * because of this code's rounding, normalisation or column mapping. Without the version the second
   * possibility is not investigable.
   */
  readonly version: string
  /** Schema-qualified, and complete: ZY194 refuses provenance for anything not in this list. */
  readonly targetTables: readonly string[]
  parse(sourceText: string): readonly StagedSourceRow[]
  validate(payload: Readonly<Record<string, unknown>>): RowVerdict
  /**
   * Applies one row and RETURNS the entity rows it created, for the framework to record provenance against.
   *
   * Returning them rather than recording them is what makes ZY196 a guard against a reachable mistake: an
   * importer that inserts a row and returns `[]` is an importer that forgot, and the deferred trigger
   * refuses its COMMIT instead of leaving a figure nobody can defend. The framework owning the insert is
   * what keeps the provenance shape in one place.
   */
  apply(
    uow: UnitOfWork,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<readonly ImportedEntity[]>
}

export interface RunImportOptions {
  readonly sql: Sql
  readonly importer: ImporterDefinition
  /** As supplied by whoever ran the import: the path, for a person to recognise. */
  readonly sourceFile: string
  readonly sourceText: string
  /** The file's bytes, when they are not simply `sourceText` in UTF-8. */
  readonly sourceBytes?: Uint8Array
  readonly mode: ImportMode
  readonly actor: Actor
}

export interface TargetTableReport {
  readonly relation: string
  /** Every column. Equal before and after means not one row and not one id moved. */
  readonly exactBefore: string
  readonly exactAfter: string
  /** Generated columns excluded, so two different runs of the same rows are comparable. */
  readonly contentBefore: string
  readonly contentAfter: string
  /** Rows in the relation that no provenance row names. The measured half of 100% coverage. */
  readonly unprovenancedRows: number
}

export interface RowRejection {
  readonly lineNumber: number
  readonly reason: string
}

export interface ImportReport {
  readonly importer: string
  readonly importerVersion: string
  readonly sourceFile: string
  readonly sourceFileHash: string
  /** For a dry run this names a row that was rolled back, and `committed` is how a reader can tell. */
  readonly runId: string
  readonly mode: ImportMode
  readonly committed: boolean
  readonly resumed: boolean
  readonly resumedCount: number
  readonly state: 'completed' | 'failed'
  readonly staged: number
  readonly applied: number
  readonly skipped: number
  readonly rejected: number
  readonly pending: number
  readonly targets: readonly TargetTableReport[]
  readonly rejections: readonly RowRejection[]
  readonly startedAt: string
  readonly finishedAt: string
}

/** Thrown, caught and never propagated: it is how a dry run reaches a ROLLBACK with a report in hand. */
class DryRunRollback extends Error {
  constructor(readonly report: ImportReport) {
    super('dry run complete — rolling back')
    this.name = 'DryRunRollback'
  }
}

interface RunRow {
  readonly id: string
  readonly resumedCount: number
  readonly startedAt: Date
}

interface PendingRow {
  readonly id: string
  readonly lineNumber: number
  readonly rowHash: string
  readonly payload: Readonly<Record<string, unknown>>
}

/** Runs `fn` in a transaction of its own, or in a shared one when the caller already has it. */
type Transactionally = <T>(fn: (uow: UnitOfWork) => Promise<T>) => Promise<T>

const AUDIT_ENTITY = 'import_run'

function assertParsedRows(importer: ImporterDefinition, rows: readonly StagedSourceRow[]): void {
  if (rows.length === 0) {
    throw new AppError(
      'validation',
      `${importer.name} parsed no rows out of the source file. Refused rather than recorded as an import ` +
        'of nothing: a run that applied zero rows and completed would make the next run of the corrected ' +
        'file look like a re-import, and the file being empty is almost always the wrong file.',
    )
  }
  const seen = new Set<number>()
  for (const row of rows) {
    if (!Number.isInteger(row.lineNumber) || row.lineNumber < 1) {
      throw new AppError(
        'validation',
        `${importer.name} reported a row at line ${String(row.lineNumber)}. A line number is what a person ` +
          'opens the spreadsheet at, so it is 1-based and an integer.',
      )
    }
    if (seen.has(row.lineNumber)) {
      throw new AppError(
        'validation',
        `${importer.name} reported two rows at line ${row.lineNumber}. The pair (run, line) is unique in ` +
          'the staging ledger, so provenance could not tell the two apart afterwards.',
      )
    }
    seen.add(row.lineNumber)
  }
}

async function readTargetReports(
  handle: Sql,
  relations: readonly string[],
  before: ReadonlyMap<string, { exact: string; content: string }>,
): Promise<TargetTableReport[]> {
  const out: TargetTableReport[] = []
  for (const relation of relations) {
    const exact = await exactChecksum(handle, relation)
    const content = await contentChecksum(handle, relation)
    const unprovenanced = await unprovenancedRowIds(handle, relation)
    out.push({
      relation,
      exactBefore: before.get(relation)?.exact ?? '',
      exactAfter: exact,
      contentBefore: before.get(relation)?.content ?? '',
      contentAfter: content,
      unprovenancedRows: unprovenanced.length,
    })
  }
  return out
}

async function findOpenLiveRun(
  sql: Sql,
  importer: string,
  sourceFileHash: string,
): Promise<RunRow | null> {
  const rows = await sql<RunRow[]>`
    select id, resumed_count as "resumedCount", started_at as "startedAt"
      from import_staging.import_run
     where importer = ${importer}
       and source_file_hash = ${sourceFileHash}
       and mode = 'live'
       and state = 'running'
     order by started_at
     limit 1
  `
  return rows[0] ?? null
}

async function openRun(
  uow: UnitOfWork,
  options: RunImportOptions,
  sourceFileHash: string,
  parsed: readonly StagedSourceRow[],
): Promise<{ run: RunRow; rejections: RowRejection[] }> {
  const { importer } = options
  const created = await uow.sql<RunRow[]>`
    insert into import_staging.import_run (
      importer, importer_version, source_file, source_file_hash, mode, state, target_tables, actor_label
    ) values (
      ${importer.name},
      ${importer.version},
      ${options.sourceFile},
      ${sourceFileHash},
      ${options.mode},
      'running',
      ${[...importer.targetTables]}::text[],
      ${options.actor.label ?? options.actor.kind}
    )
    returning id, resumed_count as "resumedCount", started_at as "startedAt"
  `
  const run = created[0]
  if (run === undefined) {
    throw new AppError('invariant_violated', 'The import run insert returned no row.')
  }

  const rejections: RowRejection[] = []
  for (const row of parsed) {
    const verdict = importer.validate(row.payload)
    if (verdict.ok) {
      await uow.sql`
        insert into import_staging.import_row (run_id, line_number, row_hash, payload, state)
        values (${run.id}::uuid, ${row.lineNumber}, ${contentHash(row.payload)},
                ${uow.sql.json(row.payload as never)}, 'pending')
      `
      continue
    }
    rejections.push({ lineNumber: row.lineNumber, reason: verdict.reason })
    await uow.sql`
      insert into import_staging.import_row (
        run_id, line_number, row_hash, payload, state, outcome_detail
      ) values (
        ${run.id}::uuid, ${row.lineNumber}, ${contentHash(row.payload)},
        ${uow.sql.json(row.payload as never)}, 'rejected', ${verdict.reason}
      )
    `
  }

  await uow.audit.record({
    action: 'migration.import.opened',
    entityType: AUDIT_ENTITY,
    entityId: run.id,
    operation: 'create',
    after: {
      importer: importer.name,
      importerVersion: importer.version,
      sourceFile: options.sourceFile,
      sourceFileHash,
      mode: options.mode,
      staged: parsed.length,
      rejected: rejections.length,
    },
  })
  await uow.publish({
    eventType: 'migration.import.opened',
    aggregateType: AUDIT_ENTITY,
    aggregateId: run.id,
    payload: { importer: importer.name, sourceFileHash, mode: options.mode, staged: parsed.length },
    idempotencyKey: `migration.import.opened:${run.id}`,
  })

  return { run, rejections }
}

async function readPendingRows(handle: Sql, runId: string): Promise<PendingRow[]> {
  return handle<PendingRow[]>`
    select id, line_number as "lineNumber", row_hash as "rowHash", payload
      from import_staging.import_row
     where run_id = ${runId}::uuid and state = 'pending'
     order by line_number
  `
}

/** Has a COMPLETED run of this importer already applied a row with this content? */
async function alreadyImported(
  handle: Sql,
  importer: string,
  rowHash: string,
): Promise<string | null> {
  const rows = await handle<{ runId: string }[]>`
    select w.run_id as "runId"
      from import_staging.import_row w
      join import_staging.import_run r on r.id = w.run_id
     where w.row_hash = ${rowHash}
       and w.state = 'applied'
       and r.importer = ${importer}
       and r.state = 'completed'
     order by r.finished_at
     limit 1
  `
  return rows[0]?.runId ?? null
}

async function applyOneRow(
  uow: UnitOfWork,
  importer: ImporterDefinition,
  runId: string,
  row: PendingRow,
): Promise<'applied' | 'skipped'> {
  const previous = await alreadyImported(uow.sql, importer.name, row.rowHash)
  if (previous !== null) {
    await uow.sql`
      update import_staging.import_row
         set state = 'skipped',
             outcome_detail = ${`already imported by run ${previous}`}
       where id = ${row.id}::uuid
    `
    return 'skipped'
  }

  const entities = await importer.apply(uow, row.payload)
  for (const entity of entities) {
    await recordProvenance(uow, row.id, entity)
  }
  // Audit and the event BEFORE the state change, and the state change before COMMIT, so that ZY196 —
  // which fires at COMMIT — takes all five writes with it when it refuses. That is the acceptance line
  // "an import rolled back discards its audit rows and outbox events together with its data", and it is
  // asserted against exactly this ordering in `framework.itest.ts`.
  await uow.audit.record({
    action: 'migration.row.imported',
    entityType: 'import_row',
    entityId: row.id,
    operation: 'create',
    after: {
      runId,
      lineNumber: row.lineNumber,
      contentHash: row.rowHash,
      entities: entities.map((entity) => ({
        relation: `${entity.schema ?? 'public'}.${entity.table}`,
        id: entity.id,
      })),
    },
  })
  await uow.publish({
    eventType: 'migration.row.imported',
    aggregateType: 'import_row',
    aggregateId: row.id,
    payload: {
      runId,
      importer: importer.name,
      lineNumber: row.lineNumber,
      entities: entities.length,
    },
    idempotencyKey: `migration.row.imported:${row.id}`,
  })
  await uow.sql`
    update import_staging.import_row
       set state = 'applied', applied_at = now()
     where id = ${row.id}::uuid
  `
  return 'applied'
}

async function closeRun(
  uow: UnitOfWork,
  runId: string,
  state: 'completed' | 'failed',
  counts: { applied: number; skipped: number; rejected: number; pending: number },
): Promise<Date> {
  const rows = await uow.sql<{ finishedAt: Date }[]>`
    update import_staging.import_run
       set state = ${state}, finished_at = now()
     where id = ${runId}::uuid
     returning finished_at as "finishedAt"
  `
  const finishedAt = rows[0]?.finishedAt
  if (finishedAt === undefined) {
    throw new AppError(
      'invariant_violated',
      `Import run ${runId} could not be closed: no such row.`,
    )
  }
  await uow.audit.record({
    action: state === 'completed' ? 'migration.import.completed' : 'migration.import.failed',
    entityType: AUDIT_ENTITY,
    entityId: runId,
    operation: 'update',
    after: { state, ...counts },
  })
  await uow.publish({
    eventType: state === 'completed' ? 'migration.import.completed' : 'migration.import.failed',
    aggregateType: AUDIT_ENTITY,
    aggregateId: runId,
    payload: { state, ...counts },
    idempotencyKey: `migration.import.${state}:${runId}`,
  })
  return finishedAt
}

/** The body both modes share: stage or resume, apply every pending row, close the run, build the report. */
async function performRun(
  options: RunImportOptions,
  handle: Sql,
  transactionally: Transactionally,
  sourceFileHash: string,
  parsed: readonly StagedSourceRow[],
  before: ReadonlyMap<string, { exact: string; content: string }>,
): Promise<ImportReport> {
  const { importer } = options
  const existing =
    options.mode === 'live' ? await findOpenLiveRun(handle, importer.name, sourceFileHash) : null

  let run: RunRow
  let rejections: RowRejection[] = []
  let resumedCount: number
  if (existing === null) {
    const opened = await transactionally((uow) => openRun(uow, options, sourceFileHash, parsed))
    run = opened.run
    rejections = opened.rejections
    resumedCount = 0
  } else {
    run = existing
    resumedCount = existing.resumedCount + 1
    await transactionally(async (uow) => {
      await uow.sql`
        update import_staging.import_run
           set resumed_count = resumed_count + 1
         where id = ${run.id}::uuid
      `
      await uow.audit.record({
        action: 'migration.import.resumed',
        entityType: AUDIT_ENTITY,
        entityId: run.id,
        operation: 'update',
        after: { resumedCount },
      })
    })
    const staged = await handle<{ lineNumber: number; reason: string }[]>`
      select line_number as "lineNumber", coalesce(outcome_detail, '') as reason
        from import_staging.import_row
       where run_id = ${run.id}::uuid and state = 'rejected'
       order by line_number
    `
    rejections = staged.map((row) => ({ lineNumber: row.lineNumber, reason: row.reason }))
  }

  const stagedCount = await handle<{ count: string }[]>`
    select count(*)::text as count from import_staging.import_row where run_id = ${run.id}::uuid
  `
  const staged = Number(stagedCount[0]?.count ?? '0')

  let applied = 0
  let skipped = 0
  if (rejections.length === 0) {
    for (const row of await readPendingRows(handle, run.id)) {
      const outcome = await transactionally((uow) => applyOneRow(uow, importer, run.id, row))
      if (outcome === 'applied') applied += 1
      else skipped += 1
    }
  }

  const pendingAfter = await handle<{ count: string }[]>`
    select count(*)::text as count
      from import_staging.import_row
     where run_id = ${run.id}::uuid and state = 'pending'
  `
  const pending = Number(pendingAfter[0]?.count ?? '0')
  const state = rejections.length > 0 ? 'failed' : 'completed'
  const counts = { applied, skipped, rejected: rejections.length, pending }
  const finishedAt = await transactionally((uow) => closeRun(uow, run.id, state, counts))

  return {
    importer: importer.name,
    importerVersion: importer.version,
    sourceFile: options.sourceFile,
    sourceFileHash,
    runId: run.id,
    mode: options.mode,
    committed: options.mode === 'live',
    resumed: existing !== null,
    resumedCount,
    state,
    staged,
    applied,
    skipped,
    rejected: rejections.length,
    pending,
    targets: await readTargetReports(handle, importer.targetTables, before),
    rejections,
    startedAt: run.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  }
}

/**
 * Imports one source file, or rehearses the import and rolls it back.
 *
 * Resumes automatically: if a LIVE run of this importer over this file's hash is still open, this call
 * continues it rather than starting a second one. There is no `--resume` flag, because an import that has to
 * be told to resume is an import somebody will re-run instead, and ZY191 would then refuse it — correctly,
 * and at the least helpful moment.
 */
export async function runImport(options: RunImportOptions): Promise<ImportReport> {
  const { sql, importer } = options
  for (const relation of importer.targetTables) assertRelationName(relation)
  if (importer.targetTables.length === 0) {
    throw new AppError(
      'validation',
      `${importer.name} declares no target tables. The report's before/after checksums are taken over that ` +
        'list, so an importer with an empty one would produce a report that measured nothing — which is ' +
        'the shape of failure this whole unit is arranged against.',
    )
  }

  const parsed = importer.parse(options.sourceText)
  assertParsedRows(importer, parsed)
  const sourceFileHash = fileHash(options.sourceBytes ?? options.sourceText)

  const before = new Map<string, { exact: string; content: string }>()
  for (const relation of importer.targetTables) {
    before.set(relation, {
      exact: await exactChecksum(sql, relation),
      content: await contentChecksum(sql, relation),
    })
  }

  if (options.mode === 'live') {
    return performRun(
      options,
      sql,
      (fn) => withUnitOfWork(sql, options.actor, fn),
      sourceFileHash,
      parsed,
      before,
    )
  }

  try {
    await withUnitOfWork(sql, options.actor, async (uow) => {
      const report = await performRun(
        options,
        uow.sql,
        (fn) => fn(uow),
        sourceFileHash,
        parsed,
        before,
      )
      // The line that makes the rehearsal as strong as the run. Every constraint trigger in
      // `import_staging` is DEFERRED, so a transaction that never commits never fires one — and a dry run
      // would report success over exactly the defect ZY196 exists to catch.
      await uow.sql`set constraints all immediate`
      throw new DryRunRollback(report)
    })
  } catch (error) {
    if (error instanceof DryRunRollback) return error.report
    throw error
  }
  throw new AppError(
    'invariant_violated',
    'A dry run committed. The transaction is supposed to end by throwing DryRunRollback, so reaching here ' +
      'means the rollback did not happen and the database has been changed by a rehearsal.',
  )
}
