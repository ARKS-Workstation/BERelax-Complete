#!/usr/bin/env node
/**
 * Thirteen rules about layout, motion and elevation that a design document cannot enforce on its own.
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
 * **7. `reduced-motion-belongs-to-the-token-layer`.** docs/08 §5 makes reduced motion "a token override,
 * not a per-component branch": one `@media (prefers-reduced-motion: reduce)` block sets the durations to
 * 120ms, the movement distances to 0px and the stagger to 0ms, and every component inherits compliance
 * through `var()`. A second block anywhere is the beginning of the other design, where each component
 * decides for itself — and the ones that get it wrong are invisible, because nobody reviews with the
 * setting on. So the media query may appear in exactly **one** authored file, and it is the emitter of the
 * token stylesheet.
 *
 * **8. `at-most-two-scroll-driven-effects`.** docs/08 §7: "**Exactly two** scroll-driven effects exist:
 * header condensation and below-fold reveal." Counted as *declarations*, because that is what costs
 * something: a scroll-driven animation is cheap in isolation and a page of them is a page whose every
 * frame recomputes. The count is asserted in both directions — a third is decoration, and a missing one is
 * an effect somebody deleted, which is equally worth a failing build.
 *
 * **9. `motion-island-must-be-a-dynamic-client-module`.** docs/08 §7 puts the motion library in "≤2
 * code-split islands, never in the shared layout". An island that is missing `'use client'` is not an
 * island at all, and an island reached by a *static* import is in the importer's chunk — which is the one
 * thing code-splitting was for. Both are silent: the page still works, and the bytes move.
 *
 * **10. `at-most-two-motion-islands`.** The other half of "≤2": a third island is a third chunk on a
 * route, and the budget in `build/budgets.json` measures the ones that are declared there.
 *
 * **11. `motion-library-only-in-a-client-island`.** `motion`/`framer-motion` is 32-36KB gzip. It may be
 * imported only by an island, so that the fence above applies to it too — and a component that reaches
 * for it directly gets a build failure rather than a page that now carries an animation runtime.
 *
 * **12. `viewport-height-must-be-dynamic`.** docs/09 §3, in the list of booking-flow mechanics: *"`100dvh`
 * never `100vh`"*. `vh` is the **large** viewport height, which on a phone is the height the window has when
 * the browser's own toolbars are hidden — so an element sized `100vh` is taller than the visible area for as
 * long as the toolbar is showing, and the bottom of it, which on a booking flow is the primary action, is
 * underneath the toolbar. `dvh` is the height that is actually there right now. The unit reads as a
 * reasonable default and is wrong on the devices most of this site's traffic arrives on, which is exactly the
 * kind of mistake a grep can catch and a review does not: nobody looks at `100vh` twice.
 *
 * Counted in every scanned file, tests included, because a test that asserted a layout against `100vh` would
 * be asserting the defect. `100dvh`, `100svh` and `100lvh` are all left alone — the ban is on the static
 * unit, not on viewport units.
 *
 * **13. `css-rule-must-have-a-block`.** A selector followed by a declaration with no `{` between them.
 * That is not a typo anybody makes by hand — it is what a **destructive reformat of a template literal**
 * leaves behind, and this rule exists because it happened. `biome check --write` was run on
 * `packages/ui/src/patterns/therapist-card.tsx` while the file had a parse error elsewhere in it (a backtick
 * inside a CSS comment, which ends the template literal early); Biome's error-recovery parse read the CSS as
 * JavaScript labels and reprinted it without its braces, and three `@container` rules became declarations
 * belonging to nothing. Nothing failed. The stylesheet still shipped, the class names were all still there,
 * `pnpm colours` and rules 1-12 had nothing to say, and the card simply stopped changing shape at 260, 340
 * and 420px — which is a layout nobody looks at in three container sizes.
 *
 * The signature is narrow on purpose: a line whose first non-space character begins a selector (`.`, `#`,
 * `:` or `@`), which then contains `property: value;`, and which has no `{` on it at all. A brace-balance
 * count would be the obvious alternative and is worse here, because this project's CSS is assembled from
 * several template literals per file — `slot-picture.tsx` opens an `@media` in one and closes it in
 * another — so per-literal balance has false positives and whole-file balance lets a missing pair cancel out.
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

/** Where the motion system lives. The islands are the `.tsx` files directly inside it. */
const MOTION_DIRECTORY = 'packages/ui/src/motion/'

