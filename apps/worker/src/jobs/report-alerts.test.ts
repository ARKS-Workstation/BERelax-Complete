import { readFileSync } from 'node:fs'
import { type Instant, instantFromIso, tradingDayBuckets } from '@berelax/core'
import {
  type ClassifiedTemplate,
  evaluateGate,
  type GateContext,
  type MessageId,
  outboundMessageFor,
  TDRA_PROMOTIONAL_WINDOW,
} from '@berelax/messaging'
import { describe, expect, it } from 'vitest'
import {
  composeReportAlert,
  NO_ALERT_RECIPIENT,
  PROVISIONAL_ALERT_SENDER,
  REPORT_ALERT_CLASS,
  REPORT_ALERT_TEMPLATE,
} from './report-alerts.ts'

/**
 * R-REP-08 — the pushed alert, and the two answers the messaging gate gives it.
 *
 * The acceptance line is *alerts route through the messaging compliance gate as transactional class: a
 * staff operational alert at 01:30 is permitted while a customer-facing alert is held to the 07:00–21:00
 * window — both asserted*. Both are asserted here, against the REAL `evaluateGate` rather than against
 * a description of it, because the claim is about that function's answer and nothing else:
 *
 *   * 01:30 Asia/Dubai is the middle of the trading session the alert is about — trading runs
 *     11:00–02:00 — so a staff alert that waited until 07:00 would arrive after the day it concerns had
 *     closed. `transactional` returns `allow` on the gate's first line and the quiet-hours window is
 *     never read.
 *   * The same instant with a `promotional` message is `queue`d for the window's own opening, which is
 *     the TDRA rule and is not this unit's to relax.
 *
 * The third claim is the one a type cannot make: the class is a CONSTANT in `report-alerts.ts` and not a
 * parameter, so no caller can ask for a staff alert to be treated as promotional (which would silence
 * the one message saying the figures cannot be trusted) or for a customer-facing one to be treated as
 * transactional (which is the breach). That is asserted over the source.
 */

/** 01:30 Asia/Dubai on the night of 18 September 2026: inside the trading session, outside the window. */
const LATE_NIGHT: Instant = instantFromIso('2026-09-17T21:30:00.000Z')

/** 14:00 Asia/Dubai, well inside the promotional window. The control instant. */
const AFTERNOON: Instant = instantFromIso('2026-09-18T10:00:00.000Z')

const STAFF_ALERT: ClassifiedTemplate = {
  key: REPORT_ALERT_TEMPLATE,
  messageClass: 'transactional',
  approvalState: 'approved',
  channel: 'email',
  locale: 'en',
  body: '{{report}}',
  variables: ['report'],
}

/** The same words, declared promotional. The only difference is the class, which is the whole test. */
const CUSTOMER_FACING: ClassifiedTemplate = {
  ...STAFF_ALERT,
  key: 'campaign.offer',
  messageClass: 'promotional',
}

const GATE: GateContext = {
  marketingKillSwitch: false,
  promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
  // Healthy evaluators, deliberately: the point of the promotional case below is that it is held by the
  // WINDOW and not by a missing consent store. The shipped runtime's evaluators throw, which is asserted
  // separately over the source.
  evaluators: {
    hasConsent: () => true,
    isSuppressed: () => false,
    frequencyCapReached: () => false,
  },
}

const messageFor = (template: ClassifiedTemplate) =>
  outboundMessageFor({
    id: 'report-alert-probe' as MessageId,
    template,
    values: { report: 'Some figures cannot be trusted today.' },
    recipient: 'not-configured@berelax.example.invalid',
  })

const INPUT = {
  windowFrom: '2026-09-01',
  windowTo: '2026-09-30',
  failingCheckIds: ['ledger_vs_facts'],
  findings: ['The sale facts and the journal differ by 1 fils on 2026-09-14.'],
  buckets: tradingDayBuckets({ opensAtHour: 11, openMinutes: 15 * 60 }),
}

const SOURCE = readFileSync(new URL('./report-alerts.ts', import.meta.url).pathname, 'utf8')

