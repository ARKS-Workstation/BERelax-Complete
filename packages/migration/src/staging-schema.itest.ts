import { createHash, randomUUID } from 'node:crypto'
import { createConnection, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contentChecksum, exactChecksum } from './checksum.ts'
import { clearProbeEntities, PROBE_KEY_PREFIX, PROBE_TARGET } from './conformance/probe-importer.ts'
import { MIGRATION_SQLSTATE } from './refusals.ts'

/**
 * Every refusal migration 0111 raises, shown to fire, and every one shown to be about its own subject.
 *
 * `framework.itest.ts` drives the framework end to end and therefore exercises the schema the way an
 * importer will. This file is the other half: it issues the statements a framework never issues, because the
 * rules exist for the cases the framework does not produce — a second process, a hand-run `psql` correction,
 * a later importer that goes its own way. A rule nobody has seen fail may not be a rule (ADR 0003).
 *
 * ## Why nothing here is cleaned up, and why that is safe to run repeatedly
 *
 * The staging ledger is append-only by construction: ZY192 refuses a DELETE on a staged row for every role
 * including the owner, and ZY195 does the same for provenance. So these rows stay, which is the point of a
 * ledger — and it means every value this file writes has to be unique to this execution. Run ids come from
 * the database; source file hashes are derived from a fresh uuid, which also keeps ZY191 from firing between
 * unrelated cases.
 *
 * The one thing that IS emptied is the conformance target, through the single scoped statement in
 * `clearProbeEntities`.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

const NONCE = `${process.pid}-${randomUUID().slice(0, 8)}`
const HASH_64 = /^[0-9a-f]{64}$/

/** A distinct, well-formed source-file hash per case, so no two cases collide on ZY191. */
const freshFileHash = (): string => createHash('sha256').update(randomUUID()).digest('hex')

const rowHash = (label: string): string => createHash('sha256').update(label).digest('hex')

interface OpenRunOptions {
  readonly mode?: 'live' | 'dry-run'
  readonly importer?: string
  readonly sourceFileHash?: string
  readonly targetTables?: readonly string[]
}

async function openRun(options: OpenRunOptions = {}): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into import_staging.import_run (
      importer, importer_version, source_file, source_file_hash, mode, state, target_tables, actor_label
    ) values (
      ${options.importer ?? `schema-probe-${NONCE}`},
      '1',
      ${`artifacts/migration/schema-${NONCE}.tsv`},
      ${options.sourceFileHash ?? freshFileHash()},
      ${options.mode ?? 'live'},
      'running',
      ${[...(options.targetTables ?? [PROBE_TARGET])]}::text[],
      'H-MIG-01 schema suite'
    )
    returning id
  `
  return rows[0]?.id as string
}

async function stageRow(runId: string, line: number, state = 'pending'): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into import_staging.import_row (run_id, line_number, row_hash, payload, state, outcome_detail)
    values (
      ${runId}::uuid, ${line}, ${rowHash(`${runId}:${line}`)},
      ${sql.json({ line } as never)}, ${state},
      ${state === 'pending' || state === 'applied' ? null : 'stated by the suite'}
    )
    returning id
  `
  return rows[0]?.id as string
}

