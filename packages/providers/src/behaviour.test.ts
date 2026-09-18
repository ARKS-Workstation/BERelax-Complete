import { parseConfig } from '@berelax/config'
import { aed } from '@berelax/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { BOUNCE_MARKER, COMPLAINT_MARKER } from './email/fake-resend.ts'
import { REVIEW_FIXTURES } from './google/fake-google.ts'
import { REFERENCE_MARKERS } from './payments/fake-gateway.ts'
import { createProviders, type Providers } from './registry.ts'
import { PROVISIONAL_COST_PER_SEGMENT_FILS, UNDELIVERABLE_SUFFIX } from './sms/fake-smsala.ts'

/**
 * What each fake gets *right about its real counterpart*.
 *
 * The conformance suite proves the rules hold across every provider. This one proves each fake is
 * worth having: a fake that satisfies the contract and behaves nothing like the service it stands in
 * for is a more expensive way of returning success.
 */

const CLOCK = '2026-09-18T10:00:00.000Z'
let providers: Providers

beforeEach(() => {
  providers = createProviders({
    config: parseConfig({ APP_ENV: 'test', DATABASE_URL: 'postgres://localhost/berelax_test' }),
    now: () => CLOCK,
  })
})

const transactional = { value: 'BERELAX', messageClass: 'transactional' } as const
const promotional = { value: 'AD-BERELAX', messageClass: 'promotional' } as const

describe('SMSala — the sender-ID rule that protects every booking confirmation', () => {
  it('refuses promotional content from the transactional sender ID', async () => {
    // One over-eager blast from the transactional identity risks its suspension, and with it every
    // OTP and every confirmation. See ADR 0016.
    await expect(
      providers.sms.send({
        recipient: '+971528239069',
        body: '20% off this weekend',
        senderId: transactional,
        messageClass: 'promotional',
        idempotencyKey: 'k1',
      }),
    ).rejects.toThrow()
    expect(providers.calls.forProvider('smsala')[0]?.outcome).toBe('failure')
  })

  it('refuses transactional content from the promotional sender ID as well', async () => {
    // The mirror case matters too: a booking confirmation carrying an AD- prefix reads as an advert
    // and is what customers block.
    await expect(
      providers.sms.send({
        recipient: '+971528239069',
        body: 'Your appointment is confirmed',
        senderId: promotional,
        messageClass: 'transactional',
        idempotencyKey: 'k2',
      }),
    ).rejects.toThrow()
  })
})

describe('SMSala — segment counting, which is what a campaign actually costs', () => {
  const send = (body: string, key: string) =>
    providers.sms.send({
      recipient: '+971528239069',
      body,
      senderId: promotional,
      messageClass: 'promotional',
      idempotencyKey: key,
    })

  it('bills an English message at 160 characters per segment', async () => {
    const accepted = await send('a'.repeat(160), 'en-1')
    expect(accepted.encoding).toBe('GSM-7')
    expect(accepted.segments).toBe(1)
    expect(accepted.estimatedCostFils).toBe(PROVISIONAL_COST_PER_SEGMENT_FILS)
  })

  it('bills an Arabic message at 70, so the same campaign costs more in Arabic', async () => {
    const english = await send('a'.repeat(140), 'en-2')
    const arabic = await send('م'.repeat(140), 'ar-1')
    expect(english.segments).toBe(1)
    expect(arabic.encoding).toBe('UCS-2')
    expect(arabic.segments).toBe(3)
    expect(arabic.estimatedCostFils).toBeGreaterThan(english.estimatedCostFils * 2)
  })

  it('reports which character forced UCS-2, so a composer can explain the cost', async () => {
    await send('Don’t miss this', 'smart-quote')
    const recorded = providers.calls.forProvider('smsala').at(-1)
    expect(recorded?.detail['forcedUnicodeBy']).toEqual(['’'])
  })
})

