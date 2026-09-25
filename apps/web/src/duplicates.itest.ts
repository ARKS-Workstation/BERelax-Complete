import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nameMatchKey, normalisePhone } from '@berelax/core'
import { type Actor, createConnection, ensureCustomer, type Sql, withUnitOfWork } from '@berelax/db'
import {
  customerLabel,
  DUPLICATE_QUEUE_FIXTURE_INSTANTS,
  type SeededDuplicateQueueFixture,
  SYNTHETIC_MOBILE_PREFIX,
  seedDuplicateQueueFixture,
} from '@berelax/fixtures'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import {
  captureUntilStable,
  DETERMINISM_CSS,
  DETERMINISTIC_LAUNCH_ARGS,
} from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { repositoryRoot } from './media/storage.ts'

/**
 * C-CRM-06 — the duplicate review queue and the merge preview, driven against the built application.
 *
 * Four claims live here and nowhere else, because none can be checked by reading source: the queue LISTS
 * the pairs above the review threshold in score order; **no `merge_record` row exists until the confirm
 * step is clicked**, asserted as a row count either side of the click; the survivor choice is real, because
 * swapping it changes the previewed row counts in both directions; and **axe** reports nothing serious or
 * critical on a rendered DOM at three viewports, in two themes and in both directions, with the same pages
 * photographed twice producing byte-identical images.
 *
 * ## Why the direction axis exists here and not on the other admin screens
 *
 * `/compliance`, the Messages inbox, the HR credentials screen and the template editor are all English-only
 * route handlers and say so: a registry *document* must be served in both locales, which needs an Arabic
 * admin document and the W-SYS-01 shell. This unit's acceptance list asks for both directions, so `?dir=rtl`
 * re-renders the same English document mirrored. That is a LAYOUT axis rather than a locale, and it is worth
 * having: every inset, border and alignment on these two pages is written with logical properties, and the
 * mirrored render is the only thing that would catch a physical one.
 *
 * ## Isolation, and the two rows this suite cannot take back
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind (brief
 * rule 12), so every assertion narrows the queue with `?customer=` and every screenshot is taken at a fixed
 * `?at=`. The shared fixture is `seedDuplicateQueueFixture`, which `packages/fixtures/src/merge-preview.itest.ts`
 * also drives — one set of pairs, so the two suites cannot drift into asserting different bands.
 *
 * The CONFIRM case is different and the difference is stated rather than hidden. It merges for real, over
 * HTTP, in a separate process: there is no transaction this file can roll back, `merge_record` refuses DELETE
 * for every role including the owner (ZT001), and the append-only rows a merge copies cannot be removed. So
 * that case mints its OWN pair per run — a fresh number in a band nothing else uses — merges it, and deletes
 * the two customer rows afterwards. What necessarily stays is the `merge_record` row and its per-table
 * reports, pointing at two ids that no longer exist. That is an ordinary state for this table (it has
 * deliberately no foreign key to `customer`, 0069 says why) and it is the same state
 * `customer-identity.itest.ts` leaves behind every time it clears the customer table.
 *
 * Nothing here is a name: every label is `Customer NNNN` (ADR 0020).
 */
let BASE = ''
const SCREENS = join(repositoryRoot(), 'artifacts', 'screens', 'C-CRM-06')

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const MARKER = 'ccrm06 duplicates web itest'
const ACTOR: Actor = { kind: 'staff', label: MARKER }

/**
 * The fixed instant every page is rendered at.
 *
 * A fixed `?at=` is what makes a repeat capture byte-identical: the page prints the instant it resolved
 * consent at, so a render that read the clock could not be photographed twice.
 *
 * It comes from the shared fixture rather than being chosen here, and that is not tidiness. The first
 * version of this file picked its own year — 2094, before the fixture's consent rows are dated — and
 * `resolveConsent` ignores records AFTER the instant asked about, deliberately, so every consent cell on the
 * page read `unknown` and the failure named the assertion rather than the date.
 */
const AT = DUPLICATE_QUEUE_FIXTURE_INSTANTS.resolveAt

