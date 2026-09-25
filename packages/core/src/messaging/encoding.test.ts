import { describe, expect, it } from 'vitest'
import {
  detectSmsEncoding,
  GSM7_BASIC,
  GSM7_EXTENDED,
  isUnicodeSms,
  nonGsm7Characters,
  SEGMENT_LIMITS,
  SMS_ENCODINGS,
  smsUnitsOf,
} from './encoding.ts'

/**
 * Which alphabet a body is sent in, and what each character costs in it.
 *
 * The cases B-MSG-01 wrote for `packages/core/src/text/sms.ts` are kept here, because the module moved
 * and the claims did not: this file is where the alphabet now lives, and a move that dropped its tests
 * would be a refactor that deleted the evidence. What is new is the table's totality and the unit
 * counter's two answers being asserted against each other rather than only in passing.
 */

describe('the alphabet', () => {
  it('has no character in both the basic and the extension set', () => {
    // A character in both would be charged one septet or two depending on which set is consulted first,
    // and the two consultations are in different functions.
    const overlap = [...GSM7_EXTENDED].filter((char) => GSM7_BASIC.includes(char))
    expect(overlap).toEqual([])
  })

  it('is the 127 typeable entries of the default alphabet and the 9 reachable by escape', () => {
    // Stated as numbers, because the failure this catches is a character deleted by an editor's
    // auto-formatting: the set would still look like the alphabet and one character would silently
    // start forcing UCS-2 for every body that contains it.
    //
    // 127 and not 128: the 128th position of the default alphabet is ESC (0x1B), which is not a
    // character anybody types. It is the escape that makes the extension table reachable, and it is
    // charged as the FIRST of the two septets an extension character costs — which is why it belongs in
    // `smsUnitsOf` rather than in this set.
    expect([...GSM7_BASIC]).toHaveLength(127)
    expect(new Set(GSM7_BASIC).size).toBe(127)
    expect([...GSM7_EXTENDED]).toHaveLength(9)
    expect(GSM7_EXTENDED).toContain('€')
  })

  it('declares a capacity for every encoding and no others', () => {
    expect(Object.keys(SEGMENT_LIMITS).sort()).toEqual([...SMS_ENCODINGS].sort())
    expect(SEGMENT_LIMITS['GSM-7']).toEqual({ single: 160, concatenated: 153 })
    expect(SEGMENT_LIMITS['UCS-2']).toEqual({ single: 70, concatenated: 67 })
    // The concatenated capacity is always smaller: the UDH header that numbers the parts lives in it.
    for (const encoding of SMS_ENCODINGS) {
      expect(SEGMENT_LIMITS[encoding].concatenated, encoding).toBeLessThan(
        SEGMENT_LIMITS[encoding].single,
      )
    }
  })
})

describe('encoding detection', () => {
  it('keeps plain English in GSM-7', () => {
    expect(detectSmsEncoding('Your appointment is confirmed for 8pm.')).toBe('GSM-7')
    expect(isUnicodeSms('Your appointment is confirmed for 8pm.')).toBe(false)
  })

  it('keeps every character of the default alphabet in GSM-7', () => {
    // The whole alphabet at once, which is the assertion a per-character review cannot make: a single
    // character wrongly outside the set would make every body containing it cost 90 characters more.
    expect(detectSmsEncoding(GSM7_BASIC)).toBe('GSM-7')
    expect(detectSmsEncoding(GSM7_EXTENDED)).toBe('GSM-7')
    expect(nonGsm7Characters(GSM7_BASIC + GSM7_EXTENDED)).toEqual([])
  })

  it('forces UCS-2 on a single Arabic character, and says which one', () => {
    expect(detectSmsEncoding('Booking ok')).toBe('GSM-7')
    const arabic = 'Booking ok م'
    expect(detectSmsEncoding(arabic)).toBe('UCS-2')
    expect(nonGsm7Characters(arabic)).toEqual(['م'])
  })

  it('names a typographic apostrophe, the usual accidental cause', () => {
    // Pasted from a word processor. It costs 90 characters of capacity and looks identical.
    expect(detectSmsEncoding('Don’t forget your appointment')).toBe('UCS-2')
    expect(nonGsm7Characters('Don’t forget your appointment')).toEqual(['’'])
    expect(isUnicodeSms("Don't forget your appointment")).toBe(false)
  })

  it('reports an astral emoji as one character rather than two surrogate halves', () => {
    // Iterated by code point. Reported as two halves, the list would name characters that do not exist
    // and an author would look for a character they cannot see in their own body.
    expect(nonGsm7Characters('See you soon \u{1f600}')).toEqual(['\u{1f600}'])
  })

  it('deduplicates in order of first appearance', () => {
    // Order and deduplication both matter: the list is shown to an author, and "م, م, م" for a body
    // with three of them is noise that hides the second distinct character.
    expect(nonGsm7Characters('م ت م ت')).toEqual(['م', 'ت'])
  })
})

describe('unit counting', () => {
  it('charges one septet per basic character and two per extension character', () => {
    expect(smsUnitsOf('abc', 'GSM-7')).toBe(3)
    expect(smsUnitsOf('€', 'GSM-7')).toBe(2)
    expect(smsUnitsOf(GSM7_EXTENDED, 'GSM-7')).toBe(18)
    // 159 letters plus one brace is 161 septets, which is the whole trap: 160 characters that do not
    // fit in one segment.
    expect(smsUnitsOf(`${'a'.repeat(159)}{`, 'GSM-7')).toBe(161)
  })

  it('counts UTF-16 code units for UCS-2, so an astral emoji is two', () => {
    expect(smsUnitsOf('\u{1f600}', 'UCS-2')).toBe(2)
    expect(smsUnitsOf('م', 'UCS-2')).toBe(1)
    // The same string costs differently in the two encodings, which is what makes the encoding argument
    // load-bearing rather than decorative.
    expect(smsUnitsOf('€', 'UCS-2')).toBe(1)
    expect(smsUnitsOf('€', 'GSM-7')).toBe(2)
  })

  it('counts nothing for an empty body in either encoding', () => {
    for (const encoding of SMS_ENCODINGS) expect(smsUnitsOf('', encoding), encoding).toBe(0)
  })
})
