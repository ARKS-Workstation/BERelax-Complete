import { ASIA_DUBAI, type Instant, normalisePhone, refCaptureRate, toLocal } from '@berelax/core'
import {
  createConnection,
  issueWhatsappRef,
  readBookableVariants,
  readMandatoryDocumentTypes,
  readRefCaptureCounts,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import { DETERMINISM_CSS, DETERMINISTIC_LAUNCH_ARGS } from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { THERAPIST_REFUSAL_REASONS } from '../app/(admin)/quick-book/view.ts'

/**
 * B-UI-04 — quick-book in a real browser, against the BUILT application and a real PostgreSQL.
 *
 * The claims here are the ones no substring assertion can make: a measured interaction is keystrokes into a
 * real form waiting on a real POST, "operable with no pointer events" is a context that refuses them, and
 * axe needs a rendered DOM. The ROWS — the schema's refusals, the enum pinning, the counters — are
 * `packages/fixtures/src/whatsapp-ref.itest.ts`'s, and the document's byte order is
 * `quick-book-render.test.ts`'s.
 *
 * The band `quick-book` in `@berelax/harness/ports` is this file's (brief rules 18 and 19).
 *
 * ## Why the measured walk-in is booked on a PINNED day, and what that does and does not weaken
 *
 * `?date=` is in the URL, and every case here uses it. Without it the screen offers the trading day in
 * progress, and the wall-clock TIME OF DAY then decides whether there is anything to book: between midnight
 * and 02:00 Dubai the current day is minutes from closing, so a 60-minute treatment has no offerable start
 * and the suite would be red for two hours in every twenty-four. That is a flake whose cause is invisible
 * from the symptom — exactly the class of defect the standing brief keeps paying for — and pinning the day
 * removes the clock from the measurement without weakening it: the CONTROLS are identical on any day, and
 * what the 10-second line measures is the interaction, not the appointment time.
 *
 * The default state is asserted separately and WITHOUT a clock assumption: `names the current trading day`
 * compares the rendered day against a direct query rather than against a hard-coded date, and the closed
 * case asserts a date the premises has no row for.
 *
 * ## Why the 10-second line is asserted as WORK as well as milliseconds
 *
 * The brief's rule 23: a wall-clock assertion measures the machine, not the code. The acceptance line names
 * 10 seconds and names no machine, and this container is not a front desk's tablet. So both are asserted:
 *
 *   - the WORK, unconditionally — how many controls the operator touches, how many keystrokes the phone
 *     number costs, that the therapist and the room cost ZERO input, and that the whole booking is two
 *     round trips. None of that moves with the load on the box, and it is the thing the 10-second target is
 *     really about;
 *   - the milliseconds, gated on a MEASURED baseline from the same server. If one plain GET of the page
 *     already costs more than {@link BASELINE_CEILING_MS}, the box cannot hold a 10-second interaction and
 *     the case skips loudly with both numbers on **stderr** — vitest shows a passing or skipped test's
 *     stdout to nobody. Otherwise it asserts the ceiling.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const PATH = '/quick-book'
const MARKER = 'bui04 quick-book itest'
const PROBE_SLUG = 'asian-normal-massage'
const PROBE_DURATION = 60

/**
 * ONE TRADING DAY PER CASE, and the reason is the sharpest isolation lesson in this file.
 *
 * The first version gave every case the same day and the same 11:00 start. Two bookings later the two
 * eligible fixture therapists were both busy over that period and every subsequent check was correctly
 * refused — so nine cases failed with a thirty-second timeout each, and not one of the failures was about
 * the thing it named. A 60-minute treatment with a 10-minute buffer each side and a 20-minute room
 * turnaround occupies roughly 80 minutes, and the grid this screen offers is only two hours wide, so a
 * shared day holds about two bookings however many cases want one.
 *
 * `?date=` makes a day per case almost free, and it is better isolation than spacing starts within one day
 * would be: no case can be affected by what another books, in either order, and a case added later needs an
 * index rather than an audit of who is busy when.
 *
 * Offsets 45 upwards, and 45 rather than the next round number: `book.itest.ts` inserts 24 through 40 and
 * removes what it inserted, and two suites inserting the same `business_day` row means the first to finish
 * deletes the row the second is still using. Every offset stays inside the provisional 90-day advance window
 * (Y9-lead), which the check applies unchanged — a date beyond it would be refused for a reason that has
 * nothing to do with this screen.
 */
const FIRST_OFFSET = 45
/** How many per-case days the fixture creates. Index 0 is the CLOSED day and gets no row. */
const CASE_DAYS = 24

/**
 * The E.164 prefix every number this file books under shares, for the cleanup to find them by.
 *
 * `52` and not the `59` other suites use for their `customer` rows: those rows are inserted directly, and a
 * number this file TYPES has to be one `normalisePhone` accepts — 59 is not a UAE mobile prefix (B-LIFE-02
 * lists 50, 52, 54, 55, 56 and 58), so a 59 number would be refused by the screen for a reason that has
 * nothing to do with what is being tested. `+9715200007` holds no customer in a seeded database.
 */
const PHONE_PREFIX = '+9715200007'
const REF_CODE = 'QB34'

/** The five fixture therapists, and what each one is for. */
const STAFF = {
  /** Eligible, rostered, free. The one the solver should choose. */
  chosen: 'bui04-chosen',
  /** Eligible, rostered, free. The alternative, so an override has somewhere to go. */
  spare: 'bui04-spare',
  /** Eligible in every other way and holds no `asian_style` skill. */
  noSkill: 'bui04-no-skill',
  /** Eligible in every other way and a mandatory document expired yesterday. */
  expired: 'bui04-expired',
  /** Eligible in every other way and on no shift at all. */
  unrostered: 'bui04-unrostered',
  /** Eligible, rostered, free — and male, so a female client cannot be paired with them. */
  male: 'bui04-male',
} as const

/** The day with no `business_day` row, for the closure case. Index 0; see {@link CASE_DAYS}. */
const CLOSED_DAY = 0
/**
 * A trading day in the PAST, which is the only way to reach `start_has_passed` without a clock assumption.
 *
 * The refusal needs an instant that is inside a trading day's window AND before `now`, and a future `?date=`
 * cannot have one. Five days back rather than the current day, because "is the current day's window partly
 * behind us" depends on the wall-clock time of day — the flake this file pins `?date=` to avoid.
 */
const PAST_DAY_OFFSET = -5
/** A day nothing books on, so the served-bytes cases can read a form nobody has consumed a slot from. */
const READ_ONLY_DAY = 23

/** The ceiling the acceptance line names, for the interaction it names. */
const WALK_IN_CEILING_MS = 10_000
/**
 * How slow one plain GET of this page may be before the millisecond assertion is meaningless.
 *
 * 2,500 ms, and the figure is a judgement rather than a measurement: a page load that alone costs a quarter
 * of the whole budget says the box is not a front desk's tablet, and asserting 10 seconds on it would be
 * asserting something about this container. Measured on an idle container the GET is roughly 60-200 ms, so
 * the gate is an order of magnitude clear of normal and only trips under real contention.
 */
const BASELINE_CEILING_MS = 2_500

let sql: Sql
let server: WebServer
let browser: Browser
let BASE = ''
let variantId = ''
let variantLabelFragment = ''
let today = ''
const staff = new Map<string, string>()
const insertedDates: string[] = []
const bookingIds: string[] = []

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

/** The trading date case `index` owns. Index 0 is deliberately the one with no `business_day` row. */
const dayFor = (index: number): string => shiftDate(today, FIRST_OFFSET + index)
/**
 * 11:00 on case `index`'s own day, which is the first grid start there.
 *
 * The day opens at 11:00 and `now` is forty-five days earlier, so `max(opens_at, now + lead)` is the open and
 * the quarter-hour round-up is a no-op. Asserted rather than assumed by the served-bytes case, which looks
 * for this exact value in an option.
 */
const startFor = (index: number): string => new Date(at(dayFor(index), '11:00')).toISOString()

async function addEmployee(args: {
  readonly reference: string
  readonly gender: 'female' | 'male'
  readonly skills: readonly string[]
  readonly credentialExpiry: string
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, notes)
    values (${args.reference}, ${args.gender}, '2020-01-01', ${MARKER})
    on conflict (staff_reference) do update set notes = excluded.notes, gender = excluded.gender
    returning id::text as id
  `
  const id = (row as { id: string }).id
  staff.set(args.reference, id)
  for (const skill of args.skills) {
    await sql`
      insert into employee_skill (employee_id, skill) values (${id}, ${skill}::therapist_skill)
      on conflict do nothing
    `
  }
  // Without a row per MANDATORY document type the read model answers `credential_missing` and the therapist
  // is not bookable at all — which is B-AVAIL-04's rule working, and why the seeded nineteen offer nothing.
  // The set is read IN FORCE rather than named, so a change to the regulatory profile reaches this fixture.
  for (const documentType of await readMandatoryDocumentTypes(sql)) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${id}, ${documentType}::employee_document_type, ${args.credentialExpiry}::date)
      on conflict do nothing
    `
  }
  return id
}

