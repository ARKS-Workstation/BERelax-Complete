import { fixedClock, formatCapturedBp, type Instant, refIssueCaptureRate } from '@berelax/core'
import {
  createConnection,
  issueWhatsappRef,
  readDailyRefCapture,
  readRefCaptureCounts,
  rollUpDailyRefCapture,
  type Sql,
  WHATSAPP_REF_MINT_ATTEMPTS,
  WHATSAPP_REF_SQLSTATE,
  whatsappRefError,
  withUnitOfWork,
} from '@berelax/db'
import { partitionWindowDate, SYNTHETIC_REF_CODE_PREFIX, syntheticPerson } from '@berelax/fixtures'
import {
  ANALYTICS_CONSENT_COOKIE,
  COLLECT_PATH,
  PROVISIONAL_WHATSAPP_REF_TTL_DAYS,
  SESSION_INACTIVITY_MS,
  WHATSAPP_REF_MESSAGE_PREFIX,
  whatsappLinkFor,
} from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claimRefForBooking } from '../app/(admin)/quick-book/ref-claim.ts'
import {
  type CollectEndpointDeps,
  handleCollectRequest,
  VISITOR_COOKIE,
} from '../app/api/collect/ingest.ts'
import {
  handleWhatsappIssueRequest,
  issueWhatsappRefForRequest,
  type WhatsappIssueDeps,
} from '../app/api/whatsapp/issue.ts'

/**
 * A-FIRST-07 — the WhatsApp reference-code loop, end to end, against a real PostgreSQL.
 *
 * ## What "end to end" means here, and what it deliberately does not
 *
 * The round trip is **session → `cta_click` → issued code → `wa.me` URL → desk claim → attribution**, and
 * every step is the production code path:
 *
 *   - the session is created by posting a real batch to `handleCollectRequest`, the same ingest the browser
 *     collector uses, with a real consent cookie;
 *   - the code is minted by `handleWhatsappIssueRequest`, and the assertions are made on the `Location`
 *     header it actually emits;
 *   - the claim goes through `claimRefForBooking`, which is the one function the quick-book handler calls.
 *
 * No server is started, so **no port band is taken** (brief rule 18) and the allocated
 * `{ start: 18_500, width: 300 }` is released. The handlers are called directly for `collect.itest.ts`'s
 * reason: three of the claims here are about a FROZEN clock — an expired code, a session idle past thirty
 * minutes — and a request over HTTP cannot have one, because `route.ts` builds the clock from the real one.
 * It is still a real `Request` in and a real `Response` out, so every claim about a status, a header and a
 * refusal is made against the bytes the route produces.
 *
 * The one step that is NOT driven from a browser is the quick-book FORM. `apps/web/src/quick-book.itest.ts`
 * owns that screen with Playwright against a built application, including the ref field, its pattern and
 * its notice; repeating it here would be a second copy of a suite that already exists, and the thing this
 * file is about is what happens to the row.
 *
 * ## Isolation, and why it needs saying twice
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind (brief
 * rule 12). Three consequences, all load-bearing:
 *
 *   - every code this file issues is on the `SYNTHETIC_REF_CODE_PREFIX` prefix, so
 *     `packages/fixtures/src/whatsapp-ref.itest.ts`'s "the code table ships empty" assertion still passes
 *     while these rows exist;
 *   - every count is read through `bookingIds`, narrowing what the query can SEE rather than assuming this
 *     file owns `booking_whatsapp_ref_capture`;
 *   - the day-level rollup is asserted on a trading date **thirty days in the past**, and the case asserts
 *     that day starts EMPTY before it writes. A rollup is an absolute figure over a whole day, so it is the
 *     one thing here that cannot be read as a delta — and a day no live code path can reach is the only
 *     way to make 10 issued and 4 claimed mean exactly ten and four.
 *
 * `premises.phone_whatsapp` is MUTATED by one case and restored in a `finally` from the value read back at
 * the start of it, which is `withEditedFile`'s shape applied to a row. It is the only way to exercise the
 * issued path at all: the acceptance line is that the link is composed from the premises row and nothing
 * else, so substituting the number through an injected dependency would stop the case proving the thing it
 * is for. The row holds the Y1-nap placeholder in every other case, which is the state this build is in.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'afirst07 ref loop itest'
const RUN = `afirst07-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** 21:00 Asia/Dubai on a date the seeded calendar holds, for `collect.itest.ts`'s reason. */
const TRADING_DATE = partitionWindowDate()
const TRADING_ISO = `${TRADING_DATE}T17:00:00.000Z`

