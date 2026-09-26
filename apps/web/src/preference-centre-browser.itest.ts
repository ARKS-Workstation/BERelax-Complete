import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OPT_OUT_TOKEN_TTL_SECONDS, suppressionKeyNormaliser } from '@berelax/core'
import {
  type Actor,
  applyPreferenceSelection,
  createConnection,
  issueOptOutGrant,
  PREFERENCE_CENTRE_ACTOR_LABEL,
  PREFERENCE_GRID,
  type Sql,
  type SuppressionKeying,
  seedConsent,
  withUnitOfWork,
} from '@berelax/db'
import { fixtureSuppressionPeppers, syntheticPerson } from '@berelax/fixtures'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import {
  captureUntilStable,
  DETERMINISM_CSS,
  DETERMINISTIC_LAUNCH_ARGS,
} from '@berelax/harness/determinism'
import { DIRECTIONS, THEMES, VIEWPORTS } from '@berelax/harness/matrix'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { PREFERENCE_CENTRE_PATH, preferenceCentrePath } from '@berelax/shared'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  handlePreferenceCentreRead,
  type PreferenceCentreDeps,
  readPreferenceRequest,
} from '../app/(public)/preferences/handler.ts'
import { callerAddress } from '../app/api/v1/otp/handler.ts'
import { repositoryRoot } from './media/storage.ts'

/**
 * C-CRM-07 — the preference centre in a browser: no JavaScript, axe, and the twelve screenshots.
 *
 * ## Why this is a second file, and the only one of the two that starts a server
 *
 * `preference-centre.itest.ts` holds every claim about rows and refusals and calls the handler directly,
 * which is right for those: a `next start` in front of them would add a router and a form parser without
 * changing one of them. One acceptance criterion cannot be made that way and it is the first one —
 * *"Playwright with JavaScript disabled: the page renders and the form submits successfully"*. A form
 * submission is the browser turning a `<form method="post">` into a request and following the 303, which
 * needs something listening. So this file starts the built application through `startWebServer` (brief rules
 * 18 and 19) on the `preference-centre` band, and it is the only claimant of that band.
 *
 * Keeping it apart is what makes gate block 99 affordable: a mutant that breaks a row-level claim re-runs the
 * suite that proves it, and a suite carrying a production build, twelve axe audits and twelve screenshots
 * costs minutes per mutant to re-prove something none of them touches.
 *
 * ## Isolation (brief rule 12)
 *
 * `syntheticPerson(9_704)` is this file's alone — the sibling seeds 9_701 to 9_703 and 9_705 to 9_706 — and
 * the withdrawal below is COMMITTED, because there is no transaction a separate process can be rolled back
 * inside. `consent` and `suppression` are append-only, so the delta is counted in SQL on both sides of the
 * click and never as a total. The rate-limit attempt log is left alone: this file makes one page load per
 * run, well inside the limit, and its sibling clears the band.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const SCREENS = join(repositoryRoot(), 'artifacts', 'screens', 'C-CRM-07')

/**
 * This file's own contact. 9_701 to 9_703 and 9_705 to 9_706 belong to the sibling suite.
 *
 * The 9_7xx band, and the sibling's header records the two bands tried before it and what each collision
 * cost — 9_5xx is `merge.itest.ts`'s and 9_6xx is `duplicate-queue.ts`'s, the second through a record of bare
 * numbers that no grep for `syntheticPerson(` can see. The withdrawal below is committed, so this file would
 * have done the same damage.
 */
const SUBJECT = syntheticPerson(9_704)
const SEEDED_ISO = '2026-09-18T10:00:00.000Z'
/** The instant the axe and screenshot documents are rendered at, so no render reads a clock. */
const READ_ISO = '2026-09-19T13:00:00.000Z'

const ACTOR: Actor = { kind: 'system', label: 'Preference centre browser itest fixture' }
/** RFC 5737 block two, and an address the sibling does not use. */
const REQUEST_IP = '198.51.100.140'

let sql: Sql
let keying: SuppressionKeying
let server: WebServer | undefined
let browser: Browser
let subjectId = ''

/** Deps with the clock frozen, for the documents axe and the camera see. */
const depsAt = (nowIso: string): PreferenceCentreDeps => ({ sql, now: () => nowIso, keying })

