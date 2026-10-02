import { fixedClock } from '@berelax/core'
import type { Sql } from '@berelax/db'
import { createConnection, readPreConsentLandings } from '@berelax/db'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import {
  AI_CRAWLER_FETCHERS,
  ANALYTICS_CONSENT_COOKIE,
  COLLECT_MAX_BATCH_EVENTS,
  COLLECT_MAX_BODY_BYTES,
  COLLECT_PATH,
  SESSION_INACTIVITY_MS,
} from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CollectEndpointDeps,
  handleCollectRequest,
  VISITOR_COOKIE,
  VISITOR_COOKIE_MAX_AGE_SECONDS,
} from './ingest.ts'

/**
 * A-FIRST-05 — `/api/collect`, against a real PostgreSQL and the built application.
 *
 * ## Why this file drives the handler directly for most of it, and a server for the rest
 *
 * Three of the six acceptance lines are claims under a FROZEN clock — "two events 29 minutes apart share a
 * session id", "31 minutes apart create a second session", "200 requests inside a frozen second" — and a
 * request over HTTP cannot have one: `route.ts` builds the clock from the real one. So the handler is called
 * with `fixedClock`, which is what makes those three assertions about the code rather than about how fast
 * this machine is (brief rule 23). It is still a real `Request` in and a real `Response` out, so every claim
 * about a status code, a `Set-Cookie` and its attributes is made against the bytes the route produces.
 *
 * A server is started for the two claims that need one and could not be made any other way: the grep over
 * RENDERED public HTML for third-party analytics origins, and one end-to-end POST that proves `route.ts`'s
 * own wiring — the connection, the clock and the `ownHosts` it builds — because a handler exercised only as
 * a function is a handler whose wiring nobody has seen run.
 *
 * ## Nothing is deleted, and every assertion is a delta
 *
 * `analytics.event` is append-only (ZY065) and `analytics.pre_consent_landing` refuses a DELETE (ZY221), so
 * this suite could not clean up after itself even if it should. It does not try: every row it creates is
 * reached through a visitor id or a session id this run minted, the landing counter is asserted as a
 * DIFFERENCE across one request, and the bucket paths carry a per-run token. That is what lets the suite run
 * twice in a row, which is the test of whether it leaks.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The frozen instant every handler call is made at, and it is inside trading hours deliberately.
 *
 * 21:00 Asia/Dubai on a date the seed's calendar holds, so `session_trading_date_fk` is satisfied and the
 * basis is `trading` — which is the ordinary case and therefore the one the ordinary assertions should be
 * made in. The daytime gap gets cases of its own further down, at an instant chosen the same way.
 */
const TRADING_ISO = '2026-09-29T17:00:00.000Z' // 21:00 Asia/Dubai
const RUN = `afirst05-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

let sql: Sql
let server: WebServer
let BASE: string

/** A fresh limiter map per case, so one case's burst cannot refuse another's request. */
const depsAt = (iso: string): CollectEndpointDeps => ({
  sql,
  clock: fixedClock(iso),
  rateLimitHits: new Map(),
  ownHosts: ['berelax.example', 'www.berelax.example'],
})

let batchSeq = 0

/**
 * A fresh event id and a DISTINCT instant for it, one second apart.
 *
 * The id is unique across the whole run because `event_client_event_id_unique` is per month, so a second run
 * of this suite in the same month would otherwise silently replay rather than insert.
 *
 * The instant is distinct for a reason this suite found the hard way: two events posted in one batch share
 * `received_at`, and if they also share `occurred_at` the only tie-break left is `event_id` — a
 * `uuid_generate_v7` whose tail is random within a millisecond, so `order by occurred_at, event_id` returned
 * a batch's events in an order that was not the order they were sent in. A case asserting on that order
 * passed once and failed on the next run. One second apart makes the reading order the sending order, which
 * is also what a real queue looks like.
 */
const nextEvent = (): { clientEventId: string; occurredAt: string } => {
  batchSeq += 1
  return {
    clientEventId: `${RUN}-${batchSeq}`.replace(/[^A-Za-z0-9_-]/g, '-'),
    occurredAt: new Date(Date.parse(TRADING_ISO) + batchSeq * 1_000).toISOString(),
  }
}

const clientEventId = (): string => nextEvent().clientEventId

interface BatchOverrides {
  readonly viewportWidth?: number | null
  readonly interactionCount?: number
  readonly interEventGapsMs?: readonly number[]
  readonly query?: string | null
  readonly referrer?: string | null
  readonly events?: readonly unknown[]
}

const pageView = (path: string, entry = true) => ({
  name: 'page_view',
  ...nextEvent(),
  payload: { path, entry },
})

const batch = (overrides: BatchOverrides = {}): Record<string, unknown> => ({
  viewportWidth: 390,
  interactionCount: 3,
  interEventGapsMs: [811, 1_402],
  query: null,
  referrer: null,
  events: [pageView(`/en/${RUN}`)],
  ...overrides,
})

const CONSENTED = `${ANALYTICS_CONSENT_COOKIE}=analytics_storage`

/** One request, with the cookies and headers a case cares about and nothing it does not. */
const post = async (
  iso: string,
  body: unknown,
  init: {
    readonly cookie?: string
    readonly userAgent?: string
    readonly deps?: CollectEndpointDeps
  } = {},
): Promise<Response> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.cookie !== undefined) headers['cookie'] = init.cookie
  if (init.userAgent !== undefined) headers['user-agent'] = init.userAgent
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  return await handleCollectRequest(
    init.deps ?? depsAt(iso),
    new Request(`http://127.0.0.1${COLLECT_PATH}`, { method: 'POST', headers, body: raw }),
  )
}

const refusalOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { refusal?: string }).refusal ?? '(none)'

const visitorIdOf = (response: Response): string | null => {
  const header = response.headers.get('set-cookie')
  if (header === null) return null
  return new RegExp(`${VISITOR_COOKIE}=([^;]+)`).exec(header)?.[1] ?? null
}

interface SessionRow {
  readonly session_id: string
  readonly visitor_id: string
  readonly trading_date: string
  readonly trading_date_basis: string
  readonly device_kind: string
  readonly breakpoint: string
  readonly bot: boolean
  readonly bot_kind: string | null
  readonly landing_path: string
  readonly started_at: string
  readonly last_event_at: string
}

const sessionsOf = async (visitorId: string): Promise<readonly SessionRow[]> =>
  await sql<SessionRow[]>`
    select session_id, visitor_id, trading_date::text as trading_date, trading_date_basis,
           device_kind, breakpoint, bot, bot_kind, landing_path,
           started_at::text as started_at, last_event_at::text as last_event_at
      from analytics.session where visitor_id = ${visitorId}::uuid order by started_at
  `

const eventsOf = async (
  sessionId: string,
): Promise<readonly { event_name: string; path: string; properties: Record<string, unknown> }[]> =>
  await sql<{ event_name: string; path: string; properties: Record<string, unknown> }[]>`
    select event_name, path, properties from analytics.event
     where session_id = ${sessionId}::uuid order by occurred_at, event_id
  `

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 6 })
  server = await startWebServer({
    suite: 'collect',
    cwd: new URL('../../../', import.meta.url).pathname,
    env: { APP_ENV: process.env['APP_ENV'] ?? 'test', DATABASE_URL: url as string },
  })
  BASE = server.origin
}, 180_000)

afterAll(async () => {
  await server?.stop()
  await sql?.end({ timeout: 5 })
})

// ------------------------------------------------------------------------------------------------
// Acceptance 1: one row per event, and a batch is all-or-nothing
// ------------------------------------------------------------------------------------------------

describe('a valid batch', () => {
  it('answers 204 and writes exactly one row per event', async () => {
    const response = await post(
      TRADING_ISO,
      batch({
        events: [
          pageView(`/en/${RUN}/one`),
          {
            name: 'service_viewed',
            ...nextEvent(),
            payload: { style: 'asian', treatment: 'hot_oil_balm_massage', path: `/en/${RUN}/two` },
          },
          {
            name: 'cta_click',
            ...nextEvent(),
            payload: { target: 'whatsapp', path: `/en/${RUN}/two` },
          },
        ],
      }),
      { cookie: CONSENTED },
    )
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')

    const visitorId = visitorIdOf(response)
    expect(visitorId, 'a first consented batch issues the visitor cookie').not.toBeNull()
    const sessions = await sessionsOf(visitorId as string)
    expect(sessions.length).toBe(1)
    const rows = await eventsOf((sessions[0] as SessionRow).session_id)
    expect(rows.map((row) => row.event_name)).toEqual(['page_view', 'service_viewed', 'cta_click'])
    // One row per event and no more: a loop that inserted twice, or a batch that fanned an event out into a
    // funnel step as well, would be caught by the count rather than by the names.
    expect(rows.length).toBe(3)
  })

  it('rejects a batch containing one invalid event as a WHOLE, with zero rows written', async () => {
    /*
     * The acceptance line asks for this "asserted inside one transaction". The stronger claim is what is
     * asserted: no transaction is ever opened, because the whole batch is validated before the writer is
     * called — so there is nothing to roll back and nothing that could half-succeed. The visitor's row
     * count is read before and after and must be identical, which is what makes "zero rows written" a
     * measurement rather than a hope.
     */
    const first = await post(TRADING_ISO, batch(), { cookie: CONSENTED })
    const visitorId = visitorIdOf(first) as string
    const cookie = `${CONSENTED}; ${VISITOR_COOKIE}=${visitorId}`
    const before = await countsFor(visitorId)

    const response = await post(
      TRADING_ISO,
      batch({
        events: [
          pageView(`/en/${RUN}/valid-one`),
          pageView(`/en/${RUN}/valid-two`, false),
          // Valid NAME, invalid payload: `cta_click` has no `target` of `sms`. The three valid events beside
          // it are what makes this a claim about the batch rather than about the one event.
          {
            name: 'cta_click',
            ...nextEvent(),
            payload: { target: 'sms', path: `/en/${RUN}/invalid` },
          },
        ],
      }),
      { cookie },
    )

    expect(response.status).toBe(400)
    expect(await refusalOf(response)).toBe('invalid_event_payload')
    const after = await countsFor(visitorId)
    expect(after, 'a refused batch wrote something').toEqual(before)
  })

  it('refuses an event name the taxonomy does not hold, by name, and writes nothing', async () => {
    const before = await totalEvents()
    const response = await post(
      TRADING_ISO,
      batch({
        events: [
          {
            name: 'page_view',
            ...nextEvent(),
            payload: { path: `/en/${RUN}`, entry: true },
          },
          {
            name: 'scroll_depth',
            ...nextEvent(),
            payload: {},
          },
        ],
      }),
      { cookie: CONSENTED },
    )
    expect(response.status).toBe(400)
    expect(await refusalOf(response)).toBe('unknown_event')
    // The message names the taxonomy rather than the field, because an unknown name is a tag nobody
    // deployed and the author needs the list (A-FIRST-02's UnknownEventError).
    expect(await totalEvents()).toBe(before)
  })
})

