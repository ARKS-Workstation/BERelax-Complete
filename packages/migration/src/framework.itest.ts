import { randomUUID } from 'node:crypto'
import { type Actor, createConnection, type Sql, type UnitOfWork } from '@berelax/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { contentChecksum, exactChecksum } from './checksum.ts'
import {
  clearProbeEntities,
  PROBE_KEY_PREFIX,
  PROBE_REJECTIONS,
  PROBE_TARGET,
  probeImporter,
} from './conformance/probe-importer.ts'
import { type ImporterDefinition, type ImportReport, runImport } from './framework.ts'
import { resolveProvenance, unprovenancedRowIds } from './provenance.ts'
import { MIGRATION_SQLSTATE } from './refusals.ts'

/**
 * H-MIG-01's five acceptance lines, each against a real PostgreSQL and each with a control that must fail.
 *
 * ## Why the UNINTERRUPTED run it is compared against is a DRY RUN
 *
 * The resumability line asks for "a final state identical to an uninterrupted run", and the obvious way to
 * get one — import the file, note the checksum, and import it again after a kill — cannot work here, because
 * the second import of the same file is correctly a no-op: that is the idempotence line. Deleting the target
 * rows in between does not help either, because the LEDGER is append-only, so the completed run remains and
 * the re-import still skips every row.
 *
 * A dry run is exactly the uninterrupted run with nothing left behind. It stages, validates and applies every
 * row inside one transaction, reports the checksum the target table WOULD have held, and rolls back — leaving
 * the ledger with no completed run, so the live run that follows applies the same rows for the first time.
 * The comparison is over the CONTENT checksum, generated columns excluded, because the two runs necessarily
 * differ in every `uuid_generate_v7()` and every `now()` and that is not what "identical" means here.
 *
 * ## How the import is killed, and why not with `pg_terminate_backend`
 *
 * The import dies at a row CHOSEN AT RANDOM, by failing inside `apply` after the entity has been inserted —
 * so the row being applied is one whose entity insert, provenance, audit row, outbox event and state
 * transition are all in flight together. The chosen row is printed in every assertion message: a fixed row
 * proves resumability at one point, the property is meant to hold at all of them, and a random choice that
 * fails has to be reproducible from what the failure says.
 *
 * `pg_terminate_backend` from a second connection was tried first, because a killed SESSION is a closer
 * analogue of `kill -9` than an aborted transaction. It cannot be used with this driver and the reason is
 * worth recording so nobody spends the afternoon again: killing the backend while the importing connection
 * is mid-statement makes postgres.js 3.4.9 fire a queued `setImmediate(nextWrite)` after it has already set
 * `socket = null`, and `TypeError: Cannot read properties of null (reading 'write')` is thrown from inside
 * that immediate — where no `catch` in this file can reach it. It reproduced on one run in three, with all
 * ten tests passing and `Errors 1 error` beside them, which is the shape of flake that gets re-run rather
 * than read.
 *
 * What a session kill would have proved over an aborted transaction is that the framework relies on no
 * post-failure cleanup to leave a resumable state. That is asserted directly instead, below: after the
 * failure the run row must be exactly as the staging transaction left it — still `running`, `finished_at`
 * null, `resumed_count` 0 — and there must be no `migration.import.failed` audit row. Any write the
 * framework performed after the row transaction aborted would show up in one of those four places.
 *
 * ## Teardown, and why running this file twice is clean
 *
 * `import_staging.import_probe_entity` is emptied before and after, through `clearProbeEntities` — one
 * predicate-scoped statement, in the conformance module, over the key namespace nothing else writes. The
 * staging LEDGER is never cleaned: it is append-only by construction (ZY192, ZY195) and it is the evidence
 * that an import happened, so every assertion over it is a delta or is scoped to this execution's run ids.
 * Each execution uses a fresh nonce in its probe keys, so its rows hash differently from the last one's and
 * the idempotence check does not mistake a new execution for a re-import.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

const ACTOR: Actor = { kind: 'system', label: 'H-MIG-01 framework suite' }

/** Unique per EXECUTION of this file, so a second run stages rows that hash differently. */
const NONCE = `${process.pid}-${randomUUID().slice(0, 8)}`

let fileCounter = 0

