import { type ChildProcess, spawn } from 'node:child_process'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import { testPort } from '@berelax/harness/ports'
import { RADIUS } from '@berelax/ui'
import {
  ICON_SIZE,
  ICON_STROKE_WIDTH,
  MIN_FORM_FONT_SIZE_PX,
  RADIUS_ROLE,
  type RadiusRole,
} from '@berelax/ui/primitives/contract'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * W-SYS-03 — the primitive set, proved against the two routes that render it.
 *
 * Not one claim in this unit can be checked by reading source:
 *
 * - **axe** is a rule engine run against a rendered accessibility tree. A file cannot be audited; the
 *   whole point of the gate is that it examined a DOM, which is why the known-bad fixture in
 *   `scripts/test-gates.mjs` is asserted to have been rejected by rule *id* rather than by a count.
 * - **a border radius** is what the engine resolved `var(--radius-2)` to, through three stylesheet
 *   imports and a theme attribute.
 * - **a portal's direction** is decided by React context crossing into `document.body`, where no
 *   ancestor's `dir` reaches it. It was wrong when this was written — two copies of
 *   `@radix-ui/react-direction` in the tree, so the provider and the consumer had different contexts —
 *   and nothing but an assertion on the rendered attribute would have noticed.
 * - **an icon's stroke width** is an SVG presentation attribute Lucide writes from a prop.
 *
 * ## Every assertion has a control that must fail
 *
 * The sweep is run again with a deliberately unlabelled button and body text on the decorative gold, and
 * asserted to report `button-name` and `color-contrast`. The font-size collector is run again with a 14px
 * input. The radius walk is run again with a pill-cornered element. The icon collector is run again with
 * a 16px glyph at stroke 2. A test that cannot fail is not a test.
 *
 * ## Why there are two routes
 *
 * `dir` belongs to the document, so the RTL half of the twelve-render sweep is a real Arabic route —
 * `/ar/kitchen-sink`, under the `(ar)` root layout — and not the English one with an attribute flipped.
 * See `apps/web/app/(ar)/ar/kitchen-sink/page.tsx` for the whole reason.
 */

/**
 * A port from the same range as `shell.itest.ts`, chosen at random for the same reason: a hard-coded
 * port collides when two agents run `pnpm verify` at once, and one of them then drives a server that is
 * not its own.
 */
const PORT = testPort('primitives')
const BASE = `http://127.0.0.1:${PORT}`
const EN = '/kitchen-sink'
const AR = '/ar/kitchen-sink'

let server: ChildProcess
let browser: Browser

