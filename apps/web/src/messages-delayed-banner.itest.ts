import { getDefinition } from '@berelax/config'
import { instantFromIso } from '@berelax/core'
import { createConnection, type Sql, withUnitOfWork, writeSetting } from '@berelax/db'
import { DETERMINISTIC_LAUNCH_ARGS } from '@berelax/harness/determinism'
import { SEND_BACKLOG_THRESHOLD_SETTING_KEY } from '@berelax/shared'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderInboxHtml } from '../app/(admin)/settings/messages/render.ts'
import { ADMIN_BANNER_CSS } from './components/admin/google-reauth-banner.ts'
import { sendBacklogBannerFor } from './components/admin/google-reauth-source.ts'
import {
  MESSAGES_DELAYED_BANNER_ATTRIBUTE,
  type SendBacklogView,
} from './components/admin/messages-delayed-banner.ts'

/**
 * H-HARD-05 — the "messages delayed" banner, in a browser, decided by the real alert path.
 *
 * ## What only a browser can say here
 *
 * The acceptance line is that the banner APPEARS above its threshold and DISAPPEARS when the queue
 * drains, and "appears" is a claim about a rendered box rather than about a substring. A banner that is
 * in the document with `display: none` on it, or collapsed to a zero-height box by a rule in a token or
 * a media query, is as absent to a receptionist as one that was never emitted — and no assertion over
 * source text can see any of those. `messages-delayed-banner.test.ts` makes the claims a parsed string
 * can carry; this file asks the browser for a non-zero box, `visibility: visible` and `opacity: 1`, and
 * case `e` adds exactly the `display: none` that must make those fail.
 *
 * ## Why no server, and therefore no port band
 *
 * `renderInboxHtml` is pure — rows and sentences in, a document out — so `page.setContent` renders the
 * exact bytes the route serves. No `next start`, no port to draw and no temp root to leave behind (brief
 * rules 18 and 19). `google-reauth-banner.itest.ts` and `google-connection-card.itest.ts` already use
 * this arrangement for the same reason, and it is what lets this unit declare no band at all: a band
 * declared and unused fails `apps/web/src/test-ports.test.ts` by name.
 *
 * ## Why the view comes from the database and not from a literal
 *
 * Because the thing worth proving is that the BANNER and the ALERT are one fact. `sendBacklogBannerFor`
 * is the function the ten admin documents call through `adminChromeFor`, and it evaluates the
 * `send_backlog` entry in `ALERT_REGISTRY` through the same observer and the same threshold setting the
 * worker's pass uses. A literal `{ queued: 40, threshold: 20 }` here would photograph the markup and
 * assert nothing about whether the banner is ever up when it should be.
 *
 * The threshold therefore moves through `writeSetting` — the path an admin takes, which validates
 * against the declared schema and records the change in the append-only history — and NOT through a
 * test-only argument on the production function. A `thresholdOverride` parameter would make the suite
 * green while proving the one thing it must not: that the banner can be driven by something other than
 * the setting the alert reads. `app_setting` is global, so `afterAll` puts the declared default back.
 *
 * ## Why it inserts its own messages and deletes exactly those
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind
 * (brief rule 12). So this file measures what is already queued, adds enough of its OWN rows to cross
 * the threshold it supplies, and deletes those same ids — never a `delete from message`. Leaving them
 * would be worse than untidy: every later suite's admin screenshots would grow a banner, and the
 * visual-regression diffs would fail in files nobody touched.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '') {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const NOW = instantFromIso('2026-10-02T12:00:00.000Z')
const NOW_ISO = new Date(NOW).toISOString()
const TRADING_DATE = NOW_ISO.slice(0, 10)

/** How many probe messages to queue. Three is enough to move a figure and cheap to undo. */
const PROBES = 3

let sql: Sql
let browser: Browser
const probeIds: string[] = []

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 120_000)

afterAll(async () => {
  // Belt and braces, in this order: the draining case deletes these rows and restores the setting, and
  // an exception before it must not leave either behind. A queued probe left in the table would grow a
  // banner on every later suite's admin screenshots, and a threshold of 1 left in `app_setting` would
  // do the same for every suite whose database has one queued message in it.
  if (probeIds.length > 0) {
    await sql`delete from message where id = any(${probeIds}::uuid[])`
  }
  await setThreshold(DECLARED_DEFAULT_THRESHOLD)
  await browser?.close()
  await sql.end({ timeout: 5 })
})

