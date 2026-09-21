#!/usr/bin/env node
/**
 * Four rules a design document cannot enforce on its own.
 *
 * Each violation is reported with its **rule name** first, so `scripts/test-gates.mjs` can assert that a
 * known-bad fixture was rejected *by the rule it was written for*. Asserting only a non-zero exit is how
 * a gate ends up passing because of an unrelated rule while the one under test has quietly stopped
 * matching anything — the ADR 0003 failure mode.
 *
 * **1. No un-tokened colour.** A raw `#89612E`, `rgb(...)` or `oklch(...)` anywhere outside the token
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
 * **4. The display face is never small.** Cormorant Garamond is a high-contrast serif: its thin strokes
 * approach a hairline, and below the `lg` step (1.25rem / 20px) they thin out to the point where the
 * letterforms stop resolving on a low-density screen and fail 1.4.3 for readers who need contrast. It is
 * a display face, and this is the fence around it. `--font-sans` is what small text uses.
 *
 * Scanned: every CSS and TS/TSX source outside the token layer itself. The token layer is where
 * literal colours are supposed to be.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stripNonCode } from './lib/strip-non-code.mjs'

const ROOTS = ['packages', 'apps']
const EXTENSIONS = new Set(['.css', '.ts', '.tsx'])
const SKIP_DIRECTORIES = new Set(['.claude', 'node_modules', 'dist', '.next', 'fixtures'])

/**
 * Files exempt from these rules, and why each one is.
 *
 * Two kinds only: the token layer, which is where literal colours are supposed to be, and the known-
 * bad design fixture, whose purpose is to contain the violations. Each entry is a single file rather
 * than a directory, so an exemption cannot quietly widen.
 */
const EXEMPT = [
  'packages/ui/src/tokens/palette.generated.ts',
  'packages/ui/src/tokens/tokens.css',
  'packages/ui/src/tokens/palette.test.ts',
  // The contrast test needs pure white and pure black as literals, and neither is a palette token — they
  // are the two fixed points of the WCAG formula (1:1 and 21:1), which is exactly what that assertion
  // pins. Tokenising them to satisfy this rule would put two colours in the palette that no design ever
  // uses, so the exemption is the honest answer.
  'packages/ui/src/tokens/contrast.test.ts',
  // The one shadow token. A shadow carries no contrast requirement, so there is nothing for
  // palette.py to derive or measure; see the file's own note on why the exception is scoped to it.
  'packages/ui/src/tokens/shadow.ts',
  // The known-bad design fixture. Its entire purpose is to contain the violations this gate exists
  // to catch, and `scripts/test-gates.mjs` fails the build if the critique pass reports it clean.
  // It is a separate file precisely so this exemption covers the smallest possible surface.
  'packages/harness/src/non-compliant.ts',
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

/**
 * Any literal colour: hex, or a functional notation whose arguments are all literal.
 *
 * `[^)$]*` rather than `[^)]*` on purpose. `rgb(${r}, ${g}, ${b})` inside a diagnostic message is not
 * a colour anybody chose — it is a template hole reporting one back — and flagging it sends the
 * reader to fix a string. The gate found that in its own critique pass's error message.
 */
const COLOUR_LITERAL =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*(?:from\s+)?[^)$]*\)/gi

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

/**
 * The type scale, read from the one place it is written down as CSS.
 *
 * `apps/web/app/globals.css` maps `scale.ts` onto Tailwind's `--text-*` namespace, and
 * `apps/web/src/type-scale.test.ts` fails if the two disagree — so reading it here gives this gate the
 * real scale without a second copy of it, and without this script having to load TypeScript.
 *
 * If the file is missing the map is empty, and rule 4 then judges only literal sizes. That is a
 * degradation rather than a silent pass: a `font-size: 0.875rem` is still caught, and
 * `scripts/test-gates.mjs` asserts the rule fires on a fixture that uses a literal.
 */
const TYPE_STEPS = (() => {
  const steps = new Map()
  try {
    const css = readFileSync('apps/web/app/globals.css', 'utf8')
    for (const match of css.matchAll(/--text-([a-z0-9]+)\s*:\s*([^;]+);/gi)) {
      const [, name = '', value = ''] = match
      steps.set(name.toLowerCase(), value.trim())
    }
  } catch {
    // No app yet, or it moved. Literal sizes are still judged.
  }
  return steps
})()

/** The `lg` step, 1.25rem. Below this the display serif's thin strokes stop resolving. */
const DISPLAY_FLOOR_REM = 1.25
const ROOT_FONT_SIZE_PX = 16

/**
 * A font-size in rem, or `undefined` when it cannot be known statically.
 *
 * `undefined` is not a pass — it is an abstention, and it is the honest answer for `calc()`, for a
 * percentage, and for a custom property this gate has never heard of. A rule that guessed would either
 * fail builds over arithmetic it cannot do, or report a number it made up.
 */
