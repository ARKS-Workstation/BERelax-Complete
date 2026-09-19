import { AppError } from '@berelax/shared'
import type { SealedPayload } from '../envelope.ts'
import {
  CLINICAL_KEK_ERRORS,
  type ClinicalKeyStore,
  type ClinicalSealedTable,
  type KekRotationReport,
  type KekVersionRow,
  type RewrapWrite,
  type SealedRecord,
} from './rotate.ts'

/**
 * An in-memory `ClinicalKeyStore`, for the unit suite.
 *
 * It enforces the same two refusals as migration 0043 — a write onto a version that is not active,
 * and a version change that leaves the wrapped key unchanged — **on purpose**. A double that accepts
 * what PostgreSQL rejects makes the unit tests pass on writes production would refuse, which is worse
 * than having no double: the suite then reports confidence it has not earned. The behaviour against
 * the real database is proved separately by `rotation.itest.ts`.
 */
export interface MemoryClinicalKeyStore extends ClinicalKeyStore {
  records(): readonly SealedRecord[]
  registry(): readonly KekVersionRow[]
  /** Audit rows this store was asked to write, oldest first. */
  events(): readonly {
    readonly kind: 'started' | 'completed'
    readonly detail: Readonly<Record<string, unknown>>
  }[]
  put(record: SealedRecord): void
}

export function createMemoryClinicalKeyStore(args: {
  readonly activeVersion: string
  readonly records?: readonly SealedRecord[]
}): MemoryClinicalKeyStore {
  const registry = new Map<string, KekVersionRow>([
    [args.activeVersion, { version: args.activeVersion, status: 'active' }],
  ])
  const rows = new Map<string, SealedRecord>()
  const events: {
    kind: 'started' | 'completed'
    detail: Readonly<Record<string, unknown>>
  }[] = []

  const key = (table: ClinicalSealedTable, recordId: string) => `${table}#${recordId}`
  const activeVersion = () => [...registry.values()].find((row) => row.status === 'active')?.version

  const put = (record: SealedRecord) => {
    rows.set(key(record.table, record.recordId), record)
  }
  for (const record of args.records ?? []) put(record)

  return {
    put,
    records: () => [...rows.values()],
    registry: () => [...registry.values()],
    events: () => events.map((event) => ({ ...event })),

    readKekVersions: async () => [...registry.values()],

    promoteKekVersion: async ({ from, to }) => {
      const source = registry.get(from)
      if (source?.status !== 'active') {
        throw new AppError(
          'invariant_violated',
          `${CLINICAL_KEK_ERRORS.registryMismatch}: "${from}" is not the active version`,
        )
      }
      // One step, like the transaction in the Postgres store: a retired source with no active target
      // is an estate nothing may write to.
      registry.set(from, { version: from, status: 'retired' })
      registry.set(to, { version: to, status: 'active' })
    },

    countSealedOn: async (version) =>
      [...rows.values()].filter((row) => row.sealed.kekVersion === version).length,

    listSealedNotOn: async (version, limit) =>
      [...rows.values()]
        .filter((row) => row.sealed.kekVersion !== version)
        // Ordered, so a resumed run continues where the last one stopped rather than re-reading the
        // same head of the queue.
        .sort((a, b) => key(a.table, a.recordId).localeCompare(key(b.table, b.recordId)))
        .slice(0, limit),

    listSealedOn: async ({ version, limit, after }) => {
      const cursor = after === undefined ? '' : key(after.table, after.recordId)
      return [...rows.values()]
        .filter((row) => row.sealed.kekVersion === version)
        .sort((a, b) => key(a.table, a.recordId).localeCompare(key(b.table, b.recordId)))
        .filter((row) => key(row.table, row.recordId) > cursor)
        .slice(0, limit)
    },

    rewrapOne: async (write: RewrapWrite) => {
      const existing = rows.get(key(write.table, write.recordId))
      if (existing === undefined) {
        throw new AppError('invariant_violated', `no such record ${write.recordId}`)
      }
      if (write.toVersion !== activeVersion()) {
        throw new AppError(
          'forbidden',
          `${CLINICAL_KEK_ERRORS.retiredCannotEncrypt}: KEK version "${write.toVersion}" may not ` +
            `encrypt; "${activeVersion() ?? '(none)'}" is the active version.`,
        )
      }
      if (existing.sealed.wrappedDataKey.equals(write.wrappedDataKey)) {
        throw new AppError(
          'invariant_violated',
          `RewrapDidNotRewrap: ${write.recordId} kept its wrapped key while changing version`,
        )
      }
      const sealed: SealedPayload = {
        ...existing.sealed,
        wrappedDataKey: write.wrappedDataKey,
        kekVersion: write.toVersion,
      }
      rows.set(key(write.table, write.recordId), { ...existing, sealed })
    },

    recordRotationStarted: async (detail) => {
      events.push({ kind: 'started', detail: { ...detail } })
    },
    recordRotationCompleted: async (report: KekRotationReport) => {
      events.push({ kind: 'completed', detail: { ...report } })
    },
  }
}
