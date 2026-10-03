import { APP_ENVS } from '@berelax/config'
import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_MAX_ATTEMPTS,
  ANALYTICS_RETRY_BASE_SECONDS,
  ANALYTICS_RETRY_FACTOR,
  analyticsRetryDelaySeconds,
  createDispatchOutbox,
  guardAnalyticsEgress,
  TRANSPORT_REFUSAL_IS_RETRYABLE,
  TRANSPORT_REFUSAL_STATUS,
  TRANSPORT_REFUSALS,
  TransportRefusalError,
  TransportScript,
  transportRefusalOf,
} from './fakes.ts'

describe('the egress guard', () => {
  it('transmits in production and in nothing else', () => {
    // Enumerated from `APP_ENVS` rather than listed, so an environment added to the schema is covered
    // here the day it is added — the shape that would otherwise go on claiming four environments while
    // the build had five.
    const transmitting = APP_ENVS.filter((env) => guardAnalyticsEgress(env).kind === 'transmit')
    expect(transmitting).toEqual(['production'])
  })

  it('has no allowlist, no setting and no second argument', () => {
    // The acceptance line is "with APP_ENV != production neither adapter transmits", and this is what
    // makes it structural: there is nothing to pass that could change the answer. F03's messaging guard
    // takes an allowlist because a developer's own phone is a legitimate test recipient; an advertising
    // account has no test recipient at all.
    expect(guardAnalyticsEgress.length).toBe(1)
  })

  it('says why, so a diverted dispatch is explicable rather than silent', () => {
    const decision = guardAnalyticsEgress('test')
    expect(decision.kind).toBe('divert')
    if (decision.kind !== 'divert') return
    expect(decision.reason).toContain('APP_ENV=test')
    expect(decision.reason).toContain('local outbox')
  })
})

describe('the retry ladder', () => {
  it('grows, and the first delay is the base', () => {
    expect(analyticsRetryDelaySeconds(0)).toBe(ANALYTICS_RETRY_BASE_SECONDS)
    const ladder = Array.from({ length: ANALYTICS_MAX_ATTEMPTS }, (_, i) =>
      analyticsRetryDelaySeconds(i),
    )
    for (const [index, delay] of ladder.entries()) {
      if (index === 0) continue
      const previous = ladder[index - 1]
      expect(delay).not.toBeNull()
      expect(previous).not.toBeNull()
      // Exponential, asserted as a RATIO rather than against written-out numbers: a ladder asserted
      // against a list of seconds passes for a constant ladder if the list is edited to match it.
      expect((delay ?? 0) / (previous ?? 1)).toBe(ANALYTICS_RETRY_FACTOR)
    }
  })

  it('answers null past the last attempt, which is what makes giving up a value', () => {
    expect(analyticsRetryDelaySeconds(ANALYTICS_MAX_ATTEMPTS)).toBeNull()
    expect(analyticsRetryDelaySeconds(ANALYTICS_MAX_ATTEMPTS + 10)).toBeNull()
  })

  it('refuses a fractional or negative attempt count rather than computing one', () => {
    // `2 ** -1` is 0.5, which is a delay BELOW the base — an immediate retry for ever, the one failure a
    // backoff exists to prevent.
    expect(() => analyticsRetryDelaySeconds(-1)).toThrow(/whole non-negative/)
    expect(() => analyticsRetryDelaySeconds(1.5)).toThrow(/whole non-negative/)
  })

  it('never yields a zero or negative delay inside the ladder', () => {
    for (let attempt = 0; attempt < ANALYTICS_MAX_ATTEMPTS; attempt += 1) {
      expect(analyticsRetryDelaySeconds(attempt) ?? 0).toBeGreaterThan(0)
    }
  })
})

describe('the transport refusals', () => {
  it('declares a retryability and a status for every refusal, in both directions', () => {
    expect(Object.keys(TRANSPORT_REFUSAL_IS_RETRYABLE).sort()).toEqual(
      [...TRANSPORT_REFUSALS].sort(),
    )
    expect(Object.keys(TRANSPORT_REFUSAL_STATUS).sort()).toEqual([...TRANSPORT_REFUSALS].sort())
  })

  it('makes a 429 retryable and a 400 not', () => {
    // The acceptance line names the 429. The 400 is the control: retrying it five times produces five
    // identical refusals and delays every other row behind it.
    expect(TRANSPORT_REFUSAL_STATUS.rate_limited).toBe(429)
    expect(TRANSPORT_REFUSAL_IS_RETRYABLE.rate_limited).toBe(true)
    expect(TRANSPORT_REFUSAL_STATUS.invalid_payload).toBe(400)
    expect(TRANSPORT_REFUSAL_IS_RETRYABLE.invalid_payload).toBe(false)
  })

  it('carries the named refusal on the error, so a consumer branches on the rule', () => {
    const error = new TransportRefusalError('some-adapter', 'rate_limited')
    expect(transportRefusalOf(error)).toBe('rate_limited')
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('429')
    // And the control: an unrelated error is not read as a transport refusal, which is what stops the
    // consumer recording a programming mistake as a platform being busy.
    expect(transportRefusalOf(new Error('something else'))).toBeNull()
  })
})

describe('the failure script', () => {
  it('refuses exactly as many calls as it was armed for', () => {
    const script = new TransportScript()
    script.arm('rate_limited', 2)
    expect(script.take()).toBe('rate_limited')
    expect(script.take()).toBe('rate_limited')
    expect(script.take()).toBeNull()
  })

  it('disarms on zero and refuses a count that leaves it unpredictable', () => {
    const script = new TransportScript()
    script.arm('server_error', 1)
    script.arm('server_error', 0)
    expect(script.take()).toBeNull()
    expect(() => script.arm('server_error', -1)).toThrow(/fractional or negative/)
  })
})

describe('the local outbox', () => {
  it('records in order, per provider, with the instant it was given', () => {
    const outbox = createDispatchOutbox(() => '2026-10-02T12:00:00.000Z')
    const request = {
      eventId: 'e1',
      destination: 'analytics_measurement_push',
      // The payload is only serialised here, and `dispatchPayloadBytes` walks the field allowlist, so a
      // minimal cast stands in for a built payload in this unit test. The branded-payload claim is
      // asserted where it matters, against the real builder, in packages/fixtures.
      payload: { eventType: 'paid', categoryCode: 'X', quantity: 1 } as never,
      actionSource: 'website' as const,
      eventTimeIso: '2026-10-01T10:00:00.000Z',
      userData: {},
    }
    const first = outbox.record({
      provider: 'a',
      request,
      body: {},
      decision: { kind: 'divert', reason: 'because' },
    })
    outbox.record({ provider: 'b', request, body: {}, decision: { kind: 'transmit' } })
    expect(outbox.all().map((row) => row.provider)).toEqual(['a', 'b'])
    expect(outbox.forProvider('a').map((row) => row.outboxId)).toEqual([first.outboxId])
    expect(first.transmitted).toBe(false)
    expect(first.divertedReason).toBe('because')
    expect(first.recordedAtIso).toBe('2026-10-02T12:00:00.000Z')
    // `transmitted` and `divertedReason` are in bijection, which is what keeps "the call returned" and
    // "an ad platform has it" from collapsing into one fact.
    for (const row of outbox.all()) {
      expect(row.transmitted).toBe(row.divertedReason === null)
    }
  })
})
