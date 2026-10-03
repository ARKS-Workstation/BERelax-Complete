import { buildEgressPayload, serialiseEgressPayload } from '@berelax/core'
import {
  createConnection,
  enqueueAnalyticsDispatch,
  recordDispatchAttempt,
  type Sql,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AGENT_CONSOLE_ANALYTICS_KEYS,
  agentConsole,
  analyticsAgentConsole,
} from '../app/(admin)/agents/queries.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The agent console's reads (A-MEAS-06), against a real database.
 *
 * ## Why this file is on the WEB side
 *
 * `app/(admin)/agents/queries.ts` is a web module and `apps/worker` does not import from `apps/web` —
 * `send-scheduled-step.itest.ts` records the same separation from the other direction. The watchdog's own
 * suite proves the heartbeat fields, the dead-letter state and the alert's class; this proves the thing
 * only the console can be asked: that the screen which arrives will be able to SEE a conversion that gave
 * up. A dead-letter queue nothing reads is the same defect one level down from a watchdog nothing watches,
 * so the reader needs a test of its own.
 *
 * ## The fixture is rolled back, and it has to be
 *
 * ZY711 refuses deleting a dead-lettered dispatch for every role including the owner, so a fixture that
 * reached `dead_letter` on the pool could never be removed and every later run would accumulate one. A
 * rollback is the only cleanup the state permits, which is the rule working rather than a difficulty.
 */
let sql: Sql

beforeAll(() => {
  sql = createConnection({ url, max: 4 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

const ROLLBACK = 'A-MEAS-06 rolled this console fixture back'

async function withDeadLetter<T>(body: (tx: Sql, dispatchId: string) => Promise<T>): Promise<T> {
  let carried: T | undefined
  try {
    await sql.begin(async (raw) => {
      const tx = raw as unknown as Sql
      const [visitor] = await tx<{ visitor_id: string }[]>`
        insert into analytics.visitor (first_seen_at, last_seen_at) values (now(), now())
        returning visitor_id::text as visitor_id
      `
      const [session] = await tx<{ session_id: string }[]>`
        insert into analytics.session (
          visitor_id, started_at, last_event_at, trading_date, trading_date_basis, landing_path,
          device_kind, breakpoint, bot,
          consent_ad_storage, consent_ad_user_data, consent_ad_personalization,
          consent_analytics_storage
        )
        select ${visitor?.visitor_id as string}::uuid, b.opens_at, b.opens_at, b.trading_date,
               'trading', '/en/console-fixture', 'desktop', 'lg', false, true, true, true, true
          from public.business_day b
         where b.closes_at <= now()
         order by b.closes_at desc
         limit 1
        returning session_id::text as session_id
      `
      // The destination read out of the catalogue rather than named: 0125 keys the consent gate on the
      // CAPABILITY, and `dispatch_consent_gap` refuses a destination with no row — so a provider's trade
      // name here would be refused for a reason nothing in this file is about.
      const [destination] = await tx<{ destination: string }[]>`
        select destination from analytics_dispatch_destination order by destination limit 1
      `
      const [day] = await tx<{ opens_at: Date }[]>`
        select opens_at from public.business_day where closes_at <= now()
         order by closes_at desc limit 1
      `
      if (day === undefined) {
        // Named rather than non-null-asserted: ZY702 and the gate both need a day that has CLOSED, and
        // `(day?.x as Date).getTime()` throws several frames from the query that actually found nothing.
        throw new Error('the trading calendar holds no day that has closed; run `pnpm seed`')
      }
      const decidedAtIso = new Date(day.opens_at.getTime() + 3_600_000).toISOString()
      const { payload } = buildEgressPayload({
        ref: { kind: 'package_template' },
        eventType: 'paid',
        quantity: 1,
        valueFils: 26_250,
      })
      const enqueued = await enqueueAnalyticsDispatch(tx, {
        sessionId: session?.session_id as string,
        destination: destination?.destination as string,
        funnelStage: 'paid',
        decidedAtIso,
        eventId: `console${Date.now().toString(16)}`,
        // Serialised through `@berelax/core`'s own function rather than `@berelax/analytics`'
        // `dispatchPayloadBytes`: `apps/web` does not depend on that package, and adding a dependency to
        // the web application's graph for a fixture would widen what the client bundle can reach for a
        // reason that has nothing to do with the web application. The two are the same serialiser.
        payload: serialiseEgressPayload(payload),
        actionSource: 'website',
        occurredAtIso: decidedAtIso,
      })
      await recordDispatchAttempt(tx, {
        dispatchId: enqueued.dispatchId,
        outcome: 'failed',
        atIso: decidedAtIso,
        error: 'rate_limited at the last attempt the budget allows',
        retryable: false,
        budgetExhausted: true,
      })
      carried = await body(tx, enqueued.dispatchId)
      throw new Error(ROLLBACK)
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error
  }
  return carried as T
}

describe('the agent console', () => {
  it('shows every agent with all four heartbeat fields, and the dead letters beside them', async () => {
    const seen = await withDeadLetter(async (tx, dispatchId) => ({
      whole: await agentConsole(tx),
      analytics: await analyticsAgentConsole(tx),
      dispatchId,
    }))

    // Every agent, not a list this module keeps: `agentsWithHeartbeat` INNER JOINS the two tables, so an
    // agent with no heartbeat row is invisible here exactly as it is to the watchdog — which is the state
    // 0021's convention and `pnpm jobs` exist to make impossible, and not something a console should
    // paper over with an outer join.
    expect(seen.whole.agents.length).toBeGreaterThan(10)
    const dispatcher = seen.whole.agents.find((agent) => agent.agentKey === 'analytics_dispatch')
    expect(dispatcher).not.toBeUndefined()
    // The four fields the acceptance line names, present as keys whatever their values: a console that
    // could not render `nextRunAtIso` cannot tell a slow agent from a stopped one.
    for (const key of ['lastRunAtIso', 'lastSuccessAtIso', 'nextRunAtIso', 'lastError'] as const) {
      expect(Object.hasOwn(dispatcher ?? {}, key), key).toBe(true)
    }
    // The dead letter is visible, with the provider's own last words on it — the only record of why the
    // conversion will never go out.
    const row = seen.whole.deadLetters.find((entry) => entry.dispatchId === seen.dispatchId)
    expect(row, 'the console must be able to see a conversion that gave up').not.toBeUndefined()
    expect(row?.lastError).toContain('rate_limited')
    expect(row?.attempts).toBeGreaterThan(0)
    // And the analytics view is a NARROWING of the same answer rather than a second query: the three
    // keys, and the same dead letters, because the queue is not an agent's property.
    expect(seen.analytics.agents.map((agent) => agent.agentKey).sort()).toEqual(
      [...AGENT_CONSOLE_ANALYTICS_KEYS].sort(),
    )
    expect(seen.analytics.deadLetters.map((entry) => entry.dispatchId)).toContain(seen.dispatchId)
  })

  it('refuses a dead-letter read that would show an empty console', async () => {
    // ADR 0002 in the place it matters most: a limit of zero renders nothing and reads as a clean
    // pipeline. The control is the ordinary limit, which is accepted.
    await expect(agentConsole(sql, { deadLetterLimit: 0 })).rejects.toThrow('limit of 0')
    await expect(agentConsole(sql, { deadLetterLimit: 5 })).resolves.toBeTruthy()
  })
})
