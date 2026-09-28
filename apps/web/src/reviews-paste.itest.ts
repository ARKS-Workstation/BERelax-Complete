import { createConnection, type Sql } from '@berelax/db'
import { createFixturePrincipal, type FixturePrincipal } from '@berelax/fixtures'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { REVIEWS_PASTE_FIELDS, REVIEWS_PASTE_PATH } from '../app/(admin)/reviews/paste/view.ts'
import { ADMIN_SESSION_COOKIE } from './session-cookie.ts'

/**
 * G-REV-02 — the paste form, driven by a real browser against the built application.
 *
 * The acceptance line this file exists for: *the paste form creates a review with source='paste',
 * delivery_mode='manual' and google_review_id NULL, writes an audit_event naming the staff actor, and
 * **completes in one form submission (e2e asserts a single POST)***.
 *
 * "A single POST" is the only claim here that cannot be made without a browser. A handler test can assert what
 * one request does; it cannot assert that the SCREEN needs one. So this file counts requests on the
 * `BrowserContext` and asserts the count, and it does it with JavaScript left ON — a no-script run would prove
 * the form submits without a script and would not prove that a script does not add a second round trip.
 *
 * ## The session is real, and it is why this file exists in this shape
 *
 * The route is guarded by `guardAdminRoute`, W-SYS-11's admin session, which is the door every route under
 * `(admin)` goes through. This file was written before that session existed and signed into the Payload admin
 * instead — the only sign-in there was — and the screen's own header said that when W-SYS-11 landed, the
 * principal's SOURCE was the one thing that would change. It did, at the merge. So each role here is a fixture
 * principal with a real session token, which is what makes the redirect, the 403 and the 200 three separate
 * assertions rather than one. No staff member is invented (brief rule 15) and there is no `?role=` parameter
 * anywhere near the route, which is what keeps it on the right side of W-SYS-11's scan.
 *
 * The UNAUTHENTICATED answer is a 303 to /login and not a 401, and that is the door's answer rather than this
 * screen's opinion: a person who is not signed in is sent to sign in, on every admin route in the build. The
 * handler still answers 401 for a null principal and `reviews-paste-handler.itest.ts` drives that path
 * directly, because the handler takes a principal from its caller and a caller is not a guarantee.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind (brief rule
 * 12). This file creates its own connection, its own listing and its own three `cms_user` rows, and every
 * assertion names an id it minted. `audit_event` is append-only (ADR 0008), so the audit assertion is a DELTA
 * counted in SQL.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The origin is assigned in `beforeAll` because the port is ACQUIRED rather than drawn: `startWebServer` binds
 * a candidate from this suite's band and draws again if another worktree holds it. Computing it at module scope
 * is what made a collision present as `next start exited with 1` with the reason discarded.
 */
let BASE = ''

/** Long enough for Payload's own policy, and obviously a test value. */

const PLACE = 'ChIJ_berelax_paste_place'
const CT = Buffer.from('ciphertext-stand-in')

/** The date typed into the form. A Sunday inside the seeded calendar, and in the past. */
const REVIEWED_ON = '2026-09-20'

let server: WebServer
let browser: Browser
let sql: Sql
let connectionId = ''
/**
 * The admin session cookie, per role, as a `Cookie` header value.
 *
 * One jar and not two: the screen has ONE session authority now. Each entry is
 * `berelax_admin_session=<token>` for a fixture principal in that role, so every `fetch` below that passes
 * `headers: { cookie }` is a signed-in request of that role and the ones that pass no cookie are the door's own
 * case.
 */
const cookies = new Map<string, string>()
/** Kept so `afterAll` can call each one's own `cleanup`, which is how every other suite removes them. */
const principals: FixturePrincipal[] = []

/**
 * A fixture principal in one role, and its session cookie.
 *
 * `createFixturePrincipal` writes the employee, the credential and the session the way the application's own
 * login would, and `packages/fixtures/src/admin-principal.ts` deletes them by their reference prefix — so no
 * staff member is invented and nothing is left behind for the next suite to find.
 */
async function sessionCookieFor(role: 'owner' | 'receptionist' | 'marketer'): Promise<string> {
  const principal = await createFixturePrincipal(sql, { role })
  principals.push(principal)
  const token = principal.sessionToken
  if (token === undefined || token === null || token === '') {
    throw new Error(`the fixture principal for ${role} carries no session token`)
  }
  return `${ADMIN_SESSION_COOKIE}=${token}`
}

