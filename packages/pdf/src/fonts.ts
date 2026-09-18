/**
 * Fonts for generated documents, embedded rather than referenced.
 *
 * A PDF that names a font it does not carry renders however the reader's machine feels like
 * rendering it, and for Arabic that usually means tofu boxes. Worse for us: a test asserting
 * "Arabic appears in the PDF" passes vacuously against notdef glyphs, because notdef glyphs still
 * carry the original codepoints in the ToUnicode map. So the font travels with the document.
 *
 * The woff2 files come from the pinned `@fontsource/*` packages and are inlined as `data:` URLs.
 * Inlining rather than a `file://` URL keeps the renderer working from `setContent` with no file
 * access and no local web server, and it removes the whole class of "worked on my machine, rendered
 * boxes in production" failure: the HTML handed to Chromium is self-contained.
 *
 * Total cost is ~135KB of woff2, ~180KB once base64-encoded. That is per-render string building, not
 * per-render disk reads: the encoded faces are cached for the life of the process.
 *
 * IBM Plex Sans and IBM Plex Sans Arabic are one family designed together, which is why they pair
 * across a bilingual invoice without the Latin column looking a size off the Arabic one. Both are
 * SIL Open Font License 1.1; see `packages/pdf/THIRD-PARTY.md`.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** The Latin family used for document body text and figures. */
export const LATIN_FAMILY = 'IBM Plex Sans'
/** The Arabic family. Restricted by `unicode-range` so it never takes over Latin text. */
export const ARABIC_FAMILY = 'IBM Plex Sans Arabic'

/**
 * `unicode-range` for the Arabic face, from the fontsource subset metadata.
 *
 * Without it Chromium is free to satisfy Latin glyphs from whichever face it loaded first, and the
 * document's Latin figures would silently change metrics. With it, each script resolves to the face
 * that was designed for it, and the font stack order stops mattering.
 */
const ARABIC_UNICODE_RANGE = [
  'U+0600-06FF',
  'U+0750-077F',
  'U+0870-088E',
  'U+08A0-08FF',
  'U+FB50-FDFF',
  'U+FE70-FE74',
  'U+FE76-FEFC',
  'U+200C-200D',
  'U+10E60-10E7E',
].join(', ')

export interface FontFace {
  readonly family: string
  readonly weight: 400 | 600
  /** Module specifier of the woff2 file inside its pinned package. */
  readonly specifier: string
  readonly unicodeRange?: string
}

/**
 * Exactly four faces: regular and semibold in each script.
 *
 * Four is a budget, not an accident. Each face is a font subset embedded in every PDF, and an
 * invoice needs one weight for figures and one for headings. Italic is not used in either script —
 * Arabic has no italic tradition, and a slanted invoice column is noise.
 */
export const FACES: readonly FontFace[] = [
  {
    family: LATIN_FAMILY,
    weight: 400,
    specifier: '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2',
  },
  {
    family: LATIN_FAMILY,
    weight: 600,
    specifier: '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2',
  },
  {
    family: ARABIC_FAMILY,
    weight: 400,
    specifier:
      '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-400-normal.woff2',
    unicodeRange: ARABIC_UNICODE_RANGE,
  },
  {
    family: ARABIC_FAMILY,
    weight: 600,
    specifier:
      '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-600-normal.woff2',
    unicodeRange: ARABIC_UNICODE_RANGE,
  },
]

const encoded = new Map<string, string>()

function dataUrl(specifier: string): string {
  const cached = encoded.get(specifier)
  if (cached !== undefined) return cached
  const path = require.resolve(specifier)
  const base64 = readFileSync(path).toString('base64')
  const url = `data:font/woff2;base64,${base64}`
  encoded.set(specifier, url)
  return url
}

/**
 * The `@font-face` block for every embedded face.
 *
 * `font-display: block` rather than `swap`: a PDF has no second paint, so a swap would print the
 * fallback. On the web the trade-off runs the other way — see docs/08 §3.
 */
export function fontFaceCss(): string {
  return FACES.map((face) => {
    const range = face.unicodeRange === undefined ? '' : `\n  unicode-range: ${face.unicodeRange};`
    return [
      '@font-face {',
      `  font-family: '${face.family}';`,
      '  font-style: normal;',
      `  font-weight: ${face.weight};`,
      '  font-display: block;',
      `  src: url(${dataUrl(face.specifier)}) format('woff2');${range}`,
      '}',
    ].join('\n')
  }).join('\n\n')
}

/** The stack every document uses. Latin first; the Arabic face is reached by `unicode-range`. */
export const FONT_STACK = `'${LATIN_FAMILY}', '${ARABIC_FAMILY}', sans-serif`

/** Byte size of the embedded faces, for the render-cost assertion in the tests. */
export function embeddedFontBytes(): number {
  return FACES.reduce(
    (total, face) => total + readFileSync(require.resolve(face.specifier)).length,
    0,
  )
}
