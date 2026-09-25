/**
 * The choke point, end to end against the SMSala fake.
 *
 * Every test here pairs its assertion with a control that must fail the other way: a batch blocked by
 * the kill switch is re-run with the switch disengaged, a diverted staging send is re-run for an
 * allowlisted recipient, a suspended identity is re-run un-suspended. A "0 promotional deliveries"
 * assertion passes just as happily when nothing can send at all, and that is the version of this
 * suite worth nothing.
 */
import { type AppEnv, getDefinition, parseConfig } from '@berelax/config'
import {
  businessDayFor,
  fixedClock,
  instantFromIso,
  localTime,
  smsSegmentPrice,
  toLocal,
} from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { costOf } from './encoding.ts'
import {
  assertPromotionalWindowChange,
  TDRA_PROMOTIONAL_WINDOW,
  withinPromotionalWindow,
} from './gate.ts'
import { InMemoryOutbox } from './outbox.ts'
import type { MessageId, OutboundMessage } from './port.ts'
import { renderTemplate, type TemplateValues } from './render.ts'
import {
  CampaignSpend,
  type ClassifiedTemplate,
  type ClassRoutedTransport,
  type SendContext,
  type SendRequest,
  type SendResult,
  sendMessage,
} from './send.ts'
import {
  assertSenderIdRegistry,
  PROVISIONAL_SENDER_IDS,
  type SenderIdRegistry,
  senderIdFor,
} from './sender-identity.ts'
import { DEFAULT_TEMPLATES } from './templates.ts'
import { createSmsalaTransport, transportFailureFor } from './transports/smsala.ts'

/** 14:00 Asia/Dubai — trading, and inside the promotional window. */
const AFTERNOON = '2026-09-18T10:00:00.000Z'
/**
 * 01:00 Asia/Dubai on the 19th.
 *
 * The interesting instant in this domain: trading runs 11:00–02:00, so this is open business hours and
 * belongs to the *18th's* trading date, while the promotional window shut four hours ago.
 */
const ONE_AM = '2026-09-18T21:00:00.000Z'
/** 07:00 Asia/Dubai on the 19th — the instant the window reopens. */
const WINDOW_OPEN = '2026-09-19T03:00:00.000Z'

const RECIPIENT = '+971528239069'

const OFFER: ClassifiedTemplate = {
  key: 'campaign.offer',
  messageClass: 'promotional',
  approvalState: 'approved',
  channel: 'sms',
  locale: 'en',
  // A campaign template rather than a shipped default. `review.request` is now a shipped promotional
  // template (C-AUTO-01) and would do for the class, but it ships in `draft` on purpose, so a send of it
  // is refused before the gate — which is the wrong thing for this file to be measuring.
  body: 'Two treatments for the price of one this week. Stop: {{link}}',
  variables: ['link'],
}

function templateFor(key: string, locale: 'en' | 'ar' = 'en'): ClassifiedTemplate {
  const found = DEFAULT_TEMPLATES.find(
    (template) => template.key === key && template.locale === locale,
  )
  if (found === undefined) throw new Error(`No shipped template ${key}/${locale}`)
  return found
}

const CONFIRMED = templateFor('booking.confirmed')
const INVOICE_EMAIL = templateFor('invoice.issued')

const SAMPLE_VALUES: Readonly<Record<string, string>> = {
  date: '19 Sep',
  time: '21:00',
  link: 'https://be.relax/b/7',
  code: '481920',
  minutes: '5',
  invoice_number: 'INV-1042',
  total: 'AED 315.00',
}

const valuesFor = (template: ClassifiedTemplate): TemplateValues =>
  Object.fromEntries(template.variables.map((name) => [name, SAMPLE_VALUES[name] ?? 'x']))

let sequence = 0
function requestFor(template: ClassifiedTemplate, recipient = RECIPIENT): SendRequest {
  sequence += 1
  return {
    id: `msg-${sequence}` as MessageId,
    template,
    values: valuesFor(template),
    recipient,
  }
}

