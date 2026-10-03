import { generateKek } from '@berelax/clinical'
import { fixedClock, instantFromIso } from '@berelax/core'
import { createConnection, type PremisesFacts, readPremisesFacts, type Sql } from '@berelax/db'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  AL_ZAHIYAH_LOCATION,
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  GBP_REGULAR_PERIODS,
  type GbpBusinessPeriod,
} from '@berelax/providers/google'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectionRecord, createMemoryConnectionStore } from '../memory-store.ts'
import { createMemoryRefreshLock } from '../token-refresh.ts'
import { connectionBinding, sealToken } from '../token-store.ts'
import type { WithGoogleDeps } from '../with-google.ts'
import {
  type GbpConsistencyDeps,
  type GbpManualSnapshot,
  recordManualSnapshot,
  runGbpConsistencyCheck,
} from './gbp-consistency.ts'

/**
 * G-SEO-06 — the consistency check against the real premises row, in both modes.
 *
 * The two claims that need a database are the two that cannot be faked: the website side comes from
 * `premises_hours` and the **price in force** (0025, not the variant column), and the manual snapshot's
 * provenance is recorded as an append-only `audit_event`. Everything Google is a fake, because there is
 * no Business Profile API access in this build (docs/10 §4, `Y3-gbp-api`).
 *
 * The acceptance criterion's *"finding count is unchanged between modes"* is asserted over the HOURS
 * divergence, which is the subject both arms can see. Business Information v1 carries no service prices
 * at all — a profile's prices live in a `priceLists` resource docs/10 §7 does not cover and nothing in
 * this build has ever read — so a price divergence is the snapshot's to report, and feeding the website's
 * own prices into the API arm would make every price agree with itself.
 */

const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!DATABASE_URL)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const KEK = generateKek('v1')
const SUB = 'sub-gseo06-gbp-consistency'
const REFRESH_TOKEN = '1//09-gseo06-consistency-refresh-token-never-in-a-row'
const CONNECTION_ID = '01930000-0000-7000-8000-00000000d606'
const NOW_ISO = '2026-10-02T06:00:00.000Z'
/** A staff reference, never a person's name (the brief's rule 10). */
const CLAIMED_BY = 'staff/BR-SNAPSHOT-FIXTURE'

/** The divergence the acceptance line names: the profile closes an hour early, every day. */
const ONE_HOUR_EARLY: readonly GbpBusinessPeriod[] = GBP_REGULAR_PERIODS.map((period) => ({
  ...period,
  closeTime: { hours: 1, minutes: 0 },
}))

let sql: Sql
let facts: PremisesFacts

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL as string, max: 4 })
  const read = await readPremisesFacts(sql)
  if (read === null) throw new Error('No premises row: this database was never seeded.')
  facts = read
})

afterAll(async () => {
  await sql.end({ timeout: 5 })
})

function googleDeps(options: {
  readonly connected: boolean
  readonly periods?: readonly GbpBusinessPeriod[]
}): { readonly deps: GbpConsistencyDeps } {
  const log = createCallLog(() => NOW_ISO)
  const store = createMemoryConnectionStore(
    options.connected
      ? [
          connectionRecord({
            id: CONNECTION_ID,
            googleSub: SUB,
            googleEmail: 'google-admin@berelax.ae',
            refreshToken: sealToken(
              KEK,
              connectionBinding({ connectionId: CONNECTION_ID, googleSub: SUB }),
              REFRESH_TOKEN,
            ),
            consentAt: instantFromIso('2026-10-01T06:00:00.000Z'),
            status: 'active',
            statusReason: null,
          }),
        ]
      : [],
  )
  if (options.connected) {
    store.putCapability({
      connectionId: CONNECTION_ID,
      capability: 'gbp_location',
      resourceRef: {
        account: 'accounts/fake-location-group-1',
        location: AL_ZAHIYAH_LOCATION.name,
        placeId: AL_ZAHIYAH_LOCATION.metadata.placeId,
      },
      health: 'unknown',
      isPrimary: true,
    })
  }
  const google: WithGoogleDeps = {
    store,
    lock: createMemoryRefreshLock(store),
    oauth: createFakeGoogleOAuth({
      log,
      failures: new FailureScript(),
      now: () => NOW_ISO,
      sub: SUB,
    }),
    kek: KEK,
    clock: fixedClock(NOW_ISO),
    logger: { log: () => {} },
  }
  const profile = createFakeBusinessProfile({
    log,
    failures: new FailureScript(),
    now: () => NOW_ISO,
    locationsByAccount: {
      'accounts/fake-location-group-1': [
        {
          ...AL_ZAHIYAH_LOCATION,
          regularHours: { periods: options.periods ?? GBP_REGULAR_PERIODS },
        },
      ],
    },
  })
  return {
    deps: {
      sql,
      google,
      profile,
      actor: { kind: 'staff', label: CLAIMED_BY },
    },
  }
}

