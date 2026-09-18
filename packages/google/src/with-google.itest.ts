import { generateKek } from '@berelax/clinical'
import { fixedClock, instantFromIso } from '@berelax/core'
import { createConnection, createJobQueue, type Sql } from '@berelax/db'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import { createFakeBusinessProfile, createFakeGoogleOAuth } from '@berelax/providers/google'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPostgresConnectionStore } from './postgres-store.ts'
import { createPostgresRefreshLock } from './token-refresh.ts'
import { connectionBinding, sealToken } from './token-store.ts'
import { type WithGoogleDeps, withGoogle } from './with-google.ts'

/**
 * G-CONN-03 — the claim that cannot be made without a real database and a real queue.
 *
 * docs/10 §4: **a pg-boss job failure is not sufficient evidence of failure, because nobody reads
 * `pgboss.job`.** Every Google failure affecting a capability must also write a row the owner's dashboard
 * renders. Proving that needs both ledgers present at once, so the interesting half of this file is the
 * control: a failure recorded *only* in `pgboss.job` must leave the dashboard count unchanged. Without it
 * the assertion degenerates into "a count went up", which a job row would satisfy.
 *
 * Which ledger, and why not a third one. `google_connection_events` already exists (migration 0016): it is
 * append-only, it is mirrored into `audit_event` by a trigger in the same transaction, it refuses a payload
 * carrying a token by CHECK constraint, and it is what the connection panel renders. `agent_alert` from
 * G-AGT-01 is the other candidate and is the wrong shape — it is keyed on `agent_key` and answers *"which
 * agent has gone silent"*, not *"which capability of which connection failed"*. So: no new table, no
 * migration, and SCHEMA_VERSION untouched.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const KEK = generateKek('v1')
const NOW_ISO = '2026-09-18T10:00:00.000Z'
const SUB = 'sub-with-google-0001'
const REFRESH_TOKEN = '1//09-itest-refresh-token-never-in-a-row'
const RESOURCE = { account: 'accounts/1', location: 'locations/2', placeId: 'ChIJ-itest' }

/** A queue used only by this file, so nothing here depends on the shipped registry's contents. */
const QUEUE = 'gconn03-review-poll'

let sql: Sql
let boss: PgBoss
let store: ReturnType<typeof createPostgresConnectionStore>

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  store = createPostgresConnectionStore(sql)
  // pg-boss owns and migrates its own schema, so this is also what guarantees `pgboss.job` exists for the
  // control below rather than the control quietly skipping on a fresh database.
  boss = createJobQueue({ connectionString: url, max: 2 })
  await boss.start()
  await boss.createQueue(QUEUE)
}, 120_000)

afterAll(async () => {
  // `stop()` resolves before the drain finishes, so the `stopped` event is what says the workers are done.
  if (boss !== undefined) {
    const stopped = new Promise<void>((resolve) => {
      boss.once('stopped', () => resolve())
    })
    await boss.stop({ graceful: true, timeout: 5_000, close: true })
    await Promise.race([
      stopped,
      new Promise<void>((resolve) => setTimeout(resolve, 7_000).unref()),
    ])
  }
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  /**
   * Nothing else in the database may serve this capability while this file runs.
   *
   * `withGoogle` takes a capability, not a connection id: `resolveTarget` scans every connection that is
   * not `disconnected`, keeps those serving the capability, ranks them and orders by id. That is
   * production behaviour — it is why a consumer never has to know which Google account is wired up — and
   * it means this file cannot assume it is alone. `google-oauth.itest.ts` sorts before this file in the
   * sequential suite and finishes consent for real, and `completeGoogleConsent` registers `gbp_reviews`
   * with `resourceRef: null` because picking the location is a separate step (G-CONN-05). Its last test
   * leaves that connection behind with a lower UUIDv7 id, so it sorts first, ties on rank and wins. Every
   * test below then degrades with `ResourceNotSelected` against a connection it never created, and the
   * failure reads like a broken access rule rather than a leaked row. Removing the update below is the
   * known-bad control: three of these tests fail immediately.
   *
   * Disconnecting rather than deleting: `google_reviews.connection_id` is `ON DELETE RESTRICT`, so a
   * `delete from google_connections` would fail the moment a review-queue suite left a review behind —
   * which is a different false failure, not a fix. Setting the status is also the same skip the connection
   * panel relies on, so the isolation runs through a path production actually takes.
   */
  await sql`update google_connections set status = 'disconnected' where google_sub <> ${SUB}`
  await sql`delete from google_connections where google_sub = ${SUB}`
  await sql`delete from pgboss.job where name = ${QUEUE}`
})

