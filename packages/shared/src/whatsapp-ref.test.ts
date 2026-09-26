import { describe, expect, it } from 'vitest'
import {
  isWhatsappRefCode,
  normaliseWhatsappRefCode,
  WHATSAPP_REF_ALPHABET,
  WHATSAPP_REF_CODE_CLASS,
  WHATSAPP_REF_CODE_HTML_PATTERN,
  WHATSAPP_REF_CODE_LENGTH,
  WHATSAPP_REF_CODE_PATTERN,
  whatsappRefCodeSchema,
} from './whatsapp-ref.ts'

/**
 * B-UI-04 — the code shape, and the two things about it that a reader will assume are the same and are not.
 *
 * The alphabet is written out as a string and the character class as ranges, which is two spellings of one
 * set. The first test here is what makes the second spelling true rather than plausible — a hand-written
 * `A-HJ-NP-Z2-9` that quietly re-admitted `O` would be invisible in review and would then be accepted by
 * the page, stored by the column, and read off a screen as a zero.
 */

describe('the character class and the alphabet describe the same set', () => {
  it('admits every character in the alphabet and nothing outside it', () => {
    const single = new RegExp(`^[${WHATSAPP_REF_CODE_CLASS}]$`)
    // Every printable ASCII character, so the claim is about the whole space rather than about the
    // handful of look-alikes somebody thought of.
    const admitted: string[] = []
    for (let code = 32; code < 127; code += 1) {
      const character = String.fromCharCode(code)
      if (single.test(character)) admitted.push(character)
    }
    expect(admitted.join('')).toBe([...WHATSAPP_REF_ALPHABET].sort().join(''))
    // And the four look-alikes are named, so the exclusion cannot be lost by widening a range: if
    // `A-HJ-NP-Z` ever became `A-Z` the assertion above fails, and this one says which characters it is
    // about.
    for (const confusable of ['I', 'O', '0', '1']) {
      expect(single.test(confusable), `${confusable} must not be in a ref code`).toBe(false)
    }
  })

  it('is the same rule in the canonical RegExp and in Zod', () => {
    for (const value of ['AB23', 'ZZZZ', '2345', 'AI23', 'AO23', 'AB2', 'AB234', '', 'ab23']) {
      const bySource = WHATSAPP_REF_CODE_PATTERN.test(value)
      expect(whatsappRefCodeSchema.safeParse(value).success, `${value}: Zod`).toBe(bySource)
    }
    // The control on the loop: the list really does contain both answers, so a pattern that matched
    // everything or nothing could not satisfy it.
    expect(WHATSAPP_REF_CODE_PATTERN.test('AB23')).toBe(true)
    expect(WHATSAPP_REF_CODE_PATTERN.test('AI23')).toBe(false)
    // And lower case is NOT canonical: it is what a field accepts and the normaliser folds, never what is
    // stored. A stored code in two cases is a code that does not join to itself.
    expect(WHATSAPP_REF_CODE_PATTERN.test('ab23')).toBe(false)
  })

  it('accepts in the FIELD exactly what the normaliser can make canonical', () => {
    /*
      The property that makes two spellings safe rather than merely different, and it is the one that was
      missing when the field's pattern was the canonical class: an HTML `pattern` is case sensitive, so `qb34`
      was refused by the browser with its own validation bubble, no request was made, and the page silently
      did nothing.

      Asserted over the whole input class rather than over a pair of examples: every value the field admits
      must normalise to a value the COLUMN admits, and nothing the field rejects may normalise to one either —
      the second half is what stops the field being widened to something the column then refuses.
    */
    const fromHtml = new RegExp(`^${WHATSAPP_REF_CODE_HTML_PATTERN}$`)
    let admitted = 0
    let rejected = 0
    // Every two-character combination of the printable ASCII range, doubled to four characters. Exhaustive
    // over the pairs, which covers every character of the class in both positions.
    for (let first = 32; first < 127; first += 1) {
      for (let second = 32; second < 127; second += 1) {
        const value = `${String.fromCharCode(first)}${String.fromCharCode(second)}${String.fromCharCode(first)}${String.fromCharCode(second)}`
        const canonical = normaliseWhatsappRefCode(value)
        if (fromHtml.test(value)) {
          admitted += 1
          expect(canonical, `${value} is admitted by the field`).not.toBeNull()
          expect(WHATSAPP_REF_CODE_PATTERN.test(canonical ?? ''), `${value} normalises`).toBe(true)
        } else {
          rejected += 1
          expect(canonical, `${value} is refused by the field but normalises`).toBeNull()
        }
      }
    }
    // Non-vacuity, both ways: 32 canonical characters plus 24 lower-case letters is 56 admissible characters,
    // so 56 x 56 = 3,136 of the 9,025 pairs are admitted. Stated exactly, because a class that quietly lost
    // its lower-case half would still satisfy every assertion in the loop.
    expect(admitted).toBe(3_136)
    expect(rejected).toBe(9_025 - 3_136)
  })

  it('is exactly WHATSAPP_REF_CODE_LENGTH characters', () => {
    expect(WHATSAPP_REF_CODE_LENGTH).toBe(4)
    const shortest = 'A'.repeat(WHATSAPP_REF_CODE_LENGTH - 1)
    const longest = 'A'.repeat(WHATSAPP_REF_CODE_LENGTH + 1)
    expect(WHATSAPP_REF_CODE_PATTERN.test('A'.repeat(WHATSAPP_REF_CODE_LENGTH))).toBe(true)
    expect(WHATSAPP_REF_CODE_PATTERN.test(shortest)).toBe(false)
    expect(WHATSAPP_REF_CODE_PATTERN.test(longest)).toBe(false)
  })
})

