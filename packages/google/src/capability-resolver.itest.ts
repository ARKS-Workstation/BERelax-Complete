import { generateKek } from '@berelax/clinical'
import { fixedClock, GOOGLE_CAPABILITIES, instantFromIso } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  AL_ZAHIYAH_LOCATION,
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  createFakeSearchConsole,
  GBP_LOCATION_GROUP_ACCOUNT,
} from '@berelax/providers/google'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  enumerateGbpChoices,
  type PickerDeps,
  reviewsPathFor,
  type SelectionActor,
  selectGbpLocation,
  selectSearchConsoleProperty,
} from './capability-resolver.ts'
import { createPostgresConnectionStore } from './postgres-store.ts'
import { createPostgresRefreshLock } from './token-refresh.ts'
import { connectionBinding, sealToken } from './token-store.ts'
import { type WithGoogleDeps, withGoogle } from './with-google.ts'

/**
 * G-CONN-05 — the two claims that need a real database.
 *
 * **The ordering fact.** Search Console is not gated behind the Business Profile application (docs/10 §2
 * and §9), so a connection whose every GBP capability is refused must still be able to select and verify a
 * `gsc` property and keep it. That is a claim about two rows in one table behaving independently, and a
 * memory store proves nothing about the `jsonb` column, the partial unique index the write addresses, or
 * the `verified_at` timestamp.
 *
 * **The gap this unit closes.** `completeGoogleConsent` registers `gbp_reviews` with `resourceRef: null`
 * and `withGoogle` degrades with `ResourceNotSelected` until a resource is chosen, so a healthy connection
 * does nothing at all. The test below walks that end to end through the PostgreSQL store and the real
 * advisory transaction lock: degraded before, `ok` with a resolved resource after.
 *
 * And criterion six is a claim about a **trigger**: the `capability_changed` row is mirrored into
 * `audit_event` inside the same transaction by migration 0016, which no fake reproduces. Asserted as a
 * delta on both tables, never a total — `audit_event` is append-only and shared with every other suite.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const KEK = generateKek('v1')
const NOW_ISO = '2026-09-18T10:00:00.000Z'
const SUB = 'sub-capability-resolver-0001'
const REFRESH_TOKEN = '1//09-itest-picker-refresh-token-never-in-a-row'
const ACTOR: SelectionActor = { kind: 'staff', label: 'settings picker (itest)' }
const DOMAIN_PROPERTY = 'sc-domain:berelaxmassage.com'
const PLACE_ID = AL_ZAHIYAH_LOCATION.metadata.placeId

let sql: Sql
let store: ReturnType<typeof createPostgresConnectionStore>

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  store = createPostgresConnectionStore(sql)
}, 120_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  /**
   * Nothing else in the database may serve these capabilities while this file runs.
   *
   * `withGoogle` resolves a connection from the capability and orders by id, so a completed consent left
   * behind by `google-oauth.itest.ts` — which sorts earlier in the sequential suite — would win every
   * resolution here and the assertions would be about a connection this file never created. The picker
   * calls below name their connection, which narrows the resolution; the bare `withGoogle` call in the
   * end-to-end test deliberately does not, because that is how a consumer calls it.
   *
   * Disconnecting rather than deleting, for the reason `with-google.itest.ts` records:
   * `google_reviews.connection_id` is `ON DELETE RESTRICT`, so a `delete from google_connections` fails the
   * moment a review-queue suite has left a review behind — a different false failure, not a fix.
   */
  await sql`update google_connections set status = 'disconnected' where google_sub <> ${SUB}`
  await sql`delete from google_connections where google_sub = ${SUB}`
})

/** A connection in exactly the state a completed consent leaves: four capabilities, no resource chosen. */
async function seedConsentedConnection(): Promise<string> {
  const id = await store.allocateId()
  await store.insert({
    id,
    googleSub: SUB,
    googleEmail: 'google-admin@berelax.ae',
    grantedScopes: [
      'https://www.googleapis.com/auth/business.manage',
      'https://www.googleapis.com/auth/webmasters.readonly',
    ],
    refreshToken: sealToken(
      KEK,
      connectionBinding({ connectionId: id, googleSub: SUB }),
      REFRESH_TOKEN,
    ),
    consentAt: instantFromIso('2026-09-17T10:00:00.000Z'),
  })
  for (const capability of GOOGLE_CAPABILITIES) {
    await store.upsertCapability({
      connectionId: id,
      capability,
      // The state this unit exists to change. G-CONN-02 writes null here because picking the resource is a
      // separate step, and this is that step.
      resourceRef: null,
      health: 'unknown',
      isPrimary: true,
    })
  }
  return id
}

