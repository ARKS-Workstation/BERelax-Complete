/**
 * The CDN purge fake.
 *
 * It models the two things about a CDN purge that change how the pipeline must be written:
 *
 * **Acceptance is not completion.** `purge` answers `accepted`, never `purged`, so nothing downstream can
 * assert that a stale page has stopped being served — because no CDN promises that at the moment of the
 * call.
 *
 * **Idempotency is over the path SET**, so a retried publish purges once and the outbox count is a
 * measurement rather than a tally of attempts.
 *
 * It also refuses a path that is not a path. A full URL in a purge request is the mistake that silently
 * purges nothing on most CDNs — the request is accepted and matches no cached object — so it is a
 * rejection here, where it is visible in the outbox.
 */
import { createHash } from 'node:crypto'
import type { PurgeOutboxEntry, PurgeOutcome, PurgePort, PurgeRequest } from './port.ts'

export const FAKE_PURGE = 'fake-cdn-purge'

export interface FakePurgeOptions {
  /** The clock, injected: a fake that read `Date.now()` could not be asserted byte-for-byte. */
  readonly now: () => string
}

export function createFakePurge(options: FakePurgeOptions): PurgePort {
  const entries: PurgeOutboxEntry[] = []
  const seen = new Map<string, PurgeOutcome>()

  const record = (
    request: Pick<PurgeRequest, 'idempotencyKey' | 'paths' | 'reason'>,
    outcome: PurgeOutcome,
  ): PurgeOutcome => {
    entries.push({
      idempotencyKey: request.idempotencyKey,
      paths: [...request.paths],
      reason: request.reason,
      outcome,
      requestedAtIso: options.now(),
    })
    return outcome
  }

  return {
    name: FAKE_PURGE,

    async purge(request: PurgeRequest): Promise<PurgeOutcome> {
      const already = seen.get(request.idempotencyKey)
      if (already !== undefined) {
        return await Promise.resolve(
          record(request, {
            kind: 'accepted',
            pathCount: request.paths.length,
            deduplicated: true,
          }),
        )
      }
      const notPaths = request.paths.filter((path) => !path.startsWith('/'))
      if (notPaths.length > 0 || request.paths.length === 0) {
        const outcome: PurgeOutcome = {
          kind: 'rejected',
          detail:
            request.paths.length === 0
              ? 'a purge with no paths would be accepted and purge nothing'
              : `not paths on this site: ${notPaths.slice(0, 3).join(', ')}`,
        }
        seen.set(request.idempotencyKey, outcome)
        return await Promise.resolve(record(request, outcome))
      }
      const outcome: PurgeOutcome = {
        kind: 'accepted',
        pathCount: request.paths.length,
        deduplicated: false,
      }
      seen.set(request.idempotencyKey, outcome)
      return await Promise.resolve(record(request, outcome))
    },

    async purgeAll(reason: string): Promise<PurgeOutcome> {
      // Recorded with the sentinel path `/*`, so the outbox can be read as one sequence: a reader looking
      // for "what was purged on Friday" must not have to join two lists.
      return await Promise.resolve(
        record(
          { idempotencyKey: `all:${options.now()}`, paths: ['/*'], reason },
          { kind: 'accepted', pathCount: 1, deduplicated: false },
        ),
      )
    },

    async outbox(): Promise<readonly PurgeOutboxEntry[]> {
      return await Promise.resolve([...entries])
    },
  }
}

/** The idempotency key for one purge: a hash of the sorted, deduplicated path set. See IndexNow's. */
export function purgeIdempotencyKey(paths: readonly string[]): string {
  return createHash('sha256')
    .update([...new Set(paths)].sort().join('\n'))
    .digest('hex')
    .slice(0, 32)
}