/** The one authored file that may carry the reduced-motion override: the token stylesheet's emitter. */
const REDUCED_MOTION_SOURCE = 'packages/ui/src/tokens/scale.ts'

/** docs/08 §7: header condensation and below-fold reveal. Neither more nor fewer. */
const SCROLL_DRIVEN_EFFECTS = 2

/** The animation library docs/08 §7 budgets at two islands, installed or not. */
const MOTION_LIBRARY = /^(motion|framer-motion)(\/|$)/

const REDUCED_MOTION_QUERY = /prefers-reduced-motion/i
const ANIMATION_TIMELINE_DECLARATION = /(^|[;{\s])animation-timeline\s*:/gi
/** `'use client'` or `"use client"`, as the first statement. A directive anywhere else is a string. */
const USE_CLIENT_DIRECTIVE = /^\s*(?:['"]use client['"])/
/** `from '…'` and a bare `import '…'`; the capture is the specifier. */
const STATIC_IMPORT = /(?:^|[\n;])\s*import\s+(?:[^'"\n]*?from\s*)?['"]([^'"]+)['"]/g
/** `import('…')` — including the `next/dynamic` spelling, which is what an island is reached by. */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

const RTL_SELECTOR = /\[dir\s*=\s*['"]?rtl['"]?\]|:dir\(\s*rtl\s*\)/i
const DARK_SCOPE = /\[data-theme\s*=\s*['"]?dark['"]?\]|prefers-color-scheme\s*:\s*dark/i
const ANIMATION_DECLARATION = /(^|[;{\s])animation(-name)?\s*:/i
const MEDIA_WIDTH_QUERY = /@media[^{;]*\(\s*(min|max)-width/i
/**
 * The static viewport height, and nothing else.
 *
 * Global, so every occurrence in a file is reported rather than the first — a stylesheet that used the unit
 * once used it three times. `100dvh`, `100svh` and `100lvh` do not contain the substring at all, so they need
 * no exception. The lookbehind keeps `1100vh` and `x.100vh` out and deliberately lets `calc(-100vh)` in: a
 * negative static viewport height is the same unit and the same defect.
 */
const STATIC_VIEWPORT_HEIGHT = /(?<![\w.])100vh\b/gi
/**
 * A selector and a declaration on one line with no block between them. Rule 13.
 *
 * Anchored at the start of a line and requiring the whole line to be selector-then-declaration, so a
 * declaration inside a block (which begins with a property name, not with `.`, `#`, `:` or `@`) cannot match,
 * and neither can any line carrying a `{`.
 */
const CSS_RULE_WITHOUT_BLOCK = /^[ \t]*[.#:@][^{};\n]*?[ \t]+[-\w]+[ \t]*:[ \t]*[^;{}\n]+;[ \t]*$/gm
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

/**
 * A file the repository generates. Its `prefers-reduced-motion` is the authored one, emitted.
 *
 * Judged against the **raw** text, not the scanned text: the marker is in a comment, and this scanner
 * blanks comments before it looks at anything. Reading the stripped copy reported `tokens/tokens.css` as a
 * second authored reduced-motion block on the first run of this rule.
 *
 * A hand-edit to a generated stylesheet is `pnpm tokens`' failure to report, not this one's — it compares
 * the committed file against a fresh emit and fails on any difference at all.
 */
function isGenerated(file, raw) {
  return file.includes('.generated.') || /GENERATED/.test(raw.slice(0, 400))
}

/** A test ships nowhere, and one of them asserts the emitted reduced-motion block by reading it. */
function isTest(file) {
  return /\.(test|itest)\.[tj]sx?$/.test(file)
}

/** The path a specifier points at, reduced to what identifies an island: `motion/<name>`. */
function motionSpecifier(specifier) {
  const match = /(?:^|\/)motion\/([a-z0-9-]+)(?:\.tsx?)?$/.exec(specifier)
  return match?.[1]
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

/** Rules 7-11 are about the tree rather than about one file, so the scan collects and then judges. */
const reducedMotionFiles = []
const scrollDrivenEffects = []
const islands = new Map()
const staticIslandImports = []
const libraryImports = []

for (const root of ROOTS) {
  try {
    statSync(root)
  } catch {
    continue
  }

  for (const file of walk(root)) {
    // Comments blanked, strings kept: the CSS this gate polices lives inside template literals, and a
    // rule explained in its own doc comment must not be reported as a violation of itself.
    const raw = readFileSync(file, 'utf8')
    const text = stripNonCode(raw, { lineComments: !file.endsWith('.css') })
    const blocks = blocksOf(text)
    const overlay = OVERLAY_NAME.test(basename(file))
    scanned += 1

    const relative = file.replaceAll('\\', '/')

    /*
     * Rules 7-11 skip tests and generated files, and both exemptions are load-bearing.
     *
     * A test ships nowhere, so nothing in one is an effect on the site — and two of them have to *write*
     * the things these rules forbid in order to check them: `tokens/scale.test.ts` reads the emitted
     * reduced-motion block back, and `apps/web/src/motion.itest.ts` injects
     * `animation-timeline: auto` to simulate a browser that has no scroll timelines, which is the only
     * way to drive the fallback in a browser that does. Counting either as a third scroll-driven effect
     * reported the motion system as over budget for writing its own tests.
     *
     * A generated stylesheet is the authored one, emitted. `pnpm tokens` fails on any difference at all
     * between the committed copy and a fresh emit, so a hand-edit there is caught by the gate that owns it.
     */
    if (!isTest(relative)) {
      // Rule 7 — the reduced-motion override, in one authored place.
      if (REDUCED_MOTION_QUERY.test(text) && !isGenerated(relative, raw)) {
        reducedMotionFiles.push(
          `${relative}:${lineAt(text, REDUCED_MOTION_QUERY.exec(text)?.index ?? 0)}`,
        )
      }

      // Rule 8 — every `animation-timeline` declaration, with the selector it is in.
      for (const match of text.matchAll(ANIMATION_TIMELINE_DECLARATION)) {
        const [innermost] = enclosing(blocks, match.index)
        scrollDrivenEffects.push({
          at: `${relative}:${lineAt(text, match.index)}`,
          selector: innermost?.prelude ?? '(top level)',
        })
      }

      // Rules 9-11 — the islands, who imports them, and who imports the library.
      if (relative.startsWith(MOTION_DIRECTORY) && relative.endsWith('.tsx')) {
        islands.set(relative, { useClient: USE_CLIENT_DIRECTIVE.test(text) })
      }
      for (const match of text.matchAll(STATIC_IMPORT)) {
        const specifier = match[1] ?? ''
        // An island importing its sibling is how `reveal.tsx` reaches `observe.ts`; the rule is about who
        // reaches an island from outside the motion system. Which of those a specifier names is decided
        // after the walk, against the islands that were actually found — `@berelax/ui/motion/bootstrap` is
        // a pure module the document shell legitimately imports, and a rule matching the directory rather
        // than the island would have forbidden it.
        const named = motionSpecifier(specifier)
        if (named !== undefined && !relative.startsWith(MOTION_DIRECTORY)) {
          staticIslandImports.push({
            at: `${relative}:${lineAt(text, match.index)}`,
            specifier,
            named,
          })
        }
        if (MOTION_LIBRARY.test(specifier)) {
          libraryImports.push({
            at: `${relative}:${lineAt(text, match.index)}`,
            file: relative,
            specifier,
          })
        }
      }
      // A dynamic import of the *library* is still the library. Only an island may reach it, however it
      // is spelled; what may be dynamic is the island itself.
      for (const match of text.matchAll(DYNAMIC_IMPORT)) {
        const specifier = match[1] ?? ''
        if (MOTION_LIBRARY.test(specifier)) {
          libraryImports.push({
            at: `${relative}:${lineAt(text, match.index)}`,
            file: relative,
            specifier,
          })
        }
      }
    }

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

    // Rule 12 — the static viewport height, anywhere in either root.
    for (const match of text.matchAll(STATIC_VIEWPORT_HEIGHT)) {
      violations.push(
        `${file}:${lineAt(text, match.index)}  [viewport-height-must-be-dynamic] '${match[0]}' — ` +
          'docs/09 §3: "100dvh never 100vh". vh is the LARGE viewport height, so on a phone this is ' +
          "taller than the visible area for as long as the browser's own toolbar is showing, and " +
          'whatever is at the bottom of the element — on a booking flow, the primary action — is ' +
          'underneath it. Use dvh.',
      )
    }

    // Rule 13 — a selector and a declaration with no block between them.
    for (const match of text.matchAll(CSS_RULE_WITHOUT_BLOCK)) {
      violations.push(
        `${file}:${lineAt(text, match.index)}  [css-rule-must-have-a-block] '${match[0].trim()}' — a ` +
          'selector followed by a declaration with no braces. This is what a destructive reformat of a ' +
          'template literal leaves behind, and it is silent: the stylesheet still ships and the rule ' +
          'simply does nothing. See rule 13.',
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

// Rule 7. One authored file, and it is the token emitter — not "at most one", because zero means the
// override was deleted and every component's movement is back on for a reader who asked for none.
if (reducedMotionFiles.length !== 1 || !reducedMotionFiles[0]?.startsWith(REDUCED_MOTION_SOURCE)) {
  violations.push(
    `[reduced-motion-belongs-to-the-token-layer] prefers-reduced-motion is authored in ` +
      `${reducedMotionFiles.length} file(s) — ${reducedMotionFiles.join(', ') || 'none'} — and docs/08 ` +
      `§5 puts it in exactly one, ${REDUCED_MOTION_SOURCE}, as a token override. A second block is a ` +
      'per-component branch, which is the design where each component decides for itself and the ones ' +
      'that get it wrong are invisible because nobody reviews with the setting on.',
  )
}

// Rule 8. Exactly two, and both in the motion stylesheet where they can be counted.
if (scrollDrivenEffects.length !== SCROLL_DRIVEN_EFFECTS) {
  violations.push(
    `[at-most-two-scroll-driven-effects] ${scrollDrivenEffects.length} animation-timeline ` +
      `declaration(s), and docs/08 §7 says exactly ${SCROLL_DRIVEN_EFFECTS} — header condensation and ` +
      `the below-fold reveal: ${scrollDrivenEffects.map((effect) => `${effect.at} (${effect.selector})`).join('; ') || 'none'}`,
  )
}
for (const effect of scrollDrivenEffects) {
  if (effect.at.startsWith(MOTION_DIRECTORY)) continue
  violations.push(
    `${effect.at}  [at-most-two-scroll-driven-effects] a scroll-driven animation outside ` +
      `${MOTION_DIRECTORY} — the two this site has are counted, and a rule can only be counted where it ` +
      'is expected to be',
  )
}

// Rule 9. Every island carries the directive, and nothing imports one statically.
for (const [island, { useClient }] of islands) {
  if (useClient) continue
  violations.push(
    `${island}  [motion-island-must-be-a-dynamic-client-module] no 'use client' directive — a motion ` +
      'island runs in the browser by definition, and without the directive it is a server component ' +
      'whose effects never run',
  )
}
/** The islands by the name a specifier carries: `reveal.tsx` is imported as `…/motion/reveal`. */
const islandNames = new Set(
  [...islands.keys()].map((island) => basename(island).replace(/\.tsx$/, '')),
)
for (const { at, specifier, named } of staticIslandImports) {
  if (!islandNames.has(named)) continue
  violations.push(
    `${at}  [motion-island-must-be-a-dynamic-client-module] static import of '${specifier}' — an island ` +
      "reached statically is in the importer's chunk, which is the one thing splitting it was for. Use " +
      "dynamic(() => import('…')).",
  )
}

// Rule 10.
if (islands.size > 2) {
  violations.push(
    `[at-most-two-motion-islands] ${islands.size} islands in ${MOTION_DIRECTORY} — ` +
      `${[...islands.keys()].join(', ')}. docs/08 §7 allows two, and build/budgets.json measures the ` +
      'ones it declares.',
  )
}

// Rule 11.
for (const { at, file, specifier } of libraryImports) {
  if (file.startsWith(MOTION_DIRECTORY) && file.endsWith('.tsx')) continue
  violations.push(
    `${at}  [motion-library-only-in-a-client-island] imports '${specifier}', which is 32-36KB gzip. ` +
      `docs/08 §7 allows it in at most two code-split islands under ${MOTION_DIRECTORY} and never in ` +
      'the shared layout; everything else on this site animates in CSS, which costs nothing.',
  )
}

if (violations.length > 0) {
  console.error('Layout, motion and elevation violations:\n')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(`\n${violations.length} violation(s).`)
  process.exit(1)
}

console.log(
  `Layout rules hold across ${scanned} source files: one animation per direction pair, no page ` +
    'breakpoint in a container component, no static viewport height, every CSS rule has a block, ' +
    'one shadow and none in the dark, one reduced-motion override, ' +
    `${scrollDrivenEffects.length} scroll-driven effects (${scrollDrivenEffects
      .map((effect) => effect.selector)
      .join(', ')}) and ${islands.size} dynamically imported motion island(s).`,
)
