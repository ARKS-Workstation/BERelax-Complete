/**
 * C-AUTO-05 — the kill switch stops marketing and cannot reach a booking confirmation.
 *
 * The acceptance line is structural, so the assertions here are deliberately of three different kinds and
 * none of them subsumes the others:
 *
 *   1. **Exhaustive over the corpus, in ONE process.** With the switch engaged, every promotional template
 *      the build ships is refused by name and every transactional one still reaches the transport — same
 *      `SendContext`, same clock, same transport, one loop. A pair of single-message tests would prove the two
 *      halves separately and leave the interesting claim — that they hold *at the same time* — unmade.
 *   2. **At the type level.** `killSwitchVerdict` and `evaluatePromotionalGate` both take a message that is
 *      promotional by type, and the cases below assert with `@ts-expect-error` that a transactional message is
 *      refused by `tsc`. An `@ts-expect-error` that stops being an error FAILS the typecheck, which is the
 *      only kind of assertion about a type worth writing.
 *   3. **Conservation across a mid-campaign flip.** `held + sent == total`, nobody sent after the flip,
 *      nobody lost. That is the claim a campaign sender will depend on, and it rests on `held` and `refused`
 *      being different answers rather than one.
 *
 * Gate cases 126a, 126c and 126f break each of the three and assert the break is caught, because an assertion
 * nobody has seen fail may not be an assertion (ADR 0003).
 *
 * `fail-closed.test.ts` already covers the single-message kill-switch behaviour — that a stopped campaign
 * reads no store, and that a confirmation goes out with the switch engaged — and this file does not repeat it.
 */
import { fixedClock } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { InMemoryOutbox } from '../outbox.ts'
import type { MessageId, OutboundMessage } from '../port.ts'
import {
  type ClassifiedTemplate,
  type ClassRoutedTransport,
  type SendContext,
  type SendResult,
  sendMessage,
  type TransportRequest,
} from '../send.ts'
import { PROVISIONAL_SENDER_IDS } from '../sender-identity.ts'
import { DEFAULT_TEMPLATES, type DefaultTemplate } from '../templates.ts'
import { evaluatePromotionalGate } from './decide.ts'
import {
  assertMayToggleMessagingControl,
  type GateEvaluators,
  killSwitchVerdict,
  PROMOTIONAL_HOLD_REASONS,
  promotionalSendDisposition,
  promotionalSenderSuspensionSuspected,
  promotionalSendingBanner,
  resolveMarketingKillSwitch,
  TDRA_PROMOTIONAL_WINDOW,
} from './index.ts'

/** 14:00 Asia/Dubai: trading, well inside the promotional window. Nothing here is about timing. */
const AFTERNOON = '2026-09-18T10:00:00.000Z'

/**
 * Consent granted, not suppressed, allowance unspent.
 *
 * A permissive set, which `check-send-chokepoint.mjs` forbids in shipped code and permits in a test — and the
 * permission is what makes the control below possible at all: with the switch disengaged these templates must
 * SEND, or "refused with the switch engaged" would be satisfied by a corpus nothing can send.
 */
const HEALTHY: GateEvaluators = {
  hasConsent: () => true,
  isSuppressed: () => false,
  frequencyCapReached: () => false,
}

function countingTransport(): ClassRoutedTransport & { readonly calls: TransportRequest[] } {
  const calls: TransportRequest[] = []
  return {
    channel: 'sms',
    calls,
    async send(request: TransportRequest) {
      calls.push(request)
      return {
        kind: 'accepted',
        providerMessageId: `stub-${calls.length}`,
        segments: 1,
        costFils: 9,
      }
    },
  }
}

/**
 * One context whose switch can be moved, so a flip happens INSIDE one process against one transport.
 *
 * `marketingKillSwitch` is read off this object on every send, which is what lets the campaign case flip it
 * halfway through the list — the shipped equivalent is `readMessagingControls` being called per message rather
 * than captured at boot.
 */
