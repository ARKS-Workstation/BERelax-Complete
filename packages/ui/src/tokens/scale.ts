/**
 * The non-colour tokens: space, radius, type, motion, layout.
 *
 * Hand-authored from docs/08 §3–§5, not derived, because nothing here is computed from anything
 * else — a spacing ramp is a decision. They live in TypeScript beside the palette so the emitted CSS
 * has one origin, and so a component can reference `SPACE[6]` rather than guessing at a pixel value.
 *
 * Pure: no I/O.
 */

/** 8px base. Index is the position on the ramp, not the pixel value. */
export const SPACE = [1, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128, 160, 192] as const

export const RADIUS = {
  /** Images, cards, inputs, chips. */
  '1': '2px',
  /** Buttons, selects. */
  '2': '8px',
  /** Dialog, bottom sheet. */
  '3': '16px',
  /** The sheet handle, and nothing else. */
  handle: '999px',
} as const

/** 360 is a floor, not a target: below it the booking flow is tested but not designed. */
export const BREAKPOINTS = { xs: 360, sm: 480, md: 768, lg: 1024, xl: 1280, xxl: 1600 } as const
export const GUTTERS = { xs: 20, sm: 24, md: 40, lg: 64, xl: 80 } as const
export const CONTAINER_MAX = 1360

/**
 * The type scale. `base` is 17px, which is the decision that matters — see docs/08 §3 on why the
 * marketing display face is not also the body face.
 */
export const TYPE_SCALE = {
  eyebrow: { size: '0.75rem', leading: '1.33', tracking: '0.08em' },
  xs: { size: '0.75rem', leading: '1.4' },
  sm: { size: '0.875rem', leading: '1.5' },
  base: { size: '1.0625rem', leading: '1.647' },
  lg: { size: '1.25rem', leading: '1.6' },
  xl: { size: '1.5rem', leading: '1.333', tracking: '-0.008em' },
  '2xl': { size: '1.875rem', leading: '1.267', tracking: '-0.012em' },
  '3xl': { size: 'clamp(2rem, 1.4rem + 2.2vw, 2.5rem)', leading: '1.15', tracking: '-0.016em' },
} as const

/** Measure caps in `ch`. A line longer than `max` is a readability bug, not a layout choice. */
export const MEASURE = { body: 68, lede: 56, h3: 40, h2: 34, h1: 26, display: 18, max: 76 } as const

export const DURATION = {
  /** Press, checkbox, focus ring. */
  instant: '90ms',
  /** Hover, colour change. */
  fast: '140ms',
  /** Tooltip, toast, chevron, number cross-fade. */
  base: '200ms',
  /** Accordion, sheet, dialog, page. */
  slow: '320ms',
  /** Below-fold media. */
  reveal: '500ms',
} as const

export const EASING = {
  /** Entrances. */
  'out-quiet': 'cubic-bezier(.22,1,.36,1)',
  /** Large reveals and sheets. */
  'out-soft': 'cubic-bezier(.16,1,.30,1)',
  /** Exits. */
  'in-quick': 'cubic-bezier(.40,0,1,1)',
  /** A-to-B movement. */
  calm: 'cubic-bezier(.45,0,.55,1)',
} as const

/** Movement distances, zeroed by the reduced-motion override rather than branched per component. */
export const MOVE = { sm: '8px', md: '16px', lg: '32px' } as const

/**
 * Distance-aware duration, in milliseconds.
 *
 * A 900px sheet and an 8px chevron animating for the same 200ms both feel wrong — one sluggish, one
 * abrupt. 8px gives 125ms, 400px gives 360ms, and everything is clamped so nothing crawls.
 */
export function durationForDistance(distancePx: number): number {
  return Math.round(Math.min(480, Math.max(120, 120 + 0.6 * distancePx)))
}

/**
 * Stagger delay per sibling, in milliseconds, and how many actually animate.
 *
 * Above twelve items the container animates once and the children do not: a list of thirty rows
 * staggered at any interval is a progress bar the reader did not ask for.
 */
export function staggerFor(count: number): { delayMs: number; animateChildren: boolean } {
  if (count > 12) return { delayMs: 0, animateChildren: false }
  const delayMs = count <= 6 ? 40 : 24
  // Total stagger is capped at 240ms however many siblings there are.
  return { delayMs: Math.min(delayMs, Math.floor(240 / Math.max(1, count))), animateChildren: true }
}

/** Minimum touch target in pixels. Mobile is larger because a thumb is not a mouse. */
export const TOUCH_TARGET = { desktop: 40, mobile: 48, minGap: 8 } as const

function block(selector: string, lines: readonly string[]): string {
  return [`${selector} {`, ...lines.map((line) => `  ${line}`), '}'].join('\n')
}

/** The non-colour tokens as CSS custom properties. */
export function scaleCss(): string {
  const space = SPACE.map((value, index) => `--space-${index}: ${value}px;`)
  const radius = Object.entries(RADIUS).map(([key, value]) => `--radius-${key}: ${value};`)
  const duration = Object.entries(DURATION).map(([key, value]) => `--dur-${key}: ${value};`)
  const easing = Object.entries(EASING).map(([key, value]) => `--ease-${key}: ${value};`)
  const move = Object.entries(MOVE).map(([key, value]) => `--move-${key}: ${value};`)

  return [
    block(':root', [
      ...space,
      ...radius,
      ...duration,
      ...easing,
      ...move,
      '--stagger: 40ms;',
      '--dur-ambient: 12s;',
      `--container-max: ${CONTAINER_MAX}px;`,
      `--gutter: ${GUTTERS.xs}px;`,
      '/* Direction multiplier, so no animation is authored twice for RTL. */',
      '--dir: 1;',
    ]),
    '',
    block('[dir="rtl"]', ['--dir: -1;']),
    '',
    '/* Reduced motion as a token override. One change, whole system compliant. */',
    '@media (prefers-reduced-motion: reduce) {',
    block('  :root:not([data-motion="full"])', [
      '--dur-instant: 1ms;',
      '--dur-fast: 1ms;',
      '--dur-base: 120ms;',
      '--dur-slow: 120ms;',
      '--dur-reveal: 120ms;',
      '--dur-ambient: 0s;',
      '--move-sm: 0px;',
      '--move-md: 0px;',
      '--move-lg: 0px;',
      '--stagger: 0ms;',
    ])
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
      .trimStart(),
    '}',
    '',
    ...Object.entries(GUTTERS)
      .filter(([key]) => key !== 'xs')
      .map(([key, value]) =>
        [
          `@media (min-width: ${BREAKPOINTS[key as keyof typeof BREAKPOINTS]}px) {`,
          `  :root { --gutter: ${value}px; }`,
          '}',
        ].join('\n'),
      ),
  ].join('\n')
}
