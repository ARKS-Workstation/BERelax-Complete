/**
 * The touch-target audit: is every control big enough to hit, and far enough from its neighbours?
 *
 * docs/08 §4 states two numbers and they are the kind nobody checks: **48px on mobile, 40px on
 * desktop, and 8px minimum between targets.** A control that misses either is not a defect anybody
 * sees in code review — it is a mis-tap on somebody's phone at half past midnight, on the one page of
 * this site that exists to take a booking.
 *
 * ## Why size *and* gap
 *
 * Size alone passes a row of 48px buttons pressed against each other, where the edge of one is a
 * pixel from the edge of the next and a thumb lands between them. WCAG 2.2's 2.5.8 measures the
 * *undisturbed* area around a target for exactly this reason. Two rules, so a violation names which
 * of the two it is.
 *
 * ## Why it runs in the page
 *
 * A target's size is not in the stylesheet. It is `min-block-size` plus padding plus line-height plus
 * whatever the flex container did, and the only thing that knows the answer is the engine that laid it
 * out. So this is a function serialised into the browser, like `critiqueInPage`: self-contained, with
 * its inputs passed rather than closed over, and typed against `page-globals.ts` because the project's
 * `lib` has no DOM on purpose.
 *
 * Used by `scripts/check-touch-targets.mjs` (the gate, over static pages) and by
 * `apps/web/src/kitchen-sink.itest.ts` (the real route, in a real server). One implementation: a rule
 * proved on a fixture and applied to the product is worth more than two that drift.
 */
import { TOUCH_TARGET } from '@berelax/ui'
import type { HarnessElement, PageGlobalsForHarness } from './page-globals.ts'

/**
 * Everything a finger is expected to hit.
 *
 * `summary` is in the list because a disclosure is a control that does not look like one, and it is
 * the element most often left at its default 20px line box.
 */
export const TOUCH_TARGET_SELECTOR = 'a, button, [role="button"], input, select, summary'

export type TouchTargetRule = 'touch-target-too-small' | 'touch-target-gap'

export interface TouchTargetFinding {
  readonly rule: TouchTargetRule
  /** A CSS-ish path to the element, so a human can find it. */
  readonly where: string
  readonly detail: string
}

export interface TouchTargetInput {
  readonly selector: string
  /** The minimum box, in CSS pixels, in both axes. */
  readonly minSize: number
  /** The minimum undisturbed distance to the next target. */
  readonly minGap: number
}

/**
 * The floors for a viewport width.
 *
 * 768px is the same boundary `critiqueInputFor` uses: below it the pointer is a thumb. The numbers
 * themselves come from `TOUCH_TARGET` in `@berelax/ui`, so docs/08 §4 is written down once.
 */
export function touchTargetInputFor(viewportWidth: number): TouchTargetInput {
  return {
    selector: TOUCH_TARGET_SELECTOR,
    minSize: viewportWidth < 768 ? TOUCH_TARGET.mobile : TOUCH_TARGET.desktop,
    minGap: TOUCH_TARGET.minGap,
  }
}

/** Runs in the browser. Must not reference anything outside its own body. */
export function auditTouchTargetsInPage(input: TouchTargetInput): TouchTargetFinding[] {
  const globals = globalThis as unknown as PageGlobalsForHarness
  const { document, getComputedStyle } = globals
  const findings: TouchTargetFinding[] = []

  const describe = (element: HarnessElement): string => {
    const id = element.id === '' ? '' : `#${element.id}`
    const cls = element.className === '' ? '' : `.${String(element.className).split(/\s+/)[0]}`
    const text = (element.textContent ?? '').trim().slice(0, 18)
    return `${element.tagName.toLowerCase()}${id}${cls}${text === '' ? '' : ` "${text}"`}`
  }

  interface Box {
    readonly element: HarnessElement
    readonly left: number
    readonly top: number
    readonly right: number
    readonly bottom: number
    readonly width: number
    readonly height: number
  }

  const boxes: Box[] = []
  for (const element of document.querySelectorAll(input.selector)) {
    const rect = element.getBoundingClientRect()
    // A zero box is `display: none`, a detached node, or a hidden input. None of them is a target.
    if (rect.width === 0 || rect.height === 0) continue
    if (getComputedStyle(element).getPropertyValue('visibility') === 'hidden') continue
    boxes.push({
      element,
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
    })
  }

  for (const box of boxes) {
    // Rounded down: a 47.6px box that the engine paints as 48 is not what this rule is about, and a
    // subpixel failure on every control is a gate nobody keeps.
    const width = Math.floor(box.width + 0.01)
    const height = Math.floor(box.height + 0.01)
    if (width < input.minSize || height < input.minSize) {
      findings.push({
        rule: 'touch-target-too-small',
        where: describe(box.element),
        detail:
          `is ${width}x${height}px, under the ${input.minSize}x${input.minSize}px minimum — ` +
          'state the floor rather than arriving at a size through padding',
      })
    }
  }

  const contains = (ancestor: HarnessElement, node: HarnessElement): boolean => {
    let current: HarnessElement | null = node
    while (current !== null) {
      if (current === ancestor) return true
      current = current.parentElement
    }
    return false
  }

  for (const [index, a] of boxes.entries()) {
    // Each pair once, and only forwards: a gap is symmetric, and reporting it twice would make the
    // count of findings a function of the DOM order.
    for (const b of boxes.slice(index + 1)) {
      // A button inside a link is one target, not two neighbours a pixel apart.
      if (contains(a.element, b.element) || contains(b.element, a.element)) continue

      const horizontal = Math.max(a.left - b.right, b.left - a.right)
      const vertical = Math.max(a.top - b.bottom, b.top - a.bottom)
      // Overlap on one axis means the other axis carries the separation; overlap on both means the
      // targets overlap, and the gap is zero. Diagonal neighbours take the larger of the two, because
      // a thumb that misses both misses into empty space.
      const gap = Math.max(horizontal, vertical, 0)
      if (gap >= input.minGap) continue
      findings.push({
        rule: 'touch-target-gap',
        where: describe(a.element),
        detail:
          `sits ${gap.toFixed(1)}px from ${describe(b.element)}, under the ${input.minGap}px ` +
          'minimum — a thumb lands between them',
      })
    }
  }

  return findings
}

/** Findings deduplicated across several renders, sorted so output is stable. */
export function uniqueTouchTargetFindings(
  findings: readonly TouchTargetFinding[],
): TouchTargetFinding[] {
  const seen = new Map<string, TouchTargetFinding>()
  for (const finding of findings) {
    const key = `${finding.rule}|${finding.where}|${finding.detail}`
    if (!seen.has(key)) seen.set(key, finding)
  }
  return [...seen.values()].sort((a, b) =>
    a.rule === b.rule ? (a.where < b.where ? -1 : 1) : a.rule < b.rule ? -1 : 1,
  )
}