async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}${EN}`)
      if (response.ok) return
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`The app did not start on ${BASE}${EN} within ${timeoutMs}ms`)
}

beforeAll(async () => {
  server = spawn('pnpm', ['exec', 'next', 'start', '--port', String(PORT)], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'ignore',
    env: { ...process.env, NODE_ENV: 'production' },
  })
  await waitForServer()
  // Pinned to the pre-installed Chromium at /opt/pw-browsers, with the same flags as every other
  // browser in this repository.
  browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.kill('SIGTERM')
})

interface Cell {
  readonly path: string
  readonly width: number
  readonly height: number
  readonly theme: 'light' | 'dark'
  readonly direction: 'ltr' | 'rtl'
}

/** Three viewports x two themes x two directions. The matrix `packages/harness/src/matrix.ts` states. */
const CELLS: readonly Cell[] = (['light', 'dark'] as const).flatMap((theme) =>
  (
    [
      { path: EN, direction: 'ltr' as const },
      { path: AR, direction: 'rtl' as const },
    ] as const
  ).flatMap((locale) =>
    [
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1440, height: 900 },
    ].map((viewport) => ({ ...locale, ...viewport, theme })),
  ),
)

/**
 * Opens a cell and hands the page to a callback.
 *
 * The theme is set by writing the `berelax:theme` key the blocking bootstrap script in
 * `app/_document/shell.tsx` reads — on the **context**, before any page exists. A page-level init script
 * would not do: `page.setContent` does not navigate, and a script registered on a page already at
 * `about:blank` never runs. `shell.itest.ts` does the same thing for the same reason.
 *
 * `colorScheme` is set to match, so the theme is what the page resolves whether it reads the attribute
 * or the media query — the point of the cell is the rendered theme, not which mechanism delivered it.
 *
 * The `__name` shim is the esbuild `keepNames` workaround: Playwright serialises a callback's *compiled*
 * source into the page, where that helper does not exist.
 */
async function withCell<T>(cell: Cell, body: (page: Page) => Promise<T>): Promise<T> {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: cell.width, height: cell.height },
    colorScheme: cell.theme,
    locale: cell.direction === 'rtl' ? 'ar-AE' : 'en-AE',
    timezoneId: 'Asia/Dubai',
  })
  try {
    await context.addInitScript({
      content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
    })
    await context.addInitScript(
      ({ value }: { value: string }) => {
        globalThis.localStorage.setItem('berelax:theme', value)
      },
      { value: cell.theme },
    )
    const page = await context.newPage()
    await page.goto(`${BASE}${cell.path}`, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    return await body(page)
  } finally {
    await context.close()
  }
}

/** What the page says it is, read back so a cell cannot pass by being a different cell. */
async function documentState(
  page: Page,
): Promise<{ theme: string | null; dir: string | null; lang: string | null; width: number }> {
  return await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    dir: document.documentElement.getAttribute('dir'),
    lang: document.documentElement.getAttribute('lang'),
    width: window.innerWidth,
  }))
}

describe('acceptance — axe reports nothing serious or critical, in twelve renders', () => {
  it('audits 390/768/1440 x light/dark x ltr/rtl, and each render is the one it claims to be', async () => {
    // Twelve, stated rather than counted after the fact: a matrix that lost an axis would otherwise
    // report a pass over eight renders.
    expect(CELLS).toHaveLength(12)
    expect(new Set(CELLS.map((cell) => `${cell.path}|${cell.theme}|${cell.width}`)).size).toBe(12)

    const audited: string[] = []
    for (const cell of CELLS) {
      const label = `${cell.path} ${cell.theme} ${cell.direction} ${cell.width}px`
      const { state, violations, incomplete } = await withCell(cell, async (page) => {
        const state = await documentState(page)
        const result = await auditPage(page, {
          page: cell.path,
          viewport: {
            name: `${cell.width}`,
            width: cell.width,
            height: cell.height,
            scale: 1,
            why: 'W-SYS-03 acceptance',
          },
          theme: cell.theme,
          direction: cell.direction,
        })
        return { state, violations: result.violations, incomplete: result.incomplete }
      })

      // The render really is this cell: the theme came from the bootstrap script reading
      // `berelax:theme`, the direction came from the root layout of the locale, and the width is the
      // viewport asked for. Without these three a sweep of twelve identical light LTR renders would
      // pass.
      expect(state.theme, `${label}: data-theme`).toBe(cell.theme)
      expect(state.dir, `${label}: dir`).toBe(cell.direction)
      expect(state.lang, `${label}: lang`).toBe(cell.direction === 'rtl' ? 'ar' : 'en')
      expect(state.width, `${label}: viewport`).toBe(cell.width)

      const blocking = blockingViolations(violations)
      expect(
        blocking.map(describeViolation),
        `${label}: ${blocking.length} serious/critical violation(s)`,
      ).toEqual([])
      // Everything axe could not decide is reported and never failed on — see BLOCKING_IMPACTS.
      void incomplete
      audited.push(label)
    }

    expect(audited).toHaveLength(12)
  }, 600_000)

  it('reports button-name and color-contrast when the two defects are put on the page', async () => {
    /*
     * The control, and the same gate that just reported twelve renders clean.
     *
     * Two defects, both in docs/08's own list of what this system does not do: a button with no
     * accessible name, and body text on `--color-decor-gold`, which measures 2.90:1 against the light
     * ground and is why `decor-gold-never-carries-text` exists in `pnpm colours`.
     *
     * The colour is read out of the token at runtime rather than typed here as `#C08A43`. Two reasons:
     * the assertion is then about the token the palette actually resolves rather than a hex somebody
     * copied, and this file needs no exemption from `pnpm colours` — which would have been an exemption
     * on a file that has nothing to do with the token layer.
     *
     * Light theme only: in dark mode `--color-decor-gold` sits on `#141210` and passes comfortably. A
     * contrast control has to run in the theme whose contrast it is about.
     */
    const cell = CELLS.find(
      (candidate) =>
        candidate.path === EN &&
        candidate.theme === 'light' &&
        candidate.width === 390 &&
        candidate.direction === 'ltr',
    )
    expect(cell, 'the light/ltr/390 cell is missing from the matrix').toBeDefined()

    const violations = await withCell(cell as Cell, async (page) => {
      await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement)
        const gold = root.getPropertyValue('--color-decor-gold').trim()
        const ground = root.getPropertyValue('--color-ground').trim()
        const main = document.querySelector('main')
        if (main === null) throw new Error('no main element')

        const unnamed = document.createElement('button')
        unnamed.type = 'button'
        unnamed.style.cssText = 'width:48px;height:48px'
        // An icon and nothing else: no text, no aria-label, no title. This is exactly the shape
        // `IconLabelling` makes a compile error for `Button`, put here by hand.
        unnamed.innerHTML =
          '<svg width="20" height="20" aria-hidden="true" focusable="false"></svg>'

        const lowContrast = document.createElement('p')
        lowContrast.textContent = 'Body copy on the decorative gold, which measures 2.90:1.'
        lowContrast.style.color = gold
        lowContrast.style.background = ground
        lowContrast.style.fontSize = '17px'

        const holder = document.createElement('div')
        holder.dataset['control'] = 'known-bad'
        holder.append(unnamed, lowContrast)
        main.append(holder)
      })

      const result = await auditPage(page, {
        page: `${EN} (known-bad)`,
        viewport: { name: '390', width: 390, height: 844, scale: 1, why: 'the control' },
        theme: 'light',
        direction: 'ltr',
      })
      return result.violations
    })

    const ids = violations.map((violation) => violation.id)
    // By rule id, not by count: a non-zero number could come from anything, and the claim is that axe
    // examined a rendered DOM and recognised these two defects in it.
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('button-name')
    expect(ids).toContain('color-contrast')
    // And both are blocking, which is what makes the sweep above a gate rather than a report.
    expect(blockingViolations(violations).map((violation) => violation.id)).toContain('button-name')
  }, 120_000)
})