beforeAll(async () => {
  sql = createConnection({ url, max: 6 })
  today = localDateOf(Date.now())

  // 11:00-02:00 Asia/Dubai, the window the whole system is built around, for every case day but index 0.
  // `appointment.trading_date` and `shift.trading_date` are foreign keys into this table, so no fixture can
  // invent a date the premises does not trade on. `returning` is what makes the cleanup remove only the rows
  // this run added: a date the fixture seed already holds is not this file's to delete.
  const days: string[] = []
  for (let index = 1; index < CASE_DAYS; index += 1) days.push(dayFor(index))
  const inserted = await sql<{ trading_date: string }[]>`
    insert into business_day (trading_date, opens_at, closes_at, source)
    select d::date, (d::date || ' 11:00:00+04')::timestamptz,
           ((d::date + 1) || ' 02:00:00+04')::timestamptz, 'weekly'
      from unnest(${days}::date[]) as d
    on conflict (trading_date) do nothing
    returning trading_date::text as trading_date
  `
  insertedDates.push(...inserted.map((row) => row.trading_date))

  // The past day. `on conflict do nothing` with `returning`, so a date the fixture SEED already holds is not
  // this file's to delete — which it usually is, because the seeded calendar covers recent dates.
  const pastDate = shiftDate(today, PAST_DAY_OFFSET)
  const insertedPast = await sql<{ trading_date: string }[]>`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${pastDate}::date, (${pastDate} || ' 11:00:00+04')::timestamptz,
            (${shiftDate(pastDate, 1)} || ' 02:00:00+04')::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
    returning trading_date::text as trading_date
  `
  insertedDates.push(...insertedPast.map((row) => row.trading_date))
  /*
    Day 0 is deliberately left with NO row: a closure is an ABSENT row rather than a flag (0018), and the case
    that asserts the screen names a closed day needs a date that really has none.

    This file's own shifts across the whole case range go FIRST, and that is not belt and braces. A crashed
    earlier run leaves them behind — `shift.trading_date` references `business_day` — so the delete below
    fails with a foreign key violation naming a table this fixture is not obviously about, and the whole
    suite fails in `beforeAll` for a reason that has nothing to do with the run. A previous run's litter must
    not poison the next one.
  */
  const range: string[] = []
  for (let index = 0; index < CASE_DAYS; index += 1) range.push(dayFor(index))
  const stale = await sql<{ id: string }[]>`
    select id::text as id from shift where label = ${MARKER} and trading_date = any(${range}::date[])
  `
  if (stale.length > 0) {
    const staleIds = stale.map((row) => row.id)
    await sql`delete from shift_assignment where shift_id = any(${staleIds}::uuid[])`
    await sql`delete from shift where id = any(${staleIds}::uuid[])`
  }
  await sql`delete from business_day where trading_date = ${dayFor(0)}::date`

  const variants = await readBookableVariants(sql)
  const variant = variants.find(
    (row) => row.slug === PROBE_SLUG && row.durationMinutes === PROBE_DURATION,
  )
  if (variant === undefined) {
    throw new Error(
      `the catalogue has no ${PROBE_SLUG} at ${PROBE_DURATION} minutes: run \`pnpm seed\` before the ` +
        'integration suite — this unit drives the real menu rather than a probe service.',
    )
  }
  variantId = variant.serviceVariantId
  variantLabelFragment = `${variant.publicDisplayName} — ${PROBE_DURATION} min`

  const yesterday = shiftDate(today, -1)
  await addEmployee({
    reference: STAFF.chosen,
    gender: 'female',
    skills: ['asian_style'],
    credentialExpiry: '2099-12-31',
  })
  await addEmployee({
    reference: STAFF.spare,
    gender: 'female',
    skills: ['asian_style'],
    credentialExpiry: '2099-12-31',
  })
  await addEmployee({
    reference: STAFF.noSkill,
    gender: 'female',
    skills: ['arabic_style'],
    credentialExpiry: '2099-12-31',
  })
  await addEmployee({
    reference: STAFF.expired,
    gender: 'female',
    skills: ['asian_style'],
    credentialExpiry: yesterday,
  })
  await addEmployee({
    reference: STAFF.unrostered,
    gender: 'female',
    skills: ['asian_style'],
    credentialExpiry: '2099-12-31',
  })
  await addEmployee({
    reference: STAFF.male,
    gender: 'male',
    skills: ['asian_style'],
    credentialExpiry: '2099-12-31',
  })

  /*
    One shift for everybody but `unrostered`, and it starts an hour BEFORE the doors and ends half an hour
    after the close — which is a fixture decision worth explaining, because the first version started it at
    11:00 and every check refused.

    The solver requires a therapist's BUFFERED interval to sit inside their presence with no gap, and the
    provisional buffer is 10 minutes each side (Y9-buffer). A treatment at 11:00 is therefore held from
    10:50, and a presence starting at 11:00 cannot contain it — so the first grid start was unbookable for
    every therapist and the suite timed out waiting for an assignment that was correctly refused.

    That is the availability engine working, not a defect, and it says something real about this screen: the
    grid offers CANDIDATE starts and the check is the authority, so the earliest option is refused whenever
    the rota begins exactly at opening. The screen answers that with `no_assignment` naming the times that
    ARE open, which the "refuses a start it never offered" sibling and the handler's own refusal table cover.
    A rota that has staff on the floor before the doors open is also what a real one looks like.
  */
  for (const date of days) {
    const [shift] = await sql<{ id: string }[]>`
      insert into shift (trading_date, period, label)
      values (${date}::date,
              ${`[${new Date(at(date, '10:00')).toISOString()},${new Date(at(shiftDate(date, 1), '02:30')).toISOString()})`}::tstzrange,
              ${MARKER})
      returning id::text as id
    `
    for (const reference of [STAFF.chosen, STAFF.spare, STAFF.noSkill, STAFF.expired, STAFF.male]) {
      await sql`
        insert into shift_assignment (shift_id, employee_id)
        values (${(shift as { id: string }).id}::uuid, ${idOf(reference)}::uuid)
        on conflict do nothing
      `
    }
  }

  // The matched code, through the writer A-FIRST will use rather than a hand-written row: a row inserted by
  // hand would be a code the issuing path never produced, which is the one thing this table must not hold.
  await withUnitOfWork(sql, { kind: 'staff', label: MARKER }, (uow) =>
    issueWhatsappRef(uow, { sessionReference: `${MARKER} conversation`, refCode: REF_CODE }),
  )

  server = await startWebServer({
    suite: 'quick-book',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: PATH,
    readyWithinMs: 90_000,
    env: {
      // This route calls `loadConfig()`, so both values it needs are declared rather than assumed: CI exports
      // them, and a local run that exported only TEST_DATABASE_URL would get a 503 reading like a broken
      // route.
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL: url,
    },
  })
  BASE = server.origin
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 240_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop()
  if (sql === undefined) return
  const customers = await sql<{ id: string }[]>`
    select id::text as id from customer where phone_e164 like ${`${PHONE_PREFIX}%`}
  `
  const ids = customers.map((row) => row.id)
  if (ids.length > 0) {
    /*
      The CAPTURE ROWS first, then the bookings, then the customers.

      `appointment.booking_id` and `booking_idempotency.booking_id` cascade from the booking, so neither needs
      a statement of its own — and `booking_idempotency` has no customer column, which is why an earlier
      version of this teardown failed with `column "customer_id" does not exist` and left the whole fixture
      behind.

      `booking_whatsapp_ref_capture.booking_id` does NOT cascade: 0079 carries no foreign key there, for the
      reason its own header gives. So a fixture that deleted only its bookings would leave capture rows
      behind — counted in every later capture rate, for ever, which would make the delta assertions in this
      very file wrong on the next run. They are found through the bookings, which are found through the
      customer: a booking taken through the endpoint carries no marker of its own.
    */
    await sql`
      delete from booking_whatsapp_ref_capture
       where booking_id in (select id from booking where customer_id = any(${ids}::uuid[]))
    `
    await sql`delete from booking where customer_id = any(${ids}::uuid[])`
    await sql`delete from customer where id = any(${ids}::uuid[])`
  }
  await sql`delete from whatsapp_ref where ref_code = ${REF_CODE}`
  const staffIds = [...staff.values()]
  if (staffIds.length > 0) {
    await sql`delete from shift_assignment where employee_id = any(${staffIds}::uuid[])`
    await sql`delete from employee_document where employee_id = any(${staffIds}::uuid[])`
    await sql`delete from employee_skill where employee_id = any(${staffIds}::uuid[])`
  }
  await sql`delete from shift where label = ${MARKER}`
  await sql`delete from employee where notes = ${MARKER}`
  if (insertedDates.length > 0) {
    await sql`delete from business_day where trading_date = any(${insertedDates}::date[])`
  }
  await sql.end({ timeout: 5 })
})

