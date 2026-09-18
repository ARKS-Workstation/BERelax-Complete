import { generateKek } from '@berelax/clinical'
import { ACCESS_TOKEN_REFRESH_MARGIN_MINUTES, fixedClock, instantFromIso } from '@berelax/core'
import { createConnection, createJobQueue, type Sql } from '@berelax/db'
import { type CallLog, createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  GOOGLE_OAUTH,
} from '@berelax/providers/google'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPostgresConnectionStore } from './postgres-store.ts'
import {
  createPostgresRefreshLock,
  REFRESH_LOCK_NAMESPACE,
  REFRESH_LOCK_TIMEOUT,
  type RefreshLockRunner,
} from './token-refresh.ts'
import { connectionBinding, openToken, sealToken } from './token-store.ts'
import { type WithGoogleDeps, withGoogle } from './with-google.ts'

/**
 * G-CONN-04 — proactive refresh under an advisory transaction lock, double-checked.
 *
 * Every claim in this unit is a claim about **two real database connections racing**, so every one of them
 * is here rather than in a unit test. The specific thing a unit test cannot do: a memory lock serialises
 * inside one event loop, so "exactly one refresh" is true there whether or not the double check exists.
 *
 * Two shapes recur below and both are deliberate.
 *
 * **Counter assertions, never "a token is present afterwards".** A test that asserted the connection has a
 * usable token after ten concurrent calls passes with no lock at all — ten refreshes also leave a usable
 * token. The assertion has to be on the number of refresh requests that reached the fake.
 *
 * **A control that must fail.** Each claim is paired with the same scenario arranged so the mechanism is
 * absent: the concurrency test re-runs with a pass-through lock and demands MORE than one refresh, the
 * transaction-scope test re-runs with the SESSION lock and demands the lock is still held after a
 * rollback, the boundary test asserts both sides of five minutes, and the job-payload scan is pointed at a
 * row that really does contain the token. Without those, each assertion is satisfied by a broken
 * implementation.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const KEK = generateKek('v1')
const NOW_ISO = '2026-09-18T10:00:00.000Z'
const NOW = instantFromIso(NOW_ISO)
/** This file's own account, so `beforeEach` can tell its rows from every other suite's. */
const SUB = 'sub-token-refresh-0001'
const RESOURCE = { account: 'accounts/9', location: 'locations/9', placeId: 'ChIJ-token-refresh' }

/**
 * Long, distinctive and shaped like Google's, so a partial leak is still recognisable in a job payload.
 *
 * Google's refresh tokens begin `1//`, which is why the comment stripper in
 * `scripts/check-google-token-chokepoint.mjs` has to leave a `//` inside a string alone.
 */
const REFRESH_TOKEN = '1//09-GCONN04-refresh-token-that-must-never-reach-a-payload'

/** Ten simultaneous calls need ten connections to race on; one would serialise them for free. */
const POOL = 14
const CONCURRENT_CALLS = 10

/** A queue owned by this file, so nothing here depends on the shipped registry's contents. */
const QUEUE = 'gconn04-refresh-probe'

let sql: Sql
/** A second pool, so the observer of `pg_locks` is never the session holding the lock. */
let observer: Sql
let boss: PgBoss
let store: ReturnType<typeof createPostgresConnectionStore>

beforeAll(async () => {
  sql = createConnection({ url, max: POOL })
  observer = createConnection({ url, max: 2 })
  store = createPostgresConnectionStore(sql)
  boss = createJobQueue({ connectionString: url, max: 2 })
  await boss.start()
  await boss.createQueue(QUEUE)
}, 120_000)

