import { describe, expect, it } from 'vitest'
import {
  STAGGER_MAX_CHILDREN,
  STAGGER_STEP_LARGE_MS,
  STAGGER_STEP_SMALL_MS,
  STAGGER_TOTAL_CAP_MS,
  staggerChildVars,
  staggerContainerVars,
  staggerDelayMs,
  staggerFor,
} from './stagger.ts'

/** The delay the last child of a group waits — which is what the 240ms cap is about. */
function totalDelay(count: number): number {
  return staggerDelayMs(count - 1, count)
}

describe('acceptance — the stagger', () => {
  it('steps 40ms at six siblings and 24ms at ten', () => {
    expect(staggerFor(6)).toEqual({ delayMs: STAGGER_STEP_SMALL_MS, animateChildren: true })
    expect(staggerFor(10)).toEqual({ delayMs: STAGGER_STEP_LARGE_MS, animateChildren: true })
  })

  it('keeps the total under 240ms at both of those counts', () => {
    expect(totalDelay(6)).toBe(200)
    expect(totalDelay(10)).toBe(216)
    expect(totalDelay(6)).toBeLessThanOrEqual(STAGGER_TOTAL_CAP_MS)
    expect(totalDelay(10)).toBeLessThanOrEqual(STAGGER_TOTAL_CAP_MS)
  })

  it('keeps the total under 240ms at every count that animates', () => {
    for (let count = 1; count <= STAGGER_MAX_CHILDREN; count += 1) {
      expect(staggerFor(count).animateChildren, `${count} siblings`).toBe(true)
      expect(totalDelay(count), `${count} siblings`).toBeLessThanOrEqual(STAGGER_TOTAL_CAP_MS)
    }
  })

  it('stops animating children above twelve siblings', () => {
    // A thirty-row list staggered at any interval is a progress bar nobody asked for.
    expect(staggerFor(13)).toEqual({ delayMs: 0, animateChildren: false })
    expect(staggerFor(200).animateChildren).toBe(false)
    for (const index of [0, 5, 199]) expect(staggerDelayMs(index, 200)).toBe(0)
  })

  it('gives each child index its own delay below the cliff', () => {
    expect([0, 1, 2, 3, 4, 5].map((index) => staggerDelayMs(index, 6))).toEqual([
      0, 40, 80, 120, 160, 200,
    ])
  })
})

describe('the cap is the binding constraint where docs/08 §5 disagrees with itself', () => {
  it('reduces the step at twelve siblings rather than overrunning', () => {
    // Twelve at the documented 24ms step would finish arriving 264ms after the first — over the stated
    // total. The step gives way, because the total is what a reader perceives.
    expect(STAGGER_STEP_LARGE_MS * (12 - 1)).toBeGreaterThan(STAGGER_TOTAL_CAP_MS)
    expect(staggerFor(12).delayMs).toBe(21)
    expect(totalDelay(12)).toBe(231)
  })

  it('does not reduce the step where the cap does not bite', () => {
    // The control. A cap applied by dividing 240 by the *count* rather than by the gaps would quietly
    // shrink every step — 20ms at twelve, and 40ms at six only by coincidence — and this assertion is
    // what tells the two implementations apart at seven through eleven.
    for (const count of [7, 8, 9, 10, 11]) {
      expect(staggerFor(count).delayMs, `${count} siblings`).toBe(STAGGER_STEP_LARGE_MS)
    }
    expect(staggerFor(2).delayMs).toBe(STAGGER_STEP_SMALL_MS)
  })
})

describe('the custom properties the CSS multiplies', () => {
  it('publishes a unitless scale on the container and an index on each child', () => {
    expect(staggerContainerVars(6)).toEqual({ '--stagger-scale': '1' })
    expect(staggerChildVars(3, 6)).toEqual({ '--stagger-index': '3' })
    expect(staggerContainerVars(10)).toEqual({ '--stagger-scale': '0.6' })
    expect(staggerContainerVars(12)).toEqual({ '--stagger-scale': '0.525' })
  })

  it('never publishes a time, so the container cannot shadow the token', () => {
    // The defect this shape exists to prevent, and it was real: an inline `--stagger: 24ms` on the
    // container overrides the value on `:root`, so the reduced-motion override — which sets exactly that
    // property to `0ms` — never reaches the children. Every delay stayed where it was for a reader who
    // asked for no motion, and nothing about the numbers looked wrong.
    for (const count of [1, 6, 7, 10, 12]) {
      for (const value of Object.values(staggerContainerVars(count))) {
        expect(value, `${count} siblings`).not.toMatch(/m?s$/)
      }
    }
    // And the scale reproduces the step the helper decided, against the base step in the token layer.
    for (const count of [1, 6, 7, 10, 11, 12]) {
      const scale = Number(staggerContainerVars(count)['--stagger-scale'])
      expect(scale * STAGGER_STEP_SMALL_MS, `${count} siblings`).toBe(staggerFor(count).delayMs)
    }
  })

  it('publishes nothing at all above the cliff', () => {
    // No index means the `calc()` in motion/tokens.css falls back to 0 and every delay is zero. And no
    // scale on the container, because a factor nobody multiplies is a number somebody will later read as
    // the delay in force.
    expect(staggerContainerVars(13)).toEqual({})
    expect(staggerChildVars(0, 13)).toEqual({})
    expect(staggerChildVars(12, 13)).toEqual({})
  })
})
