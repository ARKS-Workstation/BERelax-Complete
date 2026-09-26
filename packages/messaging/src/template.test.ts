/**
 * C-AUTO-01 — per-channel variants, the approval state a send refuses, and the 24-hour care window.
 *
 * Four acceptance criteria are proved here, and every one of them is proved by an **attempted send that
 * was refused** rather than by the absence of a call:
 *
 *   - "A template with an sms variant and no whatsapp variant refuses a whatsapp send with typed
 *     'no_variant' rather than reusing the sms body";
 *   - "A whatsapp send outside the 24-hour care window with no approved template returns typed
 *     'outside_care_window'; inside the window the free-form path is permitted - both asserted with a
 *     frozen clock";
 *   - "A template in 'draft' or 'rejected' cannot be sent, asserted for both message classes";
 *   - and the half of the sender-identity criterion that is about a send rather than a lookup.
 *
 * ## Why "cannot be sent" is asserted as a refusal and never as a missing call
 *
 * The tempting shape is `expect(transport.calls).toHaveLength(0)`, and it is worth nothing on its own: a
 * test that never built a request, a harness whose transport was not wired, a template key that does not
 * exist and a working refusal all produce exactly zero calls. So every case below asserts the RESULT —
 * `kind: 'blocked'` with the named reason — and the zero-call assertion sits beside it as the second
 * half, never as the whole. Each block also carries the positive control: the same template, approved,
 * IS sent and DOES log one call.
 *
 * ## Why the clock is frozen and the care window is injected
 *
 * `fixedClock` gives the send path one instant, and the last inbound WhatsApp message is supplied as
 * another. The window is then a comparison between two stated numbers rather than a race with the
 * machine's clock, and the interesting instants — one millisecond inside the window, and exactly on the
 * 24-hour boundary — are reachable at all.
 */
import { type AppEnv, parseConfig } from '@berelax/config'
import { fixedClock, type Instant, instantFromIso } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { TDRA_PROMOTIONAL_WINDOW } from './gate/index.ts'
import { InMemoryOutbox } from './outbox.ts'
import type { MessageId } from './port.ts'
import {
  type ClassifiedTemplate,
  type ClassRoutedTransport,
  type SendContext,
  type SendResult,
  sendMessage,
  type TransportRequest,
} from './send.ts'
import { PROVISIONAL_SENDER_IDS } from './sender-identity.ts'
import {
  type CareWindowState,
  careWindow,
  classifyTemplateRow,
  type MessageTemplate,
  resolveVariant,
  type TemplateVariant,
  WHATSAPP_CARE_WINDOW_HOURS,
} from './template.ts'

/** 14:00 Asia/Dubai: trading, and well inside the promotional window, so timing decides nothing here. */
const NOW_ISO = '2026-09-18T10:00:00.000Z'
const NOW = instantFromIso(NOW_ISO)
const RECIPIENT = '+971528239069'
const HOUR_MS = 60 * 60 * 1000

const at = (iso: string): Instant => instantFromIso(iso)

const smsVariant = (overrides: Partial<TemplateVariant> = {}): TemplateVariant => ({
  key: 'cauto01.template',
  channel: 'sms',
  locale: 'en',
  body: 'Booking confirmed for {{date}}.',
  variables: ['date'],
  approvalState: 'approved',
  ...overrides,
})

const templateWith = (
  variants: readonly TemplateVariant[],
  messageClass: 'transactional' | 'promotional' = 'transactional',
): MessageTemplate => ({
  templateId: '00000000-0000-7000-8000-0000000c0a01',
  key: 'cauto01.template',
  messageClass,
  variants,
})

const NEVER_WROTE_IN: CareWindowState = { lastInboundAt: null }

// --- the send harness ----------------------------------------------------------------------------

interface Harness {
  readonly ctx: SendContext
  readonly calls: TransportRequest[]
}

