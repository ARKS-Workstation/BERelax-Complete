import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ASIA_DUBAI,
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
  queryAvailability,
  readAvailabilityLimits,
  readBookableVariants,
  readGenderMatching,
  readMandatoryDocumentTypes,
  type Sql,
} from '@berelax/db'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import {
  captureUntilStable,
  DETERMINISM_CSS,
  DETERMINISTIC_LAUNCH_ARGS,
  freezePageEnvironment,
} from '@berelax/harness/determinism'
import { DIRECTIONS, THEMES, VIEWPORTS } from '@berelax/harness/matrix'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { auditTouchTargetsInPage, touchTargetInputFor } from '@berelax/harness/touch-targets'
import { DECORATIVE_ONLY_TOKENS, TEXT_BEARING_TOKENS } from '@berelax/ui'
import { SLOT_GRID_COLUMNS } from '@berelax/ui/patterns'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BOOK_FIELDS, bookHref, wallClock } from './book/state.ts'

/**
 * B-UI-01 — the public booking flow, driven against the built application and a real PostgreSQL.
 *
 * Every claim in this unit's acceptance list is a claim about rendered output, served bytes or a build
 * artefact, and not one of them can be checked by reading source:
 *
 *   - **one client island** is a property of what `next build` produced, read out of the route's own
 *     `page_client-reference-manifest.js`, with `/treatments` as the control that names none;
 *   - **the day strip and the first day's slot list with JavaScript disabled** is a property of the bytes,
 *     so it is asserted with `fetch` and no browser at all — a hydrated DOM would prove the opposite;
 *   - **3 / 4 / 6 columns** is a resolved `grid-template-columns` at a container width the engine worked
 *     out, which no stylesheet read can answer;
 *   - **48x48 with 8px gaps and a 16px control** is padding plus line-height plus whatever the flex
 *     container did;
 *   - **no text on `--surface-clay`, `--decor-gold` or `--decor-tan`** is a computed `color` per text node.
 *     docs/14 §5 names it as this build's single most likely defect, because the prototype used the bright
 *     gold for text — and a grep over source would pass on a rule somebody commented out;
 *   - **a mirrored layout** is two positions of the same element in two documents.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind
 * (CONTRIBUTING-AGENT-BRIEF §12). This file writes shifts, appointments and three employees, all carrying
 * {@link MARKER}; it uses the **seeded** catalogue rather than a probe service, so nothing here publishes a
 * treatment; and its trading dates are computed from the run's own clock at `+{@link FREE_OFFSET}` days,
 * which is past the fixture horizon (`FIXTURE_TODAY + 28`) and well inside `booking.max_advance_days`. Every
 * assertion is a key-set comparison or a delta, never a total on a shared table.
 *
 * ## Why the dates are relative to the clock and not literals
 *
 * Because `minLeadMinutes` and `maxAdvanceDays` are settings that bound the answer: a literal date in 2098
 * is beyond the 90-day advance window and every start on it is refused, so the suite would assert an empty
 * page. The other suites that use far-future dates do not go through the solver's horizon check (their
 * `maxAdvanceDays` is 36_500 or their solver is a stub); this one drives the real page with the real
 * settings, so its dates have to be dates a customer could actually book.
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

const MARKER = 'bui01 book itest'
const PROBE_PHONE = '+971590000681'
/** Internal handles, never display names (ADR 0020). Three, so the alternatives list can hold two. */
const REFERENCES = ['bui01-a', 'bui01-b', 'bui01-c'] as const
/** The seeded treatment this file books: `asian-normal-massage`, which needs a standard room. */
const PROBE_SLUG = 'asian-normal-massage'
const PROBE_DURATION = 60

/**
 * Where this file's trading dates sit, in days from the run's own clock.
 *
 * 30 and 31: past the seeded fixture horizon (`FIXTURE_TODAY + 28`), so no other suite's rows are on them,
 * and far inside the provisional 90-day advance window so the solver offers a full day rather than a
 * lead-truncated one. `SPAN` covers the whole strip plus the seven days either side that the
 * no-availability state searches for a nearer day.
 */
const FREE_OFFSET = 30
const FULL_OFFSET = 31
const SPAN_FROM = 24
const SPAN_TO = 40

const CAPTURE_LABEL = 'book'

let sql: Sql
let server: WebServer
let browser: Browser
let variantId = ''
let variantName = ''
let variantGrossFils = ''
let now = 0
let freeDate = ''
let fullDate = ''
/** The trading dates this file INSERTED, so `afterAll` removes only those. */
const insertedDates: string[] = []
const staff = new Map<string, string>()
let customerId = ''

const idOf = (reference: string): string => {
  const id = staff.get(reference)
  if (id === undefined) throw new Error(`no fixture employee ${reference}`)
  return id
}

/** The premises' own calendar date for an instant, which is what a trading date is counted in. */
const localDateOf = (instant: number): string => toLocal(instant as Instant, ASIA_DUBAI).date

const shiftDate = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

