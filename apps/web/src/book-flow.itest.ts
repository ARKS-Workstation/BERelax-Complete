import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ASIA_DUBAI,
  BOOKING_EDGE_STATES,
  type BookingEdgeState,
  grossMoneyFromFils,
  type Instant,
  solveAvailabilityQuery,
  splitGross,
  toLocal,
} from '@berelax/core'
import {
  type AvailabilityRequest,
  type AvailabilitySolve,
  createAvailabilityCache,
  createConnection,
  hashOtpCode,
  OTP_CODE_DIGITS,
  OTP_MAX_REQUESTS_PER_PHONE,
  OTP_PHONE_WINDOW_MINUTES,
  OTP_RESEND_COOLDOWN_SECONDS,
  queryAvailability,
  readAvailabilityLimits,
  readBookableVariants,
  readGenderMatching,
  readMandatoryDocumentTypes,
  readOtpResendWindow,
  type Sql,
} from '@berelax/db'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import { DETERMINISTIC_LAUNCH_ARGS } from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { auditTouchTargetsInPage, touchTargetInputFor } from '@berelax/harness/touch-targets'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BOOK_BUDGET,
  type BookBudgetMeasurement,
  formatBookBudgetFindings,
  judgeBookBudget,
} from './book/budget.ts'
import { BOOK_SESSION_COOKIE, bookingIdempotencyKey, resendCooldownSeconds } from './book/flow.ts'
import { BOOK_FIELDS, bookHref, wallClock } from './book/state.ts'

/**
 * B-UI-02 — steps 4 and 5 of the public booking flow, driven against the built application and a real
 * PostgreSQL.
 *
 * Every claim in this unit's acceptance list is a claim about rendered output, a served response, a
 * database row or a measured millisecond, and not one of them can be checked by reading source:
 *
 *   - **E.164 on blur** is a value in an input after a real blur event in a real browser;
 *   - **`autocomplete="one-time-code"`, `inputmode` numeric and a resend cooldown** are attributes on the
 *     served bytes, which is where a browser reads them from;
 *   - **the nine edge states** are nine rendered panels, each reached by putting the world into the state
 *     it is about — an appointment inserted over the chosen slot, a therapist's period filled, the single
 *     wet room taken, a closing time moved, a session expired in the table;
 *   - **double submission** is an appointment row COUNT and a second response's booking id;
 *   - **the ICS discretion rule** is the bytes of a downloaded file;
 *   - **the budget** is two numbers a browser measured.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind
 * (CONTRIBUTING-AGENT-BRIEF §12). This file owns:
 *
 *   - its own trading dates, at `+{@link SPAN_FROM}..{@link SPAN_TO}` days from the run's own clock. That
 *     window is past the seeded fixture horizon (`FIXTURE_TODAY + 28`) and past B-UI-01's 24–40, so no
 *     other suite's rows are on them, and it is well inside `booking.max_advance_days`;
 *   - its own employees, carrying {@link MARKER};
 *   - **one phone number per session it mints**, from {@link probePhone}'s block, which nothing else in the
 *     repository uses. That is not tidiness: `OTP_MAX_REQUESTS_PER_PHONE` is three per fifteen minutes, so
 *     a file that minted six sessions on one number would rate-limit itself half way through and the
 *     failure would read as a bug in the flow.
 *
 * It uses the **seeded** catalogue rather than a probe service, so nothing here publishes a treatment.
 * Every assertion is a key-set comparison or a delta, never a total on a shared table — and `consent` is
 * append-only (C-CRM-03 revokes DELETE for every role), so the consent assertion is a delta by necessity
 * as well as by rule and the rows this file writes stay in the table.
 *
 * ## Why the OTP code is written into the challenge row
 *
 * `issueOtpChallenge` returns the plaintext code exactly once, to the process that sends it — and that
 * process is a separate `next start`, whose in-memory outbox this file cannot read. So the fixture does the
 * only thing that is left: it lets the real endpoint issue and send a real challenge, and then replaces
 * that row's `code_hash` and `code_salt` with the hash of a code it knows, through the same
 * {@link hashOtpCode} the repository uses. Nothing about the verification path is stubbed — the expiry, the
 * single-use rule, the attempt counter and the lock are all the real ones.
 */

/**
 * Assigned in `beforeAll`, because the port is ACQUIRED rather than drawn — see
 * `packages/harness/src/server.ts` for why a module-scope origin made a collision undiagnosable.
 */
let BASE = ''
const APP_DIR = new URL('..', import.meta.url).pathname

const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '') {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const MARKER = 'bui02 book-flow itest'
/** Internal handles, never display names (ADR 0020). Two: one to occupy, one to stay free. */
const REFERENCES = ['bui02-a', 'bui02-b'] as const
/** The seeded treatment this file books: needs a standard room, of which there are three. */
const PROBE_SLUG = 'asian-normal-massage'
const PROBE_DURATION = 60
/** The seeded treatment that needs the **single** wet room. The room-type edge state turns on that. */
const WET_SLUG = 'asian-morocco-bath-jacuzzi'

/**
 * A phone number this file owns, one per session.
 *
 * `59` is unallocated by the TDRA and therefore undialable, which is why the synthetic fixtures use it
 * (`packages/fixtures/src/synthetic.ts`). The `590682` block is used by nothing else in this repository.
 */
const probePhone = (index: number): string => `+971590682${String(index).padStart(3, '0')}`
const PHONE_PREFIX = '+971590682'

/** The code the fixture writes into a live challenge. Six digits, as `auth.otp` renders. */
const KNOWN_CODE = '424242'

const SPAN_FROM = 50
const SPAN_TO = 62
/** The day this file books on. Inside the span, and far from its edges so a shift covers the whole day. */
const FREE_OFFSET = 52

const CAPTURE_LABEL = 'book-flow'

let sql: Sql
let server: WebServer
let browser: Browser
let variantId = ''
let variantName = ''
let variantStyle = ''
let variantTreatmentKey = ''
let variantGrossFils = ''
let wetVariantId = ''
let now = 0
let freeDate = ''
let roomIds: string[] = []
let wetRoomId = ''
const insertedDates: string[] = []
const staff = new Map<string, string>()
/** Incremented for every session this file mints, so no number is asked for a fourth code. */
let phoneCounter = 0

const idOf = (reference: string): string => {
  const id = staff.get(reference)
  if (id === undefined) throw new Error(`no fixture employee ${reference}`)
  return id
}

const localDateOf = (instant: number): string => toLocal(instant as Instant, ASIA_DUBAI).date

const shiftDate = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

const at = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+04:00`)

/** Core's rule, injected exactly as the page injects it. `satisfies`, not a cast. */
const solve = solveAvailabilityQuery satisfies AvailabilitySolve

/** The starts the availability engine offers, computed independently of the page. */
async function offeredStarts(args: {
  readonly tradingDate: string
  readonly serviceVariantId?: string
  readonly therapistId?: string
}): Promise<readonly number[]> {
  const [limits, genderMatching] = await Promise.all([
    readAvailabilityLimits(sql),
    readGenderMatching(sql),
  ])
  const request: AvailabilityRequest = {
    tradingDate: args.tradingDate,
    serviceVariantId: args.serviceVariantId ?? variantId,
    minLeadMinutes: limits.minLeadMinutes,
    maxAdvanceDays: limits.maxAdvanceDays,
    clientGender: 'female',
    genderMatching,
    ...(args.therapistId === undefined ? {} : { therapistIds: [args.therapistId] }),
  }
  const answer = await queryAvailability(sql, request, {
    solve,
    // A cache of this file's own, so a mutation it makes between two reads is visible to the second. The
    // page's memo is validated against `availability_epoch` and is not the thing under test here.
    cache: createAvailabilityCache(),
    now,
  })
  return answer.slots.map((slot) => slot.startsAt).sort((left, right) => left - right)
}

async function addEmployee(reference: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, notes)
    values (${reference}, 'female', '2020-01-01', ${MARKER})
    on conflict (staff_reference) do update set notes = excluded.notes
    returning id
  `
  const id = (row as { id: string }).id
  staff.set(reference, id)
  await sql`
    insert into employee_skill (employee_id, skill) values (${id}, 'asian_style')
    on conflict do nothing
  `
  // Without a row per mandatory document type the read model answers `credential_missing` and the
  // therapist is not bookable at all (B-AVAIL-04). The set is read IN FORCE rather than named.
  for (const documentType of await readMandatoryDocumentTypes(sql)) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${id}, ${documentType}::employee_document_type, '2099-12-31')
      on conflict do nothing
    `
  }
  return id
}

/** One committed appointment, used to occupy a therapist or a room. */
async function occupy(args: {
  readonly bookingId: string
  readonly tradingDate: string
  readonly roomId: string
  readonly therapistId: string
  readonly startsAt: number
  readonly minutes?: number
  /** The treatment being occupied with. The wet-room case needs the one that belongs in that room. */
  readonly serviceVariantId?: string
}): Promise<void> {
  const gross = grossMoneyFromFils(variantGrossFils)
  const split = splitGross(gross)
  const endsAt = args.startsAt + (args.minutes ?? PROBE_DURATION) * 60_000
  await sql`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
       gross_price_fils, net_fils, vat_fils)
    values (${args.bookingId}, ${args.tradingDate}, ${args.serviceVariantId ?? variantId}, 'solo',
            ${args.therapistId},
            ${args.roomId},
            ${`[${new Date(args.startsAt).toISOString()},${new Date(endsAt).toISOString()})`}::tstzrange,
            'confirmed', uuid_generate_v7(), 1, 20, 10,
            ${gross.fils}, ${split.net.fils}, ${split.vat.fils})
  `
}

/** A booking row this file owns, to hang occupying appointments off. */
async function fixtureBooking(): Promise<string> {
  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${probePhone(999)}, 'front_desk')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${(customer as { id: string }).id}, 'front_desk', ${MARKER}) returning id
  `
  return (booking as { id: string }).id
}

