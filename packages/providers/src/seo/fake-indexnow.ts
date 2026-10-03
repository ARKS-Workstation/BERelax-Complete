/**
 * The IndexNow fake.
 *
 * It models the three things about IndexNow that change how the system must be written, and ignores
 * everything else:
 *
 * **The key is required and is refused when it is a marker.** `Y1-indexnow-key` is open, so the setting's
 * stored value is a placeholder `is_placeholder_text()` refuses, and `createFakeIndexNow` **throws** when
 * it is handed one. That is the whole point of the fake existing before the key does: the publish
 * pipeline is wired, the ping is attempted, and the attempt fails with a named reason rather than being
 * skipped by a branch somebody has to remember to remove.
 *
 * **Idempotency is over the URL SET.** The same key returns `deduplicated: true` and sends nothing. A
 * different set with overlapping URLs is a new submission, because that is what a second publish is.
 *
 * **A rejection is a value.** A host mismatch answers `url_not_on_host`, and a scripted failure answers
 * whatever it was armed with — so the `last_error` path on the agent row is exercised from a fixture
 * rather than only from a mocked throw.
 *
 * Every call is written to the outbox, including a deduplicated one and a rejected one. An outbox that
 * recorded only successes could not answer the question it exists for: *did we ping, and what happened?*
 */
import { createHash } from 'node:crypto'
import type { CallLog } from '../call-log.ts'
import { type FailureScript, failureError } from '../failure.ts'
import {
  INDEXNOW_MAX_URLS,
  type IndexNowOutboxEntry,
  type IndexNowOutcome,
  type IndexNowProvider,
  type IndexNowSubmission,
} from './port.ts'

export const FAKE_INDEXNOW = 'fake-indexnow'

/** The marker the setting holds while `Y1-indexnow-key` is open. Refused rather than used. */
export const INDEXNOW_KEY_UNSET = 'INDEXNOW-KEY-PENDING-Y1-INDEXNOW-KEY'

export interface FakeIndexNowOptions {
  readonly log: CallLog
  readonly failures: FailureScript
  readonly now: () => string
  /**
   * The published key.
   *
   * No default, and a blank or marker value throws from the constructor. A default would be a key that
   * verifies against nothing, and the pipeline would then report successful pings for ever — which is the
   * "never silently succeeds" half of the acceptance criterion, enforced at the one moment it can be.
   */
  readonly key: string
}

/**
 * Whether a value is a key or a stand-in for one.
 *
 * The same shape `is_placeholder_text()` (migration 0026) refuses, in TypeScript, because this check runs
 * before any database is reachable. Exported so the settings layer and the adapter cannot disagree about
 * what "unset" means.
 */
export function indexNowKeyIsUnset(key: string): boolean {
  const trimmed = key.trim().toLowerCase()
  if (trimmed === '') return true
  return ['pending', 'placeholder', 'tbc', 'tbd', 'to be confirmed', 'not configured', 'todo'].some(
    (marker) => trimmed.includes(marker),
  )
}