const at = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+04:00`)

/** Core's rule, injected exactly as the page injects it. `satisfies`, not a cast. */
const solve = solveAvailabilityQuery satisfies AvailabilitySolve

/** The URL for one state of the page, in one locale. */
function bookUrl(
  locale: 'en' | 'ar',
  fields: Readonly<Record<string, string | number | null>>,
): string {
  return `${BASE}${bookHref(locale === 'ar' ? '/ar/book' : '/book', fields)}`
}

/** The full state: a treatment, a client and a day, which is the least the solver can answer about. */
const freeFields = (extra: Readonly<Record<string, string | number | null>> = {}) => ({
  [BOOK_FIELDS.variant]: variantId,
  [BOOK_FIELDS.gender]: 'female',
  [BOOK_FIELDS.date]: freeDate,
  ...extra,
})

/** The fully booked state: the same treatment, narrowed to the therapist whose day is full. */
const fullFields = (extra: Readonly<Record<string, string | number | null>> = {}) => ({
  [BOOK_FIELDS.variant]: variantId,
  [BOOK_FIELDS.gender]: 'female',
  [BOOK_FIELDS.date]: fullDate,
  [BOOK_FIELDS.therapist]: idOf('bui01-a'),
  ...extra,
})

async function fetchPath(url: string): Promise<Response> {
  return await fetch(url, { redirect: 'manual' })
}

/** The served bytes of one URL. No browser: "with JavaScript disabled" is a claim about these. */
async function fetchHtml(url: string): Promise<string> {
  const response = await fetchPath(url)
  expect(response.status, `${url} did not answer 200`).toBe(200)
  return await response.text()
}

/** Every match of a global pattern's first group, in document order. */
function allMatches(html: string, pattern: RegExp): readonly string[] {
  const found: string[] = []
  let match = pattern.exec(html)
  while (match !== null) {
    found.push(match[1] ?? '')
    match = pattern.exec(html)
  }
  return found
}

/**
 * The starts the availability engine offers, computed independently of the page.
 *
 * The control for every assertion about the slot list. Without it "the HTML contains a slot list" is
 * satisfied by a page rendering one time, and the count would be a number nobody had checked.
 */
async function offeredStarts(
  tradingDate: string,
  therapistId?: string,
): Promise<readonly number[]> {
  const [limits, genderMatching] = await Promise.all([
    readAvailabilityLimits(sql),
    readGenderMatching(sql),
  ])
  const request: AvailabilityRequest = {
    tradingDate,
    serviceVariantId: variantId,
    minLeadMinutes: limits.minLeadMinutes,
    maxAdvanceDays: limits.maxAdvanceDays,
    clientGender: 'female',
    genderMatching,
    ...(therapistId === undefined ? {} : { therapistIds: [therapistId] }),
  }
  const answer = await queryAvailability(sql, request, {
    solve,
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
  // therapist is not bookable at all — which is B-AVAIL-04's rule working, and why the nineteen seeded
  // therapists offer nothing. A fixture that skipped these would assert against an empty page. The set
  // is read IN FORCE rather than named: 0058 reconciled it with the column DEFAULT (decision 20's six).
  for (const documentType of await readMandatoryDocumentTypes(sql)) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${id}, ${documentType}::employee_document_type, '2099-12-31')
      on conflict do nothing
    `
  }
  return id
}

/** One committed appointment. 0038 made four of these columns NOT NULL with no default. */
async function commitAppointment(args: {
  readonly bookingId: string
  readonly tradingDate: string
  readonly roomId: string
  readonly therapistId: string
  readonly startsAt: number
  readonly endsAt: number
}): Promise<void> {
  const gross = grossMoneyFromFils(variantGrossFils)
  const split = splitGross(gross)
  await sql`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
       gross_price_fils, net_fils, vat_fils)
    values (${args.bookingId}, ${args.tradingDate}, ${variantId}, 'solo', ${args.therapistId},
            ${args.roomId},
            ${`[${new Date(args.startsAt).toISOString()},${new Date(args.endsAt).toISOString()})`}::tstzrange,
            'confirmed', uuid_generate_v7(), 1, 20, 10,
            ${gross.fils}, ${split.net.fils}, ${split.vat.fils})
  `
}

interface Cell {
  readonly width: number
  readonly height: number
  readonly theme: 'light' | 'dark'
  readonly direction: 'ltr' | 'rtl'
}

const DESKTOP: Cell = { width: 1440, height: 900, theme: 'light', direction: 'ltr' }

/**
 * One render of one URL, in one cell, settled.
 *
 * `freezePageEnvironment` on the CONTEXT before the page exists, for the reason
 * `packages/harness/src/capture.ts` records: a context init script applies to every page created
 * afterwards, and a page-level one registered against `about:blank` never runs. The `__name` shim is there
 * for the same reason it is there — esbuild's `keepNames` rewrites a named function as `__name(fn, 'fn')`
 * and Playwright serialises the compiled source into a page that has no such helper.
 */
async function open(
  url: string,
  cell: Cell = DESKTOP,
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({
    viewport: { width: cell.width, height: cell.height },
    deviceScaleFactor: 1,
    colorScheme: cell.theme,
    locale: cell.direction === 'rtl' ? 'ar-AE' : 'en-AE',
    timezoneId: 'Asia/Dubai',
    reducedMotion: 'reduce',
  })
  await context.addInitScript({
    content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
  })
  await context.addInitScript(freezePageEnvironment, now)
  // The theme is set the way the product sets it: the key the blocking bootstrap script in
  // `app/_document/shell.tsx` reads, before any page exists.
  await context.addInitScript(
    ({ value }: { value: string }) => {
      globalThis.localStorage.setItem('berelax:theme', value)
    },
    { value: cell.theme },
  )
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.addStyleTag({ content: DETERMINISM_CSS })
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve(null))
      })
    })
  })
  return { page, context }
}

