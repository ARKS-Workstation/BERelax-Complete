/**
 * The palette, as types, CSS, and one rule about which tokens may carry text.
 *
 * The hex values live in `palette.generated.ts`, written by `scripts/palette.py` and re-derived on
 * every CI run. This module adds the behaviour around them: the CSS emission that the web and the
 * PDF renderer share, and the classification that makes "a pastel is never load-bearing for text"
 * something a lint rule can check rather than a sentence in a design document.
 *
 * Pure: no I/O. `@berelax/pdf` inlines `paletteCss()` into a document; the web imports the generated
 * stylesheet. Both come from here, so an email, a PDF and a page cannot disagree about what
 * `--color-ink` is.
 */
import {
  DARK_PALETTE,
  LIGHT_PALETTE,
  NON_TEXT_SURFACE_TOKENS,
  PALETTE_MINIMUMS,
  PALETTE_RATIOS,
  PALETTE_WORST_SURFACE_RATIOS,
  TEXT_SURFACE_TOKENS,
} from './palette.generated.ts'

export {
  DARK_PALETTE,
  LIGHT_PALETTE,
  NON_TEXT_SURFACE_TOKENS,
  PALETTE_MINIMUMS,
  PALETTE_RATIOS,
  PALETTE_WORST_SURFACE_RATIOS,
  TEXT_SURFACE_TOKENS,
}

export type LightToken = keyof typeof LIGHT_PALETTE
export type DarkToken = keyof typeof DARK_PALETTE
export type Theme = 'light' | 'dark'

/** The CSS custom property a token is published as. */
export function cssVariable(token: LightToken | DarkToken): string {
  return `--color-${token}`
}

/** `var(--color-…)`, so a component never writes the string twice. */
export function colour(token: LightToken): string {
  return `var(${cssVariable(token)})`
}

/**
 * Tokens that may be used as text, or as a border or icon that carries meaning.
 *
 * Everything else is a surface or a decoration. The distinction is not stylistic: `--color-decor-gold`
 * is the prototype's signature gold at 2.90:1, which fails the 4.5:1 body threshold *and* the 3:1
 * threshold for user-interface components. It stays in the palette because it is the brand, and it is
 * fenced off here because the brand is not a reason to publish unreadable text.
 */
export const TEXT_BEARING_TOKENS: readonly LightToken[] = [
  'ink',
  'ink-2',
  'ink-3',
  'accent-gold',
  'accent-gold-strong',
  'accent-green',
  'accent-teal',
  'border-strong',
  'focus',
  'danger',
  'success',
]

/** Tokens that carry no information and must never be used for text or a meaningful border. */
export const DECORATIVE_ONLY_TOKENS: readonly LightToken[] = (
  Object.keys(LIGHT_PALETTE) as LightToken[]
).filter((token) => !TEXT_BEARING_TOKENS.includes(token))

/** True when `token` is allowed to carry text. */
export function mayCarryText(token: string): boolean {
  return (TEXT_BEARING_TOKENS as readonly string[]).includes(token)
}

/** Measured contrast of a token against its own theme's ground. */
export function contrastOf(theme: Theme, token: string): number | undefined {
  const table: Record<string, number> = PALETTE_RATIOS[theme]
  return table[token]
}

/**
 * Measured contrast of a token against the WORST surface text is allowed on.
 *
 * This is the number a token is held to, and `contrastOf` is not. The ground is the lightest thing a dark
 * foreground sits on in light mode and the darkest thing a light foreground sits on in dark mode, so the
 * ground ratio is the flattering one — `--color-danger` in dark mode reads 4.53:1 there and 3.69:1 on
 * `--color-surface-raised`, and it was derived against the ground for months while the gate said PASS.
 */
export function worstSurfaceContrastOf(theme: Theme, token: string): number | undefined {
  const table: Record<string, number> = PALETTE_WORST_SURFACE_RATIOS[theme]
  return table[token]
}

/** The ratio a token must meet, or null for a surface or decoration that states none. */
export function minimumFor(theme: Theme, token: string): number | null | undefined {
  const table: Record<string, number | null> = PALETTE_MINIMUMS[theme]
  return table[token]
}

/** The palette for a theme, by token. */
export function paletteFor(theme: Theme): Record<string, string> {
  return theme === 'light' ? LIGHT_PALETTE : DARK_PALETTE
}

/**
 * sRGB relative luminance, as WCAG 2.2 defines it.
 *
 * Written here rather than imported so the palette has one implementation the whole product shares — the
 * PDF renderer, the web and the tests. `scripts/palette.py` has its own; the two agreeing on every pairing
 * is the check, and a single shared implementation could be confidently wrong in both places at once.
 */
function relativeLuminance(hex: string): number {
  const raw = hex.replace('#', '')
  if (!/^[0-9A-Fa-f]{6}$/.test(raw)) {
    throw new Error(`[not-a-six-digit-hex] ${hex}`)
  }
  const channel = (offset: number): number => {
    const value = Number.parseInt(raw.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/** WCAG 2.2 contrast ratio between two hex colours, order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function declarations(palette: Record<string, string>, indent: string): string {
  return Object.entries(palette)
    .map(([token, value]) => `${indent}--color-${token}: ${value};`)
    .join('\n')
}

/**
 * The palette as CSS custom properties, light and dark.
 *
 * Dark mode is served twice on purpose: once from `prefers-color-scheme` for the reader who never
 * touches a setting, and once from `[data-theme="dark"]` for the one who does. The media query is
 * guarded with `:root:not([data-theme="light"])` so an explicit light choice survives a dark system
 * preference — without the guard, choosing light on a dark phone does nothing.
 */
export function paletteCss(): string {
  return [
    ':root {',
    declarations(LIGHT_PALETTE, '  '),
    '  color-scheme: light dark;',
    '}',
    '',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]) {',
    declarations(DARK_PALETTE, '    '),
    '  }',
    '}',
    '',
    ':root[data-theme="dark"] {',
    declarations(DARK_PALETTE, '  '),
    '}',
  ].join('\n')
}
