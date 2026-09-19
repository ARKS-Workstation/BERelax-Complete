import { describe, expect, it } from 'vitest'
import { BREAKPOINTS, GUTTERS, MEASURE, RADIUS, SPACE, scaleCss, TOUCH_TARGET } from './scale.ts'

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
