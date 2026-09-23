import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { PHONE_REJECTIONS, phoneMatchKey } from '../identity/normalise-phone.ts'
import { CRM_PHONE_REJECTIONS, crmPhoneKey, DELEGATED_PHONE_REJECTIONS } from './phone.ts'

/**
 * C-CRM-02's first acceptance line, and the three claims in it.
 *
 * "+971501234567, 00971501234567, 0501234567, 971 50 123 4567 and (050) 123-4567 all normalise to one
 * identical E.164 key; a non-UAE number retains its own country code; an unparseable input returns a
 * typed refusal rather than a guessed key."
 *
 * Every table here carries its control. A normaliser tested only on the spellings that must agree
 * passes identically when it returns a constant — and that version merges the whole customer table into
 * one person, which is a worse outcome than the split it was written to prevent.
 */

/** The five spellings the acceptance line names, verbatim, plus the ones that arrive in practice. */
const ONE_NUMBER_MANY_SPELLINGS = [
  '+971501234567',
  '00971501234567',
  '0501234567',
  '971 50 123 4567',
  '(050) 123-4567',
  '050-123-4567',
  '+971 50 123 45 67',
  '٠٥٠١٢٣٤٥٦٧',
  '۰۵۰۱۲۳۴۵۶۷',
] as const

const CANONICAL = '+971501234567'

describe('crmPhoneKey on UAE numbers', () => {
  it.each(ONE_NUMBER_MANY_SPELLINGS)('keys %j to the one canonical E.164', (spelling) => {
    expect(crmPhoneKey(spelling)).toEqual({
      ok: true,
      e164: CANONICAL,
      matchKey: '501234567',
      origin: 'uae',
    })
  })

  it('collapses every spelling to exactly one key, and keeps different numbers apart', () => {
    const keys = new Set(
      ONE_NUMBER_MANY_SPELLINGS.map((spelling) => {
        const result = crmPhoneKey(spelling)
        return result.ok ? result.e164 : `refused:${result.reason}`
      }),
    )
    expect(keys).toEqual(new Set([CANONICAL]))

    // The controls. A key-maker that returned a constant, or one that threw away the subscriber
    // digits, satisfies the assertion above and scores two strangers as the same person.
    for (const other of ['0501234568', '0521234567', '0590000042']) {
      const result = crmPhoneKey(other)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.e164).not.toBe(CANONICAL)
    }
  })

  /**
   * The property, over generated numbers rather than the nine spellings above.
   *
   * The generator builds one UAE mobile from random digits and then re-spells it six ways, so the
   * claim being proved is "every spelling of any number agrees", not "every spelling of 0501234567
   * agrees". A table of spellings can be satisfied by special-casing the table.
   */
  it('keys every spelling of any UAE mobile to one value', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('50', '52', '54', '55', '56', '58', '59'),
        fc.stringMatching(/^[0-9]{7}$/),
        (prefix, subscriber) => {
          const national = `${prefix}${subscriber}`
          const spellings = [
            `+971${national}`,
            `00971${national}`,
            `0${national}`,
            `971 ${national}`,
            `(0${prefix}) ${subscriber.slice(0, 3)}-${subscriber.slice(3)}`,
            `0${prefix} ${subscriber.slice(0, 3)} ${subscriber.slice(3)}`,
          ]
          const keyed = spellings.map((spelling) => crmPhoneKey(spelling))
          return (
            keyed.every((result) => result.ok && result.e164 === `+971${national}`) &&
            keyed.every((result) => result.ok && result.matchKey === national)
          )
        },
      ),
      { numRuns: 300 },
    )
  })

  it('reports the trailing nine digits that B-LIFE-02 defines, not a second key', () => {
    const result = crmPhoneKey('0501234567')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.matchKey).toBe(phoneMatchKey(result.e164))
  })
})

