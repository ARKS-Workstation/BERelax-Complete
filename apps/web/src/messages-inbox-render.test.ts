/**
 * The Messages inbox document, without a server.
 *
 * Everything the acceptance criterion asks to be *visible* is decidable from the markup: the body, the
 * encoding, the segment count, the cost, the status and an HTML preview pane for a Resend email. What
 * needs a browser — axe, and two screenshots that must be byte-identical — is
 * `apps/web/src/messages-inbox.itest.ts`, driving the built application.
 *
 * Every assertion has its control. "The recipient is masked" is satisfied by a renderer that omits the
 * recipient entirely, so the masked form is asserted present as well as the full form absent; "the email
 * preview is escaped" is satisfied by one that drops the HTML, so the escaped document is asserted to be
 * there.
 */
import type { InboxEntry } from '@berelax/db'
import { describe, expect, it } from 'vitest'
import { type InboxView, renderInboxHtml } from '../app/(admin)/settings/messages/render.ts'

const SMS: InboxEntry = {
  id: '00000000-0000-7000-8000-000000000001',
  templateKey: 'booking.confirmed',
  templateVersion: 1,
  channel: 'sms',
  vendor: 'smsala',
  messageClass: 'transactional',
  locale: 'ar',
  recipient: '+971528239069',
  senderId: 'BERELAX',
  subject: null,
  body: 'تم تأكيد موعدك يوم 19 سبتمبر الساعة 21:00.',
  bodyHtml: null,
  encoding: 'UCS-2',
  segments: 1,
  costFils: 9,
  status: 'delivered',
  providerMessageId: 'smsala-9f2c1a4b7e10',
  attempts: 1,
  lastFailureReason: null,
  lastFailureDetail: null,
  queuedAtIso: '2026-09-18T10:00:00.000Z',
  sentAtIso: '2026-09-18T10:00:00.000Z',
  deliveredAtIso: '2026-09-18T10:00:12.000Z',
  failedAtIso: null,
  nextAttemptAtIso: null,
  receipts: [
    {
      vendorStatus: 'delivered',
      mappedStatus: 'delivered',
      applied: true,
      ignoredReason: null,
      reason: null,
      occurredAtIso: '2026-09-18T10:00:12.000Z',
    },
    {
      vendorStatus: 'DELIVRD',
      mappedStatus: null,
      applied: false,
      ignoredReason: 'vendor_status_unrecognised',
      reason: null,
      occurredAtIso: '2026-09-18T10:00:20.000Z',
    },
  ],
}

const EMAIL: InboxEntry = {
  ...SMS,
  id: '00000000-0000-7000-8000-000000000002',
  templateKey: 'invoice.issued',
  channel: 'email',
  vendor: 'resend',
  locale: 'en',
  recipient: 'customer0042@example.com',
  senderId: null,
  subject: 'Your tax invoice INV-1042',
  body: 'Your tax invoice INV-1042 is attached.',
  bodyHtml:
    '<!doctype html><html lang="en"><body><p>Your tax invoice INV-1042 is attached.</p></body></html>',
  encoding: 'GSM-7',
  segments: 0,
  costFils: 0,
  status: 'failed',
  providerMessageId: 'resend-000001',
  attempts: 3,
  lastFailureReason: 'provider_rate_limited',
  lastFailureDetail: 'resend: Rate limit exceeded.',
  deliveredAtIso: null,
  failedAtIso: '2026-09-18T10:06:00.000Z',
  receipts: [],
}

function view(entries: readonly InboxEntry[], overrides: Partial<InboxView> = {}): InboxView {
  return {
    entries,
    filter: { templateKey: null, recipient: null, status: null, limit: 50 },
    smsProvider: 'fake',
    emailProvider: 'fake',
    ...overrides,
  }
}

describe('what the inbox shows for every send', () => {
  const html = renderInboxHtml(view([SMS, EMAIL]))

  it('names the body, encoding, segments, cost and status of each message', () => {
    expect(html).toContain('تم تأكيد موعدك')
    expect(html).toContain('UCS-2')
    expect(html).toContain('>Segments</dt><dd>1<')
    expect(html).toContain('9 fils')
    expect(html).toContain('delivered')
    // The email's own row, with the values that differ: no segments, no cost, three attempts.
    expect(html).toContain('>Segments</dt><dd>0<')
    expect(html).toContain('0 fils')
    expect(html).toContain('>Attempts</dt><dd>3<')
    expect(html).toContain('provider_rate_limited')
  })

  it('tells the status by word and not by colour alone', () => {
    // The dot is decoration and is hidden from assistive technology; the word is the signal.
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('dot dot-delivered')
    expect(html).toContain('>delivered</span>')
    expect(html).toContain('>failed</span>')
  })

  it('masks the recipient, because this page is screenshotted', () => {
    expect(html).toContain('…9069')
    expect(html).toContain('c***@example.com')
    // The controls: the full values are gone, not merely shortened somewhere else on the page.
    expect(html).not.toContain('+971528239069')
    expect(html).not.toContain('customer0042@example.com')
  })

  it('shows the provider id and the template version, so a receipt can be traced to a row', () => {
    expect(html).toContain('smsala-9f2c1a4b7e10')
    expect(html).toContain('booking.confirmed v1')
  })

  it('shows the vendor word of every receipt beside what it was read as', () => {
    expect(html).toContain('<code>DELIVRD</code>')
    expect(html).toContain('vendor_status_unrecognised')
    // The receipt that did apply is there too, so the table is not only the exceptions.
    expect(html).toContain('<code>delivered</code>')
    expect(html).toContain('applied')
  })

  it('says plainly that nothing left the building', () => {
    // docs/12 §1: a stub must never look like it worked. The banner is that sentence, and it names the
    // configured mode rather than asserting one.
    expect(html).toContain('Nothing here left the building')
    expect(html).toContain('<code>fake</code>')
    const real = renderInboxHtml(view([SMS], { smsProvider: 'real' }))
    expect(real).toContain('<code>real</code>')
  })

  it('totals the list, so the cost of a batch is one number', () => {
    expect(html).toContain('>Messages listed</dt><dd>2<')
    expect(html).toContain('>Billable segments</dt><dd>1<')
    expect(html).toContain('>Cost of the list</dt><dd>9 fils<')
  })
})