/**
 * This file's codes, all on the shared fixture prefix.
 *
 * `QC` because `QA` is `whatsapp-ref.itest.ts`'s and `QB` is `quick-book.itest.ts`'s. Every character is in
 * the narrowed alphabet (no I, L, O, U, 0 or 1), which the first case asserts rather than assumes.
 */
const CODE_LIVE = 'QC23'
const CODE_EXPIRED = 'QC24'
const CODE_CONTESTED = 'QC25'
const CODE_TAKEN = 'QC26'
const CODE_FREE = 'QC27'
/** The ten the rollup case issues, on their own day. */
const ROLLUP_CODES = [
  'QC32',
  'QC33',
  'QC34',
  'QC35',
  'QC36',
  'QC37',
  'QC38',
  'QC39',
  'QC42',
  'QC43',
] as const
const FIXTURE_CODES = [
  CODE_LIVE,
  CODE_EXPIRED,
  CODE_CONTESTED,
  CODE_TAKEN,
  CODE_FREE,
  ...ROLLUP_CODES,
] as const

/** Sessions, as uuids: `whatsapp_ref.session_reference` admits nothing else since 0127. */
const SESSION_FIXTURE = '0195c000-0000-7000-8000-00000000000a'
const SESSION_OTHER = '0195c000-0000-7000-8000-00000000000b'

const ACTOR = { kind: 'staff', label: MARKER } as const

let sql: Sql
/** The two people: one claims, one contests. Both on the unallocated +971 59 fixture band. */
let customerId = ''
let otherCustomerId = ''
const bookingIds: string[] = []
/** A trading date thirty days back, and an instant inside its window. Both read off the calendar. */
let rollupDate = ''
let rollupIso = ''

const collectDeps = (iso: string): CollectEndpointDeps => ({
  sql,
  clock: fixedClock(iso),
  rateLimitHits: new Map(),
  ownHosts: ['berelax.example', 'www.berelax.example'],
})

const issueDeps = (iso: string): WhatsappIssueDeps => ({ sql, clock: fixedClock(iso) })

let eventSeq = 0

/** A `cta_click` on the WhatsApp target: the event that precedes an issue in production. */
const whatsappCtaBatch = (): Record<string, unknown> => {
  eventSeq += 1
  return {
    viewportWidth: 390,
    interactionCount: 2,
    interEventGapsMs: [900],
    query: null,
    referrer: null,
    events: [
      {
        name: 'cta_click',
        clientEventId: `${RUN}-${eventSeq}`,
        occurredAt: new Date(Date.parse(TRADING_ISO) + eventSeq * 1_000).toISOString(),
        payload: { target: 'whatsapp', path: `/en/${RUN}` },
      },
    ],
  }
}

const CONSENTED = `${ANALYTICS_CONSENT_COOKIE}=analytics_storage`

