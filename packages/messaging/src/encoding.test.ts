import { describe, expect, it } from 'vitest'
import { campaignCost, costOf, PROVISIONAL_FILS_PER_SEGMENT } from './encoding.ts'

/** Table-driven, because the interesting cases are the boundaries and they are easy to miss one at a time. */
const CASES: readonly {
  what: string
  body: string
  encoding: 'GSM-7' | 'UCS-2'
  segments: number
  units: number
}[] = [
  { what: 'empty', body: '', encoding: 'GSM-7', segments: 0, units: 0 },
  {
    what: 'plain ASCII',
    body: 'Your booking is confirmed.',
    encoding: 'GSM-7',
    segments: 1,
    units: 26,
  },
  {
    what: 'exactly one GSM-7 segment',
    body: 'a'.repeat(160),
    encoding: 'GSM-7',
    segments: 1,
    units: 160,
  },
  { what: 'one over', body: 'a'.repeat(161), encoding: 'GSM-7', segments: 2, units: 161 },
  {
    what: 'two concatenated segments',
    body: 'a'.repeat(306),
    encoding: 'GSM-7',
    segments: 2,
    units: 306,
  },
  {
    what: 'three concatenated segments',
    body: 'a'.repeat(307),
    encoding: 'GSM-7',
    segments: 3,
    units: 307,
  },
  // Extension characters cost two septets each, so 160 characters can be 161 units.
  { what: 'a euro sign', body: `${'a'.repeat(159)}€`, encoding: 'GSM-7', segments: 2, units: 161 },
  { what: 'a brace', body: `${'a'.repeat(159)}{`, encoding: 'GSM-7', segments: 2, units: 161 },
  { what: 'a tilde', body: `${'a'.repeat(159)}~`, encoding: 'GSM-7', segments: 2, units: 161 },
  {
    what: 'exactly one UCS-2 segment',
    body: 'م'.repeat(70),
    encoding: 'UCS-2',
    segments: 1,
    units: 70,
  },
  { what: 'one over', body: 'م'.repeat(71), encoding: 'UCS-2', segments: 2, units: 71 },
  { what: 'two UCS-2 segments', body: 'م'.repeat(134), encoding: 'UCS-2', segments: 2, units: 134 },
  {
    what: 'three UCS-2 segments',
    body: 'م'.repeat(135),
    encoding: 'UCS-2',
    segments: 3,
    units: 135,
  },
]

describe('encoding, segments and cost', () => {
  for (const testCase of CASES) {
    it(`${testCase.what}: ${testCase.encoding}, ${testCase.segments} segment(s)`, () => {
      const cost = costOf('sms', testCase.body)
      expect(cost.encoding).toBe(testCase.encoding)
      expect(cost.segments).toBe(testCase.segments)
      expect(cost.units).toBe(testCase.units)
      expect(cost.costFils).toBe(testCase.segments * PROVISIONAL_FILS_PER_SEGMENT)
    })
  }

  it('a 150-character Arabic body is exactly 3 segments', () => {
    // The worked example from the manifest. 150 units at 67 per concatenated segment is 2.24, which
    // rounds up to 3 — not the 2 that dividing by the single-segment limit of 70 would suggest.
    const cost = costOf('sms', 'م'.repeat(150))
    expect(cost.segments).toBe(3)
    expect(cost.encoding).toBe('UCS-2')
    expect(cost.costFils).toBe(27)
  })
})

describe('the asymmetry a campaign budget has to show', () => {
  it('makes a body that fits in English spill into a second segment in Arabic', () => {
    // The asymmetry at the length a real reminder actually is. Both are around a hundred characters;
    // the English one fits a 160-character segment and the Arabic one does not fit a 70-character
    // one, so the same message costs twice as much to the Arabic half of the customer base.
    const english = costOf(
      'sms',
      'Reminder: your booking tomorrow at 20:00. Details or changes: brlx.ae/b/AbCdEf and thank you.',
    )
    const arabic = costOf(
      'sms',
      'تذكير بحجزك غداً الساعة 20:00. للتفاصيل أو التعديل: brlx.ae/b/AbCdEf ونشكرك على ثقتك بنا.',
    )
    expect(english.segments).toBe(1)
    expect(arabic.segments).toBe(2)
    expect(arabic.units).toBeLessThan(english.units)
    expect(arabic.costFils).toBe(english.costFils * 2)
  })

  it('names the character that forced UCS-2, because the usual cause is invisible', () => {
    const cost = costOf('sms', 'Don’t forget your booking')
    expect(cost.encoding).toBe('UCS-2')
    expect(cost.forcedUnicodeBy).toEqual(['’'])
    // The ASCII apostrophe looks identical and costs 90 characters less capacity.
    expect(costOf('sms', "Don't forget your booking").encoding).toBe('GSM-7')
  })

  it('multiplies by recipients, which is the number a campaign screen shows', () => {
    const body = 'م'.repeat(150)
    expect(campaignCost('sms', body, 400)).toBe(27 * 400)
  })
})

describe('channels that are not segment-billed', () => {
  it('costs nothing for email and whatsapp, rather than quietly pricing them as SMS', () => {
    const body = 'a'.repeat(500)
    expect(costOf('email', body).costFils).toBe(0)
    expect(costOf('whatsapp', body).costFils).toBe(0)
    // The encoding is still computed: a WhatsApp body is not billed by segment but is still subject
    // to a length limit, and knowing it is UCS-2 is how you know where that limit falls.
    expect(costOf('email', 'م').encoding).toBe('UCS-2')
  })
})
