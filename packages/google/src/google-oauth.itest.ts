import { generateKek } from '@berelax/clinical'
import {
  fixedClock,
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
} from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import { createFakeGoogleOAuth, type GoogleOAuthProvider } from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { GoogleConsentStore } from './connection-store.ts'
import { assertRefreshTokenStored } from './lifecycle.ts'
import { buildAuthorizationRequest, type PendingConsent } from './oauth/consent.ts'
import { type ConsentCallback, type ConsentGrant, exchangeConsentCode } from './oauth/exchange.ts'
import { applyConsent, completeGoogleConsent } from './oauth/reconnect.ts'
import { createPostgresConnectionStore } from './postgres-store.ts'
import { connectionBinding, openToken } from './token-store.ts'

/**
 * G-CONN-02 — the claims that are only true against a real PostgreSQL.
 *
 * Three of this unit's acceptance lines are claims about **columns and transactions**, and none of them
 * can be checked against a double:
 *
 *   1. A second Google account leaves the first row *byte-identical*. That is a statement about stored
 *      bytes, including a ciphertext, read back through the driver.
 *   2. A fault between the token write and the capability write rolls back both. That is a statement
 *      about one transaction, so the fault has to be injected inside the transaction the production path
 *      opens — a failure thrown around two separate transactions would leave the first committed and the
 *      test would pass while proving the opposite.
 *   3. A replayed authorization code is recognised by a `detail->>` lookup against the append-only
 *      event log, which is the durable half of replay rejection.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const KEK = generateKek('v1')
const NOW_ISO = '2026-09-18T10:00:00.000Z'
const LATER_ISO = '2026-09-19T09:00:00.000Z'
const OWNER = { sub: 'sub-owner-0001', email: 'google-admin@berelax.ae' }
/** A second, differently-verified account: docs/10 §5's ordinary case, not an edge one. */
const AGENCY = { sub: 'sub-agency-0002', email: 'webmaster@example.com' }
const PLACE_ID = 'ChIJ-fixture-place-id'
const GSC_ONLY = ['openid', 'email', GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY]

let sql: Sql

