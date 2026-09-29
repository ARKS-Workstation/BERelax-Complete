import type { GatewayIntentId, IdempotencyKey, TenderKind } from '@berelax/core'
import {
  aed,
  filsFrom,
  fixedClock,
  IdempotencyKeyReusedAcrossIntents,
  money,
  PartialCaptureNotAvailable,
  reduceIntent,
  VoidNotAvailable,
} from '@berelax/core'
import { FailureScript } from '@berelax/providers/failure'
import { REFERENCE_MARKERS } from '@berelax/providers/payments'
import { beforeEach, describe, expect, it } from 'vitest'
import { createRecordSink } from '../record-sink.ts'
import { createFakeCardGateway, type FakeCardGateway, THOUSANDTHS } from './fake-card.ts'
import { createManualGateway } from './manual.ts'

/**
 * The behaviours the conformance suite deliberately does not reach.
 *
 * The suite asserts the CONTRACT every adapter owes, which means it exercises each adapter through the
 * same shape and cannot exercise what makes one different. ADR 0022's argument is that the difference is
 * the point — *"a fake that satisfies the three rules and behaves nothing like its counterpart is an
 * expensive way of returning success"* — so the fake's 3DS round trip, its decline, its accumulating
 * partial captures and its deliberate webhook replay are asserted here, and the till's two refusals are
 * asserted for the reasons that are about a till rather than about a port.
 *
 * Every one of these paths was written before this file existed and none of them was covered by anything.
 * That is the H02 lesson arriving one layer up: a fake's most valuable behaviour is the one the happy path
 * never touches.
 */

const CLOCK = '2026-09-28T19:30:00.000Z'
const key = (label: string) => label as IdempotencyKey

function cardGateway(): {
  gateway: FakeCardGateway
  records: ReturnType<typeof createRecordSink>
  failures: FailureScript
} {
  const records = createRecordSink()
  const failures = new FailureScript()
  return {
    gateway: createFakeCardGateway({ clock: fixedClock(CLOCK), records, failures }),
    records,
    failures,
  }
}

function tillGateway() {
  const records = createRecordSink()
  return { gateway: createManualGateway({ clock: fixedClock(CLOCK), records }), records }
}

describe('the card fake: 3DS is a round trip the customer can abandon', () => {
  let harness: ReturnType<typeof cardGateway>

  beforeEach(() => {
    harness = cardGateway()
  })

  it('authorises a challenged reference into requires_customer_action with a URL', async () => {
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'card_online',
      idempotencyKey: key('3ds-1'),
      reference: `BK-1${REFERENCE_MARKERS.requiresAction}`,
    })
    expect(opened.state).toBe('requires_customer_action')
    expect(opened.customerActionUrl).toContain(opened.gatewayIntentId)
    // Nothing is captured and nothing is capturable through the port until the customer returns: the
    // table refuses a capture on an intent that is not authorised.
    expect(opened.captured.fils).toBe(0)
  })

  it('refuses a capture while the challenge is outstanding', async () => {
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'card_online',
      idempotencyKey: key('3ds-2'),
      reference: `BK-2${REFERENCE_MARKERS.requiresAction}`,
    })
    // The window where most checkout bugs live. Refused by the transition table, so the webhook path and
    // this one cannot disagree about it.
    await expect(
      harness.gateway.capture({
        gatewayIntentId: opened.gatewayIntentId,
        amount: aed(350),
        idempotencyKey: key('3ds-2-capture'),
      }),
    ).rejects.toThrow(/IntentTransitionRefused/)
  })

  it('moves to authorised when the customer comes back, and drops the action URL', async () => {
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'card_online',
      idempotencyKey: key('3ds-3'),
      reference: `BK-3${REFERENCE_MARKERS.requiresAction}`,
    })
    harness.gateway.completeCustomerAction(opened.gatewayIntentId)
    const after = await harness.gateway.fetchIntent(opened.gatewayIntentId)
    expect(after.state).toBe('authorised')
    expect(after.customerActionUrl).toBeUndefined()
    const captured = await harness.gateway.capture({
      gatewayIntentId: opened.gatewayIntentId,
      amount: aed(350),
      idempotencyKey: key('3ds-3-capture'),
    })
    expect(captured.captured.fils).toBe(35_000)
  })

  it('the control: a plain reference needs no challenge', async () => {
    // Without this, every assertion above is satisfied by a fake that challenges everything.
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'card_online',
      idempotencyKey: key('3ds-4'),
      reference: 'BK-4',
    })
    expect(opened.state).toBe('authorised')
    expect(opened.customerActionUrl).toBeUndefined()
  })
})

