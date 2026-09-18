#!/usr/bin/env node
/**
 * Six rules about layout, motion and elevation that a design document cannot enforce on its own.
 *
 * Each violation is reported with its **rule name** first, so `scripts/test-gates.mjs` can assert that a
 * known-bad fixture was rejected by the rule written for it. A bare non-zero exit is how a gate ends up
 * passing because of an unrelated rule while the one under test has quietly stopped matching anything —
 * ADR 0003.
 *
 * **1. `no-rtl-inside-keyframes`.** docs/08 §5 mirrors animation with a direction multiplier:
 * `:root { --dir: 1 } [dir="rtl"] { --dir: -1 }`, and `translateX(calc(var(--move-lg) * var(--dir)))`.
 * One keyframe set, two directions. A `[dir="rtl"]` selector *inside* a keyframes block is the shape of
 * somebody trying to author the mirror image by hand — and because it is not even valid there, it
 * silently does nothing: the animation plays unmirrored and the RTL page slides the wrong way.
 *
 * **2. `no-mirrored-keyframes-pair`.** The same mistake spelled the way it actually ships: a second
 * `@keyframes` whose name differs only by an `-rtl`/`-ltr` suffix, or a `[dir="rtl"]` rule that swaps
 * `animation-name`. Two animations to keep in step is one animation that will not be.
 *
 * **3. `no-media-query-in-container-component`.** `packages/ui/src/patterns` holds the reusable pieces:
 * a card that appears four-across on the home page, in the measure column of a treatment page, and in a
 * 300px admin rail — three widths at the *same* viewport. A `@media (min-width` there is right in one of
 * the three places and wrong in the other two. `@container` asks the only question that predicts the
 * layout.
 *
 * **4. `shadow-must-use-overlay-token`.** docs/08 §2 specifies exactly one shadow. A second one is a
 * second elevation language, and the first hand-rolled `0 2px 6px` is how a flat system stops being one.
 *
 * **5. `shadow-only-in-overlay-components`.** The one shadow is for things that float above the page —
 * dialog, sheet, popover, toast. A shadow on a card is decoration; the card already has a hairline and a
 * surface, and docs/08 §1 makes elevation the exception rather than the texture.
 *
 * **6. `no-shadow-in-dark-theme`.** On a dark ground a shadow reads as a smudge, so elevation there is
 * surface lightness instead. `--shadow-overlay` is already `none` in dark mode, which means a
 * `box-shadow` written inside a dark-theme block is at best dead code and at worst a literal that
 * defeats the token.
 *
 * Scanned: CSS and TS/TSX under `packages/ui` and `apps/web` — the design system and the app that
 * renders it. Component CSS in this project is authored in template literals (see
 * `packages/ui/src/layout/styles.tsx`), so the scanner reads the whole file with comments blanked rather
 * than parsing CSS files only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { stripNonCode } from './lib/strip-non-code.mjs'

const ROOTS = ['packages/ui', 'apps/web']
const EXTENSIONS = new Set(['.css', '.ts', '.tsx'])
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.next', '.claude'])

/** Where the container-query components live. Rule 3 applies here and nowhere else. */
const CONTAINER_COMPONENT_DIRECTORY = 'packages/ui/src/patterns/'

/**
 * What counts as an overlay, by filename.
 *
 * By name rather than by an allowlist of paths, because the components this covers do not exist yet —
 * the dialog, the bottom sheet and the toast arrive with W-SYS-03 and the booking flow. A name-based
 * rule is one those units pass by calling a file what it is, and it still fails the moment a shadow
 * lands on `therapist-card.tsx`.
 */
const OVERLAY_NAME = /(overlay|dialog|sheet|toast|popover|tooltip|menu|drawer|modal)/i

/** The only shadow. Anything else is a second elevation language. */
const ALLOWED_SHADOW = /^(var\(\s*--shadow-overlay\s*\)|none|inherit|initial|unset|revert)$/i

