import { generateKek } from '@berelax/clinical'
import { fixedClock, instantFromIso } from '@berelax/core'
import { type CallLog, createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import { createFakeGoogleOAuth } from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type DisconnectActor,
  type DisconnectDeps,
  disconnectGoogleConnection,
  retryPendingRevocations,
} from './disconnect.ts'
import { accessTokenFor } from './lifecycle.ts'
import { connectionRecord, createMemoryConnectionStore } from './memory-store.ts'
import { connectionBinding, sealToken } from './token-store.ts'

/**
 * G-CONN-09 — the ordering, and what each half-failure leaves behind.
 *
 * The claims here are about **sequence and conditionality**, so they are exercised against the memory
 * store and the fake rather than a database: the interesting cases are a revocation that Google never
 * answered and a retry announcement that threw, and both are cheap to produce here and awkward to produce
 * against PostgreSQL. What needs a real database — that the erasure and its events commit together, and
 * that the erased bytes are gone from every encoding of the column — is `google-disconnect.itest.ts`.
 *
 * The fake earns its place in two specific ways. It answers a **second** revocation of the same token with
 * `already_revoked`, the way Google's 400 `invalid_token` does, so the repeatability the retry depends on
 * is observed rather than assumed. And it throws `invalid_grant` on a refresh of a revoked token, so *"the
 * grant really is dead afterwards"* is a thing a test can watch — a fake that went on refreshing a revoked
 * token would let a disconnect that never called revoke pass every assertion below.
 */

const KEK = generateKek('v1')
const NOW_ISO = '2026-09-19T09:00:00.000Z'
const NOW = instantFromIso(NOW_ISO)
const CONSENT_AT = instantFromIso('2026-09-12T09:00:00.000Z')
const CONNECTION_ID = '01920000-0000-7000-8000-0000000000d1'
const SUB = '104729518362094771533'
const REFRESH_TOKEN = '1//09-departing-agency-refresh'

/** A role, not a person. The brief's rule 10, and what the audit row has to carry. */
const ACTOR: DisconnectActor = { kind: 'staff', label: 'owner@berelax.ae' }

const binding = connectionBinding({ connectionId: CONNECTION_ID, googleSub: SUB })

function seed(overrides: Partial<Parameters<typeof connectionRecord>[0]> = {}) {
  return connectionRecord({
    id: CONNECTION_ID,
    googleSub: SUB,
    refreshToken: sealToken(KEK, binding, REFRESH_TOKEN),
    consentAt: CONSENT_AT,
    ...overrides,
  })
}

/** How many times the fake's revocation endpoint was called. The acceptance says exactly once. */
const revokeCalls = (log: CallLog): number =>
  log.all().filter((call) => call.operation === 'revoke').length

let failures: FailureScript
let log: CallLog
let store: ReturnType<typeof createMemoryConnectionStore>
let queued: string[]
let deps: DisconnectDeps

function rig(
  overrides: Partial<DisconnectDeps> = {},
  seedOverrides: Partial<Parameters<typeof connectionRecord>[0]> = {},
): DisconnectDeps {
  store = createMemoryConnectionStore([seed(seedOverrides)])
  return {
    store,
    oauth: createFakeGoogleOAuth({ log, failures, now: () => NOW_ISO, sub: SUB }),
    kek: KEK,
    clock: fixedClock(NOW_ISO),
    enqueueRevokeRetry: async (connectionId) => {
      queued.push(connectionId)
    },
    ...overrides,
  }
}

beforeEach(() => {
  failures = new FailureScript()
  log = createCallLog(() => NOW_ISO)
  queued = []
  deps = rig()
})