afterAll(async () => {
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
  await observer?.end({ timeout: 5 })
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  /**
   * Nothing else in the database may serve `gbp_reviews` while this file runs.
   *
   * `withGoogle` resolves a connection from the **capability**, scanning every row that is not
   * `disconnected` — production behaviour, and the reason a consumer never has to know which Google
   * account is wired up. `pnpm test:integration` runs files sequentially against ONE database, so a
   * connection another file left behind with a lower UUIDv7 id sorts first, ties on rank and wins; every
   * test below would then assert against a row it never created. `with-google.itest.ts` documents the same
   * hazard and does the same thing.
   *
   * Disconnecting rather than deleting, because `google_reviews.connection_id` is `ON DELETE RESTRICT`: a
   * `delete from google_connections` fails the moment a review suite has left a review behind, which is a
   * different false failure rather than a fix.
   */
  await sql`update google_connections set status = 'disconnected' where google_sub <> ${SUB}`
  await sql`delete from google_connections where google_sub = ${SUB}`
  await sql`delete from pgboss.job where name = ${QUEUE}`
})

/**
 * A connection serving `gbp_reviews`, with its cached access token this far from expiry.
 *
 * `expiresInSeconds: null` means no cached token at all, which is the state after a consent.
 */
async function seed(expiresInSeconds: number | null): Promise<string> {
  const id = await store.allocateId()
  const binding = connectionBinding({ connectionId: id, googleSub: SUB })
  await store.insert({
    id,
    googleSub: SUB,
    googleEmail: 'google-admin@berelax.ae',
    grantedScopes: ['https://www.googleapis.com/auth/business.manage'],
    refreshToken: sealToken(KEK, binding, REFRESH_TOKEN),
    consentAt: instantFromIso('2026-09-17T10:00:00.000Z'),
  })
  await store.upsertCapability({
    connectionId: id,
    capability: 'gbp_reviews',
    resourceRef: RESOURCE,
    health: 'unknown',
    isPrimary: true,
  })
  if (expiresInSeconds !== null) {
    // Through `recordRefresh`, which writes the five sealed columns and `access_expires_at` in ONE
    // statement. Writing them by hand would either bypass the
    // `google_connections_access_token_complete` CHECK's whole point or be refused by it — see the
    // partial-write probe in scripts/test-gates.mjs.
    await store.recordRefresh({
      connectionId: id,
      accessToken: sealToken(KEK, binding, 'stale-access-token-from-the-seed'),
      accessExpiresAt: instantFromIso(new Date(NOW + expiresInSeconds * 1000).toISOString()),
      lastOkAt: instantFromIso('2026-09-18T09:00:00.000Z'),
      status: 'active',
      statusReason: null,
    })
  }
  return id
}

interface Rig {
  readonly deps: WithGoogleDeps
  readonly log: CallLog
  readonly api: FailureScript
  /** How many times the body was run inside the lock. Zero proves the fast path skipped the lock. */
  readonly locked: () => number
  readonly profile: ReturnType<typeof createFakeBusinessProfile>
}

/** Refresh requests that actually reached the fake OAuth endpoint. The counter every claim rests on. */
const refreshCount = (log: CallLog): number =>
  log.forProvider(GOOGLE_OAUTH).filter((call) => call.operation === 'refresh').length

/**
 * Builds the dependencies for one scenario.
 *
 * `lock` is a parameter because two of the tests below are about the lock itself: one replaces it with a
 * pass-through to show what happens without serialisation, and one wraps it to look at `pg_locks` from
 * outside while it is held.
 */
function rig(
  options: {
    readonly lock?: (real: RefreshLockRunner) => RefreshLockRunner
    readonly rotatesRefreshToken?: boolean
    /** Replaces the store `withGoogle` reads through. Used to hold every reader on the stale row. */
    readonly store?: WithGoogleDeps['store']
  } = {},
): Rig {
  const log = createCallLog(() => NOW_ISO)
  const api = new FailureScript()
  let locked = 0
  const real = createPostgresRefreshLock(sql)
  const counted: RefreshLockRunner = {
    withConnectionLock: (connectionId, body) =>
      real.withConnectionLock(connectionId, async (scope) => {
        locked += 1
        return body(scope)
      }),
  }
  return {
    log,
    api,
    locked: () => locked,
    profile: createFakeBusinessProfile({ log, failures: api, now: () => NOW_ISO }),
    deps: {
      store: options.store ?? store,
      lock: options.lock === undefined ? counted : options.lock(counted),
      oauth: createFakeGoogleOAuth({
        log,
        // A separate script would be needed to fail a refresh; every test here wants the refresh to
        // succeed and arms only the API call.
        failures: new FailureScript(),
        now: () => NOW_ISO,
        sub: SUB,
        ...(options.rotatesRefreshToken === undefined
          ? {}
          : { rotatesRefreshToken: options.rotatesRefreshToken }),
      }),
      kek: KEK,
      clock: fixedClock(NOW_ISO),
      logger: { log: () => {} },
      newCorrelationId: () => 'corr-gconn04',
    },
  }
}

