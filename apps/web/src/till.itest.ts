import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createConnection, readTillIssuer, type Sql } from '@berelax/db'
import { FIXTURE_ISSUER } from '@berelax/fixtures'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import {
  captureUntilStable,
  DETERMINISM_CSS,
  DETERMINISTIC_LAUNCH_ARGS,
} from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseIssuer, handleTillWrite } from '../app/(admin)/till/handler.ts'
import { TILL_FIELDS } from '../app/(admin)/till/view.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * M-TILL-13 — the till, the invoice preview, the cash-up and the package screen in a real browser, against the
 * BUILT application and a real PostgreSQL, plus the M2 Bankable walkthrough.
 *
 * The claims here are the ones no substring assertion can make: an interaction count is real key presses into
 * real forms waiting on real POSTs, "no pointer events used" is a document that records every one it receives,
 * "genuinely mirrored" is a `getBoundingClientRect` on two elements in two directions, the palette rule is the
 * COMPUTED background of every text node, and axe and the screenshot matrix both need a rendered DOM. The rows
 * — the postings, the drawdown, the document — are `packages/fixtures/src/till-receipt.itest.ts`'s and
 * `package-seed.ts`'s, and the document's bytes for a given view are `till-render.test.ts`'s.
 *
 * The band `till` in `@berelax/harness/ports` is this file's (brief rules 18 and 19).
 *
 * ## The M2 Bankable slice, and the wall it hits
 *
 * The acceptance line asks for one walk from a completed appointment to an issued invoice to a cash payment to
 * a balanced journal to the amount in the VAT201 box 1 drill-down. **The middle of that walk is blocked by a
 * fact about the business and not by any code**: `legal_entity.trn` holds `TRN-PENDING-Y1-TRN`, both invoice
 * forms state the supplier TRN, and `payment` may name only an `invoice_id` or a `package_sale_id` — so no
 * treatment can be paid for until the TRN is entered. This file therefore walks the slice in three parts, and
 * says which part is which:
 *
 *   1. **In the browser, against the real business profile** — a seeded completed appointment is pulled
 *      through, priced with a gratuity and a discount that says why, split across two tenders, previewed with
 *      every mandatory field enumerated and the TRN marked ABSENT, and then REFUSED by name, with a delta of
 *      zero over `invoice`, `journal_entry` and `payment`. That refusal is the deliverable.
 *   2. **Through the served bytes, against a configured issuer** — the same handler, driven with an issuer
 *      reader that returns `FIXTURE_ISSUER` (a fifteen-digit TRN that reaches nothing but a fixture, which is
 *      `packages/pdf`'s own arrangement). The document is issued, the cash is recorded, the entry balances,
 *      and the output VAT lands on an account whose `account.vat_box` is `standard_rated_supplies` — which is
 *      what a VAT201 box 1 sums. The drill-down is walked as box → account → journal line → document.
 *      Injecting the reader is not a way round the rule: whatever it returns still goes through
 *      `requireIssuerSnapshot`, so a caller may supply a VALID TRN and cannot supply a placeholder.
 *   3. **In the browser, all the way through** — a PACKAGE sale, which issues no document, so it is the one
 *      money path the till can complete today. Cash is taken, the entry balances, and the redemption that
 *      follows puts output VAT on 2030 — which is where box 1's package figure comes from under
 *      Y11-vat-package's provisional answer.
 *
 * The numbered box and the working papers are M-VAT-07's, which is `todo`. What exists today is
 * `account.vat_box`, the grouping box 1 will read, and that is what part 2 asserts against.
 */

const MARKER = 'mtill13 till itest'
const TILL_PATH = '/till'
const PREVIEW_PATH = '/till?view=preview'
const CASH_UP_PATH = '/till/cash-up'
const PACKAGES_PATH = '/packages'
const SCREENS = new URL('../../../artifacts/screens/M-TILL-13', import.meta.url).pathname

/**
 * The business day every case here works on, and it is the day in progress.
 *
 * The till defaults to the first `business_day` whose `closes_at` is still ahead of `now`, which is what a
 * front desk needs. A pinned date would be the safer thing to test and the wrong thing: the screens' whole
 * subject is the business day, and a case that named one would not notice the resolver breaking. So the day is
 * READ from the database the same way the screen reads it, and every fixture row is dated on it.
 */
let tradingDate = ''

/**
 * The cash-up case's OWN business day, and it has to be its own.
 *
 * A closed `cash_session` refuses DELETE for every role (0076: "a counted drawer is evidence about a day that
 * happened"), and 0076's ZU006 then refuses any cash dated on that day — "take it on the open business day, or
 * correct the closed session with a cash_session_adjustment". So a cash-up case that counted the drawer for the
 * day in progress would make every later case in this file unable to take cash, and would make the NEXT run of
 * the file unable to take cash at all. Both happened before this constant existed, and the symptom was
 * "Unexpected." on a package sale.
 *
 * 2081 is unused, MEASURED rather than assumed: a grep for every year from 2080 to 2100 in `.ts`, `.mjs` and
 * `.sql` puts 0 occurrences in 2080, 2081 and 2082 and 30 in 2088, which was this constant's first value —
 * gate block 110's own note records 2088 as the journal's. `cash-up.itest.ts` uses 2089 and 2087,
 * `period-close.itest.ts` 2091, `package-redemption.itest.ts` 2085/2084/2083, gate 105 2086, gate 103 2093,
 * gate 98 2094, and five fixtures suites 2095-2099.
 */
const CASH_UP_DAY = '2081-03-14'

const PROBE = 'mtill13_till_probe'
const PROBE_ROOM = 'mtill13-till'
/** The customer this file's booking hangs off. A SEEDED one: an invented one would outlive the suite. */
const PROBE_PHONE = '+971590009102'
const THERAPIST_ONE = '33333333-4444-4555-8666-999999999921'
const PRICE_AT_BOOKING = 20_000

let sql: Sql
let server: WebServer
let browser: Browser
let BASE = ''
/**
 * Two probe appointments, both delivered on the day in progress.
 *
 * `[0]` is the one the checkout cases bill. `[1]` is the one the package redemption draws against, and it has
 * to be a SECOND row: part 2 of the M2 slice issues a document for `[0]`, so `readBillableAppointments` stops
 * offering it — one appointment would make part 3 fail with "nothing to redeem against" for a reason that has
 * nothing to do with packages.
 */
let appointmentIds: string[] = []
let customerId = ''

interface Cell {
  readonly width: number
  readonly height: number
  readonly theme: 'light' | 'dark'
  readonly direction: 'ltr' | 'rtl'
}

/** Three viewports x two themes x two directions. The phone, the front desk and the laptop. */
const CELLS: readonly Cell[] = (['light', 'dark'] as const).flatMap((theme) =>
  (['ltr', 'rtl'] as const).flatMap((direction) =>
    [
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1440, height: 900 },
    ].map((viewport) => ({ ...viewport, theme, direction })),
  ),
)

