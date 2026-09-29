import { ASIA_DUBAI, leaveCoveragePeriod, localDate, localTime, type Role } from '@berelax/core'
import { createConnection, type Sql, writeLeaveRequest } from '@berelax/db'
import { createFixturePrincipal } from '@berelax/fixtures'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import { installAdminBrowserCookie } from '@berelax/harness/admin-session'
import { DETERMINISTIC_LAUNCH_ARGS } from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADMIN_SESSION_COOKIE } from './session-cookie.ts'

/**
 * P-HR-09's screen, driven against the built application.
 *
 * Four claims live here and nowhere else, because none of them can be checked by reading a view object:
 *
 *   1. **The narrowing is enforced by the RUNNING route, on the SESSION's role.** A marketer is served the
 *      page with the conflict report withheld, and a manager is served it with the report. The pure render
 *      test can only prove that a view with `maySeeConflicts: false` prints the withheld wording — it cannot
 *      prove that the route ever builds such a view, which is the half that matters.
 *
 *      Every case here used to say `?role=marketer` on the URL, and W-SYS-11 removed that line from the
 *      route: the role is the signed-in principal's, read through `guardAdminRoute`, and a repository-wide
 *      scan now refuses any query parameter that chooses a principal, a role or a permission. This file was
 *      not updated with it, so seven of its nine cases were served `/login` and failed — and the two that
 *      passed are the more interesting half: `serves the request with the robots header the registry
 *      declares` asserted 200, `text/html`, noindex and no-store, every one of which the SIGN-IN page also
 *      answers. It passed against a document that has nothing to do with this screen. It now also asserts a
 *      field only the leave page prints, so it cannot pass on the login page again (ADR 0002).
 *
 *      One principal per role is minted in `beforeAll` and the cookie goes on each request, rather than
 *      patching `globalThis.fetch` the way the single-role suites do: this file's subject IS the difference
 *      between four roles, so it needs four cookies in one process.
 *   2. **The noindex header is the proxy's**, derived from the registry's `/hr` prefix, and not something the
 *      document claims about itself.
 *   3. **The period is printed as instants, and the leave day ends at 02:00 on the following date.** Read off
 *      the rendered document, because the alignment is invisible to anybody looking at a date.
 *   4. **axe reports nothing serious or critical on a rendered DOM**, with a known-bad fixture proving the
 *      audit fires (ADR 0003).
 *
 * ## Isolation (brief rule 12)
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind. So this
 * file creates its own employee, its own `business_day` rows on dates nobody else uses, and one pending leave
 * request; it asserts only about that request's id; and it removes the rows it created in `afterAll`. It
 * cannot remove the leave request — 0030 revokes DELETE on `leave_request` from the application role, because
 * leave is cancelled and never deleted — so the employee it belongs to stays with it, which is why the
 * employee is minted per run rather than shared.
 *
 * No employee here has a name (brief rule 10).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/**
 * 2086 is a year no other suite uses, and the dates are fixed rather than derived from "now".
 *
 * A suite that skipped because the calendar had moved would be the vacuous pass ADR 0003 exists to prevent,
 * and these dates exist because this file inserts them.
 */
const LEAVE_DAY = '2086-03-17'
const DATES = [LEAVE_DAY]

/** The staff reference is minted per run, so a run that failed part-way cannot collide with the next. */
const MARKER = `phr09-web-${Math.floor(Math.random() * 1_000_000)}`

let BASE = ''
let server: WebServer
let browser: Browser
let sql: Sql
let employeeId = ''
let leaveRequestId = ''
let restoreAdminBrowser: (() => void) | undefined
/** One admin session per role this file asserts about, by role name. */
const cookies = new Map<Role, string>()
/**
 * The principals themselves, so `afterAll` can remove them.
 *
 * Four employee rows, four credentials and four sessions per run, and `employee.itest.ts` counts the
 * provisional employees the panel lists — a suite that mints principals and leaves them is a suite that
 * changes another's answer.
 */
const principals: { cleanup: () => Promise<void> }[] = []