describe('SMSala — delivery is asynchronous, and sometimes it fails after being accepted', () => {
  it('accepts first and reports delivery later', async () => {
    const accepted = await providers.sms.send({
      recipient: '+971528239069',
      body: 'Confirmed',
      senderId: transactional,
      messageClass: 'transactional',
      idempotencyKey: 'dlr-1',
    })
    const receipts = await providers.sms.drainDeliveryReceipts()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.providerMessageId).toBe(accepted.providerMessageId)
    expect(receipts[0]?.status).toBe('delivered')
  })

  it('fails delivery for an unreachable handset, which is the case easiest to forget', async () => {
    await providers.sms.send({
      recipient: `+97152823${UNDELIVERABLE_SUFFIX}`,
      body: 'Confirmed',
      senderId: transactional,
      messageClass: 'transactional',
      idempotencyKey: 'dlr-2',
    })
    const [receipt] = await providers.sms.drainDeliveryReceipts()
    expect(receipt?.status).toBe('failed')
    expect(receipt?.reason).toBeDefined()
  })

  it('drains once; a second drain is empty', async () => {
    await providers.sms.send({
      recipient: '+971528239069',
      body: 'Confirmed',
      senderId: transactional,
      messageClass: 'transactional',
      idempotencyKey: 'dlr-3',
    })
    expect(await providers.sms.drainDeliveryReceipts()).toHaveLength(1)
    expect(await providers.sms.drainDeliveryReceipts()).toHaveLength(0)
  })

  it('does not bill a replayed idempotency key twice', async () => {
    const first = await providers.sms.send({
      recipient: '+971528239069',
      body: 'Confirmed',
      senderId: transactional,
      messageClass: 'transactional',
      idempotencyKey: 'same',
    })
    const second = await providers.sms.send({
      recipient: '+971528239069',
      body: 'Confirmed',
      senderId: transactional,
      messageClass: 'transactional',
      idempotencyKey: 'same',
    })
    expect(second.providerMessageId).toBe(first.providerMessageId)
    expect(await providers.sms.drainDeliveryReceipts()).toHaveLength(1)
  })

  it('masks the recipient in the log, which is shown on screen and in screenshots', async () => {
    await providers.sms.send({
      recipient: '+971528239069',
      body: 'Confirmed',
      senderId: transactional,
      messageClass: 'transactional',
      idempotencyKey: 'mask',
    })
    const summary = providers.calls.forProvider('smsala')[0]?.summary ?? ''
    expect(summary).not.toContain('+971528239069')
    expect(summary).toContain('9069')
  })
})

describe('Resend — suppression is the provider’s, and it is terminal', () => {
  const send = (address: string, key: string) =>
    providers.email.send({
      to: { address },
      from: { address: 'bookings@berelax.example' },
      subject: 'Your appointment',
      html: '<p>Confirmed</p>',
      text: 'Confirmed',
      messageClass: 'transactional',
      idempotencyKey: key,
    })

  it('suppresses an address after a hard bounce and refuses it afterwards', async () => {
    await send(`${BOUNCE_MARKER}@example.com`, 'b1')
    const [event] = await providers.email.drainEvents()
    expect(event?.type).toBe('bounced')
    expect(await providers.email.isSuppressed(`${BOUNCE_MARKER}@example.com`)).toBe(true)
    // Our own consent record says yes; the provider still refuses, and it is right to.
    await expect(send(`${BOUNCE_MARKER}@example.com`, 'b2')).rejects.toThrow()
  })

  it('suppresses on a spam complaint too', async () => {
    await send(`${COMPLAINT_MARKER}@example.com`, 'c1')
    const [event] = await providers.email.drainEvents()
    expect(event?.type).toBe('complained')
    expect(await providers.email.isSuppressed(`${COMPLAINT_MARKER}@example.com`)).toBe(true)
  })

  it('treats the address case-insensitively, so a capital letter does not bypass suppression', async () => {
    await send(`${BOUNCE_MARKER}@example.com`, 'b3')
    expect(await providers.email.isSuppressed(`${BOUNCE_MARKER.toUpperCase()}@Example.com`)).toBe(
      true,
    )
  })

  it('masks the address in the log', async () => {
    await send('ahmed.almansoori@example.com', 'm1')
    const summary = providers.calls.forProvider('resend')[0]?.summary ?? ''
    expect(summary).not.toContain('ahmed.almansoori')
    expect(summary).toContain('@example.com')
  })

  it('counts attachments, because an invoice PDF is not free', async () => {
    await providers.email.send({
      to: { address: 'customer@example.com' },
      from: { address: 'bookings@berelax.example' },
      subject: 'Your tax invoice',
      html: '<p>Attached</p>',
      text: 'Attached',
      messageClass: 'transactional',
      idempotencyKey: 'att-1',
      attachments: [
        {
          filename: 'tax-invoice.pdf',
          contentType: 'application/pdf',
          bytes: new Uint8Array(66_000),
        },
      ],
    })
    const summary = providers.calls.forProvider('resend')[0]?.summary ?? ''
    expect(summary).toContain('1 attachment')
    expect(summary).toContain('64KB')
  })
})