function harness(): {
  readonly ctx: SendContext
  readonly transport: ClassRoutedTransport & { readonly calls: TransportRequest[] }
  engage(): void
} {
  const transport = countingTransport()
  const gate = {
    marketingKillSwitch: false,
    promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
    evaluators: HEALTHY,
  }
  return {
    transport,
    // Production, so F03's staging guard delivers rather than diverting: a diverted send would be a test of
    // the guard rather than of the switch.
    ctx: {
      appEnv: 'production',
      outboundAllowlist: [],
      senderIds: PROVISIONAL_SENDER_IDS,
      transports: [transport],
      outbox: new InMemoryOutbox(),
      clock: fixedClock(AFTERNOON),
      gate,
    },
    engage() {
      gate.marketingKillSwitch = true
    },
  }
}

/** Plausible values for whatever a shipped template declares. Never a blank: a blank renders. */
const valuesFor = (template: DefaultTemplate): Record<string, string> =>
  Object.fromEntries(
    template.variables.map((name) => [
      name,
      name === 'link'
        ? 'brlx.ae/b/AbCdEf'
        : name === 'date'
          ? '18 Sep'
          : name === 'time'
            ? '20:00'
            : `VALUE-${name}`,
    ]),
  )

const smsCorpus = (): DefaultTemplate[] => DEFAULT_TEMPLATES.filter((t) => t.channel === 'sms')

/**
 * The corpus with `review.request` approved.
 *
 * It ships in `draft` on purpose and an unapproved template is refused BEFORE the gate, so leaving it as it
 * ships would make the promotional half of this sweep pass for the wrong reason: `template_not_approved`, not
 * `marketing_kill_switch`. Approving it in the test's own copy is what makes this a test of the switch.
 */
const sendable = (template: DefaultTemplate): ClassifiedTemplate => ({
  ...template,
  approvalState: 'approved',
})

const RECIPIENT = '+971528239069'

describe('the kill switch refuses every promotional send in the corpus and no transactional one', () => {
  it('refuses the whole promotional corpus by name while the transactional corpus still goes out', async () => {
    const h = harness()
    h.engage()
    const counted = { promotional: 0, transactional: 0 }

    for (const template of smsCorpus()) {
      const result = await sendMessage(h.ctx, {
        id: `cauto05-killed-${template.key}-${template.locale}` as MessageId,
        template: sendable(template),
        values: valuesFor(template),
        recipient: RECIPIENT,
      })

      if (template.messageClass === 'promotional') {
        counted.promotional += 1
        // BY NAME. `blocked` alone would be satisfied by a missing consent record, an unapproved template or
        // a shut window, and each of those is a different thing to tell an operator.
        expect(result, `${template.key}/${template.locale}`).toMatchObject({
          kind: 'blocked',
          reason: 'marketing_kill_switch',
        })
      } else {
        counted.transactional += 1
        expect(result.kind, `${template.key}/${template.locale}`).toBe('sent')
      }
    }

    // The two halves, at the same time, in one process: every transactional template reached the transport
    // and no promotional one did.
    expect(h.transport.calls).toHaveLength(counted.transactional)
    for (const call of h.transport.calls) {
      expect(call.message.messageClass).toBe('transactional')
      expect(call.senderId?.value).toBe('BERELAX')
    }
    // Non-vacuity, in both directions: a corpus with nothing promotional in it would satisfy the first half
    // perfectly, and one with nothing transactional would satisfy the second.
    expect(counted.promotional).toBeGreaterThan(0)
    expect(counted.transactional).toBeGreaterThan(0)
  })

  it('sends the same promotional corpus with the switch disengaged, so the sweep above is about the switch', async () => {
    // The control. Without it, "every promotional template is refused" would also be reported by a corpus in
    // which every promotional template is unsendable for some other reason entirely.
    const h = harness()
    let promotional = 0

    for (const template of smsCorpus().filter((t) => t.messageClass === 'promotional')) {
      promotional += 1
      const result = await sendMessage(h.ctx, {
        id: `cauto05-live-${template.key}-${template.locale}` as MessageId,
        template: sendable(template),
        values: valuesFor(template),
        recipient: RECIPIENT,
      })
      expect(result.kind, `${template.key}/${template.locale}`).toBe('sent')
    }

    expect(promotional).toBeGreaterThan(0)
    expect(h.transport.calls).toHaveLength(promotional)
    for (const call of h.transport.calls) expect(call.senderId?.value).toBe('AD-BERELAX')
  })
})