describe('the card fake: a decline is an outcome, not an error', () => {
  it('returns a failed intent rather than throwing, and records what was attempted', async () => {
    // A declined card is a business outcome. Throwing would make the checkout treat it as an incident,
    // and the operator needs the amount that was attempted on the payments screen either way.
    const harness = cardGateway()
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'card_online',
      idempotencyKey: key('decline-1'),
      reference: `BK-5${REFERENCE_MARKERS.declined}`,
    })
    expect(opened.state).toBe('failed')
    const movement = harness.records.all()[0]
    expect(movement?.amount.fils).toBe(35_000)
    expect(movement?.summary).toMatch(/declined/i)
  })

  it('refuses every further move on a failed intent', async () => {
    const harness = cardGateway()
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'card_online',
      idempotencyKey: key('decline-2'),
      reference: `BK-6${REFERENCE_MARKERS.declined}`,
    })
    for (const attempt of [
      () =>
        harness.gateway.capture({
          gatewayIntentId: opened.gatewayIntentId,
          amount: aed(350),
          idempotencyKey: key('decline-2-capture'),
        }),
      () =>
        harness.gateway.voidAuthorisation({
          gatewayIntentId: opened.gatewayIntentId,
          idempotencyKey: key('decline-2-void'),
        }),
    ]) {
      await expect(attempt()).rejects.toThrow(/IntentTransitionRefused/)
    }
  })
})

describe('the card fake: partial captures and refunds accumulate', () => {
  it('draws down the authorisation across several captures and refuses the one that goes over', async () => {
    const harness = cardGateway()
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'card_online',
      idempotencyKey: key('partial-1'),
      reference: 'BK-7',
    })
    const first = await harness.gateway.capture({
      gatewayIntentId: opened.gatewayIntentId,
      amount: aed(200),
      idempotencyKey: key('partial-1-a'),
    })
    expect(first.captured.fils).toBe(20_000)
    const second = await harness.gateway.capture({
      gatewayIntentId: opened.gatewayIntentId,
      amount: aed(150),
      idempotencyKey: key('partial-1-b'),
    })
    expect(second.captured.fils).toBe(35_000)
    await expect(
      harness.gateway.capture({
        gatewayIntentId: opened.gatewayIntentId,
        amount: money(filsFrom(1)),
        idempotencyKey: key('partial-1-c'),
      }),
    ).rejects.toThrow(/cannot take more than it reserved/)
  })

  it('carries a non-round amount through its own convention without losing a fils', async () => {
    // AED 262.50 is ADR 0007's example and the amount most likely to expose a convention that cannot
    // carry it. The fake stores thousandths, so this is the conversion at its edge doing real work.
    const harness = cardGateway()
    const opened = await harness.gateway.authorise({
      amount: money(filsFrom(26_250)),
      instrument: 'card_online',
      idempotencyKey: key('exact-1'),
      reference: 'BK-8',
    })
    expect(opened.authorised.fils).toBe(26_250)
    const captured = await harness.gateway.capture({
      gatewayIntentId: opened.gatewayIntentId,
      amount: money(filsFrom(1)),
      idempotencyKey: key('exact-1-a'),
    })
    expect(captured.captured.fils).toBe(1)
    expect(harness.gateway.minorUnits).toBe(THOUSANDTHS)
  })
})