async function seedConnection(): Promise<string> {
  const [connection] = await sql<{ id: string }[]>`
    insert into google_connections
      (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
       refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp)
    values ('sub-review-paste-e2e', 'owner@berelax.ae',
            ${sql.array(['https://www.googleapis.com/auth/business.manage'])},
            ${CT}, ${CT}, ${CT}, 'v1', 'fp-stand-in')
    returning id
  `
  const id = connection?.id ?? ''
  await sql`
    insert into google_capabilities (connection_id, capability, resource_ref, health, is_primary)
    values (${id}, 'gbp_reviews', ${sql.json({ placeId: PLACE })}, 'permission_missing', true)
  `
  return id
}

async function clean(): Promise<void> {
  await sql`delete from review_intake_email`
  await sql`delete from google_place_aggregate`
  await sql`delete from google_reviews where place_id = ${PLACE}`
  await sql`delete from google_connections where google_sub = 'sub-review-paste-e2e'`
}

/** A delta, counted in SQL. `audit_event` only grows, so a total is a different number every run. */
async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '0')
}

/**
 * Picks this file's own listing, whichever control the page is offering.
 *
 * The page offers hidden inputs for ONE listing and a `<select>` for two or more, and two is a real
 * configuration rather than a test artefact: docs/10 §2 says the account that owns the listing need not be
 * the one verified on the site. It is also the ORDINARY case in the integration suite, because earlier files
 * leave connections behind (brief rule 12) and `listReviewIntakeTargets` returns every listing this system
 * manages rather than only this file's. The first version of this file asserted the hidden input
 * unconditionally: green on its own, and three timeouts in the full chain waiting for an input the page was
 * right not to render.
 *
 * Narrowing what the page can SEE was the alternative — disconnecting the other connections, as
 * `with-google.itest.ts` does — and it is the wrong one here: those rows are other suites' and this file
 * runs in the middle of them. Driving whichever control is on the page exercises production behaviour in
 * both configurations instead.
 */
async function chooseThisListing(page: Page): Promise<void> {
  const hidden = page.locator(`input[name="${REVIEWS_PASTE_FIELDS.connection}"]`)
  if ((await hidden.count()) > 0) {
    expect(await hidden.inputValue()).toBe(connectionId)
    expect(await page.locator(`input[name="${REVIEWS_PASTE_FIELDS.placeId}"]`).inputValue()).toBe(
      PLACE,
    )
    return
  }
  await page.selectOption(`select[name="${REVIEWS_PASTE_FIELDS.connection}"]`, connectionId)
  expect(await page.locator(`select[name="${REVIEWS_PASTE_FIELDS.connection}"]`).inputValue()).toBe(
    connectionId,
  )
}

/** A page that counts every POST it makes, with the cookie of one role. */
async function pageAs(role: string): Promise<{ page: Page; posts: () => readonly string[] }> {
  const context = await browser.newContext({ baseURL: BASE })
  const cookie = cookies.get(role)
  if (cookie !== undefined) {
    // `secure: true` with a loopback URL is accepted: browsers treat 127.0.0.1 as a secure context, which is
    // what lets the application set `Secure` unconditionally. See `packages/harness/src/admin-session.ts`.
    await context.addCookies([
      {
        name: ADMIN_SESSION_COOKIE,
        value: cookie.slice(`${ADMIN_SESSION_COOKIE}=`.length),
        url: BASE,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ])
  }
  const posts: string[] = []
  const page = await context.newPage()
  // Every request the browser makes, filtered to POSTs. A redirect after the POST is a GET, so a
  // post-redirect-get flow still counts ONE — which is what "a single form submission" has to mean.
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(request.url())
  })
  return { page, posts: () => [...posts] }
}

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  server = await startWebServer({
    suite: 'reviews-paste',
    cwd: new URL('..', import.meta.url).pathname,
    readyWithinMs: 120_000,
    env: {
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL,
    },
  })
  BASE = server.origin
  for (const role of ['owner', 'receptionist', 'marketer'] as const) {
    cookies.set(role, await sessionCookieFor(role))
  }
  // The pre-installed Chromium at /opt/pw-browsers, with the same flags as every other browser here.
  browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop()
  await clean()
  // Each principal removes its own employee, credential and session — three of each — so nothing of this
  // suite's is left for the next one to find.
  for (const principal of principals) await principal.cleanup()
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await clean()
  connectionId = await seedConnection()
})

