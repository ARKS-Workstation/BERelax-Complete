/**
 * HTML to PDF, through headless Chromium.
 *
 * ## Why a browser and not a PDF library
 *
 * Arabic needs two things a PDF library does not give you. **Shaping**: every Arabic letter has up to
 * four contextual forms, and choosing between them is an OpenType `GSUB` problem that needs a
 * shaping engine. **Reordering**: laying out a line that mixes Arabic and Latin is the Unicode
 * Bidirectional Algorithm, roughly a thousand lines of state machine. A pdfkit-class library gives
 * you neither: it draws the codepoints you hand it, left to right, in isolated forms, and the result
 * is a document that looks like Arabic to someone who does not read Arabic. Getting it right means
 * carrying HarfBuzz and an ICU bidi implementation and calling them yourself.
 *
 * Chromium already carries both, correct and continuously tested by the entire web. It also gives us
 * CSS for layout, so an invoice is a stylesheet rather than a coordinate system, and the same
 * template can be shown on screen and printed. The cost is an operational one, recorded in
 * docs/adr/0011: the worker process needs a Chromium binary, which is ~170MB in the image and rules
 * out the smallest droplet sizes for the worker component.
 *
 * ## Determinism
 *
 * Fonts are embedded from pinned packages (see `fonts.ts`), so rendering does not depend on what
 * fonts the host happens to have. Chromium still writes a creation timestamp into the PDF, so
 * generated PDFs are not byte-reproducible; committed fixtures are reviewed visually and asserted
 * structurally, never diffed byte for byte.
 */
import { type Browser, chromium, type LaunchOptions } from 'playwright'
import type { PageGlobals } from './page-globals.ts'

/** Page geometry. A4 because that is what a UAE tax invoice is printed and filed on. */
export interface PageSetup {
  readonly format: 'A4'
  /** Margins in millimetres, clockwise from the top. */
  readonly margin: { top: number; right: number; bottom: number; left: number }
}

/**
 * A4 with document margins rather than web margins.
 *
 * 18mm at the sides is a printed-document measure: a tax invoice is filed, sometimes punched, and
 * often photocopied, and 14mm leaves the amount column uncomfortably near the trim. The extra at the
 * foot is for the page furniture a printer adds.
 */
export const A4_DOCUMENT: PageSetup = {
  format: 'A4',
  margin: { top: 18, right: 18, bottom: 20, left: 18 },
}

/** A4, for the screen preview of a printed page. */
const A4_WIDTH_MM = 210
const A4_HEIGHT_MM = 297

/**
 * Chromium flags.
 *
 * `--no-sandbox` is required because the worker runs as the container's only user with no user
 * namespace available; the container is the sandbox. `--font-render-hinting=none` and
 * `--disable-lcd-text` remove host-dependent hinting so a rendered fixture compares across machines.
 */
const LAUNCH_OPTIONS: LaunchOptions = {
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--font-render-hinting=none',
    '--disable-lcd-text',
    '--hide-scrollbars',
  ],
}

export interface PdfRenderer {
  /** Renders a complete HTML document to PDF bytes. */
  render(html: string, setup?: PageSetup): Promise<Uint8Array>
  /**
   * Renders the same HTML to a PNG of the printed page, for visual review of a fixture.
   *
   * Not a screenshot of the document at some browser width: the content sits inside an A4 sheet with
   * the same margins `render` prints, on a backdrop. A preview that does not show the page box is a
   * preview of a different document — which is how a fixture can look wrong while the PDF is right,
   * and how it can look right while the PDF is wrong.
   */
  screenshot(html: string, setup?: PageSetup): Promise<Uint8Array>
  /** The underlying browser, for callers that need a page of their own. */
  browser(): Browser
  close(): Promise<void>
}

/**
 * Starts one browser and reuses it.
 *
 * Launching Chromium costs a few hundred milliseconds; rendering a page in an existing browser costs
 * tens. A worker that renders a month of invoices starts the browser once.
 */