async function mintToken(contactId: string, ttlSeconds = OPT_OUT_TOKEN_TTL_SECONDS) {
  return withUnitOfWork(sql, ACTOR, (uow) =>
    issueOptOutGrant(uow, {
      contactCustomerId: contactId,
      channel: 'sms',
      purpose: 'preference_centre',
      issuedAtIso: SEEDED_ISO,
      ttlSeconds,
    }),
  )
}

async function readPage(args: {
  readonly contactId: string
  readonly token: string
  readonly locale?: 'en' | 'ar'
}): Promise<Response> {
  const params = new URLSearchParams({
    c: args.contactId,
    t: args.token,
    lang: args.locale ?? 'en',
  })
  const headers = new Headers({ 'x-forwarded-for': REQUEST_IP })
  const requested = new URL(`https://berelax.test${PREFERENCE_CENTRE_PATH}?${params.toString()}`)
  return await handlePreferenceCentreRead(
    readPreferenceRequest(requested, headers, callerAddress),
    depsAt(READ_ISO),
  )
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 4 })
  keying = { peppers: fixtureSuppressionPeppers(process.env), normalise: suppressionKeyNormaliser }

  // Idempotent, and it creates the `customer` row as well as the consent: `customer-identity.itest.ts`
  // clears that table between its cases, so a file that assumed the contact was still there would pass or
  // fail on vitest's file ordering.
  await seedConsent(sql, {
    contacts: [
      {
        phoneE164: SUBJECT.phone,
        locale: 'en' as const,
        state: 'granted' as const,
        label: SUBJECT.label,
      },
    ],
    recordedAtIso: SEEDED_ISO,
  })
  const [row] = await sql<{ id: string }[]>`
    select id from customer where phone_e164 = ${SUBJECT.phone}
  `
  if (row === undefined) throw new Error(`No fixture contact for ${SUBJECT.phone}`)
  subjectId = row.id

  server = await startWebServer({
    suite: 'preference-centre',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: '/robots.txt',
    readyWithinMs: 90_000,
    env: {
      // The route calls `loadConfig()` and `loadSuppressionPeppers()`. Declared rather than assumed: a run
      // that exported only TEST_DATABASE_URL would get a 500 that reads like a broken route, and a run with
      // no pepper would report a successful unsubscribe and suppress nobody — which is the one failure this
      // whole unit exists to prevent.
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL: url as string,
      SUPPRESSION_PEPPER: keying.peppers.current.secret,
      SUPPRESSION_PEPPER_VERSION: keying.peppers.current.version,
    },
  })
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 300_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop()
  await sql?.end({ timeout: 5 })
})

// ------------------------------------------------------------------------------------------------