/**
 * A store whose `load` holds every caller until `count` of them have read the row.
 *
 * This is what makes the ten-way race deterministic instead of hopeful. `accessTokenUnderLock` reads the
 * row once before it takes the lock, and whether a caller reaches the lock at all depends on whether that
 * read landed before the winner's COMMIT — scheduling, not behaviour. Left to chance the count came out at
 * ten when the file ran alone and lower under the load of the full sequential suite, which is a flaky test
 * rather than a discovery.
 *
 * Holding all ten on the stale row first is also the exact scenario docs/10 §4 describes: *pg-boss can
 * start the review poll, the SEO crawl and the health check in the same second on different workers, all
 * seeing a stale token.* The barrier releases in JS after each query has returned, so no connection is
 * held while waiting.
 *
 * Only the OUTER store is wrapped. The double check inside the lock reads through the transaction-scoped
 * store, which is a different object, so it is never held.
 */
function storeHoldingEveryReader(count: number): WithGoogleDeps['store'] {
  let arrived = 0
  let release = (): void => {}
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    ...store,
    async load(connectionId) {
      const row = await store.load(connectionId)
      arrived += 1
      if (arrived >= count) release()
      await open
      return row
    },
  }
}

/** `refreshed` rows for one connection. A DELTA is unnecessary: `beforeEach` deletes the row. */
async function refreshedEvents(connectionId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from google_connection_events
    where connection_id = ${connectionId} and event = 'refreshed'
  `
  return Number(row?.n ?? '0')
}

/**
 * Advisory locks held anywhere in the database for this connection's computed key.
 *
 * The key is computed with `REFRESH_LOCK_NAMESPACE` and `hashtextextended`, the same expression
 * `token-refresh.ts` locks on — a test that hashed its own string would watch the wrong key and report
 * zero for ever.
 *
 * `pg_locks` splits a single-bigint advisory key into two 32-bit halves (`classid` high, `objid` low,
 * `objsubid = 1`), so the halves are recombined rather than compared to the key directly. In `numeric`,
 * because the recombined value exceeds `bigint` for any key with the high bit set — which is half of
 * them.
 */
async function advisoryLocksFor(connectionId: string): Promise<number> {
  const [row] = await observer<{ n: string }[]>`
    with k as (select hashtextextended(${REFRESH_LOCK_NAMESPACE} || ${connectionId}, 0) as key)
    select count(*)::text as n
    from pg_locks l cross join k
    where l.locktype = 'advisory'
      and l.objsubid = 1
      and (l.classid::bigint::numeric * 4294967296 + l.objid::bigint::numeric)
          = case when k.key < 0 then k.key::numeric + 18446744073709551616 else k.key::numeric end
  `
  return Number(row?.n ?? '0')
}

/**
 * Rows whose stored token columns contain `secret`, searched as bytes and needing no KEK.
 *
 * Two needles rather than three: `secret` is ASCII, so its UTF-8 and latin1 byte sequences are identical
 * and a third would be the same search twice. base64 is the one that differs, and it is the encoding a
 * token arrives in when something wraps it in an envelope on the way to a column.
 */
async function ciphertextHits(secret: string): Promise<number> {
  const rows = await sql<{ refresh: Buffer; access: Buffer | null }[]>`
    select refresh_token_ct as refresh, access_token_ct as access from google_connections
  `
  const utf8 = Buffer.from(secret, 'utf8')
  const needles = [utf8, Buffer.from(utf8.toString('base64'), 'utf8')]
  return rows.filter((row) =>
    needles.some(
      (needle) => row.refresh.includes(needle) || (row.access?.includes(needle) ?? false),
    ),
  ).length
}

describe('acceptance — ten simultaneous calls produce exactly one refresh', () => {
  it('refreshes once and answers all ten callers', async () => {
    const connectionId = await seed(60)
    // Every one of the ten holds the stale row before any of them takes the lock — see
    // `storeHoldingEveryReader`. Without the barrier, how many callers reach the lock depends on
    // scheduling, and the assertion on it was flaky under the load of the full suite.
    const refreshes: boolean[] = []
    const { deps, profile, log, locked } = rig({ store: storeHoldingEveryReader(CONCURRENT_CALLS) })
    const watched: WithGoogleDeps = {
      ...deps,
      logger: {
        log(line) {
          // `withGoogle` logs `refreshed` on every successful call: true for the one that did the work,
          // false for a caller handed a cached token. It is the only place the two are told apart.
          if (line.message === 'google call succeeded')
            refreshes.push(line.fields['refreshed'] === true)
        },
      },
    }

    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENT_CALLS }, () =>
        withGoogle(watched, 'gbp_reviews', async () => profile.listReviews(RESOURCE.location)),
      ),
    )

    // Ten successful calls. A lock that serialised by failing nine of them would also produce one
    // refresh, so this half is not decoration.
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(
      Array.from({ length: CONCURRENT_CALLS }, () => 'ok'),
    )
    // THE claim. One refresh request left this process, so Google had one chance to rotate the refresh
    // token and one row absorbed it.
    expect(refreshCount(log)).toBe(1)
    // And the append-only log agrees, which is the same claim read back out of the database rather than
    // out of the fake's memory.
    expect(await refreshedEvents(connectionId)).toBe(1)
    // All ten took the lock, nine of them only to discover they did not need to refresh. That is the
    // double check running, as distinct from nine callers never reaching the lock.
    expect(locked()).toBe(CONCURRENT_CALLS)
    // One did the work and nine used its token, which is the sentence the unit exists to make true.
    expect(refreshes.filter((refreshed) => refreshed)).toHaveLength(1)
    expect(refreshes).toHaveLength(CONCURRENT_CALLS)

    const stored = await store.load(connectionId)
    expect(stored?.accessToken).not.toBeNull()
  })

  it('and the control: without the lock the same ten calls spend several refresh tokens', async () => {
    // The known-bad arrangement, and the only thing that makes the assertion above mean anything. A
    // pass-through "lock" runs every body immediately against the pooled store, which is the code that
    // existed before this unit. If this ever reports 1, the test above is passing because something else
    // serialised the ten calls — an event loop, a pool of one — and not because of the lock.
    //
    // `toBeGreaterThan(1)` rather than `toBe(10)`, and the reason is the bug itself: with no
    // serialisation the count depends on which read happens to land after which commit, so it comes out
    // somewhere between six and ten from run to run. An unserialised refresh being NON-DETERMINISTIC is
    // exactly the complaint, and pinning the number would make this control flaky while proving nothing
    // beyond "not one".
    const connectionId = await seed(60)
    const { deps, profile, log } = rig({
      lock: () => ({ withConnectionLock: (_id, body) => body({ store }) }),
    })

    await Promise.all(
      Array.from({ length: CONCURRENT_CALLS }, () =>
        withGoogle(deps, 'gbp_reviews', async () => profile.listReviews(RESOURCE.location)),
      ),
    )

    expect(refreshCount(log)).toBeGreaterThan(1)
    // Every one of those refreshes is a chance for Google to hand back a rotated refresh token that the
    // next write overwrites, which is the failure the lock exists to prevent — and the append-only log
    // records each one, so the two counters have to agree.
    expect(await refreshedEvents(connectionId)).toBe(refreshCount(log))
  })
})

describe('acceptance — the lock is transaction-scoped', () => {
  it('is held during the refresh and gone the moment the transaction commits', async () => {
    const connectionId = await seed(60)
    let heldInside = -1
    const { deps, profile } = rig({
      lock: (real) => ({
        withConnectionLock: (id, body) =>
          real.withConnectionLock(id, async (scope) => {
            // Observed from a DIFFERENT pool, so this is what another worker would see.
            heldInside = await advisoryLocksFor(id)
            return body(scope)
          }),
      }),
    })

    const outcome = await withGoogle(deps, 'gbp_reviews', async () =>
      profile.listReviews(RESOURCE.location),
    )
    expect(outcome.kind).toBe('ok')

    // Held while the transaction was open…
    expect(heldInside).toBe(1)
    // …and released by the COMMIT, with nothing having called an unlock. No lease, no expiry, no
    // distributed-lock correctness argument (docs/10 §4).
    expect(await advisoryLocksFor(connectionId)).toBe(0)
  })

  it('and the control: the SESSION lock survives a rolled-back transaction, which is the bug', async () => {
    // Why `pg_advisory_xact_lock` and not `pg_advisory_lock`. The session variant is released by an
    // explicit unlock or by the connection closing — so a refresh that throws leaves it held on a pooled
    // connection that goes straight back into the pool, and every later refresh of that connection blocks
    // for ever on a lock nothing still wants.
    //
    // A RESERVED connection, so "the session" is one unambiguous backend, and the transaction driven by
    // explicit statements so the ROLLBACK is visibly the thing that does not release the lock.
    const connectionId = await seed(60)
    const holder = await sql.reserve()
    try {
      await holder`begin`
      await holder`
        select pg_advisory_lock(hashtextextended(${REFRESH_LOCK_NAMESPACE} || ${connectionId}, 0))
      `
      await holder`rollback`

      // Rolled back, and STILL HELD. This is also what proves the query in the test above can see a lock
      // at all — without it, "zero after the commit" would pass for ever against a query that matches
      // nothing.
      expect(await advisoryLocksFor(connectionId)).toBe(1)

      // An explicit unlock is the only thing that releases it — that, or losing the connection, which on
      // a pooled connection happens at some unrelated later moment. The xact variant needs neither.
      await holder`select pg_advisory_unlock_all()`
      expect(await advisoryLocksFor(connectionId)).toBe(0)
    } finally {
      holder.release()
    }
  })

  it('surfaces a named error rather than waiting for ever when another worker holds the lock', async () => {
    // The reason `lock_timeout` is not optional: without it every waiter holds an open transaction and
    // therefore a pooled connection, and one hung HTTPS call to Google becomes `53300
    // too_many_connections` for the booking flow.
    const connectionId = await seed(60)
    const log = createCallLog(() => NOW_ISO)
    // Taken and AWAITED before the call under test starts. An unawaited holder races, and the race it
    // loses is the one where the refresh succeeds and this test asserts nothing — which is what happened
    // on the first run of it.
    const holder = await sql.reserve()
    try {
      await holder`begin`
      await holder`
        select pg_advisory_xact_lock(
          hashtextextended(${REFRESH_LOCK_NAMESPACE} || ${connectionId}, 0)
        )
      `
      // Contention proven from a third session, so a 250ms timeout cannot be timing out on nothing.
      expect(await advisoryLocksFor(connectionId)).toBe(1)

      const deps: WithGoogleDeps = {
        ...rig().deps,
        lock: createPostgresRefreshLock(sql, { lockTimeoutMs: 250 }),
        oauth: createFakeGoogleOAuth({
          log,
          failures: new FailureScript(),
          now: () => NOW_ISO,
          sub: SUB,
        }),
      }
      const error = await withGoogle(deps, 'gbp_reviews', async () => 'never reached').catch(
        (e: unknown) => e,
      )

      // Thrown rather than degraded: `TransientUpstream` is the queue's to retry with backoff, and a lock
      // held for a moment is the definition of something the next attempt might fix.
      expect((error as { details?: Record<string, unknown> }).details?.['errorClass']).toBe(
        'TransientUpstream',
      )
      // And no refresh was attempted, which is the part that matters: a timeout that fell through to an
      // unlocked refresh would be worse than no lock at all.
      expect(refreshCount(log)).toBe(0)
      // The owner's dashboard sees it, because nobody reads `pgboss.job` (docs/10 §4).
      const [row] = await sql<{ detail: Record<string, unknown> }[]>`
        select detail from google_connection_events
        where connection_id = ${connectionId} and event = 'health_check_failed'
        order by id desc limit 1
      `
      expect(row?.detail?.['errorClass']).toBe('TransientUpstream')

      await holder`rollback`
      // The waiter's own transaction was rolled back by the failure, so nothing is left holding anything.
      expect(await advisoryLocksFor(connectionId)).toBe(0)
    } finally {
      holder.release()
    }
    // Named, so an operator reading the row knows it was contention rather than Google.
    expect(REFRESH_LOCK_TIMEOUT).toBe('google_refresh_lock_timeout')
  })
})