function harness(options: { care?: CareWindowState; channel?: 'sms' | 'whatsapp' } = {}): Harness {
  const calls: TransportRequest[] = []
  const transport: ClassRoutedTransport = {
    channel: options.channel ?? 'sms',
    async send(request) {
      calls.push(request)
      return {
        kind: 'accepted',
        providerMessageId: `fake-${calls.length}`,
        segments: 1,
        costFils: 9,
      }
    },
  }
  const config = parseConfig({
    APP_ENV: 'production' as AppEnv,
    DATABASE_URL: 'postgres://localhost:5432/x',
  })
  const ctx: SendContext = {
    appEnv: config.APP_ENV,
    // Allowlisted, so the staging guard never diverts and a `blocked` result is always the template's
    // or the identity's doing rather than the environment's.
    outboundAllowlist: [RECIPIENT],
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [transport],
    outbox: new InMemoryOutbox(),
    clock: fixedClock(NOW_ISO),
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      evaluators: {
        hasConsent: () => true,
        isSuppressed: () => false,
        frequencyCapReached: () => false,
      },
    },
    ...(options.care === undefined ? {} : { care: options.care }),
  }
  return { ctx, calls }
}

const send = async (
  h: Harness,
  template: ClassifiedTemplate,
  id = 'cauto01-1',
): Promise<SendResult> =>
  await sendMessage(h.ctx, {
    id: id as MessageId,
    template,
    values: { date: '18 Sep' },
    recipient: RECIPIENT,
  })

const classified = (
  variant: TemplateVariant,
  messageClass: 'transactional' | 'promotional' = 'transactional',
): ClassifiedTemplate => ({ ...variant, messageClass })

// --- per-channel variants -------------------------------------------------------------------------

describe('acceptance — a template with no variant for a channel refuses rather than reusing one', () => {
  it("returns 'no_variant' for a whatsapp send of an sms-only template", () => {
    const template = templateWith([smsVariant()])
    const resolved = resolveVariant({
      template,
      channel: 'whatsapp',
      locale: 'en',
      at: NOW,
      care: NEVER_WROTE_IN,
    })
    expect(resolved).toMatchObject({ kind: 'refused', reason: 'no_variant' })
  })

  it('does not reuse the sms body, which is the failure that would look like a success', () => {
    const resolved = resolveVariant({
      template: templateWith([smsVariant()]),
      channel: 'whatsapp',
      locale: 'en',
      at: NOW,
      care: NEVER_WROTE_IN,
    })
    // An SMS body pushed down WhatsApp renders, delivers and is reported as delivered. The only way to
    // see it is to assert that the words did not travel.
    expect(JSON.stringify(resolved)).not.toContain('Booking confirmed')
  })

  it('resolves the variant that IS there, so the refusal above is about the channel', () => {
    // The control: a resolver that refused every channel would satisfy both cases above.
    const resolved = resolveVariant({
      template: templateWith([smsVariant()]),
      channel: 'sms',
      locale: 'en',
      at: NOW,
      care: NEVER_WROTE_IN,
    })
    expect(resolved).toMatchObject({ kind: 'variant' })
  })

  it('never crosses locales either: an ar-only template refuses an en send', () => {
    const resolved = resolveVariant({
      template: templateWith([smsVariant({ locale: 'ar', body: 'تم تأكيد حجزك' })]),
      channel: 'sms',
      locale: 'en',
      at: NOW,
      care: NEVER_WROTE_IN,
    })
    // A locale fallback reminds an Arabic-speaking customer in English and tells them the system does
    // not remember them. `message_template_variant` is UNIQUE on (template, channel, locale) precisely
    // so there is one answer or none.
    expect(resolved).toMatchObject({ kind: 'refused', reason: 'no_variant' })
  })
})

// --- approval -------------------------------------------------------------------------------------

