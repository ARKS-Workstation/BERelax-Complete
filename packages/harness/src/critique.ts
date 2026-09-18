/**
 * The self-critique pass.
 *
 * docs/12 §5: *screenshots are a feedback signal, not just evidence.* Without this, unattended work
 * produces a site that passes every test and looks wrong — because "wrong" here means body text on a
 * pastel, a measure running to 110 characters, a 40px tap target on a phone, an RTL page that was
 * translated but not mirrored. None of those fail a unit test. All of them are visible in a second.
 *
 * ## Why it reads the DOM rather than the pixels
 *
 * A pixel diff says *something changed*. It cannot say *this is wrong*, and it cannot say it the
 * first time a page is ever rendered — which is exactly when it matters, because there is no baseline
 * to diff against yet.
 *
 * Reading computed styles and geometry gives the opposite: no baseline needed, and findings that name
 * the element and the rule. The two are complementary, and this is the half that catches a defect
 * that has been there since the first commit.
 *
 * ## Why the rules are the ones they are
 *
 * Each maps to a line in docs/08 that would otherwise be a sentence nobody re-reads. The contrast
 * rule is the sharpest: `--color-decor-gold` measures 2.90:1, and a pastel surface under body text is
 * the single most likely way this palette gets misused, because it looks lovely and is unreadable.
 */
import type { Direction, Theme, Viewport } from './matrix.ts'
import type { HarnessElement, PageGlobalsForHarness } from './page-globals.ts'

export type CritiqueSeverity = 'defect' | 'warning'

export interface Finding {
  readonly rule: string
  readonly severity: CritiqueSeverity
  /** A CSS-ish path to the element, so a human can find it. */
  readonly where: string
  readonly detail: string
}

export interface CritiqueContext {
  readonly page: string
  readonly viewport: Viewport
  readonly theme: Theme
  readonly direction: Direction
}

export interface CritiqueResult extends CritiqueContext {
  readonly findings: readonly Finding[]
}

/** Minimum contrast for body text, and for a component boundary, per WCAG 2.2. */
export const BODY_TEXT_RATIO = 4.5
export const UI_COMPONENT_RATIO = 3
/** docs/08 §4: 48px on mobile, 40px elsewhere. */
export const TOUCH_TARGET_MOBILE = 48
export const TOUCH_TARGET_DESKTOP = 40
/** docs/08 §3: 76ch is the hard maximum, not a suggestion. */
export const MAX_MEASURE_CH = 76

/**
 * The rules, as a function serialised into the page.
 *
 * It must be self-contained — it runs in the browser with no closure over this module — so the
 * contrast arithmetic is inlined rather than imported. That duplication is the price of running where
 * the computed styles are, and it is checked against `packages/ui` by a unit test.
 */