const countsFor = async (
  visitorId: string,
): Promise<{ sessions: number; events: number; attributions: number }> => {
  const [row] = await sql<{ sessions: string; events: string; attributions: string }[]>`
    select
      (select count(*) from analytics.session where visitor_id = ${visitorId}::uuid)::text as sessions,
      (select count(*) from analytics.event e
        where e.session_id in (select session_id from analytics.session where visitor_id = ${visitorId}::uuid)
      )::text as events,
      (select count(*) from analytics.attribution a
        where a.session_id in (select session_id from analytics.session where visitor_id = ${visitorId}::uuid)
      )::text as attributions
  `
  return {
    sessions: Number(row?.sessions ?? -1),
    events: Number(row?.events ?? -1),
    attributions: Number(row?.attributions ?? -1),
  }
}

const totalEvents = async (): Promise<number> => {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from analytics.event`
  return Number(row?.n ?? -1)
}

// ------------------------------------------------------------------------------------------------
// Acceptance 2: before consent, nothing identified exists and the counter still moves
// ------------------------------------------------------------------------------------------------

describe('before a consent decision', () => {
  it('issues no cookie, creates no visitor and no session, and increments the counter by exactly one', async () => {
    /*
     * The acceptance line asks for all of this in ONE test, and the reason is that the four facts are one
     * fact: the pre-consent path is a projection with no identifier. Splitting them would let three pass
     * while the fourth quietly failed.
     */
    const path = `/en/${RUN}/pre-consent`
    // The bucket's date is the one a session would get, read from the calendar the route resolves against
    // rather than computed here — a second derivation of a trading date is how a test comes to assert
    // against the wrong day.
    const key = { bucketDate: await tradingDateOf(TRADING_ISO), basis: 'trading' as const, path }

    const before = (await readPreConsentLandings(sql, key)) ?? 0
    const visitorsBefore = await totalVisitors()

    // No cookie header at all. The other two spellings of "no decision" — an unreadable cookie and one
    // granting only the advertising signals — are covered by `consent-signal.test.ts`; what is asserted
    // here is that the ROUTE takes the same branch for the ordinary one.
    const response = await post(TRADING_ISO, batch({ events: [pageView(path)] }))

    expect(response.status).toBe(204)
    expect(
      response.headers.get('set-cookie'),
      'a Set-Cookie before consent is the whole failure this line is about',
    ).toBeNull()
    expect(await readPreConsentLandings(sql, key)).toBe(before + 1)
    expect(await totalVisitors(), 'no visitor row may exist before consent').toBe(visitorsBefore)
    // And no session row anywhere carries this landing path, which is the only handle a pre-consent request
    // could have left on `analytics.session`.
    const [session] = await sql<{ n: string }[]>`
      select count(*)::text as n from analytics.session where landing_path = ${path}
    `
    expect(Number(session?.n)).toBe(0)
  })

  it('counts an arrival once however many page views the batch carries', async () => {
    // The counter is the funnel's FIRST bucket, so it counts arrivals and not page views: a batch with one
    // entry page view and three ordinary ones is one landing. Without this the denominator would be larger
    // than the numerator it is divided into.
    const path = `/en/${RUN}/pre-consent-many`
    const key = { bucketDate: await tradingDateOf(TRADING_ISO), basis: 'trading' as const, path }
    const before = (await readPreConsentLandings(sql, key)) ?? 0
    await post(
      TRADING_ISO,
      batch({
        events: [pageView(path), pageView(path, false), pageView(path, false)],
      }),
    )
    expect(await readPreConsentLandings(sql, key)).toBe(before + 1)
  })

  it('leaves a staged landing with nothing to expire when consent never arrives', async () => {
    /*
     * The claim the dispatch asks to be proved, and it is proved by ENUMERATION rather than by narration:
     * the row the pre-consent path writes has four columns, none of them an identifier and none of them an
     * instant — so "consent never arrives" needs no purge job, because nothing identifying was written, and
     * there is nothing to promote either. ADR 0066 is the decision; this is the shape of it.
     */
    const columns = await sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
       where table_schema = 'analytics' and table_name = 'pre_consent_landing'
       order by column_name
    `
    expect(columns.map((column) => column.column_name)).toEqual([
      'bucket_basis',
      'bucket_date',
      'landings',
      'path',
    ])
    // No instant of any kind. A timestamp on a row whose count is 1 is a timestamp of one person's visit,
    // which would make "identifier-free" false — the coarsest thing here is a date and it is also the
    // finest.
    expect(columns.filter((column) => column.data_type.includes('timestamp'))).toEqual([])

    // And retention's own answer, read from the policy table rather than from a comment: kept indefinitely,
    // so no window expires it and the funnel keeps its denominator past 90 days.
    const [policy] = await sql<{ policy: string; age_column: string | null }[]>`
      select policy, age_column from analytics.retention_policy
       where relation_name = 'pre_consent_landing'
    `
    expect(policy?.policy).toBe('keep_indefinitely')
    expect(policy?.age_column).toBeNull()
  })

  it('is invisible to a subject access request, because no probe can reach it', async () => {
    /*
     * The second claim the dispatch asks for. C-CRM-10's erasure engine enumerates every schema over five
     * catalogue probes — a customer or contact reference, a contact detail, a credential, a foreign key to a
     * subject-scoped table, and free text on one — and refuses an erasure when it finds a column with no
     * rule. This table is reached by NONE of them, which is what "a subject access request finds nothing"
     * means mechanically: there is no key by which a subject could be looked up, even by somebody trying.
     *
     * Asserted against `information_schema` and the probes' own patterns rather than by calling the engine,
     * because `packages/fixtures/src/analytics-privacy.itest.ts` already drives the engine over this schema
     * from both ends — including a fixture table it DOES catch, which is what stops that file passing
     * vacuously. What is added here is the narrower claim about this one table.
     */
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'analytics' and table_name = 'pre_consent_landing'
    `
    const names = columns.map((column) => column.column_name)
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(name, 'no subject reference').not.toMatch(
        /(customer|contact|booking|invoice|visitor|session)_id$/,
      )
      expect(name, 'no contact detail').not.toMatch(/(phone|email|e164|whatsapp)/)
      expect(name, 'no credential').not.toMatch(/(token|secret|hash|password|key)/)
      expect(name, 'no free text note').not.toMatch(/(note|comment|remark|reason|description)/)
      expect(name, 'no network identifier').not.toMatch(/(ip|user_agent|fingerprint)/)
    }
    // The control: the same patterns DO catch the shape they are looking for, so an empty result above means
    // the table is clean rather than that the regexes are.
    expect('customer_id').toMatch(/(customer|contact|booking|invoice|visitor|session)_id$/)
    expect('phone_e164').toMatch(/(phone|email|e164|whatsapp)/)

    // And the table carries no foreign key at all, so the fourth probe has nothing to follow either.
    const keys = await sql<{ conname: string }[]>`
      select k.conname from pg_constraint k
        join pg_class c on c.oid = k.conrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'analytics' and c.relname = 'pre_consent_landing' and k.contype = 'f'
    `
    expect(keys).toEqual([])
  })

  it('refuses to have its count lowered or removed, by name', async () => {
    // The count is the only surviving record that the visit happened — the event was never stored — so a
    // revision downwards moves every conversion rate that divides by it. ZY221 is what makes that a
    // property of the database rather than of this module.
    const path = `/en/${RUN}/monotonic`
    const key = { bucketDate: await tradingDateOf(TRADING_ISO), basis: 'trading' as const, path }
    await post(TRADING_ISO, batch({ events: [pageView(path)] }))
    await post(TRADING_ISO, batch({ events: [pageView(path)] }))
    expect(await readPreConsentLandings(sql, key)).toBe(2)

    const lowered = await stateOf(sql`
      update analytics.pre_consent_landing set landings = 1
       where bucket_date = ${key.bucketDate}::date and bucket_basis = ${key.basis} and path = ${path}
    `)
    expect(lowered.code).toBe('ZY221')
    expect(lowered.message).toContain('may not be lowered')

    const removed = await stateOf(sql`
      delete from analytics.pre_consent_landing
       where bucket_date = ${key.bucketDate}::date and bucket_basis = ${key.basis} and path = ${path}
    `)
    expect(removed.code).toBe('ZY221')

    // The control: RAISING it is the ordinary write and is permitted, so the trigger refuses a direction
    // rather than refusing every update.
    const raised = await stateOf(sql`
      update analytics.pre_consent_landing set landings = landings + 1
       where bucket_date = ${key.bucketDate}::date and bucket_basis = ${key.basis} and path = ${path}
    `)
    expect(raised.code).toBeUndefined()
    expect(await readPreConsentLandings(sql, key)).toBe(3)
  })
})

/** The trading date the calendar says contains an instant — the route's own resolution, not a second one. */
const tradingDateOf = async (iso: string): Promise<string> => {
  const [row] = await sql<{ trading_date: string }[]>`
    select trading_date::text as trading_date from public.business_day
     where ${iso}::timestamptz >= opens_at and ${iso}::timestamptz < closes_at
  `
  if (row === undefined) {
    throw new Error(
      `the seeded calendar does not cover ${iso}, so this suite would assert on nothing`,
    )
  }
  return row.trading_date
}

const totalVisitors = async (): Promise<number> => {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from analytics.visitor`
  return Number(row?.n ?? -1)
}

/** A statement's SQLSTATE and message, or `{}` when it succeeded. `analytics.itest.ts`'s helper. */
const stateOf = async (
  promise: Promise<unknown>,
): Promise<{ code?: string | undefined; message: string }> => {
  try {
    await promise
    return { message: '' }
  } catch (error) {
    const err = error as { code?: string; message?: string }
    return { code: err.code, message: err.message ?? '' }
  }
}

// ------------------------------------------------------------------------------------------------
// Acceptance 3: session stitching on thirty minutes of inactivity
// ------------------------------------------------------------------------------------------------

describe('session stitching', () => {
  const at = (offsetMinutes: number): string =>
    new Date(Date.parse(TRADING_ISO) + offsetMinutes * 60_000).toISOString()

  it('shares a session id 29 minutes apart', async () => {
    const first = await post(at(0), batch(), { cookie: CONSENTED })
    const visitorId = visitorIdOf(first) as string
    const cookie = `${CONSENTED}; ${VISITOR_COOKIE}=${visitorId}`
    const second = await post(at(29), batch(), { cookie })
    expect(second.status).toBe(204)
    // A returning visitor gets no second cookie: the row already exists, so there is nothing to issue.
    expect(second.headers.get('set-cookie')).toBeNull()
    const sessions = await sessionsOf(visitorId)
    expect(sessions.length).toBe(1)
    // And the session's own clock moved, which is what the next stitch measures against.
    expect(Date.parse((sessions[0] as SessionRow).last_event_at)).toBe(Date.parse(at(29)))
  })

  it('creates a second session 31 minutes apart and leaves first_touch untouched', async () => {
    const first = await post(at(0), batch({ query: '?utm_source=google&utm_medium=cpc' }), {
      cookie: CONSENTED,
    })
    const visitorId = visitorIdOf(first) as string
    const cookie = `${CONSENTED}; ${VISITOR_COOKIE}=${visitorId}`
    const [visitorBefore] = await sql<{ first_seen_at: string; last_seen_at: string }[]>`
      select first_seen_at::text as first_seen_at, last_seen_at::text as last_seen_at
        from analytics.visitor where visitor_id = ${visitorId}::uuid
    `

    const second = await post(at(31), batch({ query: '?utm_source=meta&utm_medium=paid_social' }), {
      cookie,
    })
    expect(second.status).toBe(204)
    const sessions = await sessionsOf(visitorId)
    expect(sessions.length).toBe(2)
    expect((sessions[0] as SessionRow).session_id).not.toBe((sessions[1] as SessionRow).session_id)

    const [visitorAfter] = await sql<{ first_seen_at: string; last_seen_at: string }[]>`
      select first_seen_at::text as first_seen_at, last_seen_at::text as last_seen_at
        from analytics.visitor where visitor_id = ${visitorId}::uuid
    `
    // The acceptance line's second half, and the one an `upsert … set first_seen_at = …` would break: the
    // visitor's first touch is the first touch whatever happens later.
    expect(visitorAfter?.first_seen_at).toBe(visitorBefore?.first_seen_at)
    expect(Date.parse(visitorAfter?.last_seen_at as string)).toBe(Date.parse(at(31)))

    // Each session carries its OWN origination, which is why the row is per session rather than per visitor.
    const bases = await sql<{ source: string; medium: string }[]>`
      select a.source, a.medium from analytics.attribution a
        join analytics.session s on s.session_id = a.session_id
       where s.visitor_id = ${visitorId}::uuid order by s.started_at
    `
    expect(bases.map((row) => `${row.source}/${row.medium}`)).toEqual([
      'google/cpc',
      'meta/paid_social',
    ])
  })

  it('stitches on the window the constant states, at its exact boundary', async () => {
    // Half-open, so exactly thirty minutes starts a new session. Asserted against the constant rather than
    // against 30 written again, and through the ROUTE rather than through `stitchSession` — the pure
    // function's own boundary is covered by its unit test; this is the claim that the route uses it.
    const first = await post(at(0), batch(), { cookie: CONSENTED })
    const visitorId = visitorIdOf(first) as string
    const cookie = `${CONSENTED}; ${VISITOR_COOKIE}=${visitorId}`
    await post(new Date(Date.parse(at(0)) + SESSION_INACTIVITY_MS).toISOString(), batch(), {
      cookie,
    })
    expect((await sessionsOf(visitorId)).length).toBe(2)
  })

  it('gives a session exactly one landing however many page views claim to be one', async () => {
    /*
     * A-FIRST-02 deferred this here: the `entry` flag is the session's FIRST page view only, and the client
     * cannot know which that is because it has never been told which session it is in. So the flag the
     * client sent is overwritten — and this case sends `entry: true` on every page view of both batches,
     * which is exactly what a client with a wrong idea of its own session would do.
     */
    const paths = [`/en/${RUN}/a`, `/en/${RUN}/b`, `/en/${RUN}/c`] as const
    const first = await post(at(0), batch({ events: [pageView(paths[0]), pageView(paths[1])] }), {
      cookie: CONSENTED,
    })
    const visitorId = visitorIdOf(first) as string
    const cookie = `${CONSENTED}; ${VISITOR_COOKIE}=${visitorId}`
    await post(at(5), batch({ events: [pageView(paths[2])] }), { cookie })

    const sessions = await sessionsOf(visitorId)
    expect(sessions.length).toBe(1)
    const rows = await eventsOf((sessions[0] as SessionRow).session_id)
    // Keyed by PATH rather than by row order. The order is deterministic now that every fixture event
    // carries its own instant, and keying on a value the case itself chose is what makes the assertion
    // independent of how the rows come back at all.
    const entryByPath = new Map(rows.map((row) => [row.path, row.properties['entry']]))
    expect([...entryByPath.entries()].sort()).toEqual([
      [paths[0], true],
      [paths[1], false],
      [paths[2], false],
    ])
  })
})

// ------------------------------------------------------------------------------------------------
// Acceptance 4: the cookie's attributes, and no third-party analytics in the rendered HTML
// ------------------------------------------------------------------------------------------------

describe('the visitor cookie as served', () => {
  it('is host-only, Secure and SameSite=Lax, with no leading-dot domain', async () => {
    const response = await post(TRADING_ISO, batch(), { cookie: CONSENTED })
    const header = response.headers.get('set-cookie') as string
    expect(header).toContain('Secure')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('Path=/')
    // Host-only is the ABSENCE of a Domain attribute, and a leading dot is the specific spelling that would
    // send this identifier to every subdomain.
    expect(header).not.toMatch(/Domain=/i)
    expect(header).not.toMatch(/=\.[A-Za-z]/)
  })

  it('lives exactly as long as the database says raw analytics does', async () => {
    // The second statement of a figure arrives with the check that holds the two equal, in the same commit.
    // `analytics.raw_retention_days()` is the one place the 90 days is stated (ADR 0045, migration 0096).
    const [window] = await sql<{ days: number }[]>`select analytics.raw_retention_days() as days`
    expect(VISITOR_COOKIE_MAX_AGE_SECONDS).toBe((window?.days as number) * 24 * 60 * 60)
  })
})

describe('the rendered public HTML', () => {
  it('references no third-party analytics origin anywhere in it', async () => {
    /*
     * ADR 0018: first-party analytics is the source of truth and nothing third-party loads. Asserted against
     * the BYTES the application serves rather than against a source scan, because the failure this is about
     * is a script that arrives through a bundle, a CMS field or a font loader rather than through a line
     * somebody wrote in a page.
     *
     * Three pages and not one, and each is fetched and checked for its own marker first — a 200 with
     * `text/html` is also what a sign-in page answers, and a case asserting only "no Google in it" would
     * pass beautifully against a 404 body.
     */
    const pages = ['/', '/ar', '/treatments']
    const forbidden = ['googletagmanager.com', 'google-analytics.com', 'connect.facebook.net']
    let checked = 0
    for (const path of pages) {
      const response = await fetch(`${BASE}${path}`)
      expect(response.status, `${path} must render`).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      const html = await response.text()
      // The marker: this is a rendered document of this site, not an error page that happens to be clean.
      expect(html, `${path} must be a rendered document`).toMatch(/<html[^>]*lang=/i)
      expect(html.length, `${path} rendered almost nothing`).toBeGreaterThan(2_000)
      for (const origin of forbidden) {
        expect(html.includes(origin), `${path} references ${origin}`).toBe(false)
      }
      checked += 1
    }
    // The control: a scan over nothing passes every assertion above.
    expect(checked).toBe(pages.length)
    // And the patterns DO catch what they look for, so a clean result means clean bytes rather than a
    // comparison that stopped matching.
    expect(
      '<script src="https://www.googletagmanager.com/gtm.js">'.includes('googletagmanager.com'),
    ).toBe(true)
  })
})

// ------------------------------------------------------------------------------------------------
// Acceptance 5: the payload caps, each with its own name and no partial write
// ------------------------------------------------------------------------------------------------

describe('the payload caps', () => {
  it('refuses a body over 64 KiB, by name, and writes nothing', async () => {
    const before = await totalEvents()
    // Oversized by its PATH rather than by a repeated event, so the body is over the cap while the batch is
    // within the event cap — which is what makes this case about the byte limit and not the array limit.
    const huge = JSON.stringify(
      batch({
        events: [
          {
            name: 'page_view',
            ...nextEvent(),
            payload: { path: `/en/${'x'.repeat(COLLECT_MAX_BODY_BYTES)}`, entry: true },
          },
        ],
      }),
    )
    expect(huge.length).toBeGreaterThan(COLLECT_MAX_BODY_BYTES)
    const response = await post(TRADING_ISO, huge, { cookie: CONSENTED })
    expect(response.status).toBe(400)
    expect(await refusalOf(response)).toBe('body_too_large')
    expect(await totalEvents()).toBe(before)
  })

  it('refuses a batch over 50 events with the cap it hit, not a generic envelope error', async () => {
    const before = await totalEvents()
    const events = Array.from({ length: COLLECT_MAX_BATCH_EVENTS + 1 }, () =>
      pageView(`/en/${RUN}`),
    )
    const response = await post(TRADING_ISO, batch({ events }), { cookie: CONSENTED })
    expect(response.status).toBe(400)
    // `batch_too_large` and not `invalid_envelope`: the schema would refuse this too, truthfully and
    // uselessly. A collector whose queue is not being split needs to be told which cap it hit.
    expect(await refusalOf(response)).toBe('batch_too_large')
    expect(await totalEvents()).toBe(before)

    // The control: exactly the cap is accepted, so the refusal is about the 51st event rather than about
    // fifty being too many.
    const atCap = Array.from({ length: COLLECT_MAX_BATCH_EVENTS }, () => pageView(`/en/${RUN}`))
    const accepted = await post(TRADING_ISO, batch({ events: atCap }), { cookie: CONSENTED })
    expect(accepted.status).toBe(204)
  })

  it('refuses an unknown extra property, in the envelope and in an event, and writes nothing', async () => {
    const before = await totalEvents()
    const envelope = await post(
      TRADING_ISO,
      { ...batch(), sessionId: 'mine' },
      { cookie: CONSENTED },
    )
    expect(envelope.status).toBe(400)
    expect(await refusalOf(envelope)).toBe('invalid_envelope')

    const event = await post(
      TRADING_ISO,
      batch({
        events: [{ ...pageView(`/en/${RUN}`), visitorId: 'mine' }],
      }),
      { cookie: CONSENTED },
    )
    expect(event.status).toBe(400)
    expect(await refusalOf(event)).toBe('invalid_envelope')
    expect(await totalEvents()).toBe(before)
  })

  it('refuses bytes that are not JSON, by name', async () => {
    const response = await post(TRADING_ISO, 'not json at all', { cookie: CONSENTED })
    expect(response.status).toBe(400)
    expect(await refusalOf(response)).toBe('malformed_json')
  })
})

// ------------------------------------------------------------------------------------------------
// Acceptance 6: the per-visitor rate limit
// ------------------------------------------------------------------------------------------------

describe('the per-visitor rate limit', () => {
  it('answers 429 without writing, over 200 requests inside a frozen second', async () => {
    /*
     * The acceptance line, literally: 200 requests, one instant. Frozen is what makes it a claim about the
     * limiter rather than about how fast this machine is — 200 real requests on a loaded container might take
     * two seconds, at which point the window has slid and the test measures the machine (brief rule 23).
     *
     * The deps are shared across all 200 so the hit list accumulates, which is the one thing a per-case map
     * would prevent.
     */
    const first = await post(TRADING_ISO, batch(), { cookie: CONSENTED })
    const visitorId = visitorIdOf(first) as string
    const cookie = `${CONSENTED}; ${VISITOR_COOKIE}=${visitorId}`
    const deps = depsAt(TRADING_ISO)
    const before = await countsFor(visitorId)

    let accepted = 0
    let refused = 0
    let retryAfter: string | null = null
    for (let request = 0; request < 200; request += 1) {
      const response = await post(TRADING_ISO, batch(), { cookie, deps })
      if (response.status === 204) accepted += 1
      else {
        expect(response.status).toBe(429)
        expect(await refusalOf(response)).toBe('rate_limited')
        retryAfter = retryAfter ?? response.headers.get('retry-after')
        refused += 1
      }
    }
    expect(refused).toBeGreaterThan(0)
    expect(accepted + refused).toBe(200)
    // A well-behaved client is told when to come back, and never "now".
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1)

    // The refusals wrote nothing: the visitor's event count moved by exactly the number of accepted
    // requests, one event each.
    const after = await countsFor(visitorId)
    expect(after.events - before.events).toBe(accepted)
  }, 30_000)
})

