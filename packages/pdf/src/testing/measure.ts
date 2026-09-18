/**
 * Layout measurements taken in the page rather than from the PDF.
 *
 * Some claims are about layout, not about PDF encoding. "The shaper joined these letters" is one:
 * joining changes advance widths, and advance widths are a layout fact. Measuring it in the page is
 * honest about what is being checked, and it is the measurement that distinguishes real shaping from
 * a fallback font drawing isolated forms — which is the way this whole proof could pass vacuously.
 *
 * Test support. Not exported from the package.
 */
import type { Browser } from 'playwright'
import { FONT_STACK, fontFaceCss } from '../fonts.ts'
import type { PageGlobals } from '../page-globals.ts'

/** ZERO WIDTH NON-JOINER. Breaks the cursive join without changing the letters. */
export const ZWNJ = '\u200c'

export interface Measurement {
  readonly label: string
  readonly widthPx: number
}

/**
 * Renders each sample in isolation and returns its rendered width in CSS pixels.
 *
 * Samples share one page and one font size, so the widths are directly comparable. Each sits in an
 * inline-block with `white-space: pre` so nothing wraps and no width is clamped by a container.
 */
export async function measureTextWidths(
  browser: Browser,
  samples: readonly { label: string; text: string; lang?: string }[],
): Promise<Measurement[]> {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const spans = samples
      .map(
        (sample, index) =>
          `<span id="m${index}" lang="${sample.lang ?? 'ar'}">${sample.text.replace(/[&<>]/g, '')}</span>`,
      )
      .join('<br>')
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaceCss()}
body { margin: 0; font-family: ${FONT_STACK}; font-size: 40px; }
span { display: inline-block; white-space: pre; }
</style></head><body>${spans}</body></html>`,
      { waitUntil: 'load' },
    )
    await page.evaluate(async () => {
      await (globalThis as unknown as PageGlobals).document.fonts.ready
    })
    const widths = await page.evaluate((count: number) => {
      const { document } = globalThis as unknown as PageGlobals
      const out: number[] = []
      for (let index = 0; index < count; index += 1) {
        const element = document.getElementById(`m${index}`)
        out.push(element === null ? 0 : element.getBoundingClientRect().width)
      }
      return out
    }, samples.length)
    return samples.map((sample, index) => ({
      label: sample.label,
      widthPx: Math.round((widths[index] ?? 0) * 100) / 100,
    }))
  } finally {
    await context.close()
  }
}

/** Inserts a ZWNJ between every character, which suppresses cursive joining without removing glyphs. */
export function unjoin(text: string): string {
  return [...text].join(ZWNJ)
}