interface HarnessOptions {
  readonly appEnv?: AppEnv
  readonly nowIso?: string
  readonly killSwitch?: boolean
  readonly consent?: boolean
  readonly senderIds?: SenderIdRegistry
  readonly campaign?: CampaignSpend
  readonly allowlist?: readonly string[]
  readonly smsProvider?: 'fake' | 'real'
}

function harness(options: HarnessOptions = {}) {
  const nowIso = options.nowIso ?? AFTERNOON
  const appEnv = options.appEnv ?? 'production'
  const allowlist = options.allowlist ?? []
  const config = parseConfig({
    APP_ENV: appEnv,
    DATABASE_URL: 'postgres://localhost/berelax_test',
    OUTBOUND_ALLOWLIST: allowlist.join(','),
    SMS_PROVIDER: options.smsProvider ?? 'fake',
  })
  const sms = createSmsalaTransport({ config, now: () => nowIso })
  const outbox = new InMemoryOutbox()
  const ctx: SendContext = {
    appEnv,
    // Taken from the parsed configuration rather than restated, so the test cannot pass with a guard
    // that is wired to nothing.
    outboundAllowlist: config.OUTBOUND_ALLOWLIST,
    senderIds: options.senderIds ?? PROVISIONAL_SENDER_IDS,
    transports: [sms.transport],
    outbox,
    clock: fixedClock(nowIso),
    gate: {
      marketingKillSwitch: options.killSwitch ?? false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      evaluators: {
        hasConsent: () => options.consent ?? true,
        isSuppressed: () => false,
        frequencyCapReached: () => false,
      },
    },
    ...(options.campaign === undefined ? {} : { campaign: options.campaign }),
  }
  return { ctx, sms, outbox }
}

type Sent = Extract<SendResult, { kind: 'sent' }>
type Blocked = Extract<SendResult, { kind: 'blocked' }>
type Failed = Extract<SendResult, { kind: 'failed' }>

const sentOf = (results: readonly SendResult[]): Sent[] =>
  results.filter((result): result is Sent => result.kind === 'sent')
const blockedOf = (results: readonly SendResult[]): Blocked[] =>
  results.filter((result): result is Blocked => result.kind === 'blocked')
const failedOf = (results: readonly SendResult[]): Failed[] =>
  results.filter((result): result is Failed => result.kind === 'failed')

/** 20 promotional and 20 transactional, interleaved, through one context. */
async function mixedBatch(ctx: SendContext): Promise<SendResult[]> {
  const results: SendResult[] = []
  for (let i = 0; i < 20; i += 1) {
    results.push(await sendMessage(ctx, requestFor(OFFER)))
    results.push(await sendMessage(ctx, requestFor(CONFIRMED)))
  }
  return results
}

const successfulSends = (sms: ReturnType<typeof harness>['sms']): number =>
  sms.calls.forProvider('smsala').filter((call) => call.outcome === 'success').length

