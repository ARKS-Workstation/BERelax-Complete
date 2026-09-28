import {
  ANALYTICS_EVENT_NAMES,
  type AnalyticsEvent,
  FUNNEL_EXCLUSION_REASONS,
  FUNNEL_STAGES,
  FUNNEL_TERMINAL_STAGE,
  parseAnalyticsEvent,
} from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import type { HoursForDate } from '../business-day/resolve.ts'
import {
  APPOINTMENT_STATUSES,
  eventTypeFor,
  TERMINAL_APPOINTMENT_STATUSES,
} from '../lifecycle/transitions.ts'
import { instantFromIso, localTime, type TimeZone, type TradingHours, toLocal } from '../time.ts'
import {
  APPOINTMENT_STATUS_FUNNEL,
  COLLECTED_EVENT_FUNNEL,
  FUNNEL_DOMAIN_EVENT_TYPES,
  FUNNEL_NON_LIFECYCLE_EVENT_TYPES,
  type FunnelSignal,
  funnelBucketFor,
  funnelOutcomeFor,
  funnelStepFor,
  REACHABLE_FUNNEL_EXCLUSION_REASONS,
  REACHABLE_FUNNEL_STAGES,
} from './funnel.ts'

/**
 * The funnel contract: the mapping table, the derivation that holds the vocabulary in `shared` equal to
 * the lifecycle table in `core`, and the business day a step is counted on.
 *
 * This is the one file in the build that can see both `FUNNEL_EXCLUSION_REASONS` (in `@berelax/shared`,
 * where `packages/db` can reach it) and `TERMINAL_APPOINTMENT_STATUSES` (in `core`, which `db` may not
 * import). The equality assertions below are therefore the only thing standing between the words the
 * `analytics` schema stores and the states that can actually end a journey.
 */

/** The real hours: 11:00 to 02:00, every day (docs/03 §2, ADR 0007). */
const OPEN_11_TO_02: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const DAILY: HoursForDate = () => OPEN_11_TO_02
/** Inside the 2nd's session, ninety minutes after midnight on the 3rd. */
const AT_0130_ON_THE_THIRD = instantFromIso('2026-10-03T01:30:00+04:00')
/** In the daytime gap: the 2nd closed at 02:00 and the 3rd does not open until 11:00. */
const AT_0900_ON_THE_THIRD = instantFromIso('2026-10-03T09:00:00+04:00')
/** Midway through the 3rd's session. */
const AT_1500_ON_THE_THIRD = instantFromIso('2026-10-03T15:00:00+04:00')

const bucketed = (signal: FunnelSignal, occurredAt = AT_1500_ON_THE_THIRD) =>
  funnelStepFor({ signal, occurredAt, hoursFor: DAILY })

const collected = (name: string, payload: unknown): AnalyticsEvent =>
  parseAnalyticsEvent(name, payload)

describe('the mapping table — the four rows the acceptance names', () => {
  it('maps appointment COMPLETED to attended', () => {
    expect(funnelOutcomeFor({ source: 'appointment', status: 'completed' })).toEqual({
      kind: 'stage',
      stage: 'attended',
    })
  })

  it('maps an invoice settled in full to paid, which is the terminal stage', () => {
    expect(funnelOutcomeFor({ source: 'payment', settlesDocumentInFull: true })).toEqual({
      kind: 'stage',
      stage: 'paid',
    })
    expect(FUNNEL_TERMINAL_STAGE).toBe('paid')
  })

  it('maps a payment that leaves the document outstanding to NO step', () => {
    // `payment.recorded` fires for a partial payment too. A deposit is not a conversion, and `paid` is
    // the signal the ad platforms are pushed — so this is the one that must not advance the funnel.
    const outcome = funnelOutcomeFor({ source: 'payment', settlesDocumentInFull: false })
    expect(outcome.kind).toBe('no_step')
    if (outcome.kind === 'no_step') expect(outcome.why).toContain('deposit')
  })

  it('maps NO_SHOW to no stage and sets the excluded reason to no_show', () => {
    const outcome = funnelOutcomeFor({ source: 'appointment', status: 'no_show' })
    expect(outcome).toEqual({ kind: 'excluded', reason: 'no_show' })
    // Explicitly NOT a stage. A no-show that advanced anything would make the funnel report an
    // attendance that did not happen; one that produced nothing would read as a journey still in flight.
    expect(outcome.kind).not.toBe('stage')
  })

  it('maps booking_created to booking_created, and that stage is not terminal', () => {
    expect(funnelOutcomeFor({ source: 'booking_created' })).toEqual({
      kind: 'stage',
      stage: 'booking_created',
    })
  })
})

