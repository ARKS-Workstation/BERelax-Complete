import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  encloseUntrustedSeoData,
  MAX_SEO_UNTRUSTED_CHARACTERS,
  SEO_UNTRUSTED_GUTTER,
  SEO_UNTRUSTED_SOURCES,
  type SeoUntrustedSource,
  seoUntrustedFences,
} from './untrusted-envelope.ts'

/**
 * The envelope's ordinary behaviour. The adversarial half is `untrusted-envelope.fuzz.test.ts`.
 */

describe('the envelope is deterministic and reports what it changed', () => {
  it('is byte-identical across repeated calls, so a prompt diff is a content diff', () => {
    const html = '<h2>Hot oil massage</h2>\n<p>60 minutes.</p>'
    const first = encloseUntrustedSeoData({ source: 'fetched_html', text: html })
    const second = encloseUntrustedSeoData({ source: 'fetched_html', text: html })
    expect(second.region).toBe(first.region)
    expect(second.fingerprint).toBe(first.fingerprint)
  })

  it('binds the fences to the content, so the same text under two sources differs only by the label', () => {
    const text = 'massage abu dhabi'
    const asSerp = encloseUntrustedSeoData({ source: 'serp_text', text })
    const asQuery = encloseUntrustedSeoData({ source: 'gsc_query', text })
    // The same bytes fenced, so the same fingerprint — and two different labels, so two different fences.
    expect(asQuery.fingerprint).toBe(asSerp.fingerprint)
    expect(asQuery.region).not.toBe(asSerp.region)
    expect(asSerp.region.split('\n')[0]).toBe(
      seoUntrustedFences('serp_text', asSerp.fingerprint).open,
    )
  })

  it('reports the control characters it removed rather than removing them silently', () => {
    const envelope = encloseUntrustedSeoData({
      source: 'fetched_html',
      text: 'Best\u0000massage\u200b in \u202eAbu Dhabi',
    })
    // A non-zero count is itself a signal: ordinary fetched copy carries none of these.
    expect(envelope.strippedControlCharacters).toBe(3)
    expect(envelope.region).not.toContain('\u0000')
    expect(envelope.region).not.toContain('\u202e')
  })

  it('does not split a surrogate pair at the cap', () => {
    // The cap is in code points. Sliced in UTF-16 units, a cap landing inside an emoji leaves a lone
    // surrogate — an ill-formed string whose fingerprint the next reader cannot reproduce.
    const cap = MAX_SEO_UNTRUSTED_CHARACTERS.gsc_query
    const envelope = encloseUntrustedSeoData({ source: 'gsc_query', text: '😀'.repeat(cap + 10) })
    expect(envelope.truncatedCharacters).toBe(10)
    expect(envelope.region).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(envelope.region).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('gutters an empty string too, so an empty page still produces a delimited region', () => {
    const envelope = encloseUntrustedSeoData({ source: 'competitor_copy', text: '' })
    const lines = envelope.region.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe(SEO_UNTRUSTED_GUTTER)
    expect(envelope.truncatedCharacters).toBe(0)
  })

  it('refuses a source outside the closed set rather than inventing a fence label', () => {
    // The label is part of the fence, so an arbitrary string here would be arbitrary bytes in the framing —
    // which is the one place nothing outside this module may reach.
    expect(() =>
      encloseUntrustedSeoData({ source: 'sitemap' as SeoUntrustedSource, text: 'x' }),
    ).toThrow(AppError)
    expect(SEO_UNTRUSTED_SOURCES).toHaveLength(4)
  })
})