describe('acceptance — a template in draft or rejected cannot be sent, for both classes', () => {
  for (const messageClass of ['transactional', 'promotional'] as const) {
    for (const approvalState of ['draft', 'rejected', 'pending'] as const) {
      it(`refuses a ${messageClass} ${approvalState} template at the send, with a reason`, async () => {
        const h = harness()
        const result = await send(h, classified(smsVariant({ approvalState }), messageClass))

        // The refusal itself, first. An assertion about the call log alone would pass for a test that
        // never built a request.
        expect(result).toMatchObject({ kind: 'blocked', reason: 'template_not_approved' })
        // …and then the consequence: nothing reached the vendor.
        expect(h.calls).toHaveLength(0)
      })
    }

    it(`sends the same ${messageClass} template once it is approved`, async () => {
      // The positive control for the six cases above, per class. Without it, a harness whose transport
      // was never wired would report every one of them as a pass.
      const h = harness()
      const result = await send(
        h,
        classified(smsVariant({ approvalState: 'approved' }), messageClass),
      )
      expect(result.kind).toBe('sent')
      expect(h.calls).toHaveLength(1)
    })
  }

  it('names the state it refused, so the repair is visible without reading the row', () => {
    const resolved = resolveVariant({
      template: templateWith([smsVariant({ approvalState: 'rejected' })]),
      channel: 'sms',
      locale: 'en',
      at: NOW,
      care: NEVER_WROTE_IN,
    })
    expect(resolved).toMatchObject({
      kind: 'refused',
      reason: 'template_not_approved',
      approvalState: 'rejected',
    })
  })
})

// --- the 24-hour customer-care window ---------------------------------------------------------------

describe('the care window is a state, under a frozen clock', () => {
  const lastInbound = at('2026-09-18T00:00:00.000Z')

  it('is open inside 24 hours and shut at the boundary', () => {
    expect(careWindow({ lastInboundAt: lastInbound }, NOW)).toBe('open')
    // One millisecond before the 24-hour mark, and exactly on it. Half-open on purpose: a boundary that
    // counted the mark as open would put every on-the-hour job on the wrong side of the rule.
    expect(
      careWindow(
        { lastInboundAt: lastInbound },
        (lastInbound + WHATSAPP_CARE_WINDOW_HOURS * HOUR_MS - 1) as Instant,
      ),
    ).toBe('open')
    expect(
      careWindow(
        { lastInboundAt: lastInbound },
        (lastInbound + WHATSAPP_CARE_WINDOW_HOURS * HOUR_MS) as Instant,
      ),
    ).toBe('closed')
  })

  it('is shut for a contact who has never written in, which is every contact in this build', () => {
    expect(careWindow(NEVER_WROTE_IN, NOW)).toBe('closed')
  })
})

