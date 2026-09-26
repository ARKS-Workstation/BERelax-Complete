import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createConnection,
  moveCard,
  readPipelineStages,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import {
  captureUntilStable,
  DETERMINISM_CSS,
  DETERMINISTIC_LAUNCH_ARGS,
} from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * C-AUTO-08 — the pipeline board in a real browser.
 *
 * The claims here are the ones no substring assertion can make: a drag is a sequence of pointer events, a
 * card returning to its origin column is a question about which element contains it, a live region is a DOM
 * change, and axe needs a rendered DOM. The ROWS — the reorders, the transition the database refuses to
 * omit, and the enrolment a stage entry starts — are `packages/fixtures/src/crm-pipeline.itest.ts`'s, and
 * that file's header says why the split is two files.
 *
 * The band `pipeline` in `@berelax/harness/ports` is this file's (brief rules 18 and 19).
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind (brief
 * rule 12). Two consequences shape this file:
 *
 *   - **Every assertion is narrowed to this file's own cards**, by contact id. The board is global by
 *     design — it shows every column and every card — so what is asserted about it is this file's cards and
 *     never a count of all of them.
 *   - **The two fixture columns are archived in `afterAll`, not deleted.** A `pipeline_stage_transition`
 *     row names the column it moved a card into, that log is append-only (ZU002), and the reference is ON
 *     DELETE RESTRICT — so a column a card has ever entered cannot be removed. Archiving is what the schema
 *     offers, `readPipelineBoard` filters archived columns out, and a second run un-archives these two by
 *     key.
 *
 * ## Why the 409 case is driven by the KEYBOARD
 *
 * The acceptance line is *"the optimistic card returns to its origin column and a named error is shown
 * rather than a silent revert"*, and the word that makes it an assertion is **optimistic**: the card has to
 * have gone somewhere for coming back to mean anything. On a drag the optimistic move and the request are
 * one gesture, so the intermediate state is a race to observe. On the keyboard path `ArrowRight` moves the
 * card and commits nothing — so the case can assert the card is in the doomed column, press Enter, and
 * assert it is back. Both halves observed, neither of them timed.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'cauto08 pipeline board itest'
/** Four contacts on the unallocated +971 59 prefix, in a band no other suite uses. */
const CONTACT_BAND_FIRST = 60_601
const CONTACTS = 3
/** The two fixture columns: the one the cards start in, and the one archived under the reader's feet. */
const FROM_STAGE = 'cauto08web_from'
const DOOMED_STAGE = 'cauto08web_doomed'
/**
 * A seeded column, used by the no-JavaScript case, which needs no pixels.
 *
 * The DRAG cases move a card between the two fixture columns instead, and the reason is geometry rather
 * than taste: eight columns at their minimum width are wider than a 1440px viewport, so the board scrolls
 * and a seeded column near the start cannot be on screen at the same time as a fixture column at the end.
 * A pointer gesture between two elements that cannot both be visible is not a drag a person could make
 * either, so the case that asserts one uses the pair that can.
 */
const TO_STAGE = 'contacted'

const PATH = '/crm/pipeline'
const SCREENS = new URL('../../../artifacts/screens/C-AUTO-08', import.meta.url).pathname

/**
 * The instants the three cards entered their column. Distinct, fixed, and in the PAST.
 *
 * Distinct, so the board's card order — by entry instant — cannot come down to a uuid tiebreak, which would
 * make the screenshots differ between runs. Fixed, so the page prints the same text every time; a relative
 * time or the real clock could not be photographed twice.
 *
 * And in the past, which is not cosmetic. The route writes a move at the REAL clock, so a fixture instant in
 * 2099 makes the setup row the newest transition for that contact for ever: `order by occurred_at desc`
 * then answers the entry rather than the drag, and the assertion about the move reads `from_stage_key` of
 * the row that created the card — null. That is exactly how this file first failed.
 */
const ENTERED = [
  new Date('2020-05-01T08:00:00.000Z'),
  new Date('2020-05-01T09:00:00.000Z'),
  new Date('2020-05-01T10:00:00.000Z'),
] as const