interface FormControl {
  readonly where: string
  readonly fontSizePx: number
}

/**
 * Every control a phone keyboard can focus, with the size it computes to.
 *
 * `.be-select` is in the selector because a Radix select trigger is a `<button role="combobox">` rather
 * than a `<select>`, and it is the one form primitive a tag-name selector misses.
 */
async function formControls(page: Page): Promise<FormControl[]> {
  return await page.evaluate(() =>
    [...document.querySelectorAll('input, select, textarea, .be-select')].map((element) => ({
      where: `${element.tagName.toLowerCase()}.${String(element.className).split(/\s+/)[0]}`,
      fontSizePx: Number.parseFloat(getComputedStyle(element).fontSize),
    })),
  )
}

describe('acceptance — no form control computes below 16px at 390px', () => {
  it('holds for every input, select and textarea on both routes', async () => {
    // iOS Safari zooms a focused control under 16px and does not zoom back out. The body step is 17px,
    // and `text-sm` — which is what shadcn ships inputs at — is 14px.
    expect(MIN_FORM_FONT_SIZE_PX).toBe(16)
    for (const path of [EN, AR]) {
      const cell: Cell = {
        path,
        width: 390,
        height: 844,
        theme: 'light',
        direction: path === AR ? 'rtl' : 'ltr',
      }
      const controls = await withCell(cell, formControls)
      // A selector that stopped matching would otherwise pass this over an empty list.
      expect(controls.length, `${path}: no form controls found`).toBeGreaterThanOrEqual(3)
      for (const control of controls) {
        expect(control.fontSizePx, `${path}: ${control.where}`).toBeGreaterThanOrEqual(
          MIN_FORM_FONT_SIZE_PX,
        )
      }
    }
  }, 180_000)

  it('reports a 14px input when one is put on the page', async () => {
    // The control, and the same collector. `text-sm` on an input is a one-word change in a class list.
    const controls = await withCell(
      { path: EN, width: 390, height: 844, theme: 'light', direction: 'ltr' },
      async (page) => {
        await page.evaluate(() => {
          const input = document.createElement('input')
          input.type = 'text'
          input.className = 'be-input'
          input.style.fontSize = '0.875rem'
          document.querySelector('main')?.append(input)
        })
        return await formControls(page)
      },
    )
    expect(controls.some((control) => control.fontSizePx < MIN_FORM_FONT_SIZE_PX)).toBe(true)
  }, 120_000)
})