// ── Driving the flow over HTTP ─────────────────────────────────────────────────────────────────────

interface FlowResponse {
  readonly status: number
  readonly location: string
  readonly cookie: string | null
}

/** The session cookie a response set, as a `Cookie` header value. */
function cookieFrom(response: Response): string | null {
  const header = response.headers.get('set-cookie')
  if (header === null) return null
  const pair = header.split(';')[0]?.trim() ?? ''
  return pair.startsWith(`${BOOK_SESSION_COOKIE}=`) ? pair : null
}

/**
 * One POST to the flow endpoint, with no redirect followed.
 *
 * `redirect: 'manual'` on purpose: the 303 IS the assertion in several cases below, and a followed
 * redirect would hide both the status and the `Location` the flow decided on.
 */
async function flowPost(
  fields: Readonly<Record<string, string | number | null>>,
  cookie?: string | null,
  callerIp?: string,
): Promise<FlowResponse> {
  const body = new URLSearchParams()
  for (const [name, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) body.set(name, String(value))
  }
  const response = await fetch(`${BASE}/api/v1/book`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie === null || cookie === undefined ? {} : { cookie }),
      // One address per session this file mints, because `OTP_MAX_REQUESTS_PER_IP` is ten an hour and this
      // file mints more sessions than that — every case after the tenth would otherwise be refused with a
      // 429, and the failure would read as a bug in the flow rather than as a fixture sharing one caller.
      // The per-IP limit is B-LIFE-02's own property and is asserted in `otp-route.itest.ts`; simulating
      // distinct callers here is not weakening it, it is declining to re-prove it thirty times.
      ...(callerIp === undefined ? {} : { 'x-forwarded-for': callerIp }),
    },
    body,
  })
  return {
    status: response.status,
    location: response.headers.get('location') ?? '',
    cookie: cookieFrom(response),
  }
}

/** The served bytes of one URL, optionally with a session cookie. */
async function fetchHtml(url: string, cookie?: string | null): Promise<string> {
  const response = await fetch(url, {
    redirect: 'manual',
    ...(cookie === null || cookie === undefined ? {} : { headers: { cookie } }),
  })
  expect(response.status, `${url} did not answer 200`).toBe(200)
  return await response.text()
}

const bookUrl = (fields: Readonly<Record<string, string | number | null>>): string =>
  `${BASE}${bookHref('/book', fields)}`

/**
 * Writes a code this file knows into the number's newest live challenge.
 *
 * See the module header. Through `hashOtpCode`, which is the repository's own function, so the stored
 * representation is exactly what a real issue produces.
 */
async function writeKnownCode(phoneE164: string): Promise<string> {
  const salt = randomBytes(16)
  const rows = await sql<{ id: string }[]>`
    update otp_challenge set code_hash = ${hashOtpCode(KNOWN_CODE, salt)}, code_salt = ${salt}
     where id = (
       select id from otp_challenge
        where phone_e164 = ${phoneE164} and purpose = 'booking_verify'
          and consumed_at is null and superseded_at is null
        order by issued_at desc limit 1
     )
    returning id::text as id
  `
  if (rows.length !== 1) {
    throw new Error(
      `no live otp_challenge for ${phoneE164}: the endpoint did not issue one, so the fixture has ` +
        'nothing to put a known code into. Check the send step answered 303 rather than a refusal.',
    )
  }
  return KNOWN_CODE
}

/** The carried booking state every step's form submits back. */
const carried = (extra: Readonly<Record<string, string | number | null>> = {}) => ({
  locale: 'en',
  [BOOK_FIELDS.variant]: variantId,
  [BOOK_FIELDS.gender]: 'female',
  [BOOK_FIELDS.date]: freeDate,
  ...extra,
})

interface Session {
  readonly cookie: string
  readonly phone: string
}

/**
 * A verified session, through the real endpoint: a code request, a known code, a verification.
 *
 * A fresh number every time, because three code requests per number per fifteen minutes is the real limit
 * and this file mints more than three sessions.
 */
const callerIpFor = (index: number): string =>
  `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`

async function verifiedSession(
  extra: Readonly<Record<string, string | number | null>> = {},
): Promise<Session> {
  phoneCounter += 1
  const phone = probePhone(phoneCounter)
  const sent = await flowPost(
    { action: 'send_code', phone, ...carried(extra) },
    null,
    callerIpFor(phoneCounter),
  )
  expect(sent.status, `send_code answered ${sent.status} (${sent.location})`).toBe(303)
  expect(sent.location).toContain('step=otp')
  const cookie = sent.cookie
  if (cookie === null) throw new Error('send_code set no session cookie')
  const code = await writeKnownCode(phone)
  const verified = await flowPost({ action: 'verify_code', code, ...carried(extra) }, cookie)
  expect(verified.status, `verify_code answered ${verified.status} (${verified.location})`).toBe(
    303,
  )
  expect(verified.location, verified.location).not.toContain('error=')
  return { cookie, phone }
}

/**
 * Consent rows captured on a booking form, counted in SQL.
 *
 * In SQL and never through a reader with a limit, for the reason brief rule 12 records about
 * `app_setting_history`: both sides of a delta over an append-only table pin at the cap, and three
 * recorded changes read as zero. `consent` is append-only too (C-CRM-03), so this can only be a delta.
 */
async function consentFormRowCount(): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from consent where capture_source = 'booking_form'
  `
  return Number(row?.n ?? '0')
}

/** Appointment rows for one trading date, as a count. The delta every booking assertion is measured by. */
async function appointmentCount(tradingDate: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from appointment where trading_date = ${tradingDate}
  `
  return Number(row?.n ?? '0')
}

// ── Browser helpers ────────────────────────────────────────────────────────────────────────────────

interface Cell {
  readonly width: number
  readonly height: number
}

const PHONE: Cell = { width: 390, height: 844 }
const DESKTOP: Cell = { width: 1440, height: 900 }

/**
 * One page, with the flow's session cookie installed before anything loads.
 *
 * The cookie is set on the CONTEXT rather than by driving the phone form in the browser, and that is what
 * keeps the nine edge-state cases short: each of them is about a state of the world, not about how the
 * session was obtained, and obtaining it through the UI five times would spend five numbers and five
 * minutes for nothing.
 */
async function open(
  url: string,
  options: { readonly cell?: Cell; readonly cookie?: string | null } = {},
): Promise<{ page: Page; context: BrowserContext }> {
  const cell = options.cell ?? DESKTOP
  const context = await browser.newContext({
    viewport: { width: cell.width, height: cell.height },
    deviceScaleFactor: 1,
    locale: 'en-AE',
    timezoneId: 'Asia/Dubai',
    reducedMotion: 'reduce',
  })
  await context.addInitScript({
    content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
  })
  if (options.cookie !== null && options.cookie !== undefined) {
    const value = options.cookie.slice(`${BOOK_SESSION_COOKIE}=`.length)
    await context.addCookies([{ name: BOOK_SESSION_COOKIE, value, url: BASE }])
  }
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'networkidle' })
  return { page, context }
}