describe('Google Business Profile — the review shapes an autoresponder gets wrong', () => {
  it('includes star-only reviews, which have nothing to respond to', async () => {
    const reviews = await providers.businessProfile.listReviews('locations/1')
    const starOnly = reviews.filter((review) => review.comment === undefined)
    expect(starOnly.length).toBeGreaterThanOrEqual(2)
    expect(starOnly.map((review) => review.rating)).toContain(1)
  })

  it('covers every star rating, so no branch is untested', async () => {
    const reviews = await providers.businessProfile.listReviews('locations/1')
    const ratings = new Set(reviews.map((review) => review.rating))
    expect([...ratings].sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('includes an Arabic review, which must be answered in Arabic', async () => {
    const arabic = REVIEW_FIXTURES.find((review) => review.reviewId === 'rev-5-ar')
    expect(arabic?.comment).toMatch(/[؀-ۿ]/)
  })

  it('includes a review naming a therapist, which must never be auto-sent', async () => {
    const named = REVIEW_FIXTURES.find((review) => review.reviewId === 'rev-2-names-staff')
    expect(named?.comment).toContain('Mina')
  })

  it('overwrites rather than appends, because the real API has no separate create', async () => {
    await providers.businessProfile.updateReply({
      locationId: 'locations/1',
      reviewId: 'rev-5-en',
      comment: 'Thank you.',
    })
    await providers.businessProfile.updateReply({
      locationId: 'locations/1',
      reviewId: 'rev-5-en',
      comment: 'Thank you very much.',
    })
    const summaries = providers.calls
      .forProvider('google-business-profile')
      .map((call) => call.summary)
    expect(summaries.at(-1)).toContain('overwrote an existing reply')
  })

  it('rejects a reply to a review that does not exist', async () => {
    await expect(
      providers.businessProfile.updateReply({
        locationId: 'locations/1',
        reviewId: 'nope',
        comment: 'Hello',
      }),
    ).rejects.toThrow()
  })
})

describe('Search Console — the rare-query gap, which no report should silently reconcile', () => {
  const range = {
    siteUrl: 'https://berelax.example',
    startDate: '2026-09-01',
    endDate: '2026-09-15',
  }

  it('returns fewer clicks in the rows than the site total', async () => {
    // Search Console withholds queries too rare to be anonymous. A report that sums the rows and
    // calls it the total will disagree with the UI, and the difference is not a bug.
    const rows = await providers.searchConsole.queryAnalytics(range)
    const totals = await providers.searchConsole.totalsFor(range)
    const inRows = rows.reduce((total, row) => total + row.clicks, 0)
    expect(inRows).toBeLessThan(totals.clicks)
  })

  it('has a realistic shape: brand queries rank well, the tail does not', async () => {
    const rows = await providers.searchConsole.queryAnalytics(range)
    const brand = rows.find((row) => row.query.includes('be relax'))
    const tail = rows.find((row) => row.query.includes('moroccan bath'))
    expect(brand?.position ?? 99).toBeLessThan(2)
    expect(tail?.position ?? 0).toBeGreaterThan(10)
    expect(tail?.impressions ?? 0).toBeGreaterThan(brand?.impressions ?? 0)
  })

  it('honours rowLimit, as the real API does', async () => {
    const rows = await providers.searchConsole.queryAnalytics({ ...range, rowLimit: 2 })
    expect(rows).toHaveLength(2)
  })
})

describe('the card gateway — the paths a checkout actually has to handle', () => {
  const create = (reference: string, key: string) =>
    providers.cards.createIntent({
      amount: aed(350),
      method: 'card_online',
      idempotencyKey: key,
      reference,
    })

  it('returns requires_action for a 3DS challenge, settling nothing', async () => {
    const intent = await create(`BK-1${REFERENCE_MARKERS.requiresAction}`, 'a1')
    expect(intent.status).toBe('requires_action')
    expect(intent.actionUrl).toBeDefined()
    expect(intent.settledAtIso).toBeUndefined()
  })

  it('fails outright on a decline, and emits the event', async () => {
    const intent = await create(`BK-2${REFERENCE_MARKERS.declined}`, 'd1')
    expect(intent.status).toBe('failed')
    const events = await providers.cards.drainEvents()
    expect(events.some((event) => event.type === 'payment.failed')).toBe(true)
    await expect(providers.cards.confirmIntent(intent.intentId)).rejects.toThrow()
  })

  it('replays every event, because every real gateway does', async () => {
    const intent = await create('BK-3', 'r1')
    await providers.cards.confirmIntent(intent.intentId)
    const events = await providers.cards.drainEvents()
    const ids = events.map((event) => event.eventId)
    // A system that only ever sees one copy of an event has an idempotency bug it has not met yet.
    expect(ids.length).toBeGreaterThan(new Set(ids).size)
  })

  it('opens a dispute against a settled intent nobody is watching', async () => {
    const intent = await create(`BK-4${REFERENCE_MARKERS.disputed}`, 'x1')
    await providers.cards.confirmIntent(intent.intentId)
    const events = await providers.cards.drainEvents()
    expect(events.some((event) => event.type === 'dispute.opened')).toBe(true)
  })

  it('refunds partially, and accumulates', async () => {
    const intent = await create('BK-5', 'p1')
    await providers.cards.confirmIntent(intent.intentId)
    await providers.cards.refund({
      intentId: intent.intentId,
      amount: aed(100),
      reason: 'one treatment cancelled',
    })
    await providers.cards.refund({
      intentId: intent.intentId,
      amount: aed(200),
      reason: 'second treatment cancelled',
    })
    await expect(
      providers.cards.refund({ intentId: intent.intentId, amount: aed(100), reason: 'too much' }),
    ).rejects.toThrow()
  })

  it('refuses to refund an intent that never settled', async () => {
    const intent = await create(`BK-6${REFERENCE_MARKERS.requiresAction}`, 'u1')
    await expect(
      providers.cards.refund({ intentId: intent.intentId, amount: aed(10), reason: 'no' }),
    ).rejects.toThrow(/has not settled/)
  })

  it('refuses cash, which belongs to the till adapter', async () => {
    await expect(
      providers.cards.createIntent({
        amount: aed(350),
        method: 'cash',
        idempotencyKey: 'cash-1',
        reference: 'BK-7',
      }),
    ).rejects.toThrow(/card gateway takes/)
  })
})

describe('the till adapter — real, and deliberately narrow', () => {
  it('settles immediately, because money at the desk has no pending state', async () => {
    const intent = await providers.till.createIntent({
      amount: aed(350),
      method: 'cash',
      idempotencyKey: 't1',
      reference: 'BK-8',
    })
    expect(intent.status).toBe('succeeded')
    expect(intent.settledAtIso).toBe(CLOCK)
  })

  it('emits no asynchronous events, because cash does not settle later', async () => {
    await providers.till.createIntent({
      amount: aed(350),
      method: 'cash',
      idempotencyKey: 't2',
      reference: 'BK-9',
    })
    expect(await providers.till.drainEvents()).toHaveLength(0)
  })

  it('refuses an online card, which belongs to a gateway', async () => {
    await expect(
      providers.till.createIntent({
        amount: aed(350),
        method: 'card_online',
        idempotencyKey: 't3',
        reference: 'BK-10',
      }),
    ).rejects.toThrow(/manual till adapter takes/)
  })

  it('refuses to refund more than was taken', async () => {
    const intent = await providers.till.createIntent({
      amount: aed(350),
      method: 'cash',
      idempotencyKey: 't4',
      reference: 'BK-11',
    })
    await expect(
      providers.till.refund({ intentId: intent.intentId, amount: aed(400), reason: 'oops' }),
    ).rejects.toThrow(/exceeds/)
  })
})

describe('the LLM fake — deterministic, and it refuses the right things', () => {
  const complete = (prompt: string, key: string, locale: 'en' | 'ar' = 'en') =>
    providers.llm.complete({
      purpose: 'review_reply',
      prompt,
      locale,
      maxOutputTokens: 200,
      idempotencyKey: key,
    })

  it('returns the same text for the same prompt, so screenshots do not diff', async () => {
    const first = await complete('Reply to a five-star review about the room', 'd1')
    const second = await complete('Reply to a five-star review about the room', 'd2')
    expect(first.kind).toBe('completion')
    expect(second).toMatchObject({ kind: 'completion' })
    if (first.kind === 'completion' && second.kind === 'completion') {
      expect(second.text).toBe(first.text)
    }
  })

  it('answers an Arabic review in Arabic', async () => {
    const outcome = await complete('Reply to an Arabic five-star review', 'ar-1', 'ar')
    expect(outcome.kind).toBe('completion')
    if (outcome.kind === 'completion') expect(outcome.text).toMatch(/[؀-ۿ]/)
  })

  it('refuses a review alleging a double charge', async () => {
    // Not because a model would write something offensive. A public reply to an allegation about
    // money is a legal statement, and it belongs in front of a person.
    const outcome = await complete(
      'Reply: "They charged my card twice and refused to refund."',
      'r1',
    )
    expect(outcome.kind).toBe('refusal')
    if (outcome.kind === 'refusal') expect(outcome.reason).toMatch(/money/i)
  })

  it('refuses a review alleging physical harm', async () => {
    const outcome = await complete('Reply: "The therapist burned my back with the hot oil."', 'r2')
    expect(outcome.kind).toBe('refusal')
  })

  it('refuses anything raising a legal process', async () => {
    const outcome = await complete('Reply: "I am speaking to my lawyer about this."', 'r3')
    expect(outcome.kind).toBe('refusal')
  })

  it('records a refusal as a successful call, because refusing is the model working', async () => {
    await complete('Reply: "They charged me twice."', 'r4')
    const recorded = providers.calls.forProvider('fake-llm').at(-1)
    expect(recorded?.outcome).toBe('success')
    expect(recorded?.detail['refused']).toBe(true)
  })

  it('accounts for tokens, so the monthly budget is measurable rather than aspirational', async () => {
    const before = await providers.llm.usage()
    await complete('Reply to a four-star review', 'u1')
    const after = await providers.llm.usage()
    expect(after.inputTokens).toBeGreaterThan(before.inputTokens)
    expect(after.outputTokens).toBeGreaterThan(before.outputTokens)
  })

  it('does not spend the budget twice on a retried job', async () => {
    await complete('Reply to a three-star review', 'same-key')
    const afterFirst = await providers.llm.usage()
    await complete('Reply to a three-star review', 'same-key')
    expect(await providers.llm.usage()).toEqual(afterFirst)
  })
})