describe('the switch structurally cannot be asked about transactional traffic', () => {
  const promotional = {
    id: 'ks-1' as MessageId,
    channel: 'sms',
    messageClass: 'promotional',
    recipient: RECIPIENT,
    body: 'Two treatments for the price of one this week.',
    templateKey: 'campaign.offer',
    locale: 'en',
  } as const satisfies OutboundMessage

  const transactional = {
    id: 'ks-2' as MessageId,
    channel: 'sms',
    messageClass: 'transactional',
    recipient: RECIPIENT,
    body: 'Booking confirmed for 18 Sep at 20:00.',
    templateKey: 'booking.confirmed',
    locale: 'en',
  } as const satisfies OutboundMessage

  it('answers stop for a promotional message', () => {
    expect(killSwitchVerdict(true, promotional)).toMatchObject({
      kind: 'stop',
      reason: 'marketing_kill_switch',
    })
    expect(killSwitchVerdict(false, promotional)).toEqual({ kind: 'pass' })
  })

  it('does not compile when handed a transactional message', () => {
    // The whole unit, as a type error. If the promotional-only parameter were widened back to
    // `OutboundMessage`, this line would stop being an error and `tsc` would fail on the unused
    // `@ts-expect-error` — so the assertion cannot rot into a comment.
    // @ts-expect-error a transactional message is not assignable to PromotionalOnly
    expect(() => killSwitchVerdict(true, transactional)).not.toThrow()
    // And the same for the gate function that reads the switch. `evaluateGate` is the entry point every
    // caller uses and takes either class, because answering `allow` for transactional traffic is its job;
    // this is the half below it, and it may only be given the other class.
    //
    // Written as one statement on one line, deliberately: `@ts-expect-error` suppresses the errors on the
    // NEXT LINE only, so Biome wrapping the call across three lines moved the error off the suppressed line
    // and produced both an unused-directive error and the very error it was meant to assert. The directive
    // has to sit immediately above the line the argument is on.
    const gate = harness().ctx.gate
    // @ts-expect-error a transactional message is not assignable to PromotionalOutboundMessage
    const refused = () => evaluatePromotionalGate(gate, transactional, 0 as never)
    expect(refused).toBeTypeOf('function')
  })
})

describe('the switch is engaged outside production whatever the row says', () => {
  it('reads the stored decision in production', () => {
    expect(resolveMarketingKillSwitch({ stored: false, appEnv: 'production' })).toEqual({
      engaged: false,
      source: 'disengaged',
    })
    expect(resolveMarketingKillSwitch({ stored: true, appEnv: 'production' })).toEqual({
      engaged: true,
      source: 'operator',
    })
  })

  it('engages in every non-production environment, and says that is why', () => {
    // A seeded or imported campaign must not fire during a staging walkthrough, and the staging send guard
    // is not the answer: it diverts by RECIPIENT allowlist, so an allowlisted number in a seeded campaign
    // still goes out.
    for (const appEnv of ['development', 'test', 'staging'] as const) {
      expect(resolveMarketingKillSwitch({ stored: false, appEnv }), appEnv).toEqual({
        engaged: true,
        source: 'non_production_default',
      })
    }
    // An operator's own engagement still reads as the operator's, because that is the one a screen can
    // explain with a name and a reason.
    expect(resolveMarketingKillSwitch({ stored: true, appEnv: 'staging' }).source).toBe('operator')
  })
})