const ACTOR = { kind: 'staff', label: MARKER } as const

let sql: Sql
let server: WebServer
let browser: Browser
let BASE = ''
let contactIds: string[] = []

const contact = (index: number): string => {
  const id = contactIds[index]
  if (id === undefined) throw new Error(`no fixture contact ${index}`)
  return id
}

const phoneOf = (index: number): string =>
  `+97159${String(CONTACT_BAND_FIRST + index).padStart(7, '0')}`

beforeAll(async () => {
  sql = createConnection({ url, max: 6 })

  await sql`
    insert into customer (phone_e164, created_via)
    select '+97159' || lpad((${CONTACT_BAND_FIRST} + g - 1)::text, 7, '0'), 'front_desk'
      from generate_series(1, ${CONTACTS}) as g
    on conflict (phone_e164) do nothing
  `
  const contacts = await sql<{ id: string }[]>`
    select id from customer
     where phone_e164 between ${phoneOf(0)} and ${phoneOf(CONTACTS - 1)}
     order by phone_e164
  `
  contactIds = contacts.map((row) => row.id)

  // Appended after whatever exists, so the positions stay 1..n and the two are ADJACENT in the board's
  // order — which is what lets one arrow key reach the doomed column from the one the cards start in.
  const [last] = await sql<{ n: number }[]>`
    select coalesce(max(display_order), 0)::int as n from pipeline_stage
  `
  let next = (last?.n ?? 0) + 1
  for (const key of [FROM_STAGE, DOOMED_STAGE]) {
    const [row] = await sql<{ inserted: boolean }[]>`
      insert into pipeline_stage (stage_key, display_order, description)
      values (${key}, ${next}, ${`C-AUTO-08 browser fixture column (${key}).`})
      on conflict (stage_key) do update set archived_at = null
      returning (xmax = 0) as inserted
    `
    if (row?.inserted === true) next += 1
  }

  // The cards, each through `moveCard` so every one of them was really moved: a row written by hand would
  // be a card the deferred trigger never examined, which is the one thing this board must not contain.
  for (const [index, at] of ENTERED.entries()) {
    await withUnitOfWork(sql, ACTOR, (uow) =>
      moveCard(uow, { customerId: contact(index), toStageKey: FROM_STAGE, actor: ACTOR, at }),
    )
  }

  server = await startWebServer({
    suite: 'pipeline',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: PATH,
    readyWithinMs: 90_000,
    env: {
      // This route calls `loadConfig()`, so the two values it needs are declared rather than assumed: CI
      // exports both, and a local run that exported only TEST_DATABASE_URL would get a 503 that reads like
      // a broken route.
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
  if (sql === undefined) return
  if (contactIds.length > 0) {
    await sql`delete from customer_pipeline_card where customer_id in ${sql(contactIds)}`
    await sql`delete from customer where id in ${sql(contactIds)}`
  }
  // Archived rather than deleted: a transition names the column it moved a card into and that log cannot
  // be rewritten, so the stage reference is ON DELETE RESTRICT.
  await sql`
    update pipeline_stage set archived_at = now()
     where stage_key in ${sql([FROM_STAGE, DOOMED_STAGE])} and archived_at is null
  `
  await sql.end({ timeout: 5 })
})

// --- the browser ----------------------------------------------------------------------------------

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

async function withCell<T>(cell: Cell, body: (page: Page) => Promise<T>): Promise<T> {
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
    // Every uncaught error the page's own script raises, collected and asserted on the way out.
    // Without it a broken listener is a TIMEOUT waiting for a data attribute, which names the assertion
    // rather than the cause and costs a run to diagnose - it cost one writing this file.
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(`${BASE}${PATH}${cell.direction === 'rtl' ? '?dir=rtl' : ''}`, {
      waitUntil: 'networkidle',
    })
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

/** One desk-width page for the interaction cases, which are not about the viewport. */
async function withDesk<T>(body: (page: Page) => Promise<T>): Promise<T> {
  return await withCell({ width: 1440, height: 900, theme: 'light', direction: 'ltr' }, body)
}

/** Which column currently CONTAINS a card, as the browser sees the DOM. */
async function columnOf(page: Page, customerId: string): Promise<string | null> {
  return await page.evaluate((id) => {
    const card = document.querySelector(`[data-customer="${id}"]`)
    const column = card === null ? null : card.closest('[data-track]')
    return column === null ? null : (column.getAttribute('data-stage') ?? null)
  }, customerId)
}

/** Which column a card is in according to the DATABASE, which is the only durable answer. */
async function storedStageOf(customerId: string): Promise<string | null> {
  const [row] = await sql<{ stage_key: string }[]>`
    select stage_key from customer_pipeline_card where customer_id = ${customerId}
  `
  return row?.stage_key ?? null
}

/** Drags a card onto another column by real pointer events. */
async function dragTo(page: Page, customerId: string, stageKey: string): Promise<void> {
  // The board scrolls, not the page, and the fixture columns are at its end. Scrolled to the end FIRST and
  // then measured: a `boundingBox` read before scrolling is a coordinate outside the viewport, and
  // `mouse.move` to it silently does nothing — which presents as a drag handler that was never wired up,
  // and cost a run of this file to find.
  await page.evaluate(() => {
    const board = document.querySelector('[data-testid="pipeline-board"]')
    if (board !== null) board.scrollLeft = board.scrollWidth
  })
  const card = page.locator(`[data-customer="${customerId}"]`)
  const box = await card.boundingBox()
  const target = await page.locator(`[data-testid="column-${stageKey}"]`).boundingBox()
  if (box === null || target === null) throw new Error(`nothing to drag onto ${stageKey}`)
  const viewport = page.viewportSize()
  if (viewport !== null && (box.x < 0 || target.x + target.width > viewport.width)) {
    throw new Error(
      `the card and the ${stageKey} column are not both on screen (card at ${box.x}, column ends at ` +
        `${target.x + target.width} of ${viewport.width}); a drag between them is not a gesture anybody ` +
        'could make, so this would be testing the harness rather than the page',
    )
  }
  await page.mouse.move(box.x + 8, box.y + box.height / 2)
  await page.mouse.down()
  // Several steps, because one jump is not a drag: the pointermove handler has to be exercised.
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 })
  await page.mouse.up()
}

describe('acceptance — the built application serves the board', () => {
  it('answers HTML with the robots header the registry declares', async () => {
    const response = await fetch(`${BASE}${PATH}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    // Derived from the registry by the proxy: `/crm` is a prefix in ADMIN_GROUP_PREFIXES, so the CRM
    // screens that land beside this one arrive noindex before they are written.
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(response.headers.get('cache-control')).toContain('no-store')
    const html = await response.text()
    expect(html).toContain('data-testid="pipeline-board"')
    expect(html).toContain(`data-testid="column-${FROM_STAGE}"`)
    expect(html).toContain(`data-customer="${contact(0)}"`)
  }, 60_000)
})

describe('acceptance — axe reports nothing serious or critical, in twelve renders', () => {
  it('audits 390/768/1440 x light/dark x ltr/rtl, and each render is the cell it claims to be', async () => {
    // Twelve, stated rather than counted after the fact: a matrix that lost an axis would report a pass
    // over six renders.
    expect(CELLS).toHaveLength(12)
    const luminance: Record<string, number> = {}
    for (const cell of CELLS) {
      const where = `${cell.theme} ${cell.direction} ${cell.width}px`
      const { violations, width, dir, lum } = await withCell(cell, async (page) => {
        const result = await auditPage(page, {
          page: PATH,
          viewport: {
            name: `${cell.width}`,
            width: cell.width,
            height: cell.height,
            scale: 1,
            why: 'C-AUTO-08 acceptance',
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
        }
      })
      expect(width, `${where}: viewport`).toBe(cell.width)
      // The direction axis is real: the document really is mirrored. Without this, twelve identical LTR
      // renders would satisfy every assertion here and the filenames would be the only difference.
      expect(dir, `${where}: dir`).toBe(cell.direction)
      luminance[where] = lum
      const blocking = blockingViolations(violations)
      expect(
        blocking.map(describeViolation),
        `${where}: ${blocking.length} serious/critical violation(s)`,
      ).toEqual([])
    }
    // And the theme axis is real too: the dark cell resolved a darker ground at every width and direction.
    for (const width of [390, 768, 1440]) {
      for (const direction of ['ltr', 'rtl']) {
        expect(
          luminance[`dark ${direction} ${width}px`],
          `dark ${direction} ${width}px is darker than light`,
        ).toBeLessThan(luminance[`light ${direction} ${width}px`] ?? 0)
      }
    }
  }, 600_000)

  it('reports the two defects a known-bad version of this page has, by rule id', async () => {
    // The control on the audit itself. A sweep that reported zero because axe never ran would pass the case
    // above for ever (ADR 0003), so the same page is audited again with an unlabelled button and body text
    // on the decorative gold — the two failures docs/08 fences off — injected into the DOM.
    const violations = await withDesk(async (page) => {
      await page.evaluate(() => {
        const button = document.createElement('button')
        button.type = 'button'
        document.body.append(button)
        const text = document.createElement('p')
        text.textContent = 'Move this card'
        const root = globalThis.getComputedStyle(document.documentElement)
        text.style.color = root.getPropertyValue('--color-decor-gold')
        text.style.backgroundColor = root.getPropertyValue('--color-surface-sand')
        document.body.append(text)
      })
      const result = await auditPage(page, {
        page: `${PATH} (known-bad)`,
        viewport: { name: '1440', width: 1440, height: 900, scale: 1, why: 'the control' },
        theme: 'light',
        direction: 'ltr',
      })
      return result.violations
    })
    const ids = violations.map((violation) => violation.id)
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('button-name')
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('color-contrast')
  }, 300_000)
})

describe('acceptance — the same board photographed twice is byte-identical', () => {
  it('captures 3 viewports x 2 themes x 2 directions twice, with zero pixel diff between the runs', async () => {
    mkdirSync(SCREENS, { recursive: true })
    const shots = new Map<string, Uint8Array>()
    for (const cell of CELLS) {
      const label = `pipeline__${cell.theme}-${cell.width}__${cell.direction}`
      /*
        The claim is about the PAGE: it renders from a database and prints an instant on every card, and a
        document printing a relative time or a generated id could not render identically twice. Through
        `captureUntilStable` rather than comparing capture one to capture two, because that also asserts
        paint had settled by the first capture.
      */
      const stable = await captureUntilStable(
        () =>
          withCell(cell, (page) =>
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
    // The control on the comparison: two DIFFERENT cells are not identical. Without it, a screenshot
    // function that returned the same bytes every time would pass every assertion above.
    const differs = (a: string, b: string): number =>
      Buffer.compare(
        Buffer.from(shots.get(a) ?? new Uint8Array()),
        Buffer.from(shots.get(b) ?? new Uint8Array()),
      )
    expect(differs('pipeline__light-390__ltr', 'pipeline__dark-390__ltr')).not.toBe(0)
    expect(differs('pipeline__light-390__ltr', 'pipeline__light-1440__ltr')).not.toBe(0)
    expect(differs('pipeline__light-390__ltr', 'pipeline__light-390__rtl')).not.toBe(0)
  }, 600_000)
})

describe('acceptance — dragging a card to another column persists across reload', () => {
  it('drops it, announces the move, and the reloaded page draws it in the new column', async () => {
    const moving = contact(0)
    expect(await storedStageOf(moving)).toBe(FROM_STAGE)
    await withDesk(async (page) => {
      expect(await columnOf(page, moving)).toBe(FROM_STAGE)
      await dragTo(page, moving, DOOMED_STAGE)
      await page.waitForFunction(() => document.documentElement.dataset['pipelineMoves'] === '1')
      expect(await page.evaluate(() => document.documentElement.dataset['pipelineStatus'])).toBe(
        '200',
      )
      const live = await page.locator('[data-testid="pipeline-live"]').textContent()
      expect(live).toContain(`Moved to ${DOOMED_STAGE}.`)
      // In this document, without a reload: the optimistic move became the real one.
      expect(await columnOf(page, moving)).toBe(DOOMED_STAGE)
      // And the column tallies were kept in step, which is what makes the count on the page a count.
      const tallies = await page.evaluate(() => ({
        from: document.querySelector('[data-testid="column-cauto08web_from"] [data-tally]')
          ?.textContent,
        to: document.querySelector('[data-testid="column-cauto08web_doomed"] [data-tally]')
          ?.textContent,
      }))
      expect(tallies.from).toBe('2')
      expect(tallies.to).toBe('1')
    })

    // The durable answer. `stage_entered_at` moved with it, and the log carries the move with its actor —
    // which is the acceptance line about a transition, asserted here through the page rather than the API.
    expect(await storedStageOf(moving)).toBe(DOOMED_STAGE)
    const [transition] = await sql<{ from_stage_key: string; actor_label: string }[]>`
      select from_stage_key, actor_label from pipeline_stage_transition
       where customer_id = ${moving} order by occurred_at desc limit 1
    `
    expect(transition?.from_stage_key).toBe(FROM_STAGE)
    expect(transition?.actor_label).toBe('Pipeline board')

    // Across a RELOAD, which is what the acceptance line asks for: a fresh document from the server.
    const reloaded = await withDesk((page) => columnOf(page, moving))
    expect(reloaded).toBe(DOOMED_STAGE)
  }, 120_000)
})

describe('acceptance — the same move is achievable keyboard-only', () => {
  it('picks a card up with Enter, moves it with an arrow key, and commits with Enter', async () => {
    const moving = contact(1)
    expect(await storedStageOf(moving)).toBe(FROM_STAGE)
    await withDesk(async (page) => {
      const card = page.locator(`[data-customer="${moving}"]`)
      // Focus by the keyboard and nothing else: no click and no pointer event anywhere in this case.
      await card.focus()
      expect(await card.getAttribute('aria-pressed')).toBe('false')
      await page.keyboard.press('Enter')
      expect(await card.getAttribute('aria-pressed')).toBe('true')
      expect(await page.locator('[data-testid="pipeline-live"]').textContent()).toContain(
        'Picked up',
      )

      // Escape first, which is the control on the whole gesture: a move that cannot be abandoned is a move
      // a reader cannot try.
      await page.keyboard.press('ArrowRight')
      expect(await columnOf(page, moving)).toBe(DOOMED_STAGE)
      await page.keyboard.press('Escape')
      expect(await page.locator('[data-testid="pipeline-live"]').textContent()).toContain(
        'Move cancelled',
      )
      expect(await columnOf(page, moving)).toBe(FROM_STAGE)
      expect(await card.getAttribute('aria-pressed')).toBe('false')

      // And now the move itself, one column along the board's own order.
      await page.keyboard.press('Enter')
      await page.keyboard.press('ArrowRight')
      const proposed = await page.locator('[data-testid="pipeline-live"]').textContent()
      expect(proposed).toContain(`Proposed ${DOOMED_STAGE}`)
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.documentElement.dataset['pipelineMoves'] === '1')
      expect(await page.locator('[data-testid="pipeline-live"]').textContent()).toContain(
        `Moved to ${DOOMED_STAGE}.`,
      )
      expect(await columnOf(page, moving)).toBe(DOOMED_STAGE)
    })
    expect(await storedStageOf(moving)).toBe(DOOMED_STAGE)
  }, 120_000)
})

describe('acceptance — a forced 409 returns the optimistic card to its origin column', () => {
  it('shows the refusal by name rather than reverting silently', async () => {
    const moving = contact(2)
    expect(await storedStageOf(moving)).toBe(FROM_STAGE)
    await withDesk(async (page) => {
      // The board in this document still draws the doomed column. Archiving it NOW is the concurrency the
      // acceptance line names: somebody else took the column off the board while this reader was looking
      // at it, and the page cannot know.
      await sql`
        update pipeline_stage set archived_at = now() where stage_key = ${DOOMED_STAGE}
      `
      expect(await page.locator(`[data-testid="column-${DOOMED_STAGE}"]`).count()).toBe(1)

      const card = page.locator(`[data-customer="${moving}"]`)
      await card.focus()
      await page.keyboard.press('Enter')
      await page.keyboard.press('ArrowRight')
      // The OPTIMISTIC position, observed. This is what makes "returns to its origin column" an assertion
      // rather than a restatement of "nothing happened".
      expect(await columnOf(page, moving)).toBe(DOOMED_STAGE)

      await page.keyboard.press('Enter')
      await page.waitForFunction(
        () => document.documentElement.dataset['pipelineRefusal'] !== undefined,
      )
      expect(await page.evaluate(() => document.documentElement.dataset['pipelineRefusal'])).toBe(
        'stage_archived',
      )
      // A 409 and not a 500 or a 200: the board the move was made on is out of date, which is a conflict.
      expect(await page.evaluate(() => document.documentElement.dataset['pipelineStatus'])).toBe(
        '409',
      )
      const live = await page.locator('[data-testid="pipeline-live"]').textContent()
      expect(live).toContain('Not moved')
      expect(live).toContain('archived')
      // Back in its origin column, and it is the SAME element — nothing re-rendered.
      expect(await columnOf(page, moving)).toBe(FROM_STAGE)
      expect(
        await page.evaluate(
          (id) => document.querySelector(`[data-customer="${id}"]`)?.getAttribute('style') ?? '',
          moving,
        ),
      ).not.toContain('translate')
    })
    // And the database never moved it.
    expect(await storedStageOf(moving)).toBe(FROM_STAGE)
    expect(
      (
        await sql<{ n: string }[]>`
          select count(*)::text as n from pipeline_stage_transition
           where customer_id = ${moving} and to_stage_key = ${DOOMED_STAGE}
        `
      )[0]?.n,
    ).toBe('0')
  }, 120_000)

  it('the control: the archived column is gone from a FRESH board, so the 409 was a race and not a bug', async () => {
    // Without this, the refusal above is indistinguishable from a route that refuses every move into that
    // column for some other reason. A reload shows the column is genuinely off the board now.
    const stages = await readPipelineStages(sql)
    expect(stages.find((stage) => stage.stageKey === DOOMED_STAGE)?.archivedAtIso).not.toBeNull()
    await withDesk(async (page) => {
      expect(await page.locator(`[data-testid="column-${DOOMED_STAGE}"]`).count()).toBe(0)
      expect(await page.locator(`[data-testid="column-${FROM_STAGE}"]`).count()).toBe(1)
    })
  }, 120_000)
})

describe('acceptance — the board works with no JavaScript at all', () => {
  it('moves a card by form POST, answers a 303, and says so on the way back', async () => {
    const moving = contact(2)
    const response = await fetch(`${BASE}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ customerId: moving, toStageKey: TO_STAGE }).toString(),
      redirect: 'manual',
    })
    // 303 so the next request is a GET whatever this one was, and a relative location because a handler
    // behind a proxy does not know its own origin.
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`/crm/pipeline?moved=${TO_STAGE}`)
    expect(await storedStageOf(moving)).toBe(TO_STAGE)

    const back = await fetch(`${BASE}${response.headers.get('location') ?? ''}`)
    expect(back.status).toBe(200)
    expect(await back.text()).toContain(`Moved to ${TO_STAGE}.`)

    // And the refusal path answers the same way: a 303 carrying the refusal NAME, never a sentence — a
    // sentence in a query string is a sentence anybody can put there and the page would print it.
    const refused = await fetch(`${BASE}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ customerId: moving, toStageKey: TO_STAGE }).toString(),
      redirect: 'manual',
    })
    expect(refused.status).toBe(303)
    expect(refused.headers.get('location')).toBe('/crm/pipeline?refusal=card_already_in_stage')
    const shown = await fetch(`${BASE}/crm/pipeline?refusal=card_already_in_stage`)
    expect(await shown.text()).toContain('already in that column')
  }, 120_000)
})
