import { describe, expect, it } from 'vitest'
import {
  BREAKPOINTS,
  durationForDistance,
  GUTTERS,
  MEASURE,
  RADIUS,
  SPACE,
  scaleCss,
  staggerFor,
  TOUCH_TARGET,
} from './scale.ts'

describe('durationForDistance', () => {
  it('matches the four worked examples in docs/08', () => {
    expect(durationForDistance(8)).toBe(125)
    expect(durationForDistance(100)).toBe(180)
    expect(durationForDistance(400)).toBe(360)
    expect(durationForDistance(900)).toBe(480)
  })

  it('clamps at both ends, so nothing is abrupt and nothing crawls', () => {
    expect(durationForDistance(0)).toBe(120)
    expect(durationForDistance(-50)).toBe(120)
    expect(durationForDistance(10_000)).toBe(480)
  })

  it('is monotonic', () => {
    let previous = 0
    for (let distance = 0; distance <= 1200; distance += 37) {
      const current = durationForDistance(distance)
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
    }
  })
})

describe('staggerFor', () => {
  it('never lets the total stagger exceed 240ms', () => {
    for (let count = 1; count <= 12; count += 1) {
      const { delayMs, animateChildren } = staggerFor(count)
      expect(animateChildren).toBe(true)
      expect(delayMs * count).toBeLessThanOrEqual(240)
    }
  })

  it('stops animating children above twelve siblings', () => {
    // A list of thirty rows staggered at any interval is a progress bar nobody asked for.
    expect(staggerFor(13)).toEqual({ delayMs: 0, animateChildren: false })
    expect(staggerFor(200).animateChildren).toBe(false)
  })
})

describe('scales', () => {
  it('keeps the spacing ramp strictly increasing', () => {
    for (let index = 1; index < SPACE.length; index += 1) {
      expect(SPACE[index] ?? 0).toBeGreaterThan(SPACE[index - 1] ?? 0)
    }
  })

  it('keeps breakpoints and gutters strictly increasing together', () => {
    const widths = Object.values(BREAKPOINTS)
    const gutters = Object.values(GUTTERS)
    expect([...widths].sort((a, b) => a - b)).toEqual(widths)
    expect([...gutters].sort((a, b) => a - b)).toEqual(gutters)
  })

  it('caps the measure above every named measure', () => {
    const { max, ...named } = MEASURE
    for (const value of Object.values(named)) expect(value).toBeLessThanOrEqual(max)
  })

  it('makes the mobile touch target larger than the desktop one', () => {
    expect(TOUCH_TARGET.mobile).toBeGreaterThan(TOUCH_TARGET.desktop)
    expect(TOUCH_TARGET.mobile).toBeGreaterThanOrEqual(48)
  })
})

describe('scaleCss', () => {
  const css = scaleCss()

  it('publishes the whole spacing ramp and every radius', () => {
    SPACE.forEach((value, index) => {
      expect(css).toContain(`--space-${index}: ${value}px;`)
    })
    for (const [key, value] of Object.entries(RADIUS)) {
      expect(css).toContain(`--radius-${key}: ${value};`)
    }
  })

  it('zeroes movement under reduced motion but keeps a non-zero cross-fade', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(block).toContain('--move-lg: 0px;')
    expect(block).toContain('--stagger: 0ms;')
    // Opacity cross-fades survive: removing them makes state changes harder to follow, not easier.
    expect(block).toContain('--dur-base: 120ms;')
  })

  it('lets a reader override reduced motion, rather than deciding for them', () => {
    expect(css).toContain(':root:not([data-motion="full"])')
  })

  it('carries the RTL direction multiplier, so no animation is authored twice', () => {
    expect(css).toContain('--dir: 1;')
    expect(css).toContain('[dir="rtl"] {')
    expect(css).toContain('--dir: -1;')
  })

  it('widens the gutter at every breakpoint above the floor', () => {
    expect(css).toContain(`--gutter: ${GUTTERS.xs}px;`)
    expect(css).toContain(`@media (min-width: ${BREAKPOINTS.md}px)`)
    expect(css).toContain(`--gutter: ${GUTTERS.md}px;`)
  })
})
