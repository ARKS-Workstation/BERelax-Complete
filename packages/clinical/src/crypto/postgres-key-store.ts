import { AuditWriter, type Sql } from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { SealedPayload } from '../envelope.ts'
import {
  CLINICAL_SEALED_TABLES,
  type ClinicalKeyStore,
  type ClinicalSealedTable,
  type KekRotationReport,
  type KekVersionRow,
  type RewrapWrite,
  type SealedRecord,
} from './rotate.ts'

/**
 * The PostgreSQL `ClinicalKeyStore`.
 *
 * Nothing in this file decrypts anything, and the KEK is not a parameter of any function in it — the
 * same rule `packages/google/src/postgres-store.ts` follows, for the same reason: a bug in a query
 * here cannot leak a payload, not even into an error message.
 *
 * Every column read is a sealed column plus the row identity the AAD binds it to. The two tables
 * spell their ciphertext differently (`payload_ciphertext` versus `body_ciphertext`), so the column
 * names are per-table and everything else is shared.
 */

/**
 * Per-table column names. Everything else about the two tables is identical.
 *
 * `aadContext` is the column holding the fourth AAD term, or null for a table whose payloads bind only
 * the three-term row identity. It is READ rather than derived, and that is what keeps the rotation
 * correct: a re-wrap has to reproduce the exact AAD a payload was sealed under, so a term the rotation
 * cannot see is a row the rotation cannot re-wrap — and it would present as `ClinicalDekUnwrapFailed`
 * on a row nothing is wrong with, at 03:00, half way through a key rotation.
 */
const SEALED_COLUMNS: Record<
  ClinicalSealedTable,
  {
    readonly relation: string
    readonly ciphertext: string
    readonly nonce: string
    readonly aadContext: string | null
  }
> = {
  'clinical.intake_submission': {
    relation: 'clinical.intake_submission',
    ciphertext: 'payload_ciphertext',
    nonce: 'payload_nonce',
    // `template_version=<n>` (migration 0082). A CHECK ties it to the template_version column.
    aadContext: 'aad_context',
  },
  'clinical.treatment_note': {
    relation: 'clinical.treatment_note',
    ciphertext: 'body_ciphertext',
    nonce: 'body_nonce',
    aadContext: null,
  },
}

interface SealedRow {
  readonly id: string
  readonly customer_id: string
  readonly ciphertext: Buffer
  readonly nonce: Buffer
  readonly wrapped_data_key: Buffer
  readonly kek_version: string
  readonly aad_fingerprint: string
  readonly aad_context: string | null
}

const toSealedRecord = (table: ClinicalSealedTable, row: SealedRow): SealedRecord => {
  const sealed: SealedPayload = {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    wrappedDataKey: row.wrapped_data_key,
    kekVersion: row.kek_version,
    aadFingerprint: row.aad_fingerprint,
  }
  // Spread rather than `context: row.aad_context ?? undefined`, because `exactOptionalPropertyTypes`
  // is on: an explicit `undefined` is not the same as an absent property, and an absent one is what
  // makes a three-term binding byte-identical to what it was before this field existed.
  return {
    table,
    recordId: row.id,
    customerId: row.customer_id,
    sealed,
    ...(row.aad_context === null ? {} : { context: row.aad_context }),
  }
}