/** Posts one consented batch and returns the visitor cookie value and the session it landed in. */
async function startSession(
  iso: string,
): Promise<{ readonly visitorId: string; readonly sessionId: string }> {
  const response = await handleCollectRequest(
    collectDeps(iso),
    new Request(`http://127.0.0.1${COLLECT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: CONSENTED },
      body: JSON.stringify(whatsappCtaBatch()),
    }),
  )
  expect(response.status, await response.text()).toBe(204)
  const visitorId =
    new RegExp(`${VISITOR_COOKIE}=([^;]+)`).exec(response.headers.get('set-cookie') ?? '')?.[1] ??
    ''
  expect(visitorId, 'the ingest issued a visitor cookie').not.toBe('')
  const [row] = await sql<{ session_id: string }[]>`
    select session_id::text as session_id from analytics.session
     where visitor_id = ${visitorId}::uuid order by started_at desc limit 1
  `
  return { visitorId, sessionId: row?.session_id ?? '' }
}

const cookiesFor = (visitorId: string): string => `${CONSENTED}; ${VISITOR_COOKIE}=${visitorId}`

async function newBooking(forCustomerId = customerId): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${forCustomerId}, 'walk_in', ${MARKER})
    returning id::text as id
  `
  const id = (row as { id: string }).id
  bookingIds.push(id)
  return id
}

/** The premises row's WhatsApp value, swapped for the length of one body and then put back. */
async function withWhatsappNumber<T>(number: string, body: () => Promise<T>): Promise<T> {
  const [before] = await sql<{ phone_whatsapp: string | null }[]>`
    select phone_whatsapp from premises where id = 1
  `
  const original = before?.phone_whatsapp ?? null
  await sql`update premises set phone_whatsapp = ${number} where id = 1`
  try {
    return await body()
  } finally {
    // Restored from what was READ, not from a constant: whatever the row held — the Y1-nap placeholder
    // today, an owner's answer one day — is what comes back.
    await sql`update premises set phone_whatsapp = ${original} where id = 1`
  }
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  const mine = syntheticPerson(7_401)
  const other = syntheticPerson(7_402)
  const [first] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${mine.phone}, 'front_desk')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id::text as id
  `
  customerId = (first as { id: string }).id
  const [second] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${other.phone}, 'front_desk')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id::text as id
  `
  otherCustomerId = (second as { id: string }).id
  // The rollup's day, read off the calendar rather than written down: the seeded calendar moves with the
  // clock, so a pinned date eventually falls outside it (the ZY061 class of failure `collect.itest.ts`
  // records). `opens_at` is inside the window by construction, so the basis is `trading`.
  const [day] = await sql<{ trading_date: string; opens_at: Date }[]>`
    select trading_date::text as trading_date, opens_at
      from business_day where trading_date = current_date - 30
  `
  if (day === undefined) {
    throw new Error(
      'business_day holds no row 30 days back, so the rollup case has no day of its own to count. The ' +
        'seeded calendar normally spans several months either side of today — run `pnpm seed`.',
    )
  }
  rollupDate = day.trading_date
  rollupIso = day.opens_at.toISOString()
})

afterAll(async () => {
  if (sql === undefined) return
  /*
    Capture rows, then bookings, then codes, then the rollup row, then the customers.

    `booking_whatsapp_ref_capture.booking_id` is deliberately NOT a foreign key (0079's header), so nothing
    cascades and a fixture that removed only its bookings would leave capture rows behind — counted in
    every later capture rate for ever. `ref_code` IS one, ON DELETE RESTRICT, so the codes cannot go until
    the rows naming them have.

    `analytics.daily_ref_capture` is removed for the day this file owns ONLY. It is a rollup kept
    indefinitely, and leaving a row claiming ten issued codes on a day whose codes no longer exist would be
    a figure nothing can reproduce.

    Nothing in `analytics.visitor`, `analytics.session` or `analytics.event` is removed: events are
    append-only (ZY065) and every row this file created is reached through a visitor id it minted.
  */
  if (bookingIds.length > 0) {
    await sql`delete from booking_whatsapp_ref_capture where booking_id = any(${bookingIds}::uuid[])`
    await sql`delete from booking where id = any(${bookingIds}::uuid[])`
  }
  await sql`delete from whatsapp_ref where ref_code like ${`${SYNTHETIC_REF_CODE_PREFIX}C%`}`
  if (rollupDate !== '') {
    await sql`delete from analytics.daily_ref_capture where trading_date = ${rollupDate}::date`
  }
  await sql`delete from customer where id = any(${[customerId, otherCustomerId]}::uuid[])`
  await sql.end({ timeout: 5 })
})