describe('the card fake: webhooks replay, and the events fold to the intent', () => {
  it('delivers every event twice with the same event id', async () => {
    // A consumer that has only ever seen one copy of an event has an idempotency bug it has not met yet,
    // so the fake replays deliberately rather than as a rare accident. The same ID on both copies is the
    // part that matters: a replay carrying a new id would be a new event, and the consumer's idempotency
    // — which is keyed on the id — would never be exercised.
    const harness = cardGateway()
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'card_online',
      idempotencyKey: key('events-1'),
      reference: 'BK-9',
    })
    const stream = await harness.gateway.eventsSince(null)
    expect(stream).toHaveLength(2)
    expect(stream[0]?.event.eventId).toBe(stream[1]?.event.eventId)
    expect(stream[0]?.cursor).not.toBe(stream[1]?.cursor)
    expect(stream.every((d) => d.gatewayIntentId === opened.gatewayIntentId)).toBe(true)
  })

  it('folds its own replayed stream to the amounts it reports, which is the whole point', async () => {
    // The end-to-end claim: what the gateway says an intent is, and what @berelax/core derives from the
    // gateway's own events, agree — replays and all. If they did not, Y-PAY-04's webhook path and
    // Y-PAY-05's reconciliation would disagree with each other by construction.
    const harness = cardGateway()
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'card_online',
      idempotencyKey: key('events-2'),
      reference: 'BK-10',
    })
    await harness.gateway.capture({
      gatewayIntentId: opened.gatewayIntentId,
      amount: aed(200),
      idempotencyKey: key('events-2-a'),
    })
    await harness.gateway.refund({
      gatewayIntentId: opened.gatewayIntentId,
      amount: aed(50),
      idempotencyKey: key('events-2-b'),
      reason: 'one treatment of three',
    })
    const snapshot = await harness.gateway.fetchIntent(opened.gatewayIntentId)
    const stream = await harness.gateway.eventsSince(null)
    const folded = reduceIntent(stream.map((delivery) => delivery.event))

    expect(folded.state).toBe(snapshot.state)
    expect(folded.amounts.authorised.fils).toBe(snapshot.authorised.fils)
    expect(folded.amounts.captured.fils).toBe(snapshot.captured.fils)
    expect(folded.amounts.refunded.fils).toBe(snapshot.refunded.fils)
    // And the fold saw the duplicates: six deliveries for three movements.
    expect(stream).toHaveLength(6)
  })

  it('resumes from a cursor without re-delivering what came before it', async () => {
    const harness = cardGateway()
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'card_online',
      idempotencyKey: key('events-3'),
      reference: 'BK-11',
    })
    const first = await harness.gateway.eventsSince(null)
    await harness.gateway.capture({
      gatewayIntentId: opened.gatewayIntentId,
      amount: aed(350),
      idempotencyKey: key('events-3-a'),
    })
    const resumed = await harness.gateway.eventsSince(first[first.length - 1]?.cursor ?? null)
    expect(resumed).toHaveLength(2)
    expect(resumed.every((d) => d.event.type === 'captured')).toBe(true)
  })
})