describe('the sender ID comes from the template class and nowhere else', () => {
  it('routes each class to its own registered identity', () => {
    expect(senderIdFor(PROVISIONAL_SENDER_IDS, 'transactional').value).toBe('BERELAX')
    expect(senderIdFor(PROVISIONAL_SENDER_IDS, 'promotional').value).toBe('AD-BERELAX')
  })

  it('selects the same identity for every shipped SMS template, from its class alone', () => {
    for (const template of DEFAULT_TEMPLATES.filter((t) => t.channel === 'sms')) {
      const identity = senderIdFor(PROVISIONAL_SENDER_IDS, template.messageClass)
      expect(identity.messageClass).toBe(template.messageClass)
      expect(identity.value.startsWith('AD-')).toBe(template.messageClass === 'promotional')
    }
  })

  it('refuses a registry whose slots and classes disagree', () => {
    // The control for the test below: this registry is what a swapped pair of environment variables
    // produces, and it must not be constructible without somebody being told.
    expect(() =>
      assertSenderIdRegistry({
        transactional: { value: 'AD-BERELAX', messageClass: 'promotional' },
        promotional: { value: 'BERELAX', messageClass: 'transactional' },
      }),
    ).toThrow(/registered as promotional/)
  })

  it('refuses a promotional identity with no AD- prefix, and a transactional one that has it', () => {
    expect(() =>
      assertSenderIdRegistry({
        transactional: { value: 'BERELAX', messageClass: 'transactional' },
        promotional: { value: 'BERELAX-OFFERS', messageClass: 'promotional' },
      }),
    ).toThrow(/must carry the 'AD-' prefix/)
    expect(() =>
      assertSenderIdRegistry({
        transactional: { value: 'AD-BERELAX', messageClass: 'transactional' },
        promotional: { value: 'AD-BERELAX-2', messageClass: 'promotional' },
      }),
    ).toThrow(/must not carry the 'AD-' prefix/)
  })

  it('refuses one identity registered for both classes, which is the outage two exist to remove', () => {
    expect(() =>
      assertSenderIdRegistry({
        transactional: { value: 'AD-BERELAX', messageClass: 'transactional' },
        promotional: { value: 'AD-BERELAX', messageClass: 'promotional' },
      }),
    ).toThrow(/Both classes are registered/)
  })

  it('sends nothing at all when the registry is swapped, for either class', async () => {
    const swapped: SenderIdRegistry = {
      transactional: { value: 'AD-BERELAX', messageClass: 'promotional' },
      promotional: { value: 'BERELAX', messageClass: 'transactional' },
    }
    const { ctx, sms } = harness({ senderIds: swapped })

    const transactional = await sendMessage(ctx, requestFor(CONFIRMED))
    const promotional = await sendMessage(ctx, requestFor(OFFER))

    expect(transactional).toMatchObject({ kind: 'blocked', reason: 'sender_id_class_mismatch' })
    expect(promotional).toMatchObject({ kind: 'blocked', reason: 'sender_id_class_mismatch' })
    expect(sms.calls.size).toBe(0)
  })

  it('is refused by SMSala too when a mismatched identity is forced at the transport seam', async () => {
    // Defence in depth. `senderIdFor` makes this unreachable from `sendMessage`; the provider's own
    // sender-ID check is what would catch a future transport that selected its own identity.
    const { ctx, sms } = harness()
    const promotional: OutboundMessage = {
      id: 'forced-1' as MessageId,
      channel: 'sms',
      messageClass: 'promotional',
      recipient: RECIPIENT,
      body: 'Two treatments for the price of one this week.',
      templateKey: OFFER.key,
      locale: 'en',
    }

    const outcome = await sms.transport.send({
      message: promotional,
      senderId: ctx.senderIds.transactional,
      idempotencyKey: 'forced-1',
    })

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'provider_rejected' })
    expect(successfulSends(sms)).toBe(0)
  })

  it('has no call-site override in the type signature', () => {
    const base = requestFor(CONFIRMED)

    // @ts-expect-error — a senderId on the send call is the hole this unit exists to close. If this
    // line ever compiles, `pnpm typecheck` fails here instead of a promotional blast leaving from the
    // transactional identity.
    const withSenderId: SendRequest = { ...base, senderId: PROVISIONAL_SENDER_IDS.promotional }
    // @ts-expect-error — and neither may a call site restate the class. It is the template's.
    const withClass: SendRequest = { ...base, messageClass: 'promotional' }

    expect(withSenderId.id).toBe(base.id)
    expect(withClass.id).toBe(base.id)
  })
})

describe('the marketing kill switch cannot touch transactional traffic', () => {
  it('delivers 0 promotional and 20 transactional from a mixed batch of 40', async () => {
    const { ctx, sms } = harness({ killSwitch: true })

    const results = await mixedBatch(ctx)
    const sent = sentOf(results)

    expect(sent).toHaveLength(20)
    expect(new Set(sent.map((result) => result.senderId))).toEqual(new Set(['BERELAX']))
    expect(blockedOf(results).filter((r) => r.reason === 'marketing_kill_switch')).toHaveLength(20)
    expect(successfulSends(sms)).toBe(20)
  })

  it('delivers all 40 with the switch disengaged, so the count above means something', async () => {
    const { ctx, sms } = harness({ killSwitch: false })

    const results = await mixedBatch(ctx)

    expect(sentOf(results)).toHaveLength(40)
    expect(successfulSends(sms)).toBe(40)
  })
})