describe('every appointment status has a decision, and the ones that are not steps say why', () => {
  it('covers all nine statuses with no gap', () => {
    expect(Object.keys(APPOINTMENT_STATUS_FUNNEL).sort()).toEqual([...APPOINTMENT_STATUSES].sort())
    expect(APPOINTMENT_STATUSES.length).toBe(9)
  })

  it('advances the funnel for exactly confirmed and completed', () => {
    const advancing = APPOINTMENT_STATUSES.filter(
      (status) => APPOINTMENT_STATUS_FUNNEL[status].kind === 'stage',
    )
    expect(advancing).toEqual(['confirmed', 'completed'])
  })

  it('gives every no_step entry a reason a reader can act on', () => {
    const notSteps = APPOINTMENT_STATUSES.filter(
      (status) => APPOINTMENT_STATUS_FUNNEL[status].kind === 'no_step',
    )
    expect(notSteps).toEqual(['requested', 'checked_in', 'in_progress'])
    for (const status of notSteps) {
      const outcome = APPOINTMENT_STATUS_FUNNEL[status]
      if (outcome.kind !== 'no_step') throw new Error('filtered above')
      // Long enough to be an argument rather than a label. A one-word `why` is how a decision becomes
      // indistinguishable from an omission.
      expect(outcome.why.length, status).toBeGreaterThan(40)
    }
  })

  it('answers identically through funnelOutcomeFor and through the table', () => {
    for (const status of APPOINTMENT_STATUSES) {
      expect(funnelOutcomeFor({ source: 'appointment', status }), status).toEqual(
        APPOINTMENT_STATUS_FUNNEL[status],
      )
    }
  })
})

describe('the exclusion vocabulary is DERIVED from the lifecycle, not a second list', () => {
  it('is exactly the terminal statuses with completed removed, in both directions', () => {
    const derived = TERMINAL_APPOINTMENT_STATUSES.filter((status) => status !== 'completed')
    expect([...FUNNEL_EXCLUSION_REASONS].sort()).toEqual([...derived].sort())
    // Non-empty on both sides, so the equality is not two empty lists agreeing (ADR 0002).
    expect(derived.length).toBeGreaterThan(2)
    expect(FUNNEL_EXCLUSION_REASONS.length).toBeGreaterThan(2)
    // And `completed` is genuinely terminal, which is what makes its removal a decision rather than a
    // filter that happens to match nothing.
    expect([...TERMINAL_APPOINTMENT_STATUSES]).toContain('completed')
  })

  it('is produced in full by the mapping table, with nothing left over', () => {
    expect([...REACHABLE_FUNNEL_EXCLUSION_REASONS].sort()).toEqual(
      [...FUNNEL_EXCLUSION_REASONS].sort(),
    )
    // No reason is produced by two statuses, which would make one word mean two facts on one column.
    expect(new Set(REACHABLE_FUNNEL_EXCLUSION_REASONS).size).toBe(
      REACHABLE_FUNNEL_EXCLUSION_REASONS.length,
    )
  })

  it('excludes every terminal status that is not completed, and no non-terminal one', () => {
    for (const status of APPOINTMENT_STATUSES) {
      const excluded = APPOINTMENT_STATUS_FUNNEL[status].kind === 'excluded'
      const shouldExclude = TERMINAL_APPOINTMENT_STATUSES.includes(status) && status !== 'completed'
      expect(excluded, status).toBe(shouldExclude)
    }
  })
})

