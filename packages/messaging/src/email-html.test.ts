/**
 * The HTML part, and the two things it must never do: emit markup from a value, or reorder a line.
 *
 * Both assertions are paired with the control that the *text* survived: an escaper that dropped the
 * value entirely would satisfy "no `<script>` in the output" perfectly.
 */
import { describe, expect, it } from 'vitest'
import { renderEmailHtml } from './email-html.ts'
import type { MessageId, OutboundMessage } from './port.ts'

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id: 'm1' as MessageId,
    channel: 'email',
    messageClass: 'transactional',
    recipient: 'guest@example.com',
    subject: 'Your tax invoice',
    body: 'Your tax invoice INV-1042 is attached.\nTotal AED 315.00.\n\nThank you.',
    templateKey: 'invoice.issued',
    locale: 'en',
    ...overrides,
  }
}

describe('renderEmailHtml', () => {
  it('produces one document carrying the subject and the body', () => {
    const html = renderEmailHtml(message())
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>Your tax invoice</title>')
    expect(html).toContain('lang="en"')
    expect(html).toContain('dir="ltr"')
    expect(html).toContain('INV-1042')
    expect(html).toContain('Thank you.')
  })

  it('makes a paragraph of each block and a line break of each single newline', () => {
    const html = renderEmailHtml(message())
    // Two blocks, so two paragraphs; the single newline inside the first stays a break.
    expect(html.match(/<p /g)).toHaveLength(2)
    expect(html).toContain('Total AED 315.00.')
    expect(html).toContain('<br>')
  })

  it('mirrors an Arabic message rather than translating the direction away', () => {
    const html = renderEmailHtml(message({ locale: 'ar', body: 'تم تأكيد موعدك.' }))
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('lang="ar"')
    expect(html).toContain('تم تأكيد موعدك.')
  })

  it('escapes markup in a rendered value', () => {
    const html = renderEmailHtml(
      message({ body: 'Hello <script>alert(1)</script> & welcome "back".' }),
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
    // The control: the words are still there. An escaper that deleted the value would pass the three
    // lines above and ship an empty email.
    expect(html).toContain('Hello')
    expect(html).toContain('welcome')
  })

  it('strips a bidi override, which escaping alone does nothing about', () => {
    // One U+202E reverses the rest of the line, which in an email is a reversed amount or a reversed
    // link. It is invisible in review and invisible in the escaped output too.
    const override = String.fromCodePoint(0x202e)
    const html = renderEmailHtml(message({ body: `Total AED 315.00${override}` }))
    expect(html).not.toContain(override)
    expect(html).toContain('Total AED 315.00')
  })

  it('renders a message with no subject rather than the word undefined', () => {
    const { subject: _dropped, ...withoutSubject } = message()
    const html = renderEmailHtml(withoutSubject)
    expect(html).toContain('<title></title>')
    expect(html).not.toContain('undefined')
  })
})
