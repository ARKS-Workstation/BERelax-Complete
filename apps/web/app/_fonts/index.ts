/**
 * The four faces, self-hosted.
 *
 * Self-hosted rather than fetched from Google: a third-party font origin costs a DNS lookup, a TLS
 * handshake and a connection before the first byte of a font arrives — typically 100–300ms on a cold
 * mobile connection, in the render-blocking path, on the one request the page cannot proceed without.
 *
 * ## Exactly two preloads, and why not four
 *
 * A preload is a promise that the browser will need this file immediately. Preloading four faces makes
 * all four compete for the same early bandwidth as the LCP image, and the two that are not above the
 * fold win some of it. So the body face and the display face are preloaded; the eyebrow face and the
 * Arabic face are not, because nothing above the fold on an English route is set in them.
 *
 * Two preloads is a count, and `next/font/local` preloads every file in a `src` array — so the body
 * face has to be **one file**. That is why it is the variable cut rather than the static 400 and 600
 * pair: two statics are 22.6KB + 24.3KB = 46.9KB across two preloaded requests and give exactly two
 * weights, where the variable file is 45.7KB across one and gives the whole 100–700 range. Marginally
 * fewer bytes, one fewer request in the critical path, and `font-weight: 500` stops being a synthesised
 * approximation — which matters on a till screen, where the numeric columns are the thing being read.
 *
 * ## Arabic is never served on an English route
 *
 * `preload: false`, and nothing on an English route references the family: `body { font-family: ... }`
 * resolves to `--font-arabic` only under `[lang='ar']`, which is set on `<html>` by the `(ar)` root
 * layout. A browser downloads a face when it is matched to text it is about to draw, so `/` never asks
 * for it — 89KB of glyphs the page does not contain, which is most of a mobile font budget. (The
 * mechanism is *not* `unicode-range`: `next/font/local` emits none. It is that the family is
 * unreferenced, which is why the integration test asserts the absence of the request rather than the
 * presence of a range.) Arabic has no variable cut published, so it stays static cuts — neither
 * preloaded, so the count is unaffected.
 *
 * The Arabic cuts are **500 and 600, not 400 and 600**. `theme/arabic.css` sets Arabic body copy to
 * weight 500, because the Arabic face reads lighter than the Latin one at the same nominal weight. With
 * 400 and 600 shipped, CSS weight matching resolves a request for 500 *downwards* to 400 — so the
 * recalibration silently did nothing, and the 400 file was the only one ever drawn. Shipping 500 and
 * 600 makes the declared weight the weight that renders, and drops a 42KB file nothing asked for.
 */
import localFont from 'next/font/local'

/**
 * Body copy and the whole admin.
 *
 * `Y12-body-face` is still open — Jost is a legibility risk at 17px and worse in a dense till screen —
 * and this is the provisional answer: a high-x-height workhorse sans, which is the safer default for
 * a booking flow. The decision is reversible and recorded.
 */
export const sans = localFont({
  src: '../../node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2',
  weight: '100 700',
  variable: '--font-sans',
  display: 'swap',
  preload: true,
  // The measured fallback from `scripts/emit-font-metrics.mjs`. Next would otherwise synthesise its
  // own adjustment, which it can only do for Google-hosted fonts.
  adjustFontFallback: false,
  fallback: ['IBM Plex Sans Fallback', 'Arial', 'Helvetica', 'sans-serif'],
})

/** Display only. Cormorant Garamond is a high-contrast serif and a poor body face at any size. */
export const display = localFont({
  src: '../../node_modules/@fontsource-variable/cormorant-garamond/files/cormorant-garamond-latin-wght-normal.woff2',
  weight: '300 600',
  variable: '--font-display',
  display: 'swap',
  preload: true,
  adjustFontFallback: false,
  fallback: ['Cormorant Garamond Fallback', 'Times New Roman', 'Times', 'serif'],
})

/** Marketing eyebrows and small caps. Not preloaded: nothing above the fold is set in it. */
export const eyebrow = localFont({
  src: '../../node_modules/@fontsource-variable/jost/files/jost-latin-wght-normal.woff2',
  weight: '300 600',
  variable: '--font-eyebrow',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  fallback: ['Jost Fallback', 'Arial', 'Helvetica', 'sans-serif'],
})

/**
 * Arabic.
 *
 * Not preloaded, and requested only by a page that contains Arabic glyphs. Cormorant Garamond has no
 * Arabic coverage, so Arabic display uses this at a heavier weight rather than a mismatched serif.
 */
export const arabic = localFont({
  src: [
    {
      path: '../../node_modules/@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-500-normal.woff2',
      weight: '500',
      style: 'normal',
    },
    {
      path: '../../node_modules/@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-600-normal.woff2',
      weight: '600',
      style: 'normal',
    },
  ],
  variable: '--font-arabic',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  fallback: ['IBM Plex Sans Arabic Fallback', 'Arial', 'sans-serif'],
})

/** Every font variable, for the `<html>` class. */
export const fontVariables = [
  sans.variable,
  display.variable,
  eyebrow.variable,
  arabic.variable,
].join(' ')
