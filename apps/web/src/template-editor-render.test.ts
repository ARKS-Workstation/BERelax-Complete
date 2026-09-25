import { describe, expect, it } from 'vitest'
import {
  previewFigures,
  renderEditorHtml,
  WORKED_EXAMPLE_BODY,
} from '../app/(admin)/messaging/templates/editor/render.ts'

/**
 * The template editor's document, without a server.
 *
 * The rendering is pure — a body in, a document out — so everything except "does a browser really repaint
 * on input" can be asserted here in milliseconds. `apps/web/src/template-editor.itest.ts` drives the rest
 * against the built application, which is the only place the inline script can be proved.
 */

/** No banner: this file's subject is the pricing, and the banner is asserted by its own suite. */
const CHROME = { googleReauth: null, returnTo: '/messaging/templates/editor' } as const

describe('the worked example', () => {
  it('is docs/04 section 5s 150-character Arabic body', () => {
    expect(WORKED_EXAMPLE_BODY).toHaveLength(150)
    // One repeated letter, so the count is checkable by reading. Asserted as a set of one rather than by
    // slicing, which would pass for a body that changed after the first character.
    expect(new Set(WORKED_EXAMPLE_BODY).size).toBe(1)
  })

  it('reports UCS-2, three segments and a non-zero cost in fils', () => {
    const figures = previewFigures(WORKED_EXAMPLE_BODY)
    expect(figures.encoding).toBe('UCS-2')
    expect(figures.segments).toBe('3')
    expect(figures.cost).toBe('90 fils')
    expect(Number.parseInt(figures.cost, 10)).toBeGreaterThan(0)
  })

  it('reports the same 150 characters in English as one GSM-7 segment, which is the control', () => {
    // Without this, a preview that said "UCS-2, 3 segments" for everything would satisfy the case above.
    const english = previewFigures('a'.repeat(150))
    expect(english.encoding).toBe('GSM-7')
    expect(english.segments).toBe('1')
    expect(english.cost).toBe('12 fils')
  })
})

describe('the figures', () => {
  it('names the units in the encoding the body is actually in', () => {
    // Septets and code units are not characters, and calling either "characters" is how an author
    // concludes the counter is broken when a body of 160 characters reports 161.
    expect(previewFigures('Booking confirmed.').units).toBe('18 septets')
    expect(previewFigures(`${'a'.repeat(159)}{`).units).toBe('161 septets')
    expect(previewFigures('م').units).toBe('1 code units')
  })

  it('says what forced UCS-2, and says so when nothing did', () => {
    expect(previewFigures('Don’t forget').forced).toBe('’')
    // An empty list rendered as an empty string reads as a missing figure, so it is a sentence.
    expect(previewFigures('Booking confirmed.').forced).toContain('inside the GSM-7 alphabet')
  })

  it('reports the remaining budget, which is the number an author watches', () => {
    expect(previewFigures('a'.repeat(100)).remaining).toBe('60')
    expect(previewFigures('م'.repeat(50)).remaining).toBe('20')
  })
})

describe('the document', () => {
  const html = renderEditorHtml(WORKED_EXAMPLE_BODY, CHROME)

  it('carries the figures, the body and the noindex directive', () => {
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">')
    expect(html).toContain('data-figure="encoding">UCS-2<')
    expect(html).toContain('data-figure="segments">3<')
    expect(html).toContain('data-figure="cost">90 fils<')
    expect(html).toContain(WORKED_EXAMPLE_BODY)
  })

  it('says the rate is provisional and names the question that settles it', () => {
    // brief rule 15. A total with nothing marking it unconfirmed is indistinguishable from a quote.
    expect(html).toContain('Y6-sms-rate')
    expect(html).toContain('The rate is provisional')
    // And the part that is NOT provisional is separated from it, because a reader who discounts the
    // whole panel discounts the segment count too — and that number is 3GPP.
    expect(html).toContain('The segment count is not provisional')
  })

  it('states that nothing is saved and that a variant is created at draft', () => {
    // C-AUTO-01's residual NOTE: the state machine governs transitions, so an INSERT naming `approved`
    // starts there. This screen writes nothing, and the page says which path the write must take when it
    // lands rather than leaving the next unit to rediscover it.
    expect(html).toContain('Nothing here is saved')
    expect(html).toContain('<code>draft</code>')
    expect(html).toContain('setTemplateApproval')
  })

  it('shows where the body splits, as a figure the script can repaint', () => {
    // Three rules for three segments, with the unit count that explains each boundary. It is one string
    // rather than a list of elements for the reason `PreviewFigures.split` gives: markup cannot be
    // repainted by `textContent`, so a server-rendered list would go on describing the previous body.
    expect(html).toContain('How it splits')
    expect(html).toContain('data-figure="split"')
    const figures = previewFigures(WORKED_EXAMPLE_BODY)
    expect([...figures.split.matchAll(/— segment \d+ of 3, \d+ units —/g)]).toHaveLength(3)
    // The control: a one-segment body has nothing to split, and says so rather than showing a list of one
    // or an empty box.
    expect(previewFigures('Booking confirmed.').split).toBe('one segment — nothing is split')
    expect(previewFigures('').split).toBe('nothing to send yet')
  })

  it('escapes a body that contains markup, in the box and in the split list', () => {
    // The body is the author's own input and is echoed twice. A script tag in it must be text.
    const nasty = `<script>alert(1)</script>${'ت'.repeat(150)}`
    const rendered = renderEditorHtml(nasty, CHROME)
    expect(rendered).not.toContain('<script>alert(1)</script>')
    expect(rendered).toContain('&lt;script&gt;')
  })

  it('renders identically twice, because nothing in it reads a clock', () => {
    // The pure-render claim, asserted rather than trusted: a document carrying "as of now" could not
    // produce two identical screenshots, and the figures would change without the body changing.
    expect(renderEditorHtml(WORKED_EXAMPLE_BODY, CHROME)).toBe(
      renderEditorHtml(WORKED_EXAMPLE_BODY, CHROME),
    )
  })

  it('carries a script that paints figures and computes none', () => {
    // The claim that keeps the browser from becoming a second implementation of the rule. `segmentSms`
    // and the two capacities must not appear in the inline script at all — if they ever do, the author's
    // preview and the vendor's bill can differ.
    const script = html.slice(html.lastIndexOf('<script>'))
    expect(script).toContain('data-figure=')
    expect(script).not.toContain('160')
    expect(script).not.toContain('153')
    expect(script).not.toContain('70')
    expect(script).not.toContain('67')
    expect(script).not.toMatch(/GSM-7|UCS-2/)
    // And it asks the server on every input, which is what makes the figures it paints the real ones.
    expect(script).toContain("addEventListener('input'")
    expect(script).toContain("method: 'POST'")
  })
})