/** The four screens the acceptance names. `label` is the screenshot filename's stem. */
const SCREEN_PATHS = [
  { label: 'till', path: TILL_PATH },
  { label: 'preview', path: PREVIEW_PATH },
  { label: 'cash-up', path: CASH_UP_PATH },
  { label: 'packages', path: PACKAGES_PATH },
] as const

/** The three decorative surfaces docs/08 fences off from copy. The acceptance names all three. */
const FORBIDDEN_SURFACES = [
  '--color-surface-clay',
  '--color-decor-gold',
  '--color-decor-tan',
] as const

beforeAll(async () => {
  sql = createConnection({ url, max: 6 })

  // A previous run that died before its `afterAll` leaves appointments behind, and
  // `appointment_therapist_no_overlap` then refuses these inserts with a message about an exclusion constraint
  // rather than about the leftovers. Cleared first, by this file's own marker only.
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from rooms where notes = ${MARKER}`

  const [day] = await sql<{ trading_date: string }[]>`
    select to_char(trading_date, 'YYYY-MM-DD') as trading_date
      from business_day where closes_at > now() order by trading_date limit 1
  `
  if (day === undefined) {
    throw new Error(
      'No business_day is still open, so the till has no day to offer. Run `pnpm seed`: this file reads the ' +
        'day in progress rather than pinning one, because the business day is what these screens are about.',
    )
  }
  tradingDate = day.trading_date

  const [customer] = await sql<{ id: string }[]>`
    select id from customer where phone_e164 = ${PROBE_PHONE}
  `
  customerId = customer?.id as string

  // The cash-up case's own day. The trading calendar is a TABLE (0011), so it has to exist before a drawer can
  // be opened against it. 11:00-02:00 in Asia/Dubai, like every other day the premises trades.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${CASH_UP_DAY}, ${`${CASH_UP_DAY} 11:00:00+04`}::timestamptz,
            ${'2081-03-15 02:00:00+04'}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `

  const [room] = await sql<{ id: string }[]>`
    insert into rooms (code, name, room_type, capacity, display_order, notes)
    values (${PROBE_ROOM}, 'Till probe room', 'standard'::room_type, 1, 97, ${MARKER})
    on conflict (code) do update set capacity = excluded.capacity
    returning id
  `
  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes, display_order)
    values ('asian', ${PROBE}, 'mtill13-till-probe', 'Till probe massage',
            'Normal Massage (Asian)', 20, 97)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
    returning id
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${service?.id as string}, 60, ${PRICE_AT_BOOKING}, ${MARKER})
    on conflict (service_id, duration_minutes) do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${customerId}, 'front_desk', ${MARKER})
    returning id
  `
  // Net derived and VAT the remainder, which is what `appointment_price_split_exact` holds the row to. The
  // figures are spelled here because this file may not import `@berelax/core`'s splitGross into a query.
  const net = 19_048
  const vat = PRICE_AT_BOOKING - net
  appointmentIds = []
  for (const hour of [15, 17] as const) {
    const [appointment] = await sql<{ id: string }[]>`
      insert into appointment
        (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
         gross_price_fils, net_fils, vat_fils, vat_rate_bp, turnaround_minutes, therapist_buffer_minutes)
      values (${booking?.id as string}, ${tradingDate}, ${variant?.id as string}, 'solo'::service_shape,
              ${THERAPIST_ONE}, ${room?.id as string},
              ${`[${tradingDate} ${hour}:00:00+04,${tradingDate} ${hour}:59:00+04)`}::tstzrange,
              'completed'::appointment_status, ${PRICE_AT_BOOKING}, ${net}, ${vat}, 500, 20, 10)
      returning id
    `
    appointmentIds.push(appointment?.id as string)
  }

  server = await startWebServer({
    suite: 'till',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: TILL_PATH,
    readyWithinMs: 90_000,
    env: {
      // These routes call `loadConfig()`, so the two values they need are declared rather than assumed: CI
      // exports both, and a local run that exported only TEST_DATABASE_URL would get a 503 that reads like a
      // broken route.
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL: url,
    },
  })
  BASE = server.origin
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop()
  // The invoice family, as the OWNER: `invoice` refuses DELETE for every role (ZI003) so truncate is the only
  // legal removal, and it must happen before the booking goes because `invoice_appointment` is ON DELETE
  // RESTRICT against the appointment. Every referencing table is NAMED rather than reached with CASCADE, so
  // the next one to reference `invoice` fails loudly here.
  await sql?.unsafe(
    'truncate refund, checkout_finalisation, payment, invoice_appointment, invoice_line, invoice',
  )
  await sql?.unsafe(`update document_series set next_number = 1, period_key = ''`)
  /*
    The cash tables by TRUNCATE and not by DELETE, which is forced: a closed `cash_session` refuses DELETE for
    every role, so a counted drawer cannot be removed a row at a time. `cash-up.itest.ts` truncates the same
    three for the same reason. Without it this file's second run cannot take cash on its own cash-up day, and
    the failure arrives as a package sale refusing for a reason that names neither the drawer nor this file.
  */
  await sql?.unsafe('truncate cash_session_adjustment, cash_drop, cash_session')
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  await sql`delete from business_day where trading_date = ${CASH_UP_DAY}::date`
  await sql?.end({ timeout: 5 })
}, 120_000)

async function withCell<T>(cell: Cell, path: string, body: (page: Page) => Promise<T>): Promise<T> {
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
    const page = await context.newPage()
    // Every uncaught error the page's own script raises, collected and asserted on the way out. Without it a
    // broken listener is a TIMEOUT waiting for a data attribute, which names the assertion rather than the
    // cause.
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const separator = path.includes('?') ? '&' : '?'
    const query = `${separator}${TILL_FIELDS.day}=${tradingDate}${
      cell.direction === 'rtl' ? `&${TILL_FIELDS.direction}=rtl` : ''
    }`
    await page.goto(`${BASE}${path}${query}`, { waitUntil: 'networkidle' })
    await page.addStyleTag({ content: DETERMINISM_CSS })
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    const answer = await body(page)
    expect(pageErrors, `${path} raised`).toEqual([])
    return answer
  } finally {
    await context.close()
  }
}

/** One desk-width page for the interaction cases, which are not about the viewport. */
async function withDesk<T>(path: string, body: (page: Page) => Promise<T>): Promise<T> {
  return await withCell({ width: 1440, height: 900, theme: 'light', direction: 'ltr' }, path, body)
}

/**
 * Every text node whose effective background is one of the three decorative surfaces.
 *
 * Read off the COMPUTED style of a rendered DOM, which is the half a string scan of the stylesheet cannot make:
 * a colour arriving from `tokensCss()`, from the Google re-auth banner's stylesheet or from a user-agent
 * default is invisible to a scan of `TILL_CSS` and visible here. The three tokens are resolved from `:root`
 * first, so the comparison is against whatever the theme actually resolved them to rather than against a hex
 * literal this file would have to repeat.
 */
async function copyOnDecorativeSurfaces(page: Page): Promise<readonly string[]> {
  return await page.evaluate(
    (tokens) => {
      const root = getComputedStyle(document.documentElement)
      const normalise = (value: string): string => {
        const probe = document.createElement('span')
        probe.style.color = value.trim()
        document.body.append(probe)
        const resolved = getComputedStyle(probe).color
        probe.remove()
        return resolved
      }
      const forbidden = new Map(
        tokens.map((token) => [normalise(root.getPropertyValue(token)), token] as const),
      )
      const effective = (element: Element): string => {
        let current: Element | null = element
        while (current !== null) {
          const colour = getComputedStyle(current).backgroundColor
          const match = /rgba?\(([^)]+)\)/.exec(colour)
          const parts = (match?.[1] ?? '').split(/[\s,/]+/).filter((part) => part.length > 0)
          const alpha = parts[3] === undefined ? 1 : Number(parts[3])
          if (match !== null && alpha > 0.95) return colour
          current = current.parentElement
        }
        return ''
      }
      const offenders: string[] = []
      const selector =
        'p, li, td, th, dd, dt, h1, h2, h3, label, button, a, code, small, span, legend'
      for (const element of document.querySelectorAll(selector)) {
        if ((element.textContent ?? '').trim().length === 0) continue
        const token = forbidden.get(effective(element))
        if (token !== undefined) {
          offenders.push(`${element.tagName.toLowerCase()} on ${token}`)
        }
      }
      return offenders
    },
    FORBIDDEN_SURFACES as unknown as string[],
  )
}

/**
 * A money label with its NON-BREAKING space normalised to an ordinary one.
 *
 * `formatMoney` separates the currency from the figure with U+00A0, which is correct on a page and invisible in
 * a failure message: the first version of this file reported `expected 'AED 0.00' to be 'AED 0.00'`, which is
 * as unhelpful as an assertion gets.
 */
const label = (text: string | null): string => (text ?? '').replace(/\u00a0/g, ' ')

/**
 * The refusal sentence out of a served document, for a failure message that names the reason.
 *
 * Without it a status assertion prints the first 400 bytes of the page, which are the doctype and the token
 * stylesheet - the one part of a document that says nothing at all about what went wrong.
 */
const refusalIn = (html: string): string =>
  /data-testid="till-refusal"[^>]*>\s*<p>([^<]*)</.exec(html)?.[1] ?? '(no refusal panel)'

/** The totals the ledger holds right now, so every ledger claim is a DELTA (brief rules 9 and 12). */
async function ledgerTotals(): Promise<{ debit: number; credit: number }> {
  const [row] = await sql<{ debit: string; credit: string }[]>`
    select coalesce(sum(debit_fils), 0)::text as debit, coalesce(sum(credit_fils), 0)::text as credit
      from journal_line
  `
  return { debit: Number(row?.debit ?? '0'), credit: Number(row?.credit ?? '0') }
}

/** The appointment the checkout cases bill. */
const billedAppointmentId = (): string => appointmentIds[0] as string
/** The appointment the package redemption draws against. */
const redeemedAppointmentId = (): string => appointmentIds[1] as string

const countOf = async (table: 'invoice' | 'journal_entry' | 'payment'): Promise<number> => {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from ${sql(table)}`
  return Number(row?.n ?? '0')
}

