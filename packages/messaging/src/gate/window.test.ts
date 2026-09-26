/**
 * The window through the real choke point: held rather than dropped, expired rather than sent late, and
 * the gate proven to run before the staging send guard.
 *
 * The pure rule is asserted in `packages/core/src/messaging/promotional-window.test.ts`, to the
 * millisecond and over every month end. What is asserted HERE is that `sendMessage` reaches it — that the
 * decision becomes a `SendResult` with the right kind, that the transport is never touched for a message
 * that was held, and that the staging guard cannot get in front of it.
 */
import { fixedClock, type Instant, instantFromIso, localDate } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { InMemoryOutbox } from '../outbox.ts'
import type { MessageId } from '../port.ts'
import {
  type ClassifiedTemplate,
  type ClassRoutedTransport,
  type SendContext,
  type SendRequest,
  type SendResult,
  sendMessage,
  type TransportRequest,
} from '../send.ts'
import { PROVISIONAL_SENDER_IDS } from '../sender-identity.ts'
import {
  type DatedPromotionalOverride,
  type GateEvaluators,
  TDRA_PROMOTIONAL_WINDOW,
} from './index.ts'

const RECIPIENT = '+971528239069'

const OFFER: ClassifiedTemplate = {
  key: 'campaign.offer',
  messageClass: 'promotional',
  approvalState: 'approved',
  channel: 'sms',
  locale: 'en',
  body: 'Two treatments for the price of one at BE RELAX this week.',
  variables: [],
}

const REMINDER: ClassifiedTemplate = {
  key: 'appointment.reminder',
  messageClass: 'transactional',
  approvalState: 'approved',
  channel: 'sms',
  locale: 'en',
  body: 'Reminder: your appointment is at {{time}}. Changes: {{link}}',
  variables: ['time', 'link'],
}

const VALUES = { time: '11:30', link: 'https://be.relax/b/7' } as const

/**
 * Permissive consent, suppression and cap, and said out loud.
 *
 * This file is about the WINDOW, and a send refused for a second reason would make every assertion here
 * pass for the wrong reason — which is C-AUTO-03's argument for stubbing these three in its own itest,
 * applied the other way round. The real evaluators are driven over the whole cross product in
 * `invariants.property.test.ts`, which is this file's counterpart: nothing is stubbed there.
 */
const CLEAR: GateEvaluators = {
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

let sequence = 0

function harness(options: {
  readonly atIso: string
  readonly appEnv?: SendContext['appEnv']
  readonly allowlist?: readonly string[]
  readonly evaluators?: GateEvaluators
  readonly overrides?: readonly DatedPromotionalOverride[]
}) {
  const transport = countingTransport()
  const ctx: SendContext = {
    appEnv: options.appEnv ?? 'production',
    outboundAllowlist: options.allowlist ?? [],
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [transport],
    outbox: new InMemoryOutbox(),
    clock: fixedClock(options.atIso),
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      evaluators: options.evaluators ?? CLEAR,
      ...(options.overrides === undefined ? {} : { windowOverrides: options.overrides }),
    },
  }
  return { ctx, transport }
}

function requestFor(template: ClassifiedTemplate, queuedSince?: Instant): SendRequest {
  sequence += 1
  return {
    id: `win-${sequence}` as MessageId,
    template,
    values: VALUES,
    recipient: RECIPIENT,
    ...(queuedSince === undefined ? {} : { attempt: { queuedSince } }),
  }
}