/** A transcription of the profile: closing an hour early, and one service 50 AED cheaper. */
function snapshotWithDivergence(): GbpManualSnapshot {
  const cheaper = facts.prices[0]
  if (cheaper === undefined) throw new Error('The seeded menu has no price points.')
  const reducedFils = Number(cheaper.grossPriceFils) - 5_000
  const majorUnits = Math.trunc(reducedFils / 100)
  const minorUnits = reducedFils % 100
  return {
    claimedBy: CLAIMED_BY,
    claimedAtIso: NOW_ISO,
    days: facts.hours.map((row) => ({
      dayOfWeek: row.dayOfWeek,
      openText: row.openTime,
      // One hour before the premises row's close. Built from the row rather than written as a literal,
      // so the NAP rule stays true of the suite as well as of the module.
      closeText: `0${Number(row.closeTime.slice(0, 2)) - 1}:00`,
    })),
    prices: [
      {
        serviceKey: cheaper.slug,
        durationMinutes: cheaper.durationMinutes,
        grossAedText: `${majorUnits}.${String(minorUnits).padStart(2, '0')}`,
      },
    ],
  }
}

describe('the GBP-versus-website consistency check', () => {
  it('reports exactly two findings for the seeded divergence, naming both sources', async () => {
    const { deps } = googleDeps({ connected: false })
    const outcome = await runGbpConsistencyCheck(deps, { snapshot: snapshotWithDivergence() })

    expect(outcome.mode).toBe('manual_snapshot')
    expect(outcome.report?.findings).toHaveLength(2)
    const [hours, price] = outcome.report?.findings ?? []
    expect(hours?.rule).toBe('opening_hours_disagree')
    expect(hours?.subject).toBe('every day')
    expect(hours?.website.provenance).toEqual({
      side: 'website',
      authority: 'premises_hours_row',
    })
    expect(hours?.google.provenance).toEqual({
      side: 'google',
      authority: 'manual_snapshot',
      claimedBy: CLAIMED_BY,
      claimedAtIso: NOW_ISO,
    })
    expect(price?.rule).toBe('service_price_disagrees')
    expect(price?.website.provenance).toEqual({ side: 'website', authority: 'price_in_force' })
    // The weaker claim, stated in words. A reader must be able to tell this from a reading.
    expect(outcome.provenance).toContain('rather than an observation')
  })

  it('renders the form and judges nothing when nobody has recorded a snapshot', async () => {
    const { deps } = googleDeps({ connected: false })
    const outcome = await runGbpConsistencyCheck(deps)

    expect(outcome.mode).toBe('manual_snapshot')
    expect(outcome.report).toBeNull()
    expect(outcome.form?.fields.length).toBeGreaterThan(0)
    expect(outcome.form?.reason).toContain('Y3-gbp-api')
    // Three fields a day, plus one per published price point. Derived, so a new service appears with no
    // code change — and so a field can never name a subject the comparison would refuse.
    expect(outcome.form?.fields).toHaveLength(facts.hours.length * 3 + facts.prices.length)
    // The form must NOT carry the website's own values: a pre-filled Google column is answered by
    // pressing Enter, and the check would then report "consistent" about a profile nobody looked at.
    const labels = (outcome.form?.fields ?? []).map((field) => field.label).join('\n')
    for (const row of facts.hours) {
      expect(labels).not.toContain(row.openTime)
      expect(labels).not.toContain(row.closeTime)
    }
  })

  it('finds the same hours divergence through the API arm: the count is unchanged between modes', async () => {
    const snapshot = snapshotWithDivergence()
    const { deps: degraded } = googleDeps({ connected: false })
    const manual = await runGbpConsistencyCheck(degraded, {
      // Hours only, so the two arms are compared over the subject both can see. See this file's header.
      snapshot: { ...snapshot, prices: [] },
    })
    const { deps: live } = googleDeps({ connected: true, periods: ONE_HOUR_EARLY })
    const api = await runGbpConsistencyCheck(live)

    expect(api.mode).toBe('api')
    expect(manual.mode).toBe('manual_snapshot')
    expect(api.report?.findings).toHaveLength(manual.report?.findings.length ?? -1)
    expect(api.report?.findings).toHaveLength(1)
    expect(api.report?.findings[0]?.rule).toBe('opening_hours_disagree')
    expect(api.report?.findings[0]?.website.value).toBe(manual.report?.findings[0]?.website.value)
    expect(api.report?.findings[0]?.google.value).toBe(manual.report?.findings[0]?.google.value)
    // And the provenance is the thing that differs, which is the whole point of two modes.
    expect(api.report?.findings[0]?.google.provenance).toEqual({
      side: 'google',
      authority: 'business_information_v1',
    })
    expect(api.provenance).toContain('read from the Business Profile API')
  })

  it('reports nothing when the profile agrees with the premises row, which is the control', async () => {
    // Without this, "two findings" and "one finding" above are satisfied by a checker that reports a
    // finding about anything it is handed.
    const { deps } = googleDeps({ connected: true })
    const outcome = await runGbpConsistencyCheck(deps)
    expect(outcome.mode).toBe('api')
    expect(outcome.report?.findings).toEqual([])
    expect(outcome.form).toBeNull()
  })

  it('records a claim with who made it and when, and never as an observation', async () => {
    const before = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'google.gbp_snapshot.recorded'
    `
    await recordManualSnapshot(
      { sql, actor: { kind: 'staff', label: CLAIMED_BY } },
      snapshotWithDivergence(),
    )
    // A DELTA, never a total: `audit_event` is append-only (ADR 0008) and every other suite writes to it.
    const after = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'google.gbp_snapshot.recorded'
    `
    expect(Number(after[0]?.n) - Number(before[0]?.n)).toBe(1)

    const [row] = await sql<{ actorKind: string; actorLabel: string; after: unknown }[]>`
      select actor_kind as "actorKind", actor_label as "actorLabel", after_state as "after"
      from audit_event
      where action = 'google.gbp_snapshot.recorded'
      order by occurred_at desc, id desc
      limit 1
    `
    expect(row?.actorKind).toBe('staff')
    expect(row?.actorLabel).toBe(CLAIMED_BY)
    expect((row?.after as { claimedBy?: string } | null)?.claimedBy).toBe(CLAIMED_BY)
    expect((row?.after as { claimedAtIso?: string } | null)?.claimedAtIso).toBe(NOW_ISO)
  })

  it('refuses an unreadable transcription rather than comparing it as midnight', async () => {
    const { deps } = googleDeps({ connected: false })
    const snapshot = snapshotWithDivergence()
    await expect(
      runGbpConsistencyCheck(deps, {
        snapshot: {
          ...snapshot,
          days: [{ dayOfWeek: 0, openText: '11pm', closeText: '2am' }],
        },
      }),
    ).rejects.toThrow('is not a time of day')
    await expect(
      runGbpConsistencyCheck(deps, {
        snapshot: { ...snapshot, days: [{ dayOfWeek: 0, openText: '11:00' }] },
      }),
    ).rejects.toThrow('neither a pair of times nor a closed mark')
  })
})
