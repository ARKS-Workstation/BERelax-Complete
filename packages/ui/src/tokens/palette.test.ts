import { describe, expect, it } from 'vitest'
import {
  contrastOf,
  DARK_PALETTE,
  DECORATIVE_ONLY_TOKENS,
  LIGHT_PALETTE,
  mayCarryText,
  PALETTE_RATIOS,
  paletteCss,
  TEXT_BEARING_TOKENS,
} from './palette.ts'

/**
 * These assert the *contract* of the palette, not the hex values — `scripts/palette.py` re-derives
 * and re-measures every value on each CI run, and duplicating its arithmetic here would only create
 * a second thing to keep in sync. What is worth asserting in TypeScript is what the script cannot
 * see: that the classification is complete, that no token is in both halves of it, and that a token
 * declared able to carry text actually meets the ratio that claim depends on.
 */

describe('classification', () => {
  it('assigns every light token to exactly one of text-bearing or decorative', () => {
    const all = Object.keys(LIGHT_PALETTE).sort()
    const classified = [...TEXT_BEARING_TOKENS, ...DECORATIVE_ONLY_TOKENS].sort()
    expect(classified).toEqual(all)
  })

  it('puts no token in both halves', () => {
    const overlap = TEXT_BEARING_TOKENS.filter((token) => DECORATIVE_ONLY_TOKENS.includes(token))
    expect(overlap).toEqual([])
  })

  it('fences off the brand gold, which is the whole reason the classification exists', () => {
    // #C08A43 measures 2.90:1 in light mode: below the 4.5:1 body threshold and below the 3:1
    // threshold for user-interface components. It is the brand, and it cannot carry information.
    expect(LIGHT_PALETTE['decor-gold']).toBe('#C08A43')
    expect(mayCarryText('decor-gold')).toBe(false)
    expect(contrastOf('light', 'decor-gold')).toBeLessThan(3)
  })

  it('offers a gold that can carry text, so the fence is not simply a loss', () => {
    expect(mayCarryText('accent-gold')).toBe(true)
    expect(contrastOf('light', 'accent-gold') ?? 0).toBeGreaterThanOrEqual(4.5)
  })

  it('flips accent polarity: the same brand gold is the primary accent in dark mode', () => {
    expect(DARK_PALETTE['accent-gold']).toBe('#C08A43')
    expect(contrastOf('dark', 'accent-gold') ?? 0).toBeGreaterThanOrEqual(4.5)
  })
})

describe('every text-bearing token meets the ratio its role claims', () => {
  // ink-3 and border-strong are the large-text and UI-component tokens, at 3:1 rather than 4.5:1.
  const LARGE_TEXT_OR_UI = new Set(['ink-3', 'border-strong', 'focus'])

  for (const token of TEXT_BEARING_TOKENS) {
    const required = LARGE_TEXT_OR_UI.has(token) ? 3 : 4.5
    it(`light --color-${token} reaches ${required}:1`, () => {
      expect(contrastOf('light', token) ?? 0).toBeGreaterThanOrEqual(required)
    })
  }

  for (const token of Object.keys(DARK_PALETTE)) {
    if (!mayCarryText(token)) continue
    const required = LARGE_TEXT_OR_UI.has(token) ? 3 : 4.5
    it(`dark --color-${token} reaches ${required}:1`, () => {
      expect(contrastOf('dark', token) ?? 0).toBeGreaterThanOrEqual(required)
    })
  }
})

describe('paletteCss', () => {
  const css = paletteCss()

  it('publishes every light token as a --color-* custom property', () => {
    for (const [token, value] of Object.entries(LIGHT_PALETTE)) {
      expect(css).toContain(`--color-${token}: ${value};`)
    }
  })

  it('serves dark mode twice: by system preference and by explicit choice', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css).toContain(':root[data-theme="dark"]')
  })

  it('lets an explicit light choice survive a dark system preference', () => {
    // Without the :not() guard, choosing light on a dark phone does nothing, because the media
    // query block would still win on specificity within the same cascade layer.
    expect(css).toContain(':root:not([data-theme="light"])')
  })

  it('declares color-scheme so form controls and scrollbars follow the theme', () => {
    expect(css).toContain('color-scheme: light dark;')
  })

  it('gives every dark token a value, so no token falls back to its light value in dark mode', () => {
    const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'))
    for (const token of Object.keys(DARK_PALETTE)) {
      expect(darkBlock).toContain(`--color-${token}:`)
    }
  })
})

describe('ratio table', () => {
  it('measures every token in both themes', () => {
    expect(Object.keys(PALETTE_RATIOS.light).sort()).toEqual(Object.keys(LIGHT_PALETTE).sort())
    expect(Object.keys(PALETTE_RATIOS.dark).sort()).toEqual(Object.keys(DARK_PALETTE).sort())
  })

  it('returns undefined for a token that does not exist, rather than a plausible number', () => {
    expect(contrastOf('light', 'not-a-token')).toBeUndefined()
  })
})