export function createFakeIndexNow(options: FakeIndexNowOptions): IndexNowProvider {
  const { log, failures, now, key } = options
  if (indexNowKeyIsUnset(key)) {
    throw new Error(
      `IndexNow has no key: the configured value is ${JSON.stringify(key)}, which is a marker rather ` +
        'than a key (Y1-indexnow-key). A key is published by this site at https://<host>/<key>.txt and ' +
        'is verified against that file, so there is nothing to fall back to — the ping is refused here ' +
        'rather than reported as sent.',
    )
  }
  const entries: IndexNowOutboxEntry[] = []
  const byIdempotencyKey = new Map<string, IndexNowOutcome>()

  const record = (submission: IndexNowSubmission, outcome: IndexNowOutcome): IndexNowOutcome => {
    entries.push({
      idempotencyKey: submission.idempotencyKey,
      host: submission.host,
      urls: [...submission.urls],
      outcome,
      submittedAtIso: now(),
    })
    return outcome
  }

  return {
    name: FAKE_INDEXNOW,

    async submit(submission: IndexNowSubmission): Promise<IndexNowOutcome> {
      const armed = failures.take()
      if (armed !== undefined) {
        log.record({
          provider: FAKE_INDEXNOW,
          operation: 'submit',
          outcome: 'failure',
          summary: `Submission of ${submission.urls.length} URL(s) failed: ${armed}`,
          detail: { host: submission.host, urlCount: submission.urls.length, failureMode: armed },
        })
        // Recorded in the outbox BEFORE the throw. A failure that left no entry would make "we never
        // pinged" and "we pinged and it blew up" indistinguishable, which is the question the outbox is
        // for.
        record(submission, { kind: 'rejected', reason: 'unknown', detail: String(armed) })
        throw failureError(FAKE_INDEXNOW, armed)
      }

      const seen = byIdempotencyKey.get(submission.idempotencyKey)
      if (seen !== undefined) {
        log.record({
          provider: FAKE_INDEXNOW,
          operation: 'submit',
          outcome: 'success',
          summary: `Submission ${submission.idempotencyKey} already sent; nothing re-submitted`,
          detail: { idempotencyKey: submission.idempotencyKey, deduplicated: true },
        })
        return record(submission, {
          kind: 'accepted',
          urlCount: submission.urls.length,
          deduplicated: true,
        })
      }

      const offHost = submission.urls.filter((url) => {
        try {
          return new URL(url).host !== submission.host
        } catch {
          return true
        }
      })
      if (offHost.length > 0) {
        const outcome: IndexNowOutcome = {
          kind: 'rejected',
          reason: 'url_not_on_host',
          detail: `${offHost.length} URL(s) are not on ${submission.host}: ${offHost.slice(0, 3).join(', ')}`,
        }
        log.record({
          provider: FAKE_INDEXNOW,
          operation: 'submit',
          outcome: 'failure',
          summary: outcome.detail,
          detail: { host: submission.host, reason: outcome.reason },
        })
        byIdempotencyKey.set(submission.idempotencyKey, outcome)
        return record(submission, outcome)
      }

      if (submission.urls.length > INDEXNOW_MAX_URLS) {
        const outcome: IndexNowOutcome = {
          kind: 'rejected',
          reason: 'rate_limited',
          detail: `${submission.urls.length} URLs exceeds the protocol cap of ${INDEXNOW_MAX_URLS}`,
        }
        byIdempotencyKey.set(submission.idempotencyKey, outcome)
        return record(submission, outcome)
      }

      const outcome: IndexNowOutcome = {
        kind: 'accepted',
        urlCount: submission.urls.length,
        deduplicated: false,
      }
      byIdempotencyKey.set(submission.idempotencyKey, outcome)
      log.record({
        provider: FAKE_INDEXNOW,
        operation: 'submit',
        outcome: 'success',
        summary: `Submitted ${submission.urls.length} URL(s) for ${submission.host}`,
        detail: { host: submission.host, urlCount: submission.urls.length },
      })
      return record(submission, outcome)
    },

    async outbox(): Promise<readonly IndexNowOutboxEntry[]> {
      return await Promise.resolve([...entries])
    },
  }
}

/**
 * The idempotency key for one changed URL set.
 *
 * A hash of the SORTED, deduplicated set, so two publishes that changed the same pages produce one key
 * and a publish that changed a different set produces another — which is exactly the acceptance
 * criterion's "one ping per changed URL set". Sorting is what makes it independent of the order the
 * propagation job happened to collect the paths in; without it a retry whose paths came back in a
 * different order would be a second ping that looked legitimate.
 */
export function indexNowIdempotencyKey(urls: readonly string[]): string {
  const canonical = [...new Set(urls)].sort().join('\n')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}
