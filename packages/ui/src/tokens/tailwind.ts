/**
 * The Tailwind v4 theme, and the line that removes Tailwind's own palette.
 *
 * `--color-*: initial;` inside `@theme` clears the entire default colour namespace, so `bg-red-500`,
 * `text-slate-700` and the other 280-odd defaults stop existing rather than merely being discouraged.
 * That is the whole point: a palette whose ratios are derived and measured is worth nothing if a
 * developer can reach for `text-gray-400` and get an un-measured colour that looks close enough.
 *
 * What replaces them is exactly the token set — so every Tailwind colour utility in this codebase
 * resolves to a value `scripts/palette.py` derived and re-measures on every CI run.
 *
 * The same reset is applied to spacing, radius and timing: Tailwind's `p-4` and ours would otherwise
 * both exist and mean different things.
 */
import { DARK_PALETTE, LIGHT_PALETTE } from './palette.generated.ts'
import { BREAKPOINTS, DURATION, EASING, RADIUS, SPACE } from './scale.ts'

/**
 * Colour utilities are generated from the LIGHT token names.
 *
 * Both themes publish the same custom property names, so one utility works in both: `text-ink`
 * resolves to `var(--color-ink)`, which the cascade has already set per theme. A dark-only token
 * gets a utility too, and simply has no light value.
 */
function colourNames(): string[] {
  return [...new Set([...Object.keys(LIGHT_PALETTE), ...Object.keys(DARK_PALETTE)])].sort()
}

export function tailwindThemeCss(): string {
  const colours = colourNames().map((token) => `  --color-${token}: var(--color-${token});`)
  const spacing = SPACE.map((_, index) => `  --spacing-${index}: var(--space-${index});`)
  const radius = Object.keys(RADIUS).map((key) => `  --radius-${key}: var(--radius-${key});`)
  const duration = Object.keys(DURATION).map((key) => `  --duration-${key}: var(--dur-${key});`)
  const easing = Object.keys(EASING).map((key) => `  --ease-${key}: var(--ease-${key});`)
  const breakpoints = Object.entries(BREAKPOINTS).map(
    ([key, value]) => `  --breakpoint-${key}: ${value}px;`,
  )

  return [
    '/*',
    ' * GENERATED from packages/ui/src/tokens. Do not edit.',
    ' *',
    " * Tailwind v4 theme. The `initial` lines clear Tailwind's defaults — without them, any of the",
    ' * 280-odd un-measured default shades remains one keystroke away from every component here.',
    ' * Regenerate with `pnpm tokens:emit`.',
    ' */',
    '',
    '@theme {',
    '  /* Remove every Tailwind default before redefining. */',
    '  --color-*: initial;',
    '  --spacing-*: initial;',
    '  --radius-*: initial;',
    '  --breakpoint-*: initial;',
    '  --font-*: initial;',
    '',
    '  /* Palette — derived and re-measured by scripts/palette.py. */',
    ...colours,
    '',
    '  /* Scales — docs/08 sections 3 to 5. */',
    ...spacing,
    ...radius,
    ...duration,
    ...easing,
    ...breakpoints,
    '',
    "  --font-display: 'Cormorant Garamond', Georgia, serif;",
    "  --font-sans: 'IBM Plex Sans', system-ui, sans-serif;",
    "  --font-arabic: 'IBM Plex Sans Arabic', 'IBM Plex Sans', sans-serif;",
    '}',
    '',
  ].join('\n')
}
