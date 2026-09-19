import { generateKek } from '@berelax/clinical'
import { fixedClock, instantFromIso } from '@berelax/core'
import { createConnection, createJobQueue, type Sql } from '@berelax/db'
import { type CallLog, createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  AL_ZAHIYAH_LOCATION,
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  GBP_LOCATION_GROUP_ACCOUNT,
  type GoogleOAuthProvider,
} from '@berelax/providers/google'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { LOCATION_READ_MASK, readLocationSnapshot } from './adapters/business-information.ts'
import {
  type DisconnectActor,
  type DisconnectDeps,
  disconnectGoogleConnection,
  retryPendingRevocations,
} from './disconnect.ts'
import { createPostgresConnectionStore } from './postgres-store.ts'
import { connectionBinding, sealToken } from './token-store.ts'

/**
 * G-CONN-09 — the claims about disconnect that are only true against a real PostgreSQL.
 *
 * Four of them, and none can be checked against a double:
 *
 *   1. **The credential is gone from the stored bytes.** That is a statement about `bytea` read back
 *      through the driver, in every encoding a token could hide in, across *every* row — and it is
 *      asserted **keylessly**, by scanning for the plaintext rather than by decrypting. Decryption would
 *      only prove the ciphertext no longer opens; a keyless scan also catches a token that was written
 *      unencrypted, which is the mistake a decrypting test cannot see. (It also has to be keyless for a
 *      mundane reason: `generateKek('v1')` is `randomBytes`, so the key differs per integration file and a
 *      row seeded elsewhere could not be opened here at all.)
 *   2. **A partial wipe is refused.** Three named CHECK constraints, each asserted by name and each
 *      paired with the write it is supposed to permit.
 *   3. **The erasure and the events that record it commit together, and a later failure cannot roll them
 *      back.** That is a statement about a transaction. G-CONN-06 found this exact defect next door:
 *      `accessTokenUnderLock` let a refresh failure propagate out of `sql.begin`, and the rollback
 *      destroyed the rows recording a dead grant. Here the rows are worse than evidence — the credential
 *      is gone, so they are the only record it ever existed.
 *   4. **A connection with reviews is disconnected, never deleted.** `google_reviews.connection_id` is
 *      ON DELETE RESTRICT, and the decision to keep the reviews is what makes that constraint never fire.
 *
 * **Isolation.** This file seeds `google_reviews`, so it deletes them in `beforeEach` *and* `afterAll` —
 * reviews before connections, because the foreign key is RESTRICT and a review left behind would fail the
 * next file's connection cleanup on a constraint unrelated to whatever it is testing (the same note
 * `review-queue.itest.ts` carries, and the same order).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const KEK = generateKek('v1')
const NOW_ISO = '2026-09-19T09:00:00.000Z'
const CONSENT_AT = instantFromIso('2026-09-12T09:00:00.000Z')

/** The departing account, and the incoming business account docs/10 §5 recommends. */
const DEPARTING = { sub: 'sub-gconn09-departing-agency', email: 'agency@example.com' }
const INCOMING = { sub: 'sub-gconn09-business-account', email: 'google-admin@berelax.ae' }

/** Long enough that a partial leak would still be visible, and shaped like Google's. */
const DEPARTING_TOKEN = '1//09-gconn09-departing-agency-refresh-token'
const PLACE_ID = AL_ZAHIYAH_LOCATION.metadata.placeId

const ACTOR: DisconnectActor = { kind: 'staff', label: 'owner@berelax.ae' }
const SWEEP_ACTOR: DisconnectActor = { kind: 'system', label: 'google-connection.revoke-retry' }

/** A queue of this file's own. The production name is `apps/worker`'s, and this package cannot see it. */
const QUEUE = 'gconn09-revoke-retry-probe'

let sql: Sql
let store: ReturnType<typeof createPostgresConnectionStore>
let boss: PgBoss
let log: CallLog
let failures: FailureScript

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  store = createPostgresConnectionStore(sql)
  boss = createJobQueue({ connectionString: url, max: 2 })
  await boss.start()
  await boss.createQueue(QUEUE)
})