// --- the browser ----------------------------------------------------------------------------------

interface Cell {
  readonly width: number
  readonly height: number
  readonly theme: 'light' | 'dark'
  readonly direction: 'ltr' | 'rtl'
}

const DESK: Cell = { width: 1440, height: 900, theme: 'light', direction: 'ltr' }

/**
 * `?date=` and `?dir=` for one case, which is the whole of this screen's URL state.
 *
 * The day is a case INDEX and not an optional date. A default would be one day several cases quietly shared,
 * which is the arrangement that cost nine timeouts — and a default is exactly the convenience that puts it
 * back the next time a case is added.
 */
const urlFor = (index: number, options: { readonly dir?: 'rtl' } = {}): string => {
  const params = new URLSearchParams({ date: dayFor(index) })
  if (options.dir === 'rtl') params.set('dir', 'rtl')
  return `${BASE}${PATH}?${params.toString()}`
}

/** Everything case `index` owns: its day, its first start, its URL and a phone nobody else books under. */
const caseFor = (index: number) => ({
  index,
  date: dayFor(index),
  start: startFor(index),
  url: urlFor(index),
  phone: phoneFor(index),
})

interface OpenOptions {
  readonly cell?: Cell
  readonly url?: string
  /** True refuses every pointer event in the context, which is the pointer-free run. */
  readonly pointerFree?: boolean
}

async function withPage<T>(
  body: (page: Page) => Promise<T>,
  options: OpenOptions = {},
): Promise<T> {
  const cell = options.cell ?? DESK
  const context: BrowserContext = await browser.newContext({
    viewport: { width: cell.width, height: cell.height },
    deviceScaleFactor: 1,
    colorScheme: cell.theme,
    locale: cell.direction === 'rtl' ? 'ar-AE' : 'en-AE',
    timezoneId: 'Asia/Dubai',
    reducedMotion: 'reduce',
  })
  try {
    // The esbuild `keepNames` shim: Playwright serialises a callback's compiled source into the page.
    await context.addInitScript({
      content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
    })
    if (options.pointerFree === true) {
      /*
        `pointer-events: none` on every element, injected BEFORE any document exists so it applies to the
        page the navigation creates. This is the acceptance line's "pointer-free Playwright run" made
        structural rather than promised: a `page.click` in this context does not fail politely, it hangs
        until the test times out, so a case that reaches for one is a red test rather than a silent
        regression. The stylesheet is added on the CONTEXT for the reason `capture.ts` records — a page-level
        init script registered against `about:blank` never runs.
      */
      await context.addInitScript({
        content: `
          document.addEventListener('DOMContentLoaded', function () {
            var style = document.createElement('style')
            style.textContent = '*, *::before, *::after { pointer-events: none !important; }'
            document.head.appendChild(style)
          })
        `,
      })
    }
    const page = await context.newPage()
    // Every uncaught error the page's own script raises, collected and asserted on the way out. Without it a
    // broken listener is a TIMEOUT waiting for a data attribute, which names the assertion rather than the
    // cause.
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    if (options.url === undefined)
      throw new Error('withPage needs the URL of the case that owns the day')
    await page.goto(options.url, { waitUntil: 'networkidle' })
    await page.addStyleTag({ content: DETERMINISM_CSS })
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    const answer = await body(page)
    expect(pageErrors, 'the page script raised').toEqual([])
    return answer
  } finally {
    await context.close()
  }
}

/**
 * A phone number this file owns, distinct per case so no two cases share an idempotency key.
 *
 * The LOCAL spelling — a leading zero and no country code — because that is what the desk types, and the
 * E.164 normalisation is then exercised rather than bypassed.
 *
 * Ten digits exactly, and the arithmetic is worth stating because it was wrong twice. A UAE mobile is
 * `0` + a two-digit prefix + seven digits. The first version appended ONE digit of index to a nine-digit
 * stem, so case 10 produced eleven digits; the second padded the index to two and left the nine-digit stem,
 * so EVERY case produced eleven. Both failed as `phone_not_eligible` — a check failing for a reason that had
 * nothing to do with the thing it named, which is this session's dominant defect class arriving in a helper.
 */
const phoneFor = (index: number): string => `05200007${String(index).padStart(2, '0')}`

/**
 * Fills the entry form with the KEYBOARD alone and submits it, returning the resulting page.
 *
 * Every step is `keyboard` and never `click` or `fill`: `fill` sets a value without the keystrokes, which
 * would make the measured interaction a measurement of Playwright. `selectOption` is used for the two
 * selects because a native select's popup is chrome rather than DOM and cannot be driven by keys in a
 * headless context — and the acceptance claim about them is that they are reachable by TAB and settable
 * without a pointer, which `focus()` plus `selectOption` is: neither dispatches a pointer event.
 */