describe('the HTML preview pane', () => {
  it('renders a Resend email inside a sandboxed iframe, escaped', () => {
    const html = renderInboxHtml(view([EMAIL]))
    expect(html).toContain('<iframe class="preview" sandbox=""')
    expect(html).toContain('title="HTML preview of Your tax invoice INV-1042"')
    // Escaped into the attribute: the bytes Resend was given, displayed rather than executed.
    expect(html).toContain('srcdoc="&lt;!doctype html&gt;')
    // The control: the preview's markup is present, not dropped.
    expect(html).toContain('Your tax invoice INV-1042 is attached.')
  })

  it('does not inject the email markup into the admin document', () => {
    const hostile: InboxEntry = {
      ...EMAIL,
      bodyHtml: '<!doctype html><html><body><script>alert(1)</script></body></html>',
    }
    const html = renderInboxHtml(view([hostile]))
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('renders no pane for an SMS, which has no HTML part', () => {
    const html = renderInboxHtml(view([SMS]))
    expect(html).not.toContain('<iframe')
    // The control: the email in the same list does get one, so "no iframe" is about this row rather
    // than about a renderer that never emits one.
    expect(renderInboxHtml(view([EMAIL]))).toContain('<iframe')
  })

  it('says why a sent message has no receipt yet, rather than leaving a gap', () => {
    const awaiting = renderInboxHtml(view([{ ...SMS, status: 'sent', receipts: [] }]))
    expect(awaiting).toContain('smsala reports delivery asynchronously')
    const queued = renderInboxHtml(view([{ ...SMS, status: 'queued', receipts: [] }]))
    expect(queued).toContain('has not been handed to a vendor')
  })
})

describe('the states either side of a list', () => {
  it('renders the empty state as a designed state', () => {
    const html = renderInboxHtml(view([]))
    expect(html).toContain('No messages recorded yet')
    expect(html).toContain('nothing has been sent')
    // Not an empty container: the criterion this surface exists for is that an absent row is visible.
    expect(html).not.toContain('<ol class="messages"></ol>')
  })

  it('says when the list is filtered rather than short', () => {
    const html = renderInboxHtml(
      view([SMS], {
        filter: {
          templateKey: 'booking.confirmed',
          recipient: null,
          status: 'delivered',
          limit: 10,
        },
      }),
    )
    expect(html).toContain('template booking.confirmed')
    expect(html).toContain('status delivered')
    // The limit is stated whether or not anything is filtered: "showing 10" beside "there is 1" is how
    // a reader tells a short list from a truncated one.
    expect(html).toContain('newest 10')
    expect(renderInboxHtml(view([SMS]))).toContain('newest 50')
  })
})

describe('the document itself', () => {
  const html = renderInboxHtml(view([SMS, EMAIL]))

  it('is one English document that carries the tokens inline', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<html lang="en" dir="ltr">')
    // A route handler cannot reference the build's hashed stylesheet, so the token layer is emitted.
    // Asserted by a token name: an empty `<style>` would satisfy a substring check on `<style>`.
    expect(html).toContain('--color-ink:')
    expect(html).toContain('--space-5:')
    expect(html).toContain('prefers-color-scheme: dark')
  })

  it('declares itself noindex in the document as well as in the header', () => {
    // The header comes from the proxy, derived from the registry. This is the belt: a saved copy of the
    // page keeps the directive.
    expect(html).toContain('name="robots" content="noindex, nofollow, noarchive"')
  })

  it('renders identically twice, which is what a zero pixel diff needs', () => {
    // No clock, no random id, no relative time. A document that printed "as of now" could not produce
    // two identical screenshots on a repeat run.
    expect(renderInboxHtml(view([SMS, EMAIL]))).toBe(html)
    expect(html).not.toMatch(/ago|just now/)
  })

  it('formats every instant in Asia/Dubai, where the business is', () => {
    // 10:00 UTC is 14:00 in Dubai. A document that printed UTC would read as the middle of the night.
    expect(html).toContain('14:00 Dubai')
    expect(html).not.toContain('10:00 Dubai')
  })
})