describe('a suspended promotional sender ID leaves transactional delivery alone', () => {
  it('yields 20 transactional deliveries and 20 promotional failures with a named reason', async () => {
    const { ctx, sms } = harness()
    // A suspension applies to an identity, so it is armed on that identity's script alone. One shared
    // script would stop booking confirmations too, which is the outage ADR 0016 exists to remove.
    sms.failures.promotional.failAlways('rejected')

    const results = await mixedBatch(ctx)

    expect(sentOf(results)).toHaveLength(20)
    expect(sentOf(results).every((result) => result.senderId === 'BERELAX')).toBe(true)
    const failed = failedOf(results)
    expect(failed).toHaveLength(20)
    expect(new Set(failed.map((result) => result.reason))).toEqual(new Set(['provider_rejected']))
    expect(sms.failures.transactional.armed).toBe(false)
    expect(successfulSends(sms)).toBe(20)
  })

  it('delivers all 40 once the suspension is lifted', async () => {
    const { ctx } = harness()
    const results = await mixedBatch(ctx)
    expect(sentOf(results)).toHaveLength(40)
  })
})

describe('quiet hours apply to promotional traffic only', () => {
  it('is 01:00 Asia/Dubai, inside trading hours, on the previous trading date', () => {
    // The worked example the whole clock design exists for: 11:00–02:00 trading means this instant is
    // open business, and a promotional send here is not wrong — it is early.
    const instant = instantFromIso(ONE_AM)
    expect(businessDayFor(instant, { open: localTime('11:00'), close: localTime('02:00') })).toBe(
      '2026-09-18',
    )
  })

  it('sends a transactional message at 01:00 and queues a promotional one', async () => {
    const { ctx, sms } = harness({ nowIso: ONE_AM })

    const transactional = await sendMessage(ctx, requestFor(CONFIRMED))
    const promotional = await sendMessage(ctx, requestFor(OFFER))

    expect(transactional.kind).toBe('sent')
    expect(promotional).toEqual({
      kind: 'queued',
      reason: 'queued_for_window',
      releaseAtIso: WINDOW_OPEN,
    })
    // Queued, not sent: exactly one provider call was made, and it was the confirmation.
    expect(successfulSends(sms)).toBe(1)
  })

  it('delivers the queued promotional message at 07:00 under the frozen clock', async () => {
    const { ctx, sms } = harness({ nowIso: WINDOW_OPEN })

    const promotional = await sendMessage(ctx, requestFor(OFFER))

    expect(promotional).toMatchObject({ kind: 'sent', senderId: 'AD-BERELAX' })
    expect(successfulSends(sms)).toBe(1)
  })

  it('holds a 23:30 attempt for the next morning, releasing it with the 01:00 one', async () => {
    // Both instants are inside trading hours and outside the window, on either side of midnight, and
    // both leave at the same 07:00. The date arithmetic is the part that is easy to get wrong.
    const lateEvening = harness({ nowIso: '2026-09-18T19:30:00.000Z' })

    const result = await sendMessage(lateEvening.ctx, requestFor(OFFER))

    expect(result).toEqual({
      kind: 'queued',
      reason: 'queued_for_window',
      releaseAtIso: WINDOW_OPEN,
    })
  })

  it('opens at 07:00 and shuts at 21:00 Asia/Dubai, on the minute', () => {
    const at = (iso: string): boolean =>
      withinPromotionalWindow(toLocal(instantFromIso(iso)), TDRA_PROMOTIONAL_WINDOW)

    expect(at('2026-09-18T02:59:00.000Z')).toBe(false) // 06:59
    expect(at('2026-09-18T03:00:00.000Z')).toBe(true) // 07:00
    expect(at('2026-09-18T16:59:00.000Z')).toBe(true) // 20:59
    expect(at('2026-09-18T17:00:00.000Z')).toBe(false) // 21:00
  })

  it('still refuses a promotional message with no consent record inside the window', async () => {
    const { ctx, sms } = harness({ consent: false })
    const result = await sendMessage(ctx, requestFor(OFFER))
    expect(result).toMatchObject({ kind: 'blocked', reason: 'refused_no_consent' })
    expect(sms.calls.size).toBe(0)
  })
})