describe('every stage in the vocabulary is reachable from some signal', () => {
  it('produces all eight, in funnel order', () => {
    expect([...REACHABLE_FUNNEL_STAGES]).toEqual([...FUNNEL_STAGES])
  })

  it('and the collected events account for the first four', () => {
    const fromEvents = ANALYTICS_EVENT_NAMES.flatMap((name) => {
      const stage = COLLECTED_EVENT_FUNNEL[name].stage
      return stage === null ? [] : [stage]
    })
    expect(fromEvents).toEqual([
      'landing',
      'service_viewed',
      'price_viewed',
      'cta_click',
      // whatsapp_ref_shown contributes none: it is the denominator of ref-capture rate (ADR 0018).
    ])
    expect(COLLECTED_EVENT_FUNNEL.whatsapp_ref_shown.stage).toBeNull()
  })

  it('covers every collected event name with no gap and no spare', () => {
    expect(Object.keys(COLLECTED_EVENT_FUNNEL).sort()).toEqual([...ANALYTICS_EVENT_NAMES].sort())
  })
})

describe('the landing stage is the session entry, once per session', () => {
  it('is contributed by the entry page view', () => {
    expect(
      funnelOutcomeFor({
        source: 'collected',
        event: collected('page_view', { path: '/', entry: true }),
      }),
    ).toEqual({ kind: 'stage', stage: 'landing' })
  })

  it('is NOT contributed by a later page view in the same session', () => {
    // The control that makes the assertion above about the ENTRY flag rather than about page views. If
    // this advanced too, the first bucket would count pages and every rate below it would be wrong.
    const outcome = funnelOutcomeFor({
      source: 'collected',
      event: collected('page_view', { path: '/services', entry: false }),
    })
    expect(outcome.kind).toBe('no_step')
    if (outcome.kind === 'no_step') expect(outcome.why).toContain('one session, one landing')
  })

  it('marks exactly page_view as entry-page-only', () => {
    const flagged = ANALYTICS_EVENT_NAMES.filter(
      (name) => COLLECTED_EVENT_FUNNEL[name].entryPageViewOnly,
    )
    expect(flagged).toEqual(['page_view'])
  })

  it('maps the other collected events on every occurrence', () => {
    expect(
      funnelOutcomeFor({
        source: 'collected',
        event: collected('cta_click', { target: 'whatsapp', path: '/' }),
      }),
    ).toEqual({ kind: 'stage', stage: 'cta_click' })
    expect(
      funnelOutcomeFor({
        source: 'collected',
        event: collected('service_viewed', {
          path: '/services/asian-normal-massage',
          style: 'asian',
          treatment: 'normal_massage',
        }),
      }),
    ).toEqual({ kind: 'stage', stage: 'service_viewed' })
    expect(
      funnelOutcomeFor({
        source: 'collected',
        event: collected('price_viewed', {
          path: '/services/asian-normal-massage',
          style: 'asian',
          treatment: 'normal_massage',
        }),
      }),
    ).toEqual({ kind: 'stage', stage: 'price_viewed' })
    const ref = funnelOutcomeFor({
      source: 'collected',
      event: collected('whatsapp_ref_shown', { refCode: '7K2Q' }),
    })
    expect(ref.kind).toBe('no_step')
  })
})

