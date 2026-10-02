import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HOUSE_DRAFT_LINT_VERSION,
  instantFromIso,
  REVIEW_ESCALATION_LEXICON,
  renderReplySkeleton,
  routeReview,
} from '@berelax/core'
import {
  createConnection,
  getReview,
  recordReplyDraft,
  recordRoutingVerdict,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { createFixturePrincipal, type FixturePrincipal } from '@berelax/fixtures'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import {
  captureUntilStable,
  DETERMINISM_CSS,
  DETERMINISTIC_LAUNCH_ARGS,
} from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { auditTouchTargetsInPage, touchTargetInputFor } from '@berelax/harness/touch-targets'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REVIEWS_PASTE_FIELDS, REVIEWS_PASTE_PATH } from '../app/(admin)/reviews/paste/view.ts'
import { REVIEWS_QUEUE_PATH, reviewPath } from '../app/(admin)/reviews/view.ts'
import { ADMIN_SESSION_COOKIE } from './session-cookie.ts'

/**
 * G-REV-06 — the approval queue, driven by a real browser against the built application.
 *
 * Four claims live here and nowhere else, because none of them can be made without a browser:
 *
 *   1. **The clipboard.** *"Copy reply places the exact linted text on the clipboard byte-for-byte"* is a
 *      statement about `navigator.clipboard` after a user gesture. The bytes are compared against
 *      `google_reviews.reply_approved_text` read out of PostgreSQL, so the claim is about the DATABASE and
 *      not about a textarea.
 *   2. **The full fallback walk**, in one session: paste a review through the real form, see the draft in
 *      the queue, have an edited reply REFUSED by the server, approve a clean one, copy it, and record
 *      that it was posted — after which the item leaves the worklist.
 *   3. **axe** on a rendered DOM, in twelve cells.
 *   4. **A repeat capture that is byte-identical**, which is what "zero pixel diff on an unchanged rerun"
 *      means for a page whose content comes out of a database.
 *
 * Everything else — the statuses, the refusals by name, the audit actors, the two database floors — is in
 * `reviews-queue-handler.itest.ts`, and the reason is G-REV-02's and is worth repeating: `next start`
 * serves whatever `.next` was last built, so a gate case that mutates a handler and runs THIS file proves
 * nothing. Four cases in G-REV-02's first gate block did exactly that and all four reported "exited zero".
 *
 * ## Why three viewports x two themes x TWO directions
 *
 * The acceptance line asks for twelve cells. These are route handlers serving one English document — a
 * registry *document* must be served in both locales, which needs an Arabic admin surface W-SYS-01 has not
 * built — so the direction axis is `?dir=rtl`, which re-renders the same English document mirrored. The
 * duplicate queue and the leave screen take the same axis for the same reason; it is a LAYOUT axis and not
 * a locale, and the page says `lang="en"` in both halves.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind (brief
 * rule 12). This file makes its own connection, its own listing and its own fixture principals, every
 * assertion names an id it minted, and the screenshots are of a queue holding exactly the reviews this
 * file created — a page showing every review in a shared database would diff the moment another unit
 * pasted one.
 *
 * ## No invented name
 *
 * `A Google user` is what Google shows for a reviewer with no public name, and the draft is a real house
 * rendering from `renderReplySkeleton` rather than a sentence written here — G-REV-04's vocabulary is
 * closed, and a hand-written draft would make the approval assertions a test of this file's prose.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * Assigned in `beforeAll`, because the port is ACQUIRED rather than drawn — `startWebServer` binds a
 * candidate from this suite's band, releases it, and redraws if the child still dies with `EADDRINUSE`.
 */
let BASE = ''

const PLACE = 'ChIJ_berelax_queue_e2e_place'
const SUB = 'sub-review-queue-e2e'
const CT = Buffer.from('ciphertext-stand-in')
const REVIEWER = 'A Google user'
/** A Sunday inside the seeded calendar, and in the past whatever the clock says. */
const REVIEWED_ON = '2026-09-20'
const SCREENS = new URL('../../../artifacts/screens', import.meta.url).pathname

/** The machine's draft: a real house rendering, which is the only kind of draft the generator makes. */
const DRAFT = renderReplySkeleton({
  skeleton: 'low_rating_acknowledgement',
  aspects: [],
  language: 'en',
})