describe('acceptance — the round trip: session, code, wa.me link, claim, attribution', () => {
  it('issues a code bound to the session the CTA click belongs to, and attributes the booking to it', async () => {
    const { visitorId, sessionId } = await startSession(TRADING_ISO)
    expect(sessionId, 'the consented batch created a session').not.toBe('')

    // The unallocated +971 59 band every synthetic number comes from, so this cannot reach a handset.
    // It is a FIXTURE number and not a candidate for Y1-nap: nothing here ranks the two numbers docs/13
    // §3 records, and the row is restored before the case returns.
    const number = syntheticPerson(7_403).phone
    const { refCode, href } = await withWhatsappNumber(number, async () => {
      const response = await handleWhatsappIssueRequest(
        issueDeps(TRADING_ISO),
        new Request('http://127.0.0.1/api/whatsapp', {
          headers: { cookie: cookiesFor(visitorId) },
        }),
      )
      expect(response.status).toBe(303)
      // Never cached: a cached 303 would send a second customer to the first one's conversation code.
      expect(response.headers.get('cache-control')).toBe('no-store')
      const location = response.headers.get('location') ?? ''
      const text = new URL(location).searchParams.get('text') ?? ''
      // THE acceptance line: the text begins `Ref: <code>`.
      expect(text.startsWith(WHATSAPP_REF_MESSAGE_PREFIX)).toBe(true)
      const code = text.slice(WHATSAPP_REF_MESSAGE_PREFIX.length).split('\n')[0] ?? ''
      // Composed from the ROW: the same builder, handed the same number, produces the same link. A
      // number assembled anywhere else would not match, which is the half a grep cannot check.
      const composed = whatsappLinkFor({ phoneWhatsapp: number, text })
      expect(composed.kind).toBe('link')
      if (composed.kind === 'link') expect(composed.href).toBe(location)
      return { refCode: code, href: location }
    })

    expect(href).toContain('wa.me')
    // The code is bound to the session, in the row, and the lifetime is the provisional TTL.
    const [issued] = await sql<{ session_reference: string; issued_at: Date; expires_at: Date }[]>`
        select session_reference::text as session_reference, issued_at, expires_at
          from whatsapp_ref where ref_code = ${refCode}
      `
    expect(issued?.session_reference).toBe(sessionId)
    expect((issued?.expires_at.getTime() ?? 0) - (issued?.issued_at.getTime() ?? 0)).toBe(
      PROVISIONAL_WHATSAPP_REF_TTL_DAYS * 24 * 60 * 60 * 1_000,
    )

    // The desk claims it, in whatever case the phone had it — the normaliser is what makes that one code.
    const bookingId = await newBooking()
    const { capture } = await claimRefForBooking(sql, ACTOR, {
      bookingId,
      entered: ` ${refCode.toLowerCase()} `,
      at: Date.parse(TRADING_ISO) as Instant,
    })
    expect(capture.outcome).toBe('matched')
    expect(capture.refCode).toBe(refCode)
    // The whole point of the unit: the booking names the session the conversation started in.
    expect(capture.attributedSessionId).toBe(sessionId)
    const [row] = await sql<{ attributed_session_id: string | null }[]>`
        select attributed_session_id::text as attributed_session_id
          from booking_whatsapp_ref_capture where booking_id = ${bookingId}::uuid
      `
    expect(row?.attributed_session_id).toBe(sessionId)
    // The code this run issued is on no fixture prefix, so it is removed by id rather than by the
    // prefix sweep in `afterAll`. Done here because the capture row that references it has just gone.
    await sql`delete from booking_whatsapp_ref_capture where booking_id = ${bookingId}::uuid`
    await sql`delete from booking where id = ${bookingId}::uuid`
    bookingIds.splice(bookingIds.indexOf(bookingId), 1)
    await sql`delete from whatsapp_ref where ref_code = ${refCode}`
  }, 30_000)

  it('refuses to issue while the premises row holds no dialable number, and writes nothing', async () => {
    // The state this build is in, asserted against the row as seeded rather than against a stand-in.
    const { visitorId } = await startSession(TRADING_ISO)
    const before = await sql<{ n: string }[]>`select count(*)::text as n from whatsapp_ref`
    const response = await handleWhatsappIssueRequest(
      issueDeps(TRADING_ISO),
      new Request('http://127.0.0.1/api/whatsapp', {
        headers: { cookie: cookiesFor(visitorId) },
      }),
    )
    expect(response.status).toBe(503)
    expect(response.headers.get('x-berelax-refusal')).toBe('whatsapp_number_unanswered')
    expect(await response.text()).toContain('Y1-nap')
    // NO code was minted, which is the decision rather than a side effect: `codes_issued` is the
    // denominator of the capture rate, and a code minted into an unsendable message would make a missing
    // phone number read as a front-desk failure.
    const after = await sql<{ n: string }[]>`select count(*)::text as n from whatsapp_ref`
    expect(Number(after[0]?.n ?? -1)).toBe(Number(before[0]?.n ?? -2))
  })

  it('refuses a visitor who has not consented, and one whose session has gone idle', async () => {
    const { visitorId } = await startSession(TRADING_ISO)
    const number = syntheticPerson(7_404).phone
    await withWhatsappNumber(number, async () => {
      // No consent cookie at all: before a consent decision there is no session row (ADR 0066), so there
      // is nothing to bind a code to — and a code bound to nothing is a denominator with no numerator.
      const unconsented = await handleWhatsappIssueRequest(
        issueDeps(TRADING_ISO),
        new Request('http://127.0.0.1/api/whatsapp', {
          headers: { cookie: `${VISITOR_COOKIE}=${visitorId}` },
        }),
      )
      expect(unconsented.status).toBe(409)
      expect(unconsented.headers.get('x-berelax-refusal')).toBe('analytics_not_consented')

      // Consented, but the session has been idle one millisecond past the thirty-minute window, so the
      // next collected event starts a DIFFERENT session from the one a code would name.
      const stale = await handleWhatsappIssueRequest(
        issueDeps(new Date(Date.parse(TRADING_ISO) + SESSION_INACTIVITY_MS + 1).toISOString()),
        new Request('http://127.0.0.1/api/whatsapp', {
          headers: { cookie: cookiesFor(visitorId) },
        }),
      )
      expect(stale.status).toBe(409)
      expect(stale.headers.get('x-berelax-refusal')).toBe('no_live_session')

      // The control: one millisecond INSIDE the window is issued, so the two refusals above are the
      // window and not a blanket refusal.
      const live = await issueWhatsappRefForRequest(
        issueDeps(new Date(Date.parse(TRADING_ISO) + SESSION_INACTIVITY_MS - 1).toISOString()),
        new Request('http://127.0.0.1/api/whatsapp', {
          headers: { cookie: cookiesFor(visitorId) },
        }),
      )
      expect(live.kind).toBe('issued')
      if (live.kind === 'issued')
        await sql`delete from whatsapp_ref where ref_code = ${live.refCode}`
    })
  })
})

