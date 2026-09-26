/**
 * The durable lifecycle, against the real fakes and an in-memory store.
 *
 * What is proved here is everything that is arithmetic over a clock and a policy: exact attempt counts
 * per failure mode, the declared backoff, and which outcomes record a row at all. What is *not* here is
 * every claim about the database — the constraints, the no-regression trigger, the replay guard as an
 * index — because those are the schema's and are asserted against real PostgreSQL in
 * `packages/fixtures/src/message-lifecycle.itest.ts`.
 *
 * The clock is mutable and `waitUntil` advances it. A suite that really waited sixty seconds for the
 * first retry is a suite nobody runs, and a backoff nobody runs is a backoff nobody has seen work.
 */
import { parseConfig } from '@berelax/config'
import { type Clock, type Instant, instantFromIso, MESSAGE_RETRY_POLICY } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { TDRA_PROMOTIONAL_WINDOW } from './gate/index.ts'
import {
  type DeliveryDeps,
  deliverMessage,
  MAX_ATTEMPTS_ANY_POLICY,
  MESSAGE_VENDORS,
  type RecordedSendRequest,
  vendorFor,
} from './lifecycle.ts'
import { createInMemoryMessageStore } from './lifecycle-memory.ts'
import { InMemoryOutbox } from './outbox.ts'
import type { MessageId } from './port.ts'
import type { ClassifiedTemplate, SendContext, SendRequest } from './send.ts'
import { PROVISIONAL_SENDER_IDS } from './sender-identity.ts'
import { DEFAULT_TEMPLATES } from './templates.ts'
import { createResendTransport } from './transports/resend.ts'
import { createSmsalaTransport } from './transports/smsala.ts'

/** 14:00 Asia/Dubai: trading, and inside the promotional window. */
const AFTERNOON = '2026-09-18T10:00:00.000Z'
/** 01:00 Asia/Dubai: open for business, and four hours after the promotional window shut. */
const ONE_AM = '2026-09-18T21:00:00.000Z'
const RECIPIENT = '+971528239069'
/** The number the SMSala fake reports undeliverable after accepting it. */
const UNDELIVERABLE = '+971520000000'

/**
 * A marked placeholder, not a plausible address.
 *
 * The verified Resend sending domain is OPEN-QUESTIONS Y6-email-sender. `.invalid` is reserved by
 * RFC 2606 so it can never become real, and the local part carries a marker `is_placeholder_text`
 * recognises — a `noreply@berelaxmassage.com` here would be indistinguishable from a configured value.
 */
const FROM = { address: 'not-configured@example.invalid', name: 'BE RELAX (sender not configured)' }

function templateFor(key: string, locale: 'en' | 'ar' = 'en'): ClassifiedTemplate {
  const found = DEFAULT_TEMPLATES.find((t) => t.key === key && t.locale === locale)
  if (found === undefined) throw new Error(`No shipped template ${key}/${locale}`)
  return found
}

const CONFIRMED = templateFor('booking.confirmed')
const CONFIRMED_AR = templateFor('booking.confirmed', 'ar')
const INVOICE_EMAIL = templateFor('invoice.issued')
const OFFER: ClassifiedTemplate = {
  key: 'campaign.offer',
  messageClass: 'promotional',
  approvalState: 'approved',
  channel: 'sms',
  locale: 'en',
  body: 'Two treatments for the price of one this week. Stop: {{link}}',
  variables: ['link'],
}

const SAMPLE: Readonly<Record<string, string>> = {
  date: '19 Sep',
  time: '21:00',
  link: 'https://be.relax/b/7',
  code: '481920',
  minutes: '5',
  invoice_number: 'INV-1042',
  total: 'AED 315.00',
}

let sequence = 0
function requestFor(
  template: ClassifiedTemplate,
  recipient = RECIPIENT,
): RecordedSendRequest & SendRequest {
  sequence += 1
  return {
    id: `msg-${sequence}` as MessageId,
    templateId: `00000000-0000-0000-0000-${String(sequence).padStart(12, '0')}`,
    template,
    values: Object.fromEntries(template.variables.map((name) => [name, SAMPLE[name] ?? 'x'])),
    recipient,
  }
}