async function seed(): Promise<string> {
  const id = await store.allocateId()
  await store.insert({
    id,
    googleSub: SUB,
    googleEmail: 'google-admin@berelax.ae',
    grantedScopes: ['https://www.googleapis.com/auth/business.manage'],
    refreshToken: sealToken(
      KEK,
      connectionBinding({ connectionId: id, googleSub: SUB }),
      REFRESH_TOKEN,
    ),
    consentAt: instantFromIso('2026-09-17T10:00:00.000Z'),
  })
  await store.upsertCapability({
    connectionId: id,
    capability: 'gbp_reviews',
    resourceRef: RESOURCE,
    health: 'unknown',
    isPrimary: true,
  })
  return id
}

/**
 * The rows the owner's dashboard can actually see.
 *
 * Deliberately two counts rather than one. The connection panel reads `google_connection_events`; an
 * investigation across the whole system reads `audit_event`. The mirror is written by a trigger, so a
 * failure that reached one and not the other would mean the trigger stopped firing.
 */
async function dashboardRows(connectionId: string): Promise<{ events: number; audit: number }> {
  const [events] = await sql<{ n: string }[]>`
    select count(*)::text as n from google_connection_events
    where connection_id = ${connectionId} and event = 'health_check_failed'
  `
  const [audit] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event
    where entity_type = 'google_connection' and entity_id = ${connectionId}
      and action = 'google_connection.health_check_failed'
  `
  return { events: Number(events?.n ?? '0'), audit: Number(audit?.n ?? '0') }
}

function deps(failures: { oauth: FailureScript; api: FailureScript }): WithGoogleDeps {
  return {
    store,
    // The real advisory-transaction lock (G-CONN-04). Every call below refreshes once, so this file also
    // exercises the locked path; the concurrency claim itself is token-refresh.itest.ts's.
    lock: createPostgresRefreshLock(sql),
    oauth: createFakeGoogleOAuth({
      log: createCallLog(() => NOW_ISO),
      failures: failures.oauth,
      now: () => NOW_ISO,
      sub: SUB,
    }),
    kek: KEK,
    clock: fixedClock(NOW_ISO),
    logger: { log: () => {} },
    newCorrelationId: () => 'corr-itest-0001',
  }
}

describe('acceptance — a failure reaches a ledger the owner reads', () => {
  it('increments the dashboard-visible row count, and the mirrored audit row with it', async () => {
    const connectionId = await seed()
    const api = new FailureScript().failAlways('access_not_granted')
    const profile = createFakeBusinessProfile({
      log: createCallLog(() => NOW_ISO),
      failures: api,
      now: () => NOW_ISO,
    })

    // A DELTA, never a total: audit_event is append-only and shared with every other test in this suite.
    const before = await dashboardRows(connectionId)
    const outcome = await withGoogle(
      deps({ oauth: new FailureScript(), api }),
      'gbp_reviews',
      async () => profile.listReviews(RESOURCE.location),
    )
    expect(outcome.kind).toBe('degraded')

    const after = await dashboardRows(connectionId)
    expect(after.events).toBe(before.events + 1)
    expect(after.audit).toBe(before.audit + 1)

    const [row] = await sql<{ detail: Record<string, unknown> }[]>`
      select detail from google_connection_events
      where connection_id = ${connectionId} and event = 'health_check_failed'
      order by id desc limit 1
    `
    expect(row?.detail).toMatchObject({
      capability: 'gbp_reviews',
      consumer: 'reviewAutoresponder',
      errorClass: 'AccessNotGranted',
      degradedTo: 'draft_only',
      correlationId: 'corr-itest-0001',
      // Through jsonb and back: the fingerprint is what tells an operator WHAT failed, where the class
      // only tells them what to do about it.
      upstreamKind: 'AppError',
      failureMode: 'access_not_granted',
    })
    // The fifth of the six places docs/10 §4 forbids: a row. Rows reach query logs,
    // pg_stat_statements, backups and pg-boss payloads.
    expect(JSON.stringify(row?.detail)).not.toContain(REFRESH_TOKEN)

    // And the capability's own health moved, which is what turns the event into a badge on the panel.
    const [capability] = await store.capabilitiesFor(connectionId)
    expect(capability?.health).toBe('quota_zero')
  })

  it('deliberately fails if only pgboss.job recorded the failure', async () => {
    const connectionId = await seed()

    // The same failure, recorded the way a job records one and no other way: the handler threw, pg-boss
    // marked the job failed and wrote the message into `pgboss.job.output`. This is the state docs/10 §4
    // calls insufficient evidence, and this is the control that proves the assertion above is about the
    // dashboard rather than about any count going up.
    const before = await dashboardRows(connectionId)
    // retryLimit 0 per send, not per queue: `createQueue` does not change the options of a queue that
    // already exists, so a queue-level setting would silently be whatever the first run of this file
    // created — and the job would park in `retry` rather than `failed`. With a retry allowed the control
    // would be asserting on pg-boss's backoff instead of on where the failure was recorded.
    const jobId = await boss.send(
      QUEUE,
      { connectionId, capability: 'gbp_reviews' },
      { retryLimit: 0 },
    )
    if (jobId === null) throw new Error('the probe job was not enqueued')
    const fetched = await boss.fetch<{ connectionId: string }>(QUEUE)
    const received = fetched?.[0]
    if (received === undefined) throw new Error('the probe job was not fetchable')
    await boss.fail(QUEUE, received.id, {
      message: 'gbp_reviews failed: access_not_granted',
    })

    // The failure IS recorded — in the one place nobody reads. Asserted, so the control cannot pass by
    // having failed to record anything at all.
    const [job] = await sql<{ state: string; output: unknown }[]>`
      select state::text, output from pgboss.job where id = ${received.id}::uuid
    `
    expect(job?.state).toBe('failed')
    expect(JSON.stringify(job?.output)).toContain('access_not_granted')

    // And the dashboard saw nothing.
    expect(await dashboardRows(connectionId)).toEqual(before)
  })

  it('records a failure that does NOT degrade too, because the dashboard still has to show it', async () => {
    const connectionId = await seed()
    const api = new FailureScript().failAlways('rate_limited')
    const profile = createFakeBusinessProfile({
      log: createCallLog(() => NOW_ISO),
      failures: api,
      now: () => NOW_ISO,
    })

    const before = await dashboardRows(connectionId)
    await expect(
      withGoogle(deps({ oauth: new FailureScript(), api }), 'gbp_reviews', async () =>
        profile.listReviews(RESOURCE.location),
      ),
    ).rejects.toThrow()
    const after = await dashboardRows(connectionId)
    expect(after.events).toBe(before.events + 1)
  })

  it('writes nothing to the ledger when the call succeeds', async () => {
    // The control for all three above: a ledger that recorded every call would make "the count went up"
    // true whatever happened, and the dashboard would show a failure for every successful poll.
    const connectionId = await seed()
    const api = new FailureScript()
    const profile = createFakeBusinessProfile({
      log: createCallLog(() => NOW_ISO),
      failures: api,
      now: () => NOW_ISO,
    })

    const before = await dashboardRows(connectionId)
    const outcome = await withGoogle(
      deps({ oauth: new FailureScript(), api }),
      'gbp_reviews',
      async () => profile.listReviews(RESOURCE.location),
    )
    expect(outcome.kind).toBe('ok')
    expect(await dashboardRows(connectionId)).toEqual(before)
  })
})