describe('the outbox event types the funnel subscribes to are derived', () => {
  it('names the lifecycle events for the statuses that produce a step, and no others', () => {
    expect([...FUNNEL_DOMAIN_EVENT_TYPES].sort()).toEqual([
      'appointment.cancelled_by_customer',
      'appointment.cancelled_by_salon',
      'appointment.completed',
      'appointment.confirmed',
      'appointment.no_show',
      'appointment.rescheduled',
      'booking.created',
      'payment.recorded',
    ])
  })

  it('leaves out the lifecycle events that decide nothing', () => {
    // A handler that fires and decides nothing is a cost nobody notices. `checked_in` and `started` are
    // the two that would be easiest to subscribe to by reflex.
    for (const status of ['checked_in', 'in_progress'] as const) {
      const eventType = eventTypeFor(status)
      expect(eventType, status).not.toBeNull()
      expect(FUNNEL_DOMAIN_EVENT_TYPES, status).not.toContain(eventType)
    }
  })

  it('takes the lifecycle half from eventTypeFor rather than from a literal', () => {
    for (const status of APPOINTMENT_STATUSES) {
      const eventType = eventTypeFor(status)
      if (eventType === null) continue
      const producesStep = APPOINTMENT_STATUS_FUNNEL[status].kind !== 'no_step'
      expect(FUNNEL_DOMAIN_EVENT_TYPES.includes(eventType), `${status} -> ${eventType}`).toBe(
        producesStep,
      )
    }
  })

  it('pins the two event types written in packages/db, which core cannot derive', () => {
    expect(FUNNEL_NON_LIFECYCLE_EVENT_TYPES).toEqual({
      booking_created: 'booking.created',
      payment_recorded: 'payment.recorded',
    })
  })
})

describe('a step is bucketed on business_day, never on the calendar date', () => {
  it('puts 01:30 on the 3rd onto the 2nd, because trading runs 11:00-02:00', () => {
    const step = bucketed({ source: 'payment', settlesDocumentInFull: true }, AT_0130_ON_THE_THIRD)
    expect(step.kind).toBe('stage')
    if (step.kind !== 'stage') throw new Error('asserted above')
    expect(step.bucket).toEqual({ kind: 'trading', tradingDate: '2026-10-02' })
    // The control, and it is what makes the line above a claim about business_day rather than about any
    // date at all: this instant's own calendar date in Dubai is the THIRD. A funnel cut on that would
    // split every night's takings across two rows and disagree with cash-up, the rota and the journal.
    expect(toLocal(AT_0130_ON_THE_THIRD).date).toBe('2026-10-03')
  })

  it('puts 15:00 on the 3rd onto the 3rd', () => {
    expect(funnelBucketFor({ occurredAt: AT_1500_ON_THE_THIRD, hoursFor: DAILY })).toEqual({
      kind: 'trading',
      tradingDate: '2026-10-03',
    })
  })

  it('refuses to invent a trading date for an instant in the daytime gap', () => {
    // Web traffic continues all night; the premises does not. An instant at 09:00 belongs to no trading
    // date, and this unit names the reason rather than rolling it onto the calendar date — which trading
    // date it should roll into is Y5-funnel-gap-bucket in docs/OPEN-QUESTIONS.md.
    const bucket = funnelBucketFor({ occurredAt: AT_0900_ON_THE_THIRD, hoursFor: DAILY })
    expect(bucket.kind).toBe('outside_trading')
    if (bucket.kind !== 'outside_trading') throw new Error('asserted above')
    expect(bucket.reason).toBe('before_opening')
    expect(bucket.calendarDate).toBe('2026-10-03')
    // And the shape carries no tradingDate at all, so a reader cannot use the calendar date as one by
    // accident — which is the only way this refusal could be undone downstream.
    expect(Object.hasOwn(bucket, 'tradingDate')).toBe(false)
  })

  it('still produces the STEP for an instant outside trading, rather than dropping it', () => {
    const step = bucketed(
      { source: 'collected', event: collected('page_view', { path: '/', entry: true }) },
      AT_0900_ON_THE_THIRD,
    )
    expect(step.kind).toBe('stage')
    if (step.kind !== 'stage') throw new Error('asserted above')
    expect(step.stage).toBe('landing')
    expect(step.bucket.kind).toBe('outside_trading')
  })

  it('names the premises being shut for the whole date as its own reason', () => {
    const closed: HoursForDate = () => undefined
    const bucket = funnelBucketFor({ occurredAt: AT_1500_ON_THE_THIRD, hoursFor: closed })
    expect(bucket).toEqual({
      kind: 'outside_trading',
      reason: 'premises_closed',
      calendarDate: '2026-10-03',
    })
  })

  it('carries the exclusion reason and the bucket together on an excluded step', () => {
    const step = bucketed({ source: 'appointment', status: 'no_show' }, AT_0130_ON_THE_THIRD)
    expect(step).toEqual({
      kind: 'excluded',
      reason: 'no_show',
      bucket: { kind: 'trading', tradingDate: '2026-10-02' },
    })
  })

  it('dates nothing when there is no step to date', () => {
    const step = bucketed({ source: 'appointment', status: 'in_progress' })
    expect(step.kind).toBe('no_step')
    expect(Object.hasOwn(step, 'bucket')).toBe(false)
  })

  it('reads the zone argument, on two instants where the zone changes the answer', () => {
    // The first version of this case asserted two instants whose bucket is the SAME in both zones, so it
    // would have passed against a `funnelBucketFor` that ignored `input.zone` entirely. These two do not:
    // each is one instant that trades in one zone and falls outside trading in the other, and they point
    // in opposite directions so neither expectation can be satisfied by a constant.
    const UTC = 'UTC' as TimeZone

    // 22:30 UTC on the 3rd is 02:30 on the 4th in Dubai — half an hour after the 3rd's session closed,
    // and the 4th has not opened. In UTC the same instant is mid-session on the 3rd.
    const lateNight = instantFromIso('2026-10-03T22:30:00Z')
    expect(funnelBucketFor({ occurredAt: lateNight, hoursFor: DAILY })).toEqual({
      kind: 'outside_trading',
      reason: 'before_opening',
      calendarDate: '2026-10-04',
    })
    expect(funnelBucketFor({ occurredAt: lateNight, hoursFor: DAILY, zone: UTC })).toEqual({
      kind: 'trading',
      tradingDate: '2026-10-03',
    })

    // And the other way round: 08:00 UTC on the 3rd is noon in Dubai, inside the 3rd's session, while in
    // UTC it is three hours before opening.
    const midMorningUtc = instantFromIso('2026-10-03T08:00:00Z')
    expect(funnelBucketFor({ occurredAt: midMorningUtc, hoursFor: DAILY })).toEqual({
      kind: 'trading',
      tradingDate: '2026-10-03',
    })
    expect(funnelBucketFor({ occurredAt: midMorningUtc, hoursFor: DAILY, zone: UTC })).toEqual({
      kind: 'outside_trading',
      reason: 'before_opening',
      calendarDate: '2026-10-03',
    })
  })
})

