import { describe, expect, it } from 'vitest'
import {
  assertNoCardData,
  CARD_DATA_FIELD_NAMES,
  CARD_DATA_REDACTED,
  CARD_SHAPE_PROBES,
  CardDataRefused,
  cardDataFindings,
  cardShapedRuns,
  containsCardNumber,
  isLuhnValid,
  normaliseFieldName,
  redactCardData,
  redactedMessage,
  redactText,
  SECRET_FIELD_NAMES,
  SECRET_FIELD_REDACTED,
} from './redaction.ts'

/**
 * The card-data detector, the refusal and the redactor (Y-PAY-03).
 *
 * Every case here is paired with a control that must fail, because the claim is an ABSENCE and an absence is
 * what a broken detector reports too. A detector that answered `false` to everything would satisfy "no card
 * number is found in an audit payload" perfectly, and a redactor that returned its input unchanged would
 * satisfy "the redacted value is safe" for the same reason — so the positives are asserted as hard as the
 * negatives, and `CARD_SHAPE_PROBES` is driven in both directions.
 *
 * The other half of the probe corpus is `packages/fixtures/src/card-shape-agreement.itest.ts`, which drives
 * the same entries through migration 0117's `is_card_shaped()` in PostgreSQL. This file proves the rule; that
 * one proves the two statements of it agree.
 */

const PAN = '4111111111111111'
const SPACED = '4111 1111 1111 1111'

describe('the Luhn check', () => {
  it('accepts the test number and rejects it with one digit changed', () => {
    expect(isLuhnValid(PAN)).toBe(true)
    // The control, and the direction that matters: without it every "accepts" below is satisfied by a
    // function that returns true.
    expect(isLuhnValid('4111111111111112')).toBe(false)
  })

  it('refuses anything that is not all digits, and the empty string', () => {
    expect(isLuhnValid('')).toBe(false)
    expect(isLuhnValid('4111-1111-1111-1111')).toBe(false)
    expect(isLuhnValid('411111111111111x')).toBe(false)
  })
})

describe('the card shape', () => {
  it('agrees with every probe in the shared corpus, in both directions', () => {
    const wrong = CARD_SHAPE_PROBES.filter(
      (probe) => containsCardNumber(probe.text) !== probe.cardShaped,
    ).map((probe) => `${JSON.stringify(probe.text)} should be ${probe.cardShaped}`)
    expect(wrong, 'the detector disagrees with the corpus').toEqual([])
    // Non-vacuity: a corpus that had lost its negatives, or its positives, would make the filter above
    // trivially empty. Both counts have a floor.
    expect(CARD_SHAPE_PROBES.filter((probe) => probe.cardShaped).length).toBeGreaterThanOrEqual(4)
    expect(CARD_SHAPE_PROBES.filter((probe) => !probe.cardShaped).length).toBeGreaterThanOrEqual(6)
  })

  it('finds the number however a human spaced it', () => {
    for (const spelling of [PAN, SPACED, '4111-1111-1111-1111']) {
      expect(cardShapedRuns(spelling), spelling).toContain(PAN)
    }
  })

  it('does not join two numbers across two separators', () => {
    // `12 - 3456…` is two numbers in prose. Joining them would invent a candidate nobody wrote, and the
    // detector would then refuse ordinary text.
    expect(containsCardNumber('411 - 1111111111111')).toBe(false)
  })

  it('finds a card number hidden inside a longer digit run', () => {
    // The shape an accidental paste into a reference field actually takes. A whole-run Luhn check misses it.
    expect(cardShapedRuns(`INV-0042${PAN}`)).toContain(PAN)
  })

  it('leaves this system’s own long numbers alone', () => {
    // Every one of these is in an audit payload somewhere in this build. A detector that refused them would
    // be turned off within a week, which is why they are asserted rather than assumed.
    for (const innocent of [
      '+971559990132',
      '019a3f5c-0b2d-7c9e-8f01-2d3e4f5a6b7c',
      '2026-09-29T11:30:00.000Z',
      '20000',
      'checkout-019a3f5c0b2d7c9e8f012d3e4f5a6b7c',
    ]) {
      expect(containsCardNumber(innocent), innocent).toBe(false)
    }
  })
})

