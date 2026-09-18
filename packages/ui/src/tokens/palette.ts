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
import { DARK_PALETTE, LIGHT_PALETTE, PALETTE_RATIOS } from './palette.generated.ts'

export { DARK_PALETTE, LIGHT_PALETTE, PALETTE_RATIOS }

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