export async function createPdfRenderer(): Promise<PdfRenderer> {
  const browser = await chromium.launch(LAUNCH_OPTIONS)

  async function withPage<T>(html: string, use: (page: PageLike) => Promise<T>): Promise<T> {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.setContent(html, { waitUntil: 'load' })
      // `load` does not wait for fonts. Without this the first paint can use the fallback face, and
      // in a PDF there is no second paint to correct it.
      await page.evaluate(async () => {
        await (globalThis as unknown as PageGlobals).document.fonts.ready
      })
      return await use(page)
    } finally {
      await context.close()
    }
  }

  return {
    async render(html, setup = A4_DOCUMENT) {
      return withPage(html, async (page) => {
        const bytes = await page.pdf({
          format: setup.format,
          printBackground: true,
          preferCSSPageSize: true,
          margin: {
            top: `${setup.margin.top}mm`,
            right: `${setup.margin.right}mm`,
            bottom: `${setup.margin.bottom}mm`,
            left: `${setup.margin.left}mm`,
          },
        })
        assertPdfWellFormed(bytes)
        return bytes
      })
    },

    async screenshot(html, setup = A4_DOCUMENT) {
      const context = await browser.newContext({
        // A4 at 96dpi plus room for the backdrop either side.
        viewport: { width: Math.round((A4_WIDTH_MM / 25.4) * 96) + 64, height: 1400 },
        deviceScaleFactor: 2,
      })
      try {
        const page = await context.newPage()
        await page.setContent(html, { waitUntil: 'load' })
        await page.addStyleTag({ content: paperPreviewCss(setup) })
        await page.evaluate(async () => {
          await (globalThis as unknown as PageGlobals).document.fonts.ready
        })
        return await page.screenshot({ fullPage: true, type: 'png' })
      } finally {
        await context.close()
      }
    },

    browser() {
      return browser
    },

    close() {
      return browser.close()
    },
  }
}

/**
 * Turns the document into a sheet of A4 on a desk.
 *
 * Injected after the document's own stylesheet so it wins on document order, and scoped to
 * `@media screen` so it can never affect the PDF — the preview must not be able to change the thing
 * it is previewing.
 */
function paperPreviewCss(setup: PageSetup): string {
  const { top, right, bottom, left } = setup.margin
  return `@media screen {
  html {
    background: var(--color-surface-clay);
    padding: 32px 0;
    min-height: 100%;
  }
  body {
    box-sizing: border-box;
    width: ${A4_WIDTH_MM}mm;
    /* At least one full page, so a short document previews as a sheet with space left on it
       rather than as a card cropped to its content. */
    min-height: ${A4_HEIGHT_MM}mm;
    margin: 0 auto;
    padding: ${top}mm ${right}mm ${bottom}mm ${left}mm;
    background: var(--color-ground);
    box-shadow: var(--shadow-overlay);
  }
}`
}

/** The subset of a Playwright page this module needs, so the closure above stays readable. */
interface PageLike {
  pdf(options: Record<string, unknown>): Promise<Buffer>
  evaluate<T>(fn: () => Promise<T>): Promise<T>
  screenshot(options: Record<string, unknown>): Promise<Buffer>
}

const PDF_HEADER = '%PDF-'
const PDF_TRAILER = '%%EOF'

/**
 * Structural check on generated bytes, cheap enough to run on every render.
 *
 * It does not prove the document says the right thing — the tests do that. It catches the failure
 * that would otherwise reach a customer as an attachment that will not open: a truncated write, a
 * renderer that returned an error page, an empty document.
 */
export function assertPdfWellFormed(bytes: Uint8Array): void {
  if (bytes.byteLength < 1024) {
    throw new Error(`Generated PDF is ${bytes.byteLength} bytes, which cannot be a real document.`)
  }
  const head = Buffer.from(bytes.subarray(0, PDF_HEADER.length)).toString('latin1')
  if (head !== PDF_HEADER) {
    throw new Error(
      `Generated PDF does not start with ${PDF_HEADER} (got ${JSON.stringify(head)}).`,
    )
  }
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.byteLength - 64))).toString('latin1')
  if (!tail.includes(PDF_TRAILER)) {
    throw new Error(`Generated PDF has no ${PDF_TRAILER} trailer; the write was truncated.`)
  }
}

/**
 * Base font names of every font embedded in the document.
 *
 * Read straight from the `/BaseFont` entries in the raw bytes, which is enough to answer the only
 * question that matters operationally: did the Arabic face travel with the document, or will the
 * reader substitute something? Chromium prefixes a subset tag, so `IBMPlexSansArabic` arrives as
 * something like `AAAAAB+IBMPlexSansArabic`.
 */
export function embeddedBaseFonts(bytes: Uint8Array): string[] {
  const raw = Buffer.from(bytes).toString('latin1')
  const names = new Set<string>()
  for (const match of raw.matchAll(/\/BaseFont\s*\/([#!-~]+)/g)) {
    const name = match[1]
    if (name !== undefined) names.add(name)
  }
  return [...names].sort()
}
