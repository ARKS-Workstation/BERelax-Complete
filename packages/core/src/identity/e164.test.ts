import { describe, expect, it } from 'vitest'
import {
  E164_IDENTITY_REJECTIONS,
  e164Identity,
  e164IdentityResult,
  identityAgreesWithSendNormaliser,
  isE164IdentityRejection,
  UAE_LINE_TYPES,
} from './e164.ts'
import { normalisePhoneResult, PHONE_REJECTIONS } from './normalise-phone.ts'

/**
 * E.164 for identity: the two spellings H-MIG-04's acceptance names, and the census that holds this
 * module and the SEND normaliser in the one relationship they are allowed to have.
 *
 * The census is the case that matters. Two readings of the UAE numbering plan now exist in this
 * repository, and the failure if they drift is silent in the worst direction: a booking form that
 * normalises `050 510 8633` to one string and an importer that normalises it to another produces TWO
 * customer records for one person, whose history, package balance and contraindication flags each hold
 * half the truth — which is the exact failure `normalise-phone.ts` opens by describing. So every input
 * below goes through both functions and the verdict must be one of the two permitted ones.
 */

/**
 * Every spelling either function has to answer for, as data.
 *
 * `052 510 8633` and `02 557 6533` are H-MIG-04's two acceptance lines and are the business's own numbers
 * from docs/13 §3 (`WHATSAPP_CANDIDATES` and `PREMISES_NAP.phoneLandline`), so they are facts about the
 * world rather than invented values — and they are only ever normalised here, never written to a row.
 * The rest are the shapes a phone contact list actually contains: an Arabic keyboard, a WhatsApp paste
 * with a non-breaking space, `00` for `+`, a trunk prefix and no trunk prefix, and the four faults.
 */
const CENSUS: readonly string[] = Object.freeze([
  // The two the acceptance names.
  '052 510 8633',
  '02 557 6533',
  // The same two, spelled every other way a list spells them.
  '0525108633',
  '+971525108633',
  '00971525108633',
  '971 52 510 8633',
  '+971 52 510 8633',
  '025576533',
  '+97125576533',
  '971 2 557 6533',
  // An unallocated-prefix synthetic number, which is what every fixture in this build uses.
  '059 000 0042',
  '+971590000042',
  // Arabic-Indic and extended Arabic-Indic digits, which an Arabic-locale contact list holds.
  '٠٥٢٥١٠٨٦٣٣',
  '۰۵۲۵۱۰۸۶۳۳',
  // A WhatsApp paste: U+00A0 and U+202F are invisible on screen and are different strings.
  '+971 52 510 8633',
  '052 510 8633',
  // Punctuation a person adds.
  '(052) 510-8633',
  '052/510.8633',
  // The faults.
  '',
  '   ',
  'call the front desk',
  '+447700900123',
  '00447700900123',
  '+966512345678',
  '0525108',
  '05251086331234',
  '+9715251086',
  // The toll-free and short-code range: accepted as a line nothing can message, or refused as unstorable.
  '800 4357',
  '0800',
  '600 512345',
  // A landline area code with a mobile length, and a mobile prefix with a landline length.
  '021234567890',
  '05251086',
])