/** The first-party client modules a route's build manifest names, as repository-relative paths. */
function clientModulesOf(routeDirectory: string): readonly string[] {
  const source = readFileSync(
    join(APP_DIR, '.next', 'server', 'app', routeDirectory, 'page_client-reference-manifest.js'),
    'utf8',
  )
  const assignment = source.indexOf('] = ')
  if (assignment === -1) throw new Error(`${routeDirectory}: not a client-reference manifest`)
  const manifest = JSON.parse(
    source
      .slice(assignment + 4)
      .trim()
      .replace(/;$/, ''),
  ) as {
    clientModules: Record<string, unknown>
  }
  const files = new Set<string>()
  for (const key of Object.keys(manifest.clientModules)) {
    const file = (key.split(' <locals>')[0] ?? '').split('#')[0] ?? ''
    // Turbopack spells every key `[project]/…`. Framework modules live under `node_modules`; what this
    // assertion is about is the application's own client components.
    if (!file.startsWith('[project]/') || file.includes('node_modules')) continue
    files.add(file.slice('[project]/'.length))
  }
  return [...files].sort()
}

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 8 })
  now = Date.now()
  const today = localDateOf(now)
  freeDate = shiftDate(today, FREE_OFFSET)
  fullDate = shiftDate(today, FULL_OFFSET)

  // 11:00-02:00 Asia/Dubai, the window the whole system is built around. `appointment.trading_date` and
  // `shift.trading_date` are foreign keys into this table, so no fixture can invent a date the premises
  // does not trade on. `returning` is what makes the cleanup remove only the rows this run added: a date
  // the fixture seed already holds is not this file's to delete.
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

  // The SEEDED catalogue, not a probe service: this file publishes no treatment, so nothing it does can
  // leave a service behind for the menu pages or the structured-data suite to render.
  const variants = await readBookableVariants(sql)
  const variant = variants.find(
    (row) => row.slug === PROBE_SLUG && row.durationMinutes === PROBE_DURATION,
  )
  if (variant === undefined) {
    throw new Error(
      `the catalogue has no ${PROBE_SLUG} at ${PROBE_DURATION} minutes: run \`pnpm seed\` before ` +
        'the integration suite — this unit drives the real menu rather than a probe service.',
    )
  }
  variantId = variant.serviceVariantId
  variantName = variant.publicDisplayName
  variantGrossFils = variant.grossFils

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = (customer as { id: string }).id

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

  /*
    The fully booked day, and the binding constraint is the THERAPIST rather than the floor.

    Therapist A holds eleven back-to-back 60-minute treatments in one seeded room, each followed by its
    20-minute turnaround, so her buffered presence is covered continuously from 10:50 to 01:30 and there is
    no start left for her. The other four rooms stay empty and therapists B and C stay free — which is what
    makes `alternative_therapists` non-empty for a request narrowed to A, and what the no-availability
    state's second region is about. Filling the whole FLOOR instead would empty that region and the test
    would pass on a page that renders it blank.
  */
  const [room] = await sql<{ id: string }[]>`
    select id from rooms where room_type = 'standard' and is_bookable order by display_order limit 1
  `
  const roomId = (room as { id: string }).id
  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${customerId}, 'front_desk', ${MARKER}) returning id
  `
  const bookingId = (booking as { id: string }).id
  for (let index = 0; index < 11; index += 1) {
    const startsAt = at(fullDate, '11:00') + index * 80 * 60_000
    await commitAppointment({
      bookingId,
      tradingDate: fullDate,
      roomId,
      therapistId: idOf('bui01-a'),
      startsAt,
      endsAt: startsAt + PROBE_DURATION * 60_000,
    })
  }

  server = await startWebServer({
    suite: 'book',
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
    await sql`delete from booking where notes = ${MARKER}`
    await sql`delete from shift_assignment where employee_id = any(${[...staff.values()]}::uuid[])`
    await sql`delete from shift where label = ${MARKER}`
    await sql`delete from employee_document where employee_id = any(${[...staff.values()]}::uuid[])`
    await sql`delete from employee_skill where employee_id = any(${[...staff.values()]}::uuid[])`
    await sql`delete from employee where notes = ${MARKER}`
    await sql`delete from waitlist where customer_id = ${customerId}`
    // Only the dates this run inserted, and only after the rows that reference them are gone.
    await sql`delete from availability_epoch where trading_date = any(${insertedDates}::date[])`
    await sql`delete from business_day where trading_date = any(${insertedDates}::date[])`
    await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
    await sql.end({ timeout: 5 })
  }
})

describe('acceptance — the route carries exactly the booking flows client boundaries', () => {
  /**
   * The flow's client modules, and there are two of them since B-UI-02.
   *
   * docs/09 §3's *"the booking flow is the one heavy client island; everything else is a server
   * component"* is a claim about the SITE — one heavy island, on this route — and not about a file count.
   * The picker is rendered only when there are times to pick and the step-4 fields only on the steps that
   * have them, so a single module would make every reader download the other half. What this assertion is
   * really for is unchanged: a THIRD boundary, or a component that quietly became one, fails here.
   */
  const ISLANDS = [
    'apps/web/app/_book/details.client.tsx',
    'apps/web/app/_book/slot-picker.client.tsx',
  ]

  it('names the flows two client modules beyond the shared layout, in both locales', () => {
    // Read out of what `next build` produced, not out of the source: the claim is about the boundary the
    // build found, and an import added through a barrel is exactly the way a second one arrives unseen.
    const layout = [
      'packages/ui/src/primitives/direction.tsx',
      'packages/ui/src/theme/theme-provider.tsx',
    ]
    for (const route of ['(en)/(public)/book', '(ar)/ar/book']) {
      const modules = clientModulesOf(route)
      for (const island of ISLANDS) expect(modules, route).toContain(island)
      expect(
        modules.filter((file) => !layout.includes(file)).sort(),
        `${route}: an unexpected client boundary on the route — ${modules.join(', ')}`,
      ).toEqual([...ISLANDS].sort())
    }
  })

  it('finds none on a route that has none, and finds the layouts own on both', () => {
    // Two controls in one. A reader that returned nothing would satisfy the assertion above, and a reader
    // that could not see the shared layout's two client components would make "beyond the layout"
    // meaningless. `/treatments` is the same shape of page with no island.
    const treatments = clientModulesOf('(en)/(public)/treatments')
    for (const island of ISLANDS) expect(treatments).not.toContain(island)
    expect(treatments).toContain('packages/ui/src/theme/theme-provider.tsx')
    expect(treatments).toContain('packages/ui/src/primitives/direction.tsx')
    expect(clientModulesOf('(en)/(public)/book').length).toBeGreaterThan(treatments.length)
  })
})

describe('acceptance — the initial HTML carries the day strip and the first days slot list', () => {
  it('renders both with no JavaScript, asserted against the served bytes', async () => {
    const html = await fetchHtml(bookUrl('en', freeFields()))
    // The day strip: one submit button per open trading date, the selected one marked, and the dates are
    // the ones the database holds rather than a calendar walk.
    const dayValues = allMatches(html, /class="be-book__day"[^>]*value="([^"]+)"/g)
    expect(dayValues.length).toBe(7)
    expect(dayValues[0]).toBe(freeDate)
    expect(dayValues).toEqual([...dayValues].sort())
    expect(html).toContain('aria-current="date"')
    expect(allMatches(html, /(aria-current="date")/g)).toHaveLength(1)

    // The first day's slot list, as a listbox of options, each submitting an instant.
    const starts = await offeredStarts(freeDate)
    expect(starts.length).toBeGreaterThan(5)
    expect(html).toContain('role="listbox"')
    const optionValues = allMatches(html, /role="option"[^>]*value="([^"]+)"/g)
    const byValue = allMatches(html, /value="(\d{13})"[^>]*role="option"/g)
    // Attribute order is React's, so both spellings are searched and the union is compared — asserting one
    // order would make this test a claim about the renderer rather than about the page.
    const rendered = [...new Set([...optionValues, ...byValue])].map(Number).sort((a, b) => a - b)
    expect(rendered, 'the served options are not the starts the engine offers').toEqual([...starts])
    // Every label is a wall clock in the premises' zone, and the first one is the engine's first start.
    for (const start of starts) expect(html).toContain(`>${wallClock(start)}<`)

    // Exactly one option is in the tab order: the roving tabindex, rendered by the SERVER, so the tab
    // order is right before hydration and does not move afterwards.
    expect(allMatches(html, /role="option"[^>]*(tabindex="0")/g)).toHaveLength(1)
    expect(allMatches(html, /(tabindex="0")/g)).toHaveLength(1)

    // Grouped morning/afternoon/evening, and only the parts of the day that have starts.
    const groups = allMatches(html, /data-slot-group="([a-z]+)"/g)
    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) expect(['morning', 'afternoon', 'evening']).toContain(group)
    expect(new Set(groups).size).toBe(groups.length)

    // Indexable: the registry declares it, and the absence of the header is what that means on the wire.
    expect((await fetchPath(bookUrl('en', freeFields()))).headers.get('x-robots-tag')).toBeNull()
  }, 120_000)

  it('renders the day strip and a named state, and no slot list, before the client is known', async () => {
    // The control for the case above, and the honest answer to the acceptance line: same-gender matching
    // is strict (B-AVAIL-05), so `queryAvailability` refuses with `requires_client_gender` until the page
    // knows who the treatment is for. A bare /book therefore carries the strip and a NAMED state — never
    // an empty container — and the slot list appears as soon as the two questions are answered. Both
    // renders are the server's; no JavaScript is involved in either.
    const bare = await fetchHtml(`${BASE}/book`)
    expect(allMatches(bare, /class="be-book__day"[^>]*value="([^"]+)"/g).length).toBe(7)
    expect(bare).not.toContain('role="option"')
    expect(bare).toContain('data-book-state="needs-treatment"')

    const chosen = await fetchHtml(bookUrl('en', { [BOOK_FIELDS.variant]: variantId }))
    expect(chosen).toContain('data-book-state="needs-gender"')
    expect(chosen).not.toContain('role="option"')
  }, 60_000)

  it('carries the choice into the next render, which is what makes step 3 work without JavaScript', async () => {
    const starts = await offeredStarts(freeDate)
    const chosen = starts[2] ?? 0
    const html = await fetchHtml(bookUrl('en', freeFields({ [BOOK_FIELDS.slot]: chosen })))
    // `aria-selected` on the chosen slot, and on that one alone.
    expect(allMatches(html, /(aria-selected="true")/g)).toHaveLength(1)
    expect(html).toContain('data-book-state="chosen"')
    expect(html).toContain(wallClock(chosen))
    expect(html).toContain(variantName)
    // And it now leads to step 4 (B-UI-02), which this unit deferred as "the continue-to-details step".
    expect(html).toContain('data-book-continue="details"')
    // And a slot from another day is not honoured: the summary is absent rather than wrong.
    const wrongDay = await fetchHtml(
      bookUrl('en', freeFields({ [BOOK_FIELDS.slot]: chosen - 7 * 86_400_000 })),
    )
    expect(wrongDay).not.toContain('data-book-state="chosen"')
    expect(allMatches(wrongDay, /(aria-selected="true")/g)).toHaveLength(0)
  }, 60_000)
})

describe('acceptance — the no-availability state is a designed state', () => {
  it('renders the nearest days, the other therapists and the waitlist, none of them empty', async () => {
    // The fixture is a therapist whose day is full on a floor that is not, so all three regions have
    // something to say. `offeredStarts` is the control: narrowed to A the engine offers nothing, and the
    // same day widened offers plenty — so "nothing free" is the ANSWER and not a fixture that forgot to
    // roster anybody.
    expect(await offeredStarts(fullDate, idOf('bui01-a'))).toEqual([])
    expect((await offeredStarts(fullDate)).length).toBeGreaterThan(5)

    const html = await fetchHtml(bookUrl('en', fullFields()))
    expect(html).toContain('data-book-state="no-availability"')
    expect(html).not.toContain('role="option"')

    for (const region of ['nearest-days', 'other-therapists', 'waitlist']) {
      expect(html, `the ${region} region is absent`).toContain(`data-book-region="${region}"`)
    }

    // The container is never rendered empty: each region carries text, not just a heading. Asserted by
    // reading the markup between one region marker and the next, so an empty `<section>` fails.
    const regions = html.split('data-book-region="').slice(1)
    expect(regions).toHaveLength(3)
    for (const region of regions) {
      const body = region.slice(0, region.indexOf('</section>'))
      expect(body).toMatch(/<h3[^>]*>[^<]+<\/h3>/)
      expect(
        /<(?:p|a|li)[^>]*>[^<]{4,}/.test(body),
        `a region rendered a heading and nothing else: ${body.slice(0, 200)}`,
      ).toBe(true)
    }

    // A nearer day, as a link that lands on that day's own strip.
    const nearest = allMatches(html, /class="be-action be-action--quiet" href="([^"]*date=[^"]*)"/g)
    expect(nearest.length).toBeGreaterThan(0)
    const followed = await fetchHtml(`${BASE}${(nearest[0] ?? '').replaceAll('&amp;', '&')}`)
    expect(followed).toContain('role="option"')

    // The other therapists: B and C by id, and A — the therapist asked for — absent from her own
    // alternatives. `availableTherapistIds` is what the count comes from, so a page counting the CHOSEN
    // therapist would report one alternative however many were free.
    const therapists = allMatches(html, /data-therapist="([0-9a-f-]{36})"/g)
    expect([...therapists].sort()).toEqual([idOf('bui01-b'), idOf('bui01-c')].sort())
    expect(therapists).not.toContain(idOf('bui01-a'))
    // No name, because nobody has one (ADR 0020) — and the internal reference is present for assistive
    // technology to tell the two apart, never as a display name.
    expect(html).toContain('Name not yet published')
    for (const reference of ['bui01-b', 'bui01-c']) {
      expect(html).toContain(`<span class="be-book__hidden">${reference}</span>`)
    }

    // The waitlist CTA, and the step it leads to. B-UI-01 left that step as a named state with the desk
    // telephone number and nothing behind it, because `joinWaitlist` needs a customer id; B-UI-02 put the
    // phone form there and the join behind it, so the state keeps its name and now leads somewhere. The
    // join itself is asserted end to end in `book-flow.itest.ts`.
    const cta = allMatches(html, /href="([^"]*step=waitlist[^"]*)"/g)
    expect(cta.length).toBeGreaterThan(0)
    const waitlist = await fetchHtml(`${BASE}${(cta[0] ?? '').replaceAll('&amp;', '&')}`)
    expect(waitlist).toContain('data-book-state="waitlist-step"')
    expect(waitlist).toContain('href="tel:')
    // Not a dead end any more: the step carries the phone form, and `after=waitlist` is what brings a
    // verified reader back to the list rather than to a booking.
    expect(waitlist).toContain('name="phone"')
    expect(waitlist).toContain('name="after" value="waitlist"')
  }, 180_000)

  it('renders the picker and no no-availability state on the day that has space', async () => {
    // The control. Without it "the three regions are present" would pass on a page that rendered them on
    // every request, including the ones with forty free times on them.
    const html = await fetchHtml(
      bookUrl('en', freeFields({ [BOOK_FIELDS.therapist]: idOf('bui01-a') })),
    )
    expect(html).not.toContain('data-book-state="no-availability"')
    expect(html).toContain('role="option"')
  }, 60_000)

  it('never renders a designed state as an empty container, in either locale', async () => {
    // Over every state this unit can reach, in both documents: a panel always carries a heading and a
    // sentence. An empty bordered box is the failure docs/09 §3 calls "a designed state, not an empty one".
    const states = [
      {},
      { [BOOK_FIELDS.variant]: variantId },
      freeFields(),
      fullFields(),
      fullFields({ [BOOK_FIELDS.step]: 'waitlist' }),
    ]
    for (const locale of ['en', 'ar'] as const) {
      for (const fields of states) {
        const html = await fetchHtml(bookUrl(locale, fields))
        const panels = html.split('class="be-book__state" data-book-state="').slice(1)
        for (const panel of panels) {
          const name = panel.slice(0, panel.indexOf('"'))
          const body = panel.slice(0, panel.indexOf('</div>'))
          expect(body, `${locale} ${name}: no heading`).toMatch(/<h2[^>]*>[^<]+<\/h2>/)
          expect(
            /<(?:p|a|li)[^>]*>[^<]{4,}/.test(body),
            `${locale} ${name}: a panel with a heading and nothing else`,
          ).toBe(true)
        }
        // Either a picker or a named state, on every URL. Never neither.
        expect(
          html.includes('role="listbox"') || panels.length > 0,
          `${locale} ${JSON.stringify(fields)}: neither a picker nor a named state`,
        ).toBe(true)
      }
    }
  }, 180_000)
})

describe('acceptance — SlotGrid renders 3, 4 and 6 columns at the three viewports', () => {
  async function columnsAt(cell: Cell): Promise<{ columns: number; container: number }> {
    const { page, context } = await open(bookUrl('en', freeFields()), cell)
    try {
      return await page.evaluate(() => {
        const slots = document.querySelector('.be-slots')
        const list = document.querySelector('.be-slots__list')
        if (slots === null || list === null) throw new Error('no slot grid on the page')
        return {
          // Counted from the RESOLVED track list: the number of columns the engine produced, not the
          // number the stylesheet asked for.
          columns: getComputedStyle(list)
            .gridTemplateColumns.trim()
            .split(/\s+/)
            .filter((track) => track !== '').length,
          container: Math.round(slots.getBoundingClientRect().width),
        }
      })
    } finally {
      await context.close()
    }
  }

  it('answers 3 / 4 / 6 at 390 / 768 / 1440, and reports the container width it did it at', async () => {
    expect(SLOT_GRID_COLUMNS.map((step) => step.columns)).toEqual([3, 4, 6])
    const measured = []
    for (const width of [390, 768, 1440]) {
      measured.push({
        width,
        ...(await columnsAt({ width, height: 900, theme: 'light', direction: 'ltr' })),
      })
    }
    expect(
      measured.map((cell) => cell.columns),
      JSON.stringify(measured),
    ).toEqual([3, 4, 6])
    // The container width is reported beside the count so a failure says which side of a declared
    // threshold the column landed on rather than only that the count was wrong.
    for (const cell of measured) {
      const step = [...SLOT_GRID_COLUMNS]
        .filter((candidate) => cell.container >= candidate.minInlineSize)
        .at(-1)
      expect(step?.columns, `${cell.width}px viewport, ${cell.container}px container`).toBe(
        cell.columns,
      )
    }
  }, 180_000)

  it('stays at three columns when the slot grid stops being a query container', async () => {
    // The control. Without `container-type` a 700px slot grid keeps the base three columns: the container
    // queries were doing the work, and this is what it looks like when they are not.
    const { page, context } = await open(bookUrl('en', freeFields()), {
      width: 1440,
      height: 900,
      theme: 'light',
      direction: 'ltr',
    })
    try {
      await page.addStyleTag({ content: '.be-slots { container-type: normal !important; }' })
      const columns = await page.evaluate(
        () =>
          getComputedStyle(document.querySelector('.be-slots__list') as Element)
            .gridTemplateColumns.trim()
            .split(/\s+/)
            .filter((track) => track !== '').length,
      )
      expect(columns).toBe(3)
    } finally {
      await context.close()
    }
  }, 60_000)
})

describe('acceptance — every control is big enough to hit and every input big enough not to zoom', () => {
  /** Everything a finger hits, plus the roles this page introduces. */
  const CONTROL_SELECTOR = 'a, button, [role="button"], [role="option"], input, select, summary'

  it('clears 48x48 with an 8px gap at 390px, over every state the page renders', async () => {
    for (const fields of [{}, freeFields(), fullFields()]) {
      const { page, context } = await open(bookUrl('en', fields), {
        width: 390,
        height: 844,
        theme: 'light',
        direction: 'ltr',
      })
      try {
        const findings = await page.evaluate(auditTouchTargetsInPage, {
          ...touchTargetInputFor(390),
          selector: CONTROL_SELECTOR,
        })
        expect(findings, `${JSON.stringify(fields)}: ${JSON.stringify(findings)}`).toEqual([])
      } finally {
        await context.close()
      }
    }
  }, 180_000)

  it('names a 32px control and a 4px gap when they are put on this page', async () => {
    // The control, with the same rules that just reported the page clean.
    const { page, context } = await open(bookUrl('en', freeFields()), {
      width: 390,
      height: 844,
      theme: 'light',
      direction: 'ltr',
    })
    try {
      await page.evaluate(() => {
        const column = document.querySelector('.be-book__column')
        if (column === null) throw new Error('no booking column')
        const holder = document.createElement('div')
        holder.style.cssText = 'display:flex;gap:4px;padding:40px'
        for (const [size, label] of [
          [32, '11:00'],
          [48, '12:30'],
          [48, '13:50'],
        ] as const) {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = label
          button.style.cssText = `width:${size}px;height:${size}px;min-height:${size}px;padding:0`
          holder.append(button)
        }
        column.append(holder)
      })
      const findings = await page.evaluate(auditTouchTargetsInPage, {
        ...touchTargetInputFor(390),
        selector: CONTROL_SELECTOR,
      })
      expect(findings.map((finding) => finding.rule)).toContain('touch-target-too-small')
      expect(findings.map((finding) => finding.rule)).toContain('touch-target-gap')
    } finally {
      await context.close()
    }
  }, 60_000)

  it('gives every input a computed font size of at least 16px, or iOS zooms the layout away', async () => {
    const { page, context } = await open(bookUrl('en', freeFields()), {
      width: 390,
      height: 844,
      theme: 'light',
      direction: 'ltr',
    })
    try {
      const sizes = await page.evaluate(() =>
        [...document.querySelectorAll('input, select, textarea, button')].map((element) => ({
          where: `${element.tagName.toLowerCase()}#${element.id}.${element.className}`,
          px: Number.parseFloat(getComputedStyle(element).fontSize),
        })),
      )
      expect(sizes.length).toBeGreaterThan(5)
      const small = sizes.filter((entry) => entry.px < 16)
      expect(small, `under 16px: ${JSON.stringify(small)}`).toEqual([])

      // The control: the same walk over a deliberately 14px select finds it. Without this the assertion
      // above would pass on a selector that had stopped matching anything.
      const caught = await page.evaluate(() => {
        const select = document.querySelector('select')
        if (select === null) throw new Error('no select on the page')
        select.style.fontSize = '14px'
        return [...document.querySelectorAll('input, select, textarea, button')].filter(
          (element) => Number.parseFloat(getComputedStyle(element).fontSize) < 16,
        ).length
      })
      expect(caught).toBe(1)
    } finally {
      await context.close()
    }
  }, 60_000)
})

