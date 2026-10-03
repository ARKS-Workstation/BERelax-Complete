import { loadConfig } from '@berelax/config'
import {
  aedFrom,
  type Clock,
  type GatewayIntentId,
  type IdempotencyKey,
  type Instant,
  type PaymentGateway,
} from '@berelax/core'
import {
  type Actor,
  createConnection,
  readReconciliationExceptions,
  readReconciliationWatermark,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { applyGatewayEvents, createPaymentGateways } from '@berelax/payments'
import { beforeAll, describe, expect, it } from 'vitest'
import { JOB_REGISTRY } from '../registry.ts'
import {
  PAYMENT_RECONCILIATION_AGENT,
  PAYMENT_RECONCILIATION_JOB,
  runPaymentReconciliation,
} from './payment-reconciliation.ts'

/**
 * Y-PAY-05 — the pass that makes the ledger eventually correct when a webhook was never delivered.
 *
 * The diff is proved without a database by `packages/payments/src/reconcile.test.ts` and the four
 * refusals by `packages/fixtures/src/payment-reconciliation.itest.ts`. This file proves the five things
 * that are properties of the PASS, each of them an acceptance line:
 *
 *   1. **With 30% of webhooks dropped, local state equals gateway state for every intent in the fuzz
 *      run.** The drop is in the DELIVERY loop and not in the fake, because that is where a lost webhook
 *      actually happens: the gateway sent it and nothing received it, so the fake's own stream still has
 *      it — which is the only reason the pass can repair anything.
 *   2. **Each repair writes a `reconciliation_exception` with before/after and the missed event id, and
 *      the row count equals the number of CONSEQUENTIAL dropped events.** The fake emits every event
 *      twice, deliberately, so a dropped copy whose twin was delivered is inconsequential — and this
 *      suite counts the event IDS for which no copy arrived, which is what "consequential" means.
 *   3. **A second consecutive run produces zero repairs and zero journal entries.**
 *   4. **Killed mid-run and restarted, the pass reaches the same end state as an uninterrupted one**,
 *      compared by a checksum over two independently built populations.
 *   5. **An intent the gateway does not recognise is quarantined and alerted, never deleted.**
 *
 * ## Isolation (brief rule 12)
 *
 * Every pass here is NARROWED to the intents this run created. The real pass reads the whole population,
 * and a suite that did the same would ask the fake about every other suite's fixture intents — which it
 * has never heard of — and quarantine all of them into tables that refuse DELETE for every role (`ZY681`,
 * `ZY161`). So `narrowTo` exists for the suites and is absent from the job definition, and
 * `readIntentPositions`' own comment says so.
 *
 * The figures are this suite's own and none is a money figure anybody has to believe. The gateway is the
 * H02 fake; no provider has been chosen (`Y7-gateway`).
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** The acceptance line's figure. 500 intents, 1,000 events, 30% of deliveries dropped. */
const FUZZ_INTENTS = 500
const DROP_RATE = 0.3
const AUTHORISED_AED = 200

let sql: Sql
let nonce: string

const ACTOR: Actor = { kind: 'staff', label: 'Y-PAY-05 reconciliation itest' }

/**
 * The adapter name `payment_intent.gateway` holds, read from the gateway rather than written down.
 *
 * `cards.name` is the fake's own, and taking it from the object is what keeps this suite's rows joinable
 * to the pass: a literal here would be a second statement of the name, and the day the fake is replaced
 * the suite would insert intents the pass could never find.
 */
let GATEWAY_NAME: string

/** A clock that ADVANCES, so every gateway event carries its own instant and the fold orders by it. */
function tickingClock(fromIso: string): Clock {
  let ms = Date.parse(fromIso)
  return {
    now: () => {
      ms += 1_000
      return ms as Instant
    },
  }
}

/**
 * A fresh fake card gateway, through the REGISTRY and never through the adapter module.
 *
 * `createFakeCardGateway` is not exported from `@berelax/payments` on purpose: `createPaymentGateways` is
 * the chokepoint, and a repository-wide scan refuses a second way to reach an adapter. A suite that
 * imported the module directly would be driving a gateway nobody ships.
 *
 * `PAYMENT_PROVIDER` is `fake` in every non-production environment (ADR 0005), so this is the card
 * gateway this build actually has — there is no chosen provider (`Y7-gateway`).
 */
function cardGateway(): PaymentGateway {
  return createPaymentGateways({
    config: loadConfig(),
    clock: tickingClock('2099-12-25T10:00:00.000Z'),
  }).cards
}

/** A seeded 32-bit LCG, so a failure names a seed somebody can replay. */
const rng = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
}