describe('a disconnect Google confirmed', () => {
  it('calls revoke exactly once and then zeroises the row', async () => {
    const outcome = await disconnectGoogleConnection(deps, {
      connectionId: CONNECTION_ID,
      actor: ACTOR,
    })

    expect(revokeCalls(log)).toBe(1)
    expect(outcome.kind).toBe('revoked')
    expect(outcome.zeroised).toBe(true)

    const [record] = store.records()
    expect(record?.status).toBe('disconnected')
    expect(record?.statusReason).toBe('manual')
    // The whole point of the unit: the credential is gone, not merely overwritten with another ciphertext.
    expect(record?.refreshToken).toBeNull()
    expect(record?.accessToken).toBeNull()
    expect(record?.accessExpiresAt).toBeNull()
    expect(record?.lastCheckedAt).toBe(NOW)
  })

  it('erases the CACHED access token too, even though it would have expired anyway', async () => {
    // An hour of full authority over the listing, on a connection an operator has been told is
    // disconnected. "It expires soon" is not a reason to keep a live bearer credential.
    await accessTokenFor(
      { store, oauth: deps.oauth, kek: deps.kek, clock: deps.clock },
      CONNECTION_ID,
    )
    expect(store.records()[0]?.accessToken).not.toBeNull()

    await disconnectGoogleConnection(deps, { connectionId: CONNECTION_ID, actor: ACTOR })
    expect(store.records()[0]?.accessToken).toBeNull()
  })

  it('writes a revoked event and a disconnected event, both naming the actor', async () => {
    await disconnectGoogleConnection(deps, { connectionId: CONNECTION_ID, actor: ACTOR })
    const events = store.events()
    expect(events.map((e) => e.event)).toEqual(['revoked', 'disconnected'])
    for (const event of events) {
      expect(event.actorKind).toBe('staff')
      expect(event.actorLabel).toBe('owner@berelax.ae')
      expect(event.connectionId).toBe(CONNECTION_ID)
      expect(event.googleSub).toBe(SUB)
    }
    expect(events[1]?.detail).toMatchObject({
      revokeVerdict: 'revoked',
      statusReason: 'manual',
      zeroised: true,
    })
  })

  it('no event payload carries a token', async () => {
    // The memory store refuses the keys migration 0016's CHECK refuses, so this asserts the same rule the
    // database does. Asserted here as well as there because the disconnect's detail is assembled from a
    // verdict, and a verdict is the kind of value somebody would be tempted to widen "for debugging".
    await disconnectGoogleConnection(deps, { connectionId: CONNECTION_ID, actor: ACTOR })
    const serialised = JSON.stringify(store.events())
    expect(serialised).not.toContain(REFRESH_TOKEN)
    expect(serialised).not.toContain('fake-access-')
  })

  it('leaves the grant genuinely dead: a later refresh gets invalid_grant', async () => {
    // Against the fake, which tracks what it has revoked. This is what distinguishes "we called revoke"
    // from "we deleted our copy": a disconnect that skipped the revocation would leave a refreshable grant.
    await disconnectGoogleConnection(deps, { connectionId: CONNECTION_ID, actor: ACTOR })
    await expect(deps.oauth.refresh(REFRESH_TOKEN)).rejects.toThrow(/invalid_grant/)
  })

  it('announces no retry, because there is nothing to retry', async () => {
    const outcome = await disconnectGoogleConnection(deps, {
      connectionId: CONNECTION_ID,
      actor: ACTOR,
    })
    expect(outcome.retryAnnouncement).toBe('not_needed')
    expect(queued).toEqual([])
  })
})