interface Harness {
  readonly deps: PickerDeps
  readonly google: WithGoogleDeps
  readonly gbpFailures: FailureScript
  readonly gscFailures: FailureScript
}

function harness(): Harness {
  const providerLog = createCallLog(() => NOW_ISO)
  const gbpFailures = new FailureScript()
  const gscFailures = new FailureScript()
  const google: WithGoogleDeps = {
    store,
    // The real advisory transaction lock (G-CONN-04): every call below obtains a token through it.
    lock: createPostgresRefreshLock(sql),
    oauth: createFakeGoogleOAuth({
      log: providerLog,
      failures: new FailureScript(),
      now: () => NOW_ISO,
      sub: SUB,
    }),
    kek: KEK,
    clock: fixedClock(NOW_ISO),
    logger: { log: () => {} },
    newCorrelationId: () => 'corr-picker-itest',
  }
  return {
    google,
    gbpFailures,
    gscFailures,
    deps: {
      google,
      selections: store,
      profile: createFakeBusinessProfile({
        log: providerLog,
        failures: gbpFailures,
        now: () => NOW_ISO,
      }),
      searchConsole: createFakeSearchConsole({
        log: providerLog,
        failures: gscFailures,
        now: () => NOW_ISO,
      }),
    },
  }
}

async function storedRef(
  connectionId: string,
  capability: string,
): Promise<{ ref: Record<string, unknown> | null; verifiedAt: Date | null; health: string }> {
  const [row] = await sql<
    { resource_ref: Record<string, unknown> | null; verified_at: Date | null; health: string }[]
  >`
    select resource_ref, verified_at, health from google_capabilities
    where connection_id = ${connectionId} and capability = ${capability} and is_primary
  `
  return {
    ref: row?.resource_ref ?? null,
    verifiedAt: row?.verified_at ?? null,
    health: row?.health ?? 'missing',
  }
}

/** Both ledgers, counted in SQL: a capped reader would pin a delta at its own limit (the brief's rule 12). */
async function selectionRows(connectionId: string): Promise<{ events: number; audit: number }> {
  const [events] = await sql<{ n: string }[]>`
    select count(*)::text as n from google_connection_events
    where connection_id = ${connectionId} and event = 'capability_changed'
  `
  const [audit] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event
    where entity_type = 'google_connection' and entity_id = ${connectionId}
      and action = 'google_connection.capability_changed'
  `
  return { events: Number(events?.n ?? '0'), audit: Number(audit?.n ?? '0') }
}

describe('acceptance — withGoogle stops degrading once a location is picked', () => {
  it('degrades with ResourceNotSelected, then resolves the stored resource end to end', async () => {
    const connectionId = await seedConsentedConnection()
    const h = harness()

    const before = await withGoogle(h.google, 'gbp_reviews', async () => 'unreachable')
    expect(before.kind).toBe('degraded')
    if (before.kind !== 'degraded') throw new Error('unreachable')
    expect(before.cause).toBe('ResourceNotSelected')
    expect(before.connectionId).toBe(connectionId)

    const outcome = await selectGbpLocation(h.deps, {
      connectionId,
      placeId: PLACE_ID,
      actor: ACTOR,
    })
    expect([...outcome.capabilities].sort()).toEqual([
      'gbp_location',
      'gbp_performance',
      'gbp_reviews',
    ])

    // Read back through the store, not from the selection's return value: the claim is about the row.
    const stored = await storedRef(connectionId, 'gbp_reviews')
    expect(stored.ref).toEqual({
      account: GBP_LOCATION_GROUP_ACCOUNT.name,
      location: AL_ZAHIYAH_LOCATION.name,
      placeId: PLACE_ID,
    })
    // `verified_at` records that the listing was re-read from Google before anything was persisted. The
    // control is the seed above, where it is null — otherwise a column that is never written would satisfy
    // "it is a timestamp" for ever.
    expect(stored.verifiedAt).not.toBeNull()
    // And health is deliberately untouched: `ok` means every capability read succeeded and is G-CONN-06's
    // to write. A v1 location read says nothing about the legacy v4 reviews path.
    expect(stored.health).toBe('unknown')

    const after = await withGoogle(h.google, 'gbp_reviews', async (context) =>
      reviewsPathFor(context.resourceRef),
    )
    expect(after.kind).toBe('ok')
    if (after.kind !== 'ok') throw new Error('unreachable')
    expect(after.value).toBe(
      `${GBP_LOCATION_GROUP_ACCOUNT.name}/${AL_ZAHIYAH_LOCATION.name}/reviews`,
    )
    expect(after.connectionId).toBe(connectionId)
  })

  it('is idempotent: choosing the same listing again updates the same row rather than inserting one', async () => {
    // `google_capability_resource_unique` is NULLS NOT DISTINCT over (connection_id, capability,
    // resource_ref), so a selection that INSERTED would fail the second time — and an owner clicking the
    // same row twice is the most ordinary thing on this screen.
    const connectionId = await seedConsentedConnection()
    const h = harness()
    await selectGbpLocation(h.deps, { connectionId, placeId: PLACE_ID, actor: ACTOR })
    await selectGbpLocation(h.deps, { connectionId, placeId: PLACE_ID, actor: ACTOR })
    const [count] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_capabilities
      where connection_id = ${connectionId} and capability = 'gbp_reviews'
    `
    expect(Number(count?.n)).toBe(1)
  })
})