async function insertProbe(key: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into import_staging.import_probe_entity (probe_key, label, amount_fils)
    values (${key}, 'schema suite', 1)
    returning id
  `
  return rows[0]?.id as string
}

/** The SQLSTATE of a refused statement, or a failure naming what happened instead. */
async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    return typeof code === 'string' ? code : `no SQLSTATE on: ${String(error)}`
  }
  return 'the statement was accepted'
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  await clearProbeEntities(sql)
})

afterAll(async () => {
  await clearProbeEntities(sql)
  await sql?.end({ timeout: 5 })
})

describe('ZY191 — one open live run per (importer, source file)', () => {
  it('refuses a second live run and permits a rehearsal alongside it', async () => {
    const importer = `zy191-${NONCE}`
    const sourceFileHash = freshFileHash()
    await openRun({ importer, sourceFileHash })
    expect(await refusalCode(() => openRun({ importer, sourceFileHash }))).toBe(
      MIGRATION_SQLSTATE.runAlreadyOpen,
    )
    // Scoped to LIVE runs on purpose: a dry run rolls back and applies nothing, so rehearsing a file whose
    // live run is stuck is the most useful thing anybody could do about it.
    await openRun({ importer, sourceFileHash, mode: 'dry-run' })
    // And the control: another FILE is another run, so the rule is about the file and not about the
    // importer being busy.
    await openRun({ importer, sourceFileHash: freshFileHash() })
  })
})

describe('ZY192 — a staged row is evidence', () => {
  it('refuses a terminal outcome being changed, the payload being edited, and any delete', async () => {
    const runId = await openRun()
    const applied = await stageRow(runId, 1)
    const entityId = await insertProbe(`${PROBE_KEY_PREFIX}${NONCE}-zy192`)
    await sql`
      insert into import_staging.import_provenance
        (import_row_id, target_schema, target_table, target_id)
      values (${applied}::uuid, 'import_staging', 'import_probe_entity', ${entityId})
    `
    await sql`update import_staging.import_row set state = 'applied', applied_at = now()
               where id = ${applied}::uuid`

    // Reopening an applied row is what would let a resumed run apply it a second time.
    expect(
      await refusalCode(
        () =>
          sql`update import_staging.import_row set state = 'pending', applied_at = null
               where id = ${applied}::uuid`,
      ),
    ).toBe(MIGRATION_SQLSTATE.stagedRowImmutable)

    const pending = await stageRow(runId, 2)
    // The payload and the hash are the record of what was read, so provenance keeps resolving to it.
    expect(
      await refusalCode(
        () =>
          sql`update import_staging.import_row set payload = ${sql.json({ edited: true } as never)}
               where id = ${pending}::uuid`,
      ),
    ).toBe(MIGRATION_SQLSTATE.stagedRowImmutable)
    expect(
      await refusalCode(
        () => sql`update import_staging.import_row set row_hash = ${rowHash('elsewhere')}
                   where id = ${pending}::uuid`,
      ),
    ).toBe(MIGRATION_SQLSTATE.stagedRowImmutable)
    expect(
      await refusalCode(
        () => sql`delete from import_staging.import_row where id = ${pending}::uuid`,
      ),
    ).toBe(MIGRATION_SQLSTATE.stagedRowImmutable)

    // The control: the ONE permitted update still works, or the four refusals above would be satisfied by
    // a trigger that refuses everything — and the framework could not record progress at all.
    await sql`update import_staging.import_row
                 set state = 'skipped', outcome_detail = 'stated by the suite'
               where id = ${pending}::uuid`
    const after = await sql<{ state: string }[]>`
      select state from import_staging.import_row where id = ${pending}::uuid
    `
    expect(after[0]?.state).toBe('skipped')
  })
})

describe('ZY193 — a finished run takes no more rows', () => {
  it('refuses a row staged after the run closed', async () => {
    const runId = await openRun()
    await stageRow(runId, 1, 'rejected')
    await sql`update import_staging.import_run set state = 'failed', finished_at = now()
               where id = ${runId}::uuid`
    expect(await refusalCode(() => stageRow(runId, 2))).toBe(MIGRATION_SQLSTATE.runClosed)
    // The control: an OPEN run takes the same statement, so the refusal is about the run's state.
    const open = await openRun()
    await stageRow(open, 2)
  })
})

describe('ZY194 — provenance may only name a declared target', () => {
  it('refuses an undeclared table and accepts the declared one', async () => {
    const runId = await openRun({ targetTables: [PROBE_TARGET] })
    const row = await stageRow(runId, 1)
    expect(
      await refusalCode(
        () => sql`
          insert into import_staging.import_provenance
            (import_row_id, target_schema, target_table, target_id)
          values (${row}::uuid, 'public', 'package_sale', ${randomUUID()})
        `,
      ),
    ).toBe(MIGRATION_SQLSTATE.undeclaredTarget)
    const entityId = await insertProbe(`${PROBE_KEY_PREFIX}${NONCE}-zy194`)
    await sql`
      insert into import_staging.import_provenance
        (import_row_id, target_schema, target_table, target_id)
      values (${row}::uuid, 'import_staging', 'import_probe_entity', ${entityId})
    `
  })
})

describe('ZY195 — provenance is append-only', () => {
  it('refuses both an update and a delete', async () => {
    const runId = await openRun()
    const row = await stageRow(runId, 1)
    const entityId = await insertProbe(`${PROBE_KEY_PREFIX}${NONCE}-zy195`)
    const inserted = await sql<{ id: string }[]>`
      insert into import_staging.import_provenance
        (import_row_id, target_schema, target_table, target_id)
      values (${row}::uuid, 'import_staging', 'import_probe_entity', ${entityId})
      returning id
    `
    const id = inserted[0]?.id as string
    // Both events, because the half-written pair — one trigger copied for the other event with the word
    // not changed — is where this defect always hides.
    expect(
      await refusalCode(
        () =>
          sql`update import_staging.import_provenance set target_id = ${randomUUID()}
               where id = ${id}::uuid`,
      ),
    ).toBe(MIGRATION_SQLSTATE.provenanceAppendOnly)
    expect(
      await refusalCode(
        () => sql`delete from import_staging.import_provenance where id = ${id}::uuid`,
      ),
    ).toBe(MIGRATION_SQLSTATE.provenanceAppendOnly)
  })

  it('refuses a second claim on one target row, naming the constraint', async () => {
    const runId = await openRun()
    const first = await stageRow(runId, 1)
    const second = await stageRow(runId, 2)
    const entityId = await insertProbe(`${PROBE_KEY_PREFIX}${NONCE}-zy195b`)
    await sql`
      insert into import_staging.import_provenance
        (import_row_id, target_schema, target_table, target_id)
      values (${first}::uuid, 'import_staging', 'import_probe_entity', ${entityId})
    `
    // 23505 and not a private code, deliberately: the unique violation names the constraint and the values,
    // which is more than a bespoke message would say, and there is no separate remedy to point at.
    expect(
      await refusalCode(
        () => sql`
          insert into import_staging.import_provenance
            (import_row_id, target_schema, target_table, target_id)
          values (${second}::uuid, 'import_staging', 'import_probe_entity', ${entityId})
        `,
      ),
    ).toBe('23505')
  })
})

describe('ZY196 — an applied row carries provenance', () => {
  it('is refused at COMMIT and not before, so the statement order is the importer’s business', async () => {
    const runId = await openRun()
    const row = await stageRow(runId, 1)
    // Inside a transaction the update SUCCEEDS — that is what deferred means, and it is what lets an
    // importer write its provenance after marking the row rather than before.
    const code = await refusalCode(() =>
      sql.begin(async (tx) => {
        await tx`update import_staging.import_row set state = 'applied', applied_at = now()
                  where id = ${row}::uuid`
        await tx`set constraints all immediate`
      }),
    )
    expect(code).toBe(MIGRATION_SQLSTATE.missingProvenance)
    const state = await sql<{ state: string }[]>`
      select state from import_staging.import_row where id = ${row}::uuid
    `
    expect(state[0]?.state, 'the refused transaction changed nothing').toBe('pending')

    // The control: the same transaction with provenance in it commits, so the refusal is about the missing
    // row and not about the update.
    const entityId = await insertProbe(`${PROBE_KEY_PREFIX}${NONCE}-zy196`)
    await sql.begin(async (tx) => {
      await tx`update import_staging.import_row set state = 'applied', applied_at = now()
                where id = ${row}::uuid`
      await tx`
        insert into import_staging.import_provenance
          (import_row_id, target_schema, target_table, target_id)
        values (${row}::uuid, 'import_staging', 'import_probe_entity', ${entityId})
      `
    })
    const applied = await sql<{ state: string }[]>`
      select state from import_staging.import_row where id = ${row}::uuid
    `
    expect(applied[0]?.state).toBe('applied')
  })
})

describe('ZY198 — a completed run has no pending rows', () => {
  it('refuses the completion, because the next import would skip them as already imported', async () => {
    const runId = await openRun()
    await stageRow(runId, 1)
    expect(
      await refusalCode(
        () =>
          sql`update import_staging.import_run set state = 'completed', finished_at = now()
               where id = ${runId}::uuid`,
      ),
    ).toBe(MIGRATION_SQLSTATE.pendingRowsAtCompletion)
    // The control: `failed` is permitted with rows pending — that is how a run with a rejected row ends —
    // so the refusal is about the claim `completed` makes and not about closing a run.
    await sql`update import_staging.import_run set state = 'failed', finished_at = now()
               where id = ${runId}::uuid`
  })
})

describe('the checksum and the coverage read', () => {
  it('refuses a checksum over no columns rather than returning md5 of nothing (ZY197)', async () => {
    expect(
      await refusalCode(() =>
        contentChecksum(sql, PROBE_TARGET, [
          'id',
          'probe_key',
          'label',
          'amount_fils',
          'created_at',
        ]),
      ),
    ).toBe(MIGRATION_SQLSTATE.emptyChecksum)
  })

  it('says "empty" for a relation with no rows, and moves when content changes', async () => {
    await clearProbeEntities(sql)
    const empty = await exactChecksum(sql, PROBE_TARGET)
    expect(empty, 'an empty relation is distinguishable from a read that covered nothing').toBe(
      `empty:${PROBE_TARGET}`,
    )
    const first = await insertProbe(`${PROBE_KEY_PREFIX}${NONCE}-sum-a`)
    const one = await exactChecksum(sql, PROBE_TARGET)
    expect(one).toMatch(/^[0-9a-f]{32}$/)
    await insertProbe(`${PROBE_KEY_PREFIX}${NONCE}-sum-b`)
    const two = await exactChecksum(sql, PROBE_TARGET)
    expect(two).not.toBe(one)
    // The content checksum ignores the generated columns and nothing else: changing an AMOUNT must move it.
    const beforeAmount = await contentChecksum(sql, PROBE_TARGET)
    await sql`update import_staging.import_probe_entity set amount_fils = 99 where id = ${first}::uuid`
    expect(await contentChecksum(sql, PROBE_TARGET)).not.toBe(beforeAmount)
    await clearProbeEntities(sql)
  })

  it('refuses a coverage read over a relation provenance cannot address (ZY199)', async () => {
    // `outbox_delivery` is keyed on (event_id, handler). Provenance names ONE target_id, so a coverage read
    // here could only ever return nothing — which reads as full coverage.
    expect(
      await refusalCode(
        () => sql`select import_staging.unprovenanced_row_ids('public.outbox_delivery'::regclass)`,
      ),
    ).toBe(MIGRATION_SQLSTATE.unreadableCoverageTarget)
  })
})

describe('the resolution view and the grants', () => {
  it('resolves a target row to its file, line and content hash in one read', async () => {
    const sourceFileHash = freshFileHash()
    const runId = await openRun({ sourceFileHash })
    const row = await stageRow(runId, 7)
    const entityId = await insertProbe(`${PROBE_KEY_PREFIX}${NONCE}-view`)
    await sql`
      insert into import_staging.import_provenance
        (import_row_id, target_schema, target_table, target_id)
      values (${row}::uuid, 'import_staging', 'import_probe_entity', ${entityId})
    `
    const resolved = await sql<
      { sourceLine: number; contentHash: string; sourceFileHash: string; importerVersion: string }[]
    >`
      select source_line as "sourceLine", content_hash as "contentHash",
             source_file_hash as "sourceFileHash", importer_version as "importerVersion"
        from import_staging.entity_provenance
       where target_schema = 'import_staging'
         and target_table = 'import_probe_entity'
         and target_id = ${entityId}
    `
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.sourceLine).toBe(7)
    expect(resolved[0]?.sourceFileHash).toBe(sourceFileHash)
    expect(resolved[0]?.contentHash).toMatch(HASH_64)
    expect(resolved[0]?.importerVersion).toBe('1')
  })

  it('gives the application role no way to remove anything from the schema', async () => {
    // The refusal triggers and the grants have to agree. A role holding DELETE on an append-only table is
    // append-only by convention, and the first statement to find out is one issued in production.
    const rows = await sql<{ relation: string; privilege: string; held: boolean }[]>`
      select r.relation, p.privilege,
             has_table_privilege('berelax_app', r.relation, p.privilege) as held
        from (values ('import_staging.import_run'), ('import_staging.import_row'),
                     ('import_staging.import_provenance'),
                     ('import_staging.import_probe_entity')) as r(relation),
             (values ('delete'), ('truncate'), ('select'), ('insert')) as p(privilege)
    `
    const held = new Map(rows.map((row) => [`${row.relation}:${row.privilege}`, row.held]))
    for (const relation of [
      'import_staging.import_run',
      'import_staging.import_row',
      'import_staging.import_provenance',
      'import_staging.import_probe_entity',
    ]) {
      expect(held.get(`${relation}:delete`), `${relation} DELETE`).toBe(false)
      expect(held.get(`${relation}:truncate`), `${relation} TRUNCATE`).toBe(false)
      // The control: the role can still read and write, so the two assertions above are not simply
      // measuring a role with no privileges at all.
      expect(held.get(`${relation}:select`), `${relation} SELECT`).toBe(true)
      expect(held.get(`${relation}:insert`), `${relation} INSERT`).toBe(true)
    }
    // And UPDATE only where progress is recorded.
    const updates = await sql<{ run: boolean; row: boolean; prov: boolean; probe: boolean }[]>`
      select has_table_privilege('berelax_app', 'import_staging.import_run', 'update') as run,
             has_table_privilege('berelax_app', 'import_staging.import_row', 'update') as row,
             has_table_privilege('berelax_app', 'import_staging.import_provenance', 'update') as prov,
             has_table_privilege('berelax_app', 'import_staging.import_probe_entity', 'update') as probe
    `
    expect(updates[0]?.run).toBe(true)
    expect(updates[0]?.row).toBe(true)
    expect(updates[0]?.prov).toBe(false)
    expect(updates[0]?.probe).toBe(false)
  })
})