describe('crmPhoneKey on numbers outside the UAE', () => {
  it.each([
    ['+447700900123', '+447700900123', '700900123'],
    ['00447700900123', '+447700900123', '700900123'],
    ['+44 7700 900 123', '+447700900123', '700900123'],
    ['+966 50 000 0042', '+966500000042', '500000042'],
    ['+1 555 0100 999', '+15550100999', '550100999'],
  ] as const)('keeps %j on its own country code', (raw, e164, matchKey) => {
    expect(crmPhoneKey(raw)).toEqual({ ok: true, e164, matchKey, origin: 'foreign' })
  })

  it('never rewrites a foreign number onto the UAE country code', () => {
    // The control that matters. A "normaliser" that pasted +971 in front of everything would satisfy
    // every UAE assertion in this file and would key a British tourist as an Abu Dhabi customer.
    for (const raw of ['+447700900123', '+966500000042', '+15550100999']) {
      const result = crmPhoneKey(raw)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.e164.startsWith('+971')).toBe(false)
        expect(result.e164).toBe(raw)
        expect(result.origin).toBe('foreign')
      }
    }
  })

  it('keeps the country code of any generated international number', () => {
    fc.assert(
      fc.property(
        // Country codes that are not 971 and not 9 (so no prefix of 971 can be produced), plus enough
        // subscriber digits to be inside E.164's bounds.
        fc.constantFrom('1', '20', '44', '49', '61', '966', '968', '974', '91'),
        fc.stringMatching(/^[0-9]{8,10}$/),
        (countryCode, subscriber) => {
          const result = crmPhoneKey(`+${countryCode}${subscriber}`)
          if (!result.ok) return result.reason === 'implausible_length'
          return (
            result.origin === 'foreign' &&
            result.e164 === `+${countryCode}${subscriber}` &&
            result.e164.startsWith(`+${countryCode}`)
          )
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('crmPhoneKey refuses rather than guesses', () => {
  it.each([
    ['', 'empty'],
    ['+', 'empty'],
    ['   ', 'empty'],
    ['not a number at all', 'not_digits'],
    ['05012345ab', 'not_digits'],
    ['walk-in, no number given', 'not_digits'],
    // The shape judgement stays B-LIFE-02's: a UAE landline and a toll-free line cannot receive an
    // SMS, and the CRM does not hold a second opinion about which UAE numbers are which.
    ['02 123 4567', 'landline_not_an_sms_target'],
    ['04 123 4567', 'landline_not_an_sms_target'],
    ['0800 4567', 'landline_not_an_sms_target'],
    // A foreign number typed with no international prefix is refused on shape rather than assumed.
    ['447700900123', 'wrong_length'],
    ['050 123 456', 'wrong_length'],
    ['+9715012345678', 'wrong_length'],
    // An international prefix followed by a zero is one prefix too many, not a country code.
    ['+0044 7700 900123', 'no_country_code'],
    // Inside a `+`, but outside E.164's own bounds either way.
    ['+4412', 'implausible_length'],
    ['+4477009001234567', 'implausible_length'],
  ] as const)('refuses %j with reason %s', (raw, reason) => {
    expect(crmPhoneKey(raw)).toEqual({ ok: false, reason })
  })

  it('reports only declared reasons, for any input at all', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = crmPhoneKey(raw)
        if (result.ok)
          return result.e164.startsWith('+') && /^\+[1-9][0-9]{7,14}$/.test(result.e164)
        return (CRM_PHONE_REJECTIONS as readonly string[]).includes(result.reason)
      }),
      { numRuns: 1_000 },
    )
  })

  /**
   * The pass-through set, asserted rather than described.
   *
   * B-LIFE-02 owns the UAE shape rules and this module forwards their refusals. A reason added there
   * and not here would arrive at a caller as a value outside {@link CRM_PHONE_REJECTIONS} — typed as
   * one, because the forward is a cast-free assignment the compiler cannot check against a list it was
   * not given. This is the assertion that catches it.
   */
  it('carries every B-LIFE-02 reason except the one it answers itself', () => {
    expect(DELEGATED_PHONE_REJECTIONS).toEqual(
      PHONE_REJECTIONS.filter((reason) => reason !== 'unsupported_country'),
    )
    for (const reason of DELEGATED_PHONE_REJECTIONS) {
      expect(CRM_PHONE_REJECTIONS as readonly string[]).toContain(reason)
    }
    // The control: the one reason that must NOT be forwarded, because this module resolves it.
    expect(PHONE_REJECTIONS as readonly string[]).toContain('unsupported_country')
    expect(CRM_PHONE_REJECTIONS as readonly string[]).not.toContain('unsupported_country')
  })
})
