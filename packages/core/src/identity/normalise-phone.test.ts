/**
 * Phone normalisation, and the collisions it is supposed to cause.
 *
 * Every table here pairs its accepted spellings with something that must be **rejected** or must
 * **not** collide. A normaliser tested only on the happy path passes just as happily when it returns
 * its input unchanged, and that version of this function splits one customer into four rows
 * (ADR 0014) with nothing anywhere reporting a fault.
 */
import { describe, expect, it } from 'vitest'
import {
  type E164,
  isAllocatedUaeMobile,
  nameMatchKey,
  normaliseNameForMatching,
  normalisePhoneResult,
  PHONE_MATCH_KEY_DIGITS,
  PHONE_REJECTIONS,
  phoneMatchKey,
  phoneTail,
  UAE_LANDLINE_AREA_CODES,
  UAE_MOBILE_PREFIXES,
} from './normalise-phone.ts'
// The throwing half moved to a sibling so the rule itself has no runtime dependency and can be
// imported by a browser bundle — see that module's header. The assertions below are unchanged.
import { normalisePhone, PhoneNormalisationError } from './phone-error.ts'

/**
 * The five spellings named in the unit's acceptance list, and three more that arrive in practice.
 *
 * The Arabic-Indic one is not decoration: the booking form exists in Arabic, and `٠٥٠` is what an
 * Arabic keyboard produces. The non-breaking-space one is what a number pasted out of WhatsApp looks
 * like — indistinguishable from the plain-space spelling on screen, and a different string.
 */
/**
 * The same number as it arrives pasted out of WhatsApp: non-breaking spaces throughout.
 *
 * Built from the codepoint rather than typed, because a literal U+00A0 in this file would be
 * invisible to the next person to read it — and a fixture nobody can see is a fixture nobody
 * maintains.
 */
const NON_BREAKING_SPACE = String.fromCodePoint(0x00a0)
const NON_BREAKING_SPELLING =
  `${NON_BREAKING_SPACE}+971${NON_BREAKING_SPACE}50${NON_BREAKING_SPACE}123` +
  `${NON_BREAKING_SPACE}4567${NON_BREAKING_SPACE}`

const ONE_NUMBER_MANY_SPELLINGS = [
  '0501234567',
  '+971501234567',
  '971 50 123 4567',
  '00971501234567',
  '+971 50 123 45 67',
  '050-123-4567',
  '(050) 123 4567',
  '٠٥٠١٢٣٤٥٦٧',
  NON_BREAKING_SPELLING,
] as const

const CANONICAL = '+971501234567'

describe('normalisePhone', () => {
  it.each(ONE_NUMBER_MANY_SPELLINGS)('maps %j to the one canonical E.164', (spelling) => {
    expect(normalisePhone(spelling)).toBe(CANONICAL)
  })

  it('collapses every spelling to exactly one distinct value', () => {
    const distinct = new Set(ONE_NUMBER_MANY_SPELLINGS.map((s) => normalisePhone(s)))
    expect(distinct.size).toBe(1)

    // The controls. A normaliser that returned a constant, or one that threw the subscriber digits
    // away, would satisfy the assertion above and merge two people into one customer record.
    expect(normalisePhone('0501234568')).not.toBe(CANONICAL)
    expect(normalisePhone('0521234567')).not.toBe(CANONICAL)
  })

  // Every allocated prefix, because the length rule and the prefix rule interact: `5` plus eight
  // digits is the shape, and a table over one prefix proves the shape for one prefix.
  it.each(UAE_MOBILE_PREFIXES)('accepts allocated mobile prefix 0%s', (prefix) => {
    expect(normalisePhone(`0${prefix} 123 4567`)).toBe(`+971${prefix}1234567`)
    expect(normalisePhone(`+971${prefix}1234567`)).toBe(`+971${prefix}1234567`)
    expect(isAllocatedUaeMobile(normalisePhone(`0${prefix}1234567`))).toBe(true)
  })

  /**
   * The synthetic prefix, which must normalise and must not be reported as allocated.
   *
   * `packages/fixtures` derives every fixture number from `59` because it is unallocated and therefore
   * undialable. A normaliser that rejected unallocated prefixes would reject the entire fixture
   * dataset; one that reported `59` as allocated would make `assertSynthetic` meaningless.
   */
  it('normalises the unallocated fixture prefix without calling it allocated', () => {
    const fixtureNumber = normalisePhone('059 000 0042')
    expect(fixtureNumber).toBe('+971590000042')
    expect(isAllocatedUaeMobile(fixtureNumber)).toBe(false)
  })

  it.each(UAE_LANDLINE_AREA_CODES)(
    'rejects landline area code 0%s as an OTP target, by name',
    (areaCode) => {
      const landline = `0${areaCode} 123 4567`
      expect(normalisePhoneResult(landline)).toEqual({
        ok: false,
        reason: 'landline_not_an_sms_target',
      })
      // Internationally spelled, because that is how a landline reaches the API from a paste.
      expect(normalisePhoneResult(`+971${areaCode}1234567`).ok).toBe(false)
    },
  )

  it('throws a named error for a landline, carrying the reason as a value', () => {
    let caught: unknown
    try {
      normalisePhone('02 123 4567')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PhoneNormalisationError)
    expect((caught as PhoneNormalisationError).reason).toBe('landline_not_an_sms_target')
    expect((caught as PhoneNormalisationError).kind).toBe('validation')
    expect((caught as PhoneNormalisationError).details['reason']).toBe('landline_not_an_sms_target')
    // The control: the same call shape on a mobile must not throw, or the assertion above is only
    // proving that normalisePhone throws.
    expect(() => normalisePhone('052 123 4567')).not.toThrow()
  })

  it.each([
    ['', 'empty'],
    ['+', 'empty'],
    ['   ', 'empty'],
    ['not a number', 'not_digits'],
    ['05012345ab', 'not_digits'],
    ['+44 7700 900123', 'unsupported_country'],
    ['+966 50 123 4567', 'unsupported_country'],
    ['+9715012345678', 'wrong_length'],
    ['050 123 456', 'wrong_length'],
    ['5', 'wrong_length'],
    ['0800 4567', 'landline_not_an_sms_target'],
  ] as const)('rejects %j with reason %s', (input, reason) => {
    expect(normalisePhoneResult(input)).toEqual({ ok: false, reason })
  })

  it('reports only declared rejection reasons', () => {
    const inputs = ['', 'x', '+44 7700 900123', '050 123 456', '02 123 4567', '+9715012345678']
    for (const input of inputs) {
      const result = normalisePhoneResult(input)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(PHONE_REJECTIONS).toContain(result.reason)
    }
  })
})