afterAll(async () => {
  if (boss !== undefined) {
    await new Promise<void>((resolve) => {
      boss.once('stopped', () => resolve())
      void boss.stop({ graceful: true, timeout: 5_000, close: true })
    })
  }
  // Reviews before connections: RESTRICT, so a review left behind fails the next file's cleanup.
  await sql`delete from google_reviews`
  await sql`delete from google_connections`
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql`delete from google_reviews`
  await sql`delete from google_connections`
  await sql`delete from pgboss.job where name = ${QUEUE}`
  log = createCallLog(() => NOW_ISO)
  failures = new FailureScript()
})

function oauthFor(account: { sub: string; email: string }): GoogleOAuthProvider {
  return createFakeGoogleOAuth({
    log,
    failures,
    now: () => NOW_ISO,
    sub: account.sub,
    email: account.email,
  })
}

/** Seeds a connection with a sealed token and a primary `gbp_reviews` resource. */
async function seedConnection(
  account: { sub: string; email: string },
  token: string,
  placeId: string,
): Promise<string> {
  // The id first: the AAD binds the ciphertext to its own row, so the row must have an identity before
  // its token can be sealed.
  const id = await store.allocateId()
  await store.insert({
    id,
    googleSub: account.sub,
    googleEmail: account.email,
    grantedScopes: ['https://www.googleapis.com/auth/business.manage'],
    refreshToken: sealToken(
      KEK,
      connectionBinding({ connectionId: id, googleSub: account.sub }),
      token,
    ),
    consentAt: CONSENT_AT,
  })
  await store.upsertCapability({
    connectionId: id,
    capability: 'gbp_reviews',
    resourceRef: {
      account: GBP_LOCATION_GROUP_ACCOUNT.name,
      location: AL_ZAHIYAH_LOCATION.name,
      placeId,
    },
    health: 'permission_missing',
    isPrimary: true,
  })
  return id
}

function depsFor(account: { sub: string; email: string }, enqueue = true): DisconnectDeps {
  return {
    store,
    oauth: oauthFor(account),
    kek: KEK,
    clock: fixedClock(NOW_ISO),
    ...(enqueue
      ? {
          enqueueRevokeRetry: async (connectionId: string) => {
            // The real callback is `announceRevokeRetry` in apps/worker; this is the same shape. A payload
            // of one id and nothing else — docs/10 §4 names a pg-boss payload as one of the six places a
            // token must never appear.
            await boss.send(QUEUE, { connectionId }, { singletonKey: connectionId })
          },
        }
      : {}),
  }
}

interface RawRow {
  readonly status: string
  readonly status_reason: string | null
  readonly refresh_token_ct: Buffer | null
  readonly refresh_token_nonce: Buffer | null
  readonly refresh_token_wrapped_key: Buffer | null
  readonly refresh_token_kid: string | null
  readonly refresh_token_aad_fp: string | null
  readonly access_token_ct: Buffer | null
  readonly access_expires_at: Date | null
}

async function rawRow(id: string): Promise<RawRow> {
  const [row] = await sql<RawRow[]>`
    select status, status_reason, refresh_token_ct, refresh_token_nonce, refresh_token_wrapped_key,
           refresh_token_kid, refresh_token_aad_fp, access_token_ct, access_expires_at
    from google_connections where id = ${id}
  `
  if (row === undefined) throw new Error(`no row ${id}`)
  return row
}

/**
 * Every token column of every row, as the four encodings a plaintext could hide in.
 *
 * **Keyless, and across every row** rather than the one under test. A scan of one row proves the disconnect
 * erased that row; a scan of the table also catches a token copied onto another connection, which is what
 * the AAD exists to make undecryptable and what nothing else here would notice.
 */
async function scanTokenColumns(): Promise<readonly string[]> {
  const rows = await sql<{ ct: Buffer | null; at: Buffer | null }[]>`
    select refresh_token_ct as ct, access_token_ct as at from google_connections
  `
  const blobs: string[] = []
  for (const row of rows) {
    const bytes = Buffer.concat([row.ct ?? Buffer.alloc(0), row.at ?? Buffer.alloc(0)])
    blobs.push(
      bytes.toString('utf8'),
      bytes.toString('latin1'),
      bytes.toString('hex'),
      bytes.toString('base64'),
    )
  }
  return blobs
}

