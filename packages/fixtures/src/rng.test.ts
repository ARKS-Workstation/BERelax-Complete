import { describe, expect, it } from 'vitest'
import { createRng } from './rng.ts'

describe('createRng', () => {
  it('produces the same sequence from the same seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    const take = (rng: ReturnType<typeof createRng>) => Array.from({ length: 50 }, () => rng.next())
    expect(take(a)).toEqual(take(b))
  })

  it('produces a different sequence from a different seed', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next())
  })

  it('stays inside [0, 1)', () => {
    const rng = createRng(7)
    for (let index = 0; index < 5_000; index += 1) {
      const value = rng.next()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('returns integers inclusive at both ends', () => {
    const rng = createRng(11)
    const seen = new Set<number>()
    for (let index = 0; index < 2_000; index += 1) seen.add(rng.int(3, 6))
    expect([...seen].sort()).toEqual([3, 4, 5, 6])
  })

  it('rejects a reversed range rather than silently returning something', () => {
    expect(() => createRng(1).int(5, 2)).toThrow()
  })

  it('shuffles without losing or duplicating an element', () => {
    const input = Array.from({ length: 30 }, (_, index) => index)
    const shuffled = createRng(3).shuffle(input)
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input)
    expect(shuffled).not.toEqual(input)
  })

  it('does not mutate the array it shuffles', () => {
    const input = [1, 2, 3, 4, 5]
    createRng(9).shuffle(input)
    expect(input).toEqual([1, 2, 3, 4, 5])
  })

  it('forks independent streams, so one part of the fixture cannot shift another', () => {
    // This is the property that keeps the fixture stable under edits. If everything drew from one
    // sequence, adding a therapist would shift every appointment and the whole gallery would diff.
    const base = createRng(100)
    const appointmentsBefore = Array.from({ length: 5 }, () => base.fork('appointments').next())
    const other = createRng(100)
    other.fork('therapists').int(0, 1000)
    const appointmentsAfter = Array.from({ length: 5 }, () => other.fork('appointments').next())
    expect(appointmentsAfter).toEqual(appointmentsBefore)
  })

  it('gives different labels different streams', () => {
    const rng = createRng(100)
    expect(rng.fork('a').next()).not.toBe(rng.fork('b').next())
  })
})
