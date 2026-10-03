import {
  ANALYTICS_MAX_ATTEMPTS,
  actionSourceFor,
  analyticsEventId,
  BOOKING_SOURCE_ACTION_SOURCE,
  BOOKING_SOURCES,
  type BookingSource,
  createAnalyticsDispatchers,
  DISPATCH_DESTINATIONS,
  dispatchPayloadBytes,
} from '@berelax/analytics'
import type { Config } from '@berelax/config'
import {
  buildEgressPayload,
  consentGatedTargetsOn,
  serialiseEgressPayload,
  unpermittedEgressTokens,
} from '@berelax/core'
import {
  createConnection,
  dueAnalyticsDispatches,
  enqueueAnalyticsDispatch,
  type Sql,
} from '@berelax/db'
import {
  CONSENT_MODE_SIGNALS,
  type ConsentModeSignal,
  FUNNEL_TERMINAL_STAGE,
  type FunnelStage,
} from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ANALYTICS_RETRY_LADDER, runAnalyticsDispatchPass } from './analytics-dispatch.ts'

/**
 * The dispatch consumer against a real PostgreSQL (A-MEAS-03).
 *
 * ## Why this file is in `apps/worker/src/jobs` and not in `packages/fixtures`
 *
 * Its subject is the PASS, which is this directory's, and that is where a suite about a worker pass lives
 * — `gratuity-accrual.itest.ts` and `automation/interpreter.itest.ts` are the precedent. The first draft
 * put it in `packages/fixtures` and imported the pass by a relative path, reasoning that
 * `nothing-imports-an-app` forbids the package import; `pnpm boundaries` refused it, and the refusal is
 * right — the rule matches the resolved module and not the spelling of the specifier, so the relative path
 * was the same violation written differently. An app is an entry point, and the thing that reaches into it
 * is its own suite.
 *
 * Nothing is lost by the move. The four pairs below need `@berelax/core` and `@berelax/db` in one file,
 * which `packages/fixtures` exists to allow — and `apps/worker` already depends on both, because the pass
 * itself does. It holds four pairs equal:
 *
 *   - the `BOOKING_SOURCES` tuple in `@berelax/analytics` against `booking_source_check` as the DATABASE
 *     holds it, in both directions — the second statement the port's own header admits to, arriving with
 *     the check (brief: "if you must write one twice, add the check that holds the two equal");
 *   - the registry's `DISPATCH_DESTINATIONS` against `CONSENT_GATED_TARGETS`' server-dispatch surface, so
 *     an adapter cannot be missing for a destination the gate will enqueue to;
 *   - the id the ON-PAGE TAG would derive against the `event_id` stored on the row the server enqueued,
 *     which is the first acceptance line and the one claim that is about two surfaces agreeing;
 *   - the branded payload the guard built against the bytes the row stores and the adapter posts.
 *
 * `packages/db` may never import `packages/core` (ADR 0001) and `packages/core` may reach no
 * infrastructure, so these four can only be held equal somewhere that may see both — which is
 * `packages/fixtures` and, for a pass's own suite, the app that already depends on both.
 *
 * ## What it deletes
 *
 * Its own visitors (ADR 0050). Sessions and dispatch rows go with them by `on delete cascade`, which is
 * the arrangement 0125 chose — so there is no hand-written table list here and nothing to go stale
 * against a migration. `analytics.consent_record` is append-only and nothing here touches it.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql
const createdVisitors: string[] = []

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
})

afterAll(async () => {
  if (sql !== undefined && createdVisitors.length > 0) {
    await sql`delete from analytics.visitor where visitor_id = any(${createdVisitors}::uuid[])`
  }
  await sql?.end({ timeout: 5 })
})

const AT = '2026-10-02T09:00:00.000Z'

/**
 * The terminal funnel stage, narrowed ONCE.
 *
 * `FUNNEL_TERMINAL_STAGE` is derived by indexing the tuple at `length - 1`, and
 * `noUncheckedIndexedAccess` makes that `FunnelStage | undefined`. A `?? 'paid'` here would be the second
 * statement of which stage is terminal — exactly what the taxonomy module exists to prevent — so the
 * narrowing is a refusal instead: it fails loudly, at import, if the tuple is ever empty.
 *
 * Narrowed inside a function that RETURNS the stage, rather than by a bare `if` beside the `const`.
 * TypeScript does not carry a module-level narrowing into a hoisted `function` declaration — such a
 * function could be called before the check ran — so `queuedConversion` below saw `FunnelStage |
 * undefined` and `pnpm typecheck` refused two of its arguments. The annotation on the `const` is what
 * makes the narrowing a property of the binding instead of of the position.
 */