describe('acceptance — the picker is usable by keyboard alone, and axe finds nothing blocking', () => {
  it('moves a roving tabindex across the whole grid, one tab stop, mirrored in Arabic', async () => {
    for (const locale of ['en', 'ar'] as const) {
      const { page, context } = await open(bookUrl(locale, freeFields()), {
        width: 1440,
        height: 900,
        theme: 'light',
        direction: locale === 'ar' ? 'rtl' : 'ltr',
      })
      try {
        const options = page.locator('[role="option"]')
        const total = await options.count()
        expect(total, locale).toBeGreaterThan(5)
        // One tab stop for the whole grid, not one per slot.
        expect(await page.locator('[role="option"][tabindex="0"]').count(), locale).toBe(1)
        expect(await page.locator('[role="option"][tabindex="-1"]').count(), locale).toBe(total - 1)

        const indexOfFocus = async (): Promise<number> =>
          await page.evaluate(() =>
            [...document.querySelectorAll('[role="option"]')].indexOf(
              document.activeElement as Element,
            ),
          )

        await options.nth(0).focus()
        expect(await indexOfFocus(), locale).toBe(0)
        // ArrowDown is direction-independent: it moves forward in both documents.
        await page.keyboard.press('ArrowDown')
        expect(await indexOfFocus(), locale).toBe(1)
        // And the tab stop moved with the focus, which is what a roving tabindex is.
        expect(
          await page.evaluate(() =>
            (document.activeElement as HTMLElement).getAttribute('tabindex'),
          ),
          locale,
        ).toBe('0')
        expect(await page.locator('[role="option"][tabindex="0"]').count(), locale).toBe(1)

        // ArrowRight is mirrored: forward in an LTR document, backward in an RTL one. This is the half a
        // translated-but-not-mirrored page gets wrong, and it is invisible in code review.
        await page.keyboard.press('ArrowRight')
        expect(await indexOfFocus(), `${locale}: ArrowRight`).toBe(locale === 'ar' ? 0 : 2)

        await page.keyboard.press('End')
        expect(await indexOfFocus(), locale).toBe(total - 1)
        await page.keyboard.press('Home')
        expect(await indexOfFocus(), locale).toBe(0)
      } finally {
        await context.close()
      }
    }
  }, 180_000)

  it('announces the selected date in a live region, which is empty until it has something to announce', async () => {
    const { page, context } = await open(bookUrl('en', freeFields()))
    try {
      const live = page.locator('[role="status"][aria-live="polite"]')
      expect(await live.count()).toBe(1)
      // Filled after hydration: a region that already holds its text has not changed, so nothing is
      // announced. The served bytes carry it empty on purpose.
      const html = await fetchHtml(bookUrl('en', freeFields()))
      expect(html).toContain('role="status"')
      expect(html).toMatch(/role="status"[^>]*aria-live="polite"[^>]*>\s*<\/div>/)
      // Waited for rather than polled with an assertion, so a failure says the region never filled
      // rather than reporting an empty string a dozen times.
      await page.waitForFunction(
        () => (document.querySelector('[role="status"]')?.textContent ?? '').trim().length > 0,
        undefined,
        { timeout: 20_000 },
      )
      const announced = (await live.textContent())?.trim() ?? ''
      // It names the day the picker is showing, which is the claim docs/09 §3 makes.
      const heading = (await page.locator('h2.be-book__region-heading').first().textContent()) ?? ''
      const day = heading.replace(/^Times on /, '')
      expect(announced).toContain(day)
      // Clipped, not hidden: it must stay in the accessibility tree and must move no pixels.
      const box = await live.boundingBox()
      expect(box?.width ?? 0).toBeLessThan(2)
    } finally {
      await context.close()
    }
  }, 60_000)

  it('reports zero serious or critical axe violations across the matrix corners', async () => {
    for (const cell of [
      { width: 390, height: 844, theme: 'light', direction: 'ltr' },
      { width: 1440, height: 900, theme: 'dark', direction: 'rtl' },
    ] as const satisfies readonly Cell[]) {
      for (const fields of [freeFields(), fullFields()]) {
        const { page, context } = await open(
          bookUrl(cell.direction === 'rtl' ? 'ar' : 'en', fields),
          cell,
        )
        try {
          const result = await auditPage(page, {
            page: CAPTURE_LABEL,
            viewport: {
              name: `${cell.width}`,
              width: cell.width,
              height: cell.height,
              scale: 1,
              why: 'axe',
            },
            theme: cell.theme,
            direction: cell.direction,
          })
          const blocking = blockingViolations(result.violations)
          expect(
            blocking.map(describeViolation),
            `${cell.width}/${cell.theme}/${cell.direction}`,
          ).toEqual([])
        } finally {
          await context.close()
        }
      }
    }
  }, 300_000)

  it('reports a violation by rule id when one is put on this page', async () => {
    // The control (ADR 0003): a rule id, not a count. A fixture rejected by some other rule while the one
    // under test has quietly stopped matching anything is how a gate reports PASS forever.
    const { page, context } = await open(bookUrl('en', freeFields()))
    try {
      await page.evaluate(() => {
        const column = document.querySelector('.be-book__column')
        if (column === null) throw new Error('no booking column')
        const nameless = document.createElement('button')
        nameless.type = 'button'
        column.append(nameless)
      })
      const result = await auditPage(page, {
        page: CAPTURE_LABEL,
        viewport: { name: '1440', width: 1440, height: 900, scale: 1, why: 'axe control' },
        theme: 'light',
        direction: 'ltr',
      })
      expect(blockingViolations(result.violations).map((violation) => violation.id)).toContain(
        'button-name',
      )
    } finally {
      await context.close()
    }
  }, 60_000)
})