// ------------------------------------------------------------------------------------------------
// What A-FIRST-04 deferred here, and what the daytime gap does
// ------------------------------------------------------------------------------------------------

describe('the bot flag A-FIRST-04 deferred to this unit', () => {
  it('STORES and flags a declared crawler’s events rather than dropping them', async () => {
    /*
     * ADR 0062: a user agent is a claim, so no verdict may refuse, gate or authorise anything. The failure
     * this refuses is the one that looks like an optimisation — one `if` that saves a write — and it would
     * be invisible, because the rows it dropped are rows nobody counted.
     *
     * The agent's token and the kind it must classify as come from `AI_CRAWLER_FETCHERS`, the one table the
     * robots policy and the classifier both read, and NOT from a literal here. A-FIRST-04 asked for exactly
     * that of every call site it deferred to, and `apps/web/src/crawler-policy.test.ts` enforces it by
     * scanning for a crawler name written anywhere else — which is the check that caught this file writing
     * one. A literal would also have been a third copy of the list the whole arrangement exists to have one
     * of.
     */
    const crawler = AI_CRAWLER_FETCHERS[0]
    expect(
      crawler,
      'the shared crawler table holds no fetcher, so this case tests nothing',
    ).toBeDefined()
    const fetcher = crawler as { readonly token: string; readonly botKind: string }
    const response = await post(TRADING_ISO, batch(), {
      cookie: CONSENTED,
      userAgent: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ${fetcher.token}/1.2`,
    })
    expect(response.status).toBe(204)
    const visitorId = visitorIdOf(response) as string
    const sessions = await sessionsOf(visitorId)
    expect((sessions[0] as SessionRow).bot).toBe(true)
    expect((sessions[0] as SessionRow).bot_kind).toBe(fetcher.botKind)
    // The events are there. This is the half that matters: flagged, not dropped.
    expect((await eventsOf((sessions[0] as SessionRow).session_id)).length).toBe(1)
  })

  it('flags a suspected headless client from signals alone, and stores its events too', async () => {
    const response = await post(
      TRADING_ISO,
      batch({
        viewportWidth: null,
        interactionCount: 0,
        interEventGapsMs: [500, 500, 500],
      }),
      {
        cookie: CONSENTED,
        userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15',
      },
    )
    const visitorId = visitorIdOf(response) as string
    const sessions = await sessionsOf(visitorId)
    expect((sessions[0] as SessionRow).bot).toBe(true)
    expect((sessions[0] as SessionRow).bot_kind).toBe('suspected_headless')
    expect((await eventsOf((sessions[0] as SessionRow).session_id)).length).toBe(1)
  })

  it('leaves a real phone unflagged, and records its device and breakpoint', async () => {
    const response = await post(TRADING_ISO, batch({ viewportWidth: 390 }), {
      cookie: CONSENTED,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    })
    const visitorId = visitorIdOf(response) as string
    const session = (await sessionsOf(visitorId))[0] as SessionRow
    expect(session.bot).toBe(false)
    expect(session.bot_kind).toBeNull()
    expect(session.device_kind).toBe('mobile')
    expect(session.breakpoint).toBe('xs')
  })

  it('records a desktop viewport at the breakpoint the layout uses', async () => {
    const response = await post(TRADING_ISO, batch({ viewportWidth: 1440 }), { cookie: CONSENTED })
    const visitorId = visitorIdOf(response) as string
    const session = (await sessionsOf(visitorId))[0] as SessionRow
    expect(session.device_kind).toBe('desktop')
    expect(session.breakpoint).toBe('xl')
  })

  it('records `unknown` for a client that reported no viewport', async () => {
    const response = await post(TRADING_ISO, batch({ viewportWidth: null, interactionCount: 4 }), {
      cookie: CONSENTED,
    })
    const visitorId = visitorIdOf(response) as string
    const session = (await sessionsOf(visitorId))[0] as SessionRow
    expect(session.device_kind).toBe('unknown')
    expect(session.breakpoint).toBe('unknown')
  })
})

describe('a session that began in the daytime gap', () => {
  /**
   * 09:00 Asia/Dubai, which is inside the 02:00-11:00 gap: the premises is shut and `resolveTradingDate`
   * correctly answers that the instant belongs to no trading date, while web traffic carries on.
   */
  const GAP_ISO = '2026-09-29T05:00:00.000Z'

  it('is filed under the next day the calendar opens and SAYS the basis', async () => {
    const response = await post(
      GAP_ISO,
      {
        ...batch(),
        events: [
          {
            name: 'page_view',
            occurredAt: GAP_ISO,
            clientEventId: clientEventId(),
            payload: { path: `/en/${RUN}/gap`, entry: true },
          },
        ],
      },
      { cookie: CONSENTED },
    )
    expect(response.status).toBe(204)
    const visitorId = visitorIdOf(response) as string
    const session = (await sessionsOf(visitorId))[0] as SessionRow
    // Not `trading`. The whole point: nine hours a day of browsing must not read as daytime trade.
    expect(session.trading_date_basis).toBe('before_opening')
    // And the date it is filed under is the day about to open, which is the same calendar date here.
    expect(session.trading_date).toBe('2026-09-29')
  })

  it('cannot claim `trading` for an instant outside the window, by name', async () => {
    // ZY222. Without this the difference between "we attribute gap traffic and mark it" and "we attribute
    // gap traffic silently" is a comment.
    const [visitor] = await sql<{ visitor_id: string }[]>`
      insert into analytics.visitor (first_seen_at, last_seen_at)
      values (${GAP_ISO}::timestamptz, ${GAP_ISO}::timestamptz) returning visitor_id
    `
    const lying = await stateOf(sql`
      insert into analytics.session (
        visitor_id, started_at, last_event_at, trading_date, trading_date_basis,
        landing_path, device_kind, breakpoint, bot
      ) values (
        ${visitor?.visitor_id as string}::uuid, ${GAP_ISO}::timestamptz, ${GAP_ISO}::timestamptz,
        '2026-09-29', 'trading', '/en/lying', 'mobile', 'xs', false
      )
    `)
    expect(lying.code).toBe('ZY222')
    expect(lying.message).toContain('OUTSIDE')

    // The other direction, which a one-sided check would let through: a session that really did start inside
    // the window may not claim a gap reason either, or the same amount of information is lost the other way.
    const alsoLying = await stateOf(sql`
      insert into analytics.session (
        visitor_id, started_at, last_event_at, trading_date, trading_date_basis,
        landing_path, device_kind, breakpoint, bot
      ) values (
        ${visitor?.visitor_id as string}::uuid, ${TRADING_ISO}::timestamptz, ${TRADING_ISO}::timestamptz,
        '2026-09-29', 'before_opening', '/en/lying-too', 'mobile', 'xs', false
      )
    `)
    expect(alsoLying.code).toBe('ZY222')
    expect(alsoLying.message).toContain('INSIDE')

    // The control: the honest row is accepted, so the trigger refuses a disagreement rather than refusing
    // every insert.
    const honest = await stateOf(sql`
      insert into analytics.session (
        visitor_id, started_at, last_event_at, trading_date, trading_date_basis,
        landing_path, device_kind, breakpoint, bot
      ) values (
        ${visitor?.visitor_id as string}::uuid, ${GAP_ISO}::timestamptz, ${GAP_ISO}::timestamptz,
        '2026-09-29', 'before_opening', '/en/honest', 'mobile', 'xs', false
      )
    `)
    expect(honest.code).toBeUndefined()
  })

  it('counts a pre-consent landing in the gap under the same basis rather than refusing it', async () => {
    // The cohort this table exists for. A foreign key to `business_day` on the counter would have refused
    // the row and dropped exactly the traffic the denominator is about.
    const path = `/en/${RUN}/gap-pre-consent`
    const key = { bucketDate: '2026-09-29', basis: 'before_opening' as const, path }
    const before = (await readPreConsentLandings(sql, key)) ?? 0
    await post(GAP_ISO, {
      ...batch(),
      events: [
        {
          name: 'page_view',
          occurredAt: GAP_ISO,
          clientEventId: clientEventId(),
          payload: { path, entry: true },
        },
      ],
    })
    expect(await readPreConsentLandings(sql, key)).toBe(before + 1)
  })
})

// ------------------------------------------------------------------------------------------------
// The wiring: one request over real HTTP, which is the only thing a handler call cannot prove
// ------------------------------------------------------------------------------------------------

describe('the route as served', () => {
  it('accepts a consented batch over HTTP and issues the cookie', async () => {
    // `route.ts` builds the connection, the clock and the own-host list. A handler driven as a function
    // exercises none of the three, so this one case is what proves the endpoint exists at the path the
    // collector posts to and that its runtime assembles.
    const response = await fetch(`${BASE}${COLLECT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: CONSENTED },
      body: JSON.stringify(batch({ events: [pageView(`/en/${RUN}/over-http`)] })),
    })
    expect(response.status).toBe(204)
    const header = response.headers.get('set-cookie') as string
    expect(header).toContain(`${VISITOR_COOKIE}=`)
    expect(header).toContain('SameSite=Lax')

    const visitorId = new RegExp(`${VISITOR_COOKIE}=([^;]+)`).exec(header)?.[1] as string
    const session = (await sessionsOf(visitorId))[0] as SessionRow
    expect(session.landing_path).toBe(`/en/${RUN}/over-http`)
  })

  it('answers 400 with a named refusal over HTTP too, so the wiring does not swallow one', async () => {
    const response = await fetch(`${BASE}${COLLECT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: CONSENTED },
      body: '{',
    })
    expect(response.status).toBe(400)
    expect(await refusalOf(response)).toBe('malformed_json')
  })

  it('never answers a cacheable response, in either direction', async () => {
    // A `Set-Cookie` on a cacheable response is a first-party identifier served to the next visitor. Both
    // paths are asserted, because the pre-consent one returns 204 with no cookie and is the one somebody
    // would reasonably think is safe to cache.
    const consented = await fetch(`${BASE}${COLLECT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: CONSENTED },
      body: JSON.stringify(batch()),
    })
    expect(consented.headers.get('cache-control')).toContain('no-store')
    const preConsent = await fetch(`${BASE}${COLLECT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch()),
    })
    expect(preConsent.status).toBe(204)
    expect(preConsent.headers.get('set-cookie')).toBeNull()
    expect(preConsent.headers.get('cache-control')).toContain('no-store')
  })
})
