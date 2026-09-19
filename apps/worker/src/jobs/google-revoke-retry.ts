import { type Kek, parseKek } from '@berelax/clinical'
import { type Config, isProduction, loadConfig } from '@berelax/config'
import type { Clock, Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import {
  createPostgresConnectionStore,
  type DisconnectActor,
  type DisconnectDeps,
  type RevokeRetryReport,
  retryPendingRevocations,
} from '@berelax/google'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import { createFakeGoogleOAuth, type GoogleOAuthProvider } from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/**
 * G-CONN-09 — finishes a disconnect whose revocation Google never confirmed.
 *
 * ## What this exists to prevent
 *
 * docs/10 §5 requires an offboarding to revoke the grant at Google, not merely to forget our copy of it.
 * Revoke first, zeroise second — and when the revocation comes back as a 500 or a timeout, the disconnect
 * is only half done: the row is marked `disconnected` so no consumer resolves it, but the grant may still
 * be live at Google, holding `business.manage` on the business's listing. That scope has no read-only
 * variant, so a live grant in the hands of somebody who has left can rewrite the address and the opening
 * hours (docs/10 §3). Somebody has to go back and finish the job, and *"somebody"* is this.
 *
 * ## Why it is a sweep over rows and not a retry of one job
 *
 * Because the row is the work item and the queue is only the alarm clock. A connection carrying
 * `status_reason = 'revoke_failed'` **and** a retained ciphertext is a coherent pair guaranteed by
 * migration 0040's `google_connections_revoke_retry_keeps_its_token`, so `pendingRevocations()` cannot
 * return work it has no credential for. Every way a queue loses work — a failed enqueue, exhausted
 * retries, a worker that died mid-attempt, a dead-letter row nobody reads — then costs time rather than
 * losing a live Google grant. A pass that finds nothing is the healthy case, which is exactly what a job
 * keyed on a payload cannot be.
 *
 * ## Why there is no cron
 *
 * An unconfirmed revocation is **announced**: the disconnect that could not finish enqueues this, with the
 * connection id as its singleton key. `assertRegistry` demands an `agent_definition` for any job with a
 * cron, precisely because a schedule nobody watches is the failure G-AGT-01 exists to remove — and the
 * thing being watched here is the disconnect that announced it, plus the row itself, which the connection
 * panel renders. A nightly sweep over a table that is almost always empty would be a poller looking for
 * work an enqueue already announced, which is the same argument `media.build-derivatives` and
 * `messaging.reconcile-dlr` make.
 *
 * What that costs, stated plainly rather than left implicit: if the enqueue itself fails **and** no later
 * disconnect runs, nothing re-attempts the revocation on its own. The runbook's step 1 names the manual
 * revocation at `myaccount.google.com/permissions` as the operator's backstop for exactly that case, and
 * the row's `revoke_failed` reason is what tells them it applies.
 */

/** The queue name. `google-connection.` namespaces it to the subsystem, as `assertRegistry` requires. */
export const GOOGLE_REVOKE_RETRY_QUEUE = 'google-connection.revoke-retry'

/**
 * The payload: a connection id and nothing else.
 *
 * docs/10 §4 names a pg-boss job payload as one of the six places a token must never appear — a job is a
 * row, and rows reach query logs, `pg_stat_statements`, backups and the job table's own retention window.
 * The id is here so an operator reading `pgboss.job` can see *which* disconnect asked, and so the
 * singleton key has something stable to be; the handler sweeps every pending row regardless.
 */
export interface GoogleRevokeRetryData {
  readonly connectionId: string
}

/** The actor on the events this pass appends. A role, never an invented person (the brief's rule 10). */
export const REVOKE_RETRY_ACTOR: DisconnectActor = {
  kind: 'system',
  label: GOOGLE_REVOKE_RETRY_QUEUE,
}

const systemClock: Clock = { now: () => Date.now() as Instant }

/**
 * Builds the `enqueueRevokeRetry` callback a disconnect hands to `disconnectGoogleConnection`.
 *
 * Takes a bare send function rather than `TransactionalEnqueue`, and that is structural rather than
 * fussy: `enqueue.ts` imports `JobDefinition` from `registry.ts`, and `registry.ts` imports this module,
 * so importing the enqueue helper here would be a cycle — which `pnpm boundaries` reports as an error
 * because a cycle makes build order and reasoning undecidable.
 *
 * The singleton key is the connection id, so an operator clicking Disconnect three times against a Google
 * outage queues one retry rather than three that each revoke the same token.
 */
export function announceRevokeRetry(
  send: (
    queue: string,
    data: GoogleRevokeRetryData,
    options: { readonly singletonKey: string },
  ) => Promise<unknown>,
): (connectionId: string) => Promise<void> {
  return async (connectionId) => {
    await send(GOOGLE_REVOKE_RETRY_QUEUE, { connectionId }, { singletonKey: connectionId })
  }
}

/**
 * The OAuth adapter for a configured mode.
 *
 * `real` throws rather than falling back, and the reason is sharper here than anywhere else this pattern
 * appears. A health check against a stand-in reports every connection healthy, which is bad; a
 * **revocation** against a stand-in reports a grant killed that is still live at Google, and then the
 * disconnect zeroises the only credential that could have killed it. That is the unrecoverable
 * half-failure, reached by a configuration mistake rather than by a network error.
 *
 * It is the second of two layers, not the only one. `parseConfig` refuses `GOOGLE_PROVIDER=real` outside
 * `APP_ENV=production` at boot, so a staging deploy cannot reach real Google at all — and this refusal
 * means that even in production nothing revokes anything until a real adapter genuinely exists.
 * `google-revoke-retry.test.ts` drives both, including the case where the two layers would disagree.
 */
export function revokeOAuthFor(config: Config): GoogleOAuthProvider {
  if (config.GOOGLE_PROVIDER === 'real') {
    throw new AppError(
      'provider_unavailable',
      'The real Google OAuth adapter is not implemented, so a revocation would be sent to a stand-in ' +
        'and reported as success — and a disconnect that believes a revocation succeeded erases the ' +
        'only credential that could have performed it. Nothing was revoked. Set GOOGLE_PROVIDER=fake ' +
        'until the real adapter exists.',
      {
        details: {
          reason: 'google_revoke_provider_unavailable',
          appEnv: config.APP_ENV,
          production: isProduction(config.APP_ENV),
        },
      },
    )
  }
  return createFakeGoogleOAuth({
    log: createCallLog(() => new Date().toISOString()),
    failures: new FailureScript(),
    now: () => new Date().toISOString(),
  })
}

/**
 * The key the stored refresh token is sealed with, read from the environment.
 *
 * The same deferral the consent route, the picker route and the health check record: nothing in this
 * system loads an app-wide KEK at runtime yet, and naming it belongs with the secret inventory in
 * H-HARD-03. Refusing loudly is the only safe alternative to inventing one per process — a retry with the
 * wrong key would fail to open the token and report the revocation as impossible for ever, on a grant
 * that is live.
 */
function googleTokenKek(): Kek {
  const material = process.env['GOOGLE_TOKEN_KEK']
  const version = process.env['GOOGLE_TOKEN_KEK_VERSION'] ?? 'v1'
  if (!material) {
    throw new AppError(
      'provider_unavailable',
      'GOOGLE_TOKEN_KEK is not set, so no stored Google token can be opened and no pending revocation ' +
        'can be completed. Nothing was revoked.',
    )
  }
  return parseKek(material, version)
}

/**
 * Everything the sweep needs.
 *
 * Deliberately **without** `enqueueRevokeRetry`. The sweep is itself the retry, and a retry that enqueued
 * another retry per still-failing row would fan out one job into one per pass per connection. The next
 * announcement, or an operator, is what brings the sweep back.
 */
export function revokeRetryDeps(sql: Sql, config: Config): DisconnectDeps {
  return {
    store: createPostgresConnectionStore(sql),
    oauth: revokeOAuthFor(config),
    kek: googleTokenKek(),
    clock: systemClock,
  }
}

/** Runs one sweep. Separate from the handler so a test can drive it with no pg-boss and no environment. */
export async function runRevokeRetry(deps: DisconnectDeps): Promise<RevokeRetryReport> {
  return retryPendingRevocations(deps, REVOKE_RETRY_ACTOR)
}

async function handler(data: GoogleRevokeRetryData, _context: JobContext): Promise<void> {
  // Read per run rather than captured at import, for the reason `registry.ts` gives about the Google
  // handlers: `GOOGLE_PROVIDER` decides whether this pass talks to a stand-in, and a value captured at
  // boot would survive a restart-free configuration change while the log line went on claiming a real
  // revocation.
  const config = loadConfig()
  // Its own pool rather than the maintenance connection the other handlers share: the sweep opens a
  // transaction per connection it finishes, and sharing a four-connection pool with the audit partition
  // job is how one slow revocation becomes `53300 too_many_connections` for something unrelated.
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    const report = await runRevokeRetry(revokeRetryDeps(sql, config))
    // Counts every time, including all zeros. Zero pending is the evidence rather than the silence: the
    // alternative is a log that says nothing when the work is done and nothing when the job never ran.
    console.log(
      `${GOOGLE_REVOKE_RETRY_QUEUE} announced by ${data.connectionId}: ${report.attempted} pending, ` +
        `${report.revoked} revoked and zeroised, ${report.stillUnconfirmed} still unconfirmed`,
    )
    if (report.stillUnconfirmed > 0) {
      // Thrown so the queue retries with backoff. The rows are already correct and already visible — this
      // throw is purely the queue being asked to come back, which is the same shape
      // `runGoogleHealthCheck` uses for `retryWorthwhile`.
      throw new AppError(
        'provider_unavailable',
        `${report.stillUnconfirmed} Google grant(s) are still not confirmed revoked: ` +
          `${report.unconfirmed.join(', ')}. Each one keeps its stored ciphertext so this can be tried ` +
          'again; docs/runbooks/google-offboarding.md step 1 names the manual revocation if it persists.',
        { details: { reason: 'google_revoke_still_unconfirmed', connections: report.unconfirmed } },
      )
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export const GOOGLE_REVOKE_RETRY_JOB: JobDefinition<GoogleRevokeRetryData> = {
  name: GOOGLE_REVOKE_RETRY_QUEUE,
  purpose:
    'Completes any disconnect whose revocation Google did not confirm, by re-calling the revocation ' +
    'endpoint and zeroising the stored ciphertext only once it succeeds. Announced by the disconnect ' +
    'that could not finish, so it has no schedule. Until it succeeds the grant may still be live at ' +
    'Google with business.manage on the listing (G-CONN-09, docs/10 §5).',
  // Twelve attempts with exponential backoff from 60s reaches roughly a day, which is the right order for
  // a Google outage: a live grant held by somebody who has left is not a thing to stop chasing after
  // three tries, and the pass is idempotent — a second revocation of the same token answers
  // `already_revoked`, which is a success.
  retryLimit: 12,
  retryDelaySeconds: 60,
  retryBackoff: true,
  // One HTTPS call and one small transaction per pending row, of which there is normally zero or one. Two
  // minutes is generous; a pass still running past it is blocked rather than slow, and reclaiming it is
  // safe because the row, not the job, is the work item.
  expireInSeconds: 120,
  handler,
}