/** True when `token` appears anywhere in the scanned bytes, in any of the four encodings. */
function scanFinds(blobs: readonly string[], token: string): boolean {
  const needles = [
    token,
    Buffer.from(token, 'utf8').toString('hex'),
    Buffer.from(token, 'utf8').toString('base64'),
  ]
  return blobs.some((blob) => needles.some((needle) => blob.includes(needle)))
}

describe('acceptance — a disconnect Google confirmed', () => {
  it('calls revoke once, NULLs both token column sets, and marks the row disconnected/manual', async () => {
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    const deps = depsFor(DEPARTING)

    // A cached access token first, so the erasure has something to erase. An hour of full authority over
    // the listing is not a thing to leave on a disconnected row.
    await sql`
      update google_connections set
        access_token_ct = ${Buffer.from('not-a-real-ciphertext')},
        access_token_nonce = ${Buffer.from('nonce')},
        access_token_wrapped_key = ${Buffer.from('wrapped')},
        access_token_kid = 'v1',
        access_token_aad_fp = 'fp',
        access_expires_at = ${new Date(NOW_ISO)}
      where id = ${id}
    `

    const outcome = await disconnectGoogleConnection(deps, { connectionId: id, actor: ACTOR })
    expect(outcome.kind).toBe('revoked')
    expect(log.all().filter((call) => call.operation === 'revoke')).toHaveLength(1)

    const row = await rawRow(id)
    expect(row.status).toBe('disconnected')
    expect(row.status_reason).toBe('manual')
    expect(row.refresh_token_ct).toBeNull()
    expect(row.access_token_ct).toBeNull()
    // All eleven, not merely the two the acceptance names: a kid left behind tells the re-wrap job there
    // is something to move and gives it nothing to move.
    expect(row.refresh_token_nonce).toBeNull()
    expect(row.refresh_token_wrapped_key).toBeNull()
    expect(row.refresh_token_kid).toBeNull()
    expect(row.refresh_token_aad_fp).toBeNull()
    expect(row.access_expires_at).toBeNull()
  })

  it('the keyless byte scan finds the token in no row and no encoding', async () => {
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    await disconnectGoogleConnection(depsFor(DEPARTING), { connectionId: id, actor: ACTOR })
    expect(scanFinds(await scanTokenColumns(), DEPARTING_TOKEN)).toBe(false)
  })

  it('the control: the same scan DOES find a token written unencrypted', async () => {
    // Without this the assertion above is satisfied by a scanner that looks at nothing — a renamed column,
    // an empty table, a needle built wrongly. This is also the leak the assertion is really about: a
    // decrypting test would report a plaintext token in `refresh_token_ct` as *"the ciphertext no longer
    // opens"* and pass.
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    await sql`
      update google_connections
      set refresh_token_ct = ${Buffer.from(DEPARTING_TOKEN, 'utf8')}
      where id = ${id}
    `
    expect(scanFinds(await scanTokenColumns(), DEPARTING_TOKEN)).toBe(true)
  })

  it('writes a google_connection_events row and an audit_event, both naming the actor', async () => {
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    const [before] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
      where entity_type = 'google_connection' and entity_id = ${id}
    `
    await disconnectGoogleConnection(depsFor(DEPARTING), { connectionId: id, actor: ACTOR })

    const events = await sql<
      { id: string; event: string; actor_kind: string; actor_label: string }[]
    >`
      select id::text, event, actor_kind, actor_label from google_connection_events
      where connection_id = ${id} order by id
    `
    expect(events.map((e) => e.event)).toEqual(['revoked', 'disconnected'])
    for (const event of events) {
      expect(event.actor_kind).toBe('staff')
      expect(event.actor_label).toBe(ACTOR.label)
    }

    // `audit_event` is append-only, so this is a DELTA and never a total (ADR 0008).
    const [after] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
      where entity_type = 'google_connection' and entity_id = ${id}
        and actor_label = ${ACTOR.label}
        and action in ('google_connection.revoked', 'google_connection.disconnected')
    `
    expect(Number(after?.n ?? 0) - Number(before?.n ?? 0)).toBe(2)
  })

  it('refuses a subsequent UPDATE of either event row, by SQLSTATE', async () => {
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    await disconnectGoogleConnection(depsFor(DEPARTING), { connectionId: id, actor: ACTOR })
    const rows = await sql<{ id: string }[]>`
      select id::text from google_connection_events where connection_id = ${id} order by id
    `
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      // 23001 is restrict_violation, which is the errcode 0016's BEFORE UPDATE trigger raises with. The
      // older append-only tables use `create rule … do instead nothing`, which reports success — for this
      // table that would be the wrong trade, because the code that UPDATEs an event believes it is
      // correcting history and must be told it cannot rather than left believing it did.
      await expect(
        sql`update google_connection_events set detail = '{}'::jsonb where id = ${row.id}::bigint`,
      ).rejects.toMatchObject({ code: '23001' })
    }
  })

  it('the control: the same rows accept an INSERT, so the trigger is not refusing everything', async () => {
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    await disconnectGoogleConnection(depsFor(DEPARTING), { connectionId: id, actor: ACTOR })
    // A third event appends fine. Append-only means *append*, and a trigger that refused inserts would
    // make every assertion above pass for the wrong reason.
    await store.appendEvent({
      connectionId: id,
      googleSub: DEPARTING.sub,
      event: 'health_check_ok',
      detail: { source: 'gconn09-control' },
    })
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_connection_events where connection_id = ${id}
    `
    expect(row?.n).toBe('3')
  })
})

describe('acceptance — revoke failure is not silent', () => {
  it('marks the row disconnected/revoke_failed, RETAINS the ciphertext, and enqueues a retry', async () => {
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    failures.failAlways('server_error')

    const outcome = await disconnectGoogleConnection(depsFor(DEPARTING), {
      connectionId: id,
      actor: ACTOR,
    })
    expect(outcome.kind).toBe('revoke_failed')
    expect(outcome.retryAnnouncement).toBe('queued')

    const row = await rawRow(id)
    expect(row.status).toBe('disconnected')
    expect(row.status_reason).toBe('revoke_failed')
    // The assertion the ordering exists for. Erasing here destroys the only credential that could kill a
    // grant that may still be live at Google.
    expect(row.refresh_token_ct).not.toBeNull()
    // And the cached access token still goes: it is not the retry's credential and it is live authority.
    expect(row.access_token_ct).toBeNull()

    const jobs = await sql<{ data: Record<string, unknown> }[]>`
      select data from pgboss.job where name = ${QUEUE}
    `
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.data).toEqual({ connectionId: id })

    // Every encoding, over every pg-boss row's data and output. A token in a job payload is a token in a
    // table with its own retention window, reachable from `pg_stat_statements` (docs/10 §4).
    const [blob] = await sql<{ blob: string }[]>`
      select string_agg(coalesce(data::text, '') || coalesce(output::text, ''), ' ') as blob
      from pgboss.job
    `
    expect(blob?.blob ?? '').not.toContain(DEPARTING_TOKEN)
  })

  it('the retry eventually succeeds and clears the reason', async () => {
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    failures.failAlways('server_error')
    await disconnectGoogleConnection(depsFor(DEPARTING), { connectionId: id, actor: ACTOR })
    expect((await rawRow(id)).status_reason).toBe('revoke_failed')

    // Google comes back. The sweep finds the row by its reason, not by the job payload — which is what
    // makes the mechanism survive a lost enqueue.
    failures.clear()
    const report = await retryPendingRevocations(depsFor(DEPARTING, false), SWEEP_ACTOR)
    expect(report).toEqual({ attempted: 1, revoked: 1, stillUnconfirmed: 0, unconfirmed: [] })

    const row = await rawRow(id)
    expect(row.status_reason).toBe('manual')
    expect(row.refresh_token_ct).toBeNull()
    expect(scanFinds(await scanTokenColumns(), DEPARTING_TOKEN)).toBe(false)
    // The whole story, in order, in an append-only log nothing can rewrite.
    const events = await sql<{ event: string }[]>`
      select event from google_connection_events where connection_id = ${id} order by id
    `
    expect(events.map((e) => e.event)).toEqual(['disconnected', 'revoked', 'disconnected'])
  })

  it('a later failure cannot roll the disconnect rows back', async () => {
    // G-CONN-06's defect in this unit's shape. The announcement happens after the commit and is wrapped, so
    // an unreachable queue costs promptness and not the record — and the record is all that is left once
    // the credential is gone.
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    failures.failAlways('server_error')
    const deps: DisconnectDeps = {
      ...depsFor(DEPARTING, false),
      enqueueRevokeRetry: async () => {
        throw new Error('pg-boss is unreachable')
      },
    }

    const outcome = await disconnectGoogleConnection(deps, { connectionId: id, actor: ACTOR })
    expect(outcome.retryAnnouncement).toBe('failed')

    // Read back through a fresh query, so this is the committed state rather than anything in flight.
    const row = await rawRow(id)
    expect(row.status).toBe('disconnected')
    expect(row.status_reason).toBe('revoke_failed')
    const [events] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_connection_events
      where connection_id = ${id} and event = 'disconnected'
    `
    expect(events?.n).toBe('1')
    // And the work is still findable: the ROW is the queue.
    expect((await store.pendingRevocations()).map((c) => c.id)).toEqual([id])
  })
})