interface Population {
  readonly prefix: string
  /**
   * The `payment_intent.gateway` value and the watermark's key, UNIQUE to this population.
   *
   * Each population gets a fresh fake, and a fresh fake restarts its cursor sequence at `evt_00000001`.
   * The watermark is keyed on the gateway NAME, so two populations sharing one name would have the
   * second's whole stream filtered out by the first's watermark — which is not a defect in the pass: in
   * production there is one gateway and its cursors are globally monotone, exactly as the port promises.
   * So from the pass's point of view two populations ARE two gateways, and this is what says so. The
   * suite's first run found this by reporting zero repairs for a population it had just dropped events
   * from.
   */
  readonly gatewayName: string
  /** `gateway_intent_id` to the local `payment_intent.id`. */
  readonly intents: ReadonlyMap<string, string>
  /** Every event id the gateway emitted, by intent. */
  readonly emitted: ReadonlyMap<string, readonly string[]>
  /** The event ids NO copy of which was delivered — the consequential drops. */
  readonly dropped: ReadonlySet<string>
  readonly gateway: PaymentGateway
}

/**
 * Builds a population: N intents authorised and captured at the gateway, with a share of the DELIVERIES
 * dropped.
 *
 * The drop is here and not in the fake, and that is the whole shape of the unit. A lost webhook is an
 * event the gateway SENT and nothing received: the gateway's own stream still holds it, which is the only
 * reason the pass can repair anything. A fake that dropped events from its own stream would be modelling
 * an event that never happened, and nothing could repair that.
 */
async function population(label: string, size: number, seed: number): Promise<Population> {
  const prefix = `YPAY05-${nonce}-${label}`
  const gatewayName = `${GATEWAY_NAME}-${nonce}-${label}`
  const random = rng(seed)
  const gateway = cardGateway()
  const intents = new Map<string, string>()
  const emitted = new Map<string, string[]>()
  const deliveredIds = new Set<string>()
  const allIds = new Set<string>()

  for (let index = 0; index < size; index += 1) {
    const reference = `${prefix}-${index}`
    const authorised = await gateway.authorise({
      amount: aedFrom(AUTHORISED_AED),
      instrument: 'card_online',
      idempotencyKey: `${reference}-auth` as IdempotencyKey,
      reference,
    })
    await gateway.capture({
      gatewayIntentId: authorised.gatewayIntentId,
      amount: aedFrom(AUTHORISED_AED),
      idempotencyKey: `${reference}-cap` as IdempotencyKey,
    })
    const [row] = await sql<{ id: string }[]>`
      insert into payment_intent (
        idempotency_key, gateway, gateway_intent_id, instrument, posting_account_code, requested_fils,
        reference
      ) values (
        ${`${reference}-ik`}, ${gatewayName}, ${authorised.gatewayIntentId as string},
        'card_online', '1030', ${AUTHORISED_AED * 100}, ${reference}
      )
      returning id
    `
    if (row === undefined) throw new Error('inserting a fuzz intent returned no row')
    intents.set(authorised.gatewayIntentId as string, row.id)
  }

  // The deliveries, with a share dropped. One transaction per delivered event, because that is what the
  // webhook path does — and because a pass that found every event already applied in one transaction
  // would not be exercising the per-intent grain the repair runs at.
  for (const delivery of await gateway.eventsSince(null)) {
    const localId = intents.get(delivery.gatewayIntentId as string)
    if (localId === undefined) continue
    const list = emitted.get(delivery.gatewayIntentId as string) ?? []
    if (!list.includes(delivery.event.eventId)) list.push(delivery.event.eventId)
    emitted.set(delivery.gatewayIntentId as string, list)
    allIds.add(delivery.event.eventId)

    if (random() < DROP_RATE) continue
    deliveredIds.add(delivery.event.eventId)
    await withUnitOfWork(sql, ACTOR, async (uow) => {
      await applyGatewayEvents(uow, localId, [delivery.event], {
        idempotencyKey: `${delivery.event.eventId}-delivered` as IdempotencyKey,
        gatewayIntentId: delivery.gatewayIntentId,
      })
    }).catch((error) => {
      // A capture whose authorisation was dropped cannot be folded — ADR 0056's table is strict — which
      // is exactly the state the pass repairs. Not delivered, therefore, and counted as dropped.
      if (error instanceof Error && error.name === 'IntentTransitionRefused') {
        deliveredIds.delete(delivery.event.eventId)
        return
      }
      throw error
    })
  }

  const dropped = new Set([...allIds].filter((id) => !deliveredIds.has(id)))
  return { prefix, gatewayName, intents, emitted, dropped, gateway }
}