describe('acceptance — gsc is selected and verified on a connection whose GBP access is refused', () => {
  it('persists resource_ref.siteUrl while every Business Profile capability is access_not_granted', async () => {
    const connectionId = await seedConsentedConnection()
    const h = harness()
    // The launch-day state: a valid token, the two scopes granted, and Business Profile quota at 0 QPM
    // because Google has not approved the Basic API Access application yet (docs/10 §1).
    h.gbpFailures.failAlways('access_not_granted')

    const gbpView = await enumerateGbpChoices(h.deps, { connectionId })
    expect(gbpView.state).toBe('access_not_granted')
    expect(gbpView.choices).toEqual([])

    // And the Search Console side is untouched by that, because it is a different API on a different scope
    // with a different gate — which is the whole sequencing consequence in docs/10 §9.
    const selected = await selectSearchConsoleProperty(h.deps, {
      connectionId,
      siteUrl: DOMAIN_PROPERTY,
      actor: ACTOR,
    })
    expect(selected.resourceRef).toEqual({ siteUrl: DOMAIN_PROPERTY })

    const gsc = await storedRef(connectionId, 'gsc')
    expect(gsc.ref).toEqual({ siteUrl: DOMAIN_PROPERTY })
    expect(gsc.verifiedAt).not.toBeNull()

    // Every Business Profile capability is still unselected, and their health has moved to quota_zero from
    // the refused read — per capability, which is what makes "Connected, Business Profile access pending"
    // expressible at all.
    for (const capability of ['gbp_reviews', 'gbp_location', 'gbp_performance']) {
      const row = await storedRef(connectionId, capability)
      expect(row.ref, capability).toBeNull()
    }
    expect((await storedRef(connectionId, 'gbp_location')).health).toBe('quota_zero')
    expect(gsc.health).toBe('unknown')

    // The SEO agent works. That is the point of the ordering fact rather than a corollary of it.
    const seo = await withGoogle(h.google, 'gsc', async (context) => context.resourceRef)
    expect(seo.kind).toBe('ok')
    if (seo.kind !== 'ok') throw new Error('unreachable')
    expect(seo.value).toEqual({ siteUrl: DOMAIN_PROPERTY })

    // While the autoresponder still degrades, on the same connection, at the same moment.
    const reviews = await withGoogle(h.google, 'gbp_reviews', async () => 'unreachable')
    expect(reviews.kind).toBe('degraded')
    if (reviews.kind !== 'degraded') throw new Error('unreachable')
    expect(reviews.cause).toBe('ResourceNotSelected')
  })

  it('picking a listing does not pick a property, in the same database', async () => {
    // The control for the pair above: if a selection wrote both rows, the test above would pass for the
    // wrong reason and the SEO agent would be pointed at a property nobody verified.
    const connectionId = await seedConsentedConnection()
    const h = harness()
    await selectGbpLocation(h.deps, { connectionId, placeId: PLACE_ID, actor: ACTOR })
    expect((await storedRef(connectionId, 'gsc')).ref).toBeNull()
    expect((await storedRef(connectionId, 'gsc')).verifiedAt).toBeNull()
  })
})