describe('the constraints migration 0040 adds, by name', () => {
  it('refuses a PARTIAL wipe of the refresh token', async () => {
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    // Disconnected first, deliberately. On an `active` row the same UPDATE trips
    // `google_connections_live_grant_has_a_refresh_token` instead, and a fixture rejected by a neighbouring
    // constraint would leave this one free to stop matching anything while the test reported PASS (ADR
    // 0003). A terminal status satisfies that check and isolates this one.
    await sql`update google_connections set status = 'disconnected' where id = ${id}`
    // The tempting shortcut: erase the ciphertext and keep the kid "for the audit trail". The row that
    // leaves cannot be opened, cannot be re-wrapped, and cannot be told apart from corruption.
    await expect(
      sql`update google_connections set refresh_token_ct = null where id = ${id}`,
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'google_connections_refresh_token_complete',
    })
  })

  it('refuses a PARTIAL wipe of the access token', async () => {
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    await expect(
      sql`
        update google_connections set access_token_ct = ${Buffer.from('ct')} where id = ${id}
      `,
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'google_connections_access_token_complete',
    })
  })

  it('refuses a LIVE grant with no refresh token', async () => {
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    // `needs_reauth` is the state this protects. An `invalid_grant` on one refresh is not proof the grant
    // is gone at Google, so a needs_reauth row with no ciphertext is a grant nothing can ever revoke.
    await sql`
      update google_connections set status = 'needs_reauth', status_reason = 'invalid_grant'
      where id = ${id}
    `
    await expect(
      sql`
        update google_connections set
          refresh_token_ct = null, refresh_token_nonce = null, refresh_token_wrapped_key = null,
          refresh_token_kid = null, refresh_token_aad_fp = null
        where id = ${id}
      `,
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'google_connections_live_grant_has_a_refresh_token',
    })
  })

  it('refuses a revoke_failed row whose ciphertext has been erased', async () => {
    // The unrecoverable half-failure, made unrepresentable. `revoke_failed` means the grant may still be
    // live and the stored ciphertext is the retry's only credential.
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    await expect(
      sql`
        update google_connections set
          status = 'disconnected', status_reason = 'revoke_failed',
          refresh_token_ct = null, refresh_token_nonce = null, refresh_token_wrapped_key = null,
          refresh_token_kid = null, refresh_token_aad_fp = null
        where id = ${id}
      `,
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'google_connections_revoke_retry_keeps_its_token',
    })
  })

  it('the control: the disconnect the code actually makes is accepted', async () => {
    // Four refusals above and one acceptance here. Without it, a constraint written the wrong way round
    // would refuse every write and all four would still pass.
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    await disconnectGoogleConnection(depsFor(DEPARTING), { connectionId: id, actor: ACTOR })
    expect((await rawRow(id)).refresh_token_ct).toBeNull()

    const retained = await seedConnection(INCOMING, '1//09-gconn09-retained', PLACE_ID)
    failures.failAlways('server_error')
    await disconnectGoogleConnection(depsFor(INCOMING, false), {
      connectionId: retained,
      actor: ACTOR,
    })
    expect((await rawRow(retained)).refresh_token_ct).not.toBeNull()
  })
})