export function critiqueInPage(input: {
  isMobile: boolean
  maxMeasureCh: number
  bodyRatio: number
  uiRatio: number
  minTouch: number
}): Finding[] {
  const globals = globalThis as unknown as PageGlobalsForHarness
  const { document, getComputedStyle } = globals
  const findings: Finding[] = []

  const add = (rule: string, severity: CritiqueSeverity, where: string, detail: string): void => {
    findings.push({ rule, severity, where, detail })
  }

  const describe = (element: HarnessElement): string => {
    const id = element.id === '' ? '' : `#${element.id}`
    const cls = element.className === '' ? '' : `.${String(element.className).split(/\s+/)[0]}`
    return `${element.tagName.toLowerCase()}${id}${cls}`
  }

  // --- colour -----------------------------------------------------------------------------------

  const parseColour = (value: string): [number, number, number, number] | undefined => {
    const match = /rgba?\(([^)]+)\)/.exec(value)
    if (match?.[1] === undefined) return undefined
    const parts = match[1].split(/[\s,/]+/).filter((part) => part.length > 0)
    const r = Number(parts[0])
    const g = Number(parts[1])
    const b = Number(parts[2])
    const a = parts[3] === undefined ? 1 : Number(parts[3])
    if ([r, g, b].some((n) => Number.isNaN(n))) return undefined
    return [r, g, b, Number.isNaN(a) ? 1 : a]
  }

  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }

  const luminance = ([r, g, b]: [number, number, number, number]): number =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)

  const contrast = (
    fg: [number, number, number, number],
    bg: [number, number, number, number],
  ): number => {
    const a = luminance(fg)
    const b = luminance(bg)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }

  /** The nearest ancestor with a non-transparent background, which is what the text actually sits on. */
  const effectiveBackground = (
    element: HarnessElement,
  ): [number, number, number, number] | undefined => {
    let current: HarnessElement | null = element
    while (current !== null) {
      const colour = parseColour(getComputedStyle(current).getPropertyValue('background-color'))
      if (colour !== undefined && colour[3] > 0.95) return colour
      current = current.parentElement
    }
    return undefined
  }

  const TEXT_SELECTOR = 'p, li, td, th, dd, dt, h1, h2, h3, h4, h5, h6, a, button, label, span'

  for (const element of document.querySelectorAll(TEXT_SELECTOR)) {
    const text = (element.textContent ?? '').trim()
    if (text.length === 0) continue
    const style = getComputedStyle(element)
    const fg = parseColour(style.getPropertyValue('color'))
    const bg = effectiveBackground(element)
    if (fg === undefined || bg === undefined) continue

    const sizePx = Number.parseFloat(style.getPropertyValue('font-size'))
    const weight = Number.parseInt(style.getPropertyValue('font-weight'), 10)
    // WCAG "large text": 18.66px bold, or 24px at any weight.
    const large = sizePx >= 24 || (sizePx >= 18.66 && weight >= 700)
    const required = large ? input.uiRatio : input.bodyRatio
    const measured = contrast(fg, bg)

    if (measured < required) {
      add(
        'contrast',
        'defect',
        describe(element),
        `text measures ${measured.toFixed(2)}:1 against its background and needs ${required}:1` +
          ` — "${text.slice(0, 40)}"`,
      )
    }
  }

  // --- measure ----------------------------------------------------------------------------------

  for (const element of document.querySelectorAll('p, li, dd')) {
    const text = (element.textContent ?? '').trim()
    // Only long-form text has a measure; a two-word list item does not.
    if (text.length < 120) continue
    const style = getComputedStyle(element)
    const sizePx = Number.parseFloat(style.getPropertyValue('font-size'))
    if (Number.isNaN(sizePx) || sizePx <= 0) continue
    // A `ch` is the width of a zero. For a humanist sans it is very close to 0.5em, which is accurate
    // enough to catch a 110-character line and will not flag a 70-character one.
    const measureCh = element.getBoundingClientRect().width / (sizePx * 0.5)
    if (measureCh > input.maxMeasureCh) {
      add(
        'measure',
        'defect',
        describe(element),
        `line runs to about ${Math.round(measureCh)}ch, over the ${input.maxMeasureCh}ch maximum`,
      )
    }
  }

  // --- touch targets ----------------------------------------------------------------------------

  for (const element of document.querySelectorAll('a, button, input, select, [role="button"]')) {
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    // An inline link inside a paragraph is not a touch target in the sense the rule means.
    if (element.closest('p') !== null && element.tagName.toLowerCase() === 'a') continue
    if (rect.height < input.minTouch) {
      add(
        'touch-target',
        input.isMobile ? 'defect' : 'warning',
        describe(element),
        `is ${Math.round(rect.height)}px tall, under the ${input.minTouch}px minimum`,
      )
    }
  }

  // --- direction --------------------------------------------------------------------------------

  // A page that is translated but not mirrored is the classic RTL failure: the words are Arabic and
  // the layout is unchanged. Physical properties are how that happens.
  //
  // This reads the *authored* stylesheet rather than computed styles, and that distinction is the
  // whole rule. `getComputedStyle` resolves `padding-inline` to `padding-left`, so a computed-style
  // check cannot tell correct logical CSS from incorrect physical CSS — it flags both. The first
  // version of this rule did exactly that and produced 114 warnings, every one of them wrong.
  //
  // It runs in both directions, because the defect is in the stylesheet whichever way the page is
  // currently pointing.
  const PHYSICAL = /(^|[;{\s])(margin|padding|border)-(left|right)\s*:/g
  const OFFSET = /(^|[;{\s])(left|right)\s*:\s*(?!auto)/g
  for (const sheet of document.styleSheets) {
    let rules: ArrayLike<{ cssText: string }>
    try {
      rules = sheet.cssRules
    } catch {
      // A cross-origin stylesheet throws on access. Nothing this project ships is cross-origin, so
      // skipping is correct rather than a silent gap.
      continue
    }
    for (const rule of Array.from(rules)) {
      const text = rule.cssText
      // The determinism stylesheet the harness injects is not the page's to answer for.
      if (text.includes('caret-color: transparent')) continue
      for (const pattern of [PHYSICAL, OFFSET]) {
        pattern.lastIndex = 0
        const match = pattern.exec(text)
        if (match === null) continue
        const property = `${match[2]}${match[3] === undefined ? '' : `-${match[3]}`}`
        const logical = property.replace('left', 'inline-start').replace('right', 'inline-end')
        add(
          'rtl-physical-property',
          'warning',
          text.slice(0, text.indexOf('{')).trim() || 'rule',
          `uses the physical property ${property}. Use ${logical} so the layout mirrors rather than staying put`,
        )
        break
      }
    }
  }

  // --- theme ------------------------------------------------------------------------------------

  const groundColour = parseColour(
    getComputedStyle(document.body).getPropertyValue('background-color'),
  )
  if (groundColour !== undefined) {
    const [r, g, b] = groundColour
    const dark = luminance(groundColour) < 0.2
    if (dark) {
      // docs/08: the dark theme is warm, not inverted. A neutral or cool ground means somebody
      // inverted the light palette instead of using the derived one.
      const warm = r >= b
      if (!warm) {
        add(
          'dark-theme-warmth',
          'defect',
          'body',
          `dark ground is rgb(${r}, ${g}, ${b}), which is cooler than it is warm — the derived dark palette is warm`,
        )
      }
    }
  }

  return findings
}

/** Counts of each severity, for a summary line. */
export function summarise(results: readonly CritiqueResult[]): {
  defects: number
  warnings: number
  byRule: Record<string, number>
} {
  const byRule: Record<string, number> = {}
  let defects = 0
  let warnings = 0
  for (const result of results) {
    for (const finding of result.findings) {
      byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1
      if (finding.severity === 'defect') defects += 1
      else warnings += 1
    }
  }
  return { defects, warnings, byRule }
}

/** Findings deduplicated across the matrix — the same defect appears in all twelve captures. */
export function uniqueFindings(results: readonly CritiqueResult[]): Finding[] {
  const seen = new Map<string, Finding>()
  for (const result of results) {
    for (const finding of result.findings) {
      const key = `${finding.rule}|${finding.where}|${finding.detail}`
      if (!seen.has(key)) seen.set(key, finding)
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.rule === b.rule ? (a.where < b.where ? -1 : 1) : a.rule < b.rule ? -1 : 1,
  )
}

export const CRITIQUE_DEFAULTS = {
  maxMeasureCh: MAX_MEASURE_CH,
  bodyRatio: BODY_TEXT_RATIO,
  uiRatio: UI_COMPONENT_RATIO,
} as const

export function critiqueInputFor(viewport: Viewport) {
  return {
    ...CRITIQUE_DEFAULTS,
    isMobile: viewport.width < 768,
    minTouch: viewport.width < 768 ? TOUCH_TARGET_MOBILE : TOUCH_TARGET_DESKTOP,
  }
}
