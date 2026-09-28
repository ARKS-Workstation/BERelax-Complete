import { createConnection, readMessagingControls, type Sql } from '@berelax/db'
import { createFixturePrincipal, type FixturePrincipal } from '@berelax/fixtures'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import { installAdminBrowserCookie } from '@berelax/harness/admin-session'
import { DETERMINISTIC_LAUNCH_ARGS } from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADMIN_SESSION_COOKIE } from './session-cookie.ts'

/**
 * C-AUTO-05's two acceptance lines that only a running application can settle.
 *
 * *"Permission test: manager and owner may toggle the switch; receptionist and marketer are refused; every
 * toggle writes an audit_event carrying actor, direction and reason"* and *"Playwright: the agent console
 * shows the switch with its last-changed actor and timestamp, and axe reports zero serious or critical
 * violations on that screen"*.
 *
 * ## Why the permission half is driven over HTTP rather than as a function call
 *
 * `assertMayToggleMessagingControl` is unit-tested in `packages/messaging/src/gate/kill-switch.test.ts`, and
 * that is the right place for the rule. What that test cannot say is whether the SCREEN applies it: a route
 * that forgot the call would pass every unit assertion in the build. So here the refusal and the permission
 * are **status codes** — 403 for the receptionist and the marketer, 200 for the owner and the manager — on a
 * real POST carrying each role's own session cookie, and the audit rows are counted in the database
 * afterwards. That is the same reason `session.itest.ts` exists for the guard.
 *
 * Four principals rather than one with a query parameter: W-SYS-11 removed `?role=`, and a role that could be
 * asserted from the URL would be a role anybody could claim.
 *
 * ## The console, and the two facts the acceptance line names
 *
 * The screen has to show WHO last changed the switch and WHEN. A switch whose state you can see and whose
 * owner you cannot is a switch nobody takes back off — the person looking at it does not know whether it was
 * engaged an hour ago for a complaint or three weeks ago by somebody who has left. Both are read out of the
 * rendered DOM by `data-actor` and `data-changed-at`, and both are compared against the row the toggle wrote
 * rather than against a literal: a screen asserted against a hard-coded timestamp would keep passing after it
 * stopped reading the row.
 *
 * ## Cleanup
 *
 * `messaging_control` refuses DELETE (`ZY084`) and `audit_event` is append-only (ADR 0008), so nothing here
 * can be removed. Every count is a delta narrowed to this suite's principals, and the switch is put back to
 * disengaged in a `finally` — the row is shared with every promotional send in the database, and a suite that
 * left it engaged would refuse the interpreter's promotional cases in a file nobody touched.
 */
let BASE = ''
let server: WebServer
let browser: Browser
let sql: Sql

const PATH = '/messaging/controls'

/** One principal per role under test. Roles, not query parameters — see the header. */
const ROLES = ['owner', 'manager', 'receptionist', 'marketer'] as const
type TestRole = (typeof ROLES)[number]

const principals = new Map<TestRole, FixturePrincipal>()
let restoreAdminBrowser: () => void = () => {}

const cookieFor = (role: TestRole): string =>
  `${ADMIN_SESSION_COOKIE}=${principals.get(role)?.sessionToken ?? ''}`