describe('acceptance — the page renders and its form submits with JavaScript disabled', () => {
  it('loads over HTTP, posts a toggle and records it, with no script running at all', async () => {
    const issued = await mintToken(subjectId)
    /*
      The pair put back into `granted`, so this case asserts the same direction on every run.

      The click below commits a real withdrawal — there is no transaction a separate process can be rolled
      back inside — so the second run of this file found `sms:marketing` already withdrawn and the button
      reading "Start again". Making the case direction-aware would double every delta assertion; putting the
      pair back is one write.

      The instant is `Date.now()` and its two earlier spellings both failed, each for a reason worth keeping.
      A fixed 2026-09-19 instant failed because the page under test is fetched over HTTP, so the SERVER
      resolves the grid at its own clock and the previous run's withdrawal is stamped with that — newer than
      any instant in the past, so `resolveConsent` went on answering `withdrawn`. `Date.now() - 60_000`
      failed for the narrower version of the same thing: two runs less than a minute apart put the grant
      BEFORE the withdrawal it was meant to supersede. Now is strictly after every committed withdrawal and
      strictly before the one this run is about to make, and millisecond resolution is what keeps
      `consent_one_record_per_instant` from turning the write into a silent no-op.

      `wording: null` makes the write read the published statement for each purpose, which is what a grant
      needs and what a caller that rendered nothing must not invent.
    */
    const setupIso = new Date().toISOString()
    await withUnitOfWork(sql, ACTOR, (uow) =>
      applyPreferenceSelection(uow, keying, {
        contactCustomerId: subjectId,
        action: 'resubscribe',
        scope: { kind: 'pair', channel: 'sms', purpose: 'marketing' },
        recipient: SUBJECT.phone,
        keyKind: 'phone',
        locale: 'en',
        wording: null,
        decidedAtIso: setupIso,
        actorLabel: PREFERENCE_CENTRE_ACTOR_LABEL,
      }),
    )
    const origin = server?.origin
    if (origin === undefined) throw new Error('the web server did not start')
    const context: BrowserContext = await browser.newContext({
      // The whole point of the case. Next ships a client bundle for every route group, so "server-rendered
      // with no required client island" is only a claim until a browser with scripting off has submitted the
      // form and the row has landed.
      javaScriptEnabled: false,
      viewport: { width: 390, height: 844 },
      locale: 'en-AE',
      timezoneId: 'Asia/Dubai',
    })
    try {
      const page = await context.newPage()
      /*
        THE CONTROL that scripting really is off, and it took two attempts to write one that works.

        `page.evaluate` is NOT it: Playwright runs it through CDP in an isolated world and it answers
        perfectly well with `javaScriptEnabled: false` — documented behaviour, and this case's first draft
        asserted that it would reject, which made the control pass for the wrong reason and then fail. An
        INIT SCRIPT is page JavaScript, so it does not run at all when scripting is off, and it is made
        observable WITHOUT `evaluate` by having it change the title: if the title below is the mutated one,
        the context had scripting on and every assertion after it proves nothing about the no-script path.
      */
      await page.addInitScript(() => {
        document.title = 'SCRIPTING RAN'
      })
      const href = `${origin}${preferenceCentrePath({
        contactId: subjectId,
        token: issued.token,
        locale: 'en',
      })}`
      const landed = await page.goto(href, { waitUntil: 'load' })
      expect(landed?.status(), 'the page a live link opens').toBe(200)
      expect(await page.title(), 'an init script ran, so scripting was NOT off').toBe(
        'Your message preferences',
      )
      // And there is nothing to disable in the first place: a route handler answers raw bytes, so Next
      // injects no client bundle and the document carries no script tag at all.
      expect(await (await fetch(href)).text()).not.toContain('<script')

      const cells = page.locator('[data-preference-cell]')
      expect(await cells.count()).toBe(PREFERENCE_GRID.length)
      const target = page.locator('[data-preference-cell="sms:marketing"]')
      expect(await target.getAttribute('data-preference-state')).toBe('granted')

      const before = await preferenceCentreWrites(subjectId)
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load' }),
        target.locator('button[type="submit"]').click(),
      ])

      // The 303 was followed and the reader is back on the page, told what happened.
      expect(new URL(page.url()).pathname).toBe(PREFERENCE_CENTRE_PATH)
      expect(new URL(page.url()).searchParams.get('done')).toBe('stopped')
      // Still no scripting after the navigation the FORM caused, which is the half the control above cannot
      // reach: a redirect target that shipped a bundle would be a page that only works with JavaScript.
      expect(await page.title()).toBe('Your message preferences')
      expect(await page.locator('[data-preference-state="stopped"]').count()).toBe(1)
      // And the cell now reads the other way, which is the page reflecting a row rather than a redirect.
      expect(
        await page
          .locator('[data-preference-cell="sms:marketing"]')
          .getAttribute('data-preference-state'),
      ).toBe('withdrawn')

      // The rows, which are the only proof that the submission reached the database rather than the router.
      const after = await preferenceCentreWrites(subjectId)
      expect(after.withdrawals - before.withdrawals).toBe(1)
      expect(after.suppressions - before.suppressions).toBe(1)
    } finally {
      await context.close()
    }
  }, 180_000)
})

/** The two deltas a preference-centre write leaves, counted in SQL because both tables are append-only. */
async function preferenceCentreWrites(
  contactId: string,
): Promise<{ readonly withdrawals: number; readonly suppressions: number }> {
  const [row] = await sql<{ withdrawals: string; suppressions: string }[]>`
    select (select count(*) from consent
             where contact_customer_id = ${contactId}::uuid
               and kind = 'withdrawn' and capture_source = 'preference_centre')::text as withdrawals,
           (select count(*) from suppression
             where contact_customer_id = ${contactId}::uuid
               and source = 'preference_centre')::text as suppressions
  `
  return {
    withdrawals: Number(row?.withdrawals ?? 0),
    suppressions: Number(row?.suppressions ?? 0),
  }
}