describe('who may move a control', () => {
  const toggle = (role: string, reason = 'Complaints about the weekend blast.') =>
    assertMayToggleMessagingControl({
      controlKey: 'marketing_kill_switch',
      direction: 'engage',
      role,
      reason,
    })

  it('lets the owner and the manager engage it', () => {
    // The manager deliberately: a floor manager who has to fetch the proprietor at 22:00 is a kill switch
    // nobody pulls.
    expect(() => toggle('owner')).not.toThrow()
    expect(() => toggle('manager')).not.toThrow()
  })

  it('refuses the receptionist and the marketer, and everybody else who is not those two', () => {
    // The marketer is the one that matters: `campaign:send` is theirs, and un-stopping their own campaign
    // must not be.
    for (const role of [
      'receptionist',
      'marketer',
      'therapist',
      'accountant',
      'auditor',
      'system',
    ]) {
      expect(() => toggle(role), role).toThrow(/settings:write/)
    }
  })

  it('refuses a role it has never heard of rather than treating it as ungated', () => {
    expect(() => toggle('superuser')).toThrow(/not a role in this system/)
  })

  it('refuses a toggle with no reason, and one with a reason of spaces', () => {
    expect(() => toggle('owner', '')).toThrow(/needs a reason/)
    expect(() => toggle('owner', '   ')).toThrow(/needs a reason/)
  })

  it('refuses a control key that is not one of the two', () => {
    expect(() =>
      assertMayToggleMessagingControl({
        // The realistic version: somebody adds a control for the traffic that must never be stoppable.
        controlKey: 'transactional_kill_switch' as never,
        direction: 'engage',
        role: 'owner' as const,
        reason: 'Stopping everything.',
      }),
    ).toThrow(/not a messaging control/)
  })
})

describe('a recipient the switch stopped is HELD, not refused', () => {
  it('classifies each outcome, and keeps held apart from refused', () => {
    expect(promotionalSendDisposition({ kind: 'sent' })).toBe('sent')
    expect(promotionalSendDisposition({ kind: 'blocked', reason: 'marketing_kill_switch' })).toBe(
      'held',
    )
    expect(promotionalSendDisposition({ kind: 'queued', reason: 'queued_for_window' })).toBe('held')
    // The distinction. A missing consent record reads the same tomorrow; a stopped campaign does not.
    expect(promotionalSendDisposition({ kind: 'blocked', reason: 'refused_no_consent' })).toBe(
      'refused',
    )
    expect(promotionalSendDisposition({ kind: 'blocked', reason: 'refused_suppressed' })).toBe(
      'refused',
    )
    expect(promotionalSendDisposition({ kind: 'failed', reason: 'provider_rejected' })).toBe(
      'failed',
    )
    expect(promotionalSendDisposition({ kind: 'expired', reason: 'stale_outside_window' })).toBe(
      'expired',
    )
    expect(promotionalSendDisposition({ kind: 'diverted', reason: 'not_allowlisted' })).toBe(
      'diverted',
    )
    expect(PROMOTIONAL_HOLD_REASONS).toContain('marketing_kill_switch')
    expect(PROMOTIONAL_HOLD_REASONS).not.toContain('refused_no_consent')
  })

  it('refuses an outcome kind it has never been taught rather than guessing', () => {
    // Deny by default, for the reason the header gives: defaulting to `refused` would stop owing the
    // recipient a release, and defaulting to `sent` would report a send that did not happen.
    expect(() => promotionalSendDisposition({ kind: 'throttled' })).toThrow(
      /not a send outcome this classifier knows/,
    )
  })

  it('holds every remaining recipient when the switch is engaged mid-campaign, losing none', async () => {
    const h = harness()
    const total = 20
    const flipAfter = 8
    const template: ClassifiedTemplate = {
      key: 'campaign.offer',
      messageClass: 'promotional',
      approvalState: 'approved',
      channel: 'sms',
      locale: 'en',
      body: 'Two treatments for the price of one this week.',
      variables: [],
    }

    const recipients = Array.from(
      { length: total },
      (_, index) => `+9715282390${String(index).padStart(2, '0')}`,
    )
    const outcome = new Map<string, string>()

    for (const [index, recipient] of recipients.entries()) {
      if (index === flipAfter) h.engage()
      const result: SendResult = await sendMessage(h.ctx, {
        id: `cauto05-campaign-${index}` as MessageId,
        template,
        values: {},
        recipient,
      })
      outcome.set(recipient, promotionalSendDisposition(result))
    }

    const sent = [...outcome].filter(([, disposition]) => disposition === 'sent')
    const held = [...outcome].filter(([, disposition]) => disposition === 'held')

    // held + sent == total, and NONE LOST: the keys are compared as a set, so a recipient the loop skipped
    // or overwrote fails here rather than being absorbed by two counts that happen to add up.
    expect(sent.length + held.length).toBe(total)
    expect(new Set(outcome.keys())).toEqual(new Set(recipients))
    expect(sent).toHaveLength(flipAfter)
    expect(held).toHaveLength(total - flipAfter)

    // No held recipient was sent. Asserted against the TRANSPORT's own log rather than against the results,
    // because the question is whether a vendor was asked — a result saying `blocked` over a transport that
    // was called anyway is the failure this catches.
    const asked = new Set(h.transport.calls.map((call) => call.message.recipient))
    expect(asked.size).toBe(flipAfter)
    for (const [recipient] of held) expect(asked.has(recipient)).toBe(false)
    for (const [recipient] of sent) expect(asked.has(recipient)).toBe(true)
  })
})

