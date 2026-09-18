import { describe, expect, it } from 'vitest'
import { isUnicodeSms, segmentSms } from './sms.ts'

describe('encoding detection', () => {
  it('keeps plain English in GSM-7', () => {
    expect(segmentSms('Your appointment is confirmed for 8pm.').encoding).toBe('GSM-7')
  })

  it('forces UCS-2 on a single Arabic character, and says which one', () => {
    const result = segmentSms('Booking ok')
    expect(result.encoding).toBe('GSM-7')
    const arabic = segmentSms('Booking ok م')
    expect(arabic.encoding).toBe('UCS-2')
    expect(arabic.forcedBy).toEqual(['م'])
  })

  it('names a typographic apostrophe, the usual accidental cause', () => {
    // Pasted from a word processor. It costs 90 characters of capacity and looks identical.
    const result = segmentSms('Don’t forget your appointment')
    expect(result.encoding).toBe('UCS-2')
    expect(result.forcedBy).toEqual(['’'])
    expect(isUnicodeSms("Don't forget your appointment")).toBe(false)
  })
})

describe('segment counting', () => {
  it('fits 160 GSM-7 characters in one segment and 161 in two', () => {
    expect(segmentSms('a'.repeat(160)).segments).toBe(1)
    expect(segmentSms('a'.repeat(161)).segments).toBe(2)
  })

  it('drops to 153 per segment once concatenated, because of the UDH header', () => {
    expect(segmentSms('a'.repeat(306)).segments).toBe(2)
    expect(segmentSms('a'.repeat(307)).segments).toBe(3)
  })

  it('fits 70 UCS-2 characters in one segment and 67 per segment after that', () => {
    const arabic = 'م'
    expect(segmentSms(arabic.repeat(70)).segments).toBe(1)
    expect(segmentSms(arabic.repeat(71)).segments).toBe(2)
    expect(segmentSms(arabic.repeat(134)).segments).toBe(2)
    expect(segmentSms(arabic.repeat(135)).segments).toBe(3)
  })

  it('charges two septets for a GSM-7 extension character', () => {
    // 159 letters plus one brace is 161 septets, so it does not fit in one segment even though it
    // is 160 characters long.
    const result = segmentSms(`${'a'.repeat(159)}{`)
    expect(result.units).toBe(161)
    expect(result.segments).toBe(2)
  })

  it('counts an astral emoji as two UTF-16 units, which is what the air interface carries', () => {
    const result = segmentSms('\u{1f600}')
    expect(result.encoding).toBe('UCS-2')
    expect(result.units).toBe(2)
  })

  it('is zero segments for an empty body, not one', () => {
    expect(segmentSms('').segments).toBe(0)
  })
})

describe('the cost asymmetry that matters for this business', () => {
  it('makes the same message cost more than twice as much in Arabic', () => {
    const english = 'Your BE RELAX appointment is confirmed. See you soon.'
    const arabic = 'تم تأكيد موعدك في بي ريلاكس. نراكم قريباً.'
    expect(segmentSms(english).segments).toBe(1)
    expect(segmentSms(english).encoding).toBe('GSM-7')
    expect(segmentSms(arabic).encoding).toBe('UCS-2')
    // Shorter in characters, and it still costs a whole segment at 70 rather than 160.
    expect(arabic.length).toBeLessThan(english.length)
    expect(segmentSms(arabic).singleLimit).toBe(70)
  })

  it('reports remaining capacity against the right limit', () => {
    expect(segmentSms('a'.repeat(100)).remaining).toBe(60)
    expect(segmentSms('a'.repeat(200)).remaining).toBe(306 - 200)
  })
})