describe('outside the window a promotional message is queued, never dropped', () => {
  it('holds a 23:30 attempt with a release instant of the next 07:00 Asia/Dubai', async () => {
    const { ctx, transport } = harness({ atIso: '2026-09-18T19:30:00.000Z' })

    const result = await sendMessage(ctx, requestFor(OFFER))

    expect(result).toEqual({
      kind: 'queued',
      reason: 'queued_for_window',
      releaseAtIso: '2026-09-19T03:00:00.000Z',
    })
    // Never dropped AND never sent: a hold that reached the transport would be a send at 23:30.
    expect(transport.calls).toHaveLength(0)
    // And not diverted either — the outbox is for the staging guard, and this is production.
    expect(ctx.outbox.size).toBe(0)
  })

  it('sends the same message four hours earlier, so the hold is about the clock', async () => {
    const { ctx, transport } = harness({ atIso: '2026-09-18T15:30:00.000Z' }) // 19:30 Dubai

    const result = await sendMessage(ctx, requestFor(OFFER))

    expect(result).toMatchObject({ kind: 'sent', senderId: 'AD-BERELAX' })
    expect(transport.calls).toHaveLength(1)
  })

  it('holds until 10:00 when a dated override narrows the day, not until 07:00', async () => {
    // `Y9-ramadan-window` provisionally narrows to 10:00-16:00. No Ramadan DATE is written down anywhere
    // in this build — the dates are announced by an authority and are not a value a unit may invent — so
    // the row comes in as an argument, which is what a `business_calendar` read will supply.
    const overrides: DatedPromotionalOverride[] = [
      {
        fromDate: localDate('2026-09-19'),
        toDate: localDate('2026-09-19'),
        hours: { startHour: 10, endHour: 16 },
        reason: 'Ramadan hours (provisional)',
        openQuestionId: 'Y9-ramadan-window',
      },
    ]
    const { ctx } = harness({ atIso: '2026-09-18T19:30:00.000Z', overrides })

    const result = await sendMessage(ctx, requestFor(OFFER))

    expect(result).toMatchObject({ releaseAtIso: '2026-09-19T06:00:00.000Z' })
  })

  it('refuses to send when a dated override would WIDEN the window, rather than obeying it', async () => {
    // A calendar row saying promotional traffic may leave at 03:00 is somebody switching quiet hours off
    // through the calendar. It lands on the quiet-hours evaluator as unevaluable, which is the fail-closed
    // answer: the send stops and the fault is named.
    const overrides: DatedPromotionalOverride[] = [
      {
        fromDate: localDate('2026-09-01'),
        toDate: localDate('2026-09-30'),
        hours: { startHour: 0, endHour: 24 },
        reason: 'September push',
      },
    ]
    const { ctx, transport } = harness({ atIso: '2026-09-18T21:30:00.000Z', overrides })

    const result = await sendMessage(ctx, requestFor(OFFER))

    expect(result).toMatchObject({
      kind: 'blocked',
      reason: 'blocked_unevaluable',
      evaluator: 'quiet_hours',
    })
    expect(result).toMatchObject({ detail: expect.stringContaining('may only ever NARROW') })
    expect(transport.calls).toHaveLength(0)
  })
})

describe('the 02:00 collision, as a committed worked example', () => {
  it('sends a transactional reminder and queues a promotional message at the same 01:30 instant', async () => {
    // 01:30 Asia/Dubai is inside trading hours (11:00-02:00) and outside the promotional window. One
    // instant, two classes, two answers, and the promotional one is held rather than refused.
    const AT_0130 = '2026-09-18T21:30:00.000Z'

    const transactional = harness({ atIso: AT_0130 })
    const reminder = await sendMessage(transactional.ctx, requestFor(REMINDER))

    const promotional = harness({ atIso: AT_0130 })
    const offer = await sendMessage(promotional.ctx, requestFor(OFFER))

    expect(reminder).toMatchObject({ kind: 'sent', senderId: 'BERELAX' })
    expect(transactional.transport.calls).toHaveLength(1)

    expect(offer).toEqual({
      kind: 'queued',
      reason: 'queued_for_window',
      // 07:00 the SAME calendar day, because 01:30 is before the day's opening rather than after it.
      releaseAtIso: '2026-09-19T03:00:00.000Z',
    })
    expect(promotional.transport.calls).toHaveLength(0)

    // The two identities are the whole point of two TDRA registrations: the reminder left from the
    // transactional one and would have left from it whatever the promotional window said.
    expect(transactional.transport.calls[0]?.senderId?.value).toBe('BERELAX')
  })
})