describe('acceptance — whatsapp outside the care window, and inside it', () => {
  const whatsappVariant = (approvalState: TemplateVariant['approvalState']): TemplateVariant =>
    smsVariant({
      channel: 'whatsapp',
      approvalState,
      body: 'Your booking is confirmed.',
      variables: [],
    })

  it("refuses with 'outside_care_window' when there is no approved template and the window is shut", async () => {
    const h = harness({ channel: 'whatsapp', care: NEVER_WROTE_IN })
    const result = await send(h, classified(whatsappVariant('draft')))

    expect(result).toMatchObject({ kind: 'blocked', reason: 'outside_care_window' })
    expect(h.calls).toHaveLength(0)
  })

  it('permits the free-form path inside the window, for the same unapproved words', async () => {
    // The same template and the same clock; only the last inbound instant moves. That is what makes
    // this a test of the window rather than of the approval state, which the case above already covers.
    const care = { lastInboundAt: (NOW - 2 * HOUR_MS) as Instant }

    // The permission itself: the words may go as free-form, and the resolution says when the window
    // shuts so a caller can say how long it has.
    expect(
      resolveVariant({
        template: templateWith([whatsappVariant('draft')]),
        channel: 'whatsapp',
        locale: 'en',
        at: NOW,
        care,
      }),
    ).toMatchObject({ kind: 'free_form' })

    // And through the choke point, where the honest answer today is a refusal for a DIFFERENT reason.
    // WhatsApp has no contracted vendor and therefore no registered sender identity (ADR 0016;
    // `vendorFor('whatsapp')` refuses it too), so `resolveSenderIdentity` answers
    // `sender_identity_not_registered` a step later. The assertion that matters is which reason comes
    // back: the window is NOT what stops this send, and the day a vendor is contracted this send starts
    // working with no change to the rule above.
    const h = harness({ channel: 'whatsapp', care })
    const result = await send(h, classified(whatsappVariant('draft')))
    expect(result).toMatchObject({
      kind: 'blocked',
      reason: 'sender_identity_not_registered',
    })
  })

  it('sends an APPROVED whatsapp template as far as the missing vendor, in or out of the window', async () => {
    // What approval buys, and the control that the two cases above are about the window rather than
    // about the channel being unreachable: an approved variant is never refused for the window, whether
    // the customer wrote in or not.
    for (const care of [NEVER_WROTE_IN, { lastInboundAt: (NOW - HOUR_MS) as Instant }]) {
      expect(
        resolveVariant({
          template: templateWith([whatsappVariant('approved')]),
          channel: 'whatsapp',
          locale: 'en',
          at: NOW,
          care,
        }),
      ).toMatchObject({ kind: 'variant' })

      const h = harness({ channel: 'whatsapp', care })
      const result = await send(h, classified(whatsappVariant('approved')))
      expect(result).toMatchObject({
        kind: 'blocked',
        reason: 'sender_identity_not_registered',
      })
      expect(h.calls).toHaveLength(0)
    }
  })

  it('reports the template rule before the missing vendor, because that is the actionable one', async () => {
    // The ORDER is load-bearing and is asserted rather than left to the reading. `sendMessage` judges
    // the variant first, so an unapproved WhatsApp template outside the window reports
    // `outside_care_window` and not `sender_identity_not_registered` — the first is something the
    // operator can act on today (get it approved, or wait for the customer), the second is an external
    // dependency they cannot. Both are true; the useful one is returned.
    const h = harness({ channel: 'whatsapp', care: NEVER_WROTE_IN })
    const result = await send(h, classified(whatsappVariant('draft')))
    expect(result).toMatchObject({ kind: 'blocked', reason: 'outside_care_window' })
  })

  it('reports when an open window shuts, so a caller can say how long it has', () => {
    const lastInboundAt = (NOW - 2 * HOUR_MS) as Instant
    const resolved = resolveVariant({
      template: templateWith([whatsappVariant('pending')]),
      channel: 'whatsapp',
      locale: 'en',
      at: NOW,
      care: { lastInboundAt },
    })
    expect(resolved).toMatchObject({
      kind: 'free_form',
      careWindowClosesAtIso: new Date(
        lastInboundAt + WHATSAPP_CARE_WINDOW_HOURS * HOUR_MS,
      ).toISOString(),
    })
  })

  it('refuses a bare free-form reply with no template when the window is shut', () => {
    expect(
      resolveVariant({
        template: null,
        channel: 'whatsapp',
        locale: 'en',
        at: NOW,
        care: NEVER_WROTE_IN,
      }),
    ).toMatchObject({ kind: 'refused', reason: 'outside_care_window' })
  })

  it('permits a bare free-form reply inside the window', () => {
    expect(
      resolveVariant({
        template: null,
        channel: 'whatsapp',
        locale: 'en',
        at: NOW,
        care: { lastInboundAt: (NOW - HOUR_MS) as Instant },
      }),
    ).toMatchObject({ kind: 'free_form', variant: null })
  })

  it('has no free-form path on sms or email, in or out of any window', () => {
    // The window is WhatsApp's rule and must not leak. An SMS with no template has nothing to render
    // and no row to point `message.template_id` at.
    for (const channel of ['sms', 'email'] as const) {
      expect(
        resolveVariant({
          template: null,
          channel,
          locale: 'en',
          at: NOW,
          care: { lastInboundAt: (NOW - HOUR_MS) as Instant },
        }),
      ).toMatchObject({ kind: 'refused', reason: 'no_template' })
    }
  })
})