/**
 * Every local position, in the shape the gateway's own answer is compared against.
 *
 * Filtered by the GATEWAY NAME as well as the ids, and that is not belt-and-braces: the fake numbers its
 * intents from one per INSTANCE, so `pi_fake_000008` exists in every population this file builds. The
 * first version of this query read only the ids and compared one population's state against another's —
 * which failed as "state diverges on pi_fake_000008" and looked like a defect in the pass.
 */
async function positionsOf(
  population_: Population,
): Promise<ReadonlyMap<string, { state: string; captured: number; refunded: number }>> {
  const rows = await sql<
    { gatewayIntentId: string; state: string; captured: string; refunded: string }[]
  >`
    select gateway_intent_id as "gatewayIntentId", state,
           captured_fils::bigint as captured, refunded_fils::bigint as refunded
      from payment_intent
     where gateway = ${population_.gatewayName}
       and gateway_intent_id = any(${sql.array([...population_.intents.keys()])})
  `
  return new Map(
    rows.map((row) => [
      row.gatewayIntentId,
      { state: row.state, captured: Number(row.captured), refunded: Number(row.refunded) },
    ]),
  )
}

/**
 * A checksum over a population's end state, with the per-population prefix REMOVED.
 *
 * Two independently built populations hold different ids, so a checksum over the raw rows could never
 * match. What has to match is the SHAPE: for each intent, in reference order, its state, its three
 * figures and the event ids it holds with the gateway-intent prefix stripped. Computed in SQL, over the
 * rows, so it is the database's answer and not this file's idea of one.
 */
async function checksumOf(population_: Population): Promise<string> {
  const [row] = await sql<{ digest: string }[]>`
    select md5(string_agg(line, '|' order by line)) as digest
      from (
        select replace(
                 pi.reference || ':' || pi.state || ':' || pi.authorised_fils || ':' ||
                 pi.captured_fils || ':' || pi.refunded_fils || ':' ||
                 coalesce((
                   select string_agg(replace(t.gateway_event_id, pi.gateway_intent_id, 'GW'), ',' order by
                           replace(t.gateway_event_id, pi.gateway_intent_id, 'GW'))
                     from payment_intent_transaction t where t.payment_intent_id = pi.id
                 ), ''),
                 ${population_.prefix},
                 'POP'
               ) as line
          from payment_intent pi
         where pi.gateway = ${population_.gatewayName}
           and pi.gateway_intent_id = any(${sql.array([...population_.intents.keys()])})
      ) lines
  `
  return row?.digest ?? ''
}

const runFor = async (population_: Population, gateway: PaymentGateway = population_.gateway) =>
  await runPaymentReconciliation({
    sql,
    gateway,
    gatewayName: population_.gatewayName,
    now: () => Date.parse('2099-12-25T15:00:00.000Z'),
    narrowTo: [...population_.intents.keys()],
  })

const journalEntryCount = async (): Promise<number> => {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entry`
  return Number(row?.n ?? '0')
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 8 })
  nonce = Math.random().toString(36).slice(2, 10)
  GATEWAY_NAME = cardGateway().name as string
}, 60_000)

describe('the job registration', () => {
  it('is a cron, and it names an agent that holds a heartbeat row', async () => {
    const job = JOB_REGISTRY.find((candidate) => candidate.name === PAYMENT_RECONCILIATION_JOB)
    expect(job, 'the reconciliation pass is not in the registry').toBeDefined()
    expect(job?.cron).toBeDefined()
    expect(job?.agent).toBe(PAYMENT_RECONCILIATION_AGENT)
    // `pnpm jobs` asserts the pair statically. This asserts the ROW, because an `agent_definition` with
    // no `agent_heartbeat` is an agent `agentsWithHeartbeat` INNER JOINs away — the exact state a
    // watchdog exists to make impossible.
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n
        from agent_definition d join agent_heartbeat h on h.agent_key = d.agent_key
       where d.agent_key = ${PAYMENT_RECONCILIATION_AGENT}
    `
    expect(row?.n).toBe('1')
  })
})