const TERMINAL: FunnelStage = ((stage: FunnelStage | undefined): FunnelStage => {
  if (stage === undefined) {
    throw new Error(
      'FUNNEL_STAGES is empty, so there is no terminal stage to dispatch a conversion for.',
    )
  }
  return stage
})(FUNNEL_TERMINAL_STAGE)

/** Everything granted, because this file's subject is the TRANSPORT and not the gate. */
const ALL_SIGNALS: readonly ConsentModeSignal[] = CONSENT_MODE_SIGNALS

/**
 * A session with a stated consent claim, on a seeded trading day.
 *
 * `started_at` is the day's own `opens_at` and the day is the one NEAREST now, which is the arrangement
 * `analytics-consent.itest.ts` arrived at: `analytics.assert_session_trading_basis` (ZY222) holds the
 * basis against `business_day`'s stored window in both directions, and the nearest-day choice is what
 * stops this suite failing depending on the hour it runs in.
 */
async function sessionWith(
  granted: readonly ConsentModeSignal[],
): Promise<{ readonly visitorId: string; readonly sessionId: string }> {
  const set = new Set(granted)
  const [visitor] = await sql<{ visitor_id: string }[]>`
    insert into analytics.visitor (first_seen_at, last_seen_at) values (now(), now())
    returning visitor_id
  `
  const visitorId = visitor?.visitor_id as string
  createdVisitors.push(visitorId)
  const [session] = await sql<{ session_id: string }[]>`
    insert into analytics.session (
      visitor_id, started_at, last_event_at, trading_date, trading_date_basis, landing_path,
      device_kind, breakpoint, bot,
      consent_ad_storage, consent_ad_user_data, consent_ad_personalization,
      consent_analytics_storage
    )
    select ${visitorId}::uuid, b.opens_at, b.opens_at, b.trading_date, 'trading', '/en/dispatch-fixture',
           'desktop', 'lg', false,
           ${set.has('ad_storage')}, ${set.has('ad_user_data')},
           ${set.has('ad_personalization')}, ${set.has('analytics_storage')}
      from public.business_day b
     order by abs(extract(epoch from (b.opens_at - now())))
     limit 1
    returning session_id
  `
  return { visitorId, sessionId: session?.session_id as string }
}

/** A terminal-stage payload, built by the one builder. */
const conversionPayload = (valueFils: number) =>
  buildEgressPayload({
    ref: { kind: 'package_template' },
    eventType: TERMINAL,
    quantity: 1,
    valueFils,
  }).payload

const config = (overrides: Partial<Config> = {}): Config =>
  ({ APP_ENV: 'test', ANALYTICS_PROVIDER: 'fake', ...overrides }) as Config

const dispatchers = (appEnv: 'test' | 'production' = 'test') =>
  createAnalyticsDispatchers({ config: config({ APP_ENV: appEnv }), now: () => AT })

// ------------------------------------------------------------------------------------------------
// The two statements this file exists to hold equal
// ------------------------------------------------------------------------------------------------