describe('acceptance — an expired code and a contested one still take the booking', () => {
  it('records ref_expired, keeps the code, and claims no session', async () => {
    // SIXTY days back and not thirty, because thirty is the day the rollup case counts and a code issued
    // there would make "ten issued" eleven. The first run of that case caught it, which is why it asserts
    // the day is empty before it writes rather than trusting the arithmetic here.
    const issuedAt = new Date(Date.parse(TRADING_ISO) - 60 * 24 * 60 * 60 * 1_000)
    await withUnitOfWork(sql, ACTOR, (uow) =>
      issueWhatsappRef(uow, {
        sessionReference: SESSION_FIXTURE,
        refCode: CODE_EXPIRED,
        issuedAt,
        ttlDays: 7,
      }),
    )
    const bookingId = await newBooking()
    const { capture } = await claimRefForBooking(sql, ACTOR, {
      bookingId,
      entered: CODE_EXPIRED,
      at: Date.parse(TRADING_ISO) as Instant,
    })
    // The booking exists and the capture row exists: the ref field never blocks a booking.
    expect(capture.outcome).toBe('ref_expired')
    expect(capture.refCode).toBe(CODE_EXPIRED)
    expect(capture.attributedSessionId).toBeNull()
    const [row] = await sql<{ outcome: string; ref_code: string | null }[]>`
      select outcome::text as outcome, ref_code from booking_whatsapp_ref_capture
       where booking_id = ${bookingId}::uuid
    `
    expect(row?.outcome).toBe('ref_expired')
    expect(row?.ref_code).toBe(CODE_EXPIRED)
  })

  it('records ref_conflict for another customer’s code, and does not move the first attribution', async () => {
    await withUnitOfWork(sql, ACTOR, (uow) =>
      issueWhatsappRef(uow, { sessionReference: SESSION_FIXTURE, refCode: CODE_CONTESTED }),
    )
    const first = await newBooking()
    const firstClaim = await claimRefForBooking(sql, ACTOR, {
      bookingId: first,
      entered: CODE_CONTESTED,
      at: Date.now() as Instant,
    })
    expect(firstClaim.capture.outcome).toBe('matched')

    // A DIFFERENT customer types the same code.
    const second = await newBooking(otherCustomerId)
    const secondClaim = await claimRefForBooking(sql, ACTOR, {
      bookingId: second,
      entered: CODE_CONTESTED,
      at: Date.now() as Instant,
    })
    expect(secondClaim.capture.outcome).toBe('ref_conflict')
    expect(secondClaim.capture.attributedSessionId).toBeNull()
    // The FIRST claim is untouched, which is the whole of "surfaces it rather than reassigning silently".
    const [original] = await sql<{ attributed_session_id: string | null }[]>`
      select attributed_session_id::text as attributed_session_id
        from booking_whatsapp_ref_capture where booking_id = ${first}::uuid
    `
    expect(original?.attributed_session_id).toBe(SESSION_FIXTURE)

    // And the SAME customer booking twice out of one conversation is not a conflict: the code identifies a
    // conversation, so both of that person's bookings came from it.
    const third = await newBooking()
    const thirdClaim = await claimRefForBooking(sql, ACTOR, {
      bookingId: third,
      entered: CODE_CONTESTED,
      at: Date.now() as Instant,
    })
    expect(thirdClaim.capture.outcome).toBe('matched')
    expect(thirdClaim.capture.attributedSessionId).toBe(SESSION_FIXTURE)
  })

  it('returns a named error for an unknown code and never a silent unattributed success', async () => {
    const bookingId = await newBooking()
    const { capture } = await claimRefForBooking(sql, ACTOR, {
      bookingId,
      entered: 'zz99',
      at: Date.now() as Instant,
    })
    // NAMED: the outcome says which kind of unknown it is, and what was typed is kept — normalised, so a
    // code issued later joins against it. A silent success would be `matched` with no row behind it, which
    // the enum makes unrepresentable and the trigger refuses.
    expect(capture.outcome).toBe('unknown_code')
    expect(capture.enteredCode).toBe('ZZ99')
    expect(capture.refCode).toBeNull()
    expect(capture.attributedSessionId).toBeNull()
  })
})