describe('acceptance — one form submission creates the review', () => {
  it('posts exactly once and writes the row the data model asks for', async () => {
    const before = await auditCount('google_review.recorded')
    const { page, posts } = await pageAs('receptionist')
    await page.goto(`${BASE}${REVIEWS_PASTE_PATH}`, { waitUntil: 'networkidle' })

    // Read back rather than assumed, so a page that offered no listing fails here rather than silently
    // posting an empty connection id.
    await chooseThisListing(page)

    await page.check(`input[name="${REVIEWS_PASTE_FIELDS.rating}"][value="4"]`)
    await page.fill(`input[name="${REVIEWS_PASTE_FIELDS.reviewer}"]`, 'A Google user')
    await page.fill(`input[name="${REVIEWS_PASTE_FIELDS.reviewedOn}"]`, REVIEWED_ON)
    await page.fill(
      `textarea[name="${REVIEWS_PASTE_FIELDS.comment}"]`,
      'Quiet room and the towels were warm.',
    )
    await Promise.all([
      page.waitForURL(/\?created=/, { timeout: 30_000 }),
      page.click('button[type="submit"]'),
    ])

    // THE assertion the browser is here for. One POST, and the page after it is a GET — which is also what
    // stops a reload filing the same review twice.
    expect(posts()).toHaveLength(1)
    expect(posts()[0]).toContain(REVIEWS_PASTE_PATH)
    expect(await page.locator('.done').innerText()).toContain('Saved')

    const [row] = await sql<
      {
        id: string
        source: string
        delivery_mode: string
        google_review_id: string | null
        rating: number
        comment_text: string | null
        reviewer_display_name: string
        reviewed_at: Date
      }[]
    >`
      select id::text as id, source, delivery_mode, google_review_id, rating, comment_text,
             reviewer_display_name, reviewed_at
      from google_reviews where place_id = ${PLACE}
    `
    expect(row?.source).toBe('paste')
    expect(row?.delivery_mode).toBe('manual')
    // Migration 0020 decision 1: a pasted review has no Google id until reconciliation backfills one.
    expect(row?.google_review_id).toBeNull()
    expect(row?.rating).toBe(4)
    expect(row?.comment_text).toBe('Quiet room and the towels were warm.')
    expect(row?.reviewer_display_name).toBe('A Google user')
    // The date read back in Asia/Dubai is the date that was typed, which is what reconciliation matches on.
    expect(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(row?.reviewed_at),
    ).toBe(REVIEWED_ON)

    // The audit row, as a DELTA, naming the signed-in operator rather than the surface.
    expect(await auditCount('google_review.recorded')).toBe(before + 1)
    const [audit] = await sql<
      { actor_kind: string; actor_id: string | null; actor_label: string }[]
    >`
      select actor_kind, actor_id, actor_label from audit_event
      where action = 'google_review.recorded' and entity_id = ${row?.id ?? ''}
    `
    expect(audit?.actor_kind).toBe('staff')
    expect(audit?.actor_id).not.toBeNull()
    expect(audit?.actor_label).toContain('cms_user')
    expect(audit?.actor_label).toContain('receptionist')
  }, 60_000)

  it('records a star-only review as NULL text rather than as an empty string', async () => {
    const { page, posts } = await pageAs('receptionist')
    await page.goto(`${BASE}${REVIEWS_PASTE_PATH}`, { waitUntil: 'networkidle' })
    await chooseThisListing(page)
    await page.check(`input[name="${REVIEWS_PASTE_FIELDS.rating}"][value="5"]`)
    await page.fill(`input[name="${REVIEWS_PASTE_FIELDS.reviewer}"]`, 'A Google user')
    await page.fill(`input[name="${REVIEWS_PASTE_FIELDS.reviewedOn}"]`, REVIEWED_ON)
    await Promise.all([
      page.waitForURL(/\?created=/, { timeout: 30_000 }),
      page.click('button[type="submit"]'),
    ])
    expect(posts()).toHaveLength(1)
    const [row] = await sql<{ comment_text: string | null }[]>`
      select comment_text from google_reviews where place_id = ${PLACE}
    `
    // Migration 0020: one fact, one representation. A star-only review is common (docs/10 §7).
    expect(row?.comment_text).toBeNull()
  }, 60_000)

  it('closes the forwarded message it was opened from, in the same submission', async () => {
    const [intake] = await sql<{ id: string }[]>`
      insert into review_intake_email
        (connection_id, place_id, status, refusal, raw_body, raw_body_sha256, raw_body_bytes, received_at)
      values (${connectionId}, ${PLACE}, 'needs_paste', 'no_template_recognised',
              'somebody left you feedback, four stars out of five', ${'a'.repeat(64)}, 50,
              ${'2026-09-21T10:00:00.000Z'}::timestamptz)
      returning id
    `
    const { page, posts } = await pageAs('receptionist')
    await page.goto(
      `${BASE}${REVIEWS_PASTE_PATH}?${REVIEWS_PASTE_FIELDS.intake}=${intake?.id ?? ''}`,
      { waitUntil: 'networkidle' },
    )
    await chooseThisListing(page)
    await page.check(`input[name="${REVIEWS_PASTE_FIELDS.rating}"][value="4"]`)
    await page.fill(`input[name="${REVIEWS_PASTE_FIELDS.reviewer}"]`, 'A Google user')
    await page.fill(`input[name="${REVIEWS_PASTE_FIELDS.reviewedOn}"]`, REVIEWED_ON)
    await Promise.all([
      page.waitForURL(/\?created=/, { timeout: 30_000 }),
      page.click('button[type="submit"]'),
    ])
    // Still ONE POST: the resolution is part of the same transaction, not a second request.
    expect(posts()).toHaveLength(1)
    const [row] = await sql<{ resolved_at: Date | null; review_id: string | null }[]>`
      select resolved_at, review_id::text as review_id from review_intake_email
      where id = ${intake?.id ?? ''}::uuid
    `
    expect(row?.resolved_at).not.toBeNull()
    expect(row?.review_id).not.toBeNull()
  }, 60_000)
})