describe('acceptance — the built application serves the four till surfaces', () => {
  it('answers HTML with the robots header the registry declares', async () => {
    for (const screen of SCREEN_PATHS) {
      const separator = screen.path.includes('?') ? '&' : '?'
      const response = await fetch(
        `${BASE}${screen.path}${separator}${TILL_FIELDS.day}=${tradingDate}`,
      )
      expect(response.status, screen.label).toBe(200)
      expect(response.headers.get('content-type'), screen.label).toContain('text/html')
      // Derived from the registry by the proxy: `/till` and `/packages` are prefixes in
      // ADMIN_GROUP_PREFIXES, so a screen added under either arrives noindex before it is written.
      expect(response.headers.get('x-robots-tag'), screen.label).toBe(
        'noindex, nofollow, noarchive',
      )
      expect(response.headers.get('cache-control'), screen.label).toContain('no-store')
      // The BYTES a reader receives, not what a render function returned.
      const html = await response.text()
      expect(html, screen.label).toContain(`data-till-screen="`)
      expect(html, screen.label).toContain('data-testid="till-nav-packages"')
    }
  }, 120_000)

  it('offers the seeded completed appointment on the till and nowhere else', async () => {
    const response = await fetch(`${BASE}${TILL_PATH}?${TILL_FIELDS.day}=${tradingDate}`)
    const html = await response.text()
    expect(html).toContain(`data-appointment="${billedAppointmentId()}"`)
    // And the control that the pull-through is a QUERY and not a coincidence: the same appointment is absent
    // from the cash-up screen, which reads no appointments at all.
    const cashUp = await fetch(`${BASE}${CASH_UP_PATH}?${TILL_FIELDS.day}=${tradingDate}`)
    expect(await cashUp.text()).not.toContain(`data-appointment="${billedAppointmentId()}"`)
  }, 60_000)
})

