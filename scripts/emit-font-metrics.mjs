#!/usr/bin/env node
/**
 * Measures the metric-matched fallback overrides, in a browser, rather than guessing them.
 *
 * ## What this is for
 *
 * A web font arrives after the first paint. Until it does the browser draws the fallback, and when
 * the real face swaps in, every line reflows by the difference in their metrics. On a hero set in
 * Cormorant Garamond that reflow is worth **0.05–0.15 CLS on its own** (docs/08 §3), which is the
 * difference between passing Core Web Vitals and not.
 *
 * `size-adjust`, `ascent-override` and `descent-override` on the fallback `@font-face` make the
 * fallback occupy the same space as the real face, so the swap moves nothing. The numbers are
 * specific to each pairing and there is no way to reason them out: they are ratios between two fonts'
 * metrics, and the only honest source is measuring both.
 *
 * ## Why Chromium rather than a font parser
 *
 * The metrics that matter are the ones the *renderer* uses, which is not always what the font tables
 * say — a variable font's default instance, a fallback the system substituted, hinting. Measuring the
 * rendered result answers the question that is actually being asked. It also needs no woff2 decoder.
 *
 * Output is generated and committed, and `pnpm fonts` fails when it is stale — same contract as the
 * palette. Run `pnpm fonts:emit` after changing a face.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { chromium } from 'playwright'

const require = createRequire(import.meta.url)
const EMIT = process.argv.includes('--emit')
const TARGET = join(
  import.meta.dirname,
  '..',
  'packages',
  'ui',
  'src',
  'theme',
  'font-fallbacks.generated.css',
)

/**
 * Each web font, and the local face the browser will draw until it arrives.
 *
 * The fallbacks are chosen for availability rather than for looks: Arial and Times New Roman exist
 * everywhere that matters, and a fallback nobody has is a fallback that falls back again.
 */
const PAIRINGS = [
  {
    name: 'IBM Plex Sans',
    variable: '--font-sans',
    file: '@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2',
    fallback: 'Arial',
    fallbackStack: 'Arial, Helvetica, sans-serif',
    sample: 'Hxp',
  },
  {
    name: 'Jost',
    variable: '--font-eyebrow',
    file: '@fontsource-variable/jost/files/jost-latin-wght-normal.woff2',
    fallback: 'Arial',
    fallbackStack: 'Arial, Helvetica, sans-serif',
    sample: 'Hxp',
  },
  {
    name: 'Cormorant Garamond',
    variable: '--font-display',
    file: '@fontsource-variable/cormorant-garamond/files/cormorant-garamond-latin-wght-normal.woff2',
    fallback: 'Times New Roman',
    fallbackStack: "'Times New Roman', Times, serif",
    sample: 'Hxp',
  },
  {
    name: 'IBM Plex Sans Arabic',
    variable: '--font-arabic',
    file: '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-500-normal.woff2',
    fallback: 'Arial',
    fallbackStack: 'Arial, Helvetica, sans-serif',
    // Arabic, because the ratio has to be measured on the script the face will actually draw. Plex
    // Arabic carries Latin glyphs too, so measuring 'Hxp' would have produced a plausible number for
    // text this face never renders.
    sample: 'مساج استرخاء',
  },
]

function dataUrl(specifier) {
  return `data:font/woff2;base64,${readFileSync(require.resolve(specifier)).toString('base64')}`
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] })
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })

  const faces = PAIRINGS.map(
    (pairing, index) =>
      `@font-face { font-family: 'M${index}'; src: url(${dataUrl(pairing.file)}) format('woff2'); font-display: block; }`,
  ).join('\n')

  const probes = PAIRINGS.map(
    (pairing, index) =>
      `<span id="w${index}" style="font-family:'M${index}'">${pairing.sample}</span>` +
      `<span id="f${index}" style="font-family:${pairing.fallbackStack}">${pairing.sample}</span>`,
  ).join('')

  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>${faces}
body { margin: 0; font-size: 1000px; line-height: 1; }
span { display: inline-block; white-space: pre; }
</style></head><body>${probes}</body></html>`,
    { waitUntil: 'load' },
  )
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready
  })

  const measured = await page.evaluate(
    (samples) => {
      const out = []
      for (const [index, sample] of samples.entries()) {
        // A canvas gives the renderer's own ascent and descent, which is what a fallback has to match.
        const measure = (family) => {
          const canvas = globalThis.document.createElement('canvas')
          const context2d = canvas.getContext('2d')
          context2d.font = `1000px ${family}`
          const metrics = context2d.measureText(sample)
          return {
            ascent: metrics.fontBoundingBoxAscent,
            descent: metrics.fontBoundingBoxDescent,
            width: metrics.width,
          }
        }
        const web = measure(`'M${index}'`)
        const fallbackFamily = globalThis.document
          .getElementById(`f${index}`)
          .style.fontFamily.split(',')[0]
          .trim()
        const fallback = measure(fallbackFamily)
        out.push({ web, fallback })
      }
      return out
    },
    PAIRINGS.map((pairing) => pairing.sample),
  )

  const blocks = PAIRINGS.map((pairing, index) => {
    const { web, fallback } = measured[index]
    // size-adjust scales the fallback so its advance width matches; the overrides then restore the
    // line box, expressed as a percentage of the ADJUSTED em.
    const sizeAdjust = web.width / fallback.width
    const ascent = web.ascent / 1000 / sizeAdjust
    const descent = web.descent / 1000 / sizeAdjust
    const pct = (value) => `${(value * 100).toFixed(2)}%`
    return [
      `/* ${pairing.name} falling back to ${pairing.fallback}. */`,
      '@font-face {',
      `  font-family: '${pairing.name} Fallback';`,
      `  src: local('${pairing.fallback}');`,
      `  size-adjust: ${pct(sizeAdjust)};`,
      `  ascent-override: ${pct(ascent)};`,
      `  descent-override: ${pct(descent)};`,
      '  line-gap-override: 0%;',
      '}',
    ].join('\n')
  })

  const content = [
    '/*',
    ' * GENERATED by scripts/emit-font-metrics.mjs. Do not edit.',
    ' *',
    ' * Metric-matched fallbacks, measured in Chromium rather than reasoned out. Without these the',
    ' * font swap reflows every line, which on a display serif is worth 0.05-0.15 CLS on its own.',
    ' * Regenerate with `pnpm fonts:emit`.',
    ' */',
    '',
    ...blocks,
    '',
  ].join('\n')

  const relative = 'packages/ui/src/theme/font-fallbacks.generated.css'
  if (EMIT) {
    writeFileSync(TARGET, content)
    console.log(`wrote ${relative} — ${PAIRINGS.length} fallbacks`)
  } else {
    // Check mode, so that changing a face and forgetting to regenerate is a failed gate rather than a
    // silent 0.1 CLS regression. The measurement is deterministic in a fixed Chromium: the numbers are
    // ratios of two fonts' own metrics, not of anything the page does.
    const existing = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : ''
    if (existing !== content) {
      console.error(
        `${relative} is stale.\n` +
          'A face changed and the metric-matched fallbacks were not regenerated. Run `pnpm fonts:emit`.',
      )
      process.exitCode = 1
    } else {
      console.log(`${relative} is current — ${PAIRINGS.length} fallbacks`)
    }
  }
} finally {
  await browser.close()
}