/** The framework's own chunks, as the build declares them. The half `first-party-js` excludes. */
const FRAMEWORK_CHUNKS: readonly string[] = (() => {
  const manifest = JSON.parse(
    readFileSync(join(APP_DIR, '.next', 'build-manifest.json'), 'utf8'),
  ) as { rootMainFiles?: string[]; polyfillFiles?: string[] }
  const files = [...(manifest.rootMainFiles ?? []), ...(manifest.polyfillFiles ?? [])]
  if (files.length === 0) {
    throw new Error(
      '.next/build-manifest.json declares no rootMainFiles, so every script on the page would be ' +
        "counted as this application's own. Build the app before running this suite.",
    )
  }
  return files
})()

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 8 })
  now = Date.now()
  const today = localDateOf(now)
  freeDate = shiftDate(today, FREE_OFFSET)

  const span: string[] = []
  for (let offset = SPAN_FROM; offset <= SPAN_TO; offset += 1) span.push(shiftDate(today, offset))
  const inserted = await sql<{ trading_date: string }[]>`
    insert into business_day (trading_date, opens_at, closes_at, source)
    select d::date, (d::date || ' 11:00:00+04')::timestamptz,
           ((d::date + 1) || ' 02:00:00+04')::timestamptz, 'weekly'
      from unnest(${span}::date[]) as d
    on conflict (trading_date) do nothing
    returning trading_date::text as trading_date
  `
  insertedDates.push(...inserted.map((row) => row.trading_date))

  const variants = await readBookableVariants(sql)
  const variant = variants.find(
    (row) => row.slug === PROBE_SLUG && row.durationMinutes === PROBE_DURATION,
  )
  const wet = variants.find(
    (row) => row.slug === WET_SLUG && row.durationMinutes === PROBE_DURATION,
  )
  if (variant === undefined || wet === undefined) {
    throw new Error(
      `the catalogue has no ${PROBE_SLUG} or ${WET_SLUG} at ${PROBE_DURATION} minutes: run ` +
        '`pnpm seed` before the integration suite — this unit drives the real menu.',
    )
  }
  variantId = variant.serviceVariantId
  variantName = variant.publicDisplayName
  variantStyle = variant.style
  variantTreatmentKey = variant.treatmentKey
  variantGrossFils = variant.grossFils
  wetVariantId = wet.serviceVariantId

  const rooms = await sql<{ id: string; room_type: string }[]>`
    select id::text as id, room_type::text as room_type from rooms
     where is_bookable order by display_order
  `
  roomIds = rooms.filter((row) => row.room_type === 'standard').map((row) => row.id)
  wetRoomId = rooms.find((row) => row.room_type === 'wet')?.id ?? ''
  if (roomIds.length === 0 || wetRoomId === '') {
    throw new Error('the seeded premises has no standard room or no wet room')
  }

  for (const reference of REFERENCES) await addEmployee(reference)

  for (const tradingDate of span) {
    const [shift] = await sql<{ id: string }[]>`
      insert into shift (trading_date, period, label)
      values (${tradingDate},
              ${`[${new Date(at(tradingDate, '11:00')).toISOString()},${new Date(at(shiftDate(tradingDate, 1), '02:00')).toISOString()})`}::tstzrange,
              ${MARKER})
      returning id::text as id
    `
    for (const id of staff.values()) {
      await sql`
        insert into shift_assignment (shift_id, employee_id)
        values (${(shift as { id: string }).id}, ${id}) on conflict do nothing
      `
    }
  }

  server = await startWebServer({
    suite: 'book-flow',
    cwd: APP_DIR,
    probePath: '/book',
    readyWithinMs: 120_000,
  })
  BASE = server.origin
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 300_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop()
  if (sql !== undefined) {
    const customers = await sql<{ id: string }[]>`
      select id::text as id from customer where phone_e164 like ${`${PHONE_PREFIX}%`}
    `
    const ids = customers.map((row) => row.id)
    if (ids.length > 0) {
      // The BOOKING first: `appointment.booking_id` cascades, and a booking taken through the endpoint
      // carries no marker of its own — the customer is the only thing that finds it.
      await sql`delete from booking where customer_id = any(${ids}::uuid[])`
      await sql`delete from waitlist where customer_id = any(${ids}::uuid[])`
    }
    await sql`delete from booking where notes = ${MARKER}`
    await sql`delete from booking_session where phone_e164 like ${`${PHONE_PREFIX}%`}`
    await sql`delete from otp_challenge where phone_e164 like ${`${PHONE_PREFIX}%`}`
    await sql`delete from otp_phone_lock where phone_e164 like ${`${PHONE_PREFIX}%`}`
    await sql`delete from shift_assignment where employee_id = any(${[...staff.values()]}::uuid[])`
    await sql`delete from shift where label = ${MARKER}`
    await sql`delete from employee_document where employee_id = any(${[...staff.values()]}::uuid[])`
    await sql`delete from employee_skill where employee_id = any(${[...staff.values()]}::uuid[])`
    await sql`delete from employee where notes = ${MARKER}`
    // `consent` is append-only: C-CRM-03 revokes DELETE for every role including the owner, so the rows
    // this file writes stay. Every consent assertion here is therefore a DELTA, which brief rule 9
    // requires anyway. They reference `contact_customer_id` with no foreign key (0056), so removing the
    // customer below is not refused by them.
    await sql`delete from availability_epoch where trading_date = any(${insertedDates}::date[])`
    await sql`delete from business_day where trading_date = any(${insertedDates}::date[])`
    await sql`delete from customer where phone_e164 like ${`${PHONE_PREFIX}%`}`
    await sql.end({ timeout: 5 })
  }
})

describe('acceptance — the phone and code fields carry what a browser needs to help', () => {
  it('normalises to E.164 on blur, through the one normaliser and not a second one', async () => {
    const { page, context } = await open(bookUrl(carried({ [BOOK_FIELDS.step]: 'details' })), {
      cell: PHONE,
    })
    try {
      const input = page.locator('#book-phone')
      await expect.poll(async () => await input.count()).toBe(1)
      // A local spelling with separators, which is how the number is written on every card and sign in
      // the country. The island hands it to `normalisePhoneResult`; a second implementation in the
      // browser is what this is here to stop being written.
      await input.fill('050 510 8633')
      // A Tab, because that is what a reader's own next action is — and because it produces a real blur
      // event rather than a programmatic one.
      await input.press('Tab')
      await expect.poll(async () => await input.inputValue()).toBe('+971505108633')

      // The control: a landline is left EXACTLY as typed. Rewriting it into something mobile-shaped would
      // hide the refusal the reader is about to be given, and the server refuses it by name either way.
      await input.fill('04 399 1234')
      await input.press('Tab')
      await expect.poll(async () => await input.inputValue()).toBe('04 399 1234')
    } finally {
      await context.close()
    }
  }, 120_000)

  it('serves the code field with one-time-code autofill, a numeric keypad and a cooldown', async () => {
    // Asserted against the served BYTES, because that is where a browser reads an attribute from — and
    // because a cooldown rendered by the server is what a reader with no JavaScript sees.
    const session = await verifiedSessionlessCode()
    const html = await fetchHtml(bookUrl(carried({ [BOOK_FIELDS.step]: 'otp' })), session.cookie)
    expect(html).toContain('data-book-state="otp"')
    // Case-INSENSITIVE, and that is a fact about HTML rather than a loosened assertion: attribute names
    // are ASCII case-insensitive, and React 19 emits `autoComplete`, `inputMode` and `maxLength` in their
    // JSX spelling while lowercasing `className`. A browser parses all of them to the same attributes,
    // which the DOM half of this case asserts directly.
    expect(html).toMatch(/autocomplete="one-time-code"/i)
    expect(html).toMatch(/inputmode="numeric"/i)
    expect(html).toMatch(new RegExp(`maxlength="${OTP_CODE_DIGITS}"`, 'i'))
    // The resend button, disabled, with the remaining seconds rendered by the server. A code has just been
    // sent, so the courtesy cooldown is in force and the number is the one `readOtpResendWindow` computed.
    const seconds = Number(/data-resend-seconds="(\d+)"/.exec(html)?.[1] ?? '-1')
    expect(seconds).toBeGreaterThan(0)
    expect(seconds).toBeLessThanOrEqual(OTP_RESEND_COOLDOWN_SECONDS)
    expect(html).toContain('disabled=""')
    // And the two ways out docs/09 §3 asks for: the message that did not arrive, and the number that was
    // wrong. Resending a code four times is what a reader does without the second one.
    expect(html).toContain('data-book-issue-link="code_not_received"')
    expect(html).toContain('data-book-change-number="true"')
    expect(html).toContain('href="tel:')
  }, 120_000)

  it('renders no cooldown on a step where no code has been sent, which is the control', async () => {
    // Without this, "the cooldown is a positive number" is satisfied by a page that hard-codes one.
    const html = await fetchHtml(bookUrl(carried({ [BOOK_FIELDS.step]: 'details' })))
    expect(html).toContain('data-book-state="details"')
    expect(html).not.toContain('data-resend-seconds')
    expect(html).toMatch(/autocomplete="tel"/i)
    expect(html).toMatch(/inputmode="tel"/i)
  }, 60_000)

  it('is parsed by a browser as the attributes that summon autofill and the number pad', async () => {
    // The assertion that matters, and the reason the byte-level one above can afford to be
    // case-insensitive: what decides whether iOS offers the code from the SMS is the attribute the parser
    // produced, not the spelling in the source.
    const session = await verifiedSessionlessCode()
    const { page, context } = await open(bookUrl(carried({ [BOOK_FIELDS.step]: 'otp' })), {
      cell: PHONE,
      cookie: session.cookie,
    })
    try {
      const field = await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('#book-code')
        if (input === null) throw new Error('no code field on the page')
        return {
          autocomplete: input.getAttribute('autocomplete'),
          inputmode: input.getAttribute('inputmode'),
          maxLength: input.maxLength,
          type: input.type,
        }
      })
      expect(field.autocomplete).toBe('one-time-code')
      expect(field.inputmode).toBe('numeric')
      expect(field.maxLength).toBe(OTP_CODE_DIGITS)
      // The cooldown ticks, which is the one thing the server cannot do. It starts positive because a code
      // has just been sent, and the island counts it down.
      const resend = page.locator('[data-resend-seconds]')
      const started = Number(await resend.getAttribute('data-resend-seconds'))
      expect(started).toBeGreaterThan(1)
      expect(await resend.isDisabled()).toBe(true)
      await expect
        .poll(async () => Number(await resend.getAttribute('data-resend-seconds')), {
          timeout: 20_000,
        })
        .toBeLessThan(started)
    } finally {
      await context.close()
    }
  }, 120_000)

  it('reports the rate limits own clock once the window is full, not the courtesy one', async () => {
    // `readOtpResendWindow` has two clocks and the LATER wins: the courtesy cooldown after the last code,
    // and the per-number rate limit once the window is full. The case above exercises the first; this one
    // exercises the second, because that is the half whose being wrong makes the button offer a resend the
    // endpoint then refuses with a 429 — a control that does nothing.
    phoneCounter += 1
    const phone = probePhone(phoneCounter)
    const ip = callerIpFor(phoneCounter)
    for (let attempt = 0; attempt < OTP_MAX_REQUESTS_PER_PHONE; attempt += 1) {
      const sent = await flowPost({ action: 'send_code', phone, ...carried() }, null, ip)
      expect(sent.status, `request ${attempt + 1}: ${sent.location}`).toBe(303)
      expect(sent.location, `request ${attempt + 1}`).not.toContain('error=')
    }
    const nowIso = new Date(Date.now()).toISOString()
    const window = await readOtpResendWindow(sql, {
      phoneE164: phone,
      purpose: 'booking_verify',
      nowIso,
    })
    expect(window.requestsInWindow).toBe(OTP_MAX_REQUESTS_PER_PHONE)
    expect(window.rateLimited).toBe(true)
    // The wait is now the LIMIT's and not the courtesy's: comfortably more than 45 seconds, and no more
    // than the window itself. A helper that reported the courtesy clock here would offer a resend inside a
    // minute and the endpoint would answer 429.
    const remaining = resendCooldownSeconds({
      resendAvailableAtIso: window.resendAvailableAtIso,
      now: Date.parse(nowIso),
    })
    expect(remaining).toBeGreaterThan(OTP_RESEND_COOLDOWN_SECONDS)
    expect(remaining).toBeLessThanOrEqual(OTP_PHONE_WINDOW_MINUTES * 60)

    // And the endpoint really does refuse the next one, which is what the number is protecting the reader
    // from being offered.
    const refused = await flowPost({ action: 'send_code', phone, ...carried() }, null, ip)
    expect(refused.location).toContain('error=rate_limited')
  }, 120_000)

  it('clears 48x48 and 16px on every control of every step, at 390px', async () => {
    const session = await verifiedSession()
    const starts = await offeredStarts({ tradingDate: freeDate })
    const slot = starts[0] ?? 0
    for (const step of ['details', 'otp', 'confirm'] as const) {
      const { page, context } = await open(
        bookUrl(carried({ [BOOK_FIELDS.step]: step, [BOOK_FIELDS.slot]: slot })),
        { cell: PHONE, cookie: session.cookie },
      )
      try {
        const findings = await page.evaluate(auditTouchTargetsInPage, {
          ...touchTargetInputFor(390),
          // B-UI-01's selector, and deliberately WITHOUT a bare `label`: a label that names a field is
          // not a touch target, and including it reports every field caption on the page as too small.
          // The one label that IS a target — the consent row — wraps its own checkbox, and the checkbox
          // is what this audit measures (see `.be-book__checkbox` in styles.tsx).
          selector: 'a, button, [role="button"], [role="option"], input, select, summary',
        })
        expect(findings, `${step}: ${JSON.stringify(findings)}`).toEqual([])
        const small = await page.evaluate(() =>
          [...document.querySelectorAll('input, select, textarea, button')]
            .filter((element) => (element as HTMLElement).offsetParent !== null)
            .map((element) => ({
              where: `${element.tagName.toLowerCase()}#${element.id}`,
              px: Number.parseFloat(getComputedStyle(element).fontSize),
            }))
            .filter((entry) => entry.px < 16),
        )
        expect(small, `${step}: under 16px — ${JSON.stringify(small)}`).toEqual([])
      } finally {
        await context.close()
      }
    }
  }, 300_000)
})

