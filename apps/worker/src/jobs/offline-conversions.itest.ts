import { analyticsEventId, DISPATCH_DESTINATIONS } from '@berelax/analytics'
import { conversionLedgerNetFils } from '@berelax/core'
import {
  createConnection,
  type OfflineConversionFacts,
  offlineInvoiceConversions,
  offlineNoShowConversions,
  offlinePackageConversions,
  type Sql,
} from '@berelax/db'
import { syntheticPerson } from '@berelax/fixtures'
import { FUNNEL_TERMINAL_STAGE, type FunnelStage } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  enqueueOfflineConversions,
  NO_ATTRIBUTION_ON_FILE,
  runOfflineConversionPass,
  statementsFor,
} from './offline-conversions.ts'

/**
 * The offline conversion loop against a real PostgreSQL (A-MEAS-05).
 *
 * ## What is asserted over real rows, and why that is the point
 *
 * The acceptance lines are ARITHMETIC — *"dispatch rows whose values sum to exactly zero fils"*, *"a
 * negative value equal to the credit to the fils"* — and arithmetic over a pure function is already proved
 * in `conversion-value.test.ts`. What this file adds is that the figures survive the trip: the payload the
 * ledger produced is built by the egress guard, serialised by the one serialiser, written into a `jsonb`
 * column by the one writer, and read back. Every one of those steps has silently changed a figure in this
 * build already — the writer encoded a whole payload as a jsonb STRING, and the reader handed back
 * PostgreSQL's display form of a timestamp for a field named `...Iso`. So the sums below are taken from
 * `payload->>'valueFils'` on the rows themselves and never from the statements in memory.
 *
 * ## Why this file is here and not at `packages/db/src/dispatch.itest.ts`
 *
 * That is the path A-MEAS-05's manifest entry names and it cannot hold this suite: `packages/db` may never
 * import `packages/core` (ADR 0001, where the ledger lives) and `nothing-imports-an-app` refuses a package
 * reaching into `apps/` (where the pass lives) — `pnpm boundaries` refuses either, and a relative path is
 * the same violation written differently. A suite about a worker pass lives beside the pass, which is the
 * convention `gratuity-accrual.itest.ts` already follows. Recorded as a NOTE on the manifest entry.
 *
 * ## What it deletes
 *
 * Its own visitor (ADR 0050). The session and every dispatch row go with it by `on delete cascade`, which
 * is 0125's arrangement — so there is no hand-written table list here to go stale against a migration.
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

/** The pass's instant. Every conversion below happened before it, which is the unit's own subject. */
const PASS_AT = '2026-10-23T02:05:00.000Z'
const VISIT = '2026-10-20T14:30:00.000Z'
const NO_SHOW_AT = '2026-10-20T16:00:00.000Z'
const CREDITED_AT = '2026-10-21T10:15:00.000Z'
const REDEEMED_AT = '2026-10-22T11:00:00.000Z'

const TERMINAL: FunnelStage = ((stage: FunnelStage | undefined): FunnelStage => {
  if (stage === undefined) throw new Error('FUNNEL_STAGES is empty, so no stage is terminal.')
  return stage
})(FUNNEL_TERMINAL_STAGE)