describe('the fuzz run', () => {
  it('brings every intent into step with the gateway, and names every repair', async () => {
    const pop = await population('FUZZ', FUZZ_INTENTS, 20_051)
    expect(pop.intents.size).toBe(FUZZ_INTENTS)
    // The vacuity control FIRST: if nothing had been dropped there would be nothing to repair, and the
    // whole case would hold for a pass that did nothing at all.
    expect(pop.dropped.size, 'nothing was dropped: the fuzz run proves nothing').toBeGreaterThan(50)

    const before = await positionsOf(pop)
    const diverged = [...pop.intents.keys()].filter((id) => {
      const local = before.get(id)
      return local === undefined || local.state !== 'captured'
    })
    expect(diverged.length, 'every intent was already in step before the pass').toBeGreaterThan(20)

    const entriesBefore = await journalEntryCount()
    const report = await runFor(pop)

    // 1. Local state equals gateway state for ALL of them, to the fils.
    const after = await positionsOf(pop)
    for (const gatewayIntentId of pop.intents.keys()) {
      const snapshot = await pop.gateway.fetchIntent(gatewayIntentId as GatewayIntentId)
      const local = after.get(gatewayIntentId)
      expect(local, `no local row for ${gatewayIntentId}`).toBeDefined()
      expect(local?.state, `state diverges on ${gatewayIntentId}`).toBe(snapshot.state)
      expect(local?.captured, `captured diverges on ${gatewayIntentId}`).toBe(
        snapshot.captured.fils,
      )
      expect(local?.refunded, `refunded diverges on ${gatewayIntentId}`).toBe(
        snapshot.refunded.fils,
      )
    }

    // 2. Every repair is a row with both sides and the missed event ids, and the events the rows name
    //    are exactly the consequential drops.
    const exceptions = await readReconciliationExceptions(sql, report.runId)
    expect(exceptions.every((row) => row.kind === 'repaired')).toBe(true)
    const named = new Set(exceptions.flatMap((row) => [...row.missedEventIds]))
    expect(named).toEqual(pop.dropped)
    expect(report.eventsApplied).toBe(pop.dropped.size)
    expect(report.repairs).toBe(exceptions.length)
    expect(report.quarantines).toBe(0)
    for (const row of exceptions) {
      expect(row.missedEventIds.length).toBeGreaterThan(0)
      expect(row.detail.length).toBeGreaterThan(20)
    }
    const [withBoth] = await sql<{ n: string }[]>`
        select count(*)::text as n from reconciliation_exception
         where run_id = ${report.runId}::uuid and after_state is not null
      `
    expect(withBoth?.n).toBe(String(exceptions.length))

    // And nothing posted a journal entry: a reconciliation moves an intent's rows, and the document
    // side is the webhook's (Y-PAY-04) — which this pass deliberately does not reach.
    expect(await journalEntryCount()).toBe(entriesBefore)

    // 3. The watermark advanced, so the next pass resumes after this window.
    expect(await readReconciliationWatermark(sql, pop.gatewayName)).toBe(report.cursorTo)
    expect(report.cursorTo).not.toBeNull()
  }, 600_000)
})

describe('idempotence', () => {
  it('a second consecutive run produces zero repairs and zero journal entries', async () => {
    const pop = await population('IDEM', 40, 7_919)
    expect(pop.dropped.size).toBeGreaterThan(3)

    const first = await runFor(pop)
    expect(first.repairs).toBeGreaterThan(0)

    const entriesBefore = await journalEntryCount()
    const second = await runFor(pop)

    // The acceptance line, and both halves.
    expect(second.repairs).toBe(0)
    expect(second.quarantines).toBe(0)
    expect(second.eventsApplied).toBe(0)
    expect(await readReconciliationExceptions(sql, second.runId)).toEqual([])
    expect(await journalEntryCount()).toBe(entriesBefore)
    // The second run still EXAMINED them, which is what makes the zero a measured answer rather than a
    // pass that read nothing.
    expect(second.intentsExamined).toBe(pop.intents.size)
    // And its watermark did not go backwards, which ZY684 would have refused.
    expect(second.cursorFrom).toBe(first.cursorTo)
  }, 300_000)
})