beforeAll(async () => {
  server = await startWebServer({
    suite: 'marketing-kill-switch',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: PATH,
    readyWithinMs: 90_000,
  })
  BASE = server.origin
  sql = createConnection({
    url: process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '',
    max: 2,
  })
  for (const role of ROLES) {
    // TOTP where the role requires it. The second factor is a LOGIN gate and the fixture inserts the session
    // row directly, but `createFixturePrincipal` refuses a role that `requiresTotp` without one.
    principals.set(
      role,
      await createFixturePrincipal(sql, {
        role,
        ...(role === 'owner' || role === 'manager' ? { enrolTotp: true } : {}),
      }),
    )
  }
  // The browser's cookie is the MANAGER's, because the console's form is only rendered for a role that may
  // use it and the screen under audit has to be the one with the controls on it.
  restoreAdminBrowser = installAdminBrowserCookie(chromium, {
    origin: BASE,
    name: ADMIN_SESSION_COOKIE,
    token: principals.get('manager')?.sessionToken ?? '',
  })
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 180_000)

afterAll(async () => {
  restoreAdminBrowser()
  // The switch back to disengaged, before the principals go: the restore is a POST as the owner, so it needs
  // that session to still resolve.
  try {
    if ((await readMessagingControls(sql)).marketing_kill_switch.engaged) {
      await toggle('owner', 'disengage', 'Suite teardown: restoring the seeded disengaged state.')
    }
  } finally {
    for (const principal of principals.values()) await principal.cleanup()
    await sql?.end({ timeout: 5 })
    await browser?.close()
    await server?.stop()
  }
})

async function toggle(
  role: TestRole,
  direction: 'engage' | 'disengage',
  reason: string,
): Promise<Response> {
  const form = new URLSearchParams({ control: 'marketing_kill_switch', direction, reason })
  return await fetch(`${BASE}${PATH}`, {
    method: 'POST',
    headers: {
      cookie: cookieFor(role),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    redirect: 'manual',
  })
}

/** Audit rows one of this suite's principals wrote, by action. A DELTA: `audit_event` only grows. */
async function auditCount(action: string): Promise<number> {
  const labels = [...principals.values()].map((principal) => principal.staffReference)
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count
      from audit_event
     where action = ${action} and actor_label = any(${labels}::text[])
  `
  return Number(row?.count ?? '0')
}

describe('acceptance — the console answers HTML, noindex, and the state of both controls', () => {
  it('serves the screen with the robots header the registry declares', async () => {
    const response = await fetch(`${BASE}${PATH}`, { headers: { cookie: cookieFor('manager') } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    // Derived from the registry by the proxy: `/messaging` is a prefix in ADMIN_GROUP_PREFIXES, so this
    // route arrived noindex on the commit that created it.
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(response.headers.get('cache-control')).toContain('no-store')

    const html = await response.text()
    expect(html).toContain('data-control="marketing_kill_switch"')
    expect(html).toContain('data-control="promotional_sender_suspended"')
    // The banner, always, and always carrying the sentence that stops a marketing sanction being escalated
    // as an outage. `APP_ENV` is `test` here, so the switch reads engaged whatever the row says — which is
    // the provisional rule, and the screen says so rather than showing a state the gate disagrees with.
    expect(html).toContain('data-banner="stopped_by_kill_switch"')
    expect(html).toContain('Booking confirmations')
  }, 60_000)

  it('refuses a request with no session at all', async () => {
    // The proxy's own refusal, before the handler. Asserted here because the console shows an operational
    // control, and a screen that answered 200 to an anonymous GET would be one anybody could read the state
    // of marketing from.
    const response = await fetch(`${BASE}${PATH}`, { redirect: 'manual' })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('/login')
  }, 30_000)
})

describe('acceptance — manager and owner may toggle; receptionist and marketer are refused', () => {
  it('answers 200 for the two, 403 for the other two, and writes one audit row per success', async () => {
    const engagedBefore = await auditCount('messaging.marketing_kill_switch.engaged')
    const disengagedBefore = await auditCount('messaging.marketing_kill_switch.disengaged')

    try {
      // The owner engages. 200, and the row moves.
      const byOwner = await toggle('owner', 'engage', 'TDRA complaint; stopping every campaign.')
      expect(byOwner.status).toBe(200)
      expect((await readMessagingControls(sql)).marketing_kill_switch.engaged).toBe(true)

      // The two that must be refused, both while the switch is ENGAGED — which is the state in which being
      // able to disengage would matter. A marketer un-stopping their own campaign is the exact failure.
      for (const role of ['receptionist', 'marketer'] as const) {
        const refused = await toggle(role, 'disengage', 'Getting the campaign out.')
        expect(refused.status, role).toBe(403)
        const body = await refused.text()
        // The refusal names the permission and says who to ask, on the screen rather than as a bare status.
        expect(body, role).toContain('settings:write')
        // And nothing moved.
        expect((await readMessagingControls(sql)).marketing_kill_switch.engaged, role).toBe(true)
      }

      // The manager disengages. 200, and the row moves back — so the two permitted roles are shown to work
      // in both directions rather than one each.
      const byManager = await toggle(
        'manager',
        'disengage',
        'Complaint resolved; marketing resumes.',
      )
      expect(byManager.status).toBe(200)
      expect((await readMessagingControls(sql)).marketing_kill_switch.engaged).toBe(false)
    } finally {
      if ((await readMessagingControls(sql)).marketing_kill_switch.engaged) {
        await toggle('owner', 'disengage', 'Case teardown: restoring the disengaged state.')
      }
    }

    // One row per SUCCESS and none per refusal, as deltas. The two refusals wrote nothing, which is the half
    // that would be invisible in a total.
    expect(await auditCount('messaging.marketing_kill_switch.engaged')).toBe(engagedBefore + 1)
    expect(await auditCount('messaging.marketing_kill_switch.disengaged')).toBe(
      disengagedBefore + 1,
    )
  }, 120_000)

  it('carries the actor, the direction and the reason on the audit row the route wrote', async () => {
    const label = principals.get('manager')?.staffReference ?? ''
    const reason = 'A second complaint, from the same weekend blast.'
    try {
      expect((await toggle('manager', 'engage', reason)).status).toBe(200)
      const rows = await sql<
        { actor_label: string; operation: string; after_state: Record<string, unknown> }[]
      >`
        select actor_label, operation, after_state
          from audit_event
         where action = 'messaging.marketing_kill_switch.engaged' and actor_label = ${label}
         order by occurred_at desc, id desc
         limit 1
      `
      const row = rows[0]
      // The actor is the employment record's internal HANDLE, which names no person (ADR 0020) — a display
      // name here would put somebody's name in an append-only table.
      expect(row?.actor_label).toBe(label)
      expect(row?.operation).toBe('update')
      expect(row?.after_state['direction']).toBe('engage')
      expect(row?.after_state['reason']).toBe(reason)
      expect(row?.after_state['changedByRole']).toBe('manager')
    } finally {
      await toggle('owner', 'disengage', 'Case teardown: restoring the disengaged state.')
    }
  }, 120_000)

  it('refuses a toggle with no reason as a bad request, not as a forbidden one', async () => {
    const before = await auditCount('messaging.marketing_kill_switch.engaged')
    /*
      400 and NOT 403, and this case found the route answering 403.

      The permission check refuses two different things — a role that may not toggle and a missing reason —
      and the route mapped every refusal from it to 403. So a manager who left the reason box empty was told
      "not you", which sends somebody to find the owner for a form that would not have worked for the owner
      either. The route now takes the status from the error's kind.
    */
    const response = await toggle('manager', 'engage', '   ')
    expect(response.status).toBe(400)
    const body = await response.text()
    expect(body).toContain('needs a reason')
    // And the control that separates the two refusals: this one must NOT read as a permission problem.
    expect(body).not.toContain('may not settings:write')
    expect(await auditCount('messaging.marketing_kill_switch.engaged')).toBe(before)
    expect((await readMessagingControls(sql)).marketing_kill_switch.engaged).toBe(false)
  }, 60_000)

  it('refuses a no-op toggle with 409, which is the state refusing a valid request', async () => {
    // The third status the route can answer, and the one that separates "the request is wrong" from "the
    // state is not what you think it is". A double-submitted form is exactly this shape.
    try {
      expect((await toggle('manager', 'engage', 'Stopping marketing.')).status).toBe(200)
      const again = await toggle('manager', 'engage', 'Stopping marketing again.')
      expect(again.status).toBe(409)
      expect(await again.text()).toContain('already engaged')
      // The first reason survives, which is the one that explains the state.
      expect((await readMessagingControls(sql)).marketing_kill_switch.reason).toBe(
        'Stopping marketing.',
      )
    } finally {
      await toggle('owner', 'disengage', 'Case teardown: restoring the disengaged state.')
    }
  }, 60_000)
})

async function withPage<T>(
  body: (page: Page) => Promise<T>,
  options: { readonly width: number; readonly theme: 'light' | 'dark' } = {
    width: 1440,
    theme: 'light',
  },
): Promise<T> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: options.theme,
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
    await page.goto(`${BASE}${PATH}`, { waitUntil: 'networkidle' })
    return await body(page)
  } finally {
    await context.close()
  }
}

describe('acceptance — the console shows the last-changed actor and timestamp, and axe is clean', () => {
  it('shows the actor and the instant the row holds, not a literal', async () => {
    const label = principals.get('manager')?.staffReference ?? ''
    try {
      expect((await toggle('manager', 'engage', 'Shown on the console.')).status).toBe(200)
      const row = (await readMessagingControls(sql)).marketing_kill_switch

      await withPage(async (page) => {
        const actor = await page.textContent('[data-actor="marketing_kill_switch"]')
        const changedAt = await page.getAttribute(
          '[data-changed-at="marketing_kill_switch"]',
          'datetime',
        )
        const state = await page.textContent('[data-state="marketing_kill_switch"]')
        // Both compared against the ROW, so a screen that stopped reading it fails here rather than passing
        // against a literal somebody wrote twice.
        expect(actor).toContain(label)
        expect(actor).toContain('manager')
        expect(changedAt).toBe(new Date(row.changedAt).toISOString())
        expect(state?.trim()).toBe('Engaged')
        // The reason too: it is the sentence that decides whether the switch can come back off.
        expect(await page.textContent('[data-control="marketing_kill_switch"]')).toContain(
          'Shown on the console.',
        )
      })
    } finally {
      await toggle('owner', 'disengage', 'Case teardown: restoring the disengaged state.')
    }
  }, 120_000)

  it('reports no serious or critical violation at two widths in both themes, and catches a broken control', async () => {
    for (const width of [390, 1440]) {
      for (const theme of ['light', 'dark'] as const) {
        await withPage(
          async (page) => {
            const result = await auditPage(page, {
              page: PATH,
              viewport: {
                name: String(width),
                width,
                height: 900,
                scale: 1,
                why: 'C-AUTO-05 acceptance',
              },
              theme,
              direction: 'ltr',
            })
            expect(
              blockingViolations(result.violations).map(describeViolation),
              `${width}px ${theme}`,
            ).toEqual([])
          },
          { width, theme },
        )
      }
    }

    // The control on the audit itself. A sweep that reported zero because axe never ran would pass the four
    // assertions above for ever (ADR 0003), so the same page is audited again with an unlabelled button in
    // it — and asserted by RULE ID, because a count is not evidence.
    await withPage(async (page) => {
      await page.evaluate(() => {
        const button = document.createElement('button')
        button.type = 'button'
        document.body.append(button)
      })
      const broken = await auditPage(page, {
        page: `${PATH} (known-bad)`,
        viewport: { name: '1440', width: 1440, height: 900, scale: 1, why: 'the control' },
        theme: 'light',
        direction: 'ltr',
      })
      expect(blockingViolations(broken.violations).map((violation) => violation.id)).toContain(
        'button-name',
      )
    })
  }, 180_000)
})