describe('the contract is a pure function of its arguments', () => {
  it('answers identically for the same inputs, called repeatedly', () => {
    const signals: readonly FunnelSignal[] = [
      { source: 'booking_created' },
      { source: 'appointment', status: 'completed' },
      { source: 'appointment', status: 'no_show' },
      { source: 'payment', settlesDocumentInFull: true },
      { source: 'payment', settlesDocumentInFull: false },
      { source: 'collected', event: collected('page_view', { path: '/', entry: true }) },
      { source: 'collected', event: collected('cta_click', { target: 'call', path: '/' }) },
    ]
    for (const signal of signals) {
      const first = bucketed(signal, AT_0130_ON_THE_THIRD)
      const second = bucketed(signal, AT_0130_ON_THE_THIRD)
      expect(second).toEqual(first)
    }
  })

  it('never throws for any signal the type admits', () => {
    for (const status of APPOINTMENT_STATUSES) {
      expect(() => bucketed({ source: 'appointment', status }), status).not.toThrow()
    }
    for (const settlesDocumentInFull of [true, false]) {
      expect(() => bucketed({ source: 'payment', settlesDocumentInFull })).not.toThrow()
    }
    expect(() => bucketed({ source: 'booking_created' })).not.toThrow()
  })

  it('freezes the tables, so a consumer cannot edit the contract at runtime', () => {
    expect(Object.isFrozen(APPOINTMENT_STATUS_FUNNEL)).toBe(true)
    expect(Object.isFrozen(COLLECTED_EVENT_FUNNEL)).toBe(true)
    expect(Object.isFrozen(FUNNEL_NON_LIFECYCLE_EVENT_TYPES)).toBe(true)
  })
})