describe('acceptance — the five-minute margin, from both sides', () => {
  it('refreshes a token with 4m59s left', async () => {
    const connectionId = await seed(ACCESS_TOKEN_REFRESH_MARGIN_MINUTES * 60 - 1)
    const { deps, profile, log, locked } = rig()
    const outcome = await withGoogle(deps, 'gbp_reviews', async () =>
      profile.listReviews(RESOURCE.location),
    )
    expect(outcome.kind).toBe('ok')
    expect(refreshCount(log)).toBe(1)
    expect(locked()).toBe(1)
    expect(await refreshedEvents(connectionId)).toBe(1)
  })

  it('leaves a token with 5m01s left alone, and never takes the lock for it', async () => {
    // The other side of the boundary, and the control for the test above: a path that refreshed every
    // time would satisfy that one and would serialise every Google call in the system behind one row.
    const connectionId = await seed(ACCESS_TOKEN_REFRESH_MARGIN_MINUTES * 60 + 1)
    const { deps, profile, log, locked } = rig()
    const outcome = await withGoogle(deps, 'gbp_reviews', async () =>
      profile.listReviews(RESOURCE.location),
    )
    expect(outcome.kind).toBe('ok')
    expect(refreshCount(log)).toBe(0)
    expect(locked()).toBe(0)
    expect(await refreshedEvents(connectionId)).toBe(0)
  })
})