describe('acceptance — every selection writes an event and a mirrored audit row', () => {
  it('names the actor and the chosen placeId in both ledgers', async () => {
    const connectionId = await seedConsentedConnection()
    const h = harness()
    const before = await selectionRows(connectionId)

    await selectGbpLocation(h.deps, { connectionId, placeId: PLACE_ID, actor: ACTOR })

    const after = await selectionRows(connectionId)
    // Three capabilities, three rows, and the mirror trigger fired for each: one ledger the connection panel
    // renders, one an investigation reads across the whole system.
    expect(after.events).toBe(before.events + 3)
    expect(after.audit).toBe(before.audit + 3)

    const [event] = await sql<
      { actor_kind: string; actor_label: string; detail: Record<string, unknown> }[]
    >`
      select actor_kind, actor_label, detail from google_connection_events
      where connection_id = ${connectionId} and event = 'capability_changed'
        and detail->>'capability' = 'gbp_reviews'
      order by id desc limit 1
    `
    expect(event?.actor_kind).toBe('staff')
    expect(event?.actor_label).toBe(ACTOR.label)
    expect(event?.detail).toMatchObject({
      capability: 'gbp_reviews',
      placeId: PLACE_ID,
      account: GBP_LOCATION_GROUP_ACCOUNT.name,
      location: AL_ZAHIYAH_LOCATION.name,
      source: 'picker',
    })
    // A row is one of the six places docs/10 §4 forbids a token.
    expect(JSON.stringify(event?.detail)).not.toContain(REFRESH_TOKEN)

    // The mirrored row carries the actor and the placeId too, through the trigger's `after_state`.
    const [mirrored] = await sql<{ actor_label: string; after_state: Record<string, unknown> }[]>`
      select actor_label, after_state from audit_event
      where entity_type = 'google_connection' and entity_id = ${connectionId}
        and action = 'google_connection.capability_changed'
        and after_state->>'capability' = 'gbp_reviews'
      order by id desc limit 1
    `
    expect(mirrored?.actor_label).toBe(ACTOR.label)
    expect(mirrored?.after_state?.['placeId']).toBe(PLACE_ID)
  })

  it('names the siteUrl for a Search Console selection, and writes exactly one row for it', async () => {
    const connectionId = await seedConsentedConnection()
    const h = harness()
    const before = await selectionRows(connectionId)

    await selectSearchConsoleProperty(h.deps, {
      connectionId,
      siteUrl: DOMAIN_PROPERTY,
      actor: ACTOR,
    })

    const after = await selectionRows(connectionId)
    expect(after.events).toBe(before.events + 1)
    expect(after.audit).toBe(before.audit + 1)
    const [event] = await sql<{ detail: Record<string, unknown> }[]>`
      select detail from google_connection_events
      where connection_id = ${connectionId} and event = 'capability_changed'
      order by id desc limit 1
    `
    expect(event?.detail).toMatchObject({
      capability: 'gsc',
      siteUrl: DOMAIN_PROPERTY,
      propertyKind: 'domain',
    })
  })

  it('writes neither ledger when the selection is refused', async () => {
    // The control. A ledger that recorded the attempt would claim a selection that never happened, and the
    // connection panel would show a resource the row does not carry.
    const connectionId = await seedConsentedConnection()
    const h = harness()
    const before = await selectionRows(connectionId)
    await expect(
      selectSearchConsoleProperty(h.deps, {
        connectionId,
        siteUrl: 'https://not-ours.example/',
        actor: ACTOR,
      }),
    ).rejects.toThrow()
    expect(await selectionRows(connectionId)).toEqual(before)
    expect((await storedRef(connectionId, 'gsc')).ref).toBeNull()
  })
})