describe('authorisation is server-side and both verbs are guarded', () => {
  it('sends an unauthenticated GET to /login and shows no forwarded text', async () => {
    await sql`
      insert into review_intake_email
        (connection_id, place_id, status, refusal, raw_body, raw_body_sha256, raw_body_bytes, received_at)
      values (${connectionId}, ${PLACE}, 'needs_paste', 'no_template_recognised',
              'a distinctive forwarded body nobody signed in should see', ${'b'.repeat(64)}, 55,
              ${'2026-09-21T10:00:00.000Z'}::timestamptz)
    `
    // `redirect: 'manual'`, because the door answers 303 and following it would assert about /login.
    const response = await fetch(`${BASE}${REVIEWS_PASTE_PATH}`, { redirect: 'manual' })
    // 303 and not 401: the estate has one door and its answer to somebody not signed in is "sign in", on
    // every admin route in the build. This case asserted 401 until the merge that put `guardAdminRoute` in
    // front of the handler — the handler still answers 401 for a null principal, and
    // `reviews-paste-handler.itest.ts` drives that path directly, because a handler takes its principal from
    // a caller and a caller is not a guarantee.
    expect(response.status).toBe(303)
    const location = response.headers.get('location') ?? ''
    // The POSITIVE claim, so the absences below are about a real answer rather than about an empty response:
    // the redirect names the login screen and carries this path to come back to.
    expect(new URL(location).pathname).toBe('/login')
    expect(new URL(location).searchParams.get('returnTo')).toBe(REVIEWS_PASTE_PATH)
    // And the BYTES, which is the claim that found a real defect: the first version of the handler rendered
    // the same page for every refusal, so its 401 document carried the forwarded text, the connection id and
    // the Google account email. A refusal that shows what it refuses is not a refusal — and a redirect can
    // leak the same way, through the URL it sends the caller to.
    const body = await response.text()
    for (const secret of [
      'a distinctive forwarded body nobody signed in should see',
      connectionId,
      'owner@berelax.ae',
      PLACE,
    ]) {
      expect(body, 'the redirect body').not.toContain(secret)
      expect(location, 'the redirect location').not.toContain(secret)
    }
  })

  it('sends an unauthenticated POST to /login and writes nothing', async () => {
    const response = await fetch(`${BASE}${REVIEWS_PASTE_PATH}`, {
      redirect: 'manual',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        [REVIEWS_PASTE_FIELDS.connection]: connectionId,
        [REVIEWS_PASTE_FIELDS.placeId]: PLACE,
        [REVIEWS_PASTE_FIELDS.rating]: '5',
        [REVIEWS_PASTE_FIELDS.reviewer]: 'A Google user',
        [REVIEWS_PASTE_FIELDS.reviewedOn]: REVIEWED_ON,
      }).toString(),
    })
    // 303, and the row count is the claim that matters: a redirect that had already written the review would
    // be the worst of both answers.
    expect(response.status).toBe(303)
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/login')
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_reviews where place_id = ${PLACE}
    `
    expect(row?.n).toBe('0')
  })

  it('refuses a role the matrix does not trust with 403, in both verbs, and writes nothing', async () => {
    // `marketer` holds no `review:record`. The refusal is the F07 matrix's, made server-side: there is no
    // disabled button involved, and a curl gets the same answer as the screen.
    const cookie = cookies.get('marketer') ?? ''
    const read = await fetch(`${BASE}${REVIEWS_PASTE_PATH}`, { headers: { cookie } })
    expect(read.status).toBe(403)
    const write = await fetch(`${BASE}${REVIEWS_PASTE_PATH}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        [REVIEWS_PASTE_FIELDS.connection]: connectionId,
        [REVIEWS_PASTE_FIELDS.placeId]: PLACE,
        [REVIEWS_PASTE_FIELDS.rating]: '5',
        [REVIEWS_PASTE_FIELDS.reviewer]: 'A Google user',
        [REVIEWS_PASTE_FIELDS.reviewedOn]: REVIEWED_ON,
      }).toString(),
    })
    expect(write.status).toBe(403)
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_reviews where place_id = ${PLACE}
    `
    expect(row?.n).toBe('0')
  })

  it('serves the owner, so the 403 above is about the role and not about the guard', async () => {
    // The control. Without it, a guard that refused everybody would pass every assertion above.
    const response = await fetch(`${BASE}${REVIEWS_PASTE_PATH}`, {
      headers: { cookie: cookies.get('owner') ?? '' },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Paste a review')
  })
})

describe('the refusals a wrong submission gets', () => {
  const post = async (fields: Record<string, string>): Promise<Response> =>
    await fetch(`${BASE}${REVIEWS_PASTE_PATH}`, {
      method: 'POST',
      headers: {
        cookie: cookies.get('receptionist') ?? '',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
      // `fetch` follows a 303 by default, which turns the assertion about the redirect into an assertion
      // about the page after it — and then a 200 looks like a failure to redirect.
      redirect: 'manual',
    })

  const valid = (): Record<string, string> => ({
    [REVIEWS_PASTE_FIELDS.connection]: connectionId,
    [REVIEWS_PASTE_FIELDS.placeId]: PLACE,
    [REVIEWS_PASTE_FIELDS.rating]: '5',
    [REVIEWS_PASTE_FIELDS.reviewer]: 'A Google user',
    [REVIEWS_PASTE_FIELDS.reviewedOn]: REVIEWED_ON,
  })

  it('accepts the valid submission, so every refusal below is about the field it changes', async () => {
    const response = await post(valid())
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('created=')
  })

  it('refuses a future date rather than filing a review nobody has left', async () => {
    const response = await post({ ...valid(), [REVIEWS_PASTE_FIELDS.reviewedOn]: '2099-01-01' })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('has not happened yet')
  })

  it('refuses a rating outside 1-5', async () => {
    expect((await post({ ...valid(), [REVIEWS_PASTE_FIELDS.rating]: '6' })).status).toBe(400)
    expect((await post({ ...valid(), [REVIEWS_PASTE_FIELDS.rating]: '' })).status).toBe(400)
  })

  it('refuses a blank reviewer, because reconciliation matches on it', async () => {
    const response = await post({ ...valid(), [REVIEWS_PASTE_FIELDS.reviewer]: '   ' })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('reconciliation matches on')
  })

  it('refuses a connection this system does not manage', async () => {
    const response = await post({
      ...valid(),
      [REVIEWS_PASTE_FIELDS.connection]: '11111111-1111-1111-1111-111111111111',
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('not a listing this system manages')
  })

  it('refuses a body that is not form-encoded rather than answering 500', async () => {
    const response = await fetch(`${BASE}${REVIEWS_PASTE_PATH}`, {
      method: 'POST',
      headers: { cookie: cookies.get('receptionist') ?? '', 'content-type': 'text/plain' },
      body: '',
    })
    expect(response.status).toBe(400)
  })

  it('writes nothing for any of them', async () => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_reviews where place_id = ${PLACE}
    `
    // The `beforeEach` cleaned up, and the only accepted submission in this describe block was the control —
    // which ran in its own case with its own clean database.
    expect(Number(row?.n ?? '0')).toBeLessThanOrEqual(1)
  })
})
