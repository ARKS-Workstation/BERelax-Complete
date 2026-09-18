import { generateKek } from '@berelax/clinical'
import { fixedClock, type Instant, instantFromIso } from '@berelax/core'
import { type CallLog, createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import { createFakeGoogleOAuth, GOOGLE_OAUTH } from '@berelax/providers/google'
import { isAppError } from '@berelax/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { connectionRecord, createMemoryConnectionStore } from './memory-store.ts'
import {
  accessTokenUnderLock,
  assertReadCommitted,
  createMemoryRefreshLock,
  type ProactiveRefreshDeps,
  REFRESH_LOCK_NAMESPACE,
  REFRESH_LOCK_WRONG_ISOLATION,
  type RefreshLockRunner,
} from './token-refresh.ts'
import { connectionBinding, sealToken } from './token-store.ts'

/**
 * G-CONN-04, the half that needs no database.
 *
 * What is provable here and what is not, because the split is the design rather than a convenience.
 *
 * Provable: that the double check exists and is consulted, that the fast path does not take the lock at
 * all, that a dead grant is refused before any lock is taken, and that the isolation guard rejects the
 * snapshot it has to reject. Each of those is a statement about the code's shape.
 *
 * Not provable here: that the lock is a real mutual exclusion between two operating-system processes, that
 * it is released by COMMIT, and that the re-read sees the winner's row. Those are statements about
 * PostgreSQL, and a memory lock asserting them would be asserting that the memory lock works —
 * `token-refresh.itest.ts` makes them against a real database with two real connections racing.
 */
const KEK = generateKek('v1')
const NOW_ISO = '2026-09-18T10:00:00.000Z'
const NOW = instantFromIso(NOW_ISO)
const CONNECTION_ID = '01920000-0000-7000-8000-00000000000c'
const SUB = '104729518362094771533'
const REFRESH_TOKEN = '1//09-owner-refresh-token-for-the-lock'

const binding = connectionBinding({ connectionId: CONNECTION_ID, googleSub: SUB })

type RecordArgs = Parameters<typeof connectionRecord>[0]

const seeded = (overrides: Partial<RecordArgs> = {}) =>
  connectionRecord({
    id: CONNECTION_ID,
    googleSub: SUB,
    refreshToken: sealToken(KEK, binding, REFRESH_TOKEN),
    consentAt: instantFromIso('2026-09-17T10:00:00.000Z'),
    ...overrides,
  })

const refreshCount = (log: CallLog): number =>
  log.forProvider(GOOGLE_OAUTH).filter((call) => call.operation === 'refresh').length

let log: CallLog
let store: ReturnType<typeof createMemoryConnectionStore>
let deps: ProactiveRefreshDeps
/** How many times a body ran inside the lock, so "the lock was not taken" is assertable. */
let locked: number

beforeEach(() => {
  log = createCallLog(() => NOW_ISO)
  store = createMemoryConnectionStore([seeded()])
  locked = 0
  const real = createMemoryRefreshLock(store)
  const counted: RefreshLockRunner = {
    withConnectionLock: (connectionId, body) =>
      real.withConnectionLock(connectionId, async (scope) => {
        locked += 1
        return body(scope)
      }),
  }
  deps = {
    store,
    lock: counted,
    oauth: createFakeGoogleOAuth({
      log,
      failures: new FailureScript(),
      now: () => NOW_ISO,
      sub: SUB,
    }),
    kek: KEK,
    clock: fixedClock(NOW_ISO),
  }
})

describe('the double check', () => {
  it('runs one refresh for several concurrent callers and hands every loser that token', async () => {
    const grants = await Promise.all(
      Array.from({ length: 5 }, () => accessTokenUnderLock(deps, CONNECTION_ID)),
    )

    expect(refreshCount(log)).toBe(1)
    // Exactly one caller did the work; the other four found a fresh token inside the lock. `refreshed`
    // is the flag that distinguishes the two, and it is what `withGoogle` logs.
    expect(grants.filter((grant) => grant.refreshed)).toHaveLength(1)
    expect(new Set(grants.map((grant) => grant.accessToken)).size).toBe(1)
    // One event, not five. The append-only log is what the connection panel renders.
    expect(store.events().map((event) => event.event)).toEqual(['refreshed'])
    expect(locked).toBe(5)
  })

  it('and the control: with a pass-through lock every caller refreshes', async () => {
    // The known-bad arrangement. Without it, the assertion above is also satisfied by five calls that
    // happened to be serialised by the event loop, and the double check could be absent entirely.
    const unlocked: ProactiveRefreshDeps = {
      ...deps,
      lock: { withConnectionLock: (_id, body) => body({ store }) },
    }
    await Promise.all(
      Array.from({ length: 5 }, () => accessTokenUnderLock(unlocked, CONNECTION_ID)),
    )
    expect(refreshCount(log)).toBe(5)
  })

  it('does not take the lock at all for a token outside the margin', async () => {
    store.put(
      seeded({
        accessToken: sealToken(KEK, binding, 'fake-access-plenty-of-life-left'),
        accessExpiresAt: (NOW + 3_600_000) as Instant,
      }),
    )
    const grant = await accessTokenUnderLock(deps, CONNECTION_ID)

    expect(grant.refreshed).toBe(false)
    expect(grant.accessToken).toBe('fake-access-plenty-of-life-left')
    expect(refreshCount(log)).toBe(0)
    // The whole reason the first check exists. A lock taken for a token with fifty minutes to live would
    // serialise every Google call in the system behind one row.
    expect(locked).toBe(0)
  })

  it('refuses a grant that is not active before taking the lock', async () => {
    // A `needs_reauth` connection has nothing to refresh, and taking a lock to discover that would let a
    // dead connection block a live one.
    store.put(seeded({ status: 'needs_reauth', statusReason: 'invalid_grant' }))
    await expect(accessTokenUnderLock(deps, CONNECTION_ID)).rejects.toThrow(/needs re-authorising/)
    expect(locked).toBe(0)
    expect(refreshCount(log)).toBe(0)
  })

  it('does not wedge later callers behind a failed refresh', async () => {
    // A rejected promise left on the chain would make the memory lock diverge from the real one, where a
    // failed transaction releases the lock and the next waiter proceeds. Then a unit test above this one
    // would fail for a reason that has nothing to do with its own subject.
    const failing = new FailureScript().failNext('server_error')
    const armed: ProactiveRefreshDeps = {
      ...deps,
      oauth: createFakeGoogleOAuth({ log, failures: failing, now: () => NOW_ISO, sub: SUB }),
    }
    await expect(accessTokenUnderLock(armed, CONNECTION_ID)).rejects.toThrow()
    const grant = await accessTokenUnderLock(armed, CONNECTION_ID)
    expect(grant.refreshed).toBe(true)
  })
})

describe('the isolation guard', () => {
  it('accepts READ COMMITTED, where every statement takes a fresh snapshot', () => {
    expect(() => assertReadCommitted('read committed')).not.toThrow()
  })

  it.each(['repeatable read', 'serializable', 'unknown'])('rejects %s by name', (isolation) => {
    // Under a snapshot taken before the lock was acquired the re-read returns the row as it was BEFORE
    // the winner committed, so the loser refreshes anyway — silently, and while looking correct. The
    // failure branch of a guard that has never run is not a guard (ADR 0003).
    const error = (() => {
      try {
        assertReadCommitted(isolation)
        return null
      } catch (thrown) {
        return thrown
      }
    })()
    if (!isAppError(error)) throw new Error('expected an AppError')
    expect(error.details['reason']).toBe(REFRESH_LOCK_WRONG_ISOLATION)
    expect(error.details['isolation']).toBe(isolation)
  })
})

describe('the lock key', () => {
  it('is namespaced, because the advisory key space is global to the database', () => {
    // A bare UUID hash shares one 64-bit key space with every other advisory lock anybody adds, and the
    // symptom of a collision is a refresh blocking on something with no relation to Google at all.
    expect(REFRESH_LOCK_NAMESPACE).toBe('google:')
  })
})