/**
 * Clicks a trigger and waits for the overlay it opens.
 *
 * Retried, because a click that lands before React has hydrated does nothing at all and there is no
 * marker in the DOM that says hydration has happened — `networkidle` is about the network, not about
 * React. So the test asserts the effect it wants rather than a proxy for it: click, look for the
 * content, click again if it is not there. Found the hard way; the first version of this test hung for
 * thirty seconds on a select that had never received its event handlers.
 */
async function openOverlay(page: Page, trigger: string, content: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.click(trigger)
    try {
      await page.waitForSelector(content, { timeout: 1_000, state: 'attached' })
      return
    } catch {
      await page.waitForTimeout(250)
    }
  }
  throw new Error(`${trigger} never opened ${content}`)
}

interface PortalState {
  readonly dir: string | null
  readonly inBody: boolean
  readonly outsideMain: boolean
}

async function portalState(page: Page, content: string): Promise<PortalState> {
  return await page.evaluate((selector) => {
    const element = document.querySelector(selector)
    if (element === null) throw new Error(`nothing matches ${selector}`)
    return {
      dir: element.getAttribute('dir'),
      inBody: element.closest('body') !== null,
      // The whole reason a provider is needed: the content is not inside the tree that carries the
      // page's own direction.
      outsideMain: element.closest('main') === null,
    }
  }, content)
}

/** The overlays, and the trigger that opens each one, by the copy each route renders. */
const OVERLAYS = [
  { name: 'select', content: '.be-select__content', en: '.be-select', ar: '.be-select' },
  {
    name: 'dialog',
    content: '.be-dialog',
    en: 'text=Cancellation policy',
    ar: 'text=سياسة الإلغاء',
  },
  {
    name: 'sheet',
    content: '.be-sheet',
    en: 'text=Choose a start time',
    ar: 'text=اختر وقت البداية',
  },
  {
    name: 'popover',
    content: '.be-popover',
    en: 'text=What is included?',
    ar: 'text=ما الذي يشمله السعر؟',
  },
] as const

describe('acceptance — portal content carries the direction of the document that opened it', () => {
  for (const overlay of OVERLAYS) {
    it(`gives the ${overlay.name} dir="rtl" on the Arabic route and dir="ltr" on the English one`, async () => {
      // Both halves, because one of them alone proves nothing: an attribute hard-coded to `rtl` would
      // pass the Arabic assertion, and an attribute never set would pass neither. The English run is
      // the control.
      for (const [path, direction] of [
        [AR, 'rtl'],
        [EN, 'ltr'],
      ] as const) {
        const state = await withCell(
          { path, width: 1280, height: 900, theme: 'light', direction },
          async (page) => {
            await openOverlay(page, path === AR ? overlay.ar : overlay.en, overlay.content)
            return await portalState(page, overlay.content)
          },
        )
        expect(state.dir, `${overlay.name} on ${path}`).toBe(direction)
        expect(state.inBody, `${overlay.name} on ${path} is in the document`).toBe(true)
        expect(state.outsideMain, `${overlay.name} on ${path} is portalled`).toBe(true)
      }
    }, 180_000)
  }
})

/** The selector that renders each radius role, and the role whose token it must resolve to. */
const RADIUS_SELECTOR: Record<RadiusRole, string> = {
  card: '.be-panel',
  input: '.be-input',
  chip: '.be-chip',
  button: '.be-btn',
  select: '.be-select',
  dialog: '.be-dialog',
  sheet: '.be-sheet',
  handle: '.be-sheet__handle',
}

