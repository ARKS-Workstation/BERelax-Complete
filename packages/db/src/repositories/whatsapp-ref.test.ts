import { WHATSAPP_REF_ALPHABET, WHATSAPP_REF_CODE_PATTERN } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { mintWhatsappRefCode, WHATSAPP_REF_MINT_ATTEMPTS } from './whatsapp-ref.ts'

/**
 * A-FIRST-07 — the generator, over 100,000 codes.
 *
 * ## Why a hundred thousand and not a hundred
 *
 * Three of the four claims this file makes are STATISTICAL, and a small sample cannot distinguish them
 * from their failures:
 *
 *   - **The excluded characters.** Six of thirty-six are excluded, so a generator that admitted one would
 *     produce it about once every six codes — a hundred draws would catch that. This is the cheap claim.
 *   - **Not sequential, not time-ordered.** A counter, a timestamp encoding, or any generator with a
 *     direction in it produces draws that ascend almost always. Over a small sample "about half ascend" is
 *     indistinguishable from chance; over 100,000 it is 10 standard deviations from anything with a
 *     direction in it. This is the claim the sample size is FOR, and it is the one that matters, because a
 *     time-ordered code is a code whose neighbours can be guessed from one that was shown — and guessing a
 *     code attributes a booking to somebody else's conversation.
 *   - **Spread across the space.** A generator that drew the same character in a position, or that used a
 *     fraction of the alphabet, would still pass the first two. 100,000 draws from a 810,000-code space
 *     have a distinct count the birthday problem predicts to within a fraction of a per cent, so the floor
 *     below is a measurement rather than a guess.
 *
 * ## Where the forced collision is proved
 *
 * `packages/fixtures/src/ref-loop.itest.ts`. "A forced collision inside the TTL window is rejected by a
 * unique index and retried" is a claim about `whatsapp_ref.ref_code`'s primary key and about
 * `issueWhatsappRef`'s `on conflict do nothing` loop, and neither exists outside a real PostgreSQL. The
 * number this file pins is the retry BUDGET, so the two halves meet on one constant.
 *
 * ## Why the timeout is explicit
 *
 * `vitest.config.ts` declares no `testTimeout`, so every test inherits 5,000 ms (brief rule 21). 100,000
 * draws is 400,000 `randomInt` calls, which is about a second alone and several on a loaded machine while
 * three other worktrees are running suites. 30,000 ms, and the comment is the reason.
 */

/** 100,000 codes, drawn once and shared by every assertion below so the draw is not paid for four times. */
const DRAWS = 100_000
const drawn: string[] = []
for (let index = 0; index < DRAWS; index += 1) drawn.push(mintWhatsappRefCode())

describe('mintWhatsappRefCode — over 100,000 codes', () => {
  it('draws only from the unambiguous alphabet, and never an excluded character', () => {
    const permitted = new Set(WHATSAPP_REF_ALPHABET)
    // Named one by one rather than derived from the alphabet, which is the point: a test that checked
    // "every character is in WHATSAPP_REF_ALPHABET" would still pass if somebody put `U` back into the
    // alphabet. The acceptance line names six characters, so the six are named.
    ;['I', 'L', 'O', 'U', '0', '1'].forEach((excluded) => {
      expect(permitted.has(excluded), `${excluded} must not be in the alphabet`).toBe(false)
    })
    const seen = new Set<string>()
    for (const code of drawn) {
      expect(WHATSAPP_REF_CODE_PATTERN.test(code), code).toBe(true)
      for (const character of code) seen.add(character)
    }
    // Every character of the alphabet actually appeared, which is the non-vacuity control in the other
    // direction: a generator stuck on a subset would satisfy every assertion above.
    expect([...seen].sort().join('')).toBe([...WHATSAPP_REF_ALPHABET].sort().join(''))
  }, 30_000)

  it('is not sequential and not time-ordered', () => {
    let ascending = 0
    for (let index = 1; index < drawn.length; index += 1) {
      const previous = drawn[index - 1] ?? ''
      const current = drawn[index] ?? ''
      if (current > previous) ascending += 1
    }
    const pairs = drawn.length - 1
    const share = ascending / pairs
    /*
        A counter or a timestamp prefix gives a share of essentially 1; a descending one gives 0. The
        measured share of a uniform draw is 0.5 with a standard deviation of sqrt(0.25/99,999) = 0.0016, so
        the window below is ±30 standard deviations — wide enough that this cannot be a flake, and narrow
        enough that anything with a direction in it is nowhere near it.

        A WINDOW and not a point, because "exactly half" is not a property of randomness and asserting it
        would be its own flake.
      */
    expect(share, `${ascending} of ${pairs} adjacent pairs ascend`).toBeGreaterThan(0.45)
    expect(share).toBeLessThan(0.55)
    // And no run of ten in order anywhere, which is what a generator that was MOSTLY random and
    // occasionally sequential would leave behind — the shape a counter used as a fallback produces.
    let run = 1
    let longest = 1
    for (let index = 1; index < drawn.length; index += 1) {
      run = (drawn[index] ?? '') > (drawn[index - 1] ?? '') ? run + 1 : 1
      longest = Math.max(longest, run)
    }
    // 100,000 uniform draws give a longest ascending run of about 15 on average and essentially never
    // reach 40; a generator with a direction gives 100,000.
    expect(longest, 'longest ascending run').toBeLessThan(40)
  }, 30_000)

  it('spreads across the code space, with the collision count the space predicts', () => {
    const distinct = new Set(drawn).size
    /*
        The space is 30^4 = 810,000. The expected number of distinct values in 100,000 draws with
        replacement is 810,000 x (1 - (1 - 1/810,000)^100,000) = 94,135, so about 5,865 draws collide.

        Both bounds are stated, and the UPPER one is the interesting half: a generator that somehow
        produced no collisions at all would be drawing without replacement, which means it is keeping state
        — and a generator with state is a generator whose next output depends on its last, which is the
        thing the previous test rules out from the other side.
      */
    expect(distinct, 'distinct codes').toBeGreaterThan(93_000)
    expect(distinct, 'distinct codes').toBeLessThan(95_500)
  }, 30_000)

  it('keeps the retry budget the integration suite forces a collision against', () => {
    // One number, two suites: this is the budget `ref-loop.itest.ts` exhausts to prove the unique index
    // refuses a duplicate and the loop gives up rather than changing the shape of the key.
    expect(WHATSAPP_REF_MINT_ATTEMPTS).toBe(8)
  })
})
