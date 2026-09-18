/**
 * A seeded pseudo-random generator, because `Math.random()` makes a fixture unreviewable.
 *
 * Every number in the fixture salon comes from here. That is what makes two runs produce
 * byte-identical data, which is in turn what makes a screenshot diff mean something: without it,
 * every capture differs and the visual-regression gate is noise.
 *
 * `mulberry32` — thirty-two bits of state, four operations, no dependency. It is not
 * cryptographically anything, and it does not need to be: the requirement is *reproducible*, not
 * unpredictable. Its period is 2^32, which is several orders of magnitude more numbers than a
 * fixture salon consumes.
 *
 * Pure in the sense that matters: no clock, no environment, no global state. Two generators made
 * with the same seed produce the same sequence on any machine, forever.
 */

/** A generator. Stateful by nature, but its state is entirely determined by its seed. */
export interface Rng {
  /** The next value in [0, 1). */
  next(): number
  /** An integer in [min, max], inclusive at both ends. */
  int(min: number, max: number): number
  /** True with the given probability. */
  chance(probability: number): boolean
  /** An element of a non-empty array. */
  pick<T>(items: readonly T[]): T
  /** A shuffled copy. Fisher-Yates, so every permutation is equally likely. */
  shuffle<T>(items: readonly T[]): T[]
  /** A fresh generator derived from this one, for an independent stream. */
  fork(label: string): Rng
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a, so a label becomes a stable seed offset on every machine. */
function hashLabel(label: string): number {
  let value = 0x811c9dc5
  for (let index = 0; index < label.length; index += 1) {
    value ^= label.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed)

  const rng: Rng = {
    next,

    int(min: number, max: number): number {
      if (max < min) throw new Error(`int(${min}, ${max}): max is below min`)
      return min + Math.floor(next() * (max - min + 1))
    },

    chance(probability: number): boolean {
      return next() < probability
    },

    pick<T>(items: readonly T[]): T {
      const item = items[rng.int(0, items.length - 1)]
      if (item === undefined) throw new Error('pick() on an empty array')
      return item
    },

    shuffle<T>(items: readonly T[]): T[] {
      const copy = [...items]
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const target = rng.int(0, index)
        const a = copy[index]
        const b = copy[target]
        if (a !== undefined && b !== undefined) {
          copy[index] = b
          copy[target] = a
        }
      }
      return copy
    },

    /**
     * An independent stream, named.
     *
     * This is what keeps the fixture stable under edits. If every value came from one sequence,
     * adding a therapist would shift every appointment, every package and every invoice that follows
     * it — and the whole screenshot gallery would diff on a one-line change. A named fork means the
     * appointment stream is unaffected by anything the therapist stream does.
     */
    fork(label: string): Rng {
      return createRng((seed ^ hashLabel(label)) >>> 0)
    },
  }

  return rng
}