describe('a suspended promotional identity is contained, and says so', () => {
  it('recognises a rejected promotional send as a suspension, and a rejected transactional one as not', () => {
    const rejected = { kind: 'failed', reason: 'provider_rejected' } as const
    expect(
      promotionalSenderSuspensionSuspected({ messageClass: 'promotional', result: rejected }),
    ).toBe(true)
    // The control that keeps the containment honest: a rejected booking confirmation is a bad number or a
    // bad payload, and reporting it as "promotional sending suspended" would put a marketing banner over an
    // operational fault.
    expect(
      promotionalSenderSuspensionSuspected({ messageClass: 'transactional', result: rejected }),
    ).toBe(false)
    // And a rate limit is not a suspension. It is the same campaign, later.
    expect(
      promotionalSenderSuspensionSuspected({
        messageClass: 'promotional',
        result: { kind: 'failed', reason: 'provider_rate_limited' },
      }),
    ).toBe(false)
  })

  it('states the banner for all four combinations, and never without the transactional reassurance', () => {
    const cases = [
      { killSwitchEngaged: false, senderSuspended: false, state: 'sending' },
      { killSwitchEngaged: true, senderSuspended: false, state: 'stopped_by_kill_switch' },
      { killSwitchEngaged: false, senderSuspended: true, state: 'sender_suspended' },
      { killSwitchEngaged: true, senderSuspended: true, state: 'suspended_and_stopped' },
    ] as const

    for (const { state, ...input } of cases) {
      const banner = promotionalSendingBanner(input)
      expect(banner.state, JSON.stringify(input)).toBe(state)
      expect(banner.headline.length, JSON.stringify(input)).toBeGreaterThan(0)
    }
    // The three states that stop something all have to say what is NOT stopped, because that is the first
    // question staff ask and the answer that stops somebody escalating a marketing sanction as an outage.
    for (const { state: _state, ...input } of cases.slice(1)) {
      expect(promotionalSendingBanner(input).detail).toContain('Booking confirmations')
    }
    // Four distinct states, so no two combinations collapse into one sentence.
    expect(new Set(cases.map(({ state }) => state)).size).toBe(4)
  })
})