describe('a connection with reviews', () => {
  async function seedReview(connectionId: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into google_reviews
        (connection_id, place_id, source, delivery_mode, rating, comment_text,
         reviewer_display_name, reviewed_at, reply_draft)
      values (${connectionId}, ${PLACE_ID}, 'paste', 'manual', 5,
              'Lovely hot oil massage, very professional.', 'A Google user',
              ${new Date('2026-09-15T12:00:00.000Z')}, 'Thank you for visiting us.')
      returning id::text
    `
    return row?.id ?? ''
  }

  it('is disconnected, not deleted: the reviews and their drafts survive', async () => {
    // The decision this unit has to make explicitly. 0020 makes `connection_id` ON DELETE RESTRICT and says
    // why: a review with a drafted reply is a business record, and a cascade would take the queue and its
    // drafts with it silently. So a disconnect is a STATUS CHANGE, and that is what makes RESTRICT a
    // constraint that never fires rather than one an operator has to work around.
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    const reviewId = await seedReview(id)

    const outcome = await disconnectGoogleConnection(depsFor(DEPARTING), {
      connectionId: id,
      actor: ACTOR,
    })
    expect(outcome.kind).toBe('revoked')

    const [review] = await sql<{ id: string; reply_draft: string | null }[]>`
      select id::text, reply_draft from google_reviews where id = ${reviewId}::uuid
    `
    expect(review?.id).toBe(reviewId)
    expect(review?.reply_draft).toBe('Thank you for visiting us.')
    // The connection row stays too, so the review's foreign key still resolves and the queue can still
    // name the listing a review was left on.
    expect((await rawRow(id)).status).toBe('disconnected')
  })

  it('a DELETE of that connection is refused, which is why the disconnect is a status change', async () => {
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    await seedReview(id)
    // 23503 is foreign_key_violation. This is the failure an offboarding would hit if it tried to tidy the
    // row away, and it is better than the alternative: a cascade would have deleted the reviews.
    await expect(sql`delete from google_connections where id = ${id}`).rejects.toMatchObject({
      code: '23503',
      constraint_name: 'google_reviews_connection_id_fkey',
    })
  })

  it('the control: a connection with no reviews deletes cleanly', async () => {
    // So the refusal above is about the review and not about the connection.
    const id = await seedConnection(INCOMING, '1//09-gconn09-no-reviews', PLACE_ID)
    await sql`delete from google_connections where id = ${id}`
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_connections where id = ${id}
    `
    expect(row?.n).toBe('0')
  })
})