/**
 * The hand edit that must be refused.
 *
 * `treatment` is on `regulatory_profile.banned_claim_terms` (migration 0004) — quoted from the live list
 * rather than invented, and the exact word that made 32 of G-REV-04's house renderings unpublishable
 * until G-REV-05 found it. So the rule this must break is `banned_claim_term`.
 */
const BANNED = `${DRAFT} Your treatment was carried out exactly as planned.`

let server: WebServer
let browser: Browser
let sql: Sql
let connectionId = ''
let reviewId = ''
const principals: FixturePrincipal[] = []
const cookies = new Map<string, string>()

async function sessionCookieFor(role: 'owner' | 'receptionist'): Promise<string> {
  const principal = await createFixturePrincipal(sql, { role })
  principals.push(principal)
  const token = principal.sessionToken
  if (token === undefined || token === null || token === '') {
    throw new Error(`the fixture principal for ${role} carries no session token`)
  }
  return token
}

async function seedConnection(): Promise<string> {
  const [connection] = await sql<{ id: string }[]>`
    insert into google_connections
      (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
       refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp)
    values (${SUB}, 'owner@berelax.ae',
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
  await sql`delete from review_intake_email where place_id = ${PLACE}`
  await sql`delete from google_reviews where place_id = ${PLACE}`
  await sql`delete from google_connections where google_sub = ${SUB}`
}

/** A page with one role's session cookie, and the clipboard permissions the copy control needs. */
async function contextAs(
  role: 'owner' | 'receptionist',
  cell: Cell = { width: 1440, height: 900, theme: 'light', direction: 'ltr' },
): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: { width: cell.width, height: cell.height },
    deviceScaleFactor: 1,
    colorScheme: cell.theme,
    locale: 'en-AE',
    timezoneId: 'Asia/Dubai',
    reducedMotion: 'reduce',
    // The clipboard is the one claim this file exists for. 127.0.0.1 is a secure context, so
    // `navigator.clipboard` exists; the grants are what let the page write to it and this suite read it.
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const token = cookies.get(role)
  if (token !== undefined) {
    await context.addCookies([
      {
        name: ADMIN_SESSION_COOKIE,
        value: token,
        url: BASE,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ])
  }
  // The esbuild `keepNames` shim: Playwright serialises a callback's compiled source into the page.
  await context.addInitScript({
    content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
  })
  return context
}

/**
 * Routes and drafts a review the way the jobs would, because nothing schedules either yet.
 *
 * `routeReview` is the REAL routing table against the REAL lexicon — the verdict and the rule id this
 * screen explains are computed rather than chosen, so the escalation panel is asserted against what the
 * router actually decides about a one-star review mentioning a refund. What is simulated is only the
 * SCHEDULING: no cron walks the queue, which G-REV-03 and G-REV-04 each deferred by name and no unit yet
 * owns. The draft is a real house rendering for the same reason.
 */
async function routeAndDraft(id: string, comment: string): Promise<void> {
  const decision = routeReview({
    review: {
      rating: 1,
      commentText: comment,
      reviewedAt: instantFromIso(`${REVIEWED_ON}T06:00:00Z`),
    },
    policy: {
      now: instantFromIso('2026-09-22T06:00:00Z'),
      autosendEnabledSetting: null,
      businessProfileAccessSetting: null,
      coolingOffHoursSetting: null,
      replyLanguagesSetting: null,
      lexicon: REVIEW_ESCALATION_LEXICON,
    },
  })
  // The launch mode routes everything to a human (docs/10 §4, Y3-gbp-api). If this ever came back
  // `auto_send` the rest of this file would be testing a screen the build does not serve.
  expect(decision.verdict).toBe('escalate')
  const actor = { kind: 'staff', id: principals[0]?.employeeId ?? '', label: 'Queue e2e' } as const
  await withUnitOfWork(sql, actor, (uow) =>
    recordRoutingVerdict(uow, id, {
      verdict: decision.verdict,
      ruleId: decision.rule,
      lexiconVersion: decision.lexiconVersion,
      categories: [...decision.categories],
    }),
  )
  await withUnitOfWork(sql, actor, (uow) =>
    recordReplyDraft(uow, id, {
      draft: DRAFT,
      skeletonId: 'low_rating_acknowledgement',
      aspects: [],
      language: 'en',
      promptVersion: 'g-rev-04-1',
      promptFingerprint: 'f'.repeat(64),
      lintVersion: HOUSE_DRAFT_LINT_VERSION,
    }),
  )
}

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  await clean()
  connectionId = await seedConnection()
  for (const role of ['owner', 'receptionist'] as const) {
    cookies.set(role, await sessionCookieFor(role))
  }
  server = await startWebServer({
    suite: 'reviews-queue',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: REVIEWS_QUEUE_PATH,
    readyWithinMs: 120_000,
    env: {
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL,
    },
  })
  BASE = server.origin
  // The shared launch args, not a hand-written list: `--disable-skia-runtime-opts` and
  // `--disable-lcd-text` are what make the repeat capture below byte-identical.
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 240_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop()
  await clean()
  for (const principal of principals) await principal.cleanup()
  await sql?.end({ timeout: 5 })
})

describe('acceptance — the full fallback walk, in one browser session', () => {
  it('pastes, drafts, refuses an edit, approves, copies byte-for-byte and records the claim', async () => {
    const context = await contextAs('owner')
    const page = await context.newPage()
    try {
      // --- 1. Paste a review through the real intake form (G-REV-02). -------------------------------
      await page.goto(`${BASE}${REVIEWS_PASTE_PATH}`, { waitUntil: 'networkidle' })
      // Whichever listing control the page offers: hidden inputs for one, a `<select>` for several, and
      // several is the ordinary case in the integration suite because earlier files leave connections
      // behind. G-REV-02's own e2e records the same reasoning.
      const hidden = page.locator(`input[name="${REVIEWS_PASTE_FIELDS.connection}"]`)
      if ((await hidden.count()) > 0) {
        expect(await hidden.inputValue()).toBe(connectionId)
      } else {
        await page.selectOption(`select[name="${REVIEWS_PASTE_FIELDS.connection}"]`, connectionId)
      }
      await page.check(`input[name="${REVIEWS_PASTE_FIELDS.rating}"][value="1"]`)
      await page.fill(`input[name="${REVIEWS_PASTE_FIELDS.reviewer}"]`, REVIEWER)
      await page.fill(`input[name="${REVIEWS_PASTE_FIELDS.reviewedOn}"]`, REVIEWED_ON)
      const comment = 'One star. I asked for a refund and nobody answered.'
      await page.fill(`textarea[name="${REVIEWS_PASTE_FIELDS.comment}"]`, comment)
      await Promise.all([
        page.waitForURL(/\?created=/, { timeout: 60_000 }),
        page.click('button[type="submit"]'),
      ])
      const [created] = await sql<{ id: string }[]>`
        select id::text as id from google_reviews where place_id = ${PLACE}
      `
      reviewId = created?.id ?? ''
      expect(reviewId).not.toBe('')

      // --- 2. A draft appears, and the queue explains why a human has it. --------------------------
      await routeAndDraft(reviewId, comment)
      await page.goto(`${BASE}${REVIEWS_QUEUE_PATH}`, { waitUntil: 'networkidle' })
      const listed = page.locator(`li[data-review="${reviewId}"]`)
      // `expect` here is vitest's, not Playwright's, so there are no auto-waiting locator matchers: the
      // count is read after a settled navigation and compared. A `toHaveCount` would not compile.
      expect(await listed.count()).toBe(1)
      const listedText = await listed.innerText()
      expect(listedText).toContain('drafted, waiting for a human to approve it')
      // The rule in plain English, and what the review mentions. Both, because they are two facts.
      expect(listedText).toContain('always escalated to a human')
      expect(listedText).toContain('mentions a refund')

      await page.click(`li[data-review="${reviewId}"] a`)
      await page.waitForURL((url) => url.pathname === reviewPath(reviewId))
      // The machine's draft is in the textarea, and there is nothing to copy yet.
      expect(await page.locator('[data-testid="reply-draft"]').inputValue()).toBe(DRAFT)
      expect(await page.locator('[data-testid="reply-copy"]').count()).toBe(0)

      // --- 3. A hand edit carrying a banned claim is refused BY THE SERVER. -----------------------
      // JavaScript is ON and the control is not disabled: the form posts, and the refusal comes back
      // from the server with the rule named. That is the acceptance line in as many words.
      await page.fill('[data-testid="reply-draft"]', BANNED)
      const refusal = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().includes(reviewPath(reviewId)) && response.request().method() === 'POST',
          { timeout: 60_000 },
        ),
        page.click('[data-testid="reply-approve"]'),
      ])
      expect(refusal[0].status()).toBe(422)
      // The POST answers with a document, so the DOM has to be parsed before it can be read.
      await page.waitForLoadState('domcontentloaded')
      expect(await page.locator('[data-refusal="reply_refused_by_the_linter"]').count()).toBe(1)
      expect(await page.locator('[data-rule="banned_claim_term"]').count()).toBe(1)
      // Nothing was stored, so there is still nothing to copy.
      expect((await getReview(sql, reviewId))?.replyApprovedText).toBeNull()
      expect(await page.locator('[data-testid="reply-copy"]').count()).toBe(0)
      // What was typed came back, so a refusal does not throw away an edit.
      expect(await page.locator('[data-testid="reply-draft"]').inputValue()).toBe(BANNED)

      // --- 4. Approve the clean reply. ------------------------------------------------------------
      await page.fill('[data-testid="reply-draft"]', DRAFT)
      await Promise.all([
        page.waitForURL(/\?done=approved/, { timeout: 60_000 }),
        page.click('[data-testid="reply-approve"]'),
      ])
      const approved = await getReview(sql, reviewId)
      expect(approved?.replyApprovedText).toBe(DRAFT)
      expect(approved?.replyLintVersion).toBe('g-rev-05-send-path-1')
      // Still not delivered: approval and the claim are two steps (docs/10 §6).
      expect(approved?.postedManuallyAtIso).toBeNull()

      // --- 5. Copy reply puts the stored, linted bytes on the clipboard. --------------------------
      // The deep link is beside it, rebuilt from the stored place id.
      const href = await page.locator('[data-testid="reply-deep-link"]').getAttribute('href')
      expect(href).toContain(encodeURIComponent(PLACE))
      await page.click('[data-testid="reply-copy"]')
      /*
        Waited for rather than read immediately. `navigator.clipboard.writeText` returns a promise, so the
        confirmation appears a task later than the click — the first version of this read `isVisible()` on
        the next line and failed on a page that had done exactly the right thing.
      */
      await page.waitForSelector('[data-testid="reply-copied"]:not([hidden])', { timeout: 30_000 })
      const clipboard = await page.evaluate(async () => await navigator.clipboard.readText())
      // BYTE-FOR-BYTE against the column, which is what makes this a claim about the send path rather
      // than about a textarea: nothing can write `reply_approved_text` without passing the linter.
      expect(clipboard).toBe(approved?.replyApprovedText)
      expect(clipboard).toBe(DRAFT)

      // --- 6. Marked as posted records the claim, and the item leaves the worklist. ---------------
      await Promise.all([
        page.waitForURL(/\?done=posted/, { timeout: 60_000 }),
        page.click('[data-testid="reply-mark-posted"]'),
      ])
      const posted = await getReview(sql, reviewId)
      expect(posted?.deliveryMode).toBe('manual')
      expect(posted?.postedManuallyAtIso).not.toBeNull()
      expect(posted?.submittedAtIso).toBeNull()
      // The bytes on the row are the bytes that were on the clipboard.
      expect(posted?.replyApprovedText).toBe(clipboard)

      await page.goto(`${BASE}${REVIEWS_QUEUE_PATH}`, { waitUntil: 'networkidle' })
      expect(await page.locator(`li[data-review="${reviewId}"]`).count()).toBe(0)
      // And it is still readable, because a finished review's approved text is what somebody may need to
      // paste again — the way back is a link rather than a parameter to know about.
      await Promise.all([
        page.waitForURL(/show=all/, { timeout: 60_000 }),
        page.click('text=Show all'),
      ])
      expect(await page.locator(`li[data-review="${reviewId}"]`).count()).toBe(1)
      expect(await page.locator(`li[data-review="${reviewId}"]`).innerText()).toContain(
        'a named person says they posted it',
      )
    } finally {
      await context.close()
    }
  }, 300_000)

  it('refuses the queue to a role the matrix does not trust with a reply', async () => {
    // The served answer rather than a return value, and the one assertion about the whole screen that
    // only a real request can make: the receptionist may RECORD a review (G-REV-02) and may not approve
    // the answer to it, which is why `review:reply_approve` exists.
    const context = await contextAs('receptionist')
    const page = await context.newPage()
    try {
      const response = await page.goto(`${BASE}${REVIEWS_QUEUE_PATH}`, {
        waitUntil: 'networkidle',
      })
      expect(response?.status()).toBe(403)
      const html = await page.content()
      expect(html).toContain('data-refusal="forbidden"')
      // And the refused page carries none of what it was refused.
      expect(html).not.toContain(REVIEWER)
      expect(html).not.toContain(PLACE)
      // The same request as an owner is 200, so the 403 is the matrix and not a broken route.
      const allowed = await contextAs('owner')
      try {
        const ownerPage = await allowed.newPage()
        const ok = await ownerPage.goto(`${BASE}${REVIEWS_QUEUE_PATH}`, {
          waitUntil: 'networkidle',
        })
        expect(ok?.status()).toBe(200)
      } finally {
        await allowed.close()
      }
    } finally {
      await context.close()
    }
  }, 120_000)
})

// ------------------------------------------------------------------------------------------------
// axe, and the screenshots
// ------------------------------------------------------------------------------------------------

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

async function withCell<T>(cell: Cell, path: string, body: (page: Page) => Promise<T>): Promise<T> {
  const context = await contextAs('owner', cell)
  try {
    const page = await context.newPage()
    const separator = path.includes('?') ? '&' : '?'
    const url = cell.direction === 'rtl' ? `${BASE}${path}${separator}dir=rtl` : `${BASE}${path}`
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.addStyleTag({ content: DETERMINISM_CSS })
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    return await body(page)
  } finally {
    await context.close()
  }
}

/**
 * The rendered background, as the engine resolved it.
 *
 * Read rather than compared to a literal: a hex in this file would be an un-tokened colour and
 * `pnpm colours` would reject it, rightly. The claim that matters is that the dark cell really is darker,
 * so the theme axis is a rendered difference rather than a filename.
 */
async function backgroundLuminance(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const colour = globalThis.getComputedStyle(document.body).backgroundColor
    const [r = 0, g = 0, b = 0] = (colour.match(/\d+(\.\d+)?/g) ?? []).map(Number)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  })
}

describe('acceptance — axe reports nothing serious or critical, on both screens', () => {
  it('audits the queue and the detail view in twelve cells each, and each cell is what it claims', async () => {
    // Twelve, stated rather than counted after the fact: a matrix that lost an axis would report a pass
    // over six renders.
    expect(CELLS).toHaveLength(12)
    expect(reviewId).not.toBe('')
    const luminance: Record<string, number> = {}
    let audited = 0
    for (const screen of [
      { name: 'queue', path: `${REVIEWS_QUEUE_PATH}?show=all` },
      { name: 'detail', path: reviewPath(reviewId) },
    ] as const) {
      for (const cell of CELLS) {
        const label = `${screen.name} ${cell.theme} ${cell.width}px ${cell.direction}`
        const { violations, width, direction, lum } = await withCell(
          cell,
          screen.path,
          async (page) => {
            const result = await auditPage(page, {
              page: `${screen.path} (${cell.direction})`,
              viewport: {
                name: `${cell.width}`,
                width: cell.width,
                height: cell.height,
                scale: 1,
                why: 'G-REV-06 acceptance',
              },
              theme: cell.theme,
              direction: cell.direction,
            })
            return {
              violations: result.violations,
              width: await page.evaluate(() => globalThis.innerWidth),
              direction: await page.evaluate(
                () => globalThis.getComputedStyle(document.documentElement).direction,
              ),
              lum: await backgroundLuminance(page),
            }
          },
        )
        // Every cell is the cell it says it is. Without this a matrix of twelve identical renders would
        // satisfy every assertion below.
        expect(width, `${label}: viewport`).toBe(cell.width)
        expect(direction, `${label}: direction`).toBe(cell.direction)
        luminance[label] = lum
        const blocking = blockingViolations(violations)
        expect(
          blocking.map(describeViolation),
          `${label}: ${blocking.length} serious/critical violation(s)`,
        ).toEqual([])
        audited += 1
      }
    }
    expect(audited).toBe(24)
    // The theme axis is a rendered difference at every width, in both directions and on both screens.
    for (const screen of ['queue', 'detail']) {
      for (const width of [390, 768, 1440]) {
        for (const direction of ['ltr', 'rtl']) {
          const dark = luminance[`${screen} dark ${width}px ${direction}`] ?? 0
          const light = luminance[`${screen} light ${width}px ${direction}`] ?? 0
          expect(dark, `${screen} dark ${width}px ${direction} is darker`).toBeLessThan(light)
        }
      }
    }
  }, 900_000)
})

describe('acceptance — the same screens photographed twice are byte-identical', () => {
  it('captures both screens in twelve cells, with zero pixel diff between the runs', async () => {
    mkdirSync(SCREENS, { recursive: true })
    const shots = new Map<string, Uint8Array>()
    for (const screen of [
      { name: 'reviews-queue', path: `${REVIEWS_QUEUE_PATH}?show=all` },
      { name: 'reviews-detail', path: reviewPath(reviewId) },
    ] as const) {
      for (const cell of CELLS) {
        const label = `${screen.name}__${cell.theme}-${cell.width}__${cell.direction}`
        /*
          Through `captureUntilStable` rather than by comparing capture one to capture two, because that
          also asserts paint had settled by the FIRST capture — untrue at load on a four-core box, where
          this flaps a byte at a time while passing in isolation every time. The helper throws
          `[screenshot-never-stabilised]` when no two consecutive captures ever agree, which is exactly
          what a clock in the render produces. These pages print the instant they were read at, which is
          why they are rendered with the determinism CSS and why the instant comes off the view.
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
    expect(shots.size).toBe(24)
    // The control on the comparison: different cells are NOT identical. Without it a screenshot function
    // that returned the same bytes every time would pass every assertion above.
    const differ = (a: string, b: string): void => {
      expect(
        Buffer.compare(
          Buffer.from(shots.get(a) ?? new Uint8Array()),
          Buffer.from(shots.get(b) ?? new Uint8Array()),
        ),
        `${a} vs ${b}`,
      ).not.toBe(0)
    }
    differ('reviews-queue__light-390__ltr', 'reviews-queue__dark-390__ltr')
    differ('reviews-queue__light-390__ltr', 'reviews-queue__light-1440__ltr')
    differ('reviews-queue__light-390__ltr', 'reviews-queue__light-390__rtl')
    differ('reviews-queue__light-390__ltr', 'reviews-detail__light-390__ltr')
  }, 900_000)
})

describe('every control on both screens is big enough to hit', () => {
  it('clears 48x48 with an 8px gap at 390px and 40x40 at 1440px, in both directions', async () => {
    /*
      `pnpm touch-targets` with no arguments audits the design specimen and NOT these routes, which is
      what its own header says: the live routes are audited against a real `next start`, the way
      `kitchen-sink.itest.ts` does it, with the same rules. So this is where that happens for these two
      screens — and it is not a formality: the detail view's "Back to the queue" link was a bare anchor,
      19px tall, and failed in all four cells. Every navigational link on both screens now states the
      floor as a class rather than arriving at a size through padding.
    */
    expect(reviewId).not.toBe('')
    for (const screen of [`${REVIEWS_QUEUE_PATH}?show=all`, reviewPath(reviewId)]) {
      for (const cell of CELLS.filter((candidate) => candidate.width !== 768)) {
        const findings = await withCell(cell, screen, (page) =>
          page.evaluate(auditTouchTargetsInPage, touchTargetInputFor(cell.width)),
        )
        expect(
          findings,
          `${screen} ${cell.width}px ${cell.direction}: ${JSON.stringify(findings)}`,
        ).toEqual([])
      }
    }
  }, 300_000)

  it('names a 32px control when one is put on the page', async () => {
    // The control on the audit itself (ADR 0003). The same rules that just reported both screens clean
    // report a 32px button, which is what `padding: 4px 10px` produces and looks entirely deliberate.
    const findings = await withCell(
      { width: 390, height: 844, theme: 'light', direction: 'ltr' },
      reviewPath(reviewId),
      async (page) => {
        await page.evaluate(() => {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = 'Too small'
          button.style.cssText = 'min-height:0;padding:4px 10px;font-size:12px'
          document.body.append(button)
        })
        return await page.evaluate(auditTouchTargetsInPage, touchTargetInputFor(390))
      },
    )
    expect(findings.map((finding) => finding.rule)).toContain('touch-target-too-small')
  }, 120_000)
})

describe('the mirrored render is a layout axis and not a locale', () => {
  it('serves one English document in both directions, noindex and no-store', async () => {
    const response = await fetch(`${BASE}${REVIEWS_QUEUE_PATH}`, {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${cookies.get('owner') ?? ''}` },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    // Derived from the registry by the proxy, not hand-written per route: `/reviews` is an admin prefix.
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.text()).toContain('<html lang="en" dir="ltr">')

    const mirrored = await fetch(`${BASE}${REVIEWS_QUEUE_PATH}?dir=rtl`, {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${cookies.get('owner') ?? ''}` },
    })
    // Same language, mirrored layout. An Arabic admin document is W-SYS-01's and is not invented here.
    expect(await mirrored.text()).toContain('<html lang="en" dir="rtl">')
  }, 120_000)
})