describe('a message held too long expires rather than being sent late', () => {
  const HELD_SINCE = instantFromIso('2026-09-18T19:00:00.000Z') // 23:00 Dubai

  it('expires a release attempt twelve hours after the hold, naming the reason and the ceiling', async () => {
    const { ctx, transport } = harness({ atIso: '2026-09-19T07:00:00.000Z' }) // 11:00 Dubai, inside hours

    const result = await sendMessage(ctx, requestFor(OFFER, HELD_SINCE))

    expect(result).toMatchObject({
      kind: 'expired',
      reason: 'stale_outside_window',
      queuedSinceIso: '2026-09-18T19:00:00.000Z',
      maxStalenessSeconds: 12 * 60 * 60,
    })
    // Never sent late. That is the half of the claim the reason alone does not make.
    expect(transport.calls).toHaveLength(0)
    // And never silently discarded: the outcome is a typed result the caller reports on.
    expect((result as { readonly detail: string }).detail).toContain('Y9-queued-staleness')
  })

  it('releases a hold that is still fresh, so the expiry is about the age and not about the release', async () => {
    const { ctx, transport } = harness({ atIso: '2026-09-19T06:59:00.000Z' }) // one minute inside
    const result: SendResult = await sendMessage(ctx, requestFor(OFFER, HELD_SINCE))
    expect(result.kind).toBe('sent')
    expect(transport.calls).toHaveLength(1)
  })

  it('queues a first attempt at the same instant it would expire a stale one', async () => {
    // `attempt` absent means "never held", which cannot go stale. The pair is what makes the distinction
    // observable: same clock, same template, one with a hold behind it and one without.
    const { ctx } = harness({ atIso: '2026-09-18T19:30:00.000Z' })
    expect((await sendMessage(ctx, requestFor(OFFER))).kind).toBe('queued')

    const stale = harness({ atIso: '2026-09-18T19:30:00.000Z' })
    const expired = await sendMessage(
      stale.ctx,
      requestFor(OFFER, instantFromIso('2026-09-18T00:00:00.000Z')),
    )
    expect(expired.kind).toBe('expired')
  })

  it('never expires a transactional message, however long its caller claims it was held', async () => {
    const { ctx, transport } = harness({ atIso: '2026-09-19T07:00:00.000Z' })
    const result = await sendMessage(
      ctx,
      requestFor(REMINDER, instantFromIso('2026-01-01T00:00:00.000Z')),
    )
    expect(result.kind).toBe('sent')
    expect(transport.calls).toHaveLength(1)
  })
})

describe('the compliance gate runs before the staging send guard', () => {
  it('records a promotional send with no consent as refused_no_consent on staging, not as diverted', async () => {
    // The acceptance line, and the reason it matters: the guard diverts everything outside production. If
    // it ran first, this message would read `diverted` on staging and `refused` in production — so the one
    // environment where the compliance path is exercised daily would be the one that never exercises it.
    const { ctx, transport } = harness({
      atIso: '2026-09-18T10:00:00.000Z',
      appEnv: 'staging',
      evaluators: { ...CLEAR, hasConsent: () => false },
    })

    const result = await sendMessage(ctx, requestFor(OFFER))

    expect(result).toMatchObject({ kind: 'blocked', reason: 'refused_no_consent' })
    expect(result.kind).not.toBe('diverted')
    // And nothing reached the outbox, which is where a divert would have been recorded. A refusal that
    // also left an outbox entry would make the cost report and the staging inbox disagree.
    expect(ctx.outbox.size).toBe(0)
    expect(transport.calls).toHaveLength(0)
  })

  it('diverts the same send on staging once consent is in place, so the guard is still in the path', async () => {
    // The control. Without it, a gate that refused everything on staging would satisfy the case above and
    // the guard could have been deleted.
    const { ctx, transport } = harness({ atIso: '2026-09-18T10:00:00.000Z', appEnv: 'staging' })

    const result = await sendMessage(ctx, requestFor(OFFER))

    expect(result).toMatchObject({ kind: 'diverted' })
    expect(ctx.outbox.size).toBe(1)
    expect(transport.calls).toHaveLength(0)
  })

  it('holds for the window before the guard diverts, so a staging run cannot hide a quiet-hours bug', async () => {
    // Queued, not diverted. The window is part of the compliance decision and it is taken before the
    // environment is consulted, so a quiet-hours defect is visible on staging rather than masked by it.
    const { ctx } = harness({ atIso: '2026-09-18T19:30:00.000Z', appEnv: 'staging' })
    const result = await sendMessage(ctx, requestFor(OFFER))
    expect(result).toMatchObject({ kind: 'queued' })
    expect(ctx.outbox.size).toBe(0)
  })

  it('expires a stale hold on staging rather than diverting it', async () => {
    const { ctx } = harness({ atIso: '2026-09-19T07:00:00.000Z', appEnv: 'staging' })
    const result = await sendMessage(
      ctx,
      requestFor(OFFER, instantFromIso('2026-09-18T19:00:00.000Z')),
    )
    expect(result).toMatchObject({ kind: 'expired', reason: 'stale_outside_window' })
    expect(ctx.outbox.size).toBe(0)
  })
})