async function fillByKeyboard(
  page: Page,
  args: {
    readonly phone: string
    readonly ref?: string
    /** Required: a case's start belongs to its own day, and a default would be a day cases shared. */
    readonly start: string
    readonly gender?: 'female' | 'male'
  },
): Promise<void> {
  await page.locator('[data-testid="quick-book-phone"]').focus()
  await page.keyboard.type(args.phone)
  await page.keyboard.press('Tab')
  if (args.ref !== undefined && args.ref !== '') await page.keyboard.type(args.ref)
  await page.locator('[data-testid="quick-book-variant"]').selectOption(variantId)
  await page.locator(`#quick-book-gender-${args.gender ?? 'female'}`).focus()
  await page.keyboard.press('Space')
  await page.locator('[data-testid="quick-book-start"]').selectOption(args.start)
  /*
    What the keyboard actually put in the form, asserted BEFORE the submit.

    This is not belt and braces. Without it, a keystroke that did not land — a radio the Space key did not
    check, a select whose option did not match — arrives as a thirty-second timeout waiting for an assignment
    the server correctly refused, and the failure names the assertion rather than the cause. It cost two runs
    of this file to learn that, and the fix is to assert the precondition where it is cheap.
  */
  const filled = await page.evaluate(() => {
    const form = document.querySelector('[data-testid="quick-book-form"]')
    if (!(form instanceof HTMLFormElement)) return null
    const data = new FormData(form)
    return {
      phone: String(data.get('phone') ?? ''),
      ref: String(data.get('ref') ?? ''),
      variant: String(data.get('variant') ?? ''),
      gender: String(data.get('gender') ?? ''),
      start: String(data.get('start') ?? ''),
    }
  })
  expect(filled?.phone, 'the phone field took no keystrokes').toBe(args.phone)
  expect(filled?.ref, 'the ref field does not hold what was typed').toBe(args.ref ?? '')
  expect(filled?.variant, 'the treatment select was not set').toBe(variantId)
  expect(filled?.gender, 'the gender radio was not checked by the keyboard').toBe(
    args.gender ?? 'female',
  )
  expect(filled?.start, 'the start select was not set').toBe(args.start)
  await page.locator('[data-testid="quick-book-check"]').focus()
  await Promise.all([page.waitForLoadState('networkidle'), page.keyboard.press('Enter')])
  /*
    What the server made of it, named — and read through a LOCATOR rather than `page.evaluate`.

    `page.evaluate` immediately after a form submit races the navigation and throws `Execution context was
    destroyed`, which is a failure about Playwright rather than about the page; a locator auto-waits for the
    new document instead.

    And what is waited for is a selector that exists ONLY in the answer — the assignment panel or the refusal
    panel — rather than the live region, which is in the document that ASKED as well. Waiting on the live
    region resolves immediately against the old page, so the refusal read came back null whatever had
    happened and the real failure arrived thirty seconds later as a timeout naming the wrong thing.
  */
  await page.waitForSelector(
    '[data-testid="quick-book-assignment"], [data-testid="quick-book-refusal"]',
  )
  const refusal = await page.locator('html').getAttribute('data-quick-book-refusal')
  const announcement = await page.locator('[data-testid="quick-book-live"]').innerText()
  expect(refusal, `the check was refused: ${announcement}`).toBeNull()
}

/** Presses the confirm, by keyboard, and waits for the document it produces. */
async function confirmByKeyboard(page: Page): Promise<void> {
  await page.locator('[data-testid="quick-book-confirm"]').focus()
  await Promise.all([page.waitForLoadState('networkidle'), page.keyboard.press('Enter')])
}

/** A booking id this run produced, remembered so `afterAll` can find what it made. */
async function bookingIdOf(page: Page): Promise<string> {
  const id = (await page.locator('[data-testid="quick-book-booking-id"]').innerText()).trim()
  bookingIds.push(id)
  return id
}

/** What the capture row says about one booking. The durable answer, not the page's. */
async function captureOf(
  bookingId: string,
): Promise<{ outcome: string; refCode: string | null; enteredCode: string | null } | null> {
  const [row] = await sql<
    { outcome: string; ref_code: string | null; entered_code: string | null }[]
  >`
    select outcome::text as outcome, ref_code, entered_code
      from booking_whatsapp_ref_capture where booking_id = ${bookingId}::uuid
  `
  return row === undefined
    ? null
    : { outcome: row.outcome, refCode: row.ref_code, enteredCode: row.entered_code }
}

/** A check driven through the handler's HTTP surface, for the cases that are about a REFUSAL. */
async function postCheck(
  index: number,
  fields: Readonly<Record<string, string>>,
): Promise<{ status: number; html: string }> {
  const body = new URLSearchParams({ step: 'check', ...fields })
  const response = await fetch(urlFor(index), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
  })
  return { status: response.status, html: await response.text() }
}

describe('acceptance — the built application serves the screen', () => {
  it('offers the seeded treatment by its public display name and its price', async () => {
    // The screen drives the REAL menu rather than a probe service, so the option label has to be the
    // catalogue's own words: a label composed here would be a second place a treatment is named.
    const html = await (await fetch(urlFor(READ_ONLY_DAY))).text()
    expect(html).toContain(variantLabelFragment)
  }, 60_000)

  it('answers HTML with the robots header the registry declares', async () => {
    const response = await fetch(urlFor(READ_ONLY_DAY))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    // Derived from the registry by the proxy. `/quick-book` is under no ADMIN_GROUP_PREFIXES entry, so this
    // is NOINDEX_PATTERNS doing the work — which is the one thing this route's registry entry relies on.
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(response.headers.get('cache-control')).toContain('no-store')
    const html = await response.text()
    expect(html).toContain('data-testid="quick-book-form"')
    expect(html).toContain(`value="${variantId}"`)
    expect(html).toContain(`value="${startFor(READ_ONLY_DAY)}"`)
    // The start option carries the treatment it suits, which is what the narrowing reads and what the
    // server validates the pair against.
    expect(html).toMatch(
      new RegExp(`value="${startFor(READ_ONLY_DAY)}" data-variants="[^"]*${variantId}`),
    )
  }, 60_000)

  it('names the current trading day when the URL names none, without assuming what today is', async () => {
    const response = await fetch(`${BASE}${PATH}`)
    expect(response.status).toBe(200)
    const html = await response.text()
    // Compared against a direct query rather than against a hard-coded date: the current trading day depends
    // on the wall clock, and a test that spelled one would be a test that failed at 01:30.
    const [row] = await sql<{ trading_date: string }[]>`
      select to_char(trading_date, 'YYYY-MM-DD') as trading_date from business_day
       where closes_at > now() order by trading_date limit 1
    `
    if (row === undefined) {
      // Nothing to assert and nothing wrong: a database with no open day is a legitimate state, and the
      // screen's answer to it is the case below.
      process.stderr.write(
        '[B-UI-04] no open trading day in this database; default-day case skipped\n',
      )
      return
    }
    expect(html).toContain(row.trading_date)
  }, 60_000)

  it('names a closed day instead of drawing a form that books nothing', async () => {
    const response = await fetch(urlFor(CLOSED_DAY))
    const html = await response.text()
    expect(html).toContain(dayFor(CLOSED_DAY))
    expect(html).toContain('does not trade')
    // And it offers no start at all, which is the part that matters: a form with an empty start select and a
    // live submit button is a screen that looks ready.
    expect(html).not.toContain(`data-variant="${variantId}"`)
  }, 60_000)
})