describe('acceptance — no reactive refresh on a 401', () => {
  it('surfaces the classified error and does not refresh an unexpired token', async () => {
    // A 401 from the API while the stored token has fifty minutes to live. docs/10 §4: refresh
    // proactively, *never* reactively on a 401 — a reactive refresh spends a round trip on every cron
    // cycle and fills the taxonomy with 401s that mean nothing, which is how the one 401 that means the
    // grant is dead gets lost among them.
    const connectionId = await seed(50 * 60)
    const { deps, profile, api, log, locked } = rig()
    api.failAlways('invalid_grant')

    const outcome = await withGoogle(deps, 'gbp_reviews', async () =>
      profile.listReviews(RESOURCE.location),
    )

    if (outcome.kind !== 'degraded') throw new Error('expected the declared degraded mode')
    expect(outcome.cause).toBe('GoogleReauthRequired')
    expect(outcome.mode).toBe('draft_only')
    // Zero. Not "one" and not "one fewer than it would have been".
    expect(refreshCount(log)).toBe(0)
    expect(locked()).toBe(0)
    // The connection's own status is untouched: the API said no, the grant did not.
    expect((await store.load(connectionId))?.status).toBe('active')
  })

  it('and the control: the same 401 against an expired token still refreshes exactly once', async () => {
    // Without this the assertion above passes for a fake that was never wired to an OAuth endpoint at
    // all, which is indistinguishable from "we correctly did not refresh".
    await seed(null)
    const { deps, profile, api, log } = rig()
    api.failAlways('invalid_grant')

    const outcome = await withGoogle(deps, 'gbp_reviews', async () =>
      profile.listReviews(RESOURCE.location),
    )
    expect(outcome.kind).toBe('degraded')
    expect(refreshCount(log)).toBe(1)
  })
})