describe('acceptance — the database refuses an attribution nobody proved', () => {
  it('refuses a matched row naming an expired code (ZY331)', async () => {
    const bookingId = await newBooking()
    // A direct INSERT, which is the point: the rule in `@berelax/core` already refuses this, and what is
    // asserted here is that a later unit, a backfill or a psql session cannot get round it.
    const attempt = sql`
      insert into booking_whatsapp_ref_capture
        (booking_id, outcome, ref_code, attributed_session_id)
      values (${bookingId}::uuid, 'matched', ${CODE_EXPIRED}, ${SESSION_FIXTURE}::uuid)
    `
    await expect(attempt).rejects.toThrow(/expired at/)
    const error = await attempt.catch((err: unknown) => err)
    expect((error as { code?: string }).code).toBe(WHATSAPP_REF_SQLSTATE.claimAfterExpiry)
    // Translated to a `conflict`, because it would have been accepted an hour earlier and the remedy is a
    // different outcome on the same booking rather than a failed booking.
    expect(whatsappRefError(error)?.kind).toBe('conflict')
  })

  it('refuses a matched row naming a session the code was not issued into (ZY332)', async () => {
    const bookingId = await newBooking()
    const attempt = sql`
      insert into booking_whatsapp_ref_capture
        (booking_id, outcome, ref_code, attributed_session_id)
      values (${bookingId}::uuid, 'matched', ${CODE_CONTESTED}, ${SESSION_OTHER}::uuid)
    `
    await expect(attempt).rejects.toThrow(/was issued into session/)
    const error = await attempt.catch((err: unknown) => err)
    expect((error as { code?: string }).code).toBe(WHATSAPP_REF_SQLSTATE.attributionNotProved)
    // `invariant_violated` and not `validation`: this code, not the person at the counter, built it.
    expect(whatsappRefError(error)?.kind).toBe('invariant_violated')
  })

  it('accepts the row the rule does produce, which is the control', async () => {
    // Without this, both refusals above would be satisfied by a trigger that refused everything.
    await withUnitOfWork(sql, ACTOR, (uow) =>
      issueWhatsappRef(uow, { sessionReference: SESSION_FIXTURE, refCode: CODE_LIVE }),
    )
    const bookingId = await newBooking()
    const { capture } = await claimRefForBooking(sql, ACTOR, {
      bookingId,
      entered: CODE_LIVE,
      at: Date.now() as Instant,
    })
    expect(capture.outcome).toBe('matched')
    expect(capture.attributedSessionId).toBe(SESSION_FIXTURE)
  })
})