// --- the choke point's default ---------------------------------------------------------------------

describe('a SendContext that says nothing about the care window gets the restrictive answer', () => {
  it('treats an absent care window as shut', async () => {
    const h = harness({ channel: 'whatsapp' })
    const result = await send(
      h,
      classified(smsVariant({ channel: 'whatsapp', approvalState: 'pending' })),
    )
    // An optional field whose default permitted a free-form send would be the permissive default this
    // whole unit is about: every context written before WhatsApp existed would silently allow one.
    expect(result).toMatchObject({ kind: 'blocked', reason: 'outside_care_window' })
    expect(h.calls).toHaveLength(0)
  })
})

// --- from a row to a template -----------------------------------------------------------------------

describe('classifyTemplateRow reads the class off the row and refuses a label it cannot read', () => {
  const row = {
    templateKey: 'booking.reminder',
    messageClass: 'promotional',
    channel: 'sms',
    locale: 'en',
    subject: null,
    body: 'Reminder: your booking tomorrow at {{time}}.',
    variables: ['time'],
    approvalState: 'approved',
    customerCareWindow: false,
    category: null,
  }

  it('carries the row class through, rather than the one the call site expected', () => {
    // The defect this function exists for: the reminder worker built its request with the literal
    // `messageClass: 'transactional'`, which is true of `booking.reminder` TODAY. Reclassify it and the
    // literal is a promotional message sent from the transactional identity with every gate skipped,
    // because `evaluateGate` returns `allow` on its first line for a message that says it is
    // transactional.
    const classified = classifyTemplateRow(row)
    expect(classified.kind).toBe('template')
    if (classified.kind !== 'template') return
    expect(classified.template.messageClass).toBe('promotional')
    expect(classified.template.approvalState).toBe('approved')
    expect(classified.template.channel).toBe('sms')
  })

  it('reads a transactional row as transactional, so the case above is about the row', () => {
    // The control: a function that answered `promotional` for everything would satisfy it.
    const classified = classifyTemplateRow({ ...row, messageClass: 'transactional' })
    expect(classified.kind).toBe('template')
    if (classified.kind !== 'template') return
    expect(classified.template.messageClass).toBe('transactional')
  })

  for (const [column, value] of [
    ['messageClass', 'marketing'],
    ['channel', 'telegram'],
    ['approvalState', 'signed_off'],
    ['locale', 'fr'],
  ] as const) {
    it(`refuses a row whose ${column} holds a label this build cannot read`, () => {
      const classified = classifyTemplateRow({ ...row, [column]: value })
      expect(classified.kind).toBe('unreadable')
      if (classified.kind !== 'unreadable') return
      // Named, and the value carried. A strict FALLBACK — promotional, draft — would be the more
      // restricted reading and still the wrong answer, because it is silent: the caller records an
      // ordinary refusal and nobody learns that a column holds a label nothing here understands.
      expect(classified.value).toBe(value)
      expect(classified.detail).toContain(value)
    })
  }

  it('omits the subject rather than carrying a null one, so an SMS has nowhere to put one', () => {
    const classified = classifyTemplateRow(row)
    if (classified.kind !== 'template') throw new Error('expected a template')
    expect('subject' in classified.template).toBe(false)
    // And an email row keeps its subject: `message_email_carries_both_parts` refuses a row without one.
    const email = classifyTemplateRow({
      ...row,
      channel: 'email',
      subject: 'Your tax invoice {{invoice_number}}',
    })
    if (email.kind !== 'template') throw new Error('expected a template')
    expect(email.template.subject).toBe('Your tax invoice {{invoice_number}}')
  })
})