/** A probe source file: a header and `rows` well-formed lines, in this execution's key namespace. */
function probeFile(rows: number, options: { readonly malformedAt?: number } = {}): string {
  fileCounter += 1
  const lines = ['probe_key\tlabel\tamount_fils']
  for (let i = 1; i <= rows; i += 1) {
    const key = `${PROBE_KEY_PREFIX}${NONCE}-f${fileCounter}-${i}`
    // A malformed row is malformed in ONE named way — a non-integer amount — so the rejection the report
    // carries can be asserted by name rather than by "something was refused".
    const amount = options.malformedAt === i ? 'not-a-number' : String(1000 + i)
    lines.push(`${key}\tRow ${i}\t${amount}`)
  }
  return `${lines.join('\n')}\n`
}

const countRows = async (handle: Sql, relation: 'probe'): Promise<number> => {
  const rows =
    relation === 'probe'
      ? await handle<{ n: string }[]>`
          select count(*)::text as n from import_staging.import_probe_entity
        `
      : []
  return Number(rows[0]?.n ?? '0')
}

/** The staged rows of one run, by state. */
async function rowStates(handle: Sql, runId: string): Promise<Record<string, number>> {
  const rows = await handle<{ state: string; n: string }[]>`
    select state, count(*)::text as n
      from import_staging.import_row
     where run_id = ${runId}::uuid
     group by state
  `
  return Object.fromEntries(rows.map((row) => [row.state, Number(row.n)]))
}

async function runState(handle: Sql, runId: string): Promise<string | null> {
  const rows = await handle<{ state: string }[]>`
    select state from import_staging.import_run where id = ${runId}::uuid
  `
  return rows[0]?.state ?? null
}

/**
 * Counted in SQL, never through a capped reader.
 *
 * `settings-store.itest.ts` read a delta through a `limit` and both sides pinned at the cap, so three
 * recorded changes read as zero. Every count here is `count(*)`.
 */
async function auditRows(handle: Sql, action: string, entityId: string): Promise<number> {
  const rows = await handle<{ n: string }[]>`
    select count(*)::text as n from audit_event
     where action = ${action} and entity_id = ${entityId}
  `
  return Number(rows[0]?.n ?? '0')
}

async function outboxRows(handle: Sql, key: string): Promise<number> {
  const rows = await handle<{ n: string }[]>`
    select count(*)::text as n from outbox_event where idempotency_key = ${key}
  `
  return Number(rows[0]?.n ?? '0')
}

const importProbe = (
  sourceText: string,
  mode: 'live' | 'dry-run',
  importer: ImporterDefinition = probeImporter(),
  handle: Sql = sql,
): Promise<ImportReport> =>
  runImport({
    sql: handle,
    importer,
    sourceFile: `artifacts/migration/probe-${NONCE}.tsv`,
    sourceText,
    mode,
    actor: ACTOR,
  })

const sqlState = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

beforeAll(async () => {
  sql = createConnection({ url, max: 6 })
})

beforeEach(async () => {
  await clearProbeEntities(sql)
})

afterAll(async () => {
  await clearProbeEntities(sql)
  await sql?.end({ timeout: 5 })
})

describe('importing the same file twice', () => {
  it('produces zero new and zero changed rows, by table checksum', async () => {
    const file = probeFile(6)
    const first = await importProbe(file, 'live')
    expect(first.state).toBe('completed')
    expect(
      first.applied,
      'a file nothing has imported must import: idempotence is keyed on the row content, not on whether ' +
        'this importer has completed a run before',
    ).toBe(6)
    expect(await countRows(sql, 'probe')).toBe(6)

    const afterFirst = await exactChecksum(sql, PROBE_TARGET)
    expect(afterFirst, 'the first import produced a real checksum').toMatch(/^[0-9a-f]{32}$/)

    const second = await importProbe(file, 'live')
    expect(second.state).toBe('completed')
    expect(second.applied, 'a re-import applies nothing').toBe(0)
    expect(second.skipped, 'a re-import skips every row').toBe(6)
    expect(second.runId, 'a re-import is a NEW run, recorded as having happened').not.toBe(
      first.runId,
    )

    // The claim: every column of every row, including the generated ids, is byte-identical.
    expect(await exactChecksum(sql, PROBE_TARGET)).toBe(afterFirst)
    expect(second.targets[0]?.exactBefore).toBe(second.targets[0]?.exactAfter)

    // The control, and it is what stops the assertion above being satisfied by a checksum that cannot
    // move: a THIRD import of a different file must change it.
    const third = await importProbe(probeFile(2), 'live')
    expect(
      third.applied,
      'a different file must still import: idempotence is keyed on the row content, not on whether this ' +
        'importer has run before',
    ).toBe(2)
    expect(
      await exactChecksum(sql, PROBE_TARGET),
      'a checksum that cannot move measures nothing, and every claim in this unit is a comparison of two',
    ).not.toBe(afterFirst)
  })

  it('records the skip against the run that had already applied the row', async () => {
    const file = probeFile(3)
    const first = await importProbe(file, 'live')
    const second = await importProbe(file, 'live')
    const detail = await sql<{ outcomeDetail: string }[]>`
      select outcome_detail as "outcomeDetail"
        from import_staging.import_row
       where run_id = ${second.runId}::uuid
       order by line_number
       limit 1
    `
    expect(detail[0]?.outcomeDetail).toBe(`already imported by run ${first.runId}`)
  })
})

