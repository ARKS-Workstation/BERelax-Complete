import { describe, expect, it } from 'vitest'
import {
  BIDI_CONTROLS,
  FSI,
  hasStrongRtl,
  hasUnsafeBidiControls,
  isolateAuto,
  isolateLatinRuns,
  isolateLtr,
  isolateRtl,
  LRI,
  needsIsolation,
  PDI,
  RLI,
  stripBidiControls,
} from './bidi.ts'

/** Real strings from the Arabic side of the invoice and the SMS templates. */
const ARABIC_INVOICE = 'فاتورة ضريبية'
const ARABIC_SENTENCE = 'موعدك في بي ريلاكس'
const PHONE = '+971 2 555 0199'
const REFERENCE = 'INV-2026-000123'

describe('hasStrongRtl', () => {
  it('detects Arabic', () => {
    expect(hasStrongRtl(ARABIC_INVOICE)).toBe(true)
  })

  it('detects Arabic presentation forms, which is what a pasted PDF string often contains', () => {
    expect(hasStrongRtl('\ufedf\ufeae')).toBe(true)
  })

  it('does not fire on Latin, digits, or Arabic-adjacent punctuation alone', () => {
    expect(hasStrongRtl('Tax Invoice AED 350.00')).toBe(false)
    expect(hasStrongRtl(PHONE)).toBe(false)
  })
})

describe('isolateLtr', () => {
  it('wraps in LRI … PDI', () => {
    expect(isolateLtr(PHONE)).toBe(`${LRI}${PHONE}${PDI}`)
  })

  it('does not nest when the run is already isolated the same way', () => {
    const once = isolateLtr(PHONE)
    expect(isolateLtr(once)).toBe(once)
  })

  it('still wraps a run isolated the other way, because the direction differs', () => {
    expect(isolateLtr(isolateRtl(ARABIC_INVOICE))).toBe(`${LRI}${RLI}${ARABIC_INVOICE}${PDI}${PDI}`)
  })

  it('adds exactly two characters, both zero-width', () => {
    expect(isolateLtr(REFERENCE)).toHaveLength(REFERENCE.length + 2)
  })
})

describe('isolateAuto', () => {
  it('uses FSI so a name of unknown script takes its own direction', () => {
    expect(isolateAuto('Nguyễn')).toBe(`${FSI}Nguyễn${PDI}`)
    expect(isolateAuto('سارة')).toBe(`${FSI}سارة${PDI}`)
  })
})

describe('needsIsolation', () => {
  it('flags an Arabic sentence containing an un-isolated price', () => {
    expect(needsIsolation(`${ARABIC_SENTENCE} AED 350.00`)).toBe(true)
  })

  it('flags an Arabic sentence containing an un-isolated phone number', () => {
    expect(needsIsolation(`${ARABIC_SENTENCE} ${PHONE}`)).toBe(true)
  })

  it('clears once the run is isolated', () => {
    expect(needsIsolation(`${ARABIC_SENTENCE} ${isolateLtr(PHONE)}`)).toBe(false)
  })

  it('does not flag pure Arabic', () => {
    expect(needsIsolation(ARABIC_SENTENCE)).toBe(false)
  })

  it('does not flag pure Latin, where the paragraph direction already matches', () => {
    expect(needsIsolation(`Your appointment ${PHONE}`)).toBe(false)
  })

  it('does not flag a single Arabic-Indic-free character, which cannot reorder against itself', () => {
    expect(needsIsolation(`${ARABIC_SENTENCE} A`)).toBe(false)
  })
})

describe('isolateLatinRuns', () => {
  it('isolates a Latin run that contains spaces, keeping a phone number whole', () => {
    const out = isolateLatinRuns(`${ARABIC_SENTENCE} ${PHONE}`)
    expect(out).toBe(`${ARABIC_SENTENCE} ${isolateLtr(PHONE)}`)
    expect(needsIsolation(out)).toBe(false)
  })

  it('treats adjacent Latin runs as one isolate, which displays identically', () => {
    const out = isolateLatinRuns(`${ARABIC_SENTENCE} ${REFERENCE} ${PHONE}`)
    expect(out).toBe(`${ARABIC_SENTENCE} ${isolateLtr(`${REFERENCE} ${PHONE}`)}`)
    expect(needsIsolation(out)).toBe(false)
  })

  it('leaves sentence-final punctuation outside the isolate', () => {
    expect(isolateLatinRuns(`${ARABIC_SENTENCE} AED 350.00.`)).toBe(
      `${ARABIC_SENTENCE} ${isolateLtr('AED 350.00')}.`,
    )
  })

  it('leaves a Latin-only string untouched, so English copy is never polluted', () => {
    const latin = `Tax Invoice ${REFERENCE}`
    expect(isolateLatinRuns(latin)).toBe(latin)
  })
})

describe('stripBidiControls', () => {
  it('removes every control it knows about', () => {
    const hostile = BIDI_CONTROLS.join('')
    expect(stripBidiControls(hostile)).toBe('')
  })

  it('neutralises the override a hostile customer name would carry', () => {
    // U+202E after the visible name reverses everything that follows it on the line — enough to make
    // an invoice read 00.053 where 350.00 was stored.
    const hostile = 'Ahmed\u202e'
    expect(hasUnsafeBidiControls(hostile)).toBe(true)
    expect(stripBidiControls(hostile)).toBe('Ahmed')
    expect(hasUnsafeBidiControls(stripBidiControls(hostile))).toBe(false)
  })

  it('leaves ordinary text, Arabic included, byte-identical', () => {
    expect(stripBidiControls(ARABIC_INVOICE)).toBe(ARABIC_INVOICE)
    expect(stripBidiControls('Ahmed Al Mansoori')).toBe('Ahmed Al Mansoori')
  })

  it('does not treat an isolate as safe to keep in untrusted text either', () => {
    // An unbalanced PDI from untrusted input closes an isolate the template opened.
    expect(stripBidiControls(`Ahmed${PDI}`)).toBe('Ahmed')
  })
})
