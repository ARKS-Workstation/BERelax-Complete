#!/usr/bin/env node
/**
 * Three colour rules a design document cannot enforce on its own.
 *
 * **1. No un-tokened colour.** A raw `#946A32`, `rgb(...)` or `oklch(...)` anywhere outside the token
 * layer is a colour nobody derived and nobody measured. The palette's whole value is that every
 * shade meets a stated contrast ratio; one hand-typed hex in a component and that guarantee is a
 * claim rather than a fact.
 *
 * **2. The brand gold never carries text.** `#C08A43` measures 2.90:1 against the light ground. It
 * fails the 4.5:1 body threshold and the 3:1 threshold for user-interface components, so it cannot be
 * a text colour, an icon that means something, or a border that conveys state. It stays in the
 * palette as `--color-decor-gold` because it is the brand; this rule is the fence around it. The
 * darkened `--color-accent-gold` (4.62:1) is what text uses, and it still reads as gold.
 *
 * **3. No Tailwind default palette.** `tailwind.css` clears the defaults with `--color-*: initial`,
 * but a stale build or a copied snippet can still carry `bg-red-500`. Catching the class name is
 * cheaper than discovering it rendered grey.
 *
 * Scanned: every CSS and TS/TSX source outside the token layer itself. The token layer is where
 * literal colours are supposed to be.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stripNonCode } from './lib/strip-non-code.mjs'

const ROOTS = ['packages', 'apps']
const EXTENSIONS = new Set(['.css', '.ts', '.tsx'])
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.next', 'fixtures'])

/**
 * Files allowed to contain literal colours.
 *
 * The generated palette and the script that derives it, plus the one place the prototype's original
 * values are recorded. Nothing else.
 */
const COLOUR_LITERAL_ALLOWLIST = [
  'packages/ui/src/tokens/palette.generated.ts',
  'packages/ui/src/tokens/tokens.css',
  'packages/ui/src/tokens/palette.test.ts',
]

/** The prototype gold. Decorative only — see rule 2. */
const DECOR_GOLD = /#C08A43\b/i
const DECOR_GOLD_TOKEN = /var\(\s*--color-decor-(gold|tan)\s*\)/i

/**
 * Properties whose value is read as text, or as a component boundary that carries meaning.
 *
 * `border-color` is here because WCAG 1.4.11 applies a 3:1 threshold to the visual boundary of a
 * control, and the decorative gold does not reach it. A purely ornamental rule uses
 * `--color-hairline`, which is not in this list.
 */
const TEXT_BEARING_PROPERTIES = [
  'color',
  '-webkit-text-fill-color',
  'text-decoration-color',
  'caret-color',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-inline-start-color',
  'border-inline-end-color',
  'border-block-start-color',
  'border-block-end-color',
  'outline-color',
  'fill',
  'stroke',
]

const TEXT_BEARING_DECLARATION = new RegExp(
  `(?:^|[;{\\s])(${TEXT_BEARING_PROPERTIES.join('|')})\\s*:\\s*([^;}\\n]+)`,
  'gi',
)

/** Any literal colour: hex, or a functional notation with numeric arguments. */
const COLOUR_LITERAL =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*(?:from\s+)?[^)]*\)/gi

/**
 * Tailwind's default palette as utility class names.
 *
 * Only the families Tailwind ships. A project token called `ink` produces `text-ink`, which is not
 * matched, and that asymmetry is the point.
 */
const TAILWIND_DEFAULT_FAMILIES = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
]
const TAILWIND_DEFAULT_UTILITY = new RegExp(
  `\\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|divide|accent|caret|shadow|decoration|placeholder)-(?:${TAILWIND_DEFAULT_FAMILIES.join('|')})-(?:50|\\d{3})\\b`,
  'g',
)

/**
 * Values that are a literal colour but carry no colour information.
 *
 * `transparent` and `currentColor` are keywords. A gradient of `rgb(58 59 55 / var(--scrim))` is the
 * photography scrim from docs/08 §6, whose alpha is a variable — but its channels are still literal,
 * so it goes through the token layer like everything else rather than being special-cased here.
 */
const HARMLESS = /^(transparent|currentcolor|inherit|initial|unset|none)$/i

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      yield full
    }
  }
}

const violations = []
let scanned = 0

for (const root of ROOTS) {
  try {
    statSync(root)
  } catch {
    continue
  }
  for (const file of walk(root)) {
    const allowed = COLOUR_LITERAL_ALLOWLIST.some((entry) => file.endsWith(entry))
    // Comments are blanked, strings are not: the CSS this gate exists to police lives inside
    // template literals. Without this, the sentence explaining why Tailwind defaults are banned is
    // itself reported as a Tailwind default.
    const text = stripNonCode(readFileSync(file, 'utf8'), {
      lineComments: !file.endsWith('.css'),
    })
    scanned += 1

    for (const [index, line] of text.split('\n').entries()) {
      const at = `${file}:${index + 1}`

      // Rule 1 — un-tokened colour.
      if (!allowed) {
        for (const match of line.matchAll(COLOUR_LITERAL)) {
          if (HARMLESS.test(match[0])) continue
          violations.push(
            `${at}  un-tokened colour ${match[0]} — use a token from @berelax/ui, or add it to the palette`,
          )
        }
      }

      // Rule 2 — the decorative gold on something that carries meaning.
      for (const match of line.matchAll(TEXT_BEARING_DECLARATION)) {
        const [, property, value = ''] = match
        if (DECOR_GOLD.test(value) || DECOR_GOLD_TOKEN.test(value)) {
          violations.push(
            `${at}  decorative gold used for '${property}' — it measures 2.90:1 and carries no ` +
              'information; use --color-accent-gold (4.62:1)',
          )
        }
      }

      // Rule 3 — Tailwind's default palette.
      for (const match of line.matchAll(TAILWIND_DEFAULT_UTILITY)) {
        violations.push(
          `${at}  Tailwind default palette utility '${match[0]}' — the defaults are cleared in ` +
            'tailwind.css and this colour was never measured',
        )
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Colour token violations:\n')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(`\n${violations.length} violation(s).`)
  process.exit(1)
}

console.log(
  `Colour tokens hold across ${scanned} source files: no un-tokened colour, no decorative gold on text, no Tailwind defaults.`,
)