describe('acceptance — no text-bearing element computes a decorative foreground', () => {
  /**
   * The three tokens docs/14 §5 names, resolved in the theme under test, minus any value the palette also
   * publishes as a text-bearing token in that theme.
   *
   * The subtraction is not a loophole, it is the palette: in dark mode `--color-decor-gold` and
   * `--color-accent-gold` are the SAME hex, because docs/08 §2 flips the accent polarity — the bright brand
   * gold measures 2.90:1 in light and 6.19:1 in dark, and there it is the primary text accent. Comparing
   * computed colours without this would report every legitimate dark-mode accent as a defect, and a gate
   * that fires on correct code is a gate somebody suppresses.
   */
  async function forbiddenValues(page: Page): Promise<readonly string[]> {
    return await page.evaluate(
      ({ decorative, textBearing }: { decorative: string[]; textBearing: string[] }) => {
        const probe = document.createElement('span')
        document.body.append(probe)
        const resolve = (token: string): string => {
          probe.style.color = `var(--color-${token})`
          return getComputedStyle(probe).color
        }
        const permitted = new Set(textBearing.map(resolve))
        const forbidden = new Set(decorative.map(resolve))
        probe.remove()
        return [...forbidden].filter((value) => !permitted.has(value))
      },
      {
        decorative: ['surface-clay', 'decor-gold', 'decor-tan'],
        textBearing: [...TEXT_BEARING_TOKENS],
      },
    )
  }

  /** Every element with text of its own, with the colour the engine resolved for it. */
  async function textColours(page: Page): Promise<readonly { where: string; colour: string }[]> {
    return await page.evaluate(() => {
      const found: { where: string; colour: string }[] = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      const seen = new Set<Element>()
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if ((node.textContent ?? '').trim() === '') continue
        const element = node.parentElement
        if (element === null || seen.has(element)) continue
        seen.add(element)
        if (element.closest('style, script, head') !== null) continue
        found.push({
          where: `${element.tagName.toLowerCase()}.${String(element.className).split(/\s+/)[0] ?? ''} "${(node.textContent ?? '').trim().slice(0, 30)}"`,
          colour: getComputedStyle(element).color,
        })
      }
      return found
    })
  }

  it('walks every text node in both themes and finds none', async () => {
    // The three are surfaces (`DECORATIVE_ONLY_TOKENS`), and this is the assertion docs/14 §5 asks for.
    for (const token of ['surface-clay', 'decor-gold', 'decor-tan']) {
      expect(DECORATIVE_ONLY_TOKENS, token).toContain(token)
      expect(TEXT_BEARING_TOKENS, token).not.toContain(token)
    }
    for (const theme of THEMES) {
      for (const fields of [freeFields(), fullFields()]) {
        const { page, context } = await open(bookUrl('en', fields), {
          width: 1440,
          height: 900,
          theme,
          direction: 'ltr',
        })
        try {
          const forbidden = new Set(await forbiddenValues(page))
          expect(forbidden.size, theme).toBeGreaterThan(0)
          const nodes = await textColours(page)
          expect(nodes.length, theme).toBeGreaterThan(20)
          const offenders = nodes.filter((node) => forbidden.has(node.colour))
          expect(
            offenders,
            `${theme}: text on a decorative token — ${JSON.stringify(offenders)}`,
          ).toEqual([])
        } finally {
          await context.close()
        }
      }
    }
  }, 300_000)

  it('names the element when one is given the decorative gold', async () => {
    // The control. A walk that matched nothing would satisfy the case above in every theme, which is
    // exactly how a colour gate becomes decoration.
    const { page, context } = await open(bookUrl('en', freeFields()))
    try {
      await page.evaluate(() => {
        const heading = document.querySelector('h1')
        if (heading === null) throw new Error('no heading')
        heading.style.color = 'var(--color-decor-gold)'
      })
      const forbidden = new Set(await forbiddenValues(page))
      const offenders = (await textColours(page)).filter((node) => forbidden.has(node.colour))
      expect(offenders.length).toBeGreaterThan(0)
      expect(offenders[0]?.where).toContain('h1')
    } finally {
      await context.close()
    }
  }, 60_000)
})