describe('match keys', () => {
  it('gives every spelling of one number the same phone match key', () => {
    const keys = new Set(ONE_NUMBER_MANY_SPELLINGS.map((s) => phoneMatchKey(normalisePhone(s))))
    expect(keys).toEqual(new Set(['501234567']))
    expect([...keys][0]).toHaveLength(PHONE_MATCH_KEY_DIGITS)
  })

  it('keys a number written without its country code onto the same value', () => {
    // The reason the key is the trailing nine digits rather than the whole E.164: the merge C-CRM
    // owns reads rows imported from a paper diary, where the country code was never written down.
    const imported = '501234567'
    expect(phoneMatchKey(imported as E164)).toBe(phoneMatchKey(normalisePhone(CANONICAL)))
    // Control: a different subscriber must not share the key.
    expect(phoneMatchKey(normalisePhone('0501234568'))).not.toBe(phoneMatchKey(imported as E164))
  })

  it('exposes the last four digits and nothing more', () => {
    expect(phoneTail(normalisePhone(CANONICAL))).toBe('4567')
    expect(phoneTail(normalisePhone(CANONICAL))).not.toContain('971')
  })

  // Every expectation here is token-SORTED, which is why '0042' leads: the key exists to make two
  // orderings of the same words collide, and it cannot do that and stay displayable at the same time.
  it.each([
    ['Customer 0042', '0042 customer'],
    ['  customer   0042  ', '0042 customer'],
    ['CUSTOMER-0042', '0042 customer'],
    ['0042 Customer', '0042 customer'],
  ] as const)('normalises the record label %j for matching', (input, expected) => {
    expect(normaliseNameForMatching(input)).toBe(expected)
  })

  it('folds Latin accents and Arabic orthographic variants', () => {
    // Two spellings of one label: `é` decomposed and precomposed, and the Arabic label written with
    // and without harakat and with the hamza-carrying alef.
    expect(normaliseNameForMatching('Clienté')).toBe(normaliseNameForMatching('Clienté'))
    expect(normaliseNameForMatching('أعمال')).toBe(normaliseNameForMatching('اعمَال'))
    // Control: folding must not make two different labels equal.
    expect(normaliseNameForMatching('Customer 0042')).not.toBe(
      normaliseNameForMatching('Customer 0043'),
    )
  })

  it('builds the name match key from the normalised label and the last four digits', () => {
    const e164 = normalisePhone('+971590000042')
    expect(nameMatchKey('Customer 0042', e164)).toBe('0042 customer:0042')
    // Word order must not matter, or the desk and the form produce two records.
    expect(nameMatchKey('0042 Customer', e164)).toBe(nameMatchKey('Customer 0042', e164))
    // Different number, same label: not the same key, or the key is a name index.
    expect(nameMatchKey('Customer 0042', normalisePhone('+971590000043'))).not.toBe(
      nameMatchKey('Customer 0042', e164),
    )
  })

  it('has no name key when there is no name', () => {
    const e164 = normalisePhone('+971590000042')
    expect(nameMatchKey(null, e164)).toBeNull()
    expect(nameMatchKey(undefined, e164)).toBeNull()
    expect(nameMatchKey('   ', e164)).toBeNull()
    // A key built from punctuation alone would collide every such customer with every other.
    expect(nameMatchKey('--', e164)).toBeNull()
  })
})