describe('acceptance — a rotated refresh token is persisted', () => {
  it('replaces the stored ciphertext, round-trips, and leaves the old plaintext nowhere', async () => {
    const connectionId = await seed(null)
    const before = await store.load(connectionId)
    const { deps, profile, log } = rig({ rotatesRefreshToken: true })

    const outcome = await withGoogle(deps, 'gbp_reviews', async () =>
      profile.listReviews(RESOURCE.location),
    )
    expect(outcome.kind).toBe('ok')
    expect(refreshCount(log)).toBe(1)

    const after = await store.load(connectionId)
    // The ciphertext moved. Bytes, not a decrypted comparison: AES-GCM under a fresh data key produces
    // different bytes for the same plaintext, so this alone does not prove the token changed — which is
    // why the round-trip below is the actual assertion and this is only the necessary condition.
    expect(after?.refreshToken.ct.equals(before?.refreshToken.ct as Buffer)).toBe(false)

    const sealed = after?.refreshToken
    if (sealed === undefined || sealed === null) throw new Error('the connection lost its token')
    const rotated = openToken(KEK, connectionBinding({ connectionId, googleSub: SUB }), sealed)
    expect(rotated).not.toBe(REFRESH_TOKEN)
    // Round-trips to what the fake actually issued, so "it changed" cannot be satisfied by a corrupted
    // write that happens to decrypt to something.
    expect(rotated).toMatch(/^fake-refresh-\d+$/)

    // And the old plaintext matches no stored row, which is the second half of the claim.
    //
    // Asserted on the BYTES of every row rather than by decrypting each one, and the reason is a false
    // failure the decrypting version produced: every integration file makes its own KEK with
    // `generateKek('v1')`, which is `randomBytes`, so opening a row another suite left behind raises an
    // authentication failure rather than returning a different string — and this test would then fail for
    // having read somebody else's row. A byte scan needs no key, so it covers their rows too, and it is
    // the stronger statement anyway: it would also catch a token written to the column by something that
    // never encrypted it at all.
    expect(await ciphertextHits(REFRESH_TOKEN)).toBe(0)

    // And the control for that scan, because "zero hits" is also what a query against the wrong column,
    // the wrong table or an empty result reports — and zero is exactly what a passing test looks like.
    // The row is removed immediately rather than left for `beforeEach`, so no later test can load a
    // connection whose token column is not a ciphertext.
    await sql`
      update google_connections set refresh_token_ct = ${Buffer.from(REFRESH_TOKEN, 'utf8')}
      where google_sub = ${SUB}
    `
    expect(await ciphertextHits(REFRESH_TOKEN)).toBe(1)
    await sql`delete from google_connections where google_sub = ${SUB}`

    const [event] = await sql<{ detail: Record<string, unknown> }[]>`
      select detail from google_connection_events
      where connection_id = ${connectionId} and event = 'refreshed' order by id desc limit 1
    `
    expect(event?.detail?.['rotatedRefreshToken']).toBe(true)
    // The append-only row records THAT it rotated and not what to. The CHECK in 0016 would refuse a
    // payload carrying a token, so this is also a statement about which of the two the code chose.
    expect(JSON.stringify(event?.detail)).not.toContain(REFRESH_TOKEN)
  })

  it('and the control: with no rotation the stored ciphertext is byte-identical afterwards', async () => {
    // Google's ordinary behaviour, and the control that gives the test above its meaning. A
    // `recordRefresh` that rewrote the refresh-token columns on every call would satisfy "the ciphertext
    // changed" whether or not the response carried a rotated token — so the assertion there would hold
    // over an implementation that discards one. The `coalesce` in the UPDATE is what this pins down.
    const connectionId = await seed(null)
    const before = await store.load(connectionId)
    const { deps, profile, log } = rig()

    await withGoogle(deps, 'gbp_reviews', async () => profile.listReviews(RESOURCE.location))
    expect(refreshCount(log)).toBe(1)

    const after = await store.load(connectionId)
    expect(after?.refreshToken.ct.equals(before?.refreshToken.ct as Buffer)).toBe(true)
    expect(after?.refreshToken.kid).toBe(before?.refreshToken.kid)

    const [event] = await sql<{ detail: Record<string, unknown> }[]>`
      select detail from google_connection_events
      where connection_id = ${connectionId} and event = 'refreshed' order by id desc limit 1
    `
    expect(event?.detail?.['rotatedRefreshToken']).toBe(false)
  })
})