beforeAll(() => {
  sql = createConnection({ url, max: 2 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  // Capabilities cascade. `google_connection_events` deliberately does not, and a DELETE against it
  // raises — so every assertion about it below is a delta, never a total (ADR 0008).
  await sql`delete from google_connections`
})

function oauthFor(
  account: { sub: string; email: string },
  grantedScopes?: readonly string[],
): GoogleOAuthProvider {
  return createFakeGoogleOAuth({
    log: createCallLog(() => NOW_ISO),
    failures: new FailureScript(),
    now: () => NOW_ISO,
    sub: account.sub,
    email: account.email,
    ...(grantedScopes === undefined ? {} : { grantedScopes }),
  })
}

/** Walks the fake consent screen; `dev_code` is the code its stand-in consent page would hand back. */
function walk(
  oauth: GoogleOAuthProvider,
  at: string,
  reconnectingConnectionId: string | null = null,
): { pending: PendingConsent; callback: ConsentCallback } {
  const request = buildAuthorizationRequest(
    { oauth, clock: fixedClock(at) },
    { reconnectingConnectionId },
  )
  const params = new URLSearchParams(request.url.slice(request.url.indexOf('?') + 1))
  const code = params.get('dev_code')
  if (code === null) throw new Error('the fake consent screen minted no code')
  return { pending: request.pending, callback: { code, state: request.pending.state } }
}

async function connect(args: {
  readonly account: { sub: string; email: string }
  readonly at?: string
  readonly grantedScopes?: readonly string[]
  readonly reconnecting?: string | null
  readonly consentStoreFor?: (tx: Sql) => GoogleConsentStore
}) {
  const at = args.at ?? NOW_ISO
  const oauth = oauthFor(args.account, args.grantedScopes)
  const { pending, callback } = walk(oauth, at, args.reconnecting ?? null)
  return completeGoogleConsent(
    {
      oauth,
      clock: fixedClock(at),
      kek: () => KEK,
      sql,
      ...(args.consentStoreFor === undefined ? {} : { consentStoreFor: args.consentStoreFor }),
    },
    pending,
    callback,
  )
}

/** Every column of a connection row, as the driver returns it. */
async function rawRow(id: string): Promise<Record<string, unknown>> {
  const rows = await sql<Record<string, unknown>[]>`
    select * from google_connections where id = ${id}
  `
  const row = rows[0]
  if (row === undefined) throw new Error(`no row ${id}`)
  return row
}

async function rawCapabilities(id: string): Promise<Record<string, unknown>[]> {
  return sql<Record<string, unknown>[]>`
    select * from google_capabilities where connection_id = ${id} order by capability, id
  `
}

const eventCount = async (id: string): Promise<number> => {
  const rows = await sql<{ n: string }[]>`
    select count(*)::text as n from google_connection_events where connection_id = ${id}
  `
  return Number(rows[0]?.n ?? 0)
}

describe('the first consent, against the real columns', () => {
  it('writes one row whose granted_scopes are Google’s answer and whose token is unreadable', async () => {
    const outcome = await connect({ account: OWNER })
    expect(outcome.kind).toBe('connected')

    const row = await rawRow(outcome.connectionId)
    expect(row['google_sub']).toBe(OWNER.sub)
    expect(row['google_email']).toBe(OWNER.email)
    expect(row['granted_scopes']).toEqual([
      'openid',
      'email',
      GOOGLE_SCOPE_BUSINESS_MANAGE,
      GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
    ])
    expect(row['status']).toBe('active')
    expect(row['consent_at']).toEqual(new Date(NOW_ISO))

    // The refresh token round-trips through bytea and is not greppable in any encoding.
    const record = await createPostgresConnectionStore(sql).load(outcome.connectionId)
    if (record === null) throw new Error('no record')
    const plaintext = openToken(
      KEK,
      connectionBinding({ connectionId: record.id, googleSub: record.googleSub }),
      assertRefreshTokenStored(record),
    )
    expect(plaintext).toMatch(/^fake-refresh-/)
    const ct = row['refresh_token_ct'] as Buffer
    expect(ct.toString('utf8')).not.toContain(plaintext)
    expect(ct.toString('latin1')).not.toContain(plaintext)
    // The control: the same assertion against the plaintext bytes must fail.
    expect(Buffer.from(plaintext, 'utf8').toString('latin1')).toContain(plaintext)
  })

  it('creates a capability row per capability and mirrors the event into audit_event', async () => {
    const [before] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'google_connection.connected'
    `
    const outcome = await connect({ account: OWNER })
    const capabilities = await rawCapabilities(outcome.connectionId)
    expect(capabilities.map((c) => c['capability'])).toEqual([
      'gbp_location',
      'gbp_performance',
      'gbp_reviews',
      'gsc',
    ])
    expect(capabilities.every((c) => c['is_primary'] === true)).toBe(true)
    expect(capabilities.every((c) => c['health'] === 'unknown')).toBe(true)

    const [after] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'google_connection.connected'
    `
    // A delta, because audit_event is append-only and shared with every other unit.
    expect(Number(after?.n ?? 0) - Number(before?.n ?? 0)).toBe(1)
  })

  it('stores only what a partial consent granted and marks the rest permission_missing', async () => {
    const outcome = await connect({ account: OWNER, grantedScopes: GSC_ONLY })
    const row = await rawRow(outcome.connectionId)
    expect(row['granted_scopes']).toEqual(GSC_ONLY)
    // The control: the request asked for business.manage, so a flow storing the REQUEST would have it.
    expect(row['granted_scopes']).not.toContain(GOOGLE_SCOPE_BUSINESS_MANAGE)

    const health = new Map(
      (await rawCapabilities(outcome.connectionId)).map((c) => [c['capability'], c['health']]),
    )
    expect(health.get('gbp_reviews')).toBe('permission_missing')
    expect(health.get('gsc')).toBe('unknown')
    // Usable for Search Console: the grant is active, not needs_reauth.
    expect(row['status']).toBe('active')
  })
})

describe('reconnect with a matching google_sub', () => {
  it('keeps the row id and the resource_ref placeId, and replaces the token', async () => {
    const first = await connect({ account: OWNER })
    // What a later unit does when the owner picks their listing. Done in SQL because choosing a resource
    // is not this unit's work — only preserving it is.
    await sql`
      update google_capabilities set resource_ref = ${sql.json({ placeId: PLACE_ID }) as never}
      where connection_id = ${first.connectionId} and capability = 'gbp_reviews'
    `
    const tokenBefore = (await rawRow(first.connectionId))['refresh_token_ct'] as Buffer
    const eventsBefore = await eventCount(first.connectionId)

    const second = await connect({ account: OWNER, at: LATER_ISO })
    expect(second.kind).toBe('reconnected')
    expect(second.connectionId).toBe(first.connectionId)

    const rows = await sql<{ n: string }[]>`select count(*)::text as n from google_connections`
    expect(rows[0]?.n).toBe('1')

    const after = await rawRow(first.connectionId)
    expect((after['refresh_token_ct'] as Buffer).equals(tokenBefore)).toBe(false)
    expect(after['consent_at']).toEqual(new Date(LATER_ISO))
    // The cached access token is cleared: it carries the OLD scope set for up to another hour.
    expect(after['access_token_ct']).toBeNull()
    expect(after['access_expires_at']).toBeNull()

    const capabilities = await rawCapabilities(first.connectionId)
    expect(capabilities).toHaveLength(4)
    expect(capabilities.find((c) => c['capability'] === 'gbp_reviews')?.['resource_ref']).toEqual({
      placeId: PLACE_ID,
    })
    expect(await eventCount(first.connectionId)).toBe(eventsBefore + 1)
  })
})

describe('reconnect with a different google_sub', () => {
  it('adds a row, warns naming both accounts, and leaves the first row byte-identical', async () => {
    const first = await connect({ account: OWNER })
    const before = await rawRow(first.connectionId)
    const capabilitiesBefore = await rawCapabilities(first.connectionId)
    const eventsBefore = await eventCount(first.connectionId)

    const second = await connect({
      account: AGENCY,
      at: LATER_ISO,
      reconnecting: first.connectionId,
    })
    expect(second.kind).toBe('additional_account')
    expect(second.connectionId).not.toBe(first.connectionId)
    expect(second.warning?.existingEmail).toBe(OWNER.email)
    expect(second.warning?.newEmail).toBe(AGENCY.email)
    expect(second.warning?.message).toContain(OWNER.email)
    expect(second.warning?.message).toContain(AGENCY.email)

    // Field by field over every column the table has, read back from PostgreSQL. Comparing two object
    // references — or a spread of one against itself — would pass for a row that had been rewritten.
    const after = await rawRow(first.connectionId)
    const columns = Object.keys(before)
    expect(columns.length).toBeGreaterThan(20)
    expect(columns).toContain('refresh_token_ct')
    expect(columns).toContain('status')
    expect(columns).toContain('updated_at')
    for (const column of columns) {
      expect(after[column], `${column} changed on the original row`).toEqual(before[column])
    }
    expect(await rawCapabilities(first.connectionId)).toEqual(capabilitiesBefore)
    expect(await eventCount(first.connectionId)).toBe(eventsBefore)
  })

  it('binds each row’s ciphertext to its own sub, which is why the comparison above is meaningful', async () => {
    const first = await connect({ account: OWNER })
    const second = await connect({ account: AGENCY, at: LATER_ISO })

    const store = createPostgresConnectionStore(sql)
    const one = await store.load(first.connectionId)
    const two = await store.load(second.connectionId)
    if (one === null || two === null) throw new Error('missing rows')

    const oneToken = assertRefreshTokenStored(one)
    const twoToken = assertRefreshTokenStored(two)
    expect(oneToken.ct.equals(twoToken.ct)).toBe(false)
    expect(oneToken.aadFingerprint).not.toBe(twoToken.aadFingerprint)
    // The AAD is {table, recordId, google_sub}: the second row's ciphertext cannot be opened with the
    // first row's binding. Without that, an attacker with UPDATE could transplant a token between
    // connections and it would decrypt cleanly — which is a reply posted to another business's listing.
    expect(() =>
      openToken(
        KEK,
        connectionBinding({ connectionId: one.id, googleSub: one.googleSub }),
        twoToken,
      ),
    ).toThrow()
  })
})

describe('a fault between the token write and the capability write', () => {
  /**
   * A store that fails on the capability write and on nothing else.
   *
   * It is handed to `completeGoogleConsent` through `consentStoreFor`, so it is constructed **inside**
   * the `sql.begin` the production path opens. That is the whole point: a failure injected around the
   * transaction would leave the token write committed, and this test would pass while demonstrating the
   * opposite of what it claims.
   */
  const failingOnCapabilityWrite = (tx: Sql): GoogleConsentStore => ({
    ...createPostgresConnectionStore(tx),
    async updateCapabilityHealth() {
      throw new AppError(
        'invariant_violated',
        'injected fault between the token write and the capability write',
      )
    },
  })

  it('rolls back both, leaving the pre-existing token ciphertext unchanged', async () => {
    const first = await connect({ account: OWNER })
    const before = await rawRow(first.connectionId)
    const capabilitiesBefore = await rawCapabilities(first.connectionId)
    const eventsBefore = await eventCount(first.connectionId)

    // A re-consent that narrows the scopes, so there is genuinely a capability write to fail on.
    await expect(
      connect({
        account: OWNER,
        at: LATER_ISO,
        grantedScopes: GSC_ONLY,
        consentStoreFor: failingOnCapabilityWrite,
      }),
    ).rejects.toThrow(/injected fault/)

    const after = await rawRow(first.connectionId)
    // The token write happened first and inside the same transaction, so it must be gone.
    expect((after['refresh_token_ct'] as Buffer).equals(before['refresh_token_ct'] as Buffer)).toBe(
      true,
    )
    expect(after['refresh_token_aad_fp']).toBe(before['refresh_token_aad_fp'])
    expect(after['granted_scopes']).toEqual(before['granted_scopes'])
    expect(after['consent_at']).toEqual(before['consent_at'])
    expect(after['updated_at']).toEqual(before['updated_at'])
    expect(await rawCapabilities(first.connectionId)).toEqual(capabilitiesBefore)
    // The event is written last, so its absence alone would not prove the rollback — but its presence
    // would disprove it.
    expect(await eventCount(first.connectionId)).toBe(eventsBefore)
  })

  it('and the same re-consent without the fault does change all of it', async () => {
    // The control. Without this, the assertions above would pass against a flow that writes nothing at
    // all on the reconnect path.
    const first = await connect({ account: OWNER })
    const before = await rawRow(first.connectionId)
    const eventsBefore = await eventCount(first.connectionId)

    await connect({ account: OWNER, at: LATER_ISO, grantedScopes: GSC_ONLY })

    const after = await rawRow(first.connectionId)
    expect((after['refresh_token_ct'] as Buffer).equals(before['refresh_token_ct'] as Buffer)).toBe(
      false,
    )
    expect(after['granted_scopes']).toEqual(GSC_ONLY)
    const health = new Map(
      (await rawCapabilities(first.connectionId)).map((c) => [c['capability'], c['health']]),
    )
    expect(health.get('gbp_reviews')).toBe('permission_missing')
    // `reconnected` plus `scopes_changed`, because the grant narrowed.
    expect(await eventCount(first.connectionId)).toBe(eventsBefore + 2)
  })
})

describe('a replayed authorization code, against the event log', () => {
  it('is recognised by its fingerprint and writes nothing the second time', async () => {
    const oauth = oauthFor(OWNER)
    const { pending, callback } = walk(oauth, NOW_ISO)
    const grant: ConsentGrant = await exchangeConsentCode(
      { oauth, clock: fixedClock(NOW_ISO) },
      pending,
      callback,
    )

    const first = await sql.begin(async (tx) =>
      applyConsent(
        createPostgresConnectionStore(tx as unknown as Sql),
        { kek: KEK, clock: fixedClock(NOW_ISO) },
        grant,
      ),
    )
    const connectionId = (first as unknown as { connectionId: string }).connectionId
    const eventsBefore = await eventCount(connectionId)

    // The same grant again — which is what a reloaded callback tab produces after a successful exchange.
    // The fake would refuse a second exchange, so this drives the durable check directly: the
    // `detail->>'authorizationCodeFingerprint'` lookup against the append-only log.
    await expect(
      sql.begin(async (tx) =>
        applyConsent(
          createPostgresConnectionStore(tx as unknown as Sql),
          { kek: KEK, clock: fixedClock(LATER_ISO) },
          grant,
        ),
      ),
    ).rejects.toThrow(/already been exchanged/)

    const rows = await sql<{ n: string }[]>`select count(*)::text as n from google_connections`
    expect(rows[0]?.n).toBe('1')
    expect(await eventCount(connectionId)).toBe(eventsBefore)

    // The control: a genuinely different consent for the same account is accepted, so the refusal keys
    // on the code and not on "this account has connected before".
    const again = await connect({ account: OWNER, at: LATER_ISO })
    expect(again.kind).toBe('reconnected')
    expect(again.connectionId).toBe(connectionId)
  })

  it('writes no row for a callback whose state does not match', async () => {
    // The other half of *"neither path writes a connection row"*, asserted against the table rather than
    // against the absence of a store: the refusal happens before the exchange, so nothing is created and
    // nothing at Google is consumed either.
    const oauth = oauthFor(OWNER)
    const { pending, callback } = walk(oauth, NOW_ISO)
    await expect(
      completeGoogleConsent({ oauth, clock: fixedClock(NOW_ISO), kek: () => KEK, sql }, pending, {
        ...callback,
        state: 'someone-elses-state',
      }),
    ).rejects.toThrow(/state does not match/)

    const rows = await sql<{ n: string }[]>`select count(*)::text as n from google_connections`
    expect(rows[0]?.n).toBe('0')

    // The control: the same callback with the right state does write one, so the zero above is the
    // refusal and not a flow that never writes anything.
    await completeGoogleConsent(
      { oauth, clock: fixedClock(NOW_ISO), kek: () => KEK, sql },
      pending,
      callback,
    )
    const after = await sql<{ n: string }[]>`select count(*)::text as n from google_connections`
    expect(after[0]?.n).toBe('1')
  })
})