const RTL_SELECTOR = /\[dir\s*=\s*['"]?rtl['"]?\]|:dir\(\s*rtl\s*\)/i
const DARK_SCOPE = /\[data-theme\s*=\s*['"]?dark['"]?\]|prefers-color-scheme\s*:\s*dark/i
const ANIMATION_DECLARATION = /(^|[;{\s])animation(-name)?\s*:/i
const MEDIA_WIDTH_QUERY = /@media[^{;]*\(\s*(min|max)-width/i
const BOX_SHADOW_DECLARATION = /(^|[;{\s])box-shadow\s*:\s*([^;}\n]+)/gi
/** Global, because rule 2 has to see every keyframes name in the file, not just the first. */
const KEYFRAMES_NAMES = /@keyframes\s+([A-Za-z_][\w-]*)/g

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length
}

/**
 * Every `{ ... }` block in a file, with its prelude and its character range.
 *
 * A prelude is whatever sits between the previous `{`, `}` or `;` and this `{` — which is the selector
 * or at-rule for CSS, and harmless noise for a JavaScript function body. The ranges are what let a
 * declaration be attributed to the innermost block containing it *and* to that block's ancestors, which
 * is how rule 6 knows a `box-shadow` is inside `@media (prefers-color-scheme: dark)` three levels up.
 */
function blocksOf(text) {
  const blocks = []
  const stack = []
  let segmentStart = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '{') {
      stack.push({ prelude: text.slice(segmentStart, index).trim(), start: index + 1 })
      segmentStart = index + 1
    } else if (character === '}') {
      const frame = stack.pop()
      if (frame !== undefined) {
        blocks.push({ prelude: frame.prelude, start: frame.start, end: index })
      }
      segmentStart = index + 1
    } else if (character === ';') {
      segmentStart = index + 1
    }
  }
  // An unclosed block — a template literal cut off mid-rule, or JavaScript the scanner mis-read — still
  // has to be attributable, or a declaration inside it would be judged as if it were at the top level.
  for (const frame of stack)
    blocks.push({ prelude: frame.prelude, start: frame.start, end: text.length })
  return blocks
}

/** The blocks containing an index, innermost first. */
function enclosing(blocks, index) {
  return blocks
    .filter((block) => block.start <= index && index < block.end)
    .sort((a, b) => b.start - a.start)
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
    // Comments blanked, strings kept: the CSS this gate polices lives inside template literals, and a
    // rule explained in its own doc comment must not be reported as a violation of itself.
    const text = stripNonCode(readFileSync(file, 'utf8'), { lineComments: !file.endsWith('.css') })
    const blocks = blocksOf(text)
    const overlay = OVERLAY_NAME.test(basename(file))
    scanned += 1

    // Rule 1 — a direction selector inside a keyframes block.
    for (const block of blocks) {
      if (!block.prelude.includes('@keyframes')) continue
      const body = text.slice(block.start, block.end)
      const match = RTL_SELECTOR.exec(body)
      if (match === null) continue
      violations.push(
        `${file}:${lineAt(text, block.start + match.index)}  [no-rtl-inside-keyframes] ` +
          `'${match[0]}' inside ${block.prelude} — mirror with the --dir multiplier ` +
          '(transform: translateX(calc(var(--move-lg) * var(--dir)))), not a second set of frames',
      )
    }

    // Rule 2 — the same animation authored twice.
    for (const match of text.matchAll(KEYFRAMES_NAMES)) {
      const name = match[1] ?? ''
      if (!/-(rtl|ltr)$/i.test(name)) continue
      violations.push(
        `${file}:${lineAt(text, match.index)}  [no-mirrored-keyframes-pair] @keyframes ${name} — ` +
          'a per-direction copy of one animation; multiply the inline distance by var(--dir) instead',
      )
    }
    for (const block of blocks) {
      if (!RTL_SELECTOR.test(block.prelude)) continue
      const body = text.slice(block.start, block.end)
      if (!ANIMATION_DECLARATION.test(body)) continue
      violations.push(
        `${file}:${lineAt(text, block.start)}  [no-mirrored-keyframes-pair] ` +
          `'${block.prelude}' selects a different animation for RTL — var(--dir) mirrors the one ` +
          'animation, and nothing then has to be kept in step',
      )
    }

    // Rule 3 — a page breakpoint inside a component that answers to its container.
    if (file.replaceAll('\\', '/').includes(CONTAINER_COMPONENT_DIRECTORY)) {
      const match = MEDIA_WIDTH_QUERY.exec(text)
      if (match !== null) {
        violations.push(
          `${file}:${lineAt(text, match.index)}  [no-media-query-in-container-component] ` +
            `'${match[0]}' — this component is reused at three widths at the same viewport; use ` +
            '@container',
        )
      }
    }

    // Rules 4, 5 and 6 — the one shadow, where it belongs, and never in the dark.
    for (const match of text.matchAll(BOX_SHADOW_DECLARATION)) {
      const value = (match[2] ?? '').trim()
      const at = `${file}:${lineAt(text, match.index)}`
      const scope = enclosing(blocks, match.index)

      if (!ALLOWED_SHADOW.test(value)) {
        violations.push(
          `${at}  [shadow-must-use-overlay-token] box-shadow: ${value} — docs/08 §2 specifies one ` +
            'shadow; use var(--shadow-overlay)',
        )
      }
      if (!overlay && !/^none$/i.test(value)) {
        violations.push(
          `${at}  [shadow-only-in-overlay-components] box-shadow in ${basename(file)}, which is not ` +
            'an overlay — a card has a hairline and a surface, and elevation is for things that float',
        )
      }
      const dark = scope.find((block) => DARK_SCOPE.test(block.prelude))
      if (dark !== undefined && !/^none$/i.test(value)) {
        violations.push(
          `${at}  [no-shadow-in-dark-theme] box-shadow inside '${dark.prelude}' — on a dark ground a ` +
            'shadow reads as a smudge; elevation there is surface lightness',
        )
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Layout, motion and elevation violations:\n')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(`\n${violations.length} violation(s).`)
  process.exit(1)
}

console.log(
  `Layout rules hold across ${scanned} source files: one animation per direction pair, no page ` +
    'breakpoint in a container component, one shadow and none in the dark.',
)