/** A session with a code requested and NOT yet verified — what the code step is about. */
async function verifiedSessionlessCode(): Promise<Session> {
  phoneCounter += 1
  const phone = probePhone(phoneCounter)
  const sent = await flowPost(
    { action: 'send_code', phone, ...carried() },
    null,
    callerIpFor(phoneCounter),
  )
  expect(sent.status, sent.location).toBe(303)
  const cookie = sent.cookie
  if (cookie === null) throw new Error('send_code set no session cookie')
  return { cookie, phone }
}

describe('acceptance — the whole flow completes, and does so with no browser at all', () => {
  it('walks details, code, confirm and the confirmation over plain HTTP', async () => {
    // No browser anywhere in this case, which is the point: every step is a form the server answers with a
    // 303, so a client that runs no JavaScript completes the booking. The acceptance line asks only that
    // step 4 degrade to a named message; this is the stronger thing, and the `noscript` state is asserted
    // separately below because the line asks for it by name.
    const before = await appointmentCount(freeDate)
    const starts = await offeredStarts({ tradingDate: freeDate })
    expect(starts.length).toBeGreaterThan(5)
    const slot = starts[3] as number

    const session = await verifiedSession({ [BOOK_FIELDS.slot]: slot })
    const confirm = await flowPost(
      { action: 'confirm', ...carried({ [BOOK_FIELDS.slot]: slot }) },
      session.cookie,
    )
    expect(confirm.status, confirm.location).toBe(303)
    expect(confirm.location).toContain('step=booked')
    const bookingId = /booking=([0-9a-f-]{36})/.exec(confirm.location)?.[1] ?? ''
    expect(bookingId).not.toBe('')

    expect(await appointmentCount(freeDate)).toBe(before + 1)

    const html = await fetchHtml(`${BASE}${confirm.location}`, session.cookie)
    expect(html).toContain('data-book-state="booked"')
    expect(html).toContain(`data-booking-reference="${bookingId}"`)
    // Add-to-calendar, and the region the magic link will occupy once B-UI-05 mints one.
    expect(html).toContain(`data-book-ics="${bookingId}"`)
    expect(html).toContain('data-book-region="manage"')
    expect(html).toContain('href="tel:')
  }, 180_000)

  it('records a consent row only for a ticked box, with the wording version it was shown under', async () => {
    // C-CRM-03 deferred the capture surface here by name. The delta is over `consent`, which is
    // append-only, and the row has to carry the exact wording version — `recordConsent` refuses a hash
    // that does not match the stored one, so a row at all is proof the form carried the right version.
    const starts = await offeredStarts({ tradingDate: freeDate })
    const slot = starts[4] as number
    const session = await verifiedSession({ [BOOK_FIELDS.slot]: slot })

    const form = await fetchHtml(
      bookUrl(carried({ [BOOK_FIELDS.step]: 'confirm', [BOOK_FIELDS.slot]: slot })),
      session.cookie,
    )
    expect(form).toContain('data-book-consent="offered"')
    // The recovery affordance is on the confirm step itself, not only inside the `network_drop` panel: a
    // reader whose connection dropped may never have received that page.
    expect(form).toContain('data-book-issue-link="interrupted"')
    // Driven by `consent_purpose.is_send_gating`: `marketing` and `review_request` gate a send,
    // `clinical_processing` and `photography` are lawful bases for holding a record and are absent.
    expect(form).toContain('data-consent-purpose="marketing"')
    expect(form).not.toContain('data-consent-purpose="photography"')
    expect(form).not.toContain('data-consent-purpose="clinical_processing"')
    // Unchecked. A pre-ticked marketing box is not an opt-in under TDRA and the record would claim it was.
    expect(form).not.toMatch(/name="consent_grant_marketing"[^>]*checked/)
    const wordingId =
      /name="consent_wording_marketing" value="([0-9a-f-]{36})"/.exec(form)?.[1] ?? ''
    const hash = /name="consent_hash_marketing" value="([0-9a-f]{64})"/.exec(form)?.[1] ?? ''
    expect(wordingId).not.toBe('')
    expect(hash).not.toBe('')

    const beforeCount = await consentFormRowCount()

    const confirmed = await flowPost(
      {
        action: 'confirm',
        ...carried({ [BOOK_FIELDS.slot]: slot }),
        consent_purpose: 'marketing',
        consent_grant_marketing: 'on',
        consent_wording_marketing: wordingId,
        consent_hash_marketing: hash,
      },
      session.cookie,
    )
    expect(confirmed.status, confirmed.location).toBe(303)

    expect((await consentFormRowCount()) - beforeCount).toBe(1)

    const [row] = await sql<
      {
        purpose: string
        kind: string
        channel: string
        consent_wording_id: string
        capture_actor_kind: string
        capture_locale: string
      }[]
    >`
      select c.purpose, c.kind::text as kind, c.channel::text as channel,
             c.consent_wording_id::text as consent_wording_id, c.capture_actor_kind, c.capture_locale
        from consent c
        join customer cu on cu.id = c.contact_customer_id
       where cu.phone_e164 = ${session.phone}
    `
    expect(row).toBeDefined()
    expect(row?.purpose).toBe('marketing')
    expect(row?.kind).toBe('granted')
    expect(row?.channel).toBe('sms')
    expect(row?.consent_wording_id).toBe(wordingId)
    expect(row?.capture_actor_kind).toBe('customer')
    expect(row?.capture_locale).toBe('en')
  }, 180_000)

  it('records NOTHING when the box is left unticked, which is the control', async () => {
    // "Never asked is the absence of a row and is never stored" (C-CRM-03). A `granted: false` row would
    // make "asked and declined" and "never asked" the same value, which `resolveConsent` fails closed on.
    const starts = await offeredStarts({ tradingDate: freeDate })
    const slot = starts[5] as number
    const session = await verifiedSession({ [BOOK_FIELDS.slot]: slot })
    const form = await fetchHtml(
      bookUrl(carried({ [BOOK_FIELDS.step]: 'confirm', [BOOK_FIELDS.slot]: slot })),
      session.cookie,
    )
    const wordingId =
      /name="consent_wording_marketing" value="([0-9a-f-]{36})"/.exec(form)?.[1] ?? ''
    const hash = /name="consent_hash_marketing" value="([0-9a-f]{64})"/.exec(form)?.[1] ?? ''
    const confirmed = await flowPost(
      {
        action: 'confirm',
        ...carried({ [BOOK_FIELDS.slot]: slot }),
        consent_purpose: 'marketing',
        consent_wording_marketing: wordingId,
        consent_hash_marketing: hash,
      },
      session.cookie,
    )
    expect(confirmed.status, confirmed.location).toBe(303)
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from consent c
        join customer cu on cu.id = c.contact_customer_id
       where cu.phone_e164 = ${session.phone}
    `
    expect(Number(row?.n ?? '-1')).toBe(0)
  }, 180_000)

  it('ignores a consent purpose the form never shows, whatever the submission claims', async () => {
    // `photography` is in `CONSENT_PURPOSES` and is NOT send-gating: it is a lawful basis for using
    // somebody's image, not permission to message them, so this form never offers it. A hand-made POST
    // naming it with a real wording version would otherwise write a consent record for something the
    // reader was never shown — and a consent record is a legal artefact about what a form displayed.
    const starts = await offeredStarts({ tradingDate: freeDate })
    const slot = starts[10] as number
    const session = await verifiedSession({ [BOOK_FIELDS.slot]: slot })
    const [wording] = await sql<{ id: string; hash: string }[]>`
      select id::text as id, encode(content_hash, 'hex') as hash from consent_wording
       where purpose = 'photography' order by version desc limit 1
    `
    expect(wording, 'the seed publishes no photography wording to forge with').toBeDefined()

    const confirmed = await flowPost(
      {
        action: 'confirm',
        ...carried({ [BOOK_FIELDS.slot]: slot }),
        consent_purpose: 'photography',
        consent_grant_photography: 'on',
        consent_wording_photography: (wording as { id: string }).id,
        consent_hash_photography: (wording as { hash: string }).hash,
      },
      session.cookie,
    )
    expect(confirmed.status, confirmed.location).toBe(303)
    expect(confirmed.location).toContain('step=booked')
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from consent c
        join customer cu on cu.id = c.contact_customer_id
       where cu.phone_e164 = ${session.phone}
    `
    expect(Number(row?.n ?? '-1')).toBe(0)
    // The control on the control: the same submission for a send-gating purpose IS recorded, so the
    // assertion above is about the purpose and not about a path that records nothing.
    expect(await consentFormRowCount()).toBeGreaterThan(0)
  }, 180_000)

  it('takes the booking even when the consent row cannot be written, and writes no row', async () => {
    // A hand-made POST naming a wording version that does not exist. `recordConsent` refuses it
    // (`consent_wording_not_found`), and the point of this case is what happens next: the BOOKING is
    // already durable, so a refusal inside the same transaction as the session attachment would abort it
    // and answer a committed booking with a 500 — a reader seeing an error for a booking that exists.
    // The two writes are therefore separate units of work and a consent refusal is swallowed by name.
    const starts = await offeredStarts({ tradingDate: freeDate })
    const slot = starts[9] as number
    const session = await verifiedSession({ [BOOK_FIELDS.slot]: slot })
    const before = await appointmentCount(freeDate)
    const consentBefore = await consentFormRowCount()

    const confirmed = await flowPost(
      {
        action: 'confirm',
        ...carried({ [BOOK_FIELDS.slot]: slot }),
        consent_purpose: 'marketing',
        consent_grant_marketing: 'on',
        // A well-formed uuid that names no wording row, and a well-formed hash that matches nothing.
        consent_wording_marketing: '0199f0d1-2b4e-7c9a-8f1e-3d5a7b9c1e98',
        consent_hash_marketing: 'f'.repeat(64),
      },
      session.cookie,
    )
    expect(confirmed.status, confirmed.location).toBe(303)
    expect(confirmed.location).toContain('step=booked')
    expect(await appointmentCount(freeDate)).toBe(before + 1)
    // No consent row, and the session still holds its booking — which is what a reload of the
    // confirmation reads it from.
    expect(await consentFormRowCount()).toBe(consentBefore)
    const [row] = await sql<{ booking_id: string | null }[]>`
      select booking_id::text as booking_id from booking_session where phone_e164 = ${session.phone}
    `
    expect(row?.booking_id).not.toBeNull()
  }, 180_000)

  it('carries a named state and the desk telephone number for a reader with no JavaScript', async () => {
    // The acceptance line asks that step 4 "degrade to a named message with a phone fallback rather than a
    // blank screen". It does not degrade — it works — so what is asserted is the `<noscript>` state that
    // says which conveniences are absent, and the telephone number beside it.
    const session = await verifiedSessionlessCode()
    const html = await fetchHtml(bookUrl(carried({ [BOOK_FIELDS.step]: 'otp' })), session.cookie)
    const noscript = html.slice(html.indexOf('<noscript>'))
    expect(noscript).toContain('data-book-state="no-javascript"')
    expect(noscript.slice(0, noscript.indexOf('</noscript>'))).toContain('href="tel:')
  }, 120_000)
})

