import { describe, expect, it } from 'vitest'
import {
  contrastOf,
  contrastRatio,
  minimumFor,
  NON_TEXT_SURFACE_TOKENS,
  paletteFor,
  TEXT_BEARING_TOKENS,
  TEXT_SURFACE_TOKENS,
  type Theme,
  worstSurfaceContrastOf,
} from './palette.ts'

/**
 * Every text token is legible on every surface it may sit on — recomputed here, not taken on trust.
 *
 * `scripts/palette.py` derives the palette and measures it. This file measures it again, from the emitted
 * hexes, with a second implementation of the WCAG formula. That is the point: the Python gate could be
 * confidently wrong — it was, for months, because it measured every token against the page background and
 * nothing else. `--color-danger` in dark mode reads 4.53:1 on the ground and 3.69:1 on
 * `--color-surface-raised`; the gate printed the first number and reported PASS, and F11's acceptance line
 * "every text pair meets its stated ratio in both themes" was not what was being checked.
 *
 * The thresholds come from the generated module too (`PALETTE_MINIMUMS`), so this file restates neither the
 * colours nor the numbers they have to clear.
 */

const THEMES: readonly Theme[] = ['light', 'dark']

/** Every (text token, surface it may sit on) pair, per theme. */
function textPairs(theme: Theme): readonly {
  readonly token: string
  readonly surface: string
  readonly foreground: string
  readonly background: string
  readonly minimum: number
}[] {
  const palette = paletteFor(theme)
  const pairs: {
    token: string
    surface: string
    foreground: string
    background: string
    minimum: number
  }[] = []
  for (const token of TEXT_BEARING_TOKENS) {
    const minimum = minimumFor(theme, token)
    if (typeof minimum !== 'number') continue
    const foreground = palette[token]
    if (foreground === undefined) continue
    for (const surface of TEXT_SURFACE_TOKENS) {
      const background = palette[surface]
      if (background === undefined) continue
      pairs.push({ token, surface, foreground, background, minimum })
    }
  }
  return pairs
}

describe('palette contrast', () => {
  /**
   * The control, and it comes first. Every assertion below is a loop over pairs, and a loop over an empty
   * list passes — which is exactly how a check can look green while measuring nothing (ADR 0003).
   */
  it('has pairs to measure', () => {
    for (const theme of THEMES) {
      expect(textPairs(theme).length, theme).toBe(
        TEXT_BEARING_TOKENS.length * TEXT_SURFACE_TOKENS.length,
      )
    }
    expect(TEXT_BEARING_TOKENS.length).toBeGreaterThan(8)
    expect(TEXT_SURFACE_TOKENS.length).toBeGreaterThan(3)
  })

  it('meets every token minimum on every surface text may sit on', () => {
    const failures: string[] = []
    for (const theme of THEMES) {
      for (const pair of textPairs(theme)) {
        const measured = contrastRatio(pair.foreground, pair.background)
        if (measured + 0.005 < pair.minimum) {
          failures.push(
            `${theme} --color-${pair.token} (${pair.foreground}) on --color-${pair.surface} ` +
              `(${pair.background}) is ${measured.toFixed(2)}:1, needs ${pair.minimum}:1`,
          )
        }
      }
    }
    expect(failures).toEqual([])
  })

  /**
   * The two implementations have to agree. If this drifts, one of them has changed the formula — and the
   * Python side is the one that decides the hexes, so a disagreement means the emitted palette was derived
   * against a rule this side does not hold it to.
   */
  it('agrees with the derivation about the worst surface ratio', () => {
    for (const theme of THEMES) {
      const palette = paletteFor(theme)
      for (const token of Object.keys(palette)) {
        const emitted = worstSurfaceContrastOf(theme, token)
        expect(emitted, `${theme} ${token} has no emitted worst-surface ratio`).toBeTypeOf('number')
        const foreground = palette[token]
        if (foreground === undefined || typeof emitted !== 'number') continue
        const recomputed = Math.min(
          ...TEXT_SURFACE_TOKENS.map((surface) => {
            const background = palette[surface]
            return background === undefined
              ? Number.POSITIVE_INFINITY
              : contrastRatio(foreground, background)
          }),
        )
        expect(recomputed, `${theme} --color-${token}`).toBeCloseTo(emitted, 1)
      }
    }
  })

  /**
   * The ground can never be the worst surface, because it is one of the surfaces the minimum is taken over.
   * Stated as an assertion rather than left implicit: if `ground` were ever dropped from
   * `TEXT_SURFACE_TOKENS`, every other assertion here would still pass while the page background stopped
   * being checked at all.
   */
  it('takes the worst case over a set that includes the ground', () => {
    expect(TEXT_SURFACE_TOKENS).toContain('ground')
    for (const theme of THEMES) {
      for (const token of Object.keys(paletteFor(theme))) {
        const onGround = contrastOf(theme, token)
        const worst = worstSurfaceContrastOf(theme, token)
        if (typeof onGround !== 'number' || typeof worst !== 'number') continue
        expect(worst, `${theme} --color-${token}`).toBeLessThanOrEqual(onGround + 0.005)
      }
    }
  })

  /**
   * The clay exclusion has to be doing work.
   *
   * `surface-clay` is excluded because docs/08 section 3 says text never sits on it. If nothing would fail
   * on clay, the exclusion is dead configuration and should be deleted rather than explained — and if it is
   * silently deleted later, this is what notices.
   */
  it('excludes a surface that would otherwise change the answer', () => {
    expect(NON_TEXT_SURFACE_TOKENS).toEqual(['surface-clay'])
    const wouldFail: string[] = []
    for (const theme of THEMES) {
      const palette = paletteFor(theme)
      for (const token of TEXT_BEARING_TOKENS) {
        const minimum = minimumFor(theme, token)
        const foreground = palette[token]
        const clay = palette['surface-clay']
        if (typeof minimum !== 'number' || foreground === undefined || clay === undefined) continue
        if (contrastRatio(foreground, clay) < minimum) wouldFail.push(`${theme} ${token}`)
      }
    }
    expect(
      wouldFail.length,
      'nothing fails on clay, so excluding it changes nothing',
    ).toBeGreaterThan(0)
  })

  /**
   * And the control on the measurement itself: the decorative gold is in the palette precisely because it
   * cannot carry text, so it must measure below the body threshold on a real surface. If this ever passes
   * 4.5:1, `contrastRatio` is not computing what its name says.
   */
  it('measures a known-failing pairing as failing', () => {
    const light = paletteFor('light')
    const decor = light['decor-gold']
    const sand = light['surface-sand']
    expect(decor).toBeTypeOf('string')
    expect(sand).toBeTypeOf('string')
    if (decor === undefined || sand === undefined) return
    expect(contrastRatio(decor, sand)).toBeLessThan(4.5)
    expect(contrastRatio(decor, sand)).toBeGreaterThan(1)
  })

  /** White on white is 1:1 and black on white is 21:1 — the formula's two fixed points. */
  it('anchors on the two fixed points of the formula', () => {
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5)
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5)
  })

  it('refuses a colour that is not a six-digit hex', () => {
    expect(() => contrastRatio('#FFF', '#000000')).toThrow(/\[not-a-six-digit-hex\]/)
    expect(() => contrastRatio('rebeccapurple', '#000000')).toThrow(/\[not-a-six-digit-hex\]/)
  })
})