describe('acceptance — axe reports nothing serious or critical, in forty-eight renders', () => {
  it('audits four screens x 390/768/1440 x light/dark x ltr/rtl, each render the cell it claims', async () => {
    // Forty-eight, stated rather than counted after the fact: a matrix that lost an axis would report a pass
    // over twenty-four renders.
    expect(CELLS).toHaveLength(12)
    expect(SCREEN_PATHS).toHaveLength(4)
    const luminance: Record<string, number> = {}
    let audited = 0
    for (const screen of SCREEN_PATHS) {
      for (const cell of CELLS) {
        const where = `${screen.label} ${cell.theme} ${cell.direction} ${cell.width}px`
        const measured = await withCell(cell, screen.path, async (page) => {
          const result = await auditPage(page, {
            page: screen.path,
            viewport: {
              name: `${cell.width}`,
              width: cell.width,
              height: cell.height,
              scale: 1,
              why: 'M-TILL-13 acceptance',
            },
            theme: cell.theme,
            direction: cell.direction,
          })
          return {
            violations: result.violations,
            width: await page.evaluate(() => globalThis.innerWidth),
            dir: await page.evaluate(() => document.documentElement.getAttribute('dir')),
            lum: await page.evaluate(() => {
              const colour = globalThis.getComputedStyle(document.body).backgroundColor
              const [r = 0, g = 0, b = 0] = (colour.match(/\d+(\.\d+)?/g) ?? []).map(Number)
              return 0.2126 * r + 0.7152 * g + 0.0722 * b
            }),
            offenders: await copyOnDecorativeSurfaces(page),
          }
        })
        audited += 1
        expect(measured.width, `${where}: viewport`).toBe(cell.width)
        // The direction axis is real: the document really is mirrored. Without this, forty-eight identical LTR
        // renders would satisfy every assertion here and the filenames would be the only difference.
        expect(measured.dir, `${where}: dir`).toBe(cell.direction)
        luminance[where] = measured.lum
        const blocking = blockingViolations(measured.violations)
        expect(
          blocking.map(describeViolation),
          `${where}: ${blocking.length} serious/critical violation(s)`,
        ).toEqual([])
        // The palette acceptance line, over the CAPTURED DOM rather than over a stylesheet: no body text sits
        // on `--surface-clay`, `--decor-gold` or `--decor-tan` on any till screen, at any size, in either
        // theme, in either direction.
        expect(measured.offenders, `${where}: copy on a decorative surface`).toEqual([])
      }
    }
    expect(audited).toBe(48)
    // And the theme axis is real too: the dark cell resolved a darker ground at every width and direction.
    for (const screen of SCREEN_PATHS) {
      for (const width of [390, 768, 1440]) {
        for (const direction of ['ltr', 'rtl']) {
          expect(
            luminance[`${screen.label} dark ${direction} ${width}px`],
            `${screen.label} dark ${direction} ${width}px is darker than light`,
          ).toBeLessThan(luminance[`${screen.label} light ${direction} ${width}px`] ?? 0)
        }
      }
    }
  }, 900_000)

  it('the control: the two defects a known-bad till has are reported by rule id', async () => {
    // The control on the audit itself. A sweep that reported zero because axe never ran would pass the case
    // above for ever (ADR 0003), so the same page is audited again with an unlabelled button and body text on
    // the decorative gold — the two failures docs/08 fences off — injected into the DOM.
    const { violations, offenders } = await withDesk(TILL_PATH, async (page) => {
      await page.evaluate(() => {
        const button = document.createElement('button')
        button.type = 'button'
        document.body.append(button)
        const root = globalThis.getComputedStyle(document.documentElement)
        /*
          TWO paragraphs, because the two checks fail on different things and one paragraph cannot fail both.

          axe measures CONTRAST, so its known-bad is the decorative gold as TEXT on the sand surface — 2.90:1,
          the figure docs/08 fences it off for. The palette scan measures the SURFACE, so its known-bad is ink
          on a decor-gold background. A single paragraph with gold on gold was tried first and axe reported
          nothing for it: at 1:1 there is no visible text to measure, so the rule that exists to catch faint
          copy does not fire on invisible copy.
        */
        const faint = document.createElement('p')
        faint.textContent = 'Take the payment'
        faint.style.color = root.getPropertyValue('--color-decor-gold')
        faint.style.backgroundColor = root.getPropertyValue('--color-surface-sand')
        document.body.append(faint)
        const onDecor = document.createElement('p')
        onDecor.textContent = 'Take the payment'
        onDecor.style.color = root.getPropertyValue('--color-ink')
        onDecor.style.backgroundColor = root.getPropertyValue('--color-decor-gold')
        document.body.append(onDecor)
      })
      const result = await auditPage(page, {
        page: `${TILL_PATH} (known-bad)`,
        viewport: { name: '1440', width: 1440, height: 900, scale: 1, why: 'the control' },
        theme: 'light',
        direction: 'ltr',
      })
      return { violations: result.violations, offenders: await copyOnDecorativeSurfaces(page) }
    })
    const ids = violations.map((violation) => violation.id)
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('button-name')
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('color-contrast')
    // And the palette scan itself can fail, which is what makes its forty-eight empty answers mean something.
    expect(offenders.some((offender) => offender.includes('--color-decor-gold'))).toBe(true)
  }, 300_000)
})

describe('acceptance — every till route photographed twice is byte-identical', () => {
  it('captures 4 screens x 3 viewports x 2 themes x 2 directions, with zero pixel diff between runs', async () => {
    mkdirSync(SCREENS, { recursive: true })
    const shots = new Map<string, Uint8Array>()
    for (const screen of SCREEN_PATHS) {
      for (const cell of CELLS) {
        const label = `${screen.label}__${cell.theme}-${cell.width}__${cell.direction}`
        /*
          The claim is about the PAGE: it renders from a database and prints money figures and a business day,
          and a document printing a relative time or a generated id could not render identically twice. Through
          `captureUntilStable` rather than comparing capture one to capture two, because that also asserts
          paint had settled by the first capture.
        */
        const stable = await captureUntilStable(
          () =>
            withCell(cell, screen.path, (page) =>
              page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' }),
            ),
          { label },
        )
        expect(stable.png.byteLength, label).toBeGreaterThan(1000)
        expect(stable.attemptsUsed, `${label} settled in`).toBeLessThanOrEqual(5)
        shots.set(label, stable.png)
        writeFileSync(join(SCREENS, `${label}.png`), stable.png)
      }
    }
    expect(shots.size).toBe(48)
    // The control on the comparison: different cells are not identical. Without it, a screenshot function that
    // returned the same bytes every time would pass every assertion above.
    const differs = (a: string, b: string): number =>
      Buffer.compare(
        Buffer.from(shots.get(a) ?? new Uint8Array()),
        Buffer.from(shots.get(b) ?? new Uint8Array()),
      )
    expect(differs('till__light-390__ltr', 'till__dark-390__ltr')).not.toBe(0)
    expect(differs('till__light-390__ltr', 'till__light-1440__ltr')).not.toBe(0)
    expect(differs('till__light-1440__ltr', 'till__light-1440__rtl')).not.toBe(0)
    expect(differs('till__light-1440__ltr', 'packages__light-1440__ltr')).not.toBe(0)
  }, 900_000)
})

describe('acceptance — the RTL till is genuinely mirrored, not merely translated', () => {
  it('puts the keypad and the total column on opposite sides in the two directions', async () => {
    // The two elements only exist once the basket has something in it, so the measurement is made on a priced
    // page rather than on the resting screen.
    const geometry = async (direction: 'ltr' | 'rtl') =>
      await withCell(
        { width: 1440, height: 900, theme: 'light', direction },
        `${TILL_PATH}?${TILL_FIELDS.appointment}=${billedAppointmentId()}`,
        async (page) => {
          await page.locator('[data-testid="till-price"]').press('Enter')
          await page.waitForLoadState('networkidle')
          const keypad = await page.locator('[data-testid="till-keypad"]').boundingBox()
          const totals = await page.locator('[data-testid="till-total-column"]').boundingBox()
          if (keypad === null || totals === null) {
            throw new Error(`no keypad or total column at ${direction}`)
          }
          return { keypad: keypad.x, totals: totals.x, dir: direction }
        },
      )
    const ltr = await geometry('ltr')
    const rtl = await geometry('rtl')
    // In LTR the entry column (which holds the keypad) is first in the inline direction, so it is to the LEFT
    // of the totals. In RTL the browser places the same tracks the other way. A stylesheet using `margin-left`
    // would pass every text assertion in this suite and fail exactly here.
    expect(ltr.keypad, 'ltr: keypad left of the totals').toBeLessThan(ltr.totals)
    expect(rtl.keypad, 'rtl: keypad right of the totals').toBeGreaterThan(rtl.totals)
    // And the control that the two measurements are not the same page twice.
    expect(ltr.keypad).not.toBe(rtl.keypad)
  }, 180_000)
})