function remOf(raw, seen = new Set()) {
  const value = raw.trim().toLowerCase()

  const step = value.match(/^var\(\s*--text-([a-z0-9]+)\s*\)$/)
  if (step) {
    const name = step[1] ?? ''
    // A `--text-x: var(--text-y)` chain would otherwise recurse forever.
    if (seen.has(name)) return undefined
    const mapped = TYPE_STEPS.get(name)
    return mapped === undefined ? undefined : remOf(mapped, new Set([...seen, name]))
  }

  // A clamp's first argument is its floor, which is the size a narrow phone actually gets.
  const clamped = value.match(/^clamp\(\s*([^,]+),/)
  const scalar = (clamped?.[1] ?? value).trim()

  const rem = scalar.match(/^([\d.]+)\s*r?em$/)
  if (rem) return Number.parseFloat(rem[1] ?? '')
  const px = scalar.match(/^([\d.]+)\s*px$/)
  if (px) return Number.parseFloat(px[1] ?? '') / ROOT_FONT_SIZE_PX
  const pt = scalar.match(/^([\d.]+)\s*pt$/)
  if (pt) return (Number.parseFloat(pt[1] ?? '') * 4) / 3 / ROOT_FONT_SIZE_PX
  return undefined
}

const USES_DISPLAY_FAMILY = /\bfont(?:-family)?\s*:[^;]*var\(\s*--font-display\s*\)/i
const FONT_SIZE_DECLARATION = /\bfont-size\s*:\s*([^;}\n]+)/i

/** Every `{ ... }` body in a stylesheet or a template literal, with the line it starts on. */
function* declarationBlocks(text) {
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
    yield { body: match[1] ?? '', line: text.slice(0, match.index).split('\n').length }
  }
}

/**
 * Every quoted string, for the Tailwind half of rule 4.
 *
 * A class list is a string, and `font-display text-sm` in one is the utility spelling of the same
 * mistake. Scanning strings rather than whole lines keeps a sentence in prose from matching, and keeps
 * a wrapped `className={...}` from splitting a class list across two scans.
 */
const STRING_LITERAL = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g
const SMALL_TEXT_UTILITY = new RegExp(
  `\\btext-(${[...TYPE_STEPS.keys()]
    .filter((name) => {
      const rem = remOf(TYPE_STEPS.get(name) ?? '')
      return rem !== undefined && rem < DISPLAY_FLOOR_REM
    })
    .join('|')})\\b`,
)
const DISPLAY_UTILITY = /\bfont-display\b/

/** Rule 4 — the display face below the `lg` step. */
function* displayFontTooSmall(file, text) {
  for (const { body, line } of declarationBlocks(text)) {
    if (!USES_DISPLAY_FAMILY.test(body)) continue
    const size = body.match(FONT_SIZE_DECLARATION)?.[1]
    if (size === undefined) continue
    const rem = remOf(size)
    if (rem === undefined || rem >= DISPLAY_FLOOR_REM) continue
    const shown = size.trim()
    const resolved = shown.endsWith('rem') ? '' : ` (${rem}rem)`
    yield `${file}:${line}  [no-display-font-below-lg] var(--font-display) at font-size ${shown}` +
      `${resolved} — the display serif's strokes stop resolving below ${DISPLAY_FLOOR_REM}rem; ` +
      'use var(--font-sans)'
  }

  if (file.endsWith('.css') || TYPE_STEPS.size === 0) return
  for (const match of text.matchAll(STRING_LITERAL)) {
    const literal = match[1] ?? match[2] ?? match[3] ?? ''
    if (!DISPLAY_UTILITY.test(literal) || !SMALL_TEXT_UTILITY.test(literal)) continue
    const line = text.slice(0, match.index).split('\n').length
    yield `${file}:${line}  [no-display-font-below-lg] 'font-display' with ` +
      `'${literal.match(SMALL_TEXT_UTILITY)?.[0]}' — the display serif's strokes stop resolving below ` +
      `${DISPLAY_FLOOR_REM}rem; use 'font-sans'`
  }
}

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
    const exempt = EXEMPT.some((entry) => file.endsWith(entry))
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
      if (!exempt) {
        for (const match of line.matchAll(COLOUR_LITERAL)) {
          if (HARMLESS.test(match[0])) continue
          violations.push(
            `${at}  [no-untokened-colour] ${match[0]} — use a token from @berelax/ui, or add it ` +
              'to the palette',
          )
        }
      }

      // Rules 2 and 3 are exempt on the same files. A fixture that cannot contain the defect it
      // exists to demonstrate is not a fixture.
      if (exempt) continue

      // Rule 2 — the decorative gold on something that carries meaning.
      for (const match of line.matchAll(TEXT_BEARING_DECLARATION)) {
        const [, property, value = ''] = match
        if (DECOR_GOLD.test(value) || DECOR_GOLD_TOKEN.test(value)) {
          violations.push(
            `${at}  [decor-gold-never-carries-text] used for '${property}' — it measures 2.90:1 and ` +
              'carries no information; use --color-accent-gold (4.62:1)',
          )
        }
      }

      // Rule 3 — Tailwind's default palette.
      for (const match of line.matchAll(TAILWIND_DEFAULT_UTILITY)) {
        violations.push(
          `${at}  [no-tailwind-default-palette] utility '${match[0]}' — the defaults are cleared in ` +
            'tailwind.css and this colour was never measured',
        )
      }
    }

    // Rule 4 — the display face at a small size. Whole-file rather than line-by-line: a declaration
    // block spans lines, and the family and the size are rarely on the same one.
    if (!exempt) {
      for (const violation of displayFontTooSmall(file, text)) violations.push(violation)
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
  `Design tokens hold across ${scanned} source files: no un-tokened colour, no decorative gold on ` +
    'text, no Tailwind defaults, no display serif below the lg step.',
)