describe('half-failure one: the revocation is unconfirmed', () => {
  beforeEach(() => {
    // A 500 from the revocation endpoint. The grant may be perfectly alive.
    failures.failAlways('server_error')
  })

  it('still marks the row disconnected, with revoke_failed', async () => {
    const outcome = await disconnectGoogleConnection(deps, {
      connectionId: CONNECTION_ID,
      actor: ACTOR,
    })
    expect(outcome.kind).toBe('revoke_failed')
    const [record] = store.records()
    // The status moves because the operator asked. Leaving it `active` would keep every consumer
    // resolving a connection somebody has just offboarded.
    expect(record?.status).toBe('disconnected')
    expect(record?.statusReason).toBe('revoke_failed')
  })

  it('RETAINS the ciphertext — it is the only credential that can still kill the grant', async () => {
    // The assertion the whole ordering exists for. Erasing here is the unrecoverable half-failure: a live
    // grant with `business.manage` on the listing and nothing in this system able to revoke it.
    const outcome = await disconnectGoogleConnection(deps, {
      connectionId: CONNECTION_ID,
      actor: ACTOR,
    })
    expect(outcome.zeroised).toBe(false)
    expect(store.records()[0]?.refreshToken).not.toBeNull()
  })

  it('still erases the cached access token', async () => {
    // Asymmetric on purpose. The refresh token is kept because it is the retry's credential; the access
    // token is not a credential the retry needs, and it is an hour of live authority.
    await disconnectGoogleConnection(deps, { connectionId: CONNECTION_ID, actor: ACTOR })
    expect(store.records()[0]?.accessToken).toBeNull()
  })

  it('writes the disconnected event but NOT a revoked event', async () => {
    // We did not revoke it. A `revoked` row here would put our name on an act that did not happen, which
    // is the one thing an offboarding audit is trying to establish.
    await disconnectGoogleConnection(deps, { connectionId: CONNECTION_ID, actor: ACTOR })
    expect(store.events().map((e) => e.event)).toEqual(['disconnected'])
    expect(store.events()[0]?.detail).toMatchObject({
      revokeVerdict: 'unconfirmed',
      failureMode: 'server_error',
      statusReason: 'revoke_failed',
      zeroised: false,
    })
  })

  it('enqueues the retry, with the connection id and nothing else', async () => {
    const outcome = await disconnectGoogleConnection(deps, {
      connectionId: CONNECTION_ID,
      actor: ACTOR,
    })
    expect(outcome.retryAnnouncement).toBe('queued')
    expect(queued).toEqual([CONNECTION_ID])
  })

  it('the retry eventually succeeds and clears the reason', async () => {
    await disconnectGoogleConnection(deps, { connectionId: CONNECTION_ID, actor: ACTOR })
    expect(store.records()[0]?.statusReason).toBe('revoke_failed')

    // Google comes back. The sweep finds the row by its reason rather than by a job payload.
    failures.clear()
    const report = await retryPendingRevocations(deps, { kind: 'system', label: 'revoke-retry' })

    expect(report).toEqual({ attempted: 1, revoked: 1, stillUnconfirmed: 0, unconfirmed: [] })
    const [record] = store.records()
    expect(record?.statusReason).toBe('manual')
    expect(record?.refreshToken).toBeNull()
    expect(record?.status).toBe('disconnected')
    // Two revocations in total: the failed one and the one that worked.
    expect(revokeCalls(log)).toBe(2)
    // And the append-only log now holds the whole story, in order.
    expect(store.events().map((e) => e.event)).toEqual(['disconnected', 'revoked', 'disconnected'])
  })

  it('a sweep that still fails reports the connection and leaves the credential in place', async () => {
    await disconnectGoogleConnection(deps, { connectionId: CONNECTION_ID, actor: ACTOR })
    const report = await retryPendingRevocations(deps, { kind: 'system', label: 'revoke-retry' })
    expect(report.stillUnconfirmed).toBe(1)
    expect(report.unconfirmed).toEqual([CONNECTION_ID])
    expect(store.records()[0]?.refreshToken).not.toBeNull()
  })

  it('the sweep does not enqueue another retry per failing row', async () => {
    // A retry that announced a retry would fan one job into one per pass per connection.
    await disconnectGoogleConnection(deps, { connectionId: CONNECTION_ID, actor: ACTOR })
    queued = []
    await retryPendingRevocations(deps, { kind: 'system', label: 'revoke-retry' })
    expect(queued).toEqual([])
  })

  it('the control: with no failure armed the row is zeroised, so the retention is conditional', async () => {
    // Without this, "retains the ciphertext" would be satisfied by a disconnect that never erases anything.
    failures.clear()
    await disconnectGoogleConnection(deps, { connectionId: CONNECTION_ID, actor: ACTOR })
    expect(store.records()[0]?.refreshToken).toBeNull()
  })
})