describe('acceptance — a collision inside the TTL window is refused and redrawn', () => {
  it('refuses to reissue a live code, and leaves the original pointing where it did', async () => {
    const original = await withUnitOfWork(sql, ACTOR, (uow) =>
      issueWhatsappRef(uow, { sessionReference: SESSION_FIXTURE, refCode: CODE_TAKEN }),
    )
    // The unique index is the PRIMARY KEY, and it refuses a duplicate inside the TTL window and outside it
    // alike — because the code is never recycled. A direct insert first, so the refusal is the index's.
    await expect(
      sql`
        insert into whatsapp_ref (ref_code, session_reference, expires_at)
        values (${CODE_TAKEN}, ${SESSION_OTHER}::uuid, now() + interval '7 days')
      `,
    ).rejects.toThrow(/whatsapp_ref_pkey/)
    // And through the repository: `on conflict do nothing` plus a row count, so the second conversation is
    // refused rather than being handed a code that already names the first one.
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        issueWhatsappRef(uow, { sessionReference: SESSION_OTHER, refCode: CODE_TAKEN }),
      ),
    ).rejects.toThrow(/Could not issue a WhatsApp ref code in 1 attempt/)
    const [row] = await sql<{ session_reference: string; expires_at: Date }[]>`
      select session_reference::text as session_reference, expires_at
        from whatsapp_ref where ref_code = ${CODE_TAKEN}
    `
    expect(row?.session_reference).toBe(SESSION_FIXTURE)
    expect(row?.expires_at.toISOString()).toBe(original.expiresAtIso)
  })

  it('redraws when a drawn candidate is already taken, and gives up after the budget', async () => {
    // The generator is a parameter so the collision can be FORCED rather than waited for: the alternative
    // is filling enough of an 810,000-code space to make a draw collide, which is a slow case whose
    // non-vacuity is a probability. See `issueWhatsappRef`'s own note on the parameter.
    const drawn: string[] = []
    const after = (...codes: readonly string[]) => {
      let index = 0
      return () => {
        const code = codes[Math.min(index, codes.length - 1)] ?? CODE_FREE
        index += 1
        drawn.push(code)
        return code
      }
    }
    const issued = await withUnitOfWork(sql, ACTOR, (uow) =>
      issueWhatsappRef(
        uow,
        { sessionReference: SESSION_OTHER },
        after(CODE_TAKEN, CODE_TAKEN, CODE_FREE),
      ),
    )
    // Two collisions, then a free code. The third draw is the one that landed.
    expect(drawn).toEqual([CODE_TAKEN, CODE_TAKEN, CODE_FREE])
    expect(issued.refCode).toBe(CODE_FREE)
    expect(issued.sessionReference).toBe(SESSION_OTHER)

    // And the budget is bounded: a generator that only ever returns a taken code exhausts it and raises,
    // rather than falling back to a longer code the field, the column and the desk would all refuse.
    const exhausting: string[] = []
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        issueWhatsappRef(uow, { sessionReference: SESSION_OTHER }, () => {
          exhausting.push(CODE_TAKEN)
          return CODE_TAKEN
        }),
      ),
    ).rejects.toThrow(new RegExp(`in ${WHATSAPP_REF_MINT_ATTEMPTS} attempt`))
    expect(exhausting.length).toBe(WHATSAPP_REF_MINT_ATTEMPTS)
  })

  it('refuses a lifetime that would make the code dead on arrival', async () => {
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        issueWhatsappRef(uow, { sessionReference: SESSION_FIXTURE, ttlDays: 0 }),
      ),
    ).rejects.toThrow(/whole number of days, at least one/)
  })
})