describe('acceptance — the token reaches no job payload', () => {
  /**
   * Every encoding a token could hide in, across every row of `pgboss.job` — `data` and `output` both.
   *
   * Three needles are computed although two of them coincide: the fixture token is ASCII, so its UTF-8
   * and latin1 forms are the same string, and writing both is a statement about which encodings were
   * considered rather than two different searches. base64 is the one that genuinely differs, and it is
   * the form a token arrives in when something wraps a payload in an envelope on the way to the queue —
   * which is how a token reaches a job payload without anybody having written it there.
   */
  async function jobPayloadHits(secret: string): Promise<number> {
    const rows = await sql<{ blob: string | null }[]>`
      select (coalesce(data::text, '') || coalesce(output::text, '')) as blob from pgboss.job
    `
    const needles = [
      secret,
      Buffer.from(secret, 'utf8').toString('latin1'),
      Buffer.from(secret, 'utf8').toString('base64'),
    ]
    return rows.filter((row) => needles.some((needle) => (row.blob ?? '').includes(needle))).length
  }

  it('after a full refresh cycle driven by a pg-boss job', async () => {
    const connectionId = await seed(null)
    const { deps, profile, log } = rig({ rotatesRefreshToken: true })

    // A real job, carrying what a job legitimately carries: an id. The refresh runs inside the handler,
    // so a token that leaked into the payload would have to have got there through the code under test.
    const jobId = await boss.send(QUEUE, { connectionId, capability: 'gbp_reviews' })
    if (jobId === null) throw new Error('the refresh probe job was not enqueued')
    const fetched = await boss.fetch<{ connectionId: string }>(QUEUE)
    const received = fetched?.[0]
    if (received === undefined) throw new Error('the refresh probe job was not fetchable')

    const outcome = await withGoogle(deps, 'gbp_reviews', async () =>
      profile.listReviews(RESOURCE.location),
    )
    expect(outcome.kind).toBe('ok')
    // A full cycle, including the rotation — the branch that handles a token Google replaced is the one
    // most likely to put the new value somewhere it does not belong.
    expect(refreshCount(log)).toBe(1)
    await boss.complete(QUEUE, received.id, { connectionId, refreshed: true })

    // ALL rows, not this job's: the point is that no job anywhere carries it, and `beforeEach` only
    // clears this file's queue.
    expect(await jobPayloadHits(REFRESH_TOKEN)).toBe(0)
  })

  it('and the control: the scan finds a token that really is in a payload', async () => {
    // Without this, "zero hits" is what a scan of the wrong column, the wrong schema or an empty table
    // reports — and zero is exactly what a passing test looks like. It is the same control the leak
    // detector in with-google.test.ts carries, for the same reason.
    const jobId = await boss.send(QUEUE, { leaked: REFRESH_TOKEN })
    if (jobId === null) throw new Error('the control job was not enqueued')
    expect(await jobPayloadHits(REFRESH_TOKEN)).toBe(1)
    await sql`delete from pgboss.job where id = ${jobId}::uuid`
    expect(await jobPayloadHits(REFRESH_TOKEN)).toBe(0)
  })
})