/**
 * The declared default, read from the F09 registry rather than written here as a number.
 *
 * `20` in this file would be a second statement of the figure, and the copy that drifts is the one that
 * restores it — so a later settings change would leave this suite putting back a value nobody declared.
 */
const DECLARED_DEFAULT_THRESHOLD = getDefinition(SEND_BACKLOG_THRESHOLD_SETTING_KEY)
  .defaultValue as number

async function setThreshold(value: number): Promise<void> {
  // Through `writeSetting` and not an INSERT: it validates against the declared schema and records the
  // change in the append-only history, which is the path an admin takes. A hand-written row would let
  // this file store a figure the registry would have refused, and the bound is the thing that keeps a
  // quieter threshold a judgement rather than a silencing.
  await withUnitOfWork(sql, { kind: 'system', label: 'hhard05-banner-itest' }, (uow) =>
    writeSetting(uow, {
      key: SEND_BACKLOG_THRESHOLD_SETTING_KEY,
      value,
      role: 'owner' as const,
      actorLabel: 'hhard05-banner-itest',
    }),
  )
}

/** The inbox document, with whatever chrome the case is about. Empty rows: the subject is the chrome. */
function inboxHtml(sendBacklog: SendBacklogView | null): string {
  return renderInboxHtml({
    chrome: { googleReauth: null, sendBacklog, returnTo: '/settings/messages' },
    entries: [],
    filter: { templateKey: null, recipient: null, status: null, limit: 50 },
    smsProvider: 'fake',
    emailProvider: 'fake',
  })
}

/**
 * Is the banner genuinely visible to somebody standing at the terminal?
 *
 * Four questions and not one. `querySelector` answers "is it in the DOM", which is the one a substring
 * assertion already covers; the other three are the ways a banner can be in the document and dismissed
 * anyway. Returns a record rather than a boolean so a failure says WHICH of them was wrong.
 */
async function visibility(page: Page): Promise<{
  readonly present: boolean
  readonly box: boolean
  readonly visibility: string
  readonly opacity: string
}> {
  return await page.evaluate((attribute) => {
    const element = document.querySelector(`[${attribute}]`)
    if (element === null) {
      return { present: false, box: false, visibility: 'absent', opacity: 'absent' }
    }
    const rect = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    return {
      present: true,
      box: rect.width > 0 && rect.height > 0,
      visibility: style.visibility,
      opacity: style.opacity,
    }
  }, MESSAGES_DELAYED_BANNER_ATTRIBUTE)
}

async function render(page: Page, html: string): Promise<void> {
  await page.setContent(html, { waitUntil: 'load' })
}