describe('acceptance — the day-level capture rate', () => {
  it('writes ten issued and four claimed for one day, which reads as exactly 40.0%', async () => {
    // The day starts empty, asserted rather than assumed: a rollup is an absolute figure over a whole
    // trading day, so it is the one thing in this file that cannot be read as a delta.
    const [existing] = await sql<{ n: string }[]>`
        select count(*)::text as n from whatsapp_ref r
          join business_day b on b.trading_date = ${rollupDate}::date
         where r.issued_at >= b.opens_at and r.issued_at < b.closes_at
      `
    expect(
      Number(existing?.n ?? -1),
      `${rollupDate} already holds issued codes, so ten and four could not mean ten and four`,
    ).toBe(0)

    const issuedAt = new Date(rollupIso)
    for (const code of ROLLUP_CODES) {
      await withUnitOfWork(sql, ACTOR, (uow) =>
        issueWhatsappRef(uow, {
          sessionReference: SESSION_FIXTURE,
          refCode: code,
          issuedAt,
          // Long enough that the claims below are inside the window: the rate is about the loop, not
          // about the lifetime, and an expired code would be counted as issued and not claimed.
          ttlDays: 90,
        }),
      )
    }
    for (const code of ROLLUP_CODES.slice(0, 4)) {
      const bookingId = await newBooking()
      const { capture } = await claimRefForBooking(sql, ACTOR, {
        bookingId,
        entered: code,
        at: Date.now() as Instant,
      })
      expect(capture.outcome, code).toBe('matched')
    }

    // The claim path already rolled the day up, in the same transaction as each capture. Recomputing it
    // here must therefore change nothing but `computed_at`, which is what "idempotent" means.
    const first = await withUnitOfWork(sql, ACTOR, (uow) =>
      rollUpDailyRefCapture(uow, { atIso: rollupIso }),
    )
    expect(first.tradingDate).toBe(rollupDate)
    expect(first.tradingDateBasis).toBe('trading')
    expect(first.codesIssued).toBe(10)
    expect(first.codesClaimed).toBe(4)

    const rate = refIssueCaptureRate({ issued: first.codesIssued, claimed: first.codesClaimed })
    expect(rate.claimedBp).toBe(4_000)
    // "yields exactly 40.0%" — the acceptance line, as the string a report prints.
    expect(formatCapturedBp(rate.claimedBp)).toBe('40.0%')
    // Reported, not judged: nobody has said the desk is expected to paste the code (Y12-ref-loop).
    expect(rate.claim).toBe('loop_unconfirmed')

    // Read back through the reader the funnel will use, and then recomputed a second time: two runs
    // produce identical figures, which is what makes it safe to call on every write.
    const stored = await readDailyRefCapture(sql, {
      tradingDate: rollupDate,
      tradingDateBasis: 'trading',
    })
    expect(stored?.codesIssued).toBe(10)
    expect(stored?.codesClaimed).toBe(4)
    const second = await withUnitOfWork(sql, ACTOR, (uow) =>
      rollUpDailyRefCapture(uow, { atIso: rollupIso }),
    )
    expect(second.codesIssued).toBe(first.codesIssued)
    expect(second.codesClaimed).toBe(first.codesClaimed)
  }, 30_000)

  it('counts every outcome in the booking-side rate, with no bucket left out', async () => {
    // The five counts, narrowed to this file's bookings. The sum must equal the number of capture rows: a
    // sixth outcome added without a change to `readRefCaptureCounts` would be silently absent from the
    // denominator, and the capture rate would be computed over a subset while looking exactly right.
    const counts = await readRefCaptureCounts(sql, { bookingIds })
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from booking_whatsapp_ref_capture
       where booking_id = any(${bookingIds}::uuid[])
    `
    expect(
      counts.matched +
        counts.unknownCode +
        counts.notOffered +
        counts.refExpired +
        counts.refConflict,
    ).toBe(Number(row?.n ?? -1))
    // And each of this file's own outcomes is actually represented, so the sum is not a sum of zeroes.
    expect(counts.matched).toBeGreaterThan(0)
    expect(counts.refExpired).toBeGreaterThan(0)
    expect(counts.refConflict).toBeGreaterThan(0)
    expect(counts.unknownCode).toBeGreaterThan(0)
  })

  it('uses only codes on the fixture prefix, so the empty-table claim elsewhere still holds', () => {
    // `packages/fixtures/src/whatsapp-ref.itest.ts` asserts that no code outside the fixture prefix exists,
    // which is how it states "this build mints nothing" without owning the table. Every code above is on
    // that prefix, and this is where that is checked rather than left to a reader.
    for (const code of FIXTURE_CODES) {
      expect(code.startsWith(SYNTHETIC_REF_CODE_PREFIX), code).toBe(true)
    }
    expect(new Set(FIXTURE_CODES).size).toBe(FIXTURE_CODES.length)
  })
})