describe('a refresh racing a disconnect cannot re-cache a token', () => {
  it('recordRefresh refuses a disconnected row', async () => {
    // Under READ COMMITTED a disconnect can commit after a refresh has re-read the row inside its advisory
    // lock and before the refresh writes. The UPDATE then waits on the row lock, re-evaluates its WHERE
    // against the new row version, and — without the `status <> 'disconnected'` clause — caches an hour of
    // live authority on a row whose credentials were just erased on purpose.
    const id = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    await disconnectGoogleConnection(depsFor(DEPARTING), { connectionId: id, actor: ACTOR })

    const sealed = sealToken(
      KEK,
      connectionBinding({ connectionId: id, googleSub: DEPARTING.sub }),
      'fake-access-late-arrival',
    )
    await expect(
      store.recordRefresh({
        connectionId: id,
        accessToken: sealed,
        accessExpiresAt: instantFromIso(NOW_ISO),
        lastOkAt: instantFromIso(NOW_ISO),
        status: 'active',
        statusReason: null,
      }),
    ).rejects.toThrow(/disconnected while this refresh was in flight/)
    expect((await rawRow(id)).access_token_ct).toBeNull()
    expect((await rawRow(id)).status).toBe('disconnected')
  })

  it('the control: the same write succeeds while the connection is active', async () => {
    const id = await seedConnection(INCOMING, '1//09-gconn09-still-active', PLACE_ID)
    await store.recordRefresh({
      connectionId: id,
      accessToken: sealToken(
        KEK,
        connectionBinding({ connectionId: id, googleSub: INCOMING.sub }),
        'fake-access-ok',
      ),
      accessExpiresAt: instantFromIso(NOW_ISO),
      lastOkAt: instantFromIso(NOW_ISO),
      status: 'active',
      statusReason: null,
    })
    expect((await rawRow(id)).access_token_ct).not.toBeNull()
  })
})

