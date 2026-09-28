import type { ConsentLog, ConsentRecord, Instant, SuppressionLog } from '@berelax/core'
import type { ConsentLogRead, SuppressionLogRead } from '@berelax/db'

/**
 * The two db reads, narrowed to the shapes `@berelax/core` decides over.
 *
 * The cast is unavoidable and is confined to this file. `recordedAt` is a plain `number` on the db side
 * because `packages/db` may not import core's `Instant` brand (the dependency runs core <- db and never
 * back), and every resolver in core takes the branded type. `merge.itest.ts` and `suppression.itest.ts`
 * each carry a local copy of this narrowing for the same reason; this is the runtime one, in one module, so
 * a third copy does not appear inside a node handler.
 *
 * What makes it honest rather than hopeful is that neither function reshapes anything: no defaulting, no
 * filtering and no reordering. A resolver that received a filtered log would answer about a log nobody
 * stored — and `resolveConsent`'s whole contract is that it is a fold over the WHOLE log at an instant.
 */
export function asConsentLog(read: ConsentLogRead): ConsentLog {
  return {
    contactId: read.contactId,
    records: read.records.map(
      (record): ConsentRecord => ({ ...record, recordedAt: record.recordedAt as Instant }),
    ),
    wordingVersions: read.wordingVersions,
  }
}

export function asSuppressionLog(read: SuppressionLogRead): SuppressionLog {
  return {
    key: read.key,
    records: read.records.map((record) => ({
      ...record,
      recordedAt: record.recordedAt as Instant,
    })),
  }
}

/** Every suppression log a prefetch returned, narrowed. Keyed exactly as the read keyed them. */
export function asSuppressionLogs(
  read: ReadonlyMap<string, SuppressionLogRead>,
): ReadonlyMap<string, SuppressionLog> {
  return new Map([...read].map(([key, log]) => [key, asSuppressionLog(log)]))
}
