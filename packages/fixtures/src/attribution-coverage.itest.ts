import {
  attributionCoverageOf,
  filsFrom,
  firstTouchOf,
  lastTouchBeforeOf,
  money,
  splitGross,
  type TouchCandidate,
} from '@berelax/core'
import {
  type Actor,
  AuditWriter,
  createConnection,
  issueInvoice,
  paidBookingAttributionSources,
  publishEvent,
  readBookingAttribution,
  readFirstTouch,
  recordBookingAttribution,
  type Sql,
  sessionTouchesForVisitorOf,
  type UnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_TRN } from './invoice.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The PAIR for attribution (A-FIRST-08): the rows `@berelax/db` writes against the rule `@berelax/core`
 * states, and the coverage figure against a hand count.
 *
 * `packages/db` may never import `packages/core` (ADR 0001), so the ordering that picks the first and
 * the last touch is written twice — as `order by … limit 1` in `repositories/attribution.ts`, and as
 * `firstTouchOf` / `lastTouchBeforeOf` in `core/src/analytics/attribution.ts`. The brief's rule is that
 * a second statement of a fact drifts and that the check holding the two equal ships in the same commit.
 * This file is that check, and `packages/fixtures` is the one package allowed to import both.
 *
 * It is also the only place attribution COVERAGE can be proved end to end, because the figure divides
 * PAID bookings — and "paid" is a fact in the ledger, so the fixture needs an invoice, which needs
 * `@berelax/core`'s VAT split.
 *
 * ## Everything happens inside one transaction that is rolled back
 *
 * `invoice` refuses DELETE for every role (ZI003), so truncating its family as the owner is the only
 * legal removal — and that statement is wide enough to take another suite's rows with it, which is why
 * every file that does it has a declaration in `suite-table-declarations.ts`. A rollback removes exactly
 * what this file wrote and nothing else, so no declaration is needed and the file can run twice in a
 * row. `issueInvoice` is therefore given a unit of work assembled over this transaction rather than
 * through `withUnitOfWork`, which opens its own transaction on the pool and cannot nest —
 * `merge.itest.ts`'s `attempt` does the same thing for the same reason.
 *
 * ## The trading year is 2070, which nothing else in this repository posts into
 *
 * 2080 through 2099 are taken — 2081 is P-HR-11's, 2083/2084 M-TILL-10's, 2087 onwards the journal's and
 * period-close's — and a business day another suite also writes would make this file's figures depend on
 * which suite ran first.
 */
const ACTOR: Actor = {
  kind: 'staff',
  id: '66666666-6666-6666-6666-666666666666',
  label: 'Analytics (attribution pair)',
}

const TRADING_DATE = '2070-03-10'
/** A second day, so "this day's bookings" is a filter that can be seen to exclude something. */
const OTHER_DAY = '2070-03-11'
const DAYS = [TRADING_DATE, OTHER_DAY] as const

const ISSUER = {
  legalName: 'BE RELAX SPA - L.L.C - O.P.C',
  tradingName: 'BE RELAX - Massage Center and Spa',
  trn: FIXTURE_TRN,
  addressSnapshot: '250 Al Meena Street\nTower Block A/B, M-Floor\nAl Zahiyah, Abu Dhabi',
  emirate: 'Abu Dhabi',
} as const

/** This file's own catalogue price, in fils. Not a price list's figure. */
const TREATMENT_GROSS = 26_250

const ROLLBACK = 'A-FIRST-08 rolled this fixture back'

let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