describe("acceptance — docs/10 §5's migration path, in order", () => {
  it('connects the new sub, verifies the same placeId, and only THEN revokes the old grant', async () => {
    // docs/10 §5: create the business account → … → reconnect in our admin (a new `sub`, so a new
    // connection row) → **verify capabilities against the same placeId** → mark the old connection
    // disconnected and revoke.
    //
    // The order is the substance. Revoking first and discovering afterwards that the new account cannot see
    // the listing leaves the business with no working grant at all — and Google's ownership-transfer
    // waiting period means the recovery is a week, not a retry. So the sequence is asserted from the
    // provider CALL LOG, which is a recording of what actually reached Google rather than of what this test
    // believes it asked for.
    const oldId = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)

    // 1. The new account consents. A different `sub`, so a new row beside the old one — never a swap.
    const incomingOauth = oauthFor(INCOMING)
    const consent = await incomingOauth.exchangeCode('gconn09-migration-code')
    expect(consent.sub).toBe(INCOMING.sub)
    const newId = await seedConnection(INCOMING, consent.refreshToken ?? 'missing', PLACE_ID)

    // 2. Its capabilities are verified against the SAME placeId, by reading the listing back from Google.
    const profile = createFakeBusinessProfile({ log, failures, now: () => NOW_ISO })
    // The read mask is mandatory on the real API, and `readLocationSnapshot` refuses a call without one
    // before it reaches the transport — a mask that omits `metadata` returns a location with no `placeId`
    // at all, which is the value this whole verification turns on (docs/10 §7).
    const snapshot = await readLocationSnapshot(
      profile,
      AL_ZAHIYAH_LOCATION.name,
      LOCATION_READ_MASK,
    )
    expect(snapshot.placeId).toBe(PLACE_ID)
    const voice = await profile.getVoiceOfMerchantState(AL_ZAHIYAH_LOCATION.name)
    expect(voice.hasVoiceOfMerchant).toBe(true)

    // The old connection is still usable at this point, which is the property the ordering buys.
    expect((await rawRow(oldId)).status).toBe('active')

    // 3. Only now: disconnect and revoke the old grant.
    await disconnectGoogleConnection(depsFor(DEPARTING), { connectionId: oldId, actor: ACTOR })

    const sequence = log.all().map((call) => call.operation)
    const exchanged = sequence.indexOf('exchangeCode')
    const verified = sequence.lastIndexOf('getVoiceOfMerchantState')
    const revoked = sequence.indexOf('revoke')
    expect(exchanged).toBeGreaterThanOrEqual(0)
    expect(verified).toBeGreaterThan(exchanged)
    expect(revoked).toBeGreaterThan(verified)

    // And the end state: the new connection holds a credential, the old one holds none.
    expect((await rawRow(newId)).refresh_token_ct).not.toBeNull()
    expect((await rawRow(oldId)).refresh_token_ct).toBeNull()
    expect((await rawRow(oldId)).status_reason).toBe('manual')
  })

  it('the control: the recorded sequence would catch a revocation that came first', async () => {
    // The ordering assertion above compares three indices, and three indices all equal to -1 satisfy
    // nothing. Here the disconnect happens BEFORE any verification, and the same comparison fails — which
    // is what makes the assertion above a check rather than a formality.
    const oldId = await seedConnection(DEPARTING, DEPARTING_TOKEN, PLACE_ID)
    await disconnectGoogleConnection(depsFor(DEPARTING), { connectionId: oldId, actor: ACTOR })
    const profile = createFakeBusinessProfile({ log, failures, now: () => NOW_ISO })
    await profile.getVoiceOfMerchantState(AL_ZAHIYAH_LOCATION.name)

    const sequence = log.all().map((call) => call.operation)
    expect(sequence.indexOf('revoke')).toBeLessThan(sequence.lastIndexOf('getVoiceOfMerchantState'))
  })
})