describe('a failure AFTER the write cannot roll the write back', () => {
  /**
   * G-CONN-06's defect, in this unit's shape.
   *
   * There, `accessTokenUnderLock` let a refresh failure propagate out of `sql.begin`, and the rollback
   * destroyed the very rows that recorded a dead grant. Here the rows are worse than evidence: they are the
   * only record that a credential existed and was destroyed. So the announcement happens after the write
   * and is not allowed to throw through it — and the difference between a comment saying so and a code path
   * is this test.
   */
  it('an enqueue that throws leaves the row and the events exactly as committed', async () => {
    failures.failAlways('server_error')
    const broken = rig({
      enqueueRevokeRetry: async () => {
        throw new AppError('provider_unavailable', 'pg-boss is unreachable')
      },
    })

    const outcome = await disconnectGoogleConnection(broken, {
      connectionId: CONNECTION_ID,
      actor: ACTOR,
    })

    // Not a thrown error: the disconnect succeeded and only the promptness of the retry was lost. An
    // operator told "the disconnect failed" about a connection that is already disconnected would try
    // again, and the second attempt is the one that gets the ordering wrong under time pressure.
    expect(outcome.kind).toBe('revoke_failed')
    expect(outcome.retryAnnouncement).toBe('failed')
    expect(store.records()[0]?.status).toBe('disconnected')
    expect(store.records()[0]?.statusReason).toBe('revoke_failed')
    expect(store.events().map((e) => e.event)).toEqual(['disconnected'])
    // And the work is not lost: the ROW is the queue.
    expect(await store.pendingRevocations()).toHaveLength(1)
  })

  it('a disconnect with no enqueue wired at all still completes and is still sweepable', async () => {
    failures.failAlways('server_error')
    // Built by hand rather than via `rig`: with `exactOptionalPropertyTypes`, passing
    // `enqueueRevokeRetry: undefined` is a type error, and that is the compiler making the same point the
    // `not_wired` outcome makes — *absent* and *present but undefined* are different claims.
    const base = rig()
    const unwired: DisconnectDeps = {
      store: base.store,
      oauth: base.oauth,
      kek: base.kek,
      clock: base.clock,
    }
    const outcome = await disconnectGoogleConnection(unwired, {
      connectionId: CONNECTION_ID,
      actor: ACTOR,
    })
    // `not_wired` rather than `failed`: it is what the sweep itself passes down, and conflating the two
    // would make a deliberate wiring read as an error in every line the sweep writes.
    expect(outcome.retryAnnouncement).toBe('not_wired')
    expect(await store.pendingRevocations()).toHaveLength(1)
  })
})

describe('half-failure two: the grant was already dead', () => {
  it('reads invalid_grant from the revocation endpoint as already_dead and erases', async () => {
    // The recovery path for "we revoked it and then the write failed": re-running the disconnect finds a
    // credential Google no longer recognises, which is nothing left to protect.
    failures.failAlways('invalid_grant')
    const outcome = await disconnectGoogleConnection(deps, {
      connectionId: CONNECTION_ID,
      actor: ACTOR,
    })
    expect(outcome.kind).toBe('already_dead')
    expect(outcome.zeroised).toBe(true)
    expect(store.records()[0]?.refreshToken).toBeNull()
    expect(store.records()[0]?.statusReason).toBe('manual')
    // No `revoked` event: somebody else got there first, and claiming it would be a false record.
    expect(store.events().map((e) => e.event)).toEqual(['disconnected'])
    expect(store.events()[0]?.detail).toMatchObject({ revokeVerdict: 'already_dead' })
  })

  it('disconnects a connection whose grant already looks dead to us', async () => {
    // `needs_reauth`, which `withGoogle` and `loadActiveConnection` both refuse. The disconnect must work
    // on exactly the connections they refuse, which is why it does not go through the chokepoint.
    const dead = rig({}, { status: 'needs_reauth', statusReason: 'invalid_grant' })
    const outcome = await disconnectGoogleConnection(dead, {
      connectionId: CONNECTION_ID,
      actor: ACTOR,
    })
    expect(outcome.kind).toBe('revoked')
    expect(revokeCalls(log)).toBe(1)
    expect(store.records()[0]?.refreshToken).toBeNull()
  })
})