describe('acceptance — double submission sends one key and creates one booking', () => {
  it('answers the second submission with the first bookings id and writes no second appointment', async () => {
    const starts = await offeredStarts({ tradingDate: freeDate })
    const slot = starts[6] as number
    const session = await verifiedSession({ [BOOK_FIELDS.slot]: slot })
    const before = await appointmentCount(freeDate)

    const fields = { action: 'confirm', ...carried({ [BOOK_FIELDS.slot]: slot }) }
    const first = await flowPost(fields, session.cookie)
    const second = await flowPost(fields, session.cookie)

    expect(first.status).toBe(303)
    expect(second.status).toBe(303)
    const firstId = /booking=([0-9a-f-]{36})/.exec(first.location)?.[1] ?? ''
    const secondId = /booking=([0-9a-f-]{36})/.exec(second.location)?.[1] ?? ''
    expect(firstId).not.toBe('')
    // The second response returns the FIRST booking id, which is the acceptance line's own wording.
    expect(secondId).toBe(firstId)
    // Exactly one appointment. The count is the delta on this file's own trading date.
    expect(await appointmentCount(freeDate)).toBe(before + 1)
    // And the second submission is reported as what it was, so the page can say so.
    expect(second.location).toContain('error=already_booked')

    // The key really is the same one, derived from the session rather than generated per render: the claim
    // in `booking_idempotency` is the one this file can recompute.
    const [row] = await sql<{ idempotency_key: string }[]>`
      select idempotency_key from booking_idempotency where booking_id = ${firstId}
    `
    const [sessionRow] = await sql<{ id: string }[]>`
      select id::text as id from booking_session where phone_e164 = ${session.phone}
    `
    expect(row?.idempotency_key).toBe(
      bookingIdempotencyKey({
        sessionId: (sessionRow as { id: string }).id,
        serviceVariantId: variantId,
        startsAt: slot,
      }),
    )
  }, 240_000)

  it('produces a DIFFERENT key for a different slot, which is the control', async () => {
    // Without it, "the two submissions shared a key" is satisfied by a constant — and the second booking
    // any customer ever made would be answered with their first one.
    const starts = await offeredStarts({ tradingDate: freeDate })
    const session = await verifiedSession()
    const [sessionRow] = await sql<{ id: string }[]>`
      select id::text as id from booking_session where phone_e164 = ${session.phone}
    `
    const id = (sessionRow as { id: string }).id
    const a = bookingIdempotencyKey({
      sessionId: id,
      serviceVariantId: variantId,
      startsAt: starts[0] as number,
    })
    const b = bookingIdempotencyKey({
      sessionId: id,
      serviceVariantId: variantId,
      startsAt: starts[1] as number,
    })
    expect(a).not.toBe(b)
  }, 120_000)
})