describe('acceptance — a walk-in checkout is keyboard-only and costs at most twelve interactions', () => {
  it('counts every key press, and records that no pointer event reached the document', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
      locale: 'en-AE',
      timezoneId: 'Asia/Dubai',
      reducedMotion: 'reduce',
    })
    try {
      await context.addInitScript({
        content: `
          globalThis.__name = globalThis.__name || ((fn) => fn)
          globalThis.__pointerEvents = []
          for (const type of ['pointerdown','pointerup','mousedown','mouseup','click','touchstart']) {
            document.addEventListener(type, (event) => {
              globalThis.__pointerEvents.push(type + ':' + (event.isTrusted ? 'trusted' : 'synthetic'))
            }, true)
          }
        `,
      })
      const page = await context.newPage()
      await page.goto(`${BASE}${TILL_PATH}?${TILL_FIELDS.day}=${tradingDate}`, {
        waitUntil: 'networkidle',
      })

      let interactions = 0
      const press = async (key: string): Promise<void> => {
        interactions += 1
        await page.keyboard.press(key)
      }
      const type = async (text: string): Promise<void> => {
        for (const _character of text) interactions += 1
        await page.keyboard.type(text)
      }

      // The first billable appointment's checkbox carries `autofocus`, so the operator starts on it and the
      // count begins at zero tabs. That is a real property of the document, asserted here rather than assumed.
      const focused = await page.evaluate(
        () =>
          document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.id ?? '',
      )
      expect(focused).toBe('till-appointment-1')

      await press('Space') // pull the treatment through
      await press('Enter') // implicit submission of the basket form: price it
      /*
        Waited on the ELEMENT the new document must contain, not on `networkidle`. A POST that navigates leaves
        `networkidle` satisfied by the OLD document for a moment, and the next `page.evaluate` then dies with
        "Execution context was destroyed" — which reads like a broken page and is a race in the wait. It cost a
        run of this file to find.
      */
      await page.waitForSelector('[data-testid="till-tender-form"]', { state: 'attached' })

      // The tender form's first amount field carries `autofocus`, so the operator is already on Cash.
      const onCash = await page.evaluate(
        () => document.activeElement?.getAttribute('data-testid') ?? '',
      )
      expect(onCash).toBe('till-amount-cash')
      await type('20000') // the exact cash due, typed
      await press('Enter') // implicit submission of the tender form: take the payment
      await page.waitForSelector('[data-testid="till-refusal"]', { state: 'attached' })

      // The walk ENDS at the refusal, because no treatment can be paid for until the TRN is entered. The
      // interaction count is a property of the form design and is unaffected by that — which is why it is
      // asserted here and the refusal is asserted with it rather than instead of it.
      const refusal = await page.getAttribute('html', 'data-till-refusal')
      expect(refusal).toBe('issuer_trn_not_configured')
      expect(await page.locator('[data-testid="till-refusal-question"]').textContent()).toBe(
        'Y1-trn',
      )

      /*
        MEASURED at 8: Space to pull the treatment through, Enter to price the basket, five digits for the cash
        amount, Enter to take the payment. The exact figure is asserted as well as the ceiling of 12 on purpose
        - a redesign costing four more presses would still be under the ceiling and would still be a regression
        in the thing this acceptance line is about, and the ceiling alone would not say so.
      */
      expect(interactions, 'key presses for a walk-in checkout').toBe(8)
      expect(interactions, 'and under the acceptance ceiling').toBeLessThanOrEqual(12)

      // "with no pointer events used": the document recorded every pointer, mouse and touch event it received,
      // in the capture phase, and the log is empty. A count of Playwright calls would prove nothing — this is
      // the DOM's own answer.
      const pointers = await page.evaluate(
        () => (globalThis as unknown as { __pointerEvents: string[] }).__pointerEvents,
      )
      expect(pointers, 'pointer events the document received').toEqual([])
    } finally {
      await context.close()
    }
  }, 180_000)
})