async function rolledBack<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  let carried: T | undefined
  try {
    await sql.begin(async (tx) => {
      carried = await body(tx as unknown as Sql)
      throw new Error(ROLLBACK)
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error
  }
  return carried as T
}

/** A unit of work over an open transaction, so `issueInvoice` can run inside the rollback. */
const unitOfWork = (tx: Sql): UnitOfWork => ({
  sql: tx,
  audit: new AuditWriter(tx, ACTOR),
  publish: (event) => publishEvent(tx, event),
})

interface World {
  readonly variantId: string
  readonly roomId: string
  readonly therapistId: string
}

async function world(tx: Sql): Promise<World> {
  for (const day of DAYS) {
    await tx`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (
        ${day}::date,
        (${day}::date + time '11:00') at time zone 'Asia/Dubai',
        (${day}::date + interval '1 day' + time '02:00') at time zone 'Asia/Dubai',
        'weekly'
      )
      on conflict (trading_date) do nothing
    `
  }
  const [variant] = await tx<{ id: string }[]>`
    select v.id from service_variant v join service s on s.id = v.service_id
     where s.archived_at is null order by v.id limit 1
  `
  const [room] = await tx<{ id: string }[]>`select id from rooms order by id limit 1`
  const [staff] = await tx<
    { id: string }[]
  >`select id from employee order by staff_reference limit 1`
  if (variant === undefined || room === undefined || staff === undefined) {
    throw new Error('run `pnpm seed`: a priced variant, a room and an employee are needed')
  }
  return { variantId: variant.id, roomId: room.id, therapistId: staff.id }
}

let probe = 0
function probePhone(): string {
  probe += 1
  return `+971592${String(100_000 + probe)}`
}

interface Booked {
  readonly customerId: string
  readonly bookingId: string
  readonly visitorId: string
  readonly createdAtMs: number
}

/** A customer, a consented visitor and a booking created at a known instant inside the trading day. */
async function booking(
  tx: Sql,
  w: World,
  options: {
    readonly source: string
    readonly hour: number
    readonly tradingDate?: string
  },
): Promise<Booked> {
  const tradingDate = options.tradingDate ?? TRADING_DATE
  const [customer] = await tx<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${probePhone()}, 'guest_booking')
    returning id::text as id
  `
  const createdAt = `${tradingDate} ${String(options.hour).padStart(2, '0')}:30:00+04`
  const [row] = await tx<{ id: string; created_at: Date }[]>`
    insert into booking (customer_id, source, created_at)
    values (${customer?.id as string}, ${options.source}, ${createdAt}::timestamptz)
    returning id::text as id, created_at
  `
  const [visitor] = await tx<{ visitor_id: string }[]>`
    insert into analytics.visitor (first_seen_at, last_seen_at)
    values (${`${tradingDate} 11:00:00+04`}::timestamptz, ${`${tradingDate} 11:00:00+04`}::timestamptz)
    returning visitor_id::text as visitor_id
  `
  // The appointment, which is what ties the booking to the document the coverage read counts.
  const split = splitGross(money(filsFrom(TREATMENT_GROSS)))
  const start = `${tradingDate} ${String(options.hour).padStart(2, '0')}:45:00+04`
  const end = `${tradingDate} ${String(options.hour).padStart(2, '0')}:59:00+04`
  await tx`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       gross_price_fils, net_fils, vat_fils, vat_rate_bp, turnaround_minutes,
       therapist_buffer_minutes)
    values (${row?.id as string}::uuid, ${tradingDate}::date, ${w.variantId}, 'solo'::service_shape,
            ${w.therapistId}, ${w.roomId}, ${`[${start},${end})`}::tstzrange,
            'completed'::appointment_status, ${TREATMENT_GROSS}, ${split.net.fils},
            ${split.vat.fils}, ${split.rateBp}, 20, 10)
  `
  if (customer === undefined || row === undefined || visitor === undefined) {
    // Named rather than non-null-asserted: three statements each returning no row is the shape a
    // constraint refusal takes when postgres.js is told to return one, and `(row?.x as Date).getTime()`
    // throws four frames away from the statement that actually failed.
    throw new Error('a fixture booking, its customer or its visitor returned no row')
  }
  return {
    customerId: customer.id,
    bookingId: row.id,
    visitorId: visitor.visitor_id,
    createdAtMs: row.created_at.getTime(),
  }
}

/** A session for a visitor, with the origination A-FIRST-03's resolver gave it. */
async function session(
  tx: Sql,
  booked: Booked,
  touch: { readonly atIso: string; readonly source: string; readonly tradingDate?: string },
): Promise<string> {
  const tradingDate = touch.tradingDate ?? TRADING_DATE
  const [row] = await tx<{ session_id: string }[]>`
    insert into analytics.session
      (visitor_id, started_at, last_event_at, trading_date, trading_date_basis, landing_path,
       device_kind, breakpoint, bot)
    values (${booked.visitorId}::uuid, ${touch.atIso}::timestamptz, ${touch.atIso}::timestamptz,
            ${tradingDate}::date, 'trading', '/', 'mobile', 'sm', false)
    returning session_id::text as session_id
  `
  await tx`
    insert into analytics.attribution
      (session_id, basis, source, medium, campaign, resolver_version, resolved_at)
    values (${row?.session_id as string}::uuid, 'utm', ${touch.source}, 'cpc', 'spring',
            'origination/1', ${touch.atIso}::timestamptz)
  `
  return row?.session_id as string
}

/** Issues a document for the booking's appointment and tenders `tenderFils` against it. */
async function bill(
  tx: Sql,
  booked: Booked,
  options: { readonly tenderFils: number; readonly tradingDate?: string },
): Promise<void> {
  const tradingDate = options.tradingDate ?? TRADING_DATE
  const split = splitGross(money(filsFrom(TREATMENT_GROSS)))
  const issued = await issueInvoice(unitOfWork(tx), {
    documentKind: 'tax_invoice',
    seriesCode: 'TAX-INV',
    issuer: ISSUER,
    customer: { nameSnapshot: 'Customer 0042' },
    bookingId: booked.bookingId,
    issueDate: tradingDate,
    issueTradingDate: tradingDate,
    taxPointDate: tradingDate,
    lines: [
      {
        descriptionEn: 'Treatment (attribution pair fixture)',
        quantity: 1,
        unitGrossFils: TREATMENT_GROSS,
        vatRateBp: split.rateBp,
        netFils: split.net.fils,
        vatFils: split.vat.fils,
      },
    ],
    netTotalFils: split.net.fils,
    vatTotalFils: split.vat.fils,
    grossTotalFils: TREATMENT_GROSS,
  })
  const [appointment] = await tx<{ id: string }[]>`
    select id::text as id from appointment where booking_id = ${booked.bookingId}::uuid limit 1
  `
  await tx`
    insert into invoice_appointment (invoice_id, appointment_id, line_no)
    values (${issued.id}::uuid, ${appointment?.id as string}::uuid, 1)
  `
  if (options.tenderFils > 0) {
    await tx`
      insert into payment (
        invoice_id, tender_no, tender_kind, posting_account_code, amount_fils, trading_date
      ) values (
        ${issued.id}::uuid, 1, 'cash', '1010', ${options.tenderFils}, ${tradingDate}::date
      )
    `
  }
}

// ------------------------------------------------------------------------------------------------
// The coverage figure, hand-counted
// ------------------------------------------------------------------------------------------------

describe('attribution coverage over paid bookings', () => {
  it('equals the hand-counted value, and excludes an unpaid booking and another day', async () => {
    const measured = await rolledBack(async (tx) => {
      const w = await world(tx)

      // 1. PAID and attributed: a web booking with a session an hour before it.
      const web = await booking(tx, w, { source: 'online', hour: 12 })
      const webSession = await session(tx, web, {
        atIso: `${TRADING_DATE} 11:30:00+04`,
        source: 'google',
      })
      await recordBookingAttribution(tx, {
        bookingId: web.bookingId,
        customerId: web.customerId,
        sessionReference: webSession,
        recordedAtIso: new Date(web.createdAtMs).toISOString(),
      })
      await bill(tx, web, { tenderFils: TREATMENT_GROSS })

      // 2. PAID and offline: a walk-in, which is an honest answer and NOT an attribution.
      const walkIn = await booking(tx, w, { source: 'walk_in', hour: 13 })
      await recordBookingAttribution(tx, {
        bookingId: walkIn.bookingId,
        customerId: walkIn.customerId,
        howHeard: 'Passing the door',
        recordedAtIso: new Date(walkIn.createdAtMs).toISOString(),
      })
      await bill(tx, walkIn, { tenderFils: TREATMENT_GROSS })

      // 3. PAID with NO attribution row at all, which reads `unknown` rather than disappearing.
      const unattributed = await booking(tx, w, { source: 'front_desk', hour: 14 })
      await bill(tx, unattributed, { tenderFils: TREATMENT_GROSS })

      // 4. ATTRIBUTED but not paid — the control for the numerator: counting it would raise the
      //    coverage figure using a booking the business has not been paid for.
      const unpaid = await booking(tx, w, { source: 'online', hour: 15 })
      const unpaidSession = await session(tx, unpaid, {
        atIso: `${TRADING_DATE} 14:30:00+04`,
        source: 'facebook',
      })
      await recordBookingAttribution(tx, {
        bookingId: unpaid.bookingId,
        customerId: unpaid.customerId,
        sessionReference: unpaidSession,
        recordedAtIso: new Date(unpaid.createdAtMs).toISOString(),
      })
      await bill(tx, unpaid, { tenderFils: 0 })

      // 5. PAID and attributed on ANOTHER trading day — the control for the day filter.
      const otherDay = await booking(tx, w, {
        source: 'online',
        hour: 12,
        tradingDate: OTHER_DAY,
      })
      const otherSession = await session(tx, otherDay, {
        atIso: `${OTHER_DAY} 11:30:00+04`,
        source: 'bing',
        tradingDate: OTHER_DAY,
      })
      await recordBookingAttribution(tx, {
        bookingId: otherDay.bookingId,
        customerId: otherDay.customerId,
        sessionReference: otherSession,
        recordedAtIso: new Date(otherDay.createdAtMs).toISOString(),
      })
      await bill(tx, otherDay, { tenderFils: TREATMENT_GROSS, tradingDate: OTHER_DAY })

      return {
        sources: await paidBookingAttributionSources(tx, { tradingDate: TRADING_DATE }),
        otherDaySources: await paidBookingAttributionSources(tx, { tradingDate: OTHER_DAY }),
      }
    })

    // Hand counted: three paid bookings on 2070-03-10 — google, offline, unknown — of which exactly
    // one has an attributed source. 1/3 is 333 per mille.
    expect([...measured.sources].sort()).toEqual(['google', 'offline', 'unknown'])
    const coverage = attributionCoverageOf(measured.sources)
    expect(coverage.kind).toBe('coverage')
    if (coverage.kind !== 'coverage') throw new Error('unreachable')
    expect(coverage.paidBookings).toBe(3)
    expect(coverage.attributedBookings).toBe(1)
    expect(coverage.coveragePerMille).toBe(333)
    // The day filter bites: the other day's booking is attributed and paid, and it is not in the three.
    expect(measured.otherDaySources).toEqual(['bing'])
  })
})

// ------------------------------------------------------------------------------------------------
// The rule, said twice, held equal
// ------------------------------------------------------------------------------------------------

describe('the SQL selection and the pure rule', () => {
  it('agree on the first and the last touch over the same candidate set', async () => {
    const measured = await rolledBack(async (tx) => {
      const w = await world(tx)
      const web = await booking(tx, w, { source: 'online', hour: 16 })
      // Four sessions: two before the booking, one in the same minute, one after it. The pure rule and
      // the statement must agree about all four, and they can only disagree about the last two.
      const first = await session(tx, web, {
        atIso: `${TRADING_DATE} 11:15:00+04`,
        source: 'first-google',
      })
      await session(tx, web, { atIso: `${TRADING_DATE} 13:00:00+04`, source: 'middle-bing' })
      await session(tx, web, { atIso: `${TRADING_DATE} 16:30:00+04`, source: 'same-minute' })
      await session(tx, web, { atIso: `${TRADING_DATE} 20:00:00+04`, source: 'after-the-booking' })
      await recordBookingAttribution(tx, {
        bookingId: web.bookingId,
        customerId: web.customerId,
        sessionReference: first,
        recordedAtIso: new Date(web.createdAtMs).toISOString(),
      })
      return {
        candidates: await sessionTouchesForVisitorOf(tx, first),
        storedFirst: await readFirstTouch(tx, web.customerId),
        storedLast: await readBookingAttribution(tx, web.bookingId),
        bookingCreatedAtMs: web.createdAtMs,
      }
    })

    const candidates: TouchCandidate[] = measured.candidates.map((candidate) => ({
      basis: 'utm',
      source: candidate.source,
      medium: candidate.medium,
      campaign: candidate.campaign,
      sessionReference: candidate.sessionReference,
      occurredAtMs: Date.parse(candidate.startedAtIso),
    }))
    expect(candidates).toHaveLength(4)

    const ruleFirst = firstTouchOf(candidates)
    const ruleLast = lastTouchBeforeOf(candidates, measured.bookingCreatedAtMs)

    // The rule and the statement, held equal — which is the whole point of this file.
    expect(measured.storedFirst?.source).toBe(ruleFirst?.source)
    expect(Date.parse(measured.storedFirst?.occurredAtIso ?? '')).toBe(ruleFirst?.occurredAtMs)
    expect(measured.storedLast?.source).toBe(ruleLast?.source)
    expect(Date.parse(measured.storedLast?.occurredAtIso ?? '')).toBe(ruleLast?.occurredAtMs)

    // And the controls, so this cannot pass by both sides being wrong in the same way: the answers are
    // the ones a reader can name, and the two that could have been chosen were not.
    expect(ruleFirst?.source).toBe('first-google')
    expect(ruleLast?.source).toBe('same-minute')
    expect(candidates.map((candidate) => candidate.source)).toContain('after-the-booking')
  })
})