describe('a repeated idempotency key on every operation', () => {
  it('suppresses a duplicate capture, refund and void, and marks each suppression', async () => {
    // The conformance suite proves this for `authorise`, which is where a retry is most likely. These are
    // the other three, and each has its own branch: a duplicate that was not recorded is invisible, and a
    // duplicate that was not suppressed moves the money twice.
    const harness = cardGateway()
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'card_online',
      idempotencyKey: key('dup-1'),
      reference: 'BK-12',
    })
    const capture = { gatewayIntentId: opened.gatewayIntentId, amount: aed(200) }
    await harness.gateway.capture({ ...capture, idempotencyKey: key('dup-1-c') })
    await harness.gateway.capture({ ...capture, idempotencyKey: key('dup-1-c') })
    const refund = {
      gatewayIntentId: opened.gatewayIntentId,
      amount: aed(50),
      reason: 'duplicate probe',
    }
    await harness.gateway.refund({ ...refund, idempotencyKey: key('dup-1-r') })
    await harness.gateway.refund({ ...refund, idempotencyKey: key('dup-1-r') })
    const voidArgs = { gatewayIntentId: opened.gatewayIntentId, idempotencyKey: key('dup-1-v') }
    // A void on a captured intent is refused by the table, so the duplicate-void branch is reached on a
    // second intent that was never captured.
    const clean = await harness.gateway.authorise({
      amount: aed(100),
      instrument: 'card_online',
      idempotencyKey: key('dup-2'),
      reference: 'BK-13',
    })
    await harness.gateway.voidAuthorisation({ ...voidArgs, gatewayIntentId: clean.gatewayIntentId })
    await harness.gateway.voidAuthorisation({ ...voidArgs, gatewayIntentId: clean.gatewayIntentId })

    const suppressed = harness.records
      .all()
      .filter((movement) => movement.suppressedDuplicate === true)
      .map((movement) => movement.operation)
      .sort()
    expect(suppressed).toEqual(['capture', 'refund', 'void'])

    // And the money moved once: 200 captured, 50 refunded.
    const snapshot = await harness.gateway.fetchIntent(opened.gatewayIntentId)
    expect(snapshot.captured.fils).toBe(20_000)
    expect(snapshot.refunded.fils).toBe(5_000)
  })

  it('suppresses a duplicate on the till too, where a double-keyed tender is the same hazard', async () => {
    const harness = tillGateway()
    const request = {
      amount: aed(350),
      instrument: 'cash' as TenderKind,
      idempotencyKey: key('till-dup'),
      reference: 'BK-14',
    }
    const first = await harness.gateway.authorise(request)
    const second = await harness.gateway.authorise(request)
    expect(second.gatewayIntentId).toBe(first.gatewayIntentId)
    await harness.gateway.capture({
      gatewayIntentId: first.gatewayIntentId,
      amount: aed(350),
      idempotencyKey: key('till-dup-c'),
    })
    await harness.gateway.capture({
      gatewayIntentId: first.gatewayIntentId,
      amount: aed(350),
      idempotencyKey: key('till-dup-c'),
    })
    const snapshot = await harness.gateway.fetchIntent(first.gatewayIntentId)
    expect(snapshot.captured.fils).toBe(35_000)
  })
})

describe('the till: what it refuses, and why it is about a till', () => {
  it('refuses a capture for anything other than the amount keyed in', async () => {
    const harness = tillGateway()
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'card_in_salon',
      idempotencyKey: key('till-1'),
      reference: 'BK-15',
    })
    await expect(
      harness.gateway.capture({
        gatewayIntentId: opened.gatewayIntentId,
        amount: aed(150),
        idempotencyKey: key('till-1-c'),
      }),
    ).rejects.toThrow(PartialCaptureNotAvailable)
  })

  it('refuses a void, because there is no reservation to release', async () => {
    const harness = tillGateway()
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'bank_transfer',
      idempotencyKey: key('till-2'),
      reference: 'BK-16',
    })
    await expect(
      harness.gateway.voidAuthorisation({
        gatewayIntentId: opened.gatewayIntentId,
        idempotencyKey: key('till-2-v'),
      }),
    ).rejects.toThrow(VoidNotAvailable)
  })

  it('records a partial refund at the desk, which it CAN do', async () => {
    // The capability that is true where two are false. A spa hands back one treatment of three at the
    // counter, and the till records that rather than performing it.
    const harness = tillGateway()
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'cash',
      idempotencyKey: key('till-3'),
      reference: 'BK-17',
    })
    await harness.gateway.capture({
      gatewayIntentId: opened.gatewayIntentId,
      amount: aed(350),
      idempotencyKey: key('till-3-c'),
    })
    const receipt = await harness.gateway.refund({
      gatewayIntentId: opened.gatewayIntentId,
      amount: aed(120),
      idempotencyKey: key('till-3-r'),
      reason: 'one treatment of three',
    })
    expect(receipt.amount.fils).toBe(12_000)
    const snapshot = await harness.gateway.fetchIntent(opened.gatewayIntentId)
    expect(snapshot.refunded.fils).toBe(12_000)
    expect(harness.records.all().some((m) => m.summary.includes('handed back at the desk'))).toBe(
      true,
    )
  })

  it('refuses a refund over what was taken, and names the refundable figure', async () => {
    const harness = tillGateway()
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'cash',
      idempotencyKey: key('till-4'),
      reference: 'BK-18',
    })
    await harness.gateway.capture({
      gatewayIntentId: opened.gatewayIntentId,
      amount: aed(350),
      idempotencyKey: key('till-4-c'),
    })
    await expect(
      harness.gateway.refund({
        gatewayIntentId: opened.gatewayIntentId,
        amount: aed(351),
        idempotencyKey: key('till-4-r'),
        reason: 'over',
      }),
    ).rejects.toThrow(/35000 fils still refundable/)
  })

  it('answers not_found for an intent it never issued, on every method', async () => {
    const harness = tillGateway()
    const missing = 'till_999999' as GatewayIntentId
    await expect(harness.gateway.fetchIntent(missing)).rejects.toThrow(/No till payment/)
    await expect(
      harness.gateway.capture({
        gatewayIntentId: missing,
        amount: aed(1),
        idempotencyKey: key('till-5-c'),
      }),
    ).rejects.toThrow(/No till payment/)
    await expect(
      harness.gateway.voidAuthorisation({
        gatewayIntentId: missing,
        idempotencyKey: key('till-5-v'),
      }),
    ).rejects.toThrow(/No till payment/)
  })
})

