import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The generated fallbacks, parsed rather than trusted.
 *
 * `scripts/emit-font-metrics.mjs` measures three numbers per face and writes them here. All three have
 * to be present for the mechanism to work: `size-adjust` alone matches the advance width and leaves the
 * line box wrong, and the two overrides alone match the line box and leave every line a different
 * length. A face added to the script's `PAIRINGS` without all three produces a file that looks correct,
 * passes the staleness gate — the gate compares the file to the script's own output, so it agrees with
 * whatever the script wrote — and reflows the page on swap anyway.
 *
 * So this reads what was actually emitted. The gate proves the file is current; this proves current is
 * enough.
 */
const CSS = readFileSync(new URL('./font-fallbacks.generated.css', import.meta.url), 'utf8')

interface Face {
  readonly family: string
  readonly declarations: ReadonlyMap<string, string>
}

function parseFaces(css: string): Face[] {
  const faces: Face[] = []
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const declarations = new Map<string, string>()
    for (const line of (match[1] ?? '').split(';')) {
      const colon = line.indexOf(':')
      if (colon === -1) continue
      declarations.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
    }
    const family = declarations.get('font-family') ?? ''
    faces.push({ family: family.replace(/^['"]|['"]$/g, ''), declarations })
  }
  return faces
}

const FACES = parseFaces(CSS)
const REQUIRED = ['size-adjust', 'ascent-override', 'descent-override'] as const

describe('the metric-matched fallbacks', () => {
  it('declares one face per web font, and the file is not empty', () => {
    // Four pairings in the script. An empty file would satisfy every `for` loop below.
    expect(FACES.length).toBe(4)
    expect(FACES.map((face) => face.family).sort()).toEqual([
      'Cormorant Garamond Fallback',
      'IBM Plex Sans Arabic Fallback',
      'IBM Plex Sans Fallback',
      'Jost Fallback',
    ])
  })

  for (const property of REQUIRED) {
    it(`declares ${property} on every face`, () => {
      for (const face of FACES) {
        expect(face.declarations.get(property), face.family).toMatch(/^\d+(\.\d+)?%$/)
      }
    })
  }

  it('declares a local source, so the fallback is a font the device already has', () => {
    for (const face of FACES) {
      expect(face.declarations.get('src'), face.family).toMatch(/^local\('[^']+'\)$/)
    }
  })

  it('zeroes the line gap, which is the third contributor to line box height', () => {
    for (const face of FACES) {
      expect(face.declarations.get('line-gap-override'), face.family).toBe('0%')
    }
  })

  it('emits plausible ratios rather than a placeholder repeated four times', () => {
    // A measurement that silently failed would write the same number everywhere, or 100% everywhere.
    const adjustments = FACES.map((face) => face.declarations.get('size-adjust'))
    expect(new Set(adjustments).size).toBeGreaterThan(1)
    for (const face of FACES) {
      const value = Number.parseFloat(face.declarations.get('size-adjust') ?? '0')
      expect(value, face.family).toBeGreaterThan(50)
      expect(value, face.family).toBeLessThan(200)
    }
  })
})