/** A session that granted everything: this file's subject is the LEDGER and not the gate. */
async function grantingSession(): Promise<string> {
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
      consent_ad_storage, consent_ad_user_data, consent_ad_personalization, consent_analytics_storage
    )
    select ${visitorId}::uuid, b.opens_at, b.opens_at, b.trading_date, 'trading', '/en/offline-fixture',
           'desktop', 'lg', false, true, true, true, true
      from public.business_day b
     order by abs(extract(epoch from (b.opens_at - now())))
     limit 1
    returning session_id
  `
  return session?.session_id as string
}

const facts = (overrides: Partial<OfflineConversionFacts>): OfflineConversionFacts => ({
  aggregate: 'invoice',
  aggregateId: '0193f2c1-0000-7000-8000-000000000000',
  bookingId: null,
  bookingSource: 'walk_in',
  grossFils: 32_010,
  occurredAtIso: VISIT,
  noShowAtIso: null,
  creditedFils: 0,
  creditedAtIso: null,
  releasedFils: null,
  releasedAtIso: null,
  ...overrides,
})

/**
 * The fils every dispatch row for one conversion carries, read out of the stored payload.
 *
 * `payload->>'valueFils'` and not the statements in memory: the claim is about what a platform was TOLD,
 * so the figure has to come off the row. The ids are derived the same way the pass derives them, which is
 * also the assertion that a correction has an id of its own — a revision that contributed nothing would
 * make these two queries return one row instead of two.
 */
async function ledgerFils(
  conversion: OfflineConversionFacts,
  destination: string,
): Promise<readonly number[]> {
  const kind = conversion.aggregate === 'package' ? 'package' : conversion.aggregate
  const ids = statementsFor(conversion).map((statement) =>
    analyticsEventId({
      kind,
      aggregateId: conversion.aggregateId,
      stage: TERMINAL,
      revision: statement.revision,
    }),
  )
  const rows = await sql<{ event_id: string; value_fils: string | null }[]>`
    select event_id, payload->>'valueFils' as value_fils
      from analytics_dispatch
     where destination = ${destination}
       and event_id = any(${ids}::text[])
     order by array_position(${ids}::text[], event_id)
  `
  expect(rows.length, 'every statement must have written its own row').toBe(ids.length)
  return rows.map((row) => Number(row.value_fils))
}

const upload = async (conversion: OfflineConversionFacts, sessionId: string) =>
  enqueueOfflineConversions(sql, {
    facts: [conversion],
    nowIso: PASS_AT,
    destinations: DISPATCH_DESTINATIONS,
    resolveSession: () => sessionId,
  })

describe('a booking that became a no-show', () => {
  it('writes dispatch rows whose values sum to EXACTLY zero fils for that conversion', async () => {
    const sessionId = await grantingSession()
    const conversion = facts({
      aggregate: 'booking',
      aggregateId: '0193f2c1-0000-7000-8000-00000000a001',
      noShowAtIso: NO_SHOW_AT,
    })
    const result = await upload(conversion, sessionId)
    expect(result.statements).toBe(2)
    expect(result.enqueued).toBe(2 * DISPATCH_DESTINATIONS.length)

    for (const destination of DISPATCH_DESTINATIONS) {
      const values = await ledgerFils(conversion, destination)
      // The acceptance line, over the stored payloads: 32,010 and -32,010.
      expect(values).toEqual([32_010, -32_010])
      expect(values.reduce((total, value) => total + value, 0)).toBe(0)
    }
    // And the pass's own arithmetic agrees with the rows, which is what makes the counter meaningful.
    expect(result.netFils).toBe(0)
  })

  it('dates the void on the no-show and the original on the visit, both in the past', async () => {
    const sessionId = await grantingSession()
    const conversion = facts({
      aggregate: 'booking',
      aggregateId: '0193f2c1-0000-7000-8000-00000000a002',
      noShowAtIso: NO_SHOW_AT,
    })
    await upload(conversion, sessionId)
    const rows = await sql<{ occurred_at: Date; decided_at: Date }[]>`
      select d.occurred_at, d.decided_at
        from analytics_dispatch d
        join analytics.session s on s.session_id = d.session_id
       where s.session_id = ${sessionId}::uuid
       order by d.occurred_at
    `
    const instants = [...new Set(rows.map((row) => row.occurred_at.toISOString()))]
    expect(instants).toEqual([VISIT, NO_SHOW_AT])
    // Never now(): strictly before the pass, which the database's own `occurred_at <= decided_at` cannot
    // say on its own because equality satisfies it.
    for (const row of rows) {
      expect(row.occurred_at.getTime()).toBeLessThan(row.decided_at.getTime())
      expect(row.decided_at.toISOString()).toBe(PASS_AT)
    }
  })
})

describe('a credit note and a discounted invoice', () => {
  it('pushes a negative value equal to the credit, to the fils', async () => {
    const sessionId = await grantingSession()
    const conversion = facts({
      aggregateId: '0193f2c1-0000-7000-8000-00000000b001',
      creditedFils: 12_505,
      creditedAtIso: CREDITED_AT,
    })
    await upload(conversion, sessionId)
    for (const destination of DISPATCH_DESTINATIONS) {
      const values = await ledgerFils(conversion, destination)
      expect(values).toEqual([32_010, -12_505])
      // A PARTIAL refund leaves the difference standing, which is the figure the journal holds.
      expect(values.reduce((total, value) => total + value, 0)).toBe(19_505)
    }
  })

  it('carries the DOCUMENT gross, which is what a discounted invoice makes different', async () => {
    /*
     * The acceptance line is decided in the repository, which reads `invoice.gross_total` and never
     * `appointment.gross_price_fils` — a discount, a promotion or a price-list change makes those two
     * different numbers. It is asserted here over the figure the pass carries, which is the one a platform
     * is told: whatever the booking was estimated at, the statement's value is the document's gross.
     *
     * The `alreadyPushedFils` correction — a conversion announced on the BOOKING at the estimate and
     * corrected when the invoice is issued for less — is proved in `conversion-value.test.ts` and is not
     * reachable from here, because nothing in this build announces a conversion at booking time yet, so
     * there is no earlier figure on file to correct. Handed to A-MEAS-04 with the tag loader by a NOTE on
     * the manifest entry.
     */
    const sessionId = await grantingSession()
    const conversion = facts({
      aggregateId: '0193f2c1-0000-7000-8000-00000000b002',
      grossFils: 25_000,
    })
    await upload(conversion, sessionId)
    for (const destination of DISPATCH_DESTINATIONS) {
      expect(await ledgerFils(conversion, destination)).toEqual([25_000])
    }
  })

  it('dates the credit note on the day it was raised, not on the treatment', async () => {
    const sessionId = await grantingSession()
    const conversion = facts({
      aggregateId: '0193f2c1-0000-7000-8000-00000000b003',
      creditedFils: 1_000,
      creditedAtIso: CREDITED_AT,
    })
    await upload(conversion, sessionId)
    const rows = await sql<{ occurred_at: Date }[]>`
      select occurred_at from analytics_dispatch
       where session_id = ${sessionId}::uuid
       order by occurred_at
    `
    expect([...new Set(rows.map((row) => row.occurred_at.toISOString()))]).toEqual([
      VISIT,
      CREDITED_AT,
    ])
  })
})

describe('a package, on the Y11-vat-package provisional position', () => {
  it('pushes ZERO at the sale and the released value at redemption', async () => {
    const sessionId = await grantingSession()
    const conversion = facts({
      aggregate: 'package',
      aggregateId: '0193f2c1-0000-7000-8000-00000000c001',
      grossFils: 90_000,
      releasedFils: 16_000,
      releasedAtIso: REDEEMED_AT,
    })
    await upload(conversion, sessionId)
    for (const destination of DISPATCH_DESTINATIONS) {
      const values = await ledgerFils(conversion, destination)
      // The sale's 90,000 is NOT pushed: the provisional position recognises the conversion at redemption.
      expect(values).toEqual([0, 16_000])
      expect(values).not.toContain(90_000)
    }
  })

  it('writes the sale as a zero-value row rather than as no row at all', async () => {
    // The distinction A-MEAS-07's classification rests on: a sale with no dispatch is indistinguishable
    // from a sale the pass never saw.
    const sessionId = await grantingSession()
    const conversion = facts({
      aggregate: 'package',
      aggregateId: '0193f2c1-0000-7000-8000-00000000c002',
      grossFils: 90_000,
    })
    await upload(conversion, sessionId)
    for (const destination of DISPATCH_DESTINATIONS) {
      expect(await ledgerFils(conversion, destination)).toEqual([0])
    }
  })
})

describe('the identity of a correction', () => {
  it('is its own, so the platform cannot discard it as a duplicate of what it corrects', async () => {
    const sessionId = await grantingSession()
    const conversion = facts({
      aggregateId: '0193f2c1-0000-7000-8000-00000000d001',
      creditedFils: 500,
      creditedAtIso: CREDITED_AT,
    })
    await upload(conversion, sessionId)
    const rows = await sql<{ event_id: string }[]>`
      select event_id from analytics_dispatch where session_id = ${sessionId}::uuid
    `
    // Two statements times two destinations is two distinct ids, each written once per destination.
    expect(new Set(rows.map((row) => row.event_id)).size).toBe(2)
    expect(rows).toHaveLength(2 * DISPATCH_DESTINATIONS.length)
  })

  it('is idempotent: a second pass over the same facts writes no second row', async () => {
    const sessionId = await grantingSession()
    const conversion = facts({
      aggregateId: '0193f2c1-0000-7000-8000-00000000d002',
      creditedFils: 500,
      creditedAtIso: CREDITED_AT,
    })
    const first = await upload(conversion, sessionId)
    const again = await upload(conversion, sessionId)
    expect(first.enqueued).toBe(2 * DISPATCH_DESTINATIONS.length)
    expect(first.alreadyPresent).toBe(0)
    // The unique index 0137 adds, through the pass: the replay is absorbed and SAYS it was.
    expect(again.enqueued).toBe(0)
    expect(again.alreadyPresent).toBe(2 * DISPATCH_DESTINATIONS.length)
    const [{ n } = { n: '0' }] = await sql<{ n: string }[]>`
      select count(*)::text as n from analytics_dispatch where session_id = ${sessionId}::uuid
    `
    expect(n).toBe(String(2 * DISPATCH_DESTINATIONS.length))
  })
})

describe('the refusals the pass makes rather than guessing', () => {
  it('counts a conversion with no analytics session and uploads nothing for it', async () => {
    // A-FIRST-08 owns the attribution. A session chosen here would push a conversion under somebody
    // else's consent decision, which is worse than a counted refusal.
    const conversion = facts({ aggregateId: '0193f2c1-0000-7000-8000-00000000e001' })
    const result = await enqueueOfflineConversions(sql, {
      facts: [conversion],
      nowIso: PASS_AT,
      destinations: DISPATCH_DESTINATIONS,
      resolveSession: NO_ATTRIBUTION_ON_FILE,
    })
    expect(result).toMatchObject({ withoutASession: 1, statements: 0, enqueued: 0 })
  })

  it('counts a conversion with no booking channel rather than defaulting to website', async () => {
    const sessionId = await grantingSession()
    const result = await enqueueOfflineConversions(sql, {
      facts: [facts({ aggregateId: '0193f2c1-0000-7000-8000-00000000e002', bookingSource: null })],
      nowIso: PASS_AT,
      destinations: DISPATCH_DESTINATIONS,
      resolveSession: () => sessionId,
    })
    expect(result).toMatchObject({ withoutAChannel: 1, statements: 0, enqueued: 0 })
  })

  it('refuses a conversion dated at the instant of the pass, which is what now() produces', async () => {
    const sessionId = await grantingSession()
    await expect(
      enqueueOfflineConversions(sql, {
        facts: [
          facts({ aggregateId: '0193f2c1-0000-7000-8000-00000000e003', occurredAtIso: PASS_AT }),
        ],
        nowIso: PASS_AT,
        destinations: DISPATCH_DESTINATIONS,
        resolveSession: () => sessionId,
      }),
    ).rejects.toThrow(/not before the pass/)
  })

  it('refuses a pass with no destinations, which would report a clean upload to nobody', async () => {
    await expect(
      enqueueOfflineConversions(sql, {
        facts: [],
        nowIso: PASS_AT,
        destinations: [],
        resolveSession: NO_ATTRIBUTION_ON_FILE,
      }),
    ).rejects.toThrow(/no destinations at all/)
  })
})

describe('the three reads, against a real schema', () => {
  /**
   * The half a hand-built ledger cannot cover: whether the queries find anything at all.
   *
   * The failure being guarded against is a query that is syntactically fine and joins on nothing — it
   * returns an empty set and reads exactly like a trading day with no conversions, which is ADR 0002's
   * subject. So the no-show read gets a REAL fixture: a walk-in booking and an appointment on a seeded
   * trading day, which is the whole of what that query needs and all of it deletable afterwards (the
   * appointment goes with the booking by `on delete cascade`).
   *
   * **The invoiced and package reads are proved structurally and not over data, and that is a limit rather
   * than an omission.** `invoice` refuses DELETE for every role (ZI003) and TRUNCATE as the owner is the
   * only legal removal, which is a declaration in `packages/db/src/suite-table-declarations.ts` and a
   * statement wide enough to take other suites' rows with it — and `package_sale` is the same shape. A
   * suite may delete only rows it created (ADR 0050), so writing a document here would mean leaving one
   * behind for ever. What IS asserted for all three is that each query runs against the real schema,
   * filters by trading date, and refuses an instant where a date belongs. The data half of the invoiced
   * and package reads belongs with the pass that has a document to point at, and is handed to A-FIRST-09
   * with the funnel materialisation by a NOTE on the manifest entry.
   */
  const createdBookings: string[] = []

  afterAll(async () => {
    if (sql !== undefined && createdBookings.length > 0) {
      // Only rows this file created. The appointment and its status history go by cascade.
      await sql`delete from booking where id = any(${createdBookings}::uuid[])`
    }
  })

  it('finds a real walk-in no-show, with its estimate and the instant it was recorded', async () => {
    const [day] = await sql<{ trading_date: string; opens_at: Date }[]>`
      select trading_date::text as trading_date, opens_at
        from public.business_day
       order by abs(extract(epoch from (opens_at - now())))
       limit 1
    `
    const tradingDate = day?.trading_date as string
    const opensAt = day?.opens_at as Date
    expect(tradingDate, 'the seed must hold a trading day').toBeDefined()

    // `solo`, which is the shape a one-person treatment is: `service_shape` lives on the APPOINTMENT and
    // not on the variant, because a couple booking is two appointments of one variant (0012).
    const [variant] = await sql<{ id: string }[]>`
      select id from service_variant order by id limit 1
    `
    const [room] = await sql<{ id: string }[]>`select id from rooms order by id limit 1`
    /*
     * A synthetic customer on the `59` prefix, which `packages/fixtures/src/synthetic.ts` reserves
     * precisely so a fixture number cannot be somebody's real one (ADR 0020 / brief rule 10). Upserted on
     * the phone, because this file runs twice in a row and the second run must not fail on a unique key.
     */
    const person = syntheticPerson(74)
    const [customer] = await sql<{ id: string }[]>`
      insert into customer (phone_e164, created_via) values (${person.phone}, 'guest_booking')
      on conflict (phone_e164) do update set created_via = excluded.created_via
      returning id
    `
    const [booking] = await sql<{ id: string }[]>`
      insert into booking (customer_id, source) values (${customer?.id as string}::uuid, 'walk_in')
      returning id
    `
    const bookingId = booking?.id as string
    createdBookings.push(bookingId)
    const startsAt = new Date(opensAt.getTime() + 60 * 60 * 1000)
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000)
    const [appointment] = await sql<{ id: string }[]>`
      insert into appointment (
        booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
        gross_price_fils, net_fils, vat_fils, turnaround_minutes, therapist_buffer_minutes
      ) values (
        ${bookingId}::uuid, ${tradingDate}::date, ${variant?.id as string}::uuid,
        'solo'::service_shape, ${bookingId}::uuid, ${room?.id as string}::uuid,
        tstzrange(${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz, '[)'),
        -- holds_resources is GENERATED from the status (0013): a no-show holds nothing, and writing it
        -- would be a second statement of a fact the column already derives.
        'no_show', 21000, 20000, 1000, 0, 0
      )
      returning id
    `
    expect(appointment?.id).toBeDefined()

    const found = await offlineNoShowConversions(sql, { tradingDate })
    const mine = found.find((conversion) => conversion.aggregateId === bookingId)
    expect(mine, 'the no-show read must find a walk-in no-show with no invoice').toBeDefined()
    expect(mine?.aggregate).toBe('booking')
    expect(mine?.bookingSource).toBe('walk_in')
    // The ESTIMATE, because a no-show has no document to take a gross from.
    expect(mine?.grossFils).toBe(21_000)
    expect(mine?.occurredAtIso).toBe(startsAt.toISOString())
    /*
     * The no-show instant is the APPEND-ONLY transition's and not the visit's, which is what the read
     * claims and what this assertion measures rather than assumes: inserting an appointment already in
     * `no_show` writes an `appointment_status_history` row, so the instant on file is the one that row
     * holds. The visit-instant fallback in the repository is for a row whose status was set by a path that
     * wrote no history, and leaving the instant null there would leave the ORIGINAL conversion standing at
     * its full value — which is the one outcome this unit exists to prevent.
     */
    const [transition] = await sql<{ occurred_at: Date }[]>`
      select max(occurred_at) as occurred_at
        from appointment_status_history
       where appointment_id = ${appointment?.id as string}::uuid and to_status = 'no_show'
    `
    expect(transition?.occurred_at, 'the status history must hold the transition').not.toBeNull()
    expect(mine?.noShowAtIso).toBe(transition?.occurred_at?.toISOString())

    // And the statements it produces sum to nothing, which is the acceptance line over a real row.
    expect(conversionLedgerNetFils(statementsFor(mine as OfflineConversionFacts))).toBe(0)
  })

  it('answers a day with nothing on it as empty, rather than as every day', async () => {
    // The control on the control: a query missing its date predicate would return the whole table here.
    expect(await offlineInvoiceConversions(sql, { tradingDate: '1999-01-01' })).toHaveLength(0)
    expect(await offlineNoShowConversions(sql, { tradingDate: '1999-01-01' })).toHaveLength(0)
    expect(await offlinePackageConversions(sql, { tradingDate: '1999-01-01' })).toHaveLength(0)
  })

  it('refuses an instant where a trading DATE belongs, in all three reads', async () => {
    // Trading runs 11:00-02:00, so an instant cast to a date moves every sale after midnight onto the
    // wrong day — and the conversions with it, into the wrong attribution window.
    for (const read of [
      offlineInvoiceConversions,
      offlineNoShowConversions,
      offlinePackageConversions,
    ]) {
      await expect(read(sql, { tradingDate: PASS_AT })).rejects.toThrow(/not a YYYY-MM-DD date/)
    }
  })

  it('runs the whole pass over a real trading date and reports what it could not upload', async () => {
    const [day] = await sql<{ trading_date: string }[]>`
      select trading_date::text as trading_date
        from public.business_day
       order by abs(extract(epoch from (opens_at - now())))
       limit 1
    `
    const result = await runOfflineConversionPass(sql, {
      tradingDate: day?.trading_date as string,
      nowIso: PASS_AT,
      destinations: DISPATCH_DESTINATIONS,
      resolveSession: NO_ATTRIBUTION_ON_FILE,
    })
    // Nothing is uploaded and the COUNT is what says why — "no conversions were uploaded" has to read as
    // *the attribution is missing* rather than as *there were none* (ADR 0002).
    expect(result.conversions).toBeGreaterThan(0)
    expect(result.withoutASession).toBe(result.conversions)
    expect(result.enqueued).toBe(0)
  })
})

describe('the ledger function is the one the suite sums with', () => {
  it('agrees with the rows, which is what stops this file holding a second arithmetic', async () => {
    const sessionId = await grantingSession()
    const conversion = facts({
      aggregateId: '0193f2c1-0000-7000-8000-00000000f001',
      creditedFils: 7_010,
      creditedAtIso: CREDITED_AT,
    })
    await upload(conversion, sessionId)
    const fromRows = (await ledgerFils(conversion, DISPATCH_DESTINATIONS[0] as string)).reduce(
      (total, value) => total + value,
      0,
    )
    expect(fromRows).toBe(conversionLedgerNetFils(statementsFor(conversion)))
  })
})