describe('an import killed at a random row', () => {
  it('resumes to a final state identical to an uninterrupted run', async () => {
    const rows = 8
    const file = probeFile(rows)

    // The uninterrupted run: a dry run, which applies every row and rolls back. Its report carries the
    // content checksum the target WOULD have held, which is the state the resumed run has to reach.
    const rehearsal = await importProbe(file, 'dry-run')
    expect(rehearsal.applied).toBe(rows)
    expect(rehearsal.committed).toBe(false)
    const expected = rehearsal.targets[0]?.contentAfter
    expect(expected, 'the rehearsal reported a checksum to compare against').toMatch(
      /^[0-9a-f]{32}$/,
    )
    expect(await countRows(sql, 'probe'), 'the rehearsal left nothing behind').toBe(0)

    // The kill: the row is chosen at random and the failure is raised AFTER the entity insert, so the
    // interrupted row is one whose five writes were all in flight.
    const killAt = 1 + Math.floor(Math.random() * (rows - 1))
    let reached = 0
    const base = probeImporter()
    const killing: ImporterDefinition = {
      ...base,
      async apply(uow: UnitOfWork, payload: Readonly<Record<string, unknown>>) {
        reached += 1
        const entities = await base.apply(uow, payload)
        if (reached === killAt) throw new Error(`killed at row ${killAt}`)
        return entities
      },
    }

    let killed = false
    try {
      await importProbe(file, 'live', killing)
    } catch {
      killed = true
    }
    expect(killed, `the import survived the failure at row ${killAt}`).toBe(true)

    const open = await sql<{ id: string; resumedCount: number; finishedAt: Date | null }[]>`
      select id, resumed_count as "resumedCount", finished_at as "finishedAt"
        from import_staging.import_run
       where source_file_hash = ${rehearsal.sourceFileHash} and mode = 'live' and state = 'running'
    `
    expect(open.length, `killed at row ${killAt}: exactly one run is left open to resume`).toBe(1)
    const killedRunId = open[0]?.id as string
    // Nothing was written after the row transaction aborted: this is what a session kill would have proved
    // and is the reason one is not used here (see the file comment). A `finally` that recorded the failure,
    // or any other post-mortem write, would show in one of these four.
    expect(
      open[0]?.resumedCount,
      `killed at row ${killAt}: the run row is as staging left it`,
    ).toBe(0)
    expect(open[0]?.finishedAt).toBeNull()
    expect(await auditRows(sql, 'migration.import.failed', killedRunId)).toBe(0)
    expect(await outboxRows(sql, `migration.import.failed:${killedRunId}`)).toBe(0)
    const states = await rowStates(sql, killedRunId)
    expect(
      states['applied'] ?? 0,
      `killed at row ${killAt}: the rows committed before the kill survived it`,
    ).toBe(killAt - 1)
    expect(states['pending'] ?? 0, `killed at row ${killAt}: the rest are still to do`).toBe(
      rows - killAt + 1,
    )
    expect(
      await countRows(sql, 'probe'),
      `killed at row ${killAt}: the row being applied when the session died is not half-written`,
    ).toBe(killAt - 1)

    // The resume. Same file, so the same run — never a second one.
    const resumed = await importProbe(file, 'live')
    expect(resumed.runId, `killed at row ${killAt}: the resume continued the open run`).toBe(
      killedRunId,
    )
    expect(resumed.resumed).toBe(true)
    expect(resumed.resumedCount).toBe(1)
    expect(resumed.state).toBe('completed')
    expect(resumed.applied).toBe(rows - killAt + 1)
    expect(await countRows(sql, 'probe')).toBe(rows)

    expect(
      await contentChecksum(sql, PROBE_TARGET),
      `killed at row ${killAt}: the resumed import must reach the state the uninterrupted one reached`,
    ).toBe(expected)
    // And the control: a checksum that could not tell two states apart would satisfy the line above
    // whatever happened. One more row must move it.
    await importProbe(probeFile(1), 'live')
    expect(
      await contentChecksum(sql, PROBE_TARGET),
      'a checksum that cannot move measures nothing, and every claim in this unit is a comparison of two',
    ).not.toBe(expected)
  })
})

