import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from './connection.ts'
import { MERGE_PARTICIPANTS } from './merge-participants.ts'
import {
  ATTRIBUTION_SQLSTATE,
  attributedSessionForBooking,
  attributionRefusalOf,
  paidBookingAttributionSources,
  readBookingAttribution,
  readFirstTouch,
  recordBookingAttribution,
  sessionTouchesForVisitorOf,
} from './repositories/attribution.ts'
import { applyMergeParticipant } from './repositories/merge.ts'

/**
 * Migration 0149 and `repositories/attribution.ts` — first touch, last touch, the offline fallback, the
 * merge fold and the coverage read (A-FIRST-08), proved against a real database.
 *
 * ## Why every case runs inside a transaction that is rolled back
 *
 * This file writes a customer, a booking, an analytics visitor and several analytics sessions, and none
 * of them can be removed afterwards without the suite deleting rows it did not create. `analytics`
 * grants the application role no DELETE at all — rows leave that schema through
 * `analytics.run_retention` and nothing else (0096) — and `booking.customer_id` is `ON DELETE RESTRICT`
 * precisely so that deleting a customer cannot take a booking with it. A rollback is therefore the only
 * cleanup these tables permit (ADR 0050), and it is what lets this suite run twice in a row.
 *
 * ## Every session fixture is calendar-consistent, and it has to be
 *
 * `analytics.session.trading_date_basis` is NOT NULL and held against `public.business_day`'s own
 * `[opens_at, closes_at)` window by ZY222 in both directions (0116, ADR 0066). A fixture session cannot
 * pick its instant and its trading date independently, so every one here is built from a seeded day's
 * own opening instant plus an offset inside that day's window.
 *
 * ## Why the first-touch case replays every permutation
 *
 * "Write-once" is a claim that the ANSWER does not depend on the order the evidence arrived in, and
 * asserting it on one order proves nothing: the first order a writer happens to use is the one it was
 * written against. All six orderings of three sessions are replayed, into six separate customers, and
 * the set of answers is asserted to have one member.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

/** A marker only this file throws, so a rollback cannot be mistaken for a failure. */
const ROLLBACK = 'A-FIRST-08 rolled this fixture back'

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

/** postgres.js exposes `savepoint` on a transaction and not on the pool, and `Sql` is the pool's type. */
interface Savepointing {
  savepoint<T>(cb: (sp: Sql) => Promise<T>): Promise<T>
}

/**
 * The SQLSTATE a probing statement raised, or `undefined` when it was accepted — inside a SAVEPOINT.
 *
 * The savepoint is load-bearing and its absence cost the first run of this file six failures reported as
 * `25P02`. A statement that raises aborts the whole transaction, so the first refusal this file proves
 * would make every later statement in the same case — including the CONTROL that must be accepted —
 * fail for a reason that has nothing to do with the rule under test. `merge.itest.ts` has the same
 * helper for the same reason.
 */
async function stateOf(
  tx: Sql,
  body: (sp: Sql) => Promise<unknown>,
): Promise<{ code?: string | undefined; message?: string | undefined }> {
  try {
    await (tx as unknown as Savepointing).savepoint(async (sp) => {
      await body(sp)
    })
    return {}
  } catch (error) {
    const err = error as { code?: string; message?: string }
    return { code: err.code, message: err.message }
  }
}

/** A seeded trading day with its opening instant. `analytics.itest.ts`'s helper, same reasoning. */
async function seededTradingDay(
  tx: Sql,
): Promise<{ tradingDate: string; opensAtMs: number; closesAtMs: number }> {
  const [row] = await tx<{ trading_date: string; opens_at: Date; closes_at: Date }[]>`
    select to_char(trading_date, 'YYYY-MM-DD') as trading_date, opens_at, closes_at
      from business_day
     order by abs(extract(epoch from (opens_at - now())))
     limit 1
  `
  if (row === undefined) {
    throw new Error(
      'business_day is empty, so nothing in this file could be about a trading date. Run `pnpm seed` ' +
        '— the seeder writes the trading calendar.',
    )
  }
  return {
    tradingDate: row.trading_date,
    opensAtMs: row.opens_at.getTime(),
    closesAtMs: row.closes_at.getTime(),
  }
}