interface Harness {
  readonly deps: DeliveryDeps
  readonly store: ReturnType<typeof createInMemoryMessageStore>
  readonly sms: ReturnType<typeof createSmsalaTransport>
  readonly email: ReturnType<typeof createResendTransport>
  /** Every instant `waitUntil` was asked to wait for, in order. */
  readonly waits: string[]
  nowIso(): string
}

function harness(
  options: { readonly nowIso?: string; readonly allowlist?: string[] } = {},
): Harness {
  let nowIso = options.nowIso ?? AFTERNOON
  const config = parseConfig({
    APP_ENV: 'production',
    DATABASE_URL: 'postgres://localhost/berelax_test',
    OUTBOUND_ALLOWLIST: (options.allowlist ?? []).join(','),
  })
  const sms = createSmsalaTransport({ config, now: () => nowIso })
  const email = createResendTransport({ config, now: () => nowIso, from: FROM })
  const store = createInMemoryMessageStore()
  const waits: string[] = []
  const clock: Clock = { now: () => instantFromIso(nowIso) as Instant }
  const send: SendContext = {
    appEnv: 'production',
    outboundAllowlist: config.OUTBOUND_ALLOWLIST,
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [sms.transport, email.transport],
    outbox: new InMemoryOutbox(),
    clock,
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      evaluators: {
        hasConsent: () => true,
        isSuppressed: () => false,
        frequencyCapReached: () => false,
      },
    },
  }
  return {
    deps: {
      store,
      send,
      waitUntil: async (iso: string) => {
        waits.push(iso)
        // The whole reason it is injected: the retry runs against a clock the test moves, so the
        // declared waits are asserted rather than slept through.
        nowIso = iso
      },
    },
    store,
    sms,
    email,
    waits,
    nowIso: () => nowIso,
  }
}

describe('a send that succeeds', () => {
  it('records the row the acceptance criterion asks to be visible', async () => {
    const h = harness()
    const outcome = await deliverMessage(h.deps, requestFor(CONFIRMED))
    expect(outcome.kind).toBe('sent')
    if (outcome.kind !== 'sent') return
    const row = h.store.byId(outcome.message.id)
    expect(row).toBeDefined()
    expect(row?.status).toBe('sent')
    expect(row?.attempts).toBe(1)
    expect(row?.providerMessageId).toMatch(/^smsala-[0-9a-f]{12}$/)
    expect(row?.message.encoding).toBe('GSM-7')
    expect(row?.message.segments).toBeGreaterThanOrEqual(1)
    expect(row?.message.costFils).toBeGreaterThanOrEqual(1)
    expect(row?.message.body).toContain('19 Sep')
    expect(row?.message.vendor).toBe('smsala')
    expect(row?.message.senderId).toBe('BERELAX')
    // The control on "a send is visible": there is exactly one row, and it is this one. A store that
    // recorded nothing would fail above; a store that recorded twice fails here.
    expect(h.store.all()).toHaveLength(1)
  })

  it('prices an Arabic body at 70 characters to a segment, on the row', async () => {
    const h = harness()
    const outcome = await deliverMessage(h.deps, requestFor(CONFIRMED_AR))
    expect(outcome.kind).toBe('sent')
    if (outcome.kind !== 'sent') return
    const row = h.store.byId(outcome.message.id)
    expect(row?.message.encoding).toBe('UCS-2')
    // The control that makes it an assertion about Arabic rather than about any SMS: the same template
    // in English is GSM-7, and one Arabic character forces the whole body to UCS-2 — which is the cost
    // gate B-MSG-01 exists for, now visible on the row a report reads.
    const english = await deliverMessage(h.deps, requestFor(CONFIRMED))
    expect(english.kind).toBe('sent')
    if (english.kind !== 'sent') return
    expect(h.store.byId(english.message.id)?.message.encoding).toBe('GSM-7')
  })

  it('stores the HTML part an email was sent with, and bills it no segments', async () => {
    const h = harness()
    const outcome = await deliverMessage(h.deps, requestFor(INVOICE_EMAIL, 'guest@example.com'))
    expect(outcome.kind).toBe('sent')
    if (outcome.kind !== 'sent') return
    const row = h.store.byId(outcome.message.id)
    expect(row?.message.vendor).toBe('resend')
    expect(row?.message.bodyHtml).toContain('<!doctype html>')
    expect(row?.message.bodyHtml).toContain('INV-1042')
    expect(row?.message.subject).not.toBeNull()
    // Email is not segment-billed. The control is the SMS above, which is.
    expect(row?.message.segments).toBe(0)
    expect(row?.message.costFils).toBe(0)
  })
})