interface Corners {
  readonly all: string
  readonly startStart: string
  readonly startEnd: string
}

async function cornersOf(page: Page, selector: string): Promise<Corners> {
  return await page.evaluate((query) => {
    const element = document.querySelector(query)
    if (element === null) throw new Error(`nothing matches ${query}`)
    const style = getComputedStyle(element)
    return {
      all: style.borderRadius,
      // Logical corners: for a sheet on the bottom edge these are the two that are on screen, in either
      // direction, without a second rule for Arabic.
      startStart: style.borderStartStartRadius,
      startEnd: style.borderStartEndRadius,
    }
  }, selector)
}

/** Everything on the page whose computed radius is the handle's. */
async function pillCornered(page: Page, handleRadius: string): Promise<string[]> {
  return await page.evaluate(
    (radius) =>
      [...document.querySelectorAll('*')]
        .filter((element) => getComputedStyle(element).borderRadius === radius)
        .map(
          (element) =>
            `${element.tagName.toLowerCase()}.${String(element.className).split(/\s+/)[0]}`,
        ),
    handleRadius,
  )
}

describe('acceptance — every primitive wears the radius docs/08 §4 gives it', () => {
  it('resolves the token on cards, inputs, chips, buttons, selects, the dialog and the sheet', async () => {
    const measured = await withCell(
      { path: EN, width: 1280, height: 900, theme: 'light', direction: 'ltr' },
      async (page) => {
        // The dialog and the sheet exist only while they are open, and the handle only inside the
        // sheet. A radius assertion against an element that is not there is an assertion against
        // nothing, so both are opened before anything is measured.
        await openOverlay(page, 'text=Cancellation policy', '.be-dialog')
        const dialog = await cornersOf(page, '.be-dialog')
        await page.keyboard.press('Escape')
        await openOverlay(page, 'text=Choose a start time', '.be-sheet')

        const tokens = await page.evaluate(() => {
          const root = getComputedStyle(document.documentElement)
          return {
            '1': root.getPropertyValue('--radius-1').trim(),
            '2': root.getPropertyValue('--radius-2').trim(),
            '3': root.getPropertyValue('--radius-3').trim(),
            handle: root.getPropertyValue('--radius-handle').trim(),
          }
        })
        const corners: Record<string, Corners> = { '.be-dialog': dialog }
        for (const selector of Object.values(RADIUS_SELECTOR)) {
          if (selector === '.be-dialog') continue
          corners[selector] = await cornersOf(page, selector)
        }
        return { tokens, corners, pills: await pillCornered(page, tokens.handle) }
      },
    )

    // The tokens are the scale's, resolved by the engine rather than parsed here.
    expect(measured.tokens['1']).toBe(RADIUS['1'])
    expect(measured.tokens['2']).toBe(RADIUS['2'])
    expect(measured.tokens['3']).toBe(RADIUS['3'])
    expect(measured.tokens.handle).toBe(RADIUS.handle)

    for (const [role, selector] of Object.entries(RADIUS_SELECTOR) as [RadiusRole, string][]) {
      const expected = measured.tokens[RADIUS_ROLE[role]]
      const corners = measured.corners[selector]
      expect(corners, `${role}: ${selector} is not on the page`).toBeDefined()
      if (role === 'sheet') {
        // A bottom sheet rounds the two corners that are on screen and squares the two that are off
        // the bottom of it, so `border-radius` is a four-value string rather than one length.
        expect(corners?.startStart, `${role}: ${selector}`).toBe(expected)
        expect(corners?.startEnd, `${role}: ${selector}`).toBe(expected)
      } else {
        expect(corners?.all, `${role}: ${selector}`).toBe(expected)
      }
    }

    // The control for the comparison itself: if every token resolved to the same value, or `expected`
    // were empty, the loop above would pass on a system with one radius.
    expect(measured.tokens['1']).not.toBe(measured.tokens['2'])
    expect(measured.corners['.be-btn']?.all).not.toBe(measured.tokens['1'])
    expect(measured.corners['.be-input']?.all).not.toBe(measured.tokens['2'])

    // `--radius-handle` is on the handle and on nothing else. Measured with the sheet open, so the list
    // is not empty by construction.
    expect(measured.pills).toEqual(['div.be-sheet__handle'])
  }, 180_000)

  it('reports a second pill-cornered element when one is put on the page', async () => {
    // The control. A 999px corner anywhere but the handle is a different design language, and it is the
    // first thing anybody reaches for when they want a chip to look friendlier.
    const pills = await withCell(
      { path: EN, width: 1280, height: 900, theme: 'light', direction: 'ltr' },
      async (page) => {
        const handleRadius = await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--radius-handle').trim(),
        )
        await page.evaluate((radius) => {
          const rogue = document.createElement('div')
          rogue.className = 'control-pill'
          rogue.style.borderRadius = radius
          document.querySelector('main')?.append(rogue)
        }, handleRadius)
        return await pillCornered(page, handleRadius)
      },
    )
    expect(pills).toContain('div.control-pill')
  }, 120_000)
})