// ------------------------------------------------------------------------------------------------

interface Cell {
  readonly width: number
  readonly height: number
  readonly theme: 'light' | 'dark'
  readonly direction: 'ltr' | 'rtl'
  readonly viewportName: string
}

const CELLS: readonly Cell[] = VIEWPORTS.flatMap((viewport) =>
  THEMES.flatMap((theme) =>
    DIRECTIONS.map((direction) => ({
      width: viewport.width,
      height: viewport.height,
      theme,
      direction,
      viewportName: viewport.name,
    })),
  ),
)

describe('acceptance — axe is clean and the render is reproducible', () => {
  /**
   * The document under the camera, for one cell.
   *
   * `setContent` rather than `goto`, because the renderer is pure and the bytes it produces ARE the response
   * — so there is nothing between the renderer and the assertion. The direction axis is the LOCALE: an RTL
   * cell is the Arabic reader's document, not the English one with an attribute flipped.
   */
  async function withCell<T>(
    cell: Cell,
    html: string,
    body: (page: Page) => Promise<T>,
  ): Promise<T> {
    const context: BrowserContext = await browser.newContext({
      viewport: { width: cell.width, height: cell.height },
      deviceScaleFactor: 1,
      colorScheme: cell.theme,
      locale: cell.direction === 'rtl' ? 'ar-AE' : 'en-AE',
      timezoneId: 'Asia/Dubai',
      reducedMotion: 'reduce',
    })
    try {
      const page = await context.newPage()
      await page.setContent(html, { waitUntil: 'load' })
      await page.addStyleTag({ content: DETERMINISM_CSS })
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      return await body(page)
    } finally {
      await context.close()
    }
  }

  const backgroundLuminance = (page: Page): Promise<number> =>
    page.evaluate(() => {
      const colour = globalThis.getComputedStyle(document.body).backgroundColor
      const parts = colour.match(/\d+(\.\d+)?/g)?.map(Number) ?? [255, 255, 255]
      const [r, g, b] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    })

  let english = ''
  let arabic = ''

  beforeAll(async () => {
    const issued = await mintToken(subjectId)
    english = await (
      await readPage({ contactId: subjectId, token: issued.token, locale: 'en' })
    ).text()
    arabic = await (
      await readPage({ contactId: subjectId, token: issued.token, locale: 'ar' })
    ).text()
    expect(english).toContain('data-preference-body="grid"')
    expect(arabic).toContain('<html lang="ar" dir="rtl">')
  }, 120_000)

  const documentFor = (cell: Cell): string => (cell.direction === 'rtl' ? arabic : english)

  it('reports zero serious or critical violations in all twelve cells', async () => {
    // Twelve, stated rather than counted after the fact: a matrix that lost an axis would report a pass over
    // six renders.
    expect(VIEWPORTS.map((viewport) => viewport.width)).toEqual([390, 768, 1440])
    expect(CELLS).toHaveLength(12)

    const luminance: Record<string, number> = {}
    let audited = 0
    for (const cell of CELLS) {
      const where = `${cell.viewportName} ${cell.theme} ${cell.direction}`
      const { violations, width, dir, lum } = await withCell(
        cell,
        documentFor(cell),
        async (page) => {
          const result = await auditPage(page, {
            page: 'preference-centre',
            viewport: {
              name: cell.viewportName,
              width: cell.width,
              height: cell.height,
              scale: 1,
              why: 'C-CRM-07 acceptance',
            },
            theme: cell.theme,
            direction: cell.direction,
          })
          return {
            violations: result.violations,
            width: await page.evaluate(() => globalThis.innerWidth),
            dir: await page.evaluate(() => document.documentElement.getAttribute('dir')),
            lum: await backgroundLuminance(page),
          }
        },
      )
      // Each render is the cell it claims to be. Without this, twelve identical light LTR audits would
      // satisfy the count and the labels would be the only thing that differed.
      expect(width, `${where}: viewport`).toBe(cell.width)
      expect(dir, `${where}: direction`).toBe(cell.direction)
      luminance[where] = lum
      const blocking = blockingViolations(violations)
      expect(
        blocking.map(describeViolation),
        `${where}: ${blocking.length} serious/critical violation(s)`,
      ).toEqual([])
      audited += 1
    }
    expect(audited).toBe(12)
    // The theme axis is real: the dark cell resolved a darker ground at every width and in both directions.
    for (const viewport of VIEWPORTS) {
      for (const direction of DIRECTIONS) {
        expect(
          luminance[`${viewport.name} dark ${direction}`],
          `${viewport.name} ${direction}: dark is darker than light`,
        ).toBeLessThan(luminance[`${viewport.name} light ${direction}`] ?? 0)
      }
    }
  }, 600_000)

  it('finds the two defects a known-bad version of this page has, by rule id', async () => {
    // The control on the audit itself. A sweep that reported zero because axe never ran would pass the case
    // above for ever (ADR 0003), so the page is audited again with an unlabelled button and body text on the
    // decorative gold — the two failures docs/08 fences off — injected into the DOM.
    const cell = CELLS[0] as Cell
    const violations = await withCell(cell, english, async (page) => {
      await page.evaluate(() => {
        const button = document.createElement('button')
        button.type = 'button'
        document.body.append(button)
        const text = document.createElement('p')
        text.textContent = 'Stop all promotional messages'
        const root = globalThis.getComputedStyle(document.documentElement)
        text.style.color = root.getPropertyValue('--color-decor-gold')
        text.style.backgroundColor = root.getPropertyValue('--color-surface-sand')
        document.body.append(text)
      })
      const result = await auditPage(page, {
        page: 'preference-centre (known-bad)',
        viewport: {
          name: cell.viewportName,
          width: cell.width,
          height: cell.height,
          scale: 1,
          why: 'the control',
        },
        theme: cell.theme,
        direction: cell.direction,
      })
      return result.violations
    })
    const ids = violations.map((violation) => violation.id)
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('button-name')
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('color-contrast')
    expect(blockingViolations(violations).map((violation) => violation.id)).toContain('button-name')
  }, 180_000)

  it('captures 3 viewports x 2 themes x 2 directions with zero pixel diff on a repeat run', async () => {
    mkdirSync(SCREENS, { recursive: true })
    const shots = new Map<string, Uint8Array>()
    for (const cell of CELLS) {
      const label = `preference-centre__${cell.theme}-${cell.viewportName}-${cell.direction}`
      /*
        Through `captureUntilStable` rather than comparing capture one to capture two, because that also
        asserts paint had SETTLED by the first capture — untrue at load 10 on a four-core box. The helper
        throws `[screenshot-never-stabilised]` when no two consecutive captures agree, which is exactly what
        a clock or a generated id reaching the render produces. Nothing in `render.ts` reads either, which is
        what this case is here to keep true.
      */
      const stable = await captureUntilStable(
        () =>
          withCell(cell, documentFor(cell), (page) =>
            page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' }),
          ),
        { label },
      )
      expect(stable.png.byteLength, label).toBeGreaterThan(1000)
      expect(stable.attemptsUsed, `${label} settled in`).toBeLessThanOrEqual(5)
      shots.set(label, stable.png)
      writeFileSync(join(SCREENS, `${label}.png`), stable.png)
    }
    expect(shots.size).toBe(12)

    // The control on the comparison: different cells are not identical. Without it, a screenshot function
    // that returned the same bytes every time would pass every assertion above.
    const differs = (left: string, right: string): number =>
      Buffer.compare(
        Buffer.from(shots.get(left) ?? new Uint8Array()),
        Buffer.from(shots.get(right) ?? new Uint8Array()),
      )
    const first = VIEWPORTS[0]?.name as string
    const last = VIEWPORTS[2]?.name as string
    expect(
      differs(`preference-centre__light-${first}-ltr`, `preference-centre__dark-${first}-ltr`),
    ).not.toBe(0)
    expect(
      differs(`preference-centre__light-${first}-ltr`, `preference-centre__light-${last}-ltr`),
    ).not.toBe(0)
    expect(
      differs(`preference-centre__light-${first}-ltr`, `preference-centre__light-${first}-rtl`),
    ).not.toBe(0)
  }, 600_000)
})
