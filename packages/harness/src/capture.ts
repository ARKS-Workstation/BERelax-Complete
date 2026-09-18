/**
 * The capture engine.
 *
 * One browser, twelve captures per page, byte-identical across runs. Each of the steps below closes
 * a specific source of variation — see `determinism.ts` for why that matters more than it sounds.
 *
 * The critique pass runs against the same page, in the same state, immediately before the shutter.
 * That is deliberate: a finding and the image that shows it come from one render, so a screenshot in
 * the gallery and the defect listed beside it cannot disagree.
 */
import { type Browser, chromium, type Page } from 'playwright'
import { type AccessibilityResult, type AxeViolation, auditPage } from './accessibility.ts'
import { type CritiqueResult, critiqueInPage, critiqueInputFor, type Finding } from './critique.ts'
import { DETERMINISM_CSS, freezePageEnvironment } from './determinism.ts'
import { type CaptureTarget, captureFilename, targetsFor } from './matrix.ts'

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  // Host-dependent hinting and subpixel antialiasing are the two things that make the same page
  // render differently on two machines. Neither is worth a visual gate that only works locally.
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--disable-skia-runtime-opts',
]

export interface Capture {
  readonly target: CaptureTarget
  readonly filename: string
  readonly png: Uint8Array
  readonly findings: readonly Finding[]
  /** axe violations from the same render the image came from. */
  readonly violations: readonly AxeViolation[]
  readonly incomplete: readonly string[]
}

export interface PageSource {
  readonly name: string
  /** Renders the page for one cell of the matrix. */
  html(options: { direction: 'ltr' | 'rtl'; theme: 'light' | 'dark' }): string
}

export interface CaptureHarness {
  capture(source: PageSource): Promise<Capture[]>
  close(): Promise<void>
}

export interface HarnessOptions {
  /** The instant the page believes it is. The fixture salon's, so screenshots and seed data agree. */
  readonly nowMs: number
}

export async function createCaptureHarness(options: HarnessOptions): Promise<CaptureHarness> {
  const browser: Browser = await chromium.launch({ args: LAUNCH_ARGS })

  async function captureOne(source: PageSource, target: CaptureTarget): Promise<Capture> {
    const context = await browser.newContext({
      viewport: { width: target.viewport.width, height: target.viewport.height },
      deviceScaleFactor: target.viewport.scale,
      colorScheme: target.theme,
      locale: target.direction === 'rtl' ? 'ar-AE' : 'en-AE',
      // Fixed, because a page that renders a timezone or a currency from the context would otherwise
      // depend on the machine that took the screenshot.
      timezoneId: 'Asia/Dubai',
      reducedMotion: 'reduce',
    })
    try {
      // On the CONTEXT, not the page, and before the page exists.
      //
      // `page.setContent` does not navigate — it writes into the current document — so an init script
      // registered on a page that is already at about:blank never runs. The symptom is silent: the
      // freeze appears to be installed, nothing errors, and the clock ticks. A context init script
      // applies to every page created afterwards, which is the first navigation.
      //
      // The first of the two is a shim. esbuild compiles this project with `keepNames`, rewriting
      // every named function as `__name(fn, 'fn')`; Playwright serialises a callback's *compiled*
      // source into the page, where that helper does not exist. The alternative is passing every
      // in-page function as a string, which trades one line for the loss of type checking.
      await context.addInitScript({
        content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
      })
      await context.addInitScript(freezePageEnvironment, options.nowMs)

      const page: Page = await context.newPage()
      await page.setContent(source.html({ direction: target.direction, theme: target.theme }), {
        waitUntil: 'networkidle',
      })
      await page.addStyleTag({ content: DETERMINISM_CSS })
      await page.evaluate(async () => {
        await (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } })
          .document.fonts.ready
      })

      const findings = await page.evaluate(critiqueInPage, critiqueInputFor(target.viewport))
      // Before the screenshot, and in the same page: an audit of a different render is an audit of a
      // different page, because theme, direction and viewport all change what is on screen.
      const audit: AccessibilityResult = await auditPage(page, target)
      const png = await page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' })

      return {
        target,
        filename: captureFilename(target),
        png,
        findings,
        violations: audit.violations,
        incomplete: audit.incomplete,
      }
    } finally {
      await context.close()
    }
  }

  return {
    async capture(source) {
      const captures: Capture[] = []
      // Sequential on purpose. Parallel contexts share a GPU process, and a page that renders while
      // another is compositing can pick up a different rasterisation — which is a one-pixel diff
      // nobody can reproduce.
      for (const target of targetsFor(source.name)) {
        captures.push(await captureOne(source, target))
      }
      return captures
    },
    close() {
      return browser.close()
    },
  }
}

/** The accessibility results for a set of captures, in matrix order. */
export function accessibilityResults(captures: readonly Capture[]): AccessibilityResult[] {
  return captures.map((capture) => ({
    target: capture.target,
    violations: capture.violations,
    incomplete: capture.incomplete,
  }))
}

/** The critique results for a set of captures, in matrix order. */
export function critiqueResults(captures: readonly Capture[]): CritiqueResult[] {
  return captures.map((capture) => ({
    page: capture.target.page,
    viewport: capture.target.viewport,
    theme: capture.target.theme,
    direction: capture.target.direction,
    findings: capture.findings,
  }))
}
