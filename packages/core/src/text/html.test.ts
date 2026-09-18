import { describe, expect, it } from 'vitest'
import { aed, formatMoney } from '../money.ts'
import { LRI, PDI, RLM } from './bidi.ts'
import { bdi, escapeHtml, isolatePlain, safeText } from './html.ts'

describe('escapeHtml', () => {
  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })

  it('leaves Arabic alone', () => {
    expect(escapeHtml('فاتورة ضريبية')).toBe('فاتورة ضريبية')
  })
})

describe('safeText', () => {
  it('escapes markup and strips bidi controls in one pass', () => {
    expect(safeText('<b>Ahmed\u202e</b>')).toBe('&lt;b&gt;Ahmed&lt;/b&gt;')
  })
})

describe('safeText and ICU-formatted Arabic', () => {
  it('strips the RLM marks Intl puts in an Arabic currency string', () => {
    // A trap worth writing down. `Intl.NumberFormat('ar-AE', { style: 'currency' })` wraps the
    // Arabic currency abbreviation in U+200F marks to hold it in place. safeText removes every bidi
    // control, because it cannot tell ICU's marks from an attacker's. That is the right trade — but
    // it means a formatted Arabic amount is NOT self-positioning once it has been through safeText,
    // and a caller that assumed otherwise prints the abbreviation backwards.
    const arabic = formatMoney(aed(950), 'ar')
    expect(arabic).toContain(RLM)
    expect(safeText(arabic)).not.toContain(RLM)
  })

  it('leaves the English form alone, which is why documents use it in mixed sentences', () => {
    const english = formatMoney(aed(950))
    // Intl separates the code from the figure with a non-breaking space, not a plain one — worth
    // knowing before writing a string comparison against a rendered amount.
    expect(english).toBe('AED\u00a0950.00')
    expect(safeText(english)).toBe(english)
  })
})

describe('bdi', () => {
  it('emits an isolated element with the declared direction', () => {
    expect(bdi('+971 2 555 0199', 'ltr')).toBe('<bdi dir="ltr">+971 2 555 0199</bdi>')
  })

  it('defaults to auto, for a value whose script is not known at call time', () => {
    expect(bdi('سارة')).toBe('<bdi dir="auto">سارة</bdi>')
  })

  it('cannot be escaped by a hostile value', () => {
    expect(bdi('</bdi><script>alert(1)</script>', 'ltr')).toBe(
      '<bdi dir="ltr">&lt;/bdi&gt;&lt;script&gt;alert(1)&lt;/script&gt;</bdi>',
    )
  })
})

describe('isolatePlain', () => {
  it('is the plain-text spelling of the same intent', () => {
    expect(isolatePlain('AED 350.00', 'ltr')).toBe(`${LRI}AED 350.00${PDI}`)
  })
})