describe('acceptance — the M2 slice, part 1: the browser walks it to the Y1-trn refusal', () => {
  it('prices a tip and a discount, previews every mandatory field, and writes nothing', async () => {
    const before = {
      invoice: await countOf('invoice'),
      entry: await countOf('journal_entry'),
      payment: await countOf('payment'),
    }
    /*
      The whole basket travels in the query string, which is what lets this case open the priced screen in one
      GET rather than replaying the operator's key presses — those are the keyboard case's subject, and a
      second copy of them here would make one defect fail two cases for different reasons.

      The tenders are in the query too, because the posting panel appears only once there IS a tender: an entry
      for a basket nobody has finished paying for would be a claim about money that has not moved, so
      `postingViewFor` returns null until then. That is the behaviour, and discovering it cost this case a run.
    */
    const outcome = await withDesk(
      `${TILL_PATH}?${TILL_FIELDS.appointment}=${billedAppointmentId()}&${TILL_FIELDS.tip}=1500` +
        `&${TILL_FIELDS.discount}=2000&${TILL_FIELDS.discountReason}=service_recovery` +
        `&${TILL_FIELDS.cash}=10000&${TILL_FIELDS.card}=9500`,
      async (page) => {
        const basket = await page.locator('[data-testid="till-basket"] tr[data-line-kind]').count()
        const posting = await page.getAttribute('[data-testid="till-posting"]', 'data-balanced')
        const difference = await page
          .locator('[data-testid="till-posting"] [data-field="difference"]')
          .textContent()
        const outstanding = await page
          .locator('[data-testid="till-totals"] [data-field="outstanding"]')
          .textContent()
        await page.locator('[data-testid="till-issue"]').press('Enter')
        // Waited on the element the new document must contain, never on `networkidle`: a POST that navigates
        // leaves `networkidle` satisfied by the OLD document for a moment.
        await page.waitForSelector('[data-testid="till-refusal"]', { state: 'attached' })
        return {
          basket,
          posting,
          difference,
          outstanding,
          refusal: await page.getAttribute('html', 'data-till-refusal'),
          question: await page.locator('[data-testid="till-refusal-question"]').textContent(),
        }
      },
    )
    // Three lines: the treatment, the discount that says why, and the gratuity.
    expect(outcome.basket).toBe(3)
    // The entry the basket WOULD post is shown and it balances — the money is right, the paper is not.
    expect(outcome.posting).toBe('1')
    expect(label(outcome.difference)).toBe('AED 0.00')
    // And the split tender covers the basket exactly, which is what makes the issue attempt reach the TRN
    // check rather than stopping at `tender_does_not_cover`.
    expect(label(outcome.outstanding)).toBe('AED 0.00')
    expect(outcome.refusal).toBe('issuer_trn_not_configured')
    expect(outcome.question).toBe('Y1-trn')

    // Nothing was written. The refusal happens before the mapping composes anything, so there is no
    // half-built document for a retry to trip over — asserted as a delta over three tables.
    expect(await countOf('invoice')).toBe(before.invoice)
    expect(await countOf('journal_entry')).toBe(before.entry)
    expect(await countOf('payment')).toBe(before.payment)

    // And the reason is the ROW, not a constant in this file: the seeded issuer's TRN is the placeholder.
    const issuer = await readTillIssuer(sql)
    expect(issuer?.trnIsPlaceholder).toBe(true)
    expect(issuer?.trn).toBe('TRN-PENDING-Y1-TRN')
  }, 180_000)

  it('enumerates the mandatory field list on the preview and marks the TRN absent', async () => {
    const response = await fetch(
      `${BASE}${TILL_PATH}?${TILL_FIELDS.day}=${tradingDate}&${TILL_FIELDS.view}=preview` +
        `&${TILL_FIELDS.appointment}=${billedAppointmentId()}`,
    )
    const html = await response.text()
    // The BYTES a reader receives. Every field of the chosen form is stated, the TRN is marked absent, and the
    // question that owns it is named beside it.
    expect(html).toContain('data-testid="till-mandatory"')
    expect(html).toContain('data-field-key="issuerTrn" data-absent="1"')
    expect(html).toContain('data-field-key="issuerLegalName"')
    expect(html).toContain('data-field-key="grossTotal"')
    expect(html).toContain('<code>Y1-trn</code>')
    // The control: the field list is not one row long, and a field the system CAN state is not marked absent.
    const rows = html.match(/data-field-key="/g) ?? []
    expect(rows.length).toBeGreaterThan(10)
    expect(html).not.toContain('data-field-key="issuerLegalName" data-absent="1"')
  }, 60_000)
})

describe('acceptance — the M2 slice, part 2: with a TRN configured the whole slice runs', () => {
  it('the control: the same handler with the real issuer reader refuses', async () => {
    /*
      FIRST in this describe, and the order is load-bearing rather than stylistic: the case below ISSUES a
      document for the probe appointment, after which `readBillableAppointments` stops offering it and this
      control would refuse with `nothing_to_bill` instead of `issuer_trn_not_configured` — a pass for the wrong
      reason if the assertion were loose, and a confusing failure as it is. It cost this file a run to find.

      Without this control the case below would prove only that a configured issuer works, and a handler that
      ignored the TRN entirely would satisfy it. `databaseIssuer` is exactly what the route passes.
    */
    const body = new URLSearchParams()
    body.set(TILL_FIELDS.step, 'issue')
    body.set(TILL_FIELDS.day, tradingDate)
    body.append(TILL_FIELDS.appointment, billedAppointmentId())
    body.set(TILL_FIELDS.cash, '20000')
    const response = await handleTillWrite(
      {
        searchParams: new URLSearchParams(),
        body,
        chrome: { googleReauth: null, returnTo: TILL_PATH },
        requestId: 'mtill13-m2-control',
      },
      { sql, now: () => Date.now(), readIssuer: databaseIssuer },
    )
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('data-till-refusal="issuer_trn_not_configured"')
  }, 60_000)
  it('issues the document, records the cash, balances the entry, and reaches the box-1 grouping', async () => {
    /*
      The same handler the route calls, driven with an issuer reader that returns a CONFIGURED issuer. That is
      the only way to walk past the TRN, and it is not a way round the rule: `requireIssuerSnapshot` still runs
      inside `tillCheckoutMapping`, so what can be supplied is a VALID fifteen-digit TRN and never a
      placeholder. `FIXTURE_ISSUER`'s TRN is the same one `packages/pdf`'s golden fixtures use and it reaches
      nothing but a fixture.

      Asserted through the served RESPONSE's bytes rather than through the return value of a render function,
      which is this build's own finding about screen units.
    */
    const body = new URLSearchParams()
    body.set(TILL_FIELDS.step, 'issue')
    body.set(TILL_FIELDS.day, tradingDate)
    body.append(TILL_FIELDS.appointment, billedAppointmentId())
    body.set(TILL_FIELDS.tip, '1500')
    body.set(TILL_FIELDS.discount, '2000')
    body.set(TILL_FIELDS.discountReason, 'service_recovery')
    body.set(TILL_FIELDS.cash, '10000')
    body.set(TILL_FIELDS.card, '9500')
    body.set(TILL_FIELDS.cardRef, 'APPROVAL-M2')

    const before = await ledgerTotals()
    const response = await handleTillWrite(
      {
        searchParams: new URLSearchParams(),
        body,
        chrome: { googleReauth: null, returnTo: TILL_PATH },
        requestId: 'mtill13-m2-slice',
      },
      { sql, now: () => Date.now(), readIssuer: async () => FIXTURE_ISSUER },
    )
    const html = await response.text()
    expect(response.status, refusalIn(html)).toBe(200)
    expect(html).toContain('data-testid="till-issued"')
    const number = /data-field="number">([^<]+)</.exec(html)?.[1] ?? ''
    expect(number.length, 'the served document number').toBeGreaterThan(2)

    // The document, read back off the row.
    const [invoice] = await sql<
      {
        id: string
        kind: string
        series: string
        display_number: string
        net_total: string
        vat_total: string
      }[]
    >`
      select id, document_kind as kind, series_code as series, display_number, net_total, vat_total
        from invoice where display_number = ${number}
    `
    /*
      A TAX invoice in TAX-INV, and that is the rule's answer rather than a preference — with a finding in it.

      `requireInvoiceForm` picks the form from the total and whether a customer is NAMED. `booking.customer_id`
      is NOT NULL (0011), so every appointment has a customer record and the till's answer is always
      `tax_invoice`: the SIMPLIFIED form is unreachable for a treatment checkout, and ADR 0014's "cash sale at
      the desk with no customer record" cannot exist as an appointment at all. Reported in the unit's NOTE; the
      simplified form is exercised where a basket can be built by hand, in
      `packages/fixtures/src/till-receipt.itest.ts`.

      Issuing into TAX-INV is the hazard M-TILL-10 recorded as its defect 9, so this file's `afterAll` truncates
      the invoice family AND resets `document_series`, which is what four existing fixture suites do: after it,
      `max(invoice.number)` is 0 and `next_number` is 1, so `checkout-finalise.itest.ts`'s
      `next_number = max(number) + 1` assertion holds whichever order the integration suite runs in.
    */
    expect(invoice?.kind).toBe('tax_invoice')
    expect(invoice?.series).toBe('TAX-INV')

    // The cash, recorded: one `payment` row per tender, with the card's approval code kept.
    const payments = await sql<
      { tender_kind: string; amount_fils: string; reference: string | null }[]
    >`
      select tender_kind, amount_fils, reference from payment
       where invoice_id = ${invoice?.id as string} order by tender_no
    `
    expect(payments.map((row) => row.tender_kind)).toEqual(['cash', 'card_in_salon'])
    expect(payments[1]?.reference).toBe('APPROVAL-M2')

    // The entry, balanced, as a DELTA: `journal_line` is append-only and truncated by nobody.
    const after = await ledgerTotals()
    expect(after.debit - before.debit).toBe(after.credit - before.credit)
    expect(after.debit - before.debit).toBeGreaterThan(0)

    /*
      THE DRILL-DOWN, and what it measured about the chart.

      The numbered VAT201 boxes and the working papers are M-VAT-07's, which is `todo`. What exists today is
      `account.vat_box`, the grouping a box will sum — and reading it showed box 1 is TWO tags rather than one,
      which is why this walk names both: the SUPPLIES sit on the revenue accounts
      (`standard_rated_supplies`, 4010 and the contra 4095) and the TAX sits on 2030 (`output_tax`). A box-1
      drill-down that swept only one of them would report a supply with no tax or a tax with no supply. The
      first version of this case asserted 2030 was tagged `standard_rated_supplies` and failed, which is how
      the split was found.

      Every step is a join and none of it is a figure this file recomputes:
      tag -> account -> journal line -> `checkout_finalisation` -> document.
    */
    const drill = await sql<
      {
        vat_box: string
        account_code: string
        debit: string
        credit: string
        display_number: string
      }[]
    >`
      select a.vat_box, jl.account_code, jl.debit_fils::text as debit, jl.credit_fils::text as credit,
             i.display_number
        from journal_line jl
        join account a on a.code = jl.account_code
        join checkout_finalisation cf on cf.journal_entry_id = jl.entry_id
        join invoice i on i.id = cf.invoice_id
       where i.id = ${invoice?.id as string}
         and a.vat_box in ('standard_rated_supplies', 'output_tax')
       order by jl.account_code
    `
    expect(drill.length, 'lines behind the box-1 groupings for this document').toBeGreaterThan(1)
    // The supplies half: credits to the revenue accounts less the contra-revenue discount, which is the
    // document's own net total to the fils.
    const supplies = drill.filter((row) => row.vat_box === 'standard_rated_supplies')
    const netFromTheLedger = supplies.reduce(
      (total, row) => total + Number(row.credit) - Number(row.debit),
      0,
    )
    expect(netFromTheLedger).toBe(Number(invoice?.net_total))
    // The tax half: one line on 2030, equal to the document's VAT total.
    const outputTax = drill.filter((row) => row.vat_box === 'output_tax')
    expect(outputTax).toHaveLength(1)
    expect(outputTax[0]?.account_code).toBe('2030')
    expect(Number(outputTax[0]?.credit)).toBe(Number(invoice?.vat_total))
    // And every line behind a grouping reaches a document, which is what "drills to source" means.
    for (const row of drill) expect(row.display_number).toBe(number)

    // The control on the grouping: an account tagged with NEITHER is excluded. `2040 Tips payable` is credited
    // by this very entry and is outside the scope of VAT, so a query that swept every credit would return it —
    // which is exactly how a VAT return comes to include a gratuity.
    const [tips] = await sql<{ vat_box: string | null }[]>`
      select vat_box from account where code = '2040'
    `
    expect(tips?.vat_box).toBeNull()
    expect(drill.map((row) => row.account_code)).not.toContain('2040')
  }, 180_000)
})

describe('acceptance — the M2 slice, part 3: a package sale and redemption complete in the browser', () => {
  it('takes cash for a package with no document at all, and posts a balanced entry', async () => {
    const before = await ledgerTotals()
    const [template] = await sql<{ template_key: string; price_fils: string }[]>`
      select t.template_key, tv.price_fils
        from package_template t
        join package_template_version tv on tv.template_id = t.id
       where t.template_key = 'fixture_package_untouched'
       order by tv.version desc limit 1
    `
    const price = Number(template?.price_fils)
    const sold = await withDesk(PACKAGES_PATH, async (page) => {
      await page.selectOption('[data-testid="packages-template"]', template?.template_key as string)
      await page.locator('[data-testid="packages-cash"]').fill(String(price))
      await page.locator('[data-testid="packages-sell"]').press('Enter')
      await page.waitForLoadState('networkidle')
      return {
        announcement: await page.locator('[data-testid="packages-live"]').textContent(),
        sold: await page.locator('[data-testid="packages-sold"]').count(),
        accounts: await page
          .locator('[data-testid="packages-sale-posting"] tr[data-account]')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-account'))),
      }
    })
    expect(sold.sold, sold.announcement ?? 'no announcement').toBe(1)
    // Dr the tender, Cr 2050 at the FULL gross, and nothing on revenue and nothing on 2030: the sale
    // recognises nothing, which is Y11-vat-package's provisional answer.
    expect([...(sold.accounts ?? [])].sort()).toEqual(['1010', '2050'])
    expect(sold.announcement ?? '').toContain('entitlement')

    const after = await ledgerTotals()
    expect(after.debit - before.debit).toBe(after.credit - before.credit)
    expect(after.debit - before.debit).toBe(price)

    // The `payment` row names the PACKAGE and no invoice, which is 0083's `package_sale_id` — and it is what
    // makes cash taken for a package visible to `readDrawerTakings` and so to the cash-up.
    const [payment] = await sql<{ invoice_id: string | null; amount_fils: string }[]>`
      select invoice_id, amount_fils from payment
       where package_sale_id is not null order by received_at desc limit 1
    `
    expect(payment?.invoice_id).toBeNull()
    expect(Number(payment?.amount_fils)).toBe(price)
  }, 180_000)

  it('redeems a session against the delivered treatment and puts the output VAT on 2030', async () => {
    const before = await ledgerTotals()
    const redeemed = await withDesk(PACKAGES_PATH, async (page) => {
      await page.selectOption('[data-testid="packages-appointment"]', redeemedAppointmentId())
      await page.locator('[data-testid="packages-redeem"]').press('Enter')
      await page.waitForLoadState('networkidle')
      return {
        shown: await page.locator('[data-testid="packages-redeemed"]').count(),
        vat: await page
          .locator('[data-testid="packages-redeemed"] [data-field="vat"]')
          .textContent(),
        accounts: await page
          .locator('[data-testid="packages-redemption-posting"] tr[data-account]')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-account'))),
      }
    })
    expect(redeemed.shown).toBe(1)
    // Dr 2050 at the released gross, Cr 4020 at the net, Cr 2030 at the VAT. This is where output VAT enters
    // box 1 for a package, under Y11-vat-package's provisional answer.
    // Sorted, because the ORDER of an entry's lines is `packageRedemptionPosting`'s business and not this
    // file's: asserting the order would make a harmless reordering in core fail here while proving nothing.
    expect([...(redeemed.accounts ?? [])].sort()).toEqual(['2030', '2050', '4020'])
    expect(redeemed.vat ?? '').toMatch(/AED/)

    const after = await ledgerTotals()
    expect(after.debit - before.debit).toBe(after.credit - before.credit)

    // The row, and the grouping a VAT201 box 1 reads.
    const [release] = await sql<{ vat_fils: string; entry_id: string }[]>`
      select vat_fils, journal_entry_id as entry_id from package_redemption
       order by created_at desc limit 1
    `
    const [box] = await sql<{ credit: string; vat_box: string }[]>`
      select jl.credit_fils::text as credit, a.vat_box
        from journal_line jl join account a on a.code = jl.account_code
       where jl.entry_id = ${release?.entry_id as string} and jl.account_code = '2030'
    `
    // `output_tax` and not `standard_rated_supplies`: box 1 is two tags, and this is the tax half. The supplies
    // half of a redemption sits on 4020, which the assertion below reads.
    expect(box?.vat_box).toBe('output_tax')
    expect(Number(box?.credit)).toBe(Number(release?.vat_fils))
    // The supplies half, on the package's own revenue account: 4020 and never 4010, so the one report that can
    // tell a prepaid treatment from a cash one is able to.
    const [supply] = await sql<{ credit: string; vat_box: string }[]>`
      select jl.credit_fils::text as credit, a.vat_box
        from journal_line jl join account a on a.code = jl.account_code
       where jl.entry_id = ${release?.entry_id as string} and jl.account_code = '4020'
    `
    expect(supply?.vat_box).toBe('standard_rated_supplies')
  }, 180_000)

  it('states the tax document that is owed at redemption and cannot be issued', async () => {
    // M-TILL-10 deferred "a tax document at redemption" here. It is ANSWERED rather than deferred again: the
    // document is owed, it cannot be issued for the same Y1-trn reason every other tax document cannot, and
    // the VAT is not deferred with the paper. The screen says so, naming both questions.
    const response = await fetch(`${BASE}${PACKAGES_PATH}?${TILL_FIELDS.day}=${tradingDate}`)
    const html = await response.text()
    expect(html).toContain('data-testid="packages-document-obligation"')
    expect(html).toContain('<code>Y1-trn</code>')
    expect(html).toContain('<code>Y11-vat-package</code>')
  }, 60_000)

  it('shows every seeded package with its unconfirmed marker and its open question', async () => {
    const response = await fetch(`${BASE}${PACKAGES_PATH}?${TILL_FIELDS.day}=${tradingDate}`)
    const html = await response.text()
    // The four seeded templates, each one named so a reviewer cannot mistake it for a product this business
    // sells, and each one naming a question. Narrowed to this file's known keys rather than counting rows,
    // because other suites leave probe templates behind (brief rule 12).
    for (const key of [
      'fixture_package_untouched',
      'fixture_package_part_used',
      'fixture_package_fully_used',
      'fixture_package_expired',
    ]) {
      expect(html, key).toContain(`data-template="${key}"`)
    }
    expect(html).toContain('[confirm]')
    expect(html).toContain('Y9-package-catalogue')
    // The four drawdown states docs/12 §5 asks the fixture salon to hold, on the screen built to show them.
    for (const state of ['untouched', 'part used', 'fully used', 'expired with a balance']) {
      expect(html, state).toContain(`data-state="${state}"`)
    }
  }, 60_000)
})

describe('acceptance — the cash-up screen counts a drawer and can never absorb a variance', () => {
  it('opens a shift, refuses a close with no count, and posts the discrepancy to 6140', async () => {
    // Its own business day, never the day in progress. See CASH_UP_DAY.
    const path = `${CASH_UP_PATH}?${TILL_FIELDS.day}=${CASH_UP_DAY}`
    const opened = await withCell(
      { width: 1440, height: 900, theme: 'light', direction: 'ltr' },
      path,
      async (page) => {
        await page.locator('[data-testid="cash-up-float"]').fill('50000')
        await page.locator('[data-testid="cash-up-open"]').press('Enter')
        await page.waitForLoadState('networkidle')
        return {
          live: await page.locator('[data-testid="cash-up-live"]').textContent(),
          expected: await page
            .locator('[data-testid="cash-up-takings"] [data-field="expected"]')
            .textContent(),
        }
      },
    )
    expect(opened.live ?? '').toContain('is open')
    // The expected float is `expectedFloat` in `@berelax/core`, which is the other statement of
    // `cash_session_expected_float_fils` in SQL. The screen shows core's before anything is written.
    expect(opened.expected ?? '').toMatch(/AED/)

    const refused = await withCell(
      { width: 1440, height: 900, theme: 'light', direction: 'ltr' },
      path,
      async (page) => {
        // A close with the count field left EMPTY. An empty field is the absence of a count and a zero is an
        // empty drawer; treating the first as the second is how a shift acquires a figure nobody measured.
        await page.locator('[data-testid="cash-up-close"]').press('Enter')
        await page.waitForLoadState('networkidle')
        return await page.locator('[data-testid="cash-up-refusal"]').textContent()
      },
    )
    expect(refused ?? '').toContain('CountRequired')

    const short = await withCell(
      { width: 1440, height: 900, theme: 'light', direction: 'ltr' },
      path,
      async (page) => {
        // Counted short by 1,200 fils with no reason: refused, because a discrepancy nobody explained is a
        // discrepancy nobody investigated.
        await page.locator('[data-testid="cash-up-counted"]').fill('48800')
        await page.locator('[data-testid="cash-up-close"]').press('Enter')
        await page.waitForLoadState('networkidle')
        const withoutReason = await page.locator('[data-testid="cash-up-refusal"]').textContent()
        await page.locator('[data-testid="cash-up-counted"]').fill('48800')
        await page
          .locator('[data-testid="cash-up-note"]')
          .fill('Two notes missing at the end of the shift')
        await page.locator('[data-testid="cash-up-close"]').press('Enter')
        await page.waitForLoadState('networkidle')
        return {
          withoutReason,
          live: await page.locator('[data-testid="cash-up-live"]').textContent(),
          accounts: await page
            .locator('[data-testid="cash-up-posting"] tr[data-account]')
            .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-account'))),
        }
      },
    )
    expect(short.withoutReason ?? '').toContain('carries no reason')
    expect(short.live ?? '').toContain('6140')
    // Dr 6140 and Cr the drawer's own account: a SHORT drawer is a loss, and the side comes from the sign.
    expect(short.accounts).toContain('6140')

    // And the row, with its signed generated discrepancy — negative short, positive over. A boolean could not
    // be summed over a month to tell a process problem from a person problem.
    const [session] = await sql<{ status: string; discrepancy_fils: string; count_note: string }[]>`
      select status, discrepancy_fils::text, count_note from cash_session
       where trading_date = ${CASH_UP_DAY}::date order by shift_no desc limit 1
    `
    expect(session?.status).toBe('closed')
    expect(Number(session?.discrepancy_fils)).toBe(-1200)
    expect(session?.count_note ?? '').toContain('Two notes missing')
  }, 300_000)
})