describe('an idempotency key that already answered for another intent', () => {
  it('is refused on the card gateway rather than answering with the remembered intent', async () => {
    // The hazard is what the lookup RETURNS, not that it happens: without the comparison, this capture
    // would succeed and report intent A's figures as the answer for intent B. Both invoices would then
    // reconcile, separately and wrongly, with nothing anywhere saying a key had been reused.
    const harness = cardGateway()
    const a = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'card_online',
      idempotencyKey: key('collide-a'),
      reference: 'BK-20',
    })
    const b = await harness.gateway.authorise({
      amount: aed(100),
      instrument: 'card_online',
      idempotencyKey: key('collide-b'),
      reference: 'BK-21',
    })
    const shared = key('collide-shared')
    await harness.gateway.capture({
      gatewayIntentId: a.gatewayIntentId,
      amount: aed(350),
      idempotencyKey: shared,
    })
    await expect(
      harness.gateway.capture({
        gatewayIntentId: b.gatewayIntentId,
        amount: aed(100),
        idempotencyKey: shared,
      }),
    ).rejects.toThrow(IdempotencyKeyReusedAcrossIntents)
    // And nothing moved on B.
    expect((await harness.gateway.fetchIntent(b.gatewayIntentId)).captured.fils).toBe(0)
  })

  it('is refused on the till too, on a refund as well as a capture', async () => {
    const harness = tillGateway()
    const a = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'cash',
      idempotencyKey: key('till-collide-a'),
      reference: 'BK-22',
    })
    const b = await harness.gateway.authorise({
      amount: aed(100),
      instrument: 'cash',
      idempotencyKey: key('till-collide-b'),
      reference: 'BK-23',
    })
    await harness.gateway.capture({
      gatewayIntentId: a.gatewayIntentId,
      amount: aed(350),
      idempotencyKey: key('till-collide-cap'),
    })
    const shared = key('till-collide-refund')
    await harness.gateway.refund({
      gatewayIntentId: a.gatewayIntentId,
      amount: aed(50),
      idempotencyKey: shared,
      reason: 'first',
    })
    await expect(
      harness.gateway.refund({
        gatewayIntentId: b.gatewayIntentId,
        amount: aed(50),
        idempotencyKey: shared,
        reason: 'second',
      }),
    ).rejects.toThrow(IdempotencyKeyReusedAcrossIntents)
  })

  it('the control: the SAME intent with the same key is a replay and is suppressed, not refused', async () => {
    // Without this, the two refusals above are satisfied by an adapter that refuses every repeated key —
    // which would break the retry path the key exists for.
    const harness = cardGateway()
    const opened = await harness.gateway.authorise({
      amount: aed(350),
      instrument: 'card_online',
      idempotencyKey: key('replay-ok'),
      reference: 'BK-24',
    })
    const args = {
      gatewayIntentId: opened.gatewayIntentId,
      amount: aed(200),
      idempotencyKey: key('replay-ok-cap'),
    }
    await harness.gateway.capture(args)
    await expect(harness.gateway.capture(args)).resolves.toBeDefined()
    expect((await harness.gateway.fetchIntent(opened.gatewayIntentId)).captured.fils).toBe(20_000)
  })
})