describe('acceptance — the page renders identically twice, and RTL is mirrored rather than translated', () => {
  interface Shot {
    readonly png: Uint8Array
    readonly attemptsUsed: number
    /** Read rather than compared with a hex: a literal here would be an un-tokened colour. */
    readonly backgroundLuminance: number
  }

  /**
   * One cell, captured until the page agrees with itself twice running.
   *
   * `captureUntilStable` IS the byte-identical claim, and taking both captures from **one settled page** is
   * the part that matters. Two captures from two separate navigations is a different and stronger claim —
   * that a fresh render rasterises identically — and it is not true on a loaded four-core box: it failed
   * here on `390-dark-ltr` by a single byte while every other cell agreed, which is the flake the harness's
   * own note says three earlier attempts chased by other means. `breakpoint-preview.itest.ts` makes exactly
   * this claim in exactly this way, and the determinism half is intact either way: anything clock-derived
   * or freshly generated in the render would mean no two CONSECUTIVE captures ever agreed, and the helper
   * would exhaust its attempts and throw `[screenshot-never-stabilised]` naming this label.
   */
  async function shoot(cell: Cell): Promise<Shot> {
    const url = bookUrl(cell.direction === 'rtl' ? 'ar' : 'en', freeFields())
    const { page, context } = await open(url, cell)
    try {
      // The render really is the cell it claims to be. Without this, twelve identical light LTR captures
      // would satisfy the count and the labels would be the only thing that differed.
      const state = await page.evaluate(() => ({
        theme: document.documentElement.getAttribute('data-theme'),
        dir: document.documentElement.getAttribute('dir'),
        width: globalThis.innerWidth,
        luminance: (() => {
          const colour = globalThis.getComputedStyle(document.body).backgroundColor
          const [r = 0, g = 0, b = 0] = (colour.match(/\d+(\.\d+)?/g) ?? []).map(Number)
          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        })(),
      }))
      expect(state.theme, url).toBe(cell.theme)
      expect(state.dir, url).toBe(cell.direction)
      expect(state.width, url).toBe(cell.width)
      const stable = await captureUntilStable(
        async () => await page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' }),
        { label: `${CAPTURE_LABEL}-${cell.width}-${cell.theme}-${cell.direction}` },
      )
      return {
        png: stable.png,
        attemptsUsed: stable.attemptsUsed,
        backgroundLuminance: state.luminance,
      }
    } finally {
      await context.close()
    }
  }

  it('agrees with itself twice running in all 12 cells, and renders 12 different images', async () => {
    expect(VIEWPORTS).toHaveLength(3)
    expect(THEMES).toHaveLength(2)
    expect(DIRECTIONS).toHaveLength(2)
    const cells: Cell[] = VIEWPORTS.flatMap((viewport) =>
      THEMES.flatMap((theme) =>
        DIRECTIONS.map((direction) => ({
          width: viewport.width,
          height: viewport.height,
          theme,
          direction,
        })),
      ),
    )
    expect(cells).toHaveLength(12)
    const distinct = new Set<string>()
    const luminance = new Map<string, number>()
    for (const cell of cells) {
      const name = `${cell.width}-${cell.theme}-${cell.direction}`
      const shot = await shoot(cell)
      expect(shot.png.byteLength, name).toBeGreaterThan(1000)
      // Settled in a handful of attempts. Reported rather than implied: a cell that needed all five is a
      // cell on its way to being non-deterministic, and this is where that would first be visible.
      expect(shot.attemptsUsed, `${name} settled in`).toBeLessThanOrEqual(5)
      // Hashed WHOLE, not by a prefix: the first bytes of a PNG are the signature and the IHDR, so two
      // images of the same dimensions share them and a prefix key would collapse four cells into one.
      distinct.add(createHash('sha256').update(shot.png).digest('hex'))
      luminance.set(name, shot.backgroundLuminance)
    }
    // Twelve renders, twelve different images: a matrix that produced one image twelve times would
    // satisfy every assertion above.
    expect(distinct.size).toBe(12)
    // And the theme axis is a rendered difference rather than a filename: the dark cell resolved a darker
    // ground at every viewport, in both directions.
    for (const cell of cells.filter((candidate) => candidate.theme === 'light')) {
      const light = luminance.get(`${cell.width}-light-${cell.direction}`) ?? 0
      const dark = luminance.get(`${cell.width}-dark-${cell.direction}`) ?? 0
      expect(dark, `${cell.width}-${cell.direction}: dark is darker than light`).toBeLessThan(light)
    }
  }, 850_000)

  it('mirrors the layout rather than translating it', async () => {
    // The axis most likely to be skipped and most likely to be wrong. A page that is translated but not
    // mirrored has Arabic words in an unchanged layout, which no code review catches and a position does.
    const positions: Record<string, { day: number; column: number; direction: string }> = {}
    for (const [locale, direction] of [
      ['en', 'ltr'],
      ['ar', 'rtl'],
    ] as const) {
      const { page, context } = await open(bookUrl(locale, freeFields()), {
        width: 1440,
        height: 900,
        theme: 'light',
        direction,
      })
      try {
        positions[locale] = await page.evaluate(() => {
          const day = document.querySelector('.be-book__day')
          const column = document.querySelector('.be-book__column')
          if (day === null || column === null) throw new Error('no picker on the page')
          return {
            day: Math.round(day.getBoundingClientRect().left),
            column: Math.round(column.getBoundingClientRect().left),
            direction: getComputedStyle(document.body).direction,
          }
        })
      } finally {
        await context.close()
      }
    }
    const english = positions['en']
    const arabic = positions['ar']
    if (english === undefined || arabic === undefined) throw new Error('a locale did not render')
    expect(english.direction).toBe('ltr')
    expect(arabic.direction).toBe('rtl')
    // The times column sits on the far side of the form in one document and the near side in the other:
    // something changed side, which is what mirrored means.
    expect(arabic.column).not.toBe(english.column)
    expect(english.column).toBeGreaterThan(400)
    expect(arabic.column).toBeLessThan(english.column)
    // And the first day of the strip starts on the other edge of its own row.
    expect(arabic.day).toBeGreaterThan(english.day)
  }, 120_000)
})