describe('the request boundary', () => {
  it('refuses a card-shaped value anywhere in the body, and names the path', () => {
    let refusal: CardDataRefused | null = null
    try {
      assertNoCardData({ reference: `paid ${PAN}` }, 'the checkout')
    } catch (error) {
      refusal = error instanceof CardDataRefused ? error : null
    }
    expect(refusal).not.toBeNull()
    expect(refusal?.findings).toEqual([{ path: 'reference', reason: 'card_shaped_value' }])
  })

  it('never puts the offending value in the message or the details', () => {
    // The whole reason the refusal names a path. A refusal that quoted the digits would write them into the
    // log it was raised to keep them out of — the same mistake migration 0117 avoids by not being a CHECK.
    let message = ''
    let details = ''
    try {
      assertNoCardData({ reference: PAN, cvv: '737' }, 'the checkout')
    } catch (error) {
      message = error instanceof Error ? error.message : ''
      details = JSON.stringify(error instanceof CardDataRefused ? error.details : {})
    }
    expect(message).not.toContain(PAN)
    expect(message).not.toContain('737')
    expect(details).not.toContain(PAN)
    expect(details).not.toContain('737')
    // The control: the message DOES name both offending fields, so the assertions above are about the values
    // and not about a message that says nothing.
    expect(message).toContain('reference')
    expect(message).toContain('cvv')
  })

  it('refuses a field named after card data even when its value is empty', () => {
    // The field is the defect. A form that HAS a CVV box is not a SAQ-A checkout on the submission where the
    // operator left it blank.
    expect(cardDataFindings({ cvv: '' })).toEqual([{ path: 'cvv', reason: 'card_data_field_name' }])
    expect(cardDataFindings({ cardNumber: null })).toEqual([
      { path: 'cardNumber', reason: 'card_data_field_name' },
    ])
  })

  it('does not descend into a refused field, so its value is never reported on', () => {
    // One finding, not two. Walking into it would put the value on a path in the details.
    expect(cardDataFindings({ pan: { nested: PAN } })).toEqual([
      { path: 'pan', reason: 'card_data_field_name' },
    ])
  })

  it('reads a PAN that arrived as a JSON number', () => {
    // 13 to 15 digits is inside Number.MAX_SAFE_INTEGER, so `JSON.parse` gives a number and a string-only
    // walk would pass it straight through. `4222222222222` is the thirteen-digit test number, and it is a
    // MEASURED choice: `4111111111111` (the sixteen-digit one shortened) is NOT Luhn-valid, and the first
    // version of this case reported the detector as broken when the number was.
    expect(cardDataFindings({ reference: 4_222_222_222_222 })).toEqual([
      { path: 'reference', reason: 'card_shaped_value' },
    ])
  })

  it('walks arrays and nested objects, naming each path', () => {
    expect(cardDataFindings({ lines: [{ note: PAN }] })).toEqual([
      { path: 'lines[0].note', reason: 'card_shaped_value' },
    ])
  })

  it('the control: an ordinary checkout body is accepted', () => {
    // Without this, every refusal above is satisfied by a boundary that refuses everything.
    expect(() =>
      assertNoCardData(
        {
          instrumentToken: 'tok_019a3f5c',
          amountFils: 20_000,
          reference: 'INV-2026-0042',
          idempotencyKey: 'checkout-019a3f5c-0b2d-7c9e-8f01-2d3e4f5a6b7c',
        },
        'the checkout',
      ),
    ).not.toThrow()
  })

  it('refuses every name in the card-data vocabulary, however it is spelled', () => {
    for (const name of CARD_DATA_FIELD_NAMES) {
      expect(cardDataFindings({ [name]: 'x' }), name).toHaveLength(1)
    }
    // Case and separators do not matter, which is what `normaliseFieldName` is for.
    for (const spelling of ['Card_Number', 'card-number', 'CARDNUMBER', 'cardNumber']) {
      expect(normaliseFieldName(spelling)).toBe('cardnumber')
      expect(cardDataFindings({ [spelling]: 'x' }), spelling).toHaveLength(1)
    }
    // The control: the vocabulary must not refuse the system's own words. `card_online` is the tender kind
    // this whole path is about, and a `/card/` pattern would have refused it.
    expect(cardDataFindings({ card_online: 'x', instrument: 'card_online' })).toEqual([])
  })
})

describe('the sink path', () => {
  it('redacts the number in every spelling, leaving the surrounding text', () => {
    for (const spelling of [PAN, SPACED, '4111-1111-1111-1111']) {
      const out = redactText(`took ${spelling} today`)
      expect(out, spelling).not.toContain('4111')
      expect(out, spelling).toContain(CARD_DATA_REDACTED)
      expect(out, spelling).toContain('took ')
      expect(out, spelling).toContain(' today')
    }
  })

  it('redacts a card-shaped value and a secret field, and keeps every key', () => {
    const out = redactCardData({
      reference: PAN,
      cvv: '737',
      instrumentToken: 'tok_secret',
      amountFils: 20_000,
    }) as Record<string, unknown>
    expect(out['reference']).toBe(CARD_DATA_REDACTED)
    expect(out['cvv']).toBe(SECRET_FIELD_REDACTED)
    expect(out['instrumentToken']).toBe(SECRET_FIELD_REDACTED)
    // The amount is untouched: a redactor that flattened everything would make an audit row useless and
    // would pass every leak assertion in this file.
    expect(out['amountFils']).toBe(20_000)
    // Keys survive. An operator has to be able to see that a field was present and unreadable.
    expect(Object.keys(out).sort()).toEqual(['amountFils', 'cvv', 'instrumentToken', 'reference'])
  })

  it('redacts every secret field name', () => {
    for (const name of SECRET_FIELD_NAMES) {
      const out = redactCardData({ [name]: 'value' }) as Record<string, unknown>
      expect(out[name], name).toBe(SECRET_FIELD_REDACTED)
    }
  })

  it('redacts a number and walks arrays', () => {
    expect(redactCardData(4_222_222_222_222)).toBe(CARD_DATA_REDACTED)
    expect(redactCardData([PAN, 'ok'])).toEqual([CARD_DATA_REDACTED, 'ok'])
    // The control: a fils amount is a number and must survive.
    expect(redactCardData(20_000)).toBe(20_000)
  })

  it('redacts an error’s message without throwing on a non-error', () => {
    expect(redactedMessage(new Error(`refused ${PAN}`))).not.toContain('4111')
    expect(redactedMessage(`raw ${PAN}`)).not.toContain('4111')
    expect(redactedMessage(undefined)).toBe('undefined')
  })

  it('the control: the sweep this file relies on can find a planted number', () => {
    // Every leak assertion above and in `checkout.itest.ts` is "the text does not contain the PAN". Without
    // this, all of them are satisfied by a search that can never match.
    const planted = JSON.stringify({ note: `card ${PAN}` })
    expect(planted).toContain(PAN)
    expect(JSON.stringify(redactCardData(JSON.parse(planted)))).not.toContain(PAN)
  })
})