describe('the promotional window setting narrows and never opens', () => {
  it('is compliance-locked and owner-only in the registry', () => {
    const definition = getDefinition('messaging.promotional_window')
    expect(definition.tier).toBe('compliance_locked')
    expect(definition.editableBy).toEqual(['owner'])
  })

  it('accepts a narrowing change from the owner', () => {
    expect(
      assertPromotionalWindowChange({ proposed: { startHour: 9, endHour: 20 }, role: 'owner' }),
    ).toEqual({ startHour: 9, endHour: 20 })
  })

  it('refuses the widening that disables quiet hours', () => {
    expect(() =>
      assertPromotionalWindowChange({ proposed: { startHour: 0, endHour: 24 }, role: 'owner' }),
    ).toThrow(/only be narrowed/)
    expect(() =>
      assertPromotionalWindowChange({ proposed: { startHour: 6, endHour: 21 }, role: 'owner' }),
    ).toThrow(/only be narrowed/)
  })

  it('refuses switching it off, whatever "off" is spelled as', () => {
    for (const proposed of [null, false, 'off', {}, { startHour: 7 }]) {
      expect(() => assertPromotionalWindowChange({ proposed, role: 'owner' })).toThrow(
        /cannot be switched off/,
      )
    }
  })

  it('refuses a window with no hours in it, and an hour outside the registry range', () => {
    expect(() =>
      assertPromotionalWindowChange({ proposed: { startHour: 7, endHour: 7 }, role: 'owner' }),
    ).toThrow(/never opens/)
    expect(() =>
      assertPromotionalWindowChange({ proposed: { startHour: 7, endHour: 25 }, role: 'owner' }),
    ).toThrow(/Promotional send window/)
  })

  it('refuses a manager, before it even looks at the value', () => {
    expect(() =>
      assertPromotionalWindowChange({ proposed: { startHour: 9, endHour: 20 }, role: 'manager' }),
    ).toThrow(/may not change/)
  })
})

describe('outside production nothing reaches a real recipient', () => {
  it('diverts to the local outbox instead of sending', async () => {
    const { ctx, sms, outbox } = harness({ appEnv: 'staging' })

    const result = await sendMessage(ctx, requestFor(CONFIRMED))

    expect(result).toMatchObject({ kind: 'diverted', outboxRef: 'outbox:1' })
    expect(outbox.size).toBe(1)
    expect(outbox.all()[0]?.reason).toContain('OUTBOUND_ALLOWLIST')
    expect(outbox.all()[0]?.recordedAtIso).toBe(AFTERNOON)
    expect(sms.calls.size).toBe(0)
  })

  it('delivers to an allowlisted handset on staging, so the divert above is the guard and not a dead path', async () => {
    const { ctx, sms, outbox } = harness({ appEnv: 'staging', allowlist: [RECIPIENT] })

    const result = await sendMessage(ctx, requestFor(CONFIRMED))

    expect(result.kind).toBe('sent')
    expect(outbox.size).toBe(0)
    expect(successfulSends(sms)).toBe(1)
  })

  it('records a compliance refusal as a refusal on staging, not as a divert', async () => {
    // Ordering, asserted: the gate runs before the send guard. Otherwise the only environment where
    // the compliance path runs daily would be the one environment that never runs it.
    const { ctx, outbox } = harness({ appEnv: 'staging', consent: false })

    const result = await sendMessage(ctx, requestFor(OFFER))

    expect(result).toMatchObject({ kind: 'blocked', reason: 'refused_no_consent' })
    expect(outbox.size).toBe(0)
  })
})