/** The request init that presents `role`'s session. Throws rather than silently fetching as nobody. */
function as(role: Role): RequestInit {
  const cookie = cookies.get(role)
  if (cookie === undefined) {
    throw new Error(
      `No fixture session was minted for ${role}, so this case would fetch as nobody.`,
    )
  }
  return { headers: { cookie } }
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  // 11:00–02:00 Asia/Dubai, the window the whole system is built around. `shift.trading_date` and
  // `appointment.trading_date` are foreign keys into this table, so no fixture can invent a date the
  // premises does not trade on.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    select d::date, (d::date || ' 11:00:00+04')::timestamptz,
           ((d::date + 1) || ' 02:00:00+04')::timestamptz, 'weekly'
      from unnest(${DATES}::date[]) as d
    on conflict (trading_date) do nothing
  `

  const [employee] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, notes)
    values (${`P-HR-09 WEB ${MARKER}`}, 'female', date '2080-01-01', ${MARKER})
    returning id::text as id
  `
  employeeId = (employee as { id: string }).id
  await sql`
    insert into employee_skill (employee_id, skill) values (${employeeId}::uuid, 'asian_style')
    on conflict do nothing
  `

  // The period comes from `leaveCoveragePeriod`, never from two instants written out here: that function is
  // the one place that decides a leave day covers its trading session, and a fixture with its own bounds
  // would be the second statement this whole unit exists not to have.
  const hoursFor = () => ({ open: localTime('11:00'), close: localTime('02:00') })
  const period = leaveCoveragePeriod({
    from: localDate(LEAVE_DAY),
    to: localDate(LEAVE_DAY),
    hoursFor,
    zone: ASIA_DUBAI,
  })
  const request = await writeLeaveRequest(sql, {
    employeeId,
    kind: 'annual',
    startsAt: Number(period.startsAt),
    endsAt: Number(period.endsAt),
    reason: 'P-HR-09 web itest',
  })
  leaveRequestId = request.id

  server = await startWebServer({
    suite: 'leave-approval',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: '/robots.txt',
    readyWithinMs: 90_000,
    env: {
      // The route calls `loadConfig()`. Declared rather than assumed, the note every admin suite makes: a
      // local run that exported only TEST_DATABASE_URL gets a 503 that reads like a broken route.
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL: url,
    },
  })
  BASE = server.origin
  /*
    A session per role, and the browser's separately.

    `installAdminBrowserCookie` patches `chromium.launch`, so it runs BEFORE the launch below — it has to
    reach the browser that line is about to make. `manager` is the browser's role because the two Playwright
    cases audit the page with the conflict report present, which is the widest document this screen renders.
  */
  for (const role of ['marketer', 'manager', 'owner', 'therapist'] as const) {
    const principal = await createFixturePrincipal(sql, { role })
    principals.push(principal)
    cookies.set(role, `${ADMIN_SESSION_COOKIE}=${principal.sessionToken ?? ''}`)
  }
  const managerToken = (cookies.get('manager') ?? '').split('=')[1] ?? ''
  restoreAdminBrowser = installAdminBrowserCookie(chromium, {
    origin: BASE,
    name: ADMIN_SESSION_COOKIE,
    token: managerToken,
  })
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 300_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop()
  // Restored before the database work, so a failure there still leaves `chromium.launch` as it was found.
  restoreAdminBrowser?.()
  for (const principal of principals) await principal.cleanup()
  if (employeeId !== '') {
    await sql`delete from employee_skill where employee_id = ${employeeId}::uuid`
  }
  // `leave_request` cannot be deleted by the application role (0030), so the employee it references stays
  // too. Both are minted per run and named with this file's marker, which is what keeps that harmless.
  await sql`delete from business_day where trading_date = any(${DATES}::date[])`
  await sql?.end({ timeout: 5 })
})

const pagePath = (query: string = ''): string => `/hr/leave/${leaveRequestId}${query}`

async function withPage<T>(path: string, body: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-AE',
    timezoneId: 'Asia/Dubai',
    reducedMotion: 'reduce',
  })
  try {
    // The esbuild `keepNames` shim: Playwright serialises a callback's compiled source into the page.
    await context.addInitScript({
      content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
    })
    const page = await context.newPage()
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
    return await body(page)
  } finally {
    await context.close()
  }
}