describe('e164IdentityResult', () => {
  it('normalises the two local Abu Dhabi spellings H-MIG-04 names', () => {
    // The mobile, and the landline the SEND normaliser refuses. Both are identities; one is messageable.
    expect(e164IdentityResult('052 510 8633')).toEqual({
      ok: true,
      e164: '+971525108633',
      lineType: 'mobile',
      messageable: true,
    })
    expect(e164IdentityResult('02 557 6533')).toEqual({
      ok: true,
      e164: '+97125576533',
      lineType: 'landline',
      messageable: false,
    })
  })

  it('folds every spelling of one number onto one string', () => {
    const spellings = [
      '052 510 8633',
      '0525108633',
      '+971525108633',
      '00971525108633',
      '971 52 510 8633',
      '٠٥٢٥١٠٨٦٣٣',
      '+971 52 510 8633',
      '(052) 510-8633',
    ]
    const canonical = new Set(
      spellings.map((raw) => {
        const result = e164IdentityResult(raw)
        return result.ok ? result.e164 : `refused:${result.reason}`
      }),
    )
    expect([...canonical]).toEqual(['+971525108633'])
  })

  it('refuses rather than repairs a number from another country', () => {
    // The control on the `+971` assumption: it applies to a BARE local number and to nothing else.
    for (const foreign of ['+447700900123', '00447700900123', '+966512345678']) {
      expect(e164IdentityResult(foreign)).toEqual({ ok: false, reason: 'unsupported_country' })
    }
  })

  it('names each of the four faults, and nothing else', () => {
    expect(e164IdentityResult('')).toEqual({ ok: false, reason: 'empty' })
    expect(e164IdentityResult('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(e164IdentityResult('call the front desk')).toEqual({ ok: false, reason: 'not_digits' })
    expect(e164IdentityResult('0525108')).toEqual({ ok: false, reason: 'wrong_length' })
    expect(e164IdentityResult('+9715251086')).toEqual({ ok: false, reason: 'wrong_length' })
    // `landline_not_an_sms_target` is the send normaliser's fifth reason and is deliberately not one here.
    expect([...E164_IDENTITY_REJECTIONS]).not.toContain('landline_not_an_sms_target')
    expect(E164_IDENTITY_REJECTIONS.every((reason) => isE164IdentityRejection(reason))).toBe(true)
    expect(isE164IdentityRejection('landline_not_an_sms_target')).toBe(false)
  })

  it('never produces a number the customer column would refuse', () => {
    // The guard the toll-free branch needs: `0800` reaches `classify` with a three-digit national number,
    // and `+971800` satisfies `phoneSchema.shape.e164` while `customer_phone_is_e164` refuses it.
    expect(e164IdentityResult('0800')).toEqual({ ok: false, reason: 'wrong_length' })
    for (const raw of CENSUS) {
      const result = e164IdentityResult(raw)
      if (!result.ok) continue
      expect(result.e164, `${raw} normalised to an unstorable number`).toMatch(/^\+[1-9]\d{7,14}$/)
    }
  })

  it('classifies a toll-free line apart from a landline, since neither can be messaged', () => {
    const tollFree = e164IdentityResult('800 4357')
    expect(tollFree).toEqual({
      ok: true,
      e164: '+9718004357',
      lineType: 'toll_free',
      messageable: false,
    })
    expect(UAE_LINE_TYPES.filter((type) => type !== 'mobile')).toEqual(['landline', 'toll_free'])
  })

  it('throws from the throwing form and names the reason', () => {
    expect(() => e164Identity('call the front desk')).toThrow(/not_digits/)
    expect(e164Identity('052 510 8633')).toBe('+971525108633')
  })
})

describe('the census against the send normaliser', () => {
  it('agrees with normalisePhoneResult, or differs only over a line nothing can message', () => {
    const verdicts = CENSUS.map((raw) => ({
      raw,
      verdict: identityAgreesWithSendNormaliser(e164IdentityResult(raw), normalisePhoneResult(raw)),
    }))
    expect(verdicts.filter((entry) => entry.verdict === 'disagree')).toEqual([])
    // The controls, and the reason the line above is not vacuous: the census has to CONTAIN inputs of
    // every permitted kind. A census of nothing but mobiles would pass while proving nothing about the
    // case the two functions are meant to answer differently.
    const count = (verdict: string): number =>
      verdicts.filter((entry) => entry.verdict === verdict).length
    expect(
      count('identity_only'),
      'the census exercises the landline divergence',
    ).toBeGreaterThanOrEqual(5)
    expect(count('same'), 'the census exercises agreement too').toBeGreaterThanOrEqual(10)
    // `both_refuse` was found BY this census rather than reasoned into the rule: `0800` is an unsendable
    // line to the send normaliser and an unstorable number here. The floor keeps that input in the census.
    expect(
      count('both_refuse'),
      'the census exercises the both-refuse case',
    ).toBeGreaterThanOrEqual(1)
  })

  it('detects a disagreement, which is the known-bad half of the census', () => {
    // A deliberately wrong identity answer against a real send answer. Without this, a comparison that
    // always answered `same` would satisfy the case above over any census at all.
    expect(
      identityAgreesWithSendNormaliser(
        { ok: false, reason: 'wrong_length' },
        normalisePhoneResult('052 510 8633'),
      ),
    ).toBe('disagree')
    expect(
      identityAgreesWithSendNormaliser(
        { ok: true, e164: '+971590000001' as never, lineType: 'mobile', messageable: true },
        normalisePhoneResult('052 510 8633'),
      ),
    ).toBe('disagree')
    // A landline the identity side wrongly reports as messageable is the drift that would put an SMS on a
    // number nothing can reach, so it must not read as the permitted divergence.
    expect(
      identityAgreesWithSendNormaliser(
        { ok: true, e164: '+97125576533' as never, lineType: 'mobile', messageable: true },
        normalisePhoneResult('02 557 6533'),
      ),
    ).toBe('disagree')
    expect(
      identityAgreesWithSendNormaliser(
        { ok: false, reason: 'not_digits' },
        normalisePhoneResult('0525108'),
      ),
    ).toBe('disagree')
  })

  it('shares the four reason spellings with the send normaliser, so one person can read both', () => {
    for (const reason of E164_IDENTITY_REJECTIONS) {
      expect(PHONE_REJECTIONS as readonly string[]).toContain(reason)
    }
    // And the fifth is the one this module answers rather than refuses.
    expect(PHONE_REJECTIONS.filter((reason) => !isE164IdentityRejection(reason))).toEqual([
      'landline_not_an_sms_target',
    ])
  })
})