describe('retries and backoff', () => {
  it('attempts a rejection exactly once and ends failed', async () => {
    const h = harness()
    h.sms.failures.transactional.failAlways('rejected')
    const outcome = await deliverMessage(h.deps, requestFor(CONFIRMED))
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.message.status).toBe('failed')
    // The exact count the acceptance criterion asks for, per failure mode.
    expect(outcome.message.attempts).toBe(1)
    expect(outcome.message.lastFailureReason).toBe('provider_rejected')
    expect(outcome.message.nextAttemptAtIso).toBeNull()
    // No wait was taken, because there was no second attempt to wait for.
    expect(h.waits).toEqual([])
    // And the transport really was called once: a policy that refused to attempt at all would also
    // report one attempt and no waits.
    expect(h.sms.calls.forProvider('smsala')).toHaveLength(1)
  })

  it('attempts a rate limit three times, at the declared waits, and ends failed', async () => {
    const h = harness()
    h.sms.failures.transactional.failAlways('rate_limited')
    const outcome = await deliverMessage(h.deps, requestFor(CONFIRMED))
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.message.attempts).toBe(3)
    expect(outcome.message.status).toBe('failed')
    expect(outcome.message.lastFailureReason).toBe('provider_rate_limited')
    // One minute, then five — each measured from the failure it follows, not from the first attempt.
    // 10:00 fails, retry at 10:01; that fails, and five minutes later is 10:06. Asserted as instants,
    // so a formula that doubled the wait (10:03) would fail here.
    expect(h.waits).toEqual(['2026-09-18T10:01:00.000Z', '2026-09-18T10:06:00.000Z'])
    expect(h.waits[1]).not.toBe('2026-09-18T10:03:00.000Z')
    expect(h.sms.calls.forProvider('smsala')).toHaveLength(3)
    // The clock really moved, which is what makes the third attempt a later attempt rather than a
    // second call in the same millisecond.
    expect(h.nowIso()).toBe('2026-09-18T10:06:00.000Z')
  })

  it('stops retrying the moment an attempt succeeds', async () => {
    const h = harness()
    // Two rate limits, then the provider recovers.
    h.sms.failures.transactional.failNext('rate_limited', 2)
    const outcome = await deliverMessage(h.deps, requestFor(CONFIRMED))
    expect(outcome.kind).toBe('sent')
    if (outcome.kind !== 'sent') return
    expect(outcome.message.status).toBe('sent')
    expect(outcome.message.attempts).toBe(3)
    expect(outcome.message.nextAttemptAtIso).toBeNull()
    expect(h.waits).toHaveLength(2)
    // The control for the failed case above: the same three attempts, and this time the row is sent.
    expect(h.store.all()).toHaveLength(1)
  })

  it('caps the loop independently of the policy table', () => {
    // The loop's bound and the policy's cap are separate numbers on purpose: one expression for both is
    // how an edit to the table silently removes the guard.
    for (const policy of Object.values(MESSAGE_RETRY_POLICY)) {
      expect(policy.maxAttempts).toBeLessThanOrEqual(MAX_ATTEMPTS_ANY_POLICY)
    }
  })
})