describe('acceptance — the delay banner appears above the threshold and disappears when it drains', () => {
  it('is not in the document while the backlog is inside its threshold', async () => {
    // The control the whole file rests on, and it runs FIRST so it cannot be satisfied by rows this
    // file has not inserted yet. The schema's own ceiling is "inside it" for any queue this database
    // can hold, and it is the ceiling rather than a chosen figure precisely because a chosen one would
    // be a figure nobody measured.
    await setThreshold(500)
    const view = await sendBacklogBannerFor({ sql, now: NOW, tradingDate: TRADING_DATE })
    expect(view).toBeNull()

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await render(page, inboxHtml(view))
      expect(await visibility(page)).toMatchObject({ present: false })
    } finally {
      await page.close()
    }
  })

  it('appears, with a real box, once more messages are queued than the threshold allows', async () => {
    const [template] = await sql<{ id: string }[]>`select id from message_template limit 1`
    if (template === undefined) throw new Error('the seed created no message template')

    const baseline = await sql<{ queued: string }[]>`
      select count(*)::text as queued from message where status = 'queued'
    `
    const before = Number(baseline[0]?.queued ?? 0)

    for (let n = 0; n < PROBES; n += 1) {
      const [row] = await sql<{ id: string }[]>`
        insert into message (template_id, channel, message_class, locale, vendor, recipient, sender_id,
                             body, encoding, segments, cost_fils, status, attempts, queued_at)
        values (${template.id}::uuid, 'sms'::message_channel, 'transactional'::message_class, 'en',
                'smsala', '+971500000902', 'BERELAX', 'Booking confirmed.', 'GSM-7', 1, 9,
                'queued'::message_status, 0, ${NOW_ISO}::timestamptz)
        returning id
      `
      if (row === undefined) throw new Error('the probe message was not inserted')
      probeIds.push(row.id)
    }

    // The threshold is set RELATIVE to the baseline, which is what makes this assertion survive another
    // suite's leftover queue (brief rule 12) instead of going red on somebody else's branch.
    await setThreshold(before + PROBES)
    const view = await sendBacklogBannerFor({ sql, now: NOW, tradingDate: TRADING_DATE })
    expect(view).not.toBeNull()
    expect(view?.queued).toBe(before + PROBES)
    expect(view?.threshold).toBe(before + PROBES)

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await render(page, inboxHtml(view))
      const seen = await visibility(page)
      expect(seen.present, 'the banner is in the document').toBe(true)
      expect(seen.box, 'the banner has a non-zero box').toBe(true)
      expect(seen.visibility).toBe('visible')
      expect(seen.opacity).toBe('1')
      // And it says the thing it exists to say. A visible box with the wrong words is a banner that
      // tells a receptionist nothing. `textContent` off the element rather than a locator count,
      // because vitest's `expect` is not Playwright's and has no `toHaveCount`.
      const words = await page.evaluate(
        (attribute) => document.querySelector(`[${attribute}]`)?.textContent ?? '',
        MESSAGES_DELAYED_BANNER_ATTRIBUTE,
      )
      expect(words).toContain('Do not tell a client')
    } finally {
      await page.close()
    }
  })

  it('disappears when the queue drains, which is also how this file cleans up after itself', async () => {
    await sql`delete from message where id = any(${probeIds}::uuid[])`
    const drained = probeIds.splice(0, probeIds.length).length
    expect(drained).toBe(PROBES)

    // The threshold is left exactly where the firing case set it. Nothing about the configuration
    // changed; the rows did, which is the claim — the banner is derived and clears itself.
    const view = await sendBacklogBannerFor({ sql, now: NOW, tradingDate: TRADING_DATE })
    expect(view).toBeNull()

    // And the setting goes back, so no later suite inherits a threshold this file chose.
    await setThreshold(DECLARED_DEFAULT_THRESHOLD)

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await render(page, inboxHtml(view))
      expect(await visibility(page)).toMatchObject({ present: false })
    } finally {
      await page.close()
    }
  })

  it('reports a known-bad document that hides the banner, which is why the three checks above mean something', async () => {
    // ADR 0003 in one case. Every assertion in this file is about a banner being visible, and a
    // visibility check that has never been seen to fail may not be a check at all — `getBoundingClientRect`
    // on a detached node, a selector that stopped matching, a `setContent` that silently rendered
    // nothing, all answer "fine". So: the same document with one rule added.
    const view: SendBacklogView = { queued: 99, threshold: 20 }
    const hidden = inboxHtml(view).replace(
      '</head>',
      `<style>[${MESSAGES_DELAYED_BANNER_ATTRIBUTE}] { display: none; }</style></head>`,
    )
    expect(hidden).toContain('display: none')

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await render(page, hidden)
      const seen = await visibility(page)
      // In the DOM and not visible: exactly the state a substring assertion calls a pass.
      expect(seen.present).toBe(true)
      expect(seen.box).toBe(false)

      // And the positive control, so this case cannot pass because the page failed to render.
      await render(page, inboxHtml(view))
      expect(await visibility(page)).toMatchObject({ present: true, box: true })
    } finally {
      await page.close()
    }
  })

  it('ships the banner rules in the chrome stylesheet every admin document emits', async () => {
    // The route-level half of the visibility claim. A banner whose rules were not in ADMIN_BANNER_CSS
    // would render unstyled on all ten documents with nothing failing anywhere, and the browser is
    // where "the stylesheet reached the document" can actually be asked.
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await render(page, inboxHtml({ queued: 99, threshold: 20 }))
      const padding = await page.evaluate((attribute) => {
        const element = document.querySelector(`[${attribute}]`)
        return element === null ? null : window.getComputedStyle(element).paddingTop
      }, MESSAGES_DELAYED_BANNER_ATTRIBUTE)
      // A styled banner has the token padding; an unstyled `<section>` has none.
      expect(padding).not.toBe('0px')
      expect(ADMIN_BANNER_CSS).toContain('.messages-delayed {')
    } finally {
      await page.close()
    }
  })
})