describe('acceptance — the route answers HTML, noindex, and the period as instants', () => {
  it('serves the request with the robots header the registry declares', async () => {
    const response = await fetch(`${BASE}${pagePath()}`, as('manager'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    // Asserted here and not only in the period case below: 200, `text/html`, noindex and no-store are all
    // true of the SIGN-IN page too, which is what this case was passing against while the other seven
    // failed. A field only this screen prints is what makes the four headers above a claim about it.
    expect(await response.clone().text()).toContain('data-field="tradingDates"')
    // Derived from the registry by the proxy: `/hr` is a prefix in ADMIN_GROUP_PREFIXES, so a screen added
    // beside this one arrives noindex rather than needing to be remembered.
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(response.headers.get('cache-control')).toContain('no-store')
  }, 60_000)

  it('prints both ends of the stored period, and the leave day ends at 02:00 the NEXT date', async () => {
    const html = await (await fetch(`${BASE}${pagePath()}`, as('manager'))).text()
    // The claim the whole unit rests on, read off the document: a leave day on the 17th runs to 02:00 on
    // the 18th. The control is the second assertion — a calendar-aligned day would end at 00:00 on the
    // 18th, and a naive one would end at 23:59 on the 17th.
    expect(html).toContain('2086-03-17 11:00 to 2086-03-18 02:00')
    expect(html).not.toContain('2086-03-18 00:00')
    expect(html).toContain('data-field="tradingDates">2086-03-17 to 2086-03-17<')
  }, 60_000)

  it('answers 404 for a request that does not exist, and 400 for a role that is not a role', async () => {
    const missing = await fetch(
      `${BASE}/hr/leave/00000000-0000-7000-8000-000000000000`,
      as('manager'),
    )
    expect(missing.status).toBe(404)
    /*
      The 400 half was `?role=supervisor` and cannot be written over HTTP any more, so what replaced it is
      the reason why — not a deletion.

      The route still refuses a role it does not know (`is not a role this system knows`), deliberately, and
      that branch is now unreachable through a request: the role comes from `staff_credential.role`, and
      `staff_credential_role_is_a_known_role` is a CHECK over the same eight names `ROLES` declares. So the
      claim this case can still make is that the database is what makes the branch unreachable. Asserted by
      the constraint's NAME, because a refusal for some other reason — a bad hash, a missing employee —
      would otherwise read as this one.
    */
    const refused = await sql`
      insert into staff_credential (employee_id, role, password_hash)
      values (${employeeId}::uuid, 'supervisor', 'scrypt$notused')
    `.then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    )
    expect(refused, 'the database accepted a role that is not a role').not.toBeNull()
    expect(refused?.code).toBe('23514')
    expect(refused?.message).toContain('staff_credential_role_is_a_known_role')
  }, 60_000)
})

describe('acceptance — the session\u2019s role narrows and never widens, decided on the server', () => {
  it('withholds the conflict report from a marketer and serves it to a manager', async () => {
    const asMarketer = await (await fetch(`${BASE}${pagePath()}`, as('marketer'))).text()
    const asManager = await (await fetch(`${BASE}${pagePath()}`, as('manager'))).text()
    // Both halves, because either alone is satisfied by a route that withholds from everybody or from
    // nobody. The report itself is empty for this request — no appointment overlaps it — so the assertion is
    // about the SECTION being withheld rather than about a row count, which is the distinction that matters:
    // a count is enough to tell a marketer whether a named colleague has bookings.
    expect(asMarketer).toContain('data-conflicts="withheld"')
    expect(asMarketer).toContain('may not see which clients have appointments')
    expect(asManager).toContain('data-conflicts="0"')
    expect(asManager).not.toContain('data-conflicts="withheld"')
  }, 60_000)

  it('does not widen for an owner: the ceiling is a manager, and the page has no write either way', async () => {
    const asOwner = await (await fetch(`${BASE}${pagePath()}`, as('owner'))).text()
    // The owner holds every permission, so if the intersection were missing this page would report the same
    // capabilities either way — which it does, because a manager holds both of them. What must NOT appear at
    // any role is a control: the page is read-only, and no role can make it otherwise.
    expect(asOwner).toContain('data-field="writes"')
    expect(asOwner).toContain('Read-only.')
    expect(asOwner).not.toContain('<form')
    expect(asOwner).not.toContain('<button')
  }, 60_000)

  it('shows a therapist the page without the approval or override authority', async () => {
    const asTherapist = await (await fetch(`${BASE}${pagePath()}`, as('therapist'))).text()
    expect(asTherapist).toContain('does not hold the approval permission')
    expect(asTherapist).toContain('does not hold the override authority')
  }, 60_000)
})

describe('acceptance — axe reports nothing serious or critical, and the audit fires', () => {
  it('audits the rendered page clean', async () => {
    const violations = await withPage(pagePath(), async (page) => {
      const result = await auditPage(page, {
        page: '/hr/leave/[id]',
        viewport: { name: '1440', width: 1440, height: 900, scale: 1, why: 'P-HR-09 acceptance' },
        theme: 'light',
        direction: 'ltr',
      })
      return blockingViolations(result.violations)
    })
    expect(violations.map(describeViolation)).toEqual([])
  }, 120_000)

  it('and the audit is not vacuous: a deliberately broken DOM is reported', async () => {
    // The control (ADR 0003). An image with no alternative text is a serious violation, injected into the
    // rendered document, so a clean answer above means the audit ran rather than that it found nothing to
    // look at.
    const violations = await withPage(pagePath(), async (page) => {
      await page.evaluate(() => {
        const broken = document.createElement('img')
        broken.src =
          'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7'
        document.querySelector('main')?.append(broken)
      })
      const result = await auditPage(page, {
        page: '/hr/leave/[id] (known-bad)',
        viewport: { name: '1440', width: 1440, height: 900, scale: 1, why: 'P-HR-09 control' },
        theme: 'light',
        direction: 'ltr',
      })
      return blockingViolations(result.violations)
    })
    expect(violations.map((violation) => violation.id)).toContain('image-alt')
  }, 120_000)
})

describe('acceptance — ?dir=rtl re-renders the same document mirrored', () => {
  it('sets dir on the html element', async () => {
    // `?dir=` stays a query parameter and is the one that may: direction is a rendering choice, not a
    // principal, a role or a permission, which is the distinction W-SYS-11's scan draws.
    const mirrored = await (await fetch(`${BASE}${pagePath('?dir=rtl')}`, as('manager'))).text()
    expect(mirrored).toContain('<html lang="en" dir="rtl">')
    const upright = await (await fetch(`${BASE}${pagePath()}`, as('manager'))).text()
    expect(upright).toContain('<html lang="en" dir="ltr">')
  }, 60_000)
})