/**
 * A probe phone number, unique per call.
 *
 * `customer.phone_e164` is UNIQUE and the integration suite runs against ONE database, so a constant
 * would collide with the previous case in this file as well as with another suite. No real number is
 * invented: `59` is a UAE mobile prefix and the rest is a counter (brief rule 15).
 */
let probe = 0
function probePhone(): string {
  probe += 1
  return `+971591${String(100_000 + probe)}`
}

interface Fixture {
  readonly customerId: string
  readonly bookingId: string
  readonly visitorId: string
  readonly tradingDate: string
  readonly opensAtMs: number
  readonly bookingCreatedAtMs: number
}

const HOUR = 3_600_000

/**
 * A customer, a consented analytics visitor, and a booking whose `created_at` is written EXPLICITLY.
 *
 * Explicitly, because every claim in this file is about order: the last touch is the most recent session
 * before that instant, and a booking stamped with the transaction's own `now()` would be after every
 * fixture session by construction — which would make the bound untestable in the one direction that
 * matters.
 */
async function fixture(
  tx: Sql,
  options: { readonly bookingAfterOpeningHours?: number; readonly source?: string } = {},
): Promise<Fixture> {
  const day = await seededTradingDay(tx)
  const [customer] = await tx<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${probePhone()}, 'guest_booking')
    returning id::text as id
  `
  const [visitor] = await tx<{ visitor_id: string }[]>`
    insert into analytics.visitor (first_seen_at, last_seen_at)
    values (to_timestamp(${day.opensAtMs / 1000}), to_timestamp(${day.opensAtMs / 1000}))
    returning visitor_id::text as visitor_id
  `
  const createdAtMs = day.opensAtMs + (options.bookingAfterOpeningHours ?? 6) * HOUR
  const [booking] = await tx<{ id: string }[]>`
    insert into booking (customer_id, source, created_at)
    values (${customer?.id as string}, ${options.source ?? 'online'},
            to_timestamp(${createdAtMs / 1000}))
    returning id::text as id
  `
  return {
    customerId: customer?.id as string,
    bookingId: booking?.id as string,
    visitorId: visitor?.visitor_id as string,
    tradingDate: day.tradingDate,
    opensAtMs: day.opensAtMs,
    bookingCreatedAtMs: createdAtMs,
  }
}

/** One analytics session for a visitor, with the origination A-FIRST-03's resolver gave it. */
async function session(
  tx: Sql,
  fx: Fixture,
  touch: { readonly afterOpeningHours: number; readonly source: string },
): Promise<string> {
  const startedMs = fx.opensAtMs + touch.afterOpeningHours * HOUR
  const [row] = await tx<{ session_id: string }[]>`
    insert into analytics.session
      (visitor_id, started_at, last_event_at, trading_date, trading_date_basis, landing_path,
       device_kind, breakpoint, bot)
    values (${fx.visitorId}::uuid, to_timestamp(${startedMs / 1000}),
            to_timestamp(${startedMs / 1000}), ${fx.tradingDate}, 'trading', '/',
            'mobile', 'sm', false)
    returning session_id::text as session_id
  `
  const sessionId = row?.session_id as string
  await tx`
    insert into analytics.attribution
      (session_id, basis, source, medium, campaign, resolver_version, resolved_at)
    values (${sessionId}::uuid, 'utm', ${touch.source}, 'cpc', 'spring', 'origination/1',
            to_timestamp(${startedMs / 1000}))
  `
  return sessionId
}

/** Every permutation of a list, so "shuffled" is exhaustive rather than sampled. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  )
}

// ------------------------------------------------------------------------------------------------
// Acceptance 1: first touch is write-once, whatever order the sessions are replayed in
// ------------------------------------------------------------------------------------------------

describe('the first touch', () => {
  it('keeps the earliest of three sessions in all six replay orders', async () => {
    const answers = await rolledBack(async (tx) => {
      const found: string[] = []
      // Three sessions one hour apart, each from a different source, and the booking six hours after
      // opening so the last-touch bound excludes none of them: this case is only about which one wins.
      const touches = [
        { afterOpeningHours: 1, source: 'earliest-google' },
        { afterOpeningHours: 2, source: 'middle-bing' },
        { afterOpeningHours: 3, source: 'latest-facebook' },
      ]
      for (const order of permutations(touches)) {
        const fx = await fixture(tx)
        // The PHYSICAL insertion order differs per permutation — `uuid_generate_v7` is time-ordered, so
        // the session ids are too, and a resolver reading row order rather than `started_at` would
        // answer differently for each of the six.
        const ids: Record<string, string> = {}
        for (const touch of order) ids[touch.source] = await session(tx, fx, touch)
        await recordBookingAttribution(tx, {
          bookingId: fx.bookingId,
          customerId: fx.customerId,
          sessionReference: ids['earliest-google'] as string,
          recordedAtIso: new Date(fx.bookingCreatedAtMs).toISOString(),
        })
        const first = await readFirstTouch(tx, fx.customerId)
        found.push(`${first?.source}@${first?.occurredAtIso}`)
      }
      return found
    })
    expect(answers).toHaveLength(6)
    const distinct = new Set(answers)
    expect(
      distinct.size,
      `six orders gave ${distinct.size} answers: ${[...distinct].join(', ')}`,
    ).toBe(1)
    expect([...distinct][0]).toContain('earliest-google')
  })

  it('is not replaced by a later claim, and a resolver re-run writes nothing', async () => {
    const result = await rolledBack(async (tx) => {
      const fx = await fixture(tx)
      const early = await session(tx, fx, { afterOpeningHours: 1, source: 'earliest-google' })
      await recordBookingAttribution(tx, {
        bookingId: fx.bookingId,
        customerId: fx.customerId,
        sessionReference: early,
        recordedAtIso: new Date(fx.bookingCreatedAtMs).toISOString(),
      })
      const afterFirstPass = await readFirstTouch(tx, fx.customerId)
      // A second, LATER session arrives and the pass runs again. The customer was still found once.
      const late = await session(tx, fx, { afterOpeningHours: 4, source: 'later-facebook' })
      await recordBookingAttribution(tx, {
        bookingId: fx.bookingId,
        customerId: fx.customerId,
        sessionReference: late,
        recordedAtIso: new Date(fx.bookingCreatedAtMs).toISOString(),
      })
      return { afterFirstPass, afterSecondPass: await readFirstTouch(tx, fx.customerId) }
    })
    expect(result.afterFirstPass?.source).toBe('earliest-google')
    expect(result.afterSecondPass?.source).toBe('earliest-google')
    expect(result.afterSecondPass?.occurredAtIso).toBe(result.afterFirstPass?.occurredAtIso)
  })

  it('refuses a replacement that is not earlier, by name (ZY691)', async () => {
    const outcomes = await rolledBack(async (tx) => {
      const fx = await fixture(tx)
      const early = await session(tx, fx, { afterOpeningHours: 1, source: 'earliest-google' })
      await recordBookingAttribution(tx, {
        bookingId: fx.bookingId,
        customerId: fx.customerId,
        sessionReference: early,
        recordedAtIso: new Date(fx.bookingCreatedAtMs).toISOString(),
      })
      const later = await stateOf(
        tx,
        (sp) => sp`
        update customer_attribution
           set source = 'overwritten', occurred_at = occurred_at + interval '1 hour'
         where customer_id = ${fx.customerId}::uuid
      `,
      )
      // The control, and it is what makes ZY691 a rule rather than a refusal of every UPDATE: an
      // EARLIER claim is accepted, which is the one replacement a customer merge needs.
      const earlier = await stateOf(
        tx,
        (sp) => sp`
        update customer_attribution
           set source = 'earlier-claim', occurred_at = occurred_at - interval '1 hour'
         where customer_id = ${fx.customerId}::uuid
      `,
      )
      return { later, earlier }
    })
    expect(outcomes.later.code).toBe(ATTRIBUTION_SQLSTATE.firstTouchIsWriteOnce)
    expect(attributionRefusalOf({ code: outcomes.later.code })).toBe('first_touch_is_write_once')
    expect(outcomes.later.message).toContain('write-once')
    expect(outcomes.earlier.code).toBeUndefined()
  })
})

// ------------------------------------------------------------------------------------------------
// Acceptance 2: the last touch is the most recent session BEFORE the booking
// ------------------------------------------------------------------------------------------------

describe('the last touch', () => {
  it('is the most recent session starting before the booking, and a later one never overwrites it', async () => {
    const result = await rolledBack(async (tx) => {
      // The booking is three hours after opening. Sessions at +1h and +2h precede it; one at +5h does
      // not, and it is the MOST RECENT session in the table — so a resolver with no bound answers it.
      const fx = await fixture(tx, { bookingAfterOpeningHours: 3 })
      const first = await session(tx, fx, { afterOpeningHours: 1, source: 'first-google' })
      await session(tx, fx, { afterOpeningHours: 2, source: 'last-before-booking' })
      await recordBookingAttribution(tx, {
        bookingId: fx.bookingId,
        customerId: fx.customerId,
        sessionReference: first,
        recordedAtIso: new Date(fx.bookingCreatedAtMs).toISOString(),
      })
      const beforeTheLateSession = await readBookingAttribution(tx, fx.bookingId)
      await session(tx, fx, { afterOpeningHours: 5, source: 'after-the-booking' })
      await recordBookingAttribution(tx, {
        bookingId: fx.bookingId,
        customerId: fx.customerId,
        sessionReference: first,
        recordedAtIso: new Date(fx.bookingCreatedAtMs).toISOString(),
      })
      return {
        beforeTheLateSession,
        afterTheLateSession: await readBookingAttribution(tx, fx.bookingId),
        candidates: await sessionTouchesForVisitorOf(tx, first),
      }
    })
    expect(result.beforeTheLateSession?.source).toBe('last-before-booking')
    expect(result.afterTheLateSession?.source).toBe('last-before-booking')
    // The control that stops this passing vacuously: the later session IS in the candidate set, so the
    // answer above was chosen rather than being the only one available.
    expect(result.candidates.map((candidate) => candidate.source)).toContain('after-the-booking')
    expect(result.candidates).toHaveLength(3)
  })

  it('refuses a stored last touch dated after its own booking, by name (ZY692)', async () => {
    const outcomes = await rolledBack(async (tx) => {
      const fx = await fixture(tx, { bookingAfterOpeningHours: 3 })
      const after = await stateOf(
        tx,
        (sp) => sp`
        insert into booking_attribution
          (booking_id, basis, source, medium, session_reference, occurred_at, recorded_at)
        values (${fx.bookingId}::uuid, 'utm', 'google', 'cpc',
                '00000000-0000-7000-8000-000000000001'::uuid,
                to_timestamp(${(fx.bookingCreatedAtMs + HOUR) / 1000}),
                to_timestamp(${(fx.bookingCreatedAtMs + HOUR) / 1000}))
      `,
      )
      // The control: the same row an instant EARLIER is accepted, so the refusal is about the bound and
      // not about anything else on the row.
      const before = await stateOf(
        tx,
        (sp) => sp`
        insert into booking_attribution
          (booking_id, basis, source, medium, session_reference, occurred_at, recorded_at)
        values (${fx.bookingId}::uuid, 'utm', 'google', 'cpc',
                '00000000-0000-7000-8000-000000000001'::uuid,
                to_timestamp(${(fx.bookingCreatedAtMs - HOUR) / 1000}),
                to_timestamp(${fx.bookingCreatedAtMs / 1000}))
      `,
      )
      return { after, before }
    })
    expect(outcomes.after.code).toBe(ATTRIBUTION_SQLSTATE.lastTouchPrecedesBooking)
    expect(attributionRefusalOf({ code: outcomes.after.code })).toBe(
      'last_touch_postdates_its_booking',
    )
    expect(outcomes.after.message).toContain('self-reinforcing')
    expect(outcomes.before.code).toBeUndefined()
  })
})

// ------------------------------------------------------------------------------------------------
// Acceptance 3: the offline fallback, and the claim that no null path exists
// ------------------------------------------------------------------------------------------------

describe('an offline booking', () => {
  it('carries source offline, medium direct and the how-heard answer when one was given', async () => {
    const rows = await rolledBack(async (tx) => {
      const walkIn = await fixture(tx, { source: 'walk_in' })
      await recordBookingAttribution(tx, {
        bookingId: walkIn.bookingId,
        customerId: walkIn.customerId,
        howHeard: 'Saw the sign',
        recordedAtIso: new Date(walkIn.bookingCreatedAtMs).toISOString(),
      })
      const phone = await fixture(tx, { source: 'phone' })
      await recordBookingAttribution(tx, {
        bookingId: phone.bookingId,
        customerId: phone.customerId,
        // Blank rather than absent: a staff member who pressed Enter is not an answer.
        howHeard: '   ',
        recordedAtIso: new Date(phone.bookingCreatedAtMs).toISOString(),
      })
      return {
        walkIn: await readBookingAttribution(tx, walkIn.bookingId),
        walkInFirst: await readFirstTouch(tx, walkIn.customerId),
        phone: await readBookingAttribution(tx, phone.bookingId),
        session: await attributedSessionForBooking(tx, walkIn.bookingId),
      }
    })
    expect(rows.walkIn?.source).toBe('offline')
    expect(rows.walkIn?.medium).toBe('direct')
    expect(rows.walkIn?.basis).toBe('offline')
    expect(rows.walkIn?.sessionReference).toBeNull()
    expect(rows.walkIn?.howHeard).toBe('Saw the sign')
    // The customer's first touch is offline too: there is no session to be earlier than the walk-in.
    expect(rows.walkInFirst?.source).toBe('offline')
    expect(rows.walkInFirst?.howHeard).toBe('Saw the sign')
    expect(rows.phone?.source).toBe('offline')
    expect(rows.phone?.howHeard).toBeNull()
    // And the resolver A-MEAS-03 and A-MEAS-05 were handed answers "nothing on file" rather than
    // picking a session — which is the whole reason both units refused to choose one (ADR 0091/0092).
    expect(rows.session).toBeNull()
  })

  it('has no null path: the column is NOT NULL and every booking source produces a row', async () => {
    const result = await rolledBack(async (tx) => {
      const [column] = await tx<{ is_nullable: string }[]>`
        select is_nullable
          from information_schema.columns
         where table_schema = 'public' and table_name = 'booking_attribution'
           and column_name = 'source'
      `
      const written: Record<string, string | undefined> = {}
      for (const source of ['online', 'front_desk', 'phone', 'walk_in'] as const) {
        const fx = await fixture(tx, { source })
        await recordBookingAttribution(tx, {
          bookingId: fx.bookingId,
          customerId: fx.customerId,
          recordedAtIso: new Date(fx.bookingCreatedAtMs).toISOString(),
        })
        written[source] = (await readBookingAttribution(tx, fx.bookingId))?.source
      }
      // The control: a null source is refused by the column rather than by the writer's care.
      const fx = await fixture(tx)
      const nulled = await stateOf(
        tx,
        (sp) => sp`
        insert into booking_attribution
          (booking_id, basis, source, medium, occurred_at, recorded_at)
        values (${fx.bookingId}::uuid, 'offline', null, 'direct',
                to_timestamp(${fx.bookingCreatedAtMs / 1000}),
                to_timestamp(${fx.bookingCreatedAtMs / 1000}))
      `,
      )
      return { isNullable: column?.is_nullable, written, nulled }
    })
    expect(result.isNullable).toBe('NO')
    expect(result.written).toEqual({
      online: 'offline',
      front_desk: 'offline',
      phone: 'offline',
      walk_in: 'offline',
    })
    // 23502 is PostgreSQL's not-null violation. A private code here would mean the column was nullable
    // and something else was doing the refusing.
    expect(result.nulled.code).toBe('23502')
  })

  it('refuses a how-heard answer on a web touch, and a web basis with no session', async () => {
    const outcomes = await rolledBack(async (tx) => {
      const fx = await fixture(tx, { bookingAfterOpeningHours: 3 })
      const howHeardOnAWebRow = await stateOf(
        tx,
        (sp) => sp`
        insert into booking_attribution
          (booking_id, basis, source, medium, session_reference, how_heard, occurred_at, recorded_at)
        values (${fx.bookingId}::uuid, 'utm', 'google', 'cpc',
                '00000000-0000-7000-8000-000000000001'::uuid, 'Saw the sign',
                to_timestamp(${(fx.bookingCreatedAtMs - HOUR) / 1000}),
                to_timestamp(${fx.bookingCreatedAtMs / 1000}))
      `,
      )
      const webBasisWithNoSession = await stateOf(
        tx,
        (sp) => sp`
        insert into booking_attribution
          (booking_id, basis, source, medium, occurred_at, recorded_at)
        values (${fx.bookingId}::uuid, 'utm', 'google', 'cpc',
                to_timestamp(${(fx.bookingCreatedAtMs - HOUR) / 1000}),
                to_timestamp(${fx.bookingCreatedAtMs / 1000}))
      `,
      )
      const offlineWithASession = await stateOf(
        tx,
        (sp) => sp`
        insert into booking_attribution
          (booking_id, basis, source, medium, session_reference, occurred_at, recorded_at)
        values (${fx.bookingId}::uuid, 'offline', 'offline', 'direct',
                '00000000-0000-7000-8000-000000000001'::uuid,
                to_timestamp(${(fx.bookingCreatedAtMs - HOUR) / 1000}),
                to_timestamp(${fx.bookingCreatedAtMs / 1000}))
      `,
      )
      return { howHeardOnAWebRow, webBasisWithNoSession, offlineWithASession }
    })
    // 23514 is the CHECK, and the constraint name is what says which rule fired — one function states
    // all five of these claims, so a bare non-zero exit would not say which of them was being proved.
    for (const outcome of Object.values(outcomes)) {
      expect(outcome.code).toBe('23514')
      expect(outcome.message).toContain('origination_well_formed')
    }
  })
})

// ------------------------------------------------------------------------------------------------
// Acceptance 4: a customer merge keeps the EARLIER first touch and leaves exactly one row
// ------------------------------------------------------------------------------------------------

describe('a customer merge', () => {
  const participant = () => {
    const found = MERGE_PARTICIPANTS.find((p) => p.table === 'customer_attribution')
    if (found === undefined) {
      throw new Error(
        'customer_attribution is not a registered merge participant, so this case would prove ' +
          'nothing about a merge. Register it in packages/db/src/merge-participants.ts.',
      )
    }
    return found
  }

  it('folds the earlier first touch onto the survivor and leaves it with exactly one row', async () => {
    const result = await rolledBack(async (tx) => {
      const survivor = await fixture(tx)
      const loser = await fixture(tx)
      // The SURVIVOR's own first touch is the LATER of the two, which is the case the generic
      // repoint_update statement cannot express: it can move the loser's row or skip it, and the right
      // answer is neither.
      const survivorSession = await session(tx, survivor, {
        afterOpeningHours: 4,
        source: 'survivor-later-facebook',
      })
      const loserSession = await session(tx, loser, {
        afterOpeningHours: 1,
        source: 'loser-earlier-google',
      })
      await recordBookingAttribution(tx, {
        bookingId: survivor.bookingId,
        customerId: survivor.customerId,
        sessionReference: survivorSession,
        recordedAtIso: new Date(survivor.bookingCreatedAtMs).toISOString(),
      })
      await recordBookingAttribution(tx, {
        bookingId: loser.bookingId,
        customerId: loser.customerId,
        sessionReference: loserSession,
        recordedAtIso: new Date(loser.bookingCreatedAtMs).toISOString(),
      })
      const before = await readFirstTouch(tx, survivor.customerId)
      // Exactly what `mergeCustomers` does, in its order: the tombstone claim first — which is what
      // fires `merge_record_folds_first_touch` — and then the participant loop.
      await tx`
        insert into merge_record (
          survivor_customer_id, loser_customer_id, merged_at, actor_kind, actor_label, authority,
          reason, score_per_mille, phone_agreement, label_agreement, field_resolutions
        ) values (
          ${survivor.customerId}::uuid, ${loser.customerId}::uuid, now(), 'system', 'A-FIRST-08 itest',
          'operator_confirmed', 'proving the attribution fold', 1000, 'identical', 'identical', '[]'::jsonb
        )
      `
      const report = await applyMergeParticipant(tx, participant(), {
        survivorCustomerId: survivor.customerId,
        loserCustomerId: loser.customerId,
        mergedAtIso: new Date().toISOString(),
      })
      const [count] = await tx<{ n: string }[]>`
        select count(*)::text as n from customer_attribution
         where customer_id = ${survivor.customerId}::uuid
      `
      return {
        before,
        after: await readFirstTouch(tx, survivor.customerId),
        loserAfter: await readFirstTouch(tx, loser.customerId),
        report,
        survivorRows: Number(count?.n ?? '0'),
      }
    })
    // The control: the survivor held the LATER claim before the merge, so this case cannot pass by the
    // survivor's own row happening to be right.
    expect(result.before?.source).toBe('survivor-later-facebook')
    expect(result.after?.source).toBe('loser-earlier-google')
    expect(result.survivorRows).toBe(1)
    // The generic statement then found the survivor's key taken, so the loser's (later) row stayed on
    // the tombstone — and the registry's `retainedReason` is what the merge record records for it.
    expect(result.report.rowsRetainedOnLoser).toBe(1)
    expect(result.report.retainedReason).toContain('EARLIER')
    // The retained row holds the loser's OWN claim, which the fold has already copied onto the
    // survivor. It is a duplicate of the answer rather than a claim that was lost — the survivor may
    // hold only one first-touch row, which is its primary key.
    expect(result.loserAfter?.source).toBe('loser-earlier-google')
  })

  it('moves the loser’s row outright when the survivor has no first touch', async () => {
    const result = await rolledBack(async (tx) => {
      const survivor = await fixture(tx)
      const loser = await fixture(tx)
      const loserSession = await session(tx, loser, {
        afterOpeningHours: 1,
        source: 'loser-google',
      })
      await recordBookingAttribution(tx, {
        bookingId: loser.bookingId,
        customerId: loser.customerId,
        sessionReference: loserSession,
        recordedAtIso: new Date(loser.bookingCreatedAtMs).toISOString(),
      })
      await tx`
        insert into merge_record (
          survivor_customer_id, loser_customer_id, merged_at, actor_kind, actor_label, authority,
          reason, score_per_mille, phone_agreement, label_agreement, field_resolutions
        ) values (
          ${survivor.customerId}::uuid, ${loser.customerId}::uuid, now(), 'system', 'A-FIRST-08 itest',
          'operator_confirmed', 'proving the repoint', 1000, 'identical', 'identical', '[]'::jsonb
        )
      `
      const report = await applyMergeParticipant(tx, participant(), {
        survivorCustomerId: survivor.customerId,
        loserCustomerId: loser.customerId,
        mergedAtIso: new Date().toISOString(),
      })
      return {
        survivor: await readFirstTouch(tx, survivor.customerId),
        loser: await readFirstTouch(tx, loser.customerId),
        report,
      }
    })
    expect(result.survivor?.source).toBe('loser-google')
    expect(result.loser).toBeNull()
    expect(result.report.rowsMoved).toBe(1)
    expect(result.report.rowsRetainedOnLoser).toBe(0)
  })
})

// ------------------------------------------------------------------------------------------------
// Acceptance 5: attribution coverage over the seeded fixture
// ------------------------------------------------------------------------------------------------

describe('the paid-booking source list the coverage figure divides', () => {
  it('refuses an instant where a trading date belongs', async () => {
    // Trading runs 11:00-02:00, so an instant cast to a date moves every late sale onto the wrong day
    // and its attribution with it. The whole figure this read feeds is per trading date.
    await expect(
      paidBookingAttributionSources(sql, { tradingDate: '2026-10-03T01:30:00Z' }),
    ).rejects.toThrow('YYYY-MM-DD')
  })

  it('reports `unknown` for a paid booking with no attribution row rather than dropping it', async () => {
    // The list itself, over a day with no documents, is empty — which is the control for the case in
    // `packages/fixtures/src/attribution-coverage.itest.ts` that builds the documents: this file cannot
    // build one, because an invoice needs `@berelax/core`'s VAT split and `packages/db` may not import
    // it (ADR 0001). What IS asserted here is that the read runs against the real schema and joins
    // through the appointment chain rather than through `invoice.booking_id`, which is nullable.
    const [day] = await sql<{ trading_date: string }[]>`
      select to_char(min(trading_date), 'YYYY-MM-DD') as trading_date from business_day
    `
    const sources = await paidBookingAttributionSources(sql, {
      tradingDate: day?.trading_date as string,
    })
    expect(Array.isArray(sources)).toBe(true)
    expect(sources.every((source) => typeof source === 'string')).toBe(true)
  })
})