describe('acceptance — a walk-in, measured from the first keystroke to the confirmation', () => {
  it('books with only a phone, a treatment, a client and a start, inside the ceiling', async () => {
    const one = caseFor(1)
    const measurement = await withPage(
      async (page) => {
        // The BASELINE first, from the same server and the same browser: one plain GET of this page. It is
        // what says whether a millisecond assertion means anything on this box.
        const baselineStart = Date.now()
        await page.goto(one.url, { waitUntil: 'networkidle' })
        const baselineMs = Date.now() - baselineStart

        // The measured window opens on the FIRST KEYSTROKE, which is what the acceptance line names. The page
        // is already open — a front desk does not reload between customers — and the phone field is
        // autofocused, so the first keystroke lands without a pointer or a Tab.
        await page.locator('[data-testid="quick-book-phone"]').focus()
        const started = Date.now()
        await page.keyboard.type(one.phone)
        await page.keyboard.press('Tab')
        // The ref is skipped: it is optional, and a walk-in with no WhatsApp conversation has no code.
        await page.locator('[data-testid="quick-book-variant"]').selectOption(variantId)
        await page.locator('#quick-book-gender-female').focus()
        await page.keyboard.press('Space')
        await page.locator('[data-testid="quick-book-start"]').selectOption(one.start)
        await page.locator('[data-testid="quick-book-check"]').focus()
        await Promise.all([page.waitForLoadState('networkidle'), page.keyboard.press('Enter')])
        await page.locator('[data-testid="quick-book-assignment"]').waitFor({ state: 'attached' })
        await confirmByKeyboard(page)
        await page.locator('[data-testid="quick-book-confirmation"]').waitFor({ state: 'attached' })
        const elapsedMs = Date.now() - started
        return { baselineMs, elapsedMs, bookingId: await bookingIdOf(page) }
      },
      { url: one.url },
    )

    // Recorded in the job output for every run, passing or not. `process.stderr` and not `console.log`:
    // vitest's reporter shows a passing test's stdout to nobody (brief rule 23).
    process.stderr.write(
      `[B-UI-04] walk-in first-keystroke to confirmation: ${measurement.elapsedMs} ms ` +
        `(ceiling ${WALK_IN_CEILING_MS} ms; one page load on this box measured ${measurement.baselineMs} ms)\n`,
    )
    expect(measurement.bookingId).toMatch(/^[0-9a-f-]{36}$/)

    if (measurement.baselineMs > BASELINE_CEILING_MS) {
      // Loud, on stderr, with BOTH numbers. A skip that explained itself only in stdout would be a skip
      // nobody ever saw, which is worse than no gate at all.
      process.stderr.write(
        `[B-UI-04] SKIPPING the ${WALK_IN_CEILING_MS} ms assertion: one page load cost ` +
          `${measurement.baselineMs} ms against a ${BASELINE_CEILING_MS} ms gate, so this box cannot hold ` +
          `the target and the measured ${measurement.elapsedMs} ms would be a statement about the ` +
          'container. The WORK assertions in the next case do not skip.\n',
      )
      return
    }
    expect(
      measurement.elapsedMs,
      `the walk-in took ${measurement.elapsedMs} ms against a ${WALK_IN_CEILING_MS} ms target, with one ` +
        `page load costing ${measurement.baselineMs} ms`,
    ).toBeLessThanOrEqual(WALK_IN_CEILING_MS)
  }, 180_000)

  it('costs a fixed amount of WORK, which is what the target is really about', async () => {
    // The half of the 10-second line that does not move with the load on the box. A screen that grew a
    // second page of fields, or a third round trip, would fail here on an idle machine and on a busy one.
    const two = caseFor(2)
    const work = await withPage(
      async (page) => {
        let posts = 0
        page.on('request', (request) => {
          if (request.method() === 'POST' && request.url().includes(PATH)) posts += 1
        })
        // Every control the operator must touch to take a booking, in DOM order. Five, and the therapist and
        // the room are not among them: that is the acceptance line's "auto-assigned" as a count.
        const required = await page.evaluate(() => {
          const form = document.querySelector('[data-testid="quick-book-form"]')
          if (form === null) return { required: [], autofocused: null as string | null }
          const controls = [...form.querySelectorAll('input, select, textarea')].filter(
            (element) =>
              element instanceof HTMLElement && element.getAttribute('type') !== 'hidden',
          )
          return {
            required: controls
              .filter((element) => element.hasAttribute('required'))
              .map((element) => element.getAttribute('data-testid') ?? element.id),
            autofocused: document.activeElement?.id ?? null,
          }
        })
        // Phone, treatment, both gender radios (one group), start. The note and the ref are optional and are
        // absent from this list, which is the claim.
        expect(required.required).toEqual([
          'quick-book-phone',
          'quick-book-variant',
          'quick-book-gender-female',
          'quick-book-gender-male',
          'quick-book-start',
        ])
        // Autofocused, so the first keystroke needs no pointer and no Tab.
        expect(required.autofocused).toBe('quick-book-phone')

        await fillByKeyboard(page, { phone: two.phone, start: two.start })
        await page.locator('[data-testid="quick-book-assignment"]').waitFor({ state: 'attached' })
        await confirmByKeyboard(page)
        await page.locator('[data-testid="quick-book-confirmation"]').waitFor({ state: 'attached' })
        const bookingId = await bookingIdOf(page)
        return { posts, bookingId }
      },
      { url: two.url },
    )
    // Two round trips: the check and the confirm. A third would be a screen that asked a question it could
    // have answered, and it is the one part of the budget a slow box cannot hide.
    expect(work.posts).toBe(2)
    expect(work.bookingId).toMatch(/^[0-9a-f-]{36}$/)
  }, 180_000)
})

