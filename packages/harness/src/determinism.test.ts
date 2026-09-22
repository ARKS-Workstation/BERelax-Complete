import { describe, expect, it } from 'vitest'
import { captureUntilStable } from './determinism.ts'

/**
 * `captureUntilStable`'s three failure modes, each proved to be reported as itself.
 *
 * The helper exists because "capture one equals capture two" smuggles in a second claim — that paint had
 * settled by the first capture — which is false under load. But the first version of its failure message
 * made the opposite mistake: it asserted "a clock, a random id or an unsettled animation is reaching the
 * render — this is not load" for *every* failure. That is right for captures that all differ and wrong for
 * a page that alternates between two renderings, which is what actually happened: three agents hit it at
 * light-390 under seven-way load, byte lengths reading 4810752, 4733516, 4810752, 4733516, 4810752. The one
 * cause the message ruled out was the condition that exposed it.
 *
 * A diagnostic that names the wrong cause is worse than one that names none, because it sends the next
 * reader looking in the wrong place with confidence. So each branch has a test.
 */

/** A capture source that yields the given payloads in order, then repeats the last one. */
function sequence(payloads: readonly (string | { readonly png: string; readonly note: string })[]) {
  let index = 0
  return async () => {
    const payload = payloads[Math.min(index, payloads.length - 1)]
    index += 1
    if (payload === undefined) throw new Error('empty sequence')
    if (typeof payload === 'string') return new TextEncoder().encode(payload)
    return { png: new TextEncoder().encode(payload.png), note: payload.note }
  }
}

describe('captureUntilStable', () => {
  it('returns as soon as two consecutive captures agree', async () => {
    const stable = await captureUntilStable(sequence(['a', 'b', 'b']), { label: 'settles' })
    expect(stable.attemptsUsed).toBe(3)
    expect(new TextDecoder().decode(stable.png)).toBe('b')
  })

  it('accepts a bare Uint8Array as well as a Capture, so existing callers keep working', async () => {
    const bare = await captureUntilStable(sequence(['x', 'x']), { label: 'bare' })
    const wrapped = await captureUntilStable(
      sequence([
        { png: 'x', note: 'all images loaded' },
        { png: 'x', note: 'all images loaded' },
      ]),
      { label: 'wrapped' },
    )
    expect(new TextDecoder().decode(bare.png)).toBe('x')
    expect(new TextDecoder().decode(wrapped.png)).toBe('x')
  })

  /**
   * The branch the original message got wrong. A B A B A can never satisfy a consecutive-match rule, so
   * more attempts is not the answer, and the report must not blame a clock.
   */
  it('names alternation as two stable states, and does not blame a clock', async () => {
    const failure = await captureUntilStable(sequence(['a', 'b', 'a', 'b', 'a']), {
      label: 'light-390',
    }).catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
    expect(failure).toContain('[screenshot-never-stabilised] light-390')
    expect(failure).toContain('ALTERNATE between exactly two renderings')
    expect(failure).toContain('load can be what exposes it')
    expect(failure).not.toContain('This one is not load')
  })

  /** And the opposite branch, which is the one the original message was written for. */
  it('names all-different captures as something reaching the render', async () => {
    const failure = await captureUntilStable(sequence(['a', 'b', 'c', 'd', 'e']), {
      label: 'clocked',
    }).catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
    expect(failure).toContain('every capture differed')
    expect(failure).toContain('This one is not load')
    expect(failure).not.toContain('ALTERNATE')
  })

  /**
   * The case the notes exist for: the settle step swallows a decode rejection on purpose, because a broken
   * frame is a legitimate fixture on some pages — so it cannot tell "broken by design" from "broken this
   * time". When the note changes between attempts, the page changed and the render is not the suspect.
   */
  it('blames the page, not the render, when the note changes between captures', async () => {
    const failure = await captureUntilStable(
      // Five, not four: `sequence` repeats its last payload once exhausted, so a four-element alternation
      // would match itself on the fifth attempt and resolve. The first version of this test did exactly
      // that and reported the helper as passing when it had not been exercised at all.
      sequence([
        { png: 'a', note: 'images failed: none' },
        { png: 'b', note: 'images failed: hero-828.avif' },
        { png: 'a', note: 'images failed: none' },
        { png: 'b', note: 'images failed: hero-828.avif' },
        { png: 'a', note: 'images failed: none' },
      ]),
      { label: 'light-390' },
    ).catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
    expect(failure).toContain('the page itself changed between captures')
    expect(failure).toContain('hero-828.avif')
    // The note explanation must win over the alternation one: both are true of this sequence, and only the
    // note says what to fix.
    expect(failure).not.toContain('ALTERNATE')
  })

  it('reports byte lengths and digests, so a reader can see the shape without rerunning', async () => {
    const failure = await captureUntilStable(sequence(['aa', 'bbbb', 'aa', 'bbbb', 'aa']), {
      label: 'shape',
    }).catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
    expect(failure).toContain('Byte lengths: 2, 4, 2, 4, 2')
    expect(failure).toMatch(/Digests: [0-9a-f]{12}, [0-9a-f]{12}/)
  })

  it('refuses an attempt count that cannot compare anything', async () => {
    await expect(
      captureUntilStable(sequence(['a']), { label: 'one', attempts: 1 }),
    ).rejects.toThrow(/at least 2 attempts/)
  })

  /**
   * Equal byte lengths are not equal bytes, and the helper must not treat them as such — a page that
   * changes one pixel keeps its length. Digests are what the alternation test reads for that reason.
   */
  it('does not mistake equal lengths for equal content', async () => {
    const failure = await captureUntilStable(sequence(['ab', 'ba', 'ab', 'ba', 'ab']), {
      label: 'same-length',
    }).catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
    expect(failure).toContain('ALTERNATE')
    expect(failure).toContain('Byte lengths: 2, 2, 2, 2, 2')
  })
})