/**
 * The confirm case's own pair, minted per run.
 *
 * `+971 59` is unallocated and therefore undialable (`packages/fixtures/src/synthetic.ts` says why that is a
 * stronger guarantee than a convention). The index is `9_7xx_xx0` so the pair differs in its LAST digit
 * only, which is what makes it `one_digit_apart`; with identical labels that is 900 per mille, the review
 * band, and `operator_confirmed` may act on it. A fresh pair per run because a merge is not repeatable:
 * `merge_record_one_merge_per_loser` makes the second attempt on one pair `already_merged` for ever.
 */
const CONFIRM_INDEX = 9_700_000 + Math.floor(Math.random() * 10_000) * 10
const CONFIRM_LABEL = customerLabel(CONFIRM_INDEX)
const confirmPhone = (index: number): string =>
  `+971${SYNTHETIC_MOBILE_PREFIX}${String(index).padStart(7, '0')}`

let server: WebServer
let browser: Browser
let sql: Sql
let fixture: SeededDuplicateQueueFixture
let confirmSurvivorId = ''
let confirmLoserId = ''

const scope = (...ids: readonly string[]): string =>
  ids.map((id) => `&customer=${encodeURIComponent(id)}`).join('')

const queuePath = (...ids: readonly string[]): string =>
  `/clients/duplicates?at=${encodeURIComponent(AT)}${scope(...ids)}`

const previewPath = (
  survivorId: string,
  loserId: string,
  direction: 'ltr' | 'rtl' = 'ltr',
): string =>
  `/clients/duplicates/preview?survivor=${encodeURIComponent(survivorId)}` +
  `&loser=${encodeURIComponent(loserId)}&at=${encodeURIComponent(AT)}` +
  (direction === 'rtl' ? '&dir=rtl' : '')

