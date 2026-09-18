import { readFileSync } from 'node:fs'
import { TYPE_SCALE } from '@berelax/ui'
import { describe, expect, it } from 'vitest'

/**
 * The Tailwind type ramp has to be the scale in `scale.ts`, not Tailwind's.
 *
 * Tailwind v4 ships `--text-base: 1rem`. Ours is 1.0625rem, and the whole ramp is built on that
 * decision (docs/08 §3). If the defaults are not cleared, `text-base` silently means 16px, every
 * heading below it is proportionally wrong, and `TYPE_SCALE` becomes a document nobody reads — a
 * failure with no symptom other than the design being slightly off everywhere.
 *
 * Read from the authored stylesheet rather than from a rendered page: a unit test is the cheapest place
 * to catch a value that drifted, and the rendered check belongs to the integration suite, which asserts
 * the *effect* (`--color-red-500` absent, our tokens present).
 */
const CSS = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')

function declaredValue(name: string): string | undefined {
  const match = CSS.match(new RegExp(`^\\s*${name.replace('*', '\\*')}\\s*:\\s*([^;]+);`, 'm'))
  return match?.[1]?.trim()
}

describe('the Tailwind type ramp is our type ramp', () => {
  it('clears the namespace before redefining it', () => {
    // Without this, every Tailwind default survives alongside ours and the two disagree.
    expect(declaredValue('--text-*')).toBe('initial')
  })

  for (const [step, definition] of Object.entries(TYPE_SCALE)) {
    it(`maps text-${step} to the scale's own size and leading`, () => {
      expect(declaredValue(`--text-${step}`)).toBe(definition.size)
      expect(declaredValue(`--text-${step}--line-height`)).toBe(definition.leading)
      const tracking = 'tracking' in definition ? definition.tracking : undefined
      expect(declaredValue(`--text-${step}--letter-spacing`)).toBe(tracking)
    })
  }

  it('maps every step the scale declares, and no step it does not', () => {
    const declared = [...CSS.matchAll(/^\s*--text-([a-z0-9]+):/gm)].map((match) => match[1])
    expect(new Set(declared)).toEqual(new Set(Object.keys(TYPE_SCALE)))
  })
})