describe('idempotence', () => {
  it('a second disconnect makes no request and appends no event', async () => {
    await disconnectGoogleConnection(deps, { connectionId: CONNECTION_ID, actor: ACTOR })
    const eventsAfterFirst = store.events().length

    const second = await disconnectGoogleConnection(deps, {
      connectionId: CONNECTION_ID,
      actor: ACTOR,
    })

    expect(second.kind).toBe('already_disconnected')
    expect(second.zeroised).toBe(true)
    expect(second.verdict).toBeNull()
    expect(revokeCalls(log)).toBe(1)
    // A second `disconnected` row would make an append-only log say the connection was disconnected
    // twice, and an append-only log is the one thing that cannot be corrected afterwards.
    expect(store.events()).toHaveLength(eventsAfterFirst)
  })

  it('refuses a connection that does not exist, rather than reporting success', async () => {
    await expect(
      disconnectGoogleConnection(deps, { connectionId: 'no-such-connection', actor: ACTOR }),
    ).rejects.toThrow(/No Google connection/)
    expect(revokeCalls(log)).toBe(0)
  })
})

describe('a refresh racing a disconnect cannot re-cache a token', () => {
  it('recordRefresh refuses a disconnected row', async () => {
    // The guard the SQL carries as `and status <> 'disconnected'`, reproduced by the memory store. Without
    // it, a refresh that was already in flight commits a fresh access token onto a row whose credentials
    // were just erased on purpose — an hour of live authority on a connection an operator was told was
    // disconnected.
    await disconnectGoogleConnection(deps, { connectionId: CONNECTION_ID, actor: ACTOR })
    await expect(
      store.recordRefresh({
        connectionId: CONNECTION_ID,
        accessToken: sealToken(KEK, binding, 'fake-access-late'),
        accessExpiresAt: NOW,
        lastOkAt: NOW,
        status: 'active',
        statusReason: null,
      }),
    ).rejects.toThrow(/disconnected while this refresh was in flight/)
    expect(store.records()[0]?.accessToken).toBeNull()
    expect(store.records()[0]?.status).toBe('disconnected')
  })

  it('the control: the same write succeeds on a connection that is still active', async () => {
    await store.recordRefresh({
      connectionId: CONNECTION_ID,
      accessToken: sealToken(KEK, binding, 'fake-access-ok'),
      accessExpiresAt: NOW,
      lastOkAt: NOW,
      status: 'active',
      statusReason: null,
    })
    expect(store.records()[0]?.accessToken).not.toBeNull()
  })
})

describe('the sweep', () => {
  it('finds nothing on a healthy estate, and that is a pass rather than a silence', async () => {
    const report = await retryPendingRevocations(deps, { kind: 'system', label: 'revoke-retry' })
    expect(report).toEqual({ attempted: 0, revoked: 0, stillUnconfirmed: 0, unconfirmed: [] })
    expect(revokeCalls(log)).toBe(0)
  })

  it('never returns a row with no credential, because the retry would have nothing to send', async () => {
    // The predicate `google_connections_revoke_retry_keeps_its_token` guarantees in the database,
    // reproduced by the fake. A zeroised row appearing here would be a retry that can never succeed.
    await disconnectGoogleConnection(deps, { connectionId: CONNECTION_ID, actor: ACTOR })
    expect(await store.pendingRevocations()).toEqual([])
  })
})