describe('encoding, cost and the campaign cap', () => {
  it('reports the segments and cost the provider will bill, agreeing with costOf', async () => {
    const { ctx } = harness()
    const request = requestFor(CONFIRMED)
    // Two independent computations of the same thing: the authoring-time estimate the template screen
    // shows, and what the provider accepted. They disagreeing is the finding.
    const expected = costOf('sms', renderTemplate(CONFIRMED, request.values))

    const result = await sendMessage(ctx, request)

    expect(expected.segments).toBe(1)
    expect(result).toMatchObject({ kind: 'sent', segments: expected.segments })
    expect(sentOf([result])[0]?.costFils).toBe(expected.costFils)
  })

  it('stops a campaign at its cap rather than on the invoice', async () => {
    // Two messages' worth, expressed as two times the rate rather than as the figure it happens to be:
    // the rate is provisional (Y6-sms-rate), and a literal cap silently becomes a one-message cap the
    // day it is corrected — which would make this test assert the wrong thing while still passing.
    const cap = 2 * smsSegmentPrice('smsala', 'GSM-7').fils
    const campaign = new CampaignSpend(cap)
    const { ctx } = harness({ campaign })

    const first = await sendMessage(ctx, requestFor(OFFER))
    const second = await sendMessage(ctx, requestFor(OFFER))
    const third = await sendMessage(ctx, requestFor(OFFER))

    expect([first.kind, second.kind]).toEqual(['sent', 'sent'])
    expect(third).toMatchObject({ kind: 'blocked', reason: 'campaign_cap_exceeded' })
    expect(campaign.spentFils).toBe(cap)
  })

  it('refuses a cap that is not whole fils', () => {
    expect(() => new CampaignSpend(1.5)).toThrow(/whole number of fils/)
    expect(() => new CampaignSpend(-1)).toThrow(/whole number of fils/)
  })
})

describe('provider failures arrive as named reasons, never as an exception', () => {
  it('maps every failure mode the fakes can produce', () => {
    expect(transportFailureFor('rejected')).toBe('provider_rejected')
    expect(transportFailureFor('rate_limited')).toBe('provider_rate_limited')
    expect(transportFailureFor('quota_exhausted')).toBe('provider_rate_limited')
    expect(transportFailureFor('timeout')).toBe('provider_unavailable')
    expect(transportFailureFor('server_error')).toBe('provider_unavailable')
    // Unclassified is never retryable: a failure nobody has looked at is not one to retry in a loop.
    expect(transportFailureFor('invalid_grant')).toBe('provider_error')
    expect(transportFailureFor(undefined)).toBe('provider_error')
  })

  it('surfaces an armed provider timeout as provider_unavailable', async () => {
    const { ctx, sms } = harness()
    sms.failures.transactional.failNext('timeout')

    const result = await sendMessage(ctx, requestFor(CONFIRMED))

    expect(result).toMatchObject({ kind: 'failed', reason: 'provider_unavailable' })
  })

  it('treats a transport that throws as a failure rather than letting it escape', async () => {
    const exploding: ClassRoutedTransport = {
      channel: 'sms',
      send: () => {
        throw new Error('socket hang up')
      },
    }
    const { ctx } = harness()

    const result = await sendMessage({ ...ctx, transports: [exploding] }, requestFor(CONFIRMED))

    expect(result).toMatchObject({ kind: 'failed', reason: 'provider_error' })
  })

  it('refuses a channel with no transport rather than silently doing nothing', async () => {
    const { ctx, sms } = harness()

    const result = await sendMessage(ctx, requestFor(INVOICE_EMAIL))

    expect(result).toMatchObject({ kind: 'blocked', reason: 'channel_has_no_transport' })
    expect(sms.calls.size).toBe(0)
  })

  it('refuses at construction when configured for the real adapter that does not exist yet', () => {
    // A registry that quietly fell back to the fake would give a production deploy that looks
    // connected and sends nothing.
    expect(() => harness({ smsProvider: 'real' })).toThrow(/real smsala adapter is not implemented/)
  })
})