describe('interruption', () => {
  it('reaches the same end state as an uninterrupted run, by checksum', async () => {
    // Two populations built identically, from the SAME seed, so the drop pattern is the same and the
    // checksums are comparable once the per-population prefix is stripped.
    const interrupted = await population('KILL', 30, 31_337)
    const clean = await population('CLEAN', 30, 31_337)
    expect(interrupted.dropped.size).toBe(clean.dropped.size)
    expect(interrupted.dropped.size).toBeGreaterThan(2)

    // The kill: a gateway that answers for the first few intents and then stops. The pass dies with its
    // run row open, so the watermark does NOT advance — which is the whole mechanism.
    let answered = 0
    const dying: PaymentGateway = {
      ...interrupted.gateway,
      fetchIntent: async (id) => {
        answered += 1
        if (answered > 8) throw new Error('the pass was killed mid-run')
        return await interrupted.gateway.fetchIntent(id)
      },
    }
    await expect(runFor(interrupted, dying)).rejects.toThrow(/killed mid-run/)
    const watermarkAfterKill = await sql<{ n: string }[]>`
        select count(*)::text as n from payment_reconciliation_run
         where finished_at is null
      `
    expect(Number(watermarkAfterKill[0]?.n ?? '0')).toBeGreaterThan(0)

    // Restart, and the uninterrupted control.
    await runFor(interrupted)
    await runFor(clean)

    expect(await checksumOf(interrupted)).toBe(await checksumOf(clean))
    // The control that stops the checksum being vacuous: it is not the digest of an empty set, and two
    // DIFFERENT populations do not match.
    expect(await checksumOf(interrupted)).toMatch(/^[0-9a-f]{32}$/)
    const other = await population('OTHER', 30, 999)
    expect(await checksumOf(other)).not.toBe(await checksumOf(clean))
  }, 300_000)
})

describe('an intent the gateway does not recognise', () => {
  it('is quarantined and alerted, and is never deleted', async () => {
    const orphan = `YPAY05-${nonce}-ORPHAN-GW`
    // Its own gateway name, for the reason `Population.gatewayName` records: a watermark left by another
    // population would filter this one's (empty) stream, and the case would pass for the wrong reason.
    const orphanGateway = `${GATEWAY_NAME}-${nonce}-ORPHAN`
    const [row] = await sql<{ id: string }[]>`
      insert into payment_intent (
        idempotency_key, gateway, gateway_intent_id, instrument, posting_account_code, requested_fils,
        reference
      ) values (
        ${`YPAY05-${nonce}-ORPHAN-ik`}, ${orphanGateway}, ${orphan}, 'card_online',
        '1030', 5_000, ${`YPAY05-${nonce}-ORPHAN`}
      )
      returning id
    `
    const intentId = row?.id as string
    const gateway = cardGateway()

    const report = await runPaymentReconciliation({
      sql,
      gateway,
      gatewayName: orphanGateway,
      now: () => Date.parse('2099-12-25T15:00:00.000Z'),
      narrowTo: [orphan],
    })
    expect(report.quarantines).toBe(1)
    expect(report.repairs).toBe(0)

    const exceptions = await readReconciliationExceptions(sql, report.runId)
    expect(exceptions).toHaveLength(1)
    expect(exceptions[0]?.kind).toBe('quarantined')
    expect(exceptions[0]?.detail).toContain('does not recognise')

    // ALERTED, in the same transaction — ZY683 would have refused the commit otherwise, so this asserts
    // that the row the rule demands is the row that is there.
    const [audit] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
       where entity_type = 'reconciliation_exception' and entity_id = ${exceptions[0]?.id as string}
         and action = 'payment.reconciliation-quarantined'
    `
    expect(audit?.n).toBe('1')

    // NEVER deleted. The intent is still there, and so is the observation that justified the quarantine —
    // recorded with `recognised` false and nought figures, which is a MEASURED nothing rather than a
    // stand-in: the gateway holds nothing for it.
    const [still] = await sql<{ n: string }[]>`
      select count(*)::text as n from payment_intent where id = ${intentId}::uuid
    `
    expect(still?.n).toBe('1')
    const [observed] = await sql<{ recognised: boolean; captured: string }[]>`
      select recognised, captured_fils::bigint as captured
        from gateway_state_observation where gateway_intent_id = ${orphan}
    `
    expect(observed?.recognised).toBe(false)
    expect(Number(observed?.captured)).toBe(0)
  }, 60_000)
})