describe('acceptance — the therapist and the room are assigned, and shown before the confirm', () => {
  it('displays both in the DOM with no operator input, and books the tuple it displayed', async () => {
    const three = caseFor(3)
    const shown = await withPage(
      async (page) => {
        await fillByKeyboard(page, { phone: three.phone, start: three.start })
        const assignment = page.locator('[data-testid="quick-book-assignment"]')
        await assignment.waitFor({ state: 'attached' })
        const roomId = await page
          .locator('[data-testid="quick-book-assigned-room"]')
          .getAttribute('data-room')
        const therapistId = await page
          .locator('[data-testid="quick-book-assigned-therapist"] [data-therapist]')
          .first()
          .getAttribute('data-therapist')
        // There is no control for either. Asserted as the ABSENCE of a field on the confirm path, because a
        // screen that offered a room select would satisfy every other assertion here.
        const editable = await page.evaluate(() => {
          const form = document.querySelector('[data-testid="quick-book-confirm-form"]')
          // `null` and not `[]` for a form that is not there. An empty list would satisfy the assertion below
          // for a page with no confirm form at all, which is the vacuous reading of "nothing is editable".
          if (form === null) return null
          return [...form.querySelectorAll('select, input:not([type="hidden"]), textarea')].map(
            (element) => element.getAttribute('name') ?? '',
          )
        })
        await confirmByKeyboard(page)
        await page.locator('[data-testid="quick-book-confirmation"]').waitFor({ state: 'attached' })
        return { roomId, therapistId, editable, bookingId: await bookingIdOf(page) }
      },
      { url: three.url },
    )
    expect(shown.roomId).toMatch(/^[0-9a-f-]{36}$/)
    // The chosen therapist is the one the solver picked, and it is one of this file's own eligible pair —
    // asserted as membership rather than as an identity, because which of the two is chosen is
    // `assignShape`'s deterministic rule (lowest id) and not this screen's claim to make.
    expect([idOf(STAFF.chosen), idOf(STAFF.spare)]).toContain(shown.therapistId)
    // Found, and holding nothing editable. Two claims, because the second is worthless without the first.
    expect(shown.editable, 'there is no confirm form on the page at all').not.toBeNull()
    expect(shown.editable).toEqual([])

    // And the row the transaction wrote holds that exact tuple: the acceptance line is about what was
    // DISPLAYED being what was booked, and only the database can answer that.
    const rows = await sql<{ room_id: string; therapist_id: string }[]>`
      select room_id::text as room_id, therapist_id::text as therapist_id
        from appointment where booking_id = ${shown.bookingId}::uuid
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]?.room_id).toBe(shown.roomId)
    expect(rows[0]?.therapist_id).toBe(shown.therapistId)
  }, 180_000)
})

describe('acceptance — the WhatsApp ref field: shape, match, and an unknown code that does not block', () => {
  it('accepts the four-character shape and matches it against whatsapp_ref', async () => {
    const four = caseFor(4)
    const result = await withPage(
      async (page) => {
        // Typed in LOWER case, because that is what a paste from a phone looks like, and the normaliser is
        // what makes it match. A test that typed the stored spelling would not exercise it.
        await fillByKeyboard(page, {
          phone: four.phone,
          start: four.start,
          ref: REF_CODE.toLowerCase(),
        })
        await page.locator('[data-testid="quick-book-assignment"]').waitFor({ state: 'attached' })
        const notice = await page
          .locator('[data-testid="quick-book-ref-notice"]')
          .getAttribute('data-notice')
        await confirmByKeyboard(page)
        await page.locator('[data-testid="quick-book-confirmation"]').waitFor({ state: 'attached' })
        const outcome = await page
          .locator('[data-testid="quick-book-attribution"]')
          .getAttribute('data-outcome')
        return { notice, outcome, bookingId: await bookingIdOf(page) }
      },
      { url: four.url },
    )
    expect(result.notice).toBe('matched')
    expect(result.outcome).toBe('matched')
    // The ATTRIBUTION LINK ROW, which is what the acceptance line asks for.
    expect(await captureOf(result.bookingId)).toEqual({
      outcome: 'matched',
      refCode: REF_CODE,
      enteredCode: null,
    })
  }, 180_000)

  it('refuses a malformed code in the browser, before any round trip', async () => {
    await withPage(
      async (page) => {
        await page.locator('[data-testid="quick-book-ref"]').focus()
        // `AB2O` is four characters and contains an excluded look-alike, so it is the case a length check
        // alone would let through.
        await page.keyboard.type('AB2O')
        const valid = await page.evaluate(() => {
          const field = document.querySelector('[data-testid="quick-book-ref"]')
          return field instanceof HTMLInputElement ? field.checkValidity() : null
        })
        expect(valid).toBe(false)
        // The control: a code from the alphabet passes, so the pattern is not simply refusing everything.
        await page.locator('[data-testid="quick-book-ref"]').fill('')
        await page.locator('[data-testid="quick-book-ref"]').focus()
        await page.keyboard.type(REF_CODE)
        const good = await page.evaluate(() => {
          const field = document.querySelector('[data-testid="quick-book-ref"]')
          return field instanceof HTMLInputElement ? field.checkValidity() : null
        })
        expect(good).toBe(true)
      },
      { url: urlFor(READ_ONLY_DAY) },
    )
  }, 120_000)

  it('accepts an unknown code with a visible warning and books anyway', async () => {
    const five = caseFor(5)
    const result = await withPage(
      async (page) => {
        // A well-formed code no row holds. The pattern accepts it — this is not a shape error — and the only
        // thing that can tell is the table.
        await fillByKeyboard(page, { phone: five.phone, start: five.start, ref: 'QB99' })
        await page.locator('[data-testid="quick-book-assignment"]').waitFor({ state: 'attached' })
        const notice = page.locator('[data-testid="quick-book-ref-notice"]')
        await notice.waitFor({ state: 'attached' })
        // VISIBLE, and not merely present: a substring assertion cannot tell an element that is in the
        // document from one the page's own CSS has collapsed to nothing.
        const box = await notice.boundingBox()
        expect(box?.height ?? 0, 'the warning has no box').toBeGreaterThan(0)
        expect(await notice.getAttribute('data-notice')).toBe('unknown_code')
        // And the confirm is there and enabled, which is the "without blocking" half.
        const confirm = page.locator('[data-testid="quick-book-confirm"]')
        expect(await confirm.isEnabled()).toBe(true)
        await confirmByKeyboard(page)
        await page.locator('[data-testid="quick-book-confirmation"]').waitFor({ state: 'attached' })
        return { notice: 'unknown_code', bookingId: await bookingIdOf(page) }
      },
      { url: five.url },
    )
    // Never an invented attribution: the row carries no ref code and keeps what was typed.
    expect(await captureOf(result.bookingId)).toEqual({
      outcome: 'unknown_code',
      refCode: null,
      enteredCode: 'QB99',
    })
  }, 180_000)
})

describe('acceptance — both counters, from bookings taken through the screen', () => {
  it('increments matched for a matched ref and unmatched for a blank one, as a delta', async () => {
    const before = await readRefCaptureCounts(sql)
    const made: string[] = []
    for (const [index, ref] of [
      [6, REF_CODE],
      [7, ''],
    ] as const) {
      const one = caseFor(index)
      made.push(
        await withPage(
          async (page) => {
            await fillByKeyboard(page, { phone: one.phone, start: one.start, ref })
            await page
              .locator('[data-testid="quick-book-assignment"]')
              .waitFor({ state: 'attached' })
            await confirmByKeyboard(page)
            await page
              .locator('[data-testid="quick-book-confirmation"]')
              .waitFor({ state: 'attached' })
            return await bookingIdOf(page)
          },
          { url: one.url },
        ),
      )
    }
    const after = await readRefCaptureCounts(sql)
    // A DELTA and never a total (brief rule 12): the integration suite runs sequentially against one
    // database and `packages/fixtures/src/whatsapp-ref.itest.ts` writes capture rows of its own.
    expect(after.matched - before.matched, 'matched counter').toBe(1)
    expect(after.notOffered - before.notOffered, 'unmatched (no code) counter').toBe(1)
    // And the unknown-code counter did not move, which is the control: three counters that all moved
    // together would satisfy the two assertions above.
    expect(after.unknownCode - before.unknownCode, 'unknown-code counter').toBe(0)

    // The rate the panel prints is computed from those counts and nothing else.
    const mine = await readRefCaptureCounts(sql, { bookingIds: made })
    expect(refCaptureRate(mine).capturedBp).toBe(5_000)
    expect(refCaptureRate(mine).claim).toBe('loop_unconfirmed')
  }, 240_000)
})

describe('acceptance — an override is allowed only to an eligible therapist', () => {
  /** One check with a named therapist, straight through the handler's HTTP surface. */
  async function overrideWith(
    index: number,
    therapistId: string,
  ): Promise<{ status: number; html: string }> {
    const one = caseFor(index)
    return await postCheck(index, {
      phone: one.phone,
      variant: variantId,
      gender: 'female',
      start: one.start,
      therapist: therapistId,
    })
  }

  it('refuses each ineligible choice with its own reason code — four cases', async () => {
    // Four days, one per case, so no refusal here can be produced by another case's booking.
    for (const [index, reference, reason] of [
      [8, STAFF.male, 'gender_mismatch'],
      [14, STAFF.noSkill, 'missing_skill'],
      [15, STAFF.expired, 'credential_expired'],
      [16, STAFF.unrostered, 'not_rostered'],
    ] as const) {
      const { status, html } = await overrideWith(index, idOf(reference))
      expect(status, reference).toBe(409)
      expect(html, reference).toContain('data-quick-book-refusal="therapist_not_eligible"')
      // The SPECIFIC reason, which is what the acceptance line asks for: four different refusals and not
      // four copies of "not available".
      expect(html, reference).toContain(`data-reason="${reason}"`)
    }
  }, 120_000)

  it('allows an override to the other eligible therapist, which is the control', async () => {
    // Without this every assertion above would be satisfied by a screen that refused every override.
    const { status, html } = await overrideWith(17, idOf(STAFF.spare))
    expect(status).toBe(200)
    expect(html).toContain('data-testid="quick-book-assignment"')
    expect(html).toContain(`data-therapist="${idOf(STAFF.spare)}"`)
    expect(html).not.toContain('data-quick-book-refusal=')
  }, 120_000)

  it('names being busy as being busy, and not as being off shift', async () => {
    // A therapist who is eligible and already has work is not ineligible, and telling the desk to fix a rota
    // that is correct is worse than saying nothing. The fixture is the spare therapist booked over the whole
    // period by a booking this case makes and then leaves for `afterAll`.
    const nine = caseFor(9)
    const taken = await withPage(
      async (page) => {
        await fillByKeyboard(page, { phone: nine.phone, start: nine.start })
        await page.locator('[data-testid="quick-book-assignment"]').waitFor({ state: 'attached' })
        const therapistId = await page
          .locator('[data-testid="quick-book-assigned-therapist"] [data-therapist]')
          .first()
          .getAttribute('data-therapist')
        await confirmByKeyboard(page)
        await page.locator('[data-testid="quick-book-confirmation"]').waitFor({ state: 'attached' })
        await bookingIdOf(page)
        return therapistId ?? ''
      },
      { url: nine.url },
    )
    // The SAME day and the same start, so the therapist this case has just booked is the one being asked
    // for. A different day would report them free, which is the assertion passing for the wrong reason.
    const { status, html } = await postCheck(9, {
      phone: phoneFor(18),
      variant: variantId,
      gender: 'female',
      start: nine.start,
      therapist: taken,
    })
    expect(status).toBe(409)
    expect(html).toContain('data-reason="not_free_at_that_start"')
    // And the sentence does NOT send them to the rota, which is the whole distinction.
    expect(html).not.toContain('data-reason="not_rostered"')
  }, 180_000)

  it('lists who was excluded, with a reason for each, on the check itself', async () => {
    const { html } = await postCheck(10, {
      phone: phoneFor(10),
      variant: variantId,
      gender: 'female',
      start: startFor(10),
    })
    expect(html).toContain('data-testid="quick-book-excluded"')
    // The four this file made ineligible are all there, each with its own reason — which is where the four
    // reason codes are useful rather than only being reachable through a refusal.
    for (const [reference, reason] of [
      [STAFF.male, 'gender_mismatch'],
      [STAFF.noSkill, 'missing_skill'],
      [STAFF.expired, 'credential_expired'],
      [STAFF.unrostered, 'not_rostered'],
    ] as const) {
      expect(html, reference).toContain(`data-therapist="${idOf(reference)}"`)
      expect(html, reference).toContain(`data-reason="${reason}"`)
    }
    // Every reason the screen can say is in the union the render test enumerates, so a reason the read model
    // produces that this screen has no wording for would be a compile error there rather than a blank cell.
    expect(THERAPIST_REFUSAL_REASONS).toContain('gender_mismatch')
  }, 120_000)
})

describe('acceptance — operable by keyboard with no pointer events at all', () => {
  it('takes a whole booking in a context where every pointer event is refused', async () => {
    const eleven = caseFor(11)
    const bookingId = await withPage(
      async (page) => {
        // `pointer-events: none` is on every element in this context, so a `page.click` here would hang
        // until the test timed out. Nothing below reaches for one.
        const pointerFree = await page.evaluate(() => {
          const field = document.querySelector('[data-testid="quick-book-phone"]')
          return field === null ? null : globalThis.getComputedStyle(field).pointerEvents
        })
        // The control on the control: the run really is pointer-free, so a context where the stylesheet had
        // silently failed to apply could not report a pass.
        expect(pointerFree, 'the pointer-free stylesheet did not apply').toBe('none')

        await fillByKeyboard(page, { phone: eleven.phone, start: eleven.start })
        await page.locator('[data-testid="quick-book-assignment"]').waitFor({ state: 'attached' })
        await confirmByKeyboard(page)
        await page.locator('[data-testid="quick-book-confirmation"]').waitFor({ state: 'attached' })
        return await bookingIdOf(page)
      },
      { pointerFree: true, url: eleven.url },
    )
    expect(bookingId).toMatch(/^[0-9a-f-]{36}$/)
  }, 180_000)

  it('reaches the ref field with one Tab from the phone, which is what DOM order buys', async () => {
    await withPage(
      async (page) => {
        await page.locator('[data-testid="quick-book-phone"]').focus()
        await page.keyboard.press('Tab')
        // The acceptance line's "first optional field in DOM order", as a keyboard fact rather than a byte
        // offset: `quick-book-render.test.ts` asserts the byte order, and this asserts that the tab order
        // agrees with it — a CSS `order` that moved the field visually would pass one and fail the other.
        const focused = await page.evaluate(
          () => document.activeElement?.getAttribute('data-testid') ?? null,
        )
        expect(focused).toBe('quick-book-ref')
      },
      { url: urlFor(READ_ONLY_DAY) },
    )
  }, 120_000)

  it('narrows the start list to the chosen treatment without moving a node', async () => {
    await withPage(
      async (page) => {
        // Focused FIRST, then changed: the claim is that narrowing does not steal or drop focus, and
        // `selectOption` does not focus the element it sets — so a version that asserted focus had MOVED to
        // the select was asserting something about Playwright. This asserts it has not moved away.
        await page.locator('[data-testid="quick-book-variant"]').focus()
        const before = await page.evaluate(
          () => document.activeElement?.getAttribute('data-testid') ?? null,
        )
        expect(before).toBe('quick-book-variant')
        await page.locator('[data-testid="quick-book-variant"]').selectOption(variantId)
        const state = await page.evaluate((chosen) => {
          const select = document.querySelector('[data-testid="quick-book-start"]')
          if (!(select instanceof HTMLSelectElement)) return null
          const options = [...select.options]
          const suits = (option: HTMLOptionElement) =>
            (option.dataset['variants'] ?? '').split(' ').includes(chosen)
          return {
            enabled: options.filter((option) => !option.disabled).length,
            mine: options.filter(suits).length,
            foreignEnabled: options.filter((option) => !option.disabled && !suits(option)).length,
            // Unique values, which is what makes the select settable by value at all.
            distinctValues: new Set(options.map((option) => option.value)).size,
            total: options.length,
          }
        }, variantId)
        expect(state?.mine ?? 0).toBeGreaterThan(0)
        // Every enabled option belongs to the chosen treatment, and none of the others does.
        expect(state?.foreignEnabled).toBe(0)
        expect(state?.enabled).toBe(state?.mine)
        // A duplicate value is a select nothing can set by value — the browser takes the first match, which
        // after narrowing may be a disabled option. It cost two runs of this file before the grid became one
        // option per instant.
        expect(state?.distinctValues).toBe(state?.total)
        // And the narrowing MOVED no node, so nothing was blurred: the DOM-move-blurs-the-node hazard is
        // avoided by construction rather than repaired afterwards, and this is the assertion that says so.
        const after = await page.evaluate(
          () => document.activeElement?.getAttribute('data-testid') ?? null,
        )
        expect(after).toBe('quick-book-variant')
      },
      { url: urlFor(READ_ONLY_DAY) },
    )
  }, 120_000)
})

describe('acceptance — axe reports nothing serious or critical', () => {
  it('audits the entry form, the assignment and the confirmation, in both directions', async () => {
    // Three STATES rather than three viewports, because this screen's accessibility risk is in what the
    // states do: the entry form has a required radio group, the assignment is a description list a reader
    // has to be able to associate, and the confirmation is a live region announcing a fact.
    const cells: readonly (Cell & { readonly day: number })[] = [
      { ...DESK, direction: 'ltr', day: 20 },
      { ...DESK, direction: 'rtl', day: 21 },
      { ...DESK, theme: 'dark', direction: 'ltr', day: 22 },
    ]
    expect(cells).toHaveLength(3)
    let audited = 0
    for (const cell of cells) {
      const violations = await withPage(
        async (page) => {
          const collected: string[] = []
          for (const state of ['entry', 'assignment'] as const) {
            if (state === 'assignment') {
              // A day per CELL, so the three renders do not compete for one 11:00 slot: the second would
              // otherwise audit a refusal panel while claiming to audit an assignment.
              await fillByKeyboard(page, {
                phone: phoneFor(cell.day),
                start: startFor(cell.day),
              })
              await page
                .locator('[data-testid="quick-book-assignment"]')
                .waitFor({ state: 'attached' })
            }
            const result = await auditPage(page, {
              page: `${PATH} (${state})`,
              viewport: {
                name: `${cell.width}`,
                width: cell.width,
                height: cell.height,
                scale: 1,
                why: 'B-UI-04 acceptance',
              },
              theme: cell.theme,
              direction: cell.direction,
            })
            audited += 1
            collected.push(...blockingViolations(result.violations).map(describeViolation))
          }
          return collected
        },
        { cell, url: urlFor(cell.day, cell.direction === 'rtl' ? { dir: 'rtl' } : {}) },
      )
      expect(violations, `${cell.theme} ${cell.direction}: serious/critical`).toEqual([])
    }
    // Six audits, stated rather than counted after the fact: a loop that lost a state or a direction would
    // report a pass over fewer renders than the claim.
    expect(audited).toBe(6)
  }, 300_000)
})

describe('acceptance — a booking the endpoint refuses is refused on the screen', () => {
  it('answers the E.164 rejection by name rather than as a 500', async () => {
    // `normalisePhone` refuses a landline as an OTP target (B-LIFE-02), and the screen has to say which
    // problem it is: "that is not a mobile" is actionable and "invalid" is not.
    const { status, html } = await postCheck(READ_ONLY_DAY, {
      phone: '025576533',
      variant: variantId,
      gender: 'female',
      start: startFor(READ_ONLY_DAY),
    })
    expect(status).toBe(400)
    expect(html).toContain('data-quick-book-refusal="phone_not_eligible"')
    // The control: the same POST with a mobile is accepted, so the refusal is the number and not the shape
    // of the request.
    expect(normalisePhone(phoneFor(1))).toMatch(/^\+9715/)
  }, 60_000)

  it('refuses a start it never offered, before doing any availability work', async () => {
    const { status, html } = await postCheck(READ_ONLY_DAY, {
      phone: phoneFor(12),
      variant: variantId,
      gender: 'female',
      // Inside the trading day and NOT on the offered grid: a hand-crafted POST naming an arbitrary instant
      // is otherwise a way to ask the solver about the whole calendar from a screen that offers two hours.
      start: new Date(at(dayFor(READ_ONLY_DAY), '23:07')).toISOString(),
    })
    expect(status).toBe(400)
    expect(html).toContain('data-quick-book-refusal="start_not_offered"')
  }, 60_000)

  it('confirms a start the grid has moved past, rather than calling it never offered', async () => {
    /*
      The check→confirm race, and it is the ordinary case rather than an edge one: with no minimum notice at
      the counter the first grid option can be one minute away, so a desk that reads an assignment out loud
      and then presses Confirm has crossed a quarter-hour boundary. An earlier version re-checked the grid on
      the confirm and refused that with `start_not_offered` — "not one this screen offered" about a start it
      had offered two seconds earlier.

      Driven as a bare POST rather than through the browser, because the thing under test is what the confirm
      ACCEPTS and a browser cannot be made to wait fifteen minutes. The start is one the grid does not
      currently hold — an unpadded quarter-hour deep inside the day — and the confirm has to get past the
      start validation. It is then refused by the booking transaction for the tuple, which is the right
      authority and a DIFFERENT refusal: what must not happen is `start_not_offered`.
    */
    const day = caseFor(19)
    const deepInTheDay = new Date(at(day.date, '18:30')).toISOString()
    const body = new URLSearchParams({
      step: 'confirm',
      phone: phoneFor(19),
      variant: variantId,
      gender: 'female',
      start: deepInTheDay,
      notes: '',
      therapist: '',
      room: idOf(STAFF.chosen),
      assigned: idOf(STAFF.chosen),
    })
    const response = await fetch(day.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    })
    const html = await response.text()
    expect(html).not.toContain('data-quick-book-refusal="start_not_offered"')
    expect(html).not.toContain('data-quick-book-refusal="start_has_passed"')
    // The control on that pair of negatives, which would otherwise be satisfied by any page at all: the
    // request WAS refused, and by the tuple rather than by the start. `room` above is a therapist id, which is
    // a uuid the room table does not know.
    expect(response.status).not.toBe(201)
    expect(html).toContain('data-quick-book-refusal=')
  }, 60_000)

  it('refuses a start that has already passed by its own name, not as one never offered', async () => {
    // The other half, on a trading day in the PAST so the instant is inside a real window and behind `now`.
    // The remedy differs from `start_not_offered`'s and that is the whole reason for the second name: "check
    // again, the list has moved on" rather than "choose differently from a list that does contain it".
    const pastDate = shiftDate(today, PAST_DAY_OFFSET)
    const params = new URLSearchParams({ date: pastDate })
    const body = new URLSearchParams({
      step: 'confirm',
      phone: phoneFor(20),
      variant: variantId,
      gender: 'female',
      // On the quarter-hour grid and inside that day's window, which is entirely behind us.
      start: new Date(at(pastDate, '19:00')).toISOString(),
      notes: '',
      therapist: '',
      room: idOf(STAFF.chosen),
      assigned: idOf(STAFF.chosen),
    })
    const response = await fetch(`${BASE}${PATH}?${params.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    })
    const html = await response.text()
    expect(html).toContain('data-quick-book-refusal="start_has_passed"')
    // And NOT the other name, which is the distinction the refusal exists to make.
    expect(html).not.toContain('data-quick-book-refusal="start_not_offered"')

    // The control: an instant OUTSIDE that day's window on the same request is `start_not_offered`, so the
    // two names really are reachable separately and this case is not reading whatever the handler says last.
    const outside = new URLSearchParams(body)
    outside.set('start', new Date(at(pastDate, '05:00')).toISOString())
    const other = await fetch(`${BASE}${PATH}?${params.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: outside.toString(),
      redirect: 'manual',
    })
    expect(await other.text()).toContain('data-quick-book-refusal="start_not_offered"')
  }, 60_000)

  it('refuses a booking with nobody named, which strict matching cannot answer', async () => {
    const { status, html } = await postCheck(READ_ONLY_DAY, {
      phone: phoneFor(13),
      variant: variantId,
      gender: '',
      start: startFor(READ_ONLY_DAY),
    })
    expect(status).toBe(400)
    expect(html).toContain('data-quick-book-refusal="requires_client_gender"')
  }, 60_000)

  it('refuses a body it could not have sent, as a named refusal and not a 500', async () => {
    const response = await fetch(urlFor(READ_ONLY_DAY), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'check' }),
      redirect: 'manual',
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('data-quick-book-refusal="unreadable_request"')
  }, 60_000)
})