/** Counted in SQL, never through a capped reader: `merge_record` only ever grows (brief rule 9). */
async function mergeRecordCount(loserId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from merge_record where loser_customer_id = ${loserId}::uuid
  `
  return Number(row?.n ?? '0')
}

async function ensureConfirmPair(): Promise<void> {
  const ensure = async (index: number): Promise<string> => {
    const e164 = normalisePhone(confirmPhone(index))
    return withUnitOfWork(sql, ACTOR, async (uow) => {
      const result = await ensureCustomer(uow, {
        phoneE164: e164,
        // The same label on both records, which is what two rows for one person look like when the front
        // desk typed the same thing twice.
        displayName: CONFIRM_LABEL,
        nameMatchKey: nameMatchKey(CONFIRM_LABEL, e164),
        locale: 'en',
        createdVia: 'front_desk',
      })
      return result.customer.id
    })
  }
  // The survivor first, so it is the earlier record and the default survivor is the one asserted below.
  confirmSurvivorId = await ensure(CONFIRM_INDEX)
  confirmLoserId = await ensure(CONFIRM_INDEX + 1)
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  fixture = await seedDuplicateQueueFixture(sql, MARKER)
  await ensureConfirmPair()

  server = await startWebServer({
    suite: 'duplicates',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: '/robots.txt',
    readyWithinMs: 90_000,
    env: {
      // Both routes call `loadConfig()`. Declared rather than assumed, the note every admin suite makes: a
      // local run that exported only TEST_DATABASE_URL would get a 503 that reads like a broken route.
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL: url,
    },
  })
  BASE = server.origin
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 300_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop()
  // The confirm pair's customer rows go; its merge_record cannot (ZT001) and does not need to — see the
  // file header. The shared fixture's six records stay: they are ensured, never merged, and
  // `merge-preview.itest.ts` drives the same ones.
  if (confirmLoserId !== '') {
    await sql`delete from customer where id in (${confirmSurvivorId}::uuid, ${confirmLoserId}::uuid)`
  }
  await sql?.end({ timeout: 5 })
})

// ------------------------------------------------------------------------------------------------
// The queue
// ------------------------------------------------------------------------------------------------

describe('acceptance — the queue lists candidates above the review threshold, in score order', () => {
  it('lists the two review-band pairs, highest first, with the default survivor named', async () => {
    const response = await fetch(
      `${BASE}${queuePath(
        fixture.nearMiss.survivorId,
        fixture.nearMiss.loserId,
        fixture.simChange.survivorId,
        fixture.simChange.loserId,
      )}`,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    // Derived from the registry by the proxy rather than written per route: `/clients` is a prefix in
    // ADMIN_GROUP_PREFIXES, so the client screens that land beside these two arrive noindex before they
    // are written.
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(response.headers.get('cache-control')).toContain('no-store')

    const html = await response.text()
    // The order, read off the rendered document: 0.900 before 0.710. A queue that shuffled would be a
    // queue a reviewer loses their place in.
    const scores = [...html.matchAll(/data-field="score">([0-9.]+)</g)].map((match) => match[1])
    expect(scores).toEqual(['0.900', '0.710'])
    // Both pairs are present as pairs, and the survivor of each is the earlier record.
    expect(html).toContain(fixture.nearMiss.survivorId)
    expect(html).toContain(fixture.nearMiss.loserId)
    expect(html).toContain(fixture.simChange.survivorId)
    // The signal that matched is on the row, because a single number cannot say whether the phones agreed
    // or only the labels did.
    expect(html).toContain('one_digit_apart')
    expect(html).toContain('different')
    // And the page says it merges nothing, which is this unit's provisional line on its face.
    expect(html).toContain('Nothing on this page merges anything')
  }, 60_000)

  it('leaves a pair below the review threshold out, and says how many it left out', async () => {
    const html = await (
      await fetch(`${BASE}${queuePath(fixture.belowBand.survivorId, fixture.belowBand.loserId)}`)
    ).text()
    // The known-bad fixture the acceptance list asks for. The scan DOES return this pair — C-CRM-02's
    // floors are deliberately looser than the scorer's classes — so its absence is the threshold's doing.
    expect(html).toContain('Nothing to review')
    expect(html).not.toContain('data-field="score"')
    // The counts are what make the absence legible: a pair was found and it was below the band.
    expect(html).toMatch(/Pairs the scan found<\/dt><dd>1<\/dd>/)
    expect(html).toMatch(/Below the review threshold<\/dt><dd>1<\/dd>/)
    // The control: the same page for the near-miss pair DOES list it, so "Nothing to review" above is
    // about the score and not about a scope that matched nothing.
    const listed = await (
      await fetch(`${BASE}${queuePath(fixture.nearMiss.survivorId, fixture.nearMiss.loserId)}`)
    ).text()
    expect(listed).toContain('data-field="score"')
  }, 60_000)

  it('refuses a scope that is not a uuid rather than rendering an empty queue', async () => {
    // An empty queue is the one answer this screen must never give by accident: it reads as "there are no
    // duplicates". A 400 says which of the two it was.
    const response = await fetch(`${BASE}/clients/duplicates?customer=not-a-uuid`)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('a customer scope is a uuid')
    // And an unparseable instant, for the same reason `/compliance` refuses one.
    expect((await fetch(`${BASE}/clients/duplicates?at=not-a-date`)).status).toBe(400)
  }, 30_000)
})

// ------------------------------------------------------------------------------------------------
// The preview, and the confirm step
// ------------------------------------------------------------------------------------------------

describe('acceptance — no merge_record row exists until the confirm step is clicked', () => {
  it('previews as many times as you like and writes nothing, then writes exactly one on confirm', async () => {
    const before = await mergeRecordCount(confirmLoserId)
    expect(before).toBe(0)

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    try {
      const page = await context.newPage()
      // The queue, narrowed to the confirm pair, and the link is followed rather than typed: the assertion
      // is that the screen a reviewer reaches from the queue is the screen that merges.
      await page.goto(`${BASE}${queuePath(confirmSurvivorId, confirmLoserId)}`, {
        waitUntil: 'networkidle',
      })
      await page.locator('a.action').first().click()
      await page.waitForLoadState('networkidle')
      expect(page.url()).toContain('/clients/duplicates/preview')
      expect(await page.locator('[data-role="survivor"] [data-field="id"]').innerText()).toBe(
        confirmSurvivorId,
      )

      // Previewed twice, and still nothing written. `merge_record` is inserted BEFORE any row moves, so a
      // preview that reused the merge path without rolling back would have tombstoned this record here.
      await page.reload({ waitUntil: 'networkidle' })
      expect(await mergeRecordCount(confirmLoserId), 'a preview wrote a merge_record').toBe(0)

      // The confirm step: both fields are required by the form and by the database, which refuses a
      // placeholder in either (0069).
      await page.fill('#authorisedBy', 'Front desk supervisor (integration suite)')
      await page.fill(
        '#reason',
        'One person, two records: the same handset was entered twice at the front desk.',
      )
      await page.click('button[type="submit"]')
      await page.waitForLoadState('networkidle')

      // Exactly one, and the page it redirected to reads it back off the tombstone.
      expect(await mergeRecordCount(confirmLoserId)).toBe(1)
      expect(await page.locator('h1').innerText()).toContain('Already merged')
      const recordId = await page.locator('[data-field="merge-record"]').innerText()
      expect(recordId).toMatch(/^[0-9a-f-]{36}$/)

      // And a second confirm cannot happen: the preview for the same pair now answers `already_merged`
      // rather than offering the button again.
      await page.goto(`${BASE}${previewPath(confirmSurvivorId, confirmLoserId)}`, {
        waitUntil: 'networkidle',
      })
      expect(await page.locator('h1').innerText()).toContain('Already merged')
      expect(await page.locator('button[type="submit"]').count()).toBe(0)
      expect(await mergeRecordCount(confirmLoserId)).toBe(1)
    } finally {
      await context.close()
    }
  }, 180_000)

  it('refuses a confirm with no authoriser and no reason, having written nothing', async () => {
    const pair = fixture.nearMiss
    const before = await mergeRecordCount(pair.loserId)
    const body = new URLSearchParams({
      survivor: pair.survivorId,
      loser: pair.loserId,
      confirm: 'yes',
      authorisedBy: '   ',
      reason: '',
    })
    const response = await fetch(`${BASE}/clients/duplicates/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('authorisedBy is required')
    expect(await mergeRecordCount(pair.loserId)).toBe(before)

    // And a POST that never came from the form at all. The button carries `confirm=yes`; a merge is not an
    // operation to perform for a caller that has not said it means to.
    const unconfirmed = await fetch(`${BASE}/clients/duplicates/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        survivor: pair.survivorId,
        loser: pair.loserId,
        authorisedBy: 'Front desk supervisor (integration suite)',
        reason: 'One person, two records.',
      }).toString(),
    })
    expect(unconfirmed.status).toBe(400)
    expect(await unconfirmed.text()).toContain('confirm must be "yes"')
    expect(await mergeRecordCount(pair.loserId)).toBe(before)
  }, 60_000)

  it('refuses to preview a pair the scorer calls distinct, by name', async () => {
    // A hand-typed URL for two records that are not a duplicate. The plan refuses it under BOTH
    // authorities, so there is no page with a merge button on it for this pair.
    const response = await fetch(
      `${BASE}${previewPath(fixture.belowBand.survivorId, fixture.belowBand.loserId)}`,
    )
    expect(response.status).toBe(409)
    const text = await response.text()
    expect(text).toContain('refusal: merge_verdict_is_distinct')
    // The control: the review-band pair previews, so the refusal is about the band.
    expect(
      (await fetch(`${BASE}${previewPath(fixture.nearMiss.survivorId, fixture.nearMiss.loserId)}`))
        .status,
    ).toBe(200)
  }, 60_000)
})

describe('acceptance — the survivor is a choice, and swapping it changes the preview', () => {
  it('defaults to the earliest created_at and swaps in both directions', async () => {
    const pair = fixture.nearMiss
    const defaultWay = await (
      await fetch(`${BASE}${previewPath(pair.survivorId, pair.loserId)}`)
    ).text()
    const swapped = await (
      await fetch(`${BASE}${previewPath(pair.loserId, pair.survivorId)}`)
    ).text()

    // The default: the earlier record, and the page says it is the default rather than leaving a reviewer
    // to work out which it is.
    expect(defaultWay).toContain('This is the <strong>default</strong> survivor')
    expect(swapped).toContain('chosen by hand')

    const movedIn = (html: string): string => {
      const row =
        /<tr data-participant="public\.customer_tag">([\s\S]*?)<\/tr>/.exec(html)?.[1] ?? ''
      return /data-field="moved">(\d+)</.exec(row)?.[1] ?? 'no row'
    }
    const retainedIn = (html: string): string => {
      const row =
        /<tr data-participant="public\.customer_tag">([\s\S]*?)<\/tr>/.exec(html)?.[1] ?? ''
      return /data-field="retained">(\d+)</.exec(row)?.[1] ?? 'no row'
    }

    // Both directions asserted. Keeping the earlier record (one tag) moves the later record's `walk-in`;
    // keeping the later record (two tags) moves nothing, because the only tag the earlier one holds is one
    // it already carries and `customer_tag`'s primary key refuses the second copy.
    expect(movedIn(defaultWay)).toBe('1')
    expect(movedIn(swapped)).toBe('0')
    expect(retainedIn(defaultWay)).toBe('1')
    expect(retainedIn(swapped)).toBe('1')
    // A retained row states WHY, because a row left on the tombstone is the one that looks lost.
    expect(defaultWay).toContain('already carries that tag')
  }, 60_000)

  it('shows the consent state the merge would produce, and the one it starts from', async () => {
    const pair = fixture.nearMiss
    const html = await (await fetch(`${BASE}${previewPath(pair.survivorId, pair.loserId)}`)).text()
    const row = /<tr data-consent="sms\/marketing">([\s\S]*?)<\/tr>/.exec(html)?.[1] ?? ''
    // The worked example: the kept record granted marketing on sms, the merged-away record withdrew it
    // later, and a withdrawal on either record governs the survivor when it is the newest thing either of
    // them said. Both columns, because the "after" alone would be satisfied by a page that printed the
    // current state twice.
    expect(/data-field="before">([a-z]+)</.exec(row)?.[1]).toBe('granted')
    expect(/data-field="after">([a-z]+)</.exec(row)?.[1]).toBe('withdrawn')
    // The number is the one thing a merge can never transfer, and the reviewer is shown both.
    expect(html).toContain('not_transferable')
    expect(html).toContain(pair.survivorPhone)
    expect(html).toContain(pair.loserPhone)
  }, 60_000)
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
  const context: BrowserContext = await browser.newContext({
    viewport: { width: cell.width, height: cell.height },
    deviceScaleFactor: 1,
    colorScheme: cell.theme,
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
 * Read rather than asserted against a literal: a hex or `rgb()` in this file would be an un-tokened colour
 * and `pnpm colours` would reject it, rightly. The claim that matters is that the dark cell really is
 * darker, so the theme axis is a rendered difference rather than a filename.
 */
async function backgroundLuminance(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const colour = globalThis.getComputedStyle(document.body).backgroundColor
    const [r = 0, g = 0, b = 0] = (colour.match(/\d+(\.\d+)?/g) ?? []).map(Number)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  })
}

describe('acceptance — axe reports nothing serious or critical, in twenty-four renders', () => {
  it('audits both screens at 390/768/1440 x light/dark x ltr/rtl, and each render is the cell it claims', async () => {
    // Twenty-four, stated rather than counted after the fact: a matrix that lost an axis would report a
    // pass over twelve renders.
    expect(CELLS).toHaveLength(12)
    const pair = fixture.nearMiss
    const paths = [
      [
        'queue',
        queuePath(
          pair.survivorId,
          pair.loserId,
          fixture.simChange.survivorId,
          fixture.simChange.loserId,
        ),
      ],
      ['preview', previewPath(pair.survivorId, pair.loserId)],
    ] as const

    const luminance: Record<string, number> = {}
    let audited = 0
    for (const [label, path] of paths) {
      for (const cell of CELLS) {
        const where = `${label} ${cell.theme} ${cell.direction} ${cell.width}px`
        const { violations, width, dir, lum } = await withCell(cell, path, async (page) => {
          const result = await auditPage(page, {
            page: label === 'queue' ? '/clients/duplicates' : '/clients/duplicates/preview',
            viewport: {
              name: `${cell.width}`,
              width: cell.width,
              height: cell.height,
              scale: 1,
              why: 'C-CRM-06 acceptance',
            },
            theme: cell.theme,
            direction: cell.direction,
          })
          return {
            violations: result.violations,
            width: await page.evaluate(() => globalThis.innerWidth),
            dir: await page.evaluate(() => document.documentElement.dir),
            lum: await backgroundLuminance(page),
          }
        })
        expect(width, `${where}: viewport`).toBe(cell.width)
        // The direction axis is real: the document really is mirrored, so twelve identical LTR renders
        // cannot satisfy the assertions above.
        expect(dir, `${where}: dir`).toBe(cell.direction)
        luminance[where] = lum
        const blocking = blockingViolations(violations)
        expect(
          blocking.map(describeViolation),
          `${where}: ${blocking.length} serious/critical violation(s)`,
        ).toEqual([])
        audited += 1
      }
    }
    expect(audited).toBe(24)
    // And the theme axis is real too: the dark cell resolved a darker ground at every width, on both
    // screens, in both directions.
    for (const label of ['queue', 'preview']) {
      for (const direction of ['ltr', 'rtl']) {
        for (const width of [390, 768, 1440]) {
          expect(
            luminance[`${label} dark ${direction} ${width}px`],
            `${label} dark ${direction} ${width}px is darker than light`,
          ).toBeLessThan(luminance[`${label} light ${direction} ${width}px`] ?? 0)
        }
      }
    }
  }, 900_000)

  it('reports the two defects a known-bad version of these pages has, by rule id', async () => {
    // The control on the audit itself. A sweep that reported zero because axe never ran would pass the
    // test above for ever (ADR 0003), so the queue is audited again with an unlabelled button and body text
    // on the decorative gold — the two failures docs/08 fences off — injected into the DOM.
    const violations = await withCell(
      { width: 390, height: 844, theme: 'light', direction: 'ltr' },
      queuePath(fixture.nearMiss.survivorId, fixture.nearMiss.loserId),
      async (page) => {
        await page.evaluate(() => {
          const button = document.createElement('button')
          button.type = 'button'
          document.body.append(button)
          const text = document.createElement('p')
          text.textContent = 'Merge these records'
          // The decorative gold on the sand surface: 2.90:1, and the reason --color-decor-gold never
          // carries text. Read from the token layer rather than typed, so this file states no colour.
          const root = globalThis.getComputedStyle(document.documentElement)
          text.style.color = root.getPropertyValue('--color-decor-gold')
          text.style.backgroundColor = root.getPropertyValue('--color-surface-sand')
          document.body.append(text)
        })
        const result = await auditPage(page, {
          page: '/clients/duplicates (known-bad)',
          viewport: { name: '390', width: 390, height: 844, scale: 1, why: 'the control' },
          theme: 'light',
          direction: 'ltr',
        })
        return result.violations
      },
    )
    const ids = violations.map((violation) => violation.id)
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('button-name')
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('color-contrast')
    expect(blockingViolations(violations).map((violation) => violation.id)).toContain('button-name')
  }, 180_000)
})

describe('acceptance — the same routes photographed twice are byte-identical', () => {
  it('captures both screens at 3 viewports x 2 themes x 2 directions twice, with zero pixel diff', async () => {
    mkdirSync(SCREENS, { recursive: true })
    const pair = fixture.nearMiss
    const shots = new Map<string, Uint8Array>()
    const paths = [
      [
        'queue',
        queuePath(
          pair.survivorId,
          pair.loserId,
          fixture.simChange.survivorId,
          fixture.simChange.loserId,
        ),
      ],
      ['preview', previewPath(pair.survivorId, pair.loserId)],
    ] as const

    for (const [name, path] of paths) {
      for (const cell of CELLS) {
        const label = `${name}__${cell.theme}-${cell.width}__${cell.direction}`
        /*
          The claim is about the PAGE: it renders from a database, and a document printing a relative time
          or a generated id could not render identically twice. Through `captureUntilStable` rather than
          comparing capture one to capture two, because that also asserts paint had settled by the first
          capture — untrue at load 10 on a four-core box.
        */
        const stable = await captureUntilStable(
          () =>
            withCell(cell, path, (page) =>
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

    // The control on the comparison: two DIFFERENT cells are not identical. Without it, a screenshot
    // function that returned the same bytes every time would pass every assertion above.
    const differs = (left: string, right: string): number =>
      Buffer.compare(
        Buffer.from(shots.get(left) ?? new Uint8Array()),
        Buffer.from(shots.get(right) ?? new Uint8Array()),
      )
    expect(differs('queue__light-390__ltr', 'queue__dark-390__ltr')).not.toBe(0)
    expect(differs('queue__light-390__ltr', 'queue__light-1440__ltr')).not.toBe(0)
    expect(differs('queue__light-390__ltr', 'queue__light-390__rtl')).not.toBe(0)
    expect(differs('queue__light-390__ltr', 'preview__light-390__ltr')).not.toBe(0)
  }, 900_000)
})