describe('the gate at 01:30', () => {
  it('permits a staff operational alert, because it is transactional', () => {
    const decision = evaluateGate(GATE, messageFor(STAFF_ALERT), LATE_NIGHT)
    expect(decision.kind).toBe('allow')
    // And the class really is the reason: the shipped constant is the one the template declares.
    expect(REPORT_ALERT_CLASS).toBe('transactional')
    expect(STAFF_ALERT.messageClass).toBe(REPORT_ALERT_CLASS)
  })

  it('holds a customer-facing alert to the 07:00–21:00 window', () => {
    const decision = evaluateGate(GATE, messageFor(CUSTOMER_FACING), LATE_NIGHT)
    // Held, not dropped: a dropped message is indistinguishable from one that was never scheduled.
    expect(decision.kind).toBe('queue')
    if (decision.kind !== 'queue') throw new Error('narrowing')
    expect(decision.reason).toBe('queued_for_window')
    // Released into the window, which is the claim rather than the exact instant: the window's own
    // bounds are `TDRA_PROMOTIONAL_WINDOW`'s and this unit does not restate them.
    expect(decision.releaseAtIso.length).toBeGreaterThan(0)
  })

  it('is the CLASS that decides, not the hour, which is the control on both cases', () => {
    // The same promotional message in the afternoon is allowed, and the same transactional message is
    // allowed at both instants. Without this pair, a gate that refused everything at 01:30 and allowed
    // everything at 14:00 would satisfy the two cases above.
    expect(evaluateGate(GATE, messageFor(CUSTOMER_FACING), AFTERNOON).kind).toBe('allow')
    expect(evaluateGate(GATE, messageFor(STAFF_ALERT), AFTERNOON).kind).toBe('allow')
  })
})

describe('the class is a constant and the runtime fails closed', () => {
  it('reads the module it claims to', () => {
    expect(SOURCE.length).toBeGreaterThan(2_000)
    expect(SOURCE).toContain('export function reportAlertSender')
  })

  it('takes no message class from a caller', () => {
    // A `messageClass` on the input type would let a caller ask for a staff alert to be treated as
    // promotional — which reads as respecting quiet hours and would silence the one message that says
    // the figures cannot be trusted.
    expect(SOURCE).not.toMatch(/readonly messageClass/)
    expect(SOURCE).toContain('export const REPORT_ALERT_CLASS')
  })

  it('wires three evaluators that THROW, so a promotional send through it is refused', () => {
    // `gate-evaluator-answers-a-constant` in scripts/check-send-chokepoint.mjs refuses a literal here;
    // this is the same claim asserted where the diff is read.
    for (const evaluator of ['hasConsent', 'isSuppressed', 'frequencyCapReached']) {
      expect(SOURCE).toContain(`${evaluator}: () => {`)
    }
    expect(SOURCE.split('throw new Error(').length - 1).toBeGreaterThanOrEqual(3)
    expect(SOURCE).not.toContain('hasConsent: () => true')
  })

  it('hands the message to nothing but deliverMessage', () => {
    // The choke point, asserted where a reviewer reads the diff as well as in the scanner.
    expect(SOURCE).toContain('deliverMessage(delivery,')
    expect(SOURCE).not.toMatch(/transport\.send\(/)
    expect(SOURCE).not.toMatch(/provider\.send\(/)
  })
})

describe('the alert says what is wrong and carries no figure', () => {
  it('names every failing check and the window', () => {
    const body = composeReportAlert(INPUT)
    expect(body).toContain('ledger_vs_facts')
    expect(body).toContain('2026-09-01')
    expect(body).toContain('2026-09-30')
    expect(body).toContain('15 hour(s)')
    expect(body).toContain('11:00')
    expect(body).toContain('01:00')
  })

  it('refuses an alert about nothing', () => {
    // "All clear" every morning is how a real alert comes to be ignored, so a pass with nothing to say
    // sends nothing rather than a reassurance.
    expect(() => composeReportAlert({ ...INPUT, failingCheckIds: [], findings: [] })).toThrow(
      /no failing check/,
    )
  })

  it('escapes what it is given', () => {
    const body = composeReportAlert({
      ...INPUT,
      findings: ['<script>alert(1)</script>'],
    })
    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('&lt;')
  })
})

describe('the recipient and the sender', () => {
  it('has nobody to send to, which is the shipped answer', () => {
    // No table in this build holds a contact address for the owner (Y7-owner-notification-address), and
    // a plausible address is worse than a blank one (brief rule 15).
    expect(NO_ALERT_RECIPIENT()).toBeNull()
  })

  it('carries a marker on a .invalid domain rather than a plausible sender', () => {
    expect(PROVISIONAL_ALERT_SENDER.address.endsWith('.invalid')).toBe(true)
    expect(PROVISIONAL_ALERT_SENDER.name).toContain('not configured')
  })
})