describe('the booking-source vocabulary', () => {
  it('is the same set the database admits, in both directions', async () => {
    const [row] = await sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conrelid = 'public.booking'::regclass
         and conname = 'booking_source_check'
    `
    expect(row?.definition, 'the CHECK must exist or this case measures nothing').toBeTruthy()
    const inDatabase = [...(row?.definition ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    // Both directions. A value in the database and not in the table makes `actionSourceFor` throw for a
    // real booking; one in the table and not in the database is a branch nothing can reach, which looks
    // like coverage and is not.
    expect(inDatabase).toEqual([...BOOKING_SOURCES].sort())
    // The action-source table is total over the sources a LIVE booking may have, which is every value
    // the database admits EXCEPT `import`. Migration 0130 (H-MIG-05) added that one for a reconstructed
    // visit, and the legacy file does not say where such a booking was taken — so there is no action
    // source to declare, and `actionSourceFor` refuses it by the same path it refuses an unknown value.
    // Asserted as a set difference rather than a hand-written list of four, so the next widening of the
    // CHECK fails here instead of silently leaving a value unmapped.
    expect(Object.keys(BOOKING_SOURCE_ACTION_SOURCE).sort()).toEqual(
      inDatabase.filter((value) => value !== 'import'),
    )
    expect(() => actionSourceFor('import')).toThrow(/no action source is declared/)
  })
})

describe('the registry and the consent gate', () => {
  it('serves exactly the destinations the gate enqueues to', () => {
    // A destination the gate will write a `queued` row for and no adapter serves is a row that stays
    // queued for ever — which reads exactly like a consumer that stopped running.
    expect([...DISPATCH_DESTINATIONS].sort()).toEqual(
      [...consentGatedTargetsOn('server_dispatch')].sort(),
    )
  })

  it('serves exactly the destinations the DATABASE declares', async () => {
    const rows = await sql<{ destination: string }[]>`
      select destination from analytics_dispatch_destination order by destination
    `
    expect(rows.map((row) => row.destination)).toEqual([...DISPATCH_DESTINATIONS].sort())
  })
})

// ------------------------------------------------------------------------------------------------
// One event_id, on both surfaces, stable across retries
// ------------------------------------------------------------------------------------------------

describe('the shared event id', () => {
  it('is the value an on-page tag would derive, stored on the row the server enqueued', async () => {
    const { sessionId } = await sessionWith(ALL_SIGNALS)
    const bookingId = '0193f2c1-0000-7000-8000-00000000aa01'
    // What the SERVER computes, at enqueue.
    const serverSide = analyticsEventId({
      kind: 'booking',
      aggregateId: bookingId,
      stage: TERMINAL,
    })
    const enqueued = await enqueueAnalyticsDispatch(sql, {
      sessionId,
      destination: 'analytics_measurement_push',
      funnelStage: TERMINAL,
      decidedAtIso: AT,
      eventId: serverSide,
      payload: dispatchPayloadBytes(conversionPayload(32_010)),
      actionSource: 'website',
      occurredAtIso: AT,
    })
    expect(enqueued.state).toBe('queued')

    // What the CLIENT TAG computes, from the same three facts and nothing it was told. A-MEAS-04 owns the
    // loader; the derivation it will call is this one, and this is the equality the acceptance line names.
    const clientSide = analyticsEventId({
      kind: 'booking',
      aggregateId: bookingId,
      stage: TERMINAL,
    })
    const [stored] = await sql<{ event_id: string }[]>`
      select event_id from analytics_dispatch where dispatch_id = ${enqueued.dispatchId}::uuid
    `
    expect(stored?.event_id).toBe(clientSide)
    expect(clientSide).toBe(serverSide)
    // The control: a DIFFERENT booking does not share it, so the equality above is not two constants.
    expect(
      analyticsEventId({
        kind: 'booking',
        aggregateId: '0193f2c1-0000-7000-8000-00000000aa02',
        stage: TERMINAL,
      }),
    ).not.toBe(clientSide)
  })

  it('writes no second dispatch when the outbox event is replayed', async () => {
    const { sessionId } = await sessionWith(ALL_SIGNALS)
    const eventId = analyticsEventId({
      kind: 'invoice',
      aggregateId: '0193f2c1-0000-7000-8000-00000000bb01',
      stage: TERMINAL,
    })
    const payload = dispatchPayloadBytes(conversionPayload(12_500))
    const first = await enqueueAnalyticsDispatch(sql, {
      sessionId,
      destination: 'analytics_measurement_push',
      funnelStage: TERMINAL,
      decidedAtIso: AT,
      eventId,
      payload,
      actionSource: 'website',
      occurredAtIso: AT,
    })
    const replay = await enqueueAnalyticsDispatch(sql, {
      sessionId,
      destination: 'analytics_measurement_push',
      funnelStage: TERMINAL,
      decidedAtIso: AT,
      eventId,
      payload,
      actionSource: 'website',
      occurredAtIso: AT,
    })
    expect(first.alreadyPresent).toBe(false)
    // The acceptance line: the replay writes nothing, and it SAYS it wrote nothing rather than reporting
    // itself as a second push.
    expect(replay.alreadyPresent).toBe(true)
    expect(replay.dispatchId).toBe(first.dispatchId)
    const [{ n } = { n: '0' }] = await sql<{ n: string }[]>`
      select count(*)::text as n from analytics_dispatch
       where event_id = ${eventId} and destination = 'analytics_measurement_push'
    `
    expect(n).toBe('1')
    // And the index is per DESTINATION, so the same conversion may go to both platforms.
    const other = await enqueueAnalyticsDispatch(sql, {
      sessionId,
      destination: 'advertising_conversion_push',
      funnelStage: TERMINAL,
      decidedAtIso: AT,
      eventId,
      payload,
      actionSource: 'website',
      occurredAtIso: AT,
    })
    expect(other.alreadyPresent).toBe(false)
    expect(other.dispatchId).not.toBe(first.dispatchId)
  })
})

// ------------------------------------------------------------------------------------------------
// The pass: the guard, the 429 and the one delivery
// ------------------------------------------------------------------------------------------------

/**
 * Enqueues one conversion for a fresh session and returns what the consumer will see.
 *
 * No booking and no invoice row: `action_source` and `occurred_at` are COLUMNS 0137 added, written by the
 * enqueuer, because nothing in this schema links an analytics session to the booking it produced. An
 * earlier draft of this suite built a booking and an invoice and had the repository join them to the
 * session through `analytics.funnel_step` — which joins on nothing at all, and produced a confident
 * action source for an arbitrary booking. The join is gone and so is the fixture.
 *
 * The action source is still MAPPED rather than written, through `BOOKING_SOURCE_ACTION_SOURCE`, because
 * that is what the real enqueuer does and the mapping is the acceptance line's own subject.
 */
async function queuedConversion(options: {
  /**
   * A LIVE booking's source. `import` is excluded because no action source is declared for it:
   * a reconstructed visit (migration 0130) is never dispatched as a conversion, and
   * `actionSourceFor` refuses it.
   */
  readonly bookingSource: Exclude<BookingSource, 'import'>
  readonly aggregateId: string
  readonly destination?: string
  /** When the conversion happened. Defaults to the decision instant, which is a LIVE conversion. */
  readonly occurredAtIso?: string
}): Promise<{ readonly dispatchId: string; readonly eventId: string; readonly sessionId: string }> {
  const { sessionId } = await sessionWith(ALL_SIGNALS)
  const eventId = analyticsEventId({
    kind: 'invoice',
    aggregateId: options.aggregateId,
    stage: TERMINAL,
  })
  const enqueued = await enqueueAnalyticsDispatch(sql, {
    sessionId,
    destination: options.destination ?? 'analytics_measurement_push',
    funnelStage: TERMINAL,
    decidedAtIso: AT,
    eventId,
    payload: dispatchPayloadBytes(conversionPayload(32_010)),
    actionSource: BOOKING_SOURCE_ACTION_SOURCE[options.bookingSource],
    occurredAtIso: options.occurredAtIso ?? AT,
  })
  expect(enqueued.state, 'the fixture must have something queued to drain').toBe('queued')
  return { dispatchId: enqueued.dispatchId, eventId, sessionId }
}

describe('the pass', () => {
  it('records a diverted dispatch as sent, with the local outbox row as the receipt', async () => {
    const { dispatchId } = await queuedConversion({
      bookingSource: 'walk_in',
      aggregateId: '0193f2c1-0000-7000-8000-00000000cc01',
    })
    const registry = dispatchers('test')
    const result = await runAnalyticsDispatchPass(sql, registry, AT)
    expect(result.claimed).toBeGreaterThanOrEqual(1)

    const [row] = await sql<{ state: string; attempts: number; transmitted_at: string | null }[]>`
      select state::text as state, attempts, transmitted_at::text as transmitted_at
        from analytics_dispatch where dispatch_id = ${dispatchId}::uuid
    `
    expect(row?.state).toBe('sent')
    expect(row?.attempts).toBe(1)
    expect(row?.transmitted_at).not.toBeNull()

    // Nothing left the building, and the proof is the outbox row rather than the dispatch row: APP_ENV is
    // a property of the deployment and not of the row.
    const recorded = registry.outbox
      .all()
      .filter((entry) => entry.actionSource === 'physical_store')
    expect(recorded.length).toBeGreaterThanOrEqual(1)
    for (const entry of recorded) {
      expect(entry.transmitted).toBe(false)
      expect(entry.divertedReason).toContain('APP_ENV=test')
      expect(entry.body).not.toEqual({})
      // The payload the row stored is the payload the adapter posted, byte for byte.
      expect(entry.serialisedPayload).toBe(serialiseEgressPayload(conversionPayload(32_010)))
      expect(unpermittedEgressTokens(entry.serialisedPayload)).toEqual([])
    }
  })

  it('carries the action source the booking channel says, table-driven across all three', async () => {
    const cases = [
      {
        bookingSource: 'online',
        actionSource: 'website',
        aggregateId: '0193f2c1-0000-7000-8000-00000000dd01',
      },
      {
        bookingSource: 'phone',
        actionSource: 'phone_call',
        aggregateId: '0193f2c1-0000-7000-8000-00000000dd02',
      },
      {
        bookingSource: 'walk_in',
        actionSource: 'physical_store',
        aggregateId: '0193f2c1-0000-7000-8000-00000000dd03',
      },
    ] as const
    for (const { bookingSource, actionSource, aggregateId } of cases) {
      const { eventId } = await queuedConversion({ bookingSource, aggregateId })
      const registry = dispatchers('test')
      await runAnalyticsDispatchPass(sql, registry, AT)
      const entry = registry.outbox.all().find((row) => row.eventId === eventId)
      expect(entry, `${bookingSource} must have produced an outbox row`).toBeDefined()
      expect(entry?.actionSource).toBe(actionSource)
    }
  })

  it('backs off a 429 and yields exactly ONE successful delivery for the pair', async () => {
    const { dispatchId, eventId } = await queuedConversion({
      bookingSource: 'online',
      aggregateId: '0193f2c1-0000-7000-8000-00000000ee01',
    })
    const registry = dispatchers('test')
    // One 429, which is the acceptance line's own fixture.
    registry.script.arm('rate_limited', 1)
    await runAnalyticsDispatchPass(sql, registry, AT)

    const afterRefusal = await sql<
      { state: string; attempts: number; last_error: string | null }[]
    >`
      select state::text as state, attempts, last_error
        from analytics_dispatch where dispatch_id = ${dispatchId}::uuid
    `
    // Back to `queued` — the ZY312 trigger re-judged it on the way, which is what makes a retry after a
    // withdrawal impossible — with the attempt counted and the refusal named.
    expect(afterRefusal[0]?.state).toBe('queued')
    expect(afterRefusal[0]?.attempts).toBe(1)
    expect(afterRefusal[0]?.last_error).toContain('rate_limited')
    // And nothing was recorded as a push: the refusal is on the row, not in the outbox.
    expect(registry.outbox.all().filter((row) => row.eventId === eventId)).toHaveLength(0)

    /*
     * Not due yet, which is the backoff — asserted about THIS dispatch rather than about the pass's total.
     *
     * `claimed === 0` was the first spelling and it is a claim about the whole table: the integration
     * suite runs sequentially against one database and an earlier file's queued row would fail it (brief
     * rule 12). What the backoff actually says is that this row is not due at this instant and is due
     * later, and that is what the two reads below measure.
     */
    const dueNow = await dueAnalyticsDispatches(sql, {
      nowIso: AT,
      backoffSeconds: ANALYTICS_RETRY_LADDER,
      limit: 200,
    })
    expect(dueNow.some((entry) => entry.dispatchId === dispatchId)).toBe(false)
    const immediate = await runAnalyticsDispatchPass(sql, registry, AT)
    expect(immediate.sent).toBe(0)

    // Past the first delay, it is due and it goes. The control for the read above: the same query at a
    // later instant DOES return it, so "not due" was about the delay and not about the query missing it.
    const later = new Date(Date.parse(AT) + 10 * 60 * 1000).toISOString()
    expect(
      (
        await dueAnalyticsDispatches(sql, {
          nowIso: later,
          backoffSeconds: ANALYTICS_RETRY_LADDER,
          limit: 200,
        })
      ).some((entry) => entry.dispatchId === dispatchId),
    ).toBe(true)
    await runAnalyticsDispatchPass(sql, registry, later)
    const settled = await sql<{ state: string; attempts: number }[]>`
      select state::text as state, attempts
        from analytics_dispatch where dispatch_id = ${dispatchId}::uuid
    `
    expect(settled[0]?.state).toBe('sent')
    expect(settled[0]?.attempts).toBe(2)
    // EXACTLY one delivery for the pair, which is the acceptance line. One outbox row, and one row in the
    // table — the second is the unique index's doing and the first is the pass's.
    expect(registry.outbox.all().filter((row) => row.eventId === eventId)).toHaveLength(1)
    const [{ n } = { n: '0' }] = await sql<{ n: string }[]>`
      select count(*)::text as n from analytics_dispatch where event_id = ${eventId}
    `
    expect(n).toBe('1')

    // And a sent row is never claimed again, whatever instant the pass runs at.
    const again = await runAnalyticsDispatchPass(sql, registry, later)
    expect(
      (
        await dueAnalyticsDispatches(sql, {
          nowIso: later,
          backoffSeconds: ANALYTICS_RETRY_LADDER,
          limit: 50,
        })
      ).some((row) => row.dispatchId === dispatchId),
    ).toBe(false)
    expect(again.sent).toBe(0)
  })

  it('leaves a dispatch whose payload cannot be accepted as failed, and stops retrying it', async () => {
    const { dispatchId } = await queuedConversion({
      bookingSource: 'online',
      aggregateId: '0193f2c1-0000-7000-8000-00000000ff01',
    })
    const registry = dispatchers('test')
    // A 400 is not retryable: retrying it five times produces five identical refusals and delays every
    // other row behind it.
    registry.script.arm('invalid_payload', 1)
    await runAnalyticsDispatchPass(sql, registry, AT)
    const [row] = await sql<{ state: string; reason: string | null; last_error: string | null }[]>`
      select state::text as state, reason, last_error
        from analytics_dispatch where dispatch_id = ${dispatchId}::uuid
    `
    expect(row?.state).toBe('failed')
    expect(row?.reason).toBe('transport_failed')
    expect(row?.last_error).toContain('invalid_payload')
  })

  it('carries the instant the conversion HAPPENED and never the instant of the pass', async () => {
    // A-MEAS-05's subject, asserted here because the column and the adapter are this unit's: a conversion
    // that happened two days before the gate judged it is dated on the visit, not on the drain.
    const occurredAtIso = new Date(Date.parse(AT) - 2 * 24 * 60 * 60 * 1000).toISOString()
    const { eventId } = await queuedConversion({
      bookingSource: 'walk_in',
      aggregateId: '0193f2c1-0000-7000-8000-000000011101',
      occurredAtIso,
    })
    const registry = dispatchers('test')
    // Deliberately a LATER instant than either, so "now" and "the decision" are both distinguishable
    // from the answer.
    const passAt = new Date(Date.parse(AT) + 60 * 60 * 1000).toISOString()
    await runAnalyticsDispatchPass(sql, registry, passAt)
    const entry = registry.outbox.all().find((row) => row.eventId === eventId)
    expect(entry?.eventTimeIso).toBe(occurredAtIso)
    expect(entry?.eventTimeIso).not.toBe(passAt)
    expect(entry?.eventTimeIso).not.toBe(AT)
    // And the body dates the conversion on it, in the platform's own unit.
    const data = (entry?.body['data'] ?? []) as readonly Record<string, unknown>[]
    const events = (entry?.body['events'] ?? []) as readonly { params: Record<string, unknown> }[]
    const dated = data[0]?.['event_time'] ?? events[0]?.params['timestamp_micros']
    expect(dated).toBeDefined()
  })

  it('refuses a dispatch whose destination no adapter serves, and leaves the row alone', async () => {
    // `analytics_dispatch_destination` is a table the gate reads and the registry is a separate list, so
    // a destination declared there and not here is a deployment somebody has to finish. The row must not
    // be skipped silently: a skipped row stays queued for ever and reads like a consumer that stopped.
    const { sessionId } = await sessionWith(ALL_SIGNALS)
    await sql`
      insert into analytics_dispatch_destination
        (destination, requires_ad_storage, requires_ad_user_data, requires_ad_personalization,
         requires_analytics_storage, reason)
      values ('fixture_unserved_push', false, false, false, true,
              'A destination this fixture declares and no adapter serves, to prove the consumer refuses '
              'rather than skipping. Removed in the same test.')
    `
    const eventId = analyticsEventId({
      kind: 'booking',
      aggregateId: '0193f2c1-0000-7000-8000-000000011201',
      stage: TERMINAL,
    })
    try {
      const enqueued = await enqueueAnalyticsDispatch(sql, {
        sessionId,
        destination: 'fixture_unserved_push',
        funnelStage: TERMINAL,
        decidedAtIso: AT,
        eventId,
        payload: dispatchPayloadBytes(conversionPayload(5_000)),
        actionSource: 'website',
        occurredAtIso: AT,
      })
      const registry = dispatchers('test')
      const result = await runAnalyticsDispatchPass(sql, registry, AT)
      expect(result.refusedForDestination).toBeGreaterThanOrEqual(1)
      const [row] = await sql<{ state: string; attempts: number }[]>`
        select state::text as state, attempts
          from analytics_dispatch where dispatch_id = ${enqueued.dispatchId}::uuid
      `
      // No attempt burnt, and nothing recorded as a push.
      expect(row?.state).toBe('queued')
      expect(row?.attempts).toBe(0)
      expect(registry.outbox.all().some((entry) => entry.eventId === eventId)).toBe(false)
      await sql`delete from analytics_dispatch where dispatch_id = ${enqueued.dispatchId}::uuid`
    } finally {
      // Removed whatever happened: the destination table is shared, and `analytics-consent.itest.ts`
      // asserts it equals `CONSENT_GATED_TARGETS` in both directions — a row left here fails that file
      // rather than this one, which is the cross-file failure the brief's rule 12 is about.
      await sql`delete from analytics_dispatch_destination where destination = 'fixture_unserved_push'`
    }
  })
})

// ------------------------------------------------------------------------------------------------
// The two refusals the database makes
// ------------------------------------------------------------------------------------------------

describe('the database refuses what the consumer must not do', () => {
  it('freezes a transmitted dispatch (ZY451)', async () => {
    const { dispatchId } = await queuedConversion({
      bookingSource: 'online',
      aggregateId: '0193f2c1-0000-7000-8000-000000012201',
    })
    await runAnalyticsDispatchPass(sql, dispatchers('test'), AT)
    for (const statement of [
      sql`update analytics_dispatch set payload = '{"eventType":"paid"}'::jsonb
           where dispatch_id = ${dispatchId}::uuid`,
      sql`update analytics_dispatch set event_id = 'rewritten'
           where dispatch_id = ${dispatchId}::uuid`,
      sql`update analytics_dispatch set state = 'queued', transmitted_at = null, reason = null
           where dispatch_id = ${dispatchId}::uuid`,
    ]) {
      // A-MEAS-07 compares internal truth against what was PUSHED, and a payload that can be rewritten
      // to match the corrected figure makes every variance zero.
      await expect(statement).rejects.toMatchObject({ code: 'ZY451' })
    }
  })

  it('refuses an attempt counter that decreases (ZY452)', async () => {
    const { dispatchId } = await queuedConversion({
      bookingSource: 'online',
      aggregateId: '0193f2c1-0000-7000-8000-000000013301',
    })
    const registry = dispatchers('test')
    registry.script.arm('rate_limited', 1)
    await runAnalyticsDispatchPass(sql, registry, AT)
    await expect(
      sql`update analytics_dispatch set attempts = 0 where dispatch_id = ${dispatchId}::uuid`,
    ).rejects.toMatchObject({ code: 'ZY452' })
    // The control: raising it is permitted, so the rule is about the DIRECTION rather than about the
    // column being read-only.
    await expect(
      sql`update analytics_dispatch set attempts = attempts + 1
           where dispatch_id = ${dispatchId}::uuid`,
    ).resolves.toBeDefined()
  })

  it('never lets a dispatch exceed the ladder, so a dead destination stops being retried', async () => {
    const { dispatchId } = await queuedConversion({
      bookingSource: 'online',
      aggregateId: '0193f2c1-0000-7000-8000-000000014401',
    })
    const registry = dispatchers('test')
    let at = AT
    for (let attempt = 0; attempt < ANALYTICS_MAX_ATTEMPTS + 2; attempt += 1) {
      /*
       * Armed for far MORE calls than one pass can make, and that is a correction rather than caution.
       * `arm(…, 1)` was the first spelling: a pass claims every row that is due, the earlier cases in
       * this file leave rows behind, and the single refusal went to whichever row `order by decided_at`
       * put first — so this dispatch was TRANSMITTED on the pass that was supposed to refuse it, and the
       * case failed naming the state rather than the arming. The script is shared on purpose (a rate
       * limit hits everything at once), so the fix is to refuse everything.
       */
      registry.script.arm('server_error', 50)
      await runAnalyticsDispatchPass(sql, registry, at)
      // Far enough forward to clear any delay the ladder holds.
      at = new Date(Date.parse(at) + 24 * 60 * 60 * 1000).toISOString()
    }
    const [row] = await sql<{ state: string; attempts: number }[]>`
      select state::text as state, attempts
        from analytics_dispatch where dispatch_id = ${dispatchId}::uuid
    `
    // `dead_letter` and not `failed` since migration 0151 (A-MEAS-06): exhausting the ladder is a
    // permanent failure that must be VISIBLE, while `failed` stays what a single non-retryable refusal
    // leaves behind. The two are different facts about a dead destination and the console reads them
    // differently.
    expect(row?.state).toBe('dead_letter')
    expect(row?.attempts).toBe(ANALYTICS_MAX_ATTEMPTS)
    // And it is not due again, which is what makes giving up a state somebody can see.
    // `ANALYTICS_RETRY_LADDER` and not a hand-written `[30, 60, 120, 240, 480]`, which was the first
    // spelling and is the brief's "a second statement of a fact drifts" in four lines: the real ladder has
    // one entry FEWER than the attempt ceiling — the last attempt is not followed by a wait — so the
    // written copy made a dispatch with every attempt spent read as due again.
    const due = await dueAnalyticsDispatches(sql, {
      nowIso: at,
      backoffSeconds: ANALYTICS_RETRY_LADDER,
      limit: 50,
    })
    expect(due.some((entry) => entry.dispatchId === dispatchId)).toBe(false)
  })
})