describe('dry-run mode', () => {
  it('leaves every table checksum unchanged and still produces a full report', async () => {
    await importProbe(probeFile(2), 'live')
    const before = await exactChecksum(sql, PROBE_TARGET)
    const beforeRuns = await sql<{ n: string }[]>`
      select count(*)::text as n from import_staging.import_run
    `

    const report = await importProbe(probeFile(5), 'dry-run')

    expect(await exactChecksum(sql, PROBE_TARGET), 'a rehearsal changes nothing').toBe(before)
    const afterRuns = await sql<{ n: string }[]>`
      select count(*)::text as n from import_staging.import_run
    `
    expect(afterRuns[0]?.n, 'not even the run row survives a rehearsal').toBe(beforeRuns[0]?.n)
    expect(await runState(sql, report.runId), 'the report names a run that was rolled back').toBe(
      null,
    )

    // "a full report": every field a live run's report carries, including what the checksums WOULD have
    // become. A rehearsal whose report said only "5 rows would be imported" would not be a rehearsal of
    // anything a person could check.
    expect(report.committed).toBe(false)
    expect(report.state).toBe('completed')
    expect(report.staged).toBe(5)
    expect(report.applied).toBe(5)
    expect(report.skipped).toBe(0)
    expect(report.rejected).toBe(0)
    expect(report.pending).toBe(0)
    expect(report.targets).toHaveLength(1)
    expect(report.targets[0]?.relation).toBe(PROBE_TARGET)
    expect(report.targets[0]?.exactBefore).toBe(before)
    expect(
      report.targets[0]?.exactAfter,
      'the report says what the table would have held, which is the whole value of a rehearsal',
    ).not.toBe(before)
    expect(report.targets[0]?.unprovenancedRows).toBe(0)
    expect(report.importerVersion).toBe(probeImporter().version)
    expect(report.sourceFileHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('fires the DEFERRED checks it would otherwise never reach', async () => {
    // The trap this whole mode turns on: ZY196 is a deferred constraint trigger, so a transaction that
    // never commits never fires it, and a rehearsal would report success over exactly the defect the
    // trigger exists to find. `set constraints all immediate` is what makes the rehearsal as strong as the
    // run — and this is the case that proves the line is still there.
    let raised: unknown
    try {
      await importProbe(probeFile(3), 'dry-run', probeImporter({ forgetProvenance: true }))
    } catch (error) {
      raised = error
    }
    expect(
      sqlState(raised),
      'a rehearsal of a broken importer must refuse, not report success',
    ).toBe(MIGRATION_SQLSTATE.missingProvenance)
    // The control: the same rehearsal with a correct importer completes, so the refusal above is about the
    // missing provenance and not about dry runs in general.
    const clean = await importProbe(probeFile(3), 'dry-run')
    expect(clean.applied).toBe(3)
  })
})

describe('provenance', () => {
  it('resolves every imported row to its file, line and content hash, with no gaps', async () => {
    const file = probeFile(4)
    const report = await importProbe(file, 'live')
    const entities = await sql<{ id: string; probeKey: string }[]>`
      select id, probe_key as "probeKey"
        from import_staging.import_probe_entity
       order by probe_key
    `
    expect(entities).toHaveLength(4)

    for (const entity of entities) {
      const resolved = await resolveProvenance(sql, {
        schema: 'import_staging',
        table: 'import_probe_entity',
        id: entity.id,
      })
      expect(resolved, `${entity.probeKey} resolves to a source row`).not.toBeNull()
      expect(resolved?.sourceFile).toBe(report.sourceFile)
      expect(resolved?.sourceFileHash).toBe(report.sourceFileHash)
      expect(resolved?.contentHash).toMatch(/^[0-9a-f]{64}$/)
      expect(resolved?.importerVersion).toBe(probeImporter().version)
      expect(resolved?.runId).toBe(report.runId)
      // The line number is the line of the FILE, which is what somebody opening the spreadsheet needs.
      const line = resolved?.sourceLine ?? 0
      expect(file.split('\n')[line - 1]).toContain(entity.probeKey)
    }

    // 100% coverage, measured from the target table's side rather than from the ledger's — the direction
    // ZY196 cannot see, because a row nobody staged has no staged row to refuse.
    expect(await unprovenancedRowIds(sql, PROBE_TARGET)).toEqual([])
    expect(report.targets[0]?.unprovenancedRows).toBe(0)
  })

  it('detects a row that arrived without provenance, so the zero above is not vacuous', async () => {
    await importProbe(probeFile(2), 'live')
    const inserted = await sql<{ id: string }[]>`
      insert into import_staging.import_probe_entity (probe_key, label, amount_fils)
      values (${`${PROBE_KEY_PREFIX}${NONCE}-smuggled`}, 'inserted behind the framework', 100)
      returning id
    `
    const id = inserted[0]?.id as string
    expect(await unprovenancedRowIds(sql, PROBE_TARGET)).toEqual([id])
    await sql`delete from import_staging.import_probe_entity where id = ${id}::uuid`
    expect(await unprovenancedRowIds(sql, PROBE_TARGET)).toEqual([])
  })

  it('cannot commit a row that was applied with no provenance', async () => {
    let raised: unknown
    try {
      await importProbe(probeFile(2), 'live', probeImporter({ forgetProvenance: true }))
    } catch (error) {
      raised = error
    }
    expect(sqlState(raised)).toBe(MIGRATION_SQLSTATE.missingProvenance)
    // And nothing was left behind by the refused transaction.
    expect(await countRows(sql, 'probe')).toBe(0)
  })
})

describe('a rolled-back import', () => {
  it('discards its audit rows and its outbox events with its data (ADR 0008)', async () => {
    // The CONTROL first, so the zeros below cannot be satisfied by a framework that writes neither. A
    // correct import writes one audit row and one outbox event per applied row, in the row's transaction.
    const good = await importProbe(probeFile(2), 'live')
    const appliedRows = await sql<{ id: string }[]>`
      select id from import_staging.import_row
       where run_id = ${good.runId}::uuid and state = 'applied'
       order by line_number
    `
    expect(appliedRows).toHaveLength(2)
    for (const row of appliedRows) {
      expect(await auditRows(sql, 'migration.row.imported', row.id)).toBe(1)
      expect(await outboxRows(sql, `migration.row.imported:${row.id}`)).toBe(1)
    }

    // Now the refusal, which arrives at COMMIT — after the entity insert, the audit row and the event have
    // all been written. All four must go together.
    const beforeAudit = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'migration.row.imported'
    `
    const beforeOutbox = await sql<{ n: string }[]>`
      select count(*)::text as n from outbox_event where event_type = 'migration.row.imported'
    `
    let raised: unknown
    try {
      await importProbe(probeFile(3), 'live', probeImporter({ forgetProvenance: true }))
    } catch (error) {
      raised = error
    }
    expect(sqlState(raised)).toBe(MIGRATION_SQLSTATE.missingProvenance)

    const afterAudit = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'migration.row.imported'
    `
    const afterOutbox = await sql<{ n: string }[]>`
      select count(*)::text as n from outbox_event where event_type = 'migration.row.imported'
    `
    // A DELTA and not a total, because `audit_event` is append-only and only ever grows (brief rule 9).
    expect(Number(afterAudit[0]?.n) - Number(beforeAudit[0]?.n)).toBe(0)
    expect(Number(afterOutbox[0]?.n) - Number(beforeOutbox[0]?.n)).toBe(0)
    expect(
      await countRows(sql, 'probe'),
      'the two imported rows, and none of the refused three',
    ).toBe(2)
  })
})

describe('a malformed row', () => {
  it('stops the run before anything is applied, and the report names it by line', async () => {
    const file = probeFile(5, { malformedAt: 3 })
    const report = await importProbe(file, 'live')

    expect(report.state).toBe('failed')
    expect(report.applied, 'a file with a bad row imports nothing at all').toBe(0)
    expect(report.rejected).toBe(1)
    expect(report.rejections).toEqual([
      { lineNumber: 4, reason: PROBE_REJECTIONS.amountNotInteger },
    ])
    expect(await countRows(sql, 'probe')).toBe(0)
    expect(report.targets[0]?.exactBefore).toBe(report.targets[0]?.exactAfter)

    // The rejected row is COMMITTED as rejected: it is the evidence, and the report that names it is read
    // after the process has gone.
    const states = await rowStates(sql, report.runId)
    expect(states['rejected']).toBe(1)
    expect(states['pending']).toBe(4)
    expect(await runState(sql, report.runId)).toBe('failed')

    // The control: the same file without the bad row imports cleanly, so "failed" is about the row.
    const clean = await importProbe(probeFile(5), 'live')
    expect(clean.state).toBe('completed')
    expect(clean.applied).toBe(5)
  })
})