describe('outcomes that are deliberately not a row', () => {
  it('records nothing for a message the gate refused', async () => {
    const h = harness()
    const refusing = {
      ...h.deps,
      send: {
        ...h.deps.send,
        gate: {
          ...h.deps.send.gate,
          evaluators: {
            ...h.deps.send.gate.evaluators,
            hasConsent: () => false,
          },
        },
      },
    }
    const outcome = await deliverMessage(refusing, requestFor(OFFER))
    expect(outcome.kind).toBe('not_sent')
    if (outcome.kind !== 'not_sent') return
    expect(outcome.result).toMatchObject({ kind: 'blocked', reason: 'refused_no_consent' })
    // Nothing was sent, so nothing is charged and nothing counts against the frequency cap. The
    // control is every other test in this file, all of which do produce a row.
    expect(h.store.all()).toHaveLength(0)
  })

  it('records nothing for a staging send diverted to the local outbox', async () => {
    let nowIso = AFTERNOON
    const config = parseConfig({
      APP_ENV: 'staging',
      DATABASE_URL: 'postgres://localhost/berelax_test',
      OUTBOUND_ALLOWLIST: '+971500000001',
    })
    const sms = createSmsalaTransport({ config, now: () => nowIso })
    const store = createInMemoryMessageStore()
    const outbox = new InMemoryOutbox()
    const deps: DeliveryDeps = {
      store,
      send: {
        appEnv: 'staging',
        outboundAllowlist: config.OUTBOUND_ALLOWLIST,
        senderIds: PROVISIONAL_SENDER_IDS,
        transports: [sms.transport],
        outbox,
        clock: { now: () => instantFromIso(nowIso) },
        gate: {
          marketingKillSwitch: false,
          promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
          evaluators: {
            hasConsent: () => true,
            isSuppressed: () => false,
            frequencyCapReached: () => false,
          },
        },
      },
      waitUntil: async (iso) => {
        nowIso = iso
      },
    }
    const diverted = await deliverMessage(deps, requestFor(CONFIRMED))
    expect(diverted.kind).toBe('not_sent')
    expect(store.all()).toHaveLength(0)
    // It is not lost: F03's outbox holds it, which is where a diverted message has always been visible.
    expect(outbox.size).toBe(1)
    // The control, and the one that matters: an allowlisted recipient on the same staging context does
    // reach the transport and does produce a row. Without it, "no row" would be satisfied by a context
    // that cannot send at all.
    const allowed = await deliverMessage(deps, requestFor(CONFIRMED, '+971500000001'))
    expect(allowed.kind).toBe('sent')
    expect(store.all()).toHaveLength(1)
  })

  it('records a promotional message held for the window as queued, with its release instant', async () => {
    const h = harness({ nowIso: ONE_AM })
    const outcome = await deliverMessage(h.deps, requestFor(OFFER))
    expect(outcome.kind).toBe('held')
    if (outcome.kind !== 'held') return
    expect(outcome.message.status).toBe('queued')
    // Held, not attempted: counting it would spend a retry on a message no transport has seen.
    expect(outcome.message.attempts).toBe(0)
    expect(outcome.message.nextAttemptAtIso).toBe('2026-09-19T03:00:00.000Z')
    expect(h.sms.calls.forProvider('smsala')).toHaveLength(0)
    // The control: the same template inside the window is sent rather than held.
    const inside = harness()
    expect((await deliverMessage(inside.deps, requestFor(OFFER))).kind).toBe('sent')
  })
})

describe('the vendor a channel goes to', () => {
  it('is smsala for sms and resend for email', () => {
    expect(vendorFor('sms')).toBe('smsala')
    expect(vendorFor('email')).toBe('resend')
    expect([...MESSAGE_VENDORS]).toEqual(['smsala', 'resend'])
  })

  it('refuses a channel with no contracted vendor rather than guessing one', () => {
    // WhatsApp is in the schema from day one and has no vendor. A default here would make every
    // receipt on such a row uninterpretable.
    expect(() => vendorFor('whatsapp')).toThrow(/No vendor is contracted/)
  })
})

describe('the undeliverable fixture', () => {
  it('is accepted and then reported failed, which is the case worth having a receipt for', async () => {
    const h = harness()
    const outcome = await deliverMessage(h.deps, requestFor(CONFIRMED, UNDELIVERABLE))
    expect(outcome.kind).toBe('sent')
    if (outcome.kind !== 'sent') return
    // Accepted: the vendor took it. The failure arrives later, on a receipt.
    expect(outcome.message.status).toBe('sent')
    const receipts = await h.sms.receipts.drain()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      vendor: 'smsala',
      vendorStatus: 'failed',
      mapped: 'failed',
      reason: 'Absent subscriber',
    })
    // The receipt's id is the one on the row, or nothing would ever match: the fake numbers per
    // identity instance, so both halves qualify the id the same way.
    expect(receipts[0]?.providerMessageId).toBe(outcome.message.providerMessageId)
  })
})