describe('acceptance — the calendar file says the time and the place and nothing else', () => {
  it('serves an ICS whose SUMMARY names neither the treatment, the style nor the therapist', async () => {
    const starts = await offeredStarts({ tradingDate: freeDate })
    const slot = starts[7] as number
    const session = await verifiedSession({ [BOOK_FIELDS.slot]: slot })
    const confirmed = await flowPost(
      { action: 'confirm', ...carried({ [BOOK_FIELDS.slot]: slot }) },
      session.cookie,
    )
    const bookingId = /booking=([0-9a-f-]{36})/.exec(confirmed.location)?.[1] ?? ''
    expect(bookingId).not.toBe('')

    const response = await fetch(`${BASE}/api/v1/book?ics=${bookingId}`, {
      headers: { cookie: session.cookie },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/calendar')
    expect(response.headers.get('content-disposition')).toContain('.ics')
    const ics = await response.text()

    // Not vacuous: the file really is a calendar entry for this booking at this time.
    expect(ics).toContain('BEGIN:VEVENT')
    expect(ics).toContain(`UID:${bookingId}@berelax`)
    expect(ics).toContain(bookingId)
    const summary = ics.split('\r\n').find((line) => line.startsWith('SUMMARY:')) ?? ''
    expect(summary.length).toBeGreaterThan('SUMMARY:'.length)

    // docs/06 D2, over the WHOLE file and not only the summary: a calendar syncs the description to the
    // same devices a lock screen is on.
    const lower = ics.toLowerCase()
    for (const withheld of [variantName, variantStyle, variantTreatmentKey]) {
      expect(lower, `the ICS names ${withheld}`).not.toContain(withheld.toLowerCase())
    }
    const therapists = await sql<{ staff_reference: string; id: string }[]>`
      select e.staff_reference, e.id::text as id from employee e
       where e.id in (select therapist_id from appointment where booking_id = ${bookingId})
    `
    expect(therapists.length).toBeGreaterThan(0)
    for (const therapist of therapists) {
      expect(lower).not.toContain(therapist.staff_reference.toLowerCase())
      expect(lower).not.toContain(therapist.id.toLowerCase())
    }
  }, 240_000)

  it('refuses the file to a session that did not make the booking, with the same 404 as an unknown id', async () => {
    // A booking id is a uuid in a query string and not permission to download somebody's appointment.
    // `uuid_generate_v7` leads with a timestamp, so guessing is not as hard as it sounds — and the two
    // answers are identical, so a guess learns nothing about whether the id exists.
    const starts = await offeredStarts({ tradingDate: freeDate })
    const slot = starts[8] as number
    const owner = await verifiedSession({ [BOOK_FIELDS.slot]: slot })
    const confirmed = await flowPost(
      { action: 'confirm', ...carried({ [BOOK_FIELDS.slot]: slot }) },
      owner.cookie,
    )
    const bookingId = /booking=([0-9a-f-]{36})/.exec(confirmed.location)?.[1] ?? ''
    const stranger = await verifiedSession()

    const theirs = await fetch(`${BASE}/api/v1/book?ics=${bookingId}`, {
      headers: { cookie: stranger.cookie },
    })
    const unknown = await fetch(`${BASE}/api/v1/book?ics=0199f0d1-2b4e-7c9a-8f1e-3d5a7b9c1e99`, {
      headers: { cookie: stranger.cookie },
    })
    expect(theirs.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(await theirs.text()).toBe(await unknown.text())
    // The control: the owner's own request succeeds, so the 404s are about authorisation and not about a
    // route that never serves anything.
    expect(
      (await fetch(`${BASE}/api/v1/book?ics=${bookingId}`, { headers: { cookie: owner.cookie } }))
        .status,
    ).toBe(200)
  }, 240_000)
})

describe('acceptance — the waitlist join B-UI-01 deferred here', () => {
  it('takes a verified phone to the list and writes exactly one row', async () => {
    // The day is filled for BOTH therapists, which is what makes the waitlist the honest offer: the
    // availability answer has nothing, so `waitlistEligible` is eligible and carries the window.
    const fullDate = shiftDate(freeDate, 1)
    const bookingId = await fixtureBooking()
    for (const [offset, reference] of REFERENCES.entries()) {
      for (let index = 0; index < 11; index += 1) {
        await occupy({
          bookingId,
          tradingDate: fullDate,
          // Offset per therapist, so the two are never in one room at one instant: a standard room has
          // capacity 1 and `appointment_room_capacity` (ZB001) refuses the second of them.
          roomId: roomIds[(index + offset) % roomIds.length] as string,
          therapistId: idOf(reference),
          startsAt: at(fullDate, '11:00') + index * 80 * 60_000,
        })
      }
    }
    expect(await offeredStarts({ tradingDate: fullDate })).toEqual([])

    const fields = {
      [BOOK_FIELDS.variant]: variantId,
      [BOOK_FIELDS.gender]: 'female',
      [BOOK_FIELDS.date]: fullDate,
    }
    // The CTA leads to the phone step, carrying `after=waitlist` — which is the deferral discharged: it is
    // no longer a named state with nothing behind it.
    const waitlistStep = await fetchHtml(
      `${BASE}${bookHref('/book', { ...fields, [BOOK_FIELDS.step]: 'waitlist' })}`,
    )
    expect(waitlistStep).toContain('data-book-state="waitlist-step"')
    expect(waitlistStep).toContain('name="after" value="waitlist"')

    phoneCounter += 1
    const phone = probePhone(phoneCounter)
    const sent = await flowPost(
      { action: 'send_code', phone, locale: 'en', ...fields, after: 'waitlist' },
      null,
      callerIpFor(phoneCounter),
    )
    expect(sent.status).toBe(303)
    const cookie = sent.cookie as string
    await writeKnownCode(phone)
    const verified = await flowPost(
      { action: 'verify_code', code: KNOWN_CODE, locale: 'en', ...fields, after: 'waitlist' },
      cookie,
    )
    // Verification leads to the waiting list rather than to a confirm step, because that is what was asked.
    expect(verified.location).toContain('step=waitlist')

    const joined = await flowPost(
      { action: 'join_waitlist', locale: 'en', ...fields, after: 'waitlist' },
      cookie,
    )
    expect(joined.status, joined.location).toBe(303)
    expect(joined.location).toContain('step=waitlisted')

    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from waitlist w
        join customer c on c.id = w.customer_id
       where c.phone_e164 = ${phone} and w.trading_date = ${fullDate}
    `
    expect(Number(rows[0]?.n ?? '-1')).toBe(1)

    // Idempotent: a second join is a no-op rather than a second row. `waitlist_one_row_per_window` is
    // `UNIQUE NULLS NOT DISTINCT`, and the table growing a row per page refresh is what that buys.
    await flowPost({ action: 'join_waitlist', locale: 'en', ...fields, after: 'waitlist' }, cookie)
    const again = await sql<{ n: string }[]>`
      select count(*)::text as n from waitlist w
        join customer c on c.id = w.customer_id
       where c.phone_e164 = ${phone} and w.trading_date = ${fullDate}
    `
    expect(Number(again[0]?.n ?? '-1')).toBe(1)

    const confirmation = await fetchHtml(
      `${BASE}${bookHref('/book', { ...fields, [BOOK_FIELDS.step]: 'waitlisted' })}`,
      cookie,
    )
    expect(confirmation).toContain('data-book-state="waitlisted"')
  }, 300_000)
})

// ── The nine enumerated edge states ────────────────────────────────────────────────────────────────

/**
 * One edge state, driven in a browser.
 *
 * Each case puts the world into the state it is about and then loads the URL a reader would be on. The
 * assertion is the rendered panel's own marker plus the control that says the state is not permanent
 * furniture: a page that rendered all nine would pass nine assertions and help nobody.
 */
async function expectEdge(
  url: string,
  cookie: string | null,
  state: BookingEdgeState,
): Promise<void> {
  const { page, context } = await open(url, { cookie })
  try {
    const panel = page.locator(`[data-book-edge="${state}"]`)
    expect(await panel.count(), `${state} did not render on ${url}`).toBe(1)
    const heading = (await panel.locator('h2').first().textContent())?.trim() ?? ''
    expect(heading.length, `${state} rendered a panel with no heading`).toBeGreaterThan(3)
    const body = (await panel.locator('p').first().textContent())?.trim() ?? ''
    expect(body.length, `${state} rendered a heading and nothing else`).toBeGreaterThan(20)
    // Exactly one edge panel. Two at once would mean the precedence in `decideBookingEdgeState` is not
    // being applied — it answers with ONE state.
    expect(await page.locator('[data-book-edge]').count()).toBe(1)
  } finally {
    await context.close()
  }
}

describe('acceptance — the nine edge states from docs/09 §3, each its own designed state', () => {
  it('declares nine and no more, so a case below cannot be quietly missing', () => {
    expect(BOOKING_EDGE_STATES).toHaveLength(9)
  })

  it('1. slot taken while deciding', async () => {
    const date = shiftDate(freeDate, 2)
    const session = await verifiedSession({ [BOOK_FIELDS.date]: date })
    const starts = await offeredStarts({ tradingDate: date })
    const slot = starts[2] as number
    // Both therapists occupied at that start, so the start is gone for everybody and no more specific
    // reason applies. The control is the next case: narrow it to one therapist and the panel is different.
    const bookingId = await fixtureBooking()
    for (const [index, reference] of REFERENCES.entries()) {
      await occupy({
        bookingId,
        tradingDate: date,
        roomId: roomIds[index] as string,
        therapistId: idOf(reference),
        startsAt: slot,
      })
    }
    expect(await offeredStarts({ tradingDate: date })).not.toContain(slot)
    await expectEdge(
      `${BASE}${bookHref('/book', { [BOOK_FIELDS.variant]: variantId, [BOOK_FIELDS.gender]: 'female', [BOOK_FIELDS.date]: date, [BOOK_FIELDS.slot]: slot, [BOOK_FIELDS.step]: 'confirm' })}`,
      session.cookie,
      'slot_taken',
    )
  }, 240_000)

  it('2. OTP never arrives', async () => {
    const session = await verifiedSessionlessCode()
    await expectEdge(
      bookUrl(carried({ [BOOK_FIELDS.step]: 'otp', [BOOK_FIELDS.issue]: 'code_not_received' })),
      session.cookie,
      'otp_not_arrived',
    )
  }, 120_000)

  it('3. network drop mid-submit, and the recovery that writes nothing', async () => {
    const date = shiftDate(freeDate, 3)
    const starts = await offeredStarts({ tradingDate: date })
    const slot = starts[1] as number
    const session = await verifiedSession({ [BOOK_FIELDS.date]: date, [BOOK_FIELDS.slot]: slot })
    const before = await appointmentCount(date)
    const url = `${BASE}${bookHref('/book', { [BOOK_FIELDS.variant]: variantId, [BOOK_FIELDS.gender]: 'female', [BOOK_FIELDS.date]: date, [BOOK_FIELDS.slot]: slot, [BOOK_FIELDS.step]: 'confirm' })}`

    // A real drop: the submission is aborted in flight, so the browser never learns the outcome.
    const { page, context } = await open(url, { cookie: session.cookie })
    try {
      await page.route('**/api/v1/book', async (route) => await route.abort())
      await page.locator('[data-submit-once="confirm"]').click()
      await page.waitForTimeout(500)
    } finally {
      await context.close()
    }
    // Nothing was written, which is what makes the recovery safe to offer.
    expect(await appointmentCount(date)).toBe(before)

    await expectEdge(`${url}&${BOOK_FIELDS.issue}=interrupted`, session.cookie, 'network_drop')

    // And the recovery really does recover: the same key, submitted again, produces one booking.
    const retried = await flowPost(
      {
        action: 'confirm',
        ...carried({ [BOOK_FIELDS.date]: date, [BOOK_FIELDS.slot]: slot }),
      },
      session.cookie,
    )
    expect(retried.status, retried.location).toBe(303)
    expect(await appointmentCount(date)).toBe(before + 1)
  }, 300_000)

  it('4. double submission', async () => {
    const date = shiftDate(freeDate, 4)
    const starts = await offeredStarts({ tradingDate: date })
    const slot = starts[1] as number
    const session = await verifiedSession({ [BOOK_FIELDS.date]: date, [BOOK_FIELDS.slot]: slot })
    const fields = {
      action: 'confirm',
      ...carried({ [BOOK_FIELDS.date]: date, [BOOK_FIELDS.slot]: slot }),
    }
    await flowPost(fields, session.cookie)
    const second = await flowPost(fields, session.cookie)
    expect(second.location).toContain('error=already_booked')
    await expectEdge(`${BASE}${second.location}`, session.cookie, 'double_submission')
  }, 240_000)

  it('5. therapist became unavailable after selection', async () => {
    const date = shiftDate(freeDate, 5)
    const session = await verifiedSession({ [BOOK_FIELDS.date]: date })
    const chosen = idOf('bui02-a')
    const starts = await offeredStarts({ tradingDate: date, therapistId: chosen })
    const slot = starts[3] as number
    // Only the CHOSEN therapist is occupied. The other stays free, so the start is still deliverable —
    // which is exactly what makes "widen to any therapist" the useful remedy rather than "choose again".
    await occupy({
      bookingId: await fixtureBooking(),
      tradingDate: date,
      roomId: roomIds[0] as string,
      therapistId: chosen,
      startsAt: slot,
    })
    expect(await offeredStarts({ tradingDate: date, therapistId: chosen })).not.toContain(slot)
    expect(await offeredStarts({ tradingDate: date })).toContain(slot)
    await expectEdge(
      `${BASE}${bookHref('/book', { [BOOK_FIELDS.variant]: variantId, [BOOK_FIELDS.gender]: 'female', [BOOK_FIELDS.date]: date, [BOOK_FIELDS.therapist]: chosen, [BOOK_FIELDS.slot]: slot, [BOOK_FIELDS.step]: 'confirm' })}`,
      session.cookie,
      'therapist_became_unavailable',
    )
  }, 240_000)

  it('6. required room type now booked', async () => {
    // The treatment that needs the WET room, of which the premises has exactly one. One appointment in it
    // takes the room while a therapist stays free, which is the state this panel is about: another
    // therapist would not help and another time would.
    const date = shiftDate(freeDate, 6)
    const session = await verifiedSession({
      [BOOK_FIELDS.date]: date,
      [BOOK_FIELDS.variant]: wetVariantId,
    })
    const starts = await offeredStarts({ tradingDate: date, serviceVariantId: wetVariantId })
    expect(starts.length).toBeGreaterThan(3)
    const slot = starts[3] as number
    await occupy({
      bookingId: await fixtureBooking(),
      tradingDate: date,
      roomId: wetRoomId,
      therapistId: idOf('bui02-a'),
      startsAt: slot,
      // Long enough that the room is covered for the whole of the chosen start's footprint.
      minutes: 120,
      serviceVariantId: wetVariantId,
    })
    expect(
      await offeredStarts({ tradingDate: date, serviceVariantId: wetVariantId }),
    ).not.toContain(slot)
    // The other therapist is still free at that instant, which is what makes the ROOM the reason.
    expect(await offeredStarts({ tradingDate: date })).toContain(slot)
    await expectEdge(
      `${BASE}${bookHref('/book', { [BOOK_FIELDS.variant]: wetVariantId, [BOOK_FIELDS.gender]: 'female', [BOOK_FIELDS.date]: date, [BOOK_FIELDS.slot]: slot, [BOOK_FIELDS.step]: 'confirm' })}`,
      session.cookie,
      'required_room_taken',
    )
  }, 240_000)

  it('7. service duration no longer fits before closing', async () => {
    // The close MOVES after the reader chose, which is the only way this state arises: the engine would
    // never have offered a start whose treatment ran past the close. The date is one this file inserted,
    // so nothing else is looking at it.
    const date = insertedDates.at(-1) ?? shiftDate(freeDate, 4)
    const session = await verifiedSession({ [BOOK_FIELDS.date]: date })
    const starts = await offeredStarts({ tradingDate: date })
    const slot = starts.at(-1) as number
    await sql`
      update business_day set closes_at = ${new Date(slot + 30 * 60_000).toISOString()}
       where trading_date = ${date}
    `
    await expectEdge(
      `${BASE}${bookHref('/book', { [BOOK_FIELDS.variant]: variantId, [BOOK_FIELDS.gender]: 'female', [BOOK_FIELDS.date]: date, [BOOK_FIELDS.slot]: slot, [BOOK_FIELDS.step]: 'confirm' })}`,
      session.cookie,
      'duration_no_longer_fits',
    )
    // Restored, so the case leaves the fixture as it found it: `afterAll` deletes the row, but a later
    // case in this file reading this date would otherwise see a day that closes at teatime.
    await sql`
      update business_day
         set closes_at = ((trading_date + 1) || ' 02:00:00+04')::timestamptz
       where trading_date = ${date}
    `
  }, 240_000)

  it('8. session expiry mid-flow', async () => {
    const session = await verifiedSession()
    // Expired in the table, which is where the decision is made. A cookie `Max-Age` is a request to the
    // browser and an `exp` claim is checked by whatever remembers to; `expires_at` is read every request.
    await sql`
      update booking_session set expires_at = created_at + interval '1 millisecond'
       where phone_e164 = ${session.phone}
    `
    const starts = await offeredStarts({ tradingDate: freeDate })
    await expectEdge(
      bookUrl(carried({ [BOOK_FIELDS.slot]: starts[0] as number, [BOOK_FIELDS.step]: 'confirm' })),
      session.cookie,
      'session_expired',
    )
  }, 180_000)

  it('9. browser back after confirm', async () => {
    const date = shiftDate(freeDate, 2)
    const starts = await offeredStarts({ tradingDate: date })
    const slot = starts.at(-2) as number
    const session = await verifiedSession({ [BOOK_FIELDS.date]: date, [BOOK_FIELDS.slot]: slot })
    const confirmed = await flowPost(
      {
        action: 'confirm',
        ...carried({ [BOOK_FIELDS.date]: date, [BOOK_FIELDS.slot]: slot }),
      },
      session.cookie,
    )
    expect(confirmed.status, confirmed.location).toBe(303)
    // Back to the form. Rendering it again would invite a second appointment for one customer, which is
    // the worst outcome available on this page.
    await expectEdge(
      `${BASE}${bookHref('/book', { [BOOK_FIELDS.variant]: variantId, [BOOK_FIELDS.gender]: 'female', [BOOK_FIELDS.date]: date, [BOOK_FIELDS.slot]: slot, [BOOK_FIELDS.step]: 'confirm' })}`,
      session.cookie,
      'back_after_confirm',
    )
  }, 240_000)

  it('renders NO edge panel on a flow where nothing is wrong, which is the control for all nine', async () => {
    // Nine reachable panels prove nothing if the page renders one on every request. This is the same
    // confirm step, on a session that is live and a slot that is free.
    const date = shiftDate(freeDate, 3)
    const starts = await offeredStarts({ tradingDate: date })
    const session = await verifiedSession({ [BOOK_FIELDS.date]: date })
    const { page, context } = await open(
      `${BASE}${bookHref('/book', { [BOOK_FIELDS.variant]: variantId, [BOOK_FIELDS.gender]: 'female', [BOOK_FIELDS.date]: date, [BOOK_FIELDS.slot]: starts.at(-1) as number, [BOOK_FIELDS.step]: 'confirm' })}`,
      { cookie: session.cookie },
    )
    try {
      expect(await page.locator('[data-book-edge]').count()).toBe(0)
      expect(await page.locator('[data-book-state="confirm"]').count()).toBe(1)
    } finally {
      await context.close()
    }
  }, 180_000)

  it('reports zero serious or critical axe violations on the four steps it adds', async () => {
    const starts = await offeredStarts({ tradingDate: freeDate })
    const session = await verifiedSession()
    for (const step of ['details', 'otp', 'confirm'] as const) {
      const { page, context } = await open(
        bookUrl(carried({ [BOOK_FIELDS.step]: step, [BOOK_FIELDS.slot]: starts[0] as number })),
        { cell: PHONE, cookie: session.cookie },
      )
      try {
        const result = await auditPage(page, {
          page: CAPTURE_LABEL,
          viewport: { name: '390', width: 390, height: 844, scale: 1, why: 'axe' },
          theme: 'light',
          direction: 'ltr',
        })
        expect(blockingViolations(result.violations).map(describeViolation), step).toEqual([])
      } finally {
        await context.close()
      }
    }
  }, 300_000)
})

describe('acceptance — the budget, measured against the running page', () => {
  /**
   * INP and the first-slot paint, from one load.
   *
   * INP is measured two ways and the WORSE is taken. The Event Timing API is the faithful one — it is what
   * a field measurement uses — but it reports nothing at all when no interaction exceeds its 16ms
   * threshold, and a budget that reads zero cannot be shown to fire. So a click-to-paint is measured
   * beside it with `requestAnimationFrame`, which is always positive, and the maximum of the two is the
   * number judged. Both are reported, so a failure says which one produced it.
   */
  async function measure(): Promise<{ measurement: BookBudgetMeasurement; eventInp: number }> {
    const starts = await offeredStarts({ tradingDate: freeDate })
    expect(starts.length).toBeGreaterThan(5)
    const url = bookUrl(carried({}))
    // The page really does render a slot list, so the paint being timed is a paint that contains one.
    expect(await fetchHtml(url)).toContain('role="option"')

    const { page, context } = await open(url, { cell: PHONE })
    try {
      await page.evaluate(() => {
        const store = globalThis as unknown as { __events: number[] }
        store.__events = []
        // `durationThreshold` is a real field of the Event Timing API and is absent from this TypeScript
        // lib's `PerformanceObserverInit`, so the options object is widened structurally rather than with
        // an `any` — a cast to `any` here would also hide a typo in `type` on the line above.
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) store.__events.push(entry.duration)
        }).observe({
          type: 'event',
          durationThreshold: 16,
          buffered: true,
        } as PerformanceObserverInit & {
          durationThreshold: number
        })
      })

      const rafInp = await page.evaluate(async () => {
        const first = document.querySelector<HTMLElement>('[role="option"][tabindex="0"]')
        if (first === null) throw new Error('no slot option on the page')
        first.focus()
        const worst: number[] = []
        for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'End', 'Home']) {
          const started = performance.now()
          ;(document.activeElement ?? first).dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
          )
          await new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))
          })
          worst.push(performance.now() - started)
        }
        return Math.max(...worst)
      })

      // Real interactions as well, so the Event Timing entries are about real input and not a synthetic
      // dispatch. `page.keyboard` goes through the browser's own input pipeline.
      await page.locator('[role="option"]').first().focus()
      for (const key of ['ArrowDown', 'ArrowUp', 'End', 'Home']) await page.keyboard.press(key)

      const measured = await page.evaluate(() => {
        const store = globalThis as unknown as { __events: number[] }
        const navigation = performance.getEntriesByType('navigation')[0] as
          | PerformanceNavigationTiming
          | undefined
        const paint = performance.getEntriesByName('first-contentful-paint')[0]
        const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
        return {
          eventInp: store.__events.length === 0 ? 0 : Math.max(...store.__events),
          // The slot list is in the initial HTML, so the first contentful paint IS the paint that
          // contains it. Asserted above against the served bytes rather than assumed here.
          firstSlotAt: paint?.startTime ?? navigation?.domContentLoadedEventEnd ?? 0,
          scripts: resources
            .filter(
              (entry) =>
                entry.initiatorType === 'script' ||
                entry.name.split('?')[0]?.endsWith('.js') === true,
            )
            .map((entry) => ({ name: entry.name, bytes: entry.encodedBodySize })),
        }
      })

      const own = measured.scripts.filter(
        (script) => !FRAMEWORK_CHUNKS.some((file) => script.name.endsWith(file)),
      )
      return {
        eventInp: measured.eventInp,
        measurement: {
          inp: Math.max(rafInp, measured.eventInp),
          'time-to-first-slot': measured.firstSlotAt,
          'first-party-js': own.reduce((total, script) => total + script.bytes, 0),
        },
      }
    } finally {
      await context.close()
    }
  }

  it('is inside every declared limit, and the job fails when one is lowered under it', async () => {
    const { measurement, eventInp } = await measure()
    const findings = judgeBookBudget(measurement)
    expect(
      formatBookBudgetFindings(findings),
      `measured ${JSON.stringify(measurement)} (event-timing INP ${eventInp}ms)`,
    ).toBe('')

    // The control, and it is the SAME measurement re-judged: *"the job fails when either budget is
    // breached"* is a claim about the wiring, and a synthetic measurement would prove the arithmetic
    // instead. Each limit is lowered to just under what the page actually did, so every one of them fires.
    const lowered = BOOK_BUDGET.map((entry) => ({
      ...entry,
      limit: Math.max(0, Math.floor(measurement[entry.metric]) - 1),
    }))
    const breached = judgeBookBudget(measurement, lowered)
    expect(breached.map((finding) => finding.metric).sort()).toEqual(
      BOOK_BUDGET.map((entry) => entry.metric).sort(),
    )
    // The failure carries the numbers, which is the first thing anybody asks of a breached budget.
    expect(formatBookBudgetFindings(breached)).toContain('[book-budget-over]')
    expect(formatBookBudgetFindings(breached)).toContain('against a budget of')

    // Reported, not only asserted: a run that is close to a limit is a run on its way to failing, and this
    // is where that would first be visible.
    console.log(
      `[book-budget] inp ${Math.round(measurement.inp)}ms (event-timing ${Math.round(eventInp)}ms), ` +
        `first slot ${Math.round(measurement['time-to-first-slot'])}ms, ` +
        `first-party JS ${measurement['first-party-js']} bytes`,
    )
  }, 300_000)

  it('ships the one heavy island and no more, with nothing from the server graph in it', async () => {
    // The island is the reason there is a JS number on this route at all, and the defect it exists to
    // catch is an import that drags a server-side graph across the boundary. `zod` is the marker: it
    // arrives through `@berelax/shared`'s barrel, which both `@berelax/core` and `@berelax/ui/patterns`
    // reach — and it WAS in this chunk until both imports were narrowed to the module they need.
    const { page, context } = await open(bookUrl(carried({})), { cell: PHONE })
    try {
      const sources = await page.evaluate(() =>
        [...document.querySelectorAll('script[src]')].map(
          (element) => element.getAttribute('src') ?? '',
        ),
      )
      expect(sources.length).toBeGreaterThan(0)
      const bodies = await Promise.all(
        sources
          .filter((src) => !FRAMEWORK_CHUNKS.some((file) => src.endsWith(file)))
          .map(async (src) => await (await fetch(new URL(src, BASE).toString())).text()),
      )
      expect(bodies.length).toBeGreaterThan(0)
      const joined = bodies.join('\n')
      // The island really is on the page, so the assertion below is about a chunk that exists.
      expect(joined).toContain('be-book')
      expect(joined, 'a zod schema reached the browser through a barrel import').not.toContain(
        'ZodError',
      )
    } finally {
      await context.close()
    }
  }, 180_000)
})

describe('acceptance — a step that needs a verified phone never renders without one', () => {
  it('answers the confirm step with the phone form when there is no session at all', async () => {
    const starts = await offeredStarts({ tradingDate: freeDate })
    const html = await fetchHtml(
      bookUrl(carried({ [BOOK_FIELDS.step]: 'confirm', [BOOK_FIELDS.slot]: starts[0] as number })),
    )
    // The phone form, not an error: the URL still means "I want to book this", and the one thing missing
    // is a number. A bookmarked `?step=confirm` from yesterday is exactly this.
    expect(html).toContain('data-book-state="details"')
    expect(html).not.toContain('data-book-state="confirm"')
  }, 60_000)

  it('refuses to book for an unverified session, whatever the form says', async () => {
    // The control that matters most in this file. A session exists — a code was requested — and the
    // confirm action must still refuse, because nobody has proved the number.
    const session = await verifiedSessionlessCode()
    const starts = await offeredStarts({ tradingDate: freeDate })
    const before = await appointmentCount(freeDate)
    const attempt = await flowPost(
      { action: 'confirm', ...carried({ [BOOK_FIELDS.slot]: starts[1] as number }) },
      session.cookie,
    )
    expect(attempt.status).toBe(303)
    expect(attempt.location).toContain('step=details')
    expect(await appointmentCount(freeDate)).toBe(before)
    // And the waitlist join, which needs the same thing.
    const joined = await flowPost({ action: 'join_waitlist', ...carried() }, session.cookie)
    expect(joined.location).toContain('step=details')
  }, 180_000)

  it('refuses a wrong code by name and still accepts the right one afterwards', async () => {
    const session = await verifiedSessionlessCode()
    await writeKnownCode(session.phone)
    const wrong = await flowPost(
      { action: 'verify_code', code: '000000', ...carried() },
      session.cookie,
    )
    expect(wrong.status).toBe(303)
    expect(wrong.location).toContain('error=wrong_code')
    const html = await fetchHtml(`${BASE}${wrong.location}`, session.cookie)
    expect(html).toContain('data-book-error="wrong_code"')
    // The right code still works afterwards: a wrong guess spends an attempt, not the challenge.
    const right = await flowPost(
      { action: 'verify_code', code: KNOWN_CODE, ...carried() },
      session.cookie,
    )
    expect(right.location, right.location).not.toContain('error=')
  }, 180_000)

  it('refuses a landline as a code target with its own named reason', async () => {
    // `phone_not_eligible`, not "invalid": a landline cannot receive an SMS at all, so the code would
    // never arrive and the reader would wait for it.
    const refused = await flowPost(
      { action: 'send_code', phone: '04 399 1234', ...carried() },
      null,
      callerIpFor(900),
    )
    expect(refused.status).toBe(303)
    expect(refused.location).toContain('error=phone_not_eligible')
    const html = await fetchHtml(`${BASE}${refused.location}`)
    expect(html).toContain('data-book-error="phone_not_eligible"')
  }, 60_000)
})

describe('acceptance — the chosen-slot summary now leads somewhere', () => {
  it('offers a control that reaches the phone step, which B-UI-01 left as a named state', async () => {
    const starts = await offeredStarts({ tradingDate: freeDate })
    const slot = starts[0] as number
    const html = await fetchHtml(bookUrl(carried({ [BOOK_FIELDS.slot]: slot })))
    expect(html).toContain('data-book-state="chosen"')
    expect(html).toContain('data-book-continue="details"')
    expect(html).toContain(wallClock(slot))
    const href = /data-book-continue="details"\s+href="([^"]+)"/.exec(html)?.[1]
    const followed = await fetchHtml(`${BASE}${(href ?? '').replaceAll('&amp;', '&')}`)
    expect(followed).toContain('data-book-state="details"')
  }, 120_000)
})