describe('normalisation folds case and whitespace, and folds nothing else', () => {
  it('accepts what the desk actually types', () => {
    expect(normaliseWhatsappRefCode('ab23')).toBe('AB23')
    expect(normaliseWhatsappRefCode('  ab23  ')).toBe('AB23')
    expect(normaliseWhatsappRefCode('AB23')).toBe('AB23')
    expect(isWhatsappRefCode(' Ab23 ')).toBe(true)
  })

  it('does NOT fold a zero onto an O or a one onto an I, which is the attribution rule', () => {
    // The whole point. `0` and `1` cannot be in a real code, so folding them would land on a code that
    // belongs to a DIFFERENT conversation and produce a confident wrong attribution. Refusing to fold
    // produces `unknown_code`, which is a visible warning and an honestly unknown attribution.
    expect(normaliseWhatsappRefCode('AB2O')).toBeNull()
    expect(normaliseWhatsappRefCode('AB20')).toBeNull()
    expect(normaliseWhatsappRefCode('IB23')).toBeNull()
    expect(normaliseWhatsappRefCode('1B23')).toBeNull()
  })

  it('answers null for blank and for malformed alike, because neither is a code', () => {
    expect(normaliseWhatsappRefCode('')).toBeNull()
    expect(normaliseWhatsappRefCode('   ')).toBeNull()
    expect(normaliseWhatsappRefCode('AB')).toBeNull()
    expect(normaliseWhatsappRefCode('AB-23')).toBeNull()
  })

  it('does not strip inner separators or truncate, so a paste is not silently repaired', () => {
    // Trimming the ends is reading what was typed; removing a character from the middle, or dropping one off
    // the end, is guessing at it. The operator sees the warning and retypes, which is four keystrokes and no
    // wrong join.
    expect(normaliseWhatsappRefCode('AB 23')).toBeNull()
    expect(normaliseWhatsappRefCode('AB-23')).toBeNull()
    /*
      THE load-bearing one, and it is the assertion the gate case for this rule mutates.

      `AB234` truncated to four characters is `AB23`, which is a real code belonging to a DIFFERENT
      conversation — so a truncating normaliser produces a confident wrong attribution where refusing to
      repair produces an honest unknown. It is also the likeliest paste to arrive: one character too many.

      The `0`-onto-`O` and `1`-onto-`I` assertions above are cheap by comparison and worth saying so: `O` and
      `I` are excluded from the alphabet as well, so a fold onto them lands on a value the pattern refuses
      anyway. They document the intent; this one is the one that can actually go wrong.
    */
    expect(normaliseWhatsappRefCode('AB234')).toBeNull()
    expect(normaliseWhatsappRefCode('AB23X')).toBeNull()
  })
})