interface DrawnIcon {
  readonly name: string | null
  readonly placement: string | null
  readonly strokeWidth: string
  readonly width: number
  readonly height: number
}

async function drawnIcons(page: Page): Promise<DrawnIcon[]> {
  return await page.evaluate(() =>
    [...document.querySelectorAll('[data-icon]')].map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        name: element.getAttribute('data-icon'),
        placement: element.getAttribute('data-icon-placement'),
        strokeWidth: getComputedStyle(element).strokeWidth,
        width: rect.width,
        height: rect.height,
      }
    }),
  )
}

/** Icons that are not the size or weight their placement declares. */
function iconDefects(icons: readonly DrawnIcon[]): string[] {
  const defects: string[] = []
  for (const icon of icons) {
    const expected = ICON_SIZE[icon.placement === 'nav' ? 'nav' : 'ui']
    if (icon.width !== expected || icon.height !== expected) {
      defects.push(
        `${icon.name} (${icon.placement}) is ${icon.width}x${icon.height}, not ${expected}`,
      )
    }
    if (Number.parseFloat(icon.strokeWidth) !== ICON_STROKE_WIDTH) {
      defects.push(`${icon.name} (${icon.placement}) strokes at ${icon.strokeWidth}`)
    }
  }
  return defects
}

describe('acceptance — icons are 1.5px of stroke at 20px in UI and 24px in nav', () => {
  it('draws every glyph on the page at the geometry its placement declares', async () => {
    const icons = await withCell(
      { path: EN, width: 1280, height: 900, theme: 'light', direction: 'ltr' },
      drawnIcons,
    )
    // A selector that stopped matching would pass this over an empty list, and both placements have to
    // be on the page or the 20/24 distinction is untested.
    expect(icons.length).toBeGreaterThanOrEqual(4)
    expect(icons.some((icon) => icon.placement === 'ui')).toBe(true)
    expect(icons.some((icon) => icon.placement === 'nav')).toBe(true)
    expect(iconDefects(icons)).toEqual([])
  }, 120_000)

  it('reports a 16px glyph at stroke 2, which is what Lucide draws unwrapped', async () => {
    // The control, and the reason the wrapper exists: Lucide's defaults are stroke 2 at 24px, and a
    // direct import gets them silently. `no-lucide-outside-the-icon-wrapper` in .dependency-cruiser.cjs
    // is what stops that import; this is what says the geometry assertion would notice if it happened.
    const defects = await withCell(
      { path: EN, width: 1280, height: 900, theme: 'light', direction: 'ltr' },
      async (page) => {
        await page.evaluate(() => {
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          svg.setAttribute('data-icon', 'control-unwrapped')
          svg.setAttribute('data-icon-placement', 'ui')
          svg.setAttribute('width', '16')
          svg.setAttribute('height', '16')
          svg.setAttribute('stroke-width', '2')
          svg.setAttribute('aria-hidden', 'true')
          document.querySelector('main')?.append(svg)
        })
        return iconDefects(await drawnIcons(page))
      },
    )
    expect(defects.filter((defect) => defect.includes('control-unwrapped'))).toHaveLength(2)
  }, 120_000)
})