export function createPostgresClinicalKeyStore(sql: Sql): ClinicalKeyStore {
  /**
   * The audit actor.
   *
   * `system`, because a rotation is a scheduled job and not a person: naming a staff actor would put
   * a person's id on an event they did not cause, which is worse than no actor at all in the one
   * table whose purpose is answering "who did this".
   */
  const audit = () => new AuditWriter(sql, { kind: 'system', label: 'kek-rotation' })

  return {
    readKekVersions: async () => {
      const rows = await sql<{ version: string; status: string }[]>`
        select version, status from clinical.kek_version order by activated_at, version
      `
      return rows.map((row) => {
        if (row.status !== 'active' && row.status !== 'retired') {
          throw new AppError(
            'invariant_violated',
            `clinical.kek_version holds status "${row.status}", which this code does not know. A ` +
              'status added by a migration must be handled before it is written.',
          )
        }
        return { version: row.version, status: row.status } as KekVersionRow
      })
    },

    promoteKekVersion: async ({ from, to }) => {
      // One transaction. A retired source with no active target is an estate nothing may write to,
      // and the unique index allowing one active version means the two statements cannot be reordered
      // into a state where both are active.
      await sql.begin(async (tx) => {
        const retired = await tx`
          update clinical.kek_version
             set status = 'retired', retired_at = now()
           where version = ${from} and status = 'active'
        `
        if (retired.count !== 1) {
          throw new AppError(
            'invariant_violated',
            `KekRegistryMismatch: "${from}" is not the active version, so it cannot be retired.`,
          )
        }
        await tx`
          insert into clinical.kek_version (version, status) values (${to}, 'active')
          on conflict (version) do update set status = 'active', retired_at = null
        `
      })
    },

    countSealedOn: async (version) => {
      let total = 0
      for (const table of CLINICAL_SEALED_TABLES) {
        const columns = SEALED_COLUMNS[table]
        const [row] = await sql<{ n: string }[]>`
          select count(*)::text as n from ${sql(columns.relation)} where kek_version = ${version}
        `
        total += Number(row?.n ?? '0')
      }
      return total
    },

    listSealedNotOn: async (version, limit) => {
      const found: SealedRecord[] = []
      for (const table of CLINICAL_SEALED_TABLES) {
        if (found.length >= limit) break
        const columns = SEALED_COLUMNS[table]
        // Ordered by primary key, which is a v7 UUID and therefore time-ordered: a resumed run walks
        // the remaining rows in the same order the interrupted one did.
        const rows = await sql<SealedRow[]>`
          select id,
                 customer_id,
                 ${sql(columns.ciphertext)} as ciphertext,
                 ${sql(columns.nonce)} as nonce,
                 wrapped_data_key,
                 kek_version,
                 aad_fingerprint,
                 ${columns.aadContext === null ? sql`null` : sql(columns.aadContext)} as aad_context
            from ${sql(columns.relation)}
           where kek_version <> ${version}
           order by id
           limit ${limit - found.length}
        `
        for (const row of rows) found.push(toSealedRecord(table, row))
      }
      return found
    },

    listSealedOn: async ({ version, limit, after }) => {
      const found: SealedRecord[] = []
      // The tables are walked in a fixed order and each in `id` order, so the cursor is a table plus
      // a record id. `id` is a v7 UUID, which orders by creation time, so a page boundary is stable
      // even while rows are being added.
      const startAt = after === undefined ? 0 : CLINICAL_SEALED_TABLES.indexOf(after.table)
      for (const table of CLINICAL_SEALED_TABLES.slice(startAt)) {
        if (found.length >= limit) break
        const columns = SEALED_COLUMNS[table]
        const lowerBound = after !== undefined && after.table === table ? after.recordId : null
        const rows = await sql<SealedRow[]>`
          select id,
                 customer_id,
                 ${sql(columns.ciphertext)} as ciphertext,
                 ${sql(columns.nonce)} as nonce,
                 wrapped_data_key,
                 kek_version,
                 aad_fingerprint,
                 ${columns.aadContext === null ? sql`null` : sql(columns.aadContext)} as aad_context
            from ${sql(columns.relation)}
           where kek_version = ${version}
             and (${lowerBound}::uuid is null or id > ${lowerBound}::uuid)
           order by id
           limit ${limit - found.length}
        `
        for (const row of rows) found.push(toSealedRecord(table, row))
      }
      return found
    },

    rewrapOne: async (write: RewrapWrite) => {
      const columns = SEALED_COLUMNS[write.table]
      // `kek_version = fromVersion` in the predicate is the optimistic lock: if another run has
      // already moved this row, this UPDATE matches nothing and says so, rather than overwriting a
      // wrapped key that was re-wrapped under a key this process does not hold.
      const result = await sql`
        update ${sql(columns.relation)}
           set wrapped_data_key = ${write.wrappedDataKey},
               kek_version      = ${write.toVersion}
         where id = ${write.recordId} and kek_version = ${write.fromVersion}
      `
      if (result.count !== 1) {
        throw new AppError(
          'invariant_violated',
          `KekRewrapMissedItsRow: ${write.table} ${write.recordId} was not on KEK ` +
            `"${write.fromVersion}" when the re-wrap reached it, so nothing was written.`,
          { details: { matched: result.count } },
        )
      }
    },

    recordRotationStarted: async ({ fromVersion, toVersion, pending }) => {
      // Committed before the first record moves, so a `started` with no `completed` is the evidence
      // that a rotation was interrupted. Nothing else distinguishes an interrupted rotation from one
      // that was never run — the rows themselves look the same.
      await audit().record({
        action: 'clinical.kek_rotation.started',
        entityType: 'clinical.kek_version',
        entityId: toVersion,
        operation: 'update',
        before: { fromVersion, toVersion, pending },
      })
    },

    recordRotationCompleted: async (report: KekRotationReport) => {
      await audit().record({
        action: 'clinical.kek_rotation.completed',
        entityType: 'clinical.kek_version',
        entityId: report.toVersion,
        operation: 'update',
        before: { kekVersion: report.fromVersion },
        after: {
          fromVersion: report.fromVersion,
          toVersion: report.toVersion,
          recordCount: report.scanned,
          rewrapped: report.rewrapped,
          alreadyCurrent: report.alreadyCurrent,
        },
      })
    },
  }
}
