import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Instant, instantFromIso } from '../time.ts'
import {
  type AgentHealthInput,
  BudgetExceeded,
  createRunBudget,
  evaluateAgentHealth,
  incidentKeyFor,
  isOverdue,
  OVERDUE_INTERVAL_MULTIPLE,
  silenceStartedAt,
} from './watchdog.ts'

const NOW = instantFromIso('2026-09-18T10:00:00.000Z')
const DAY_SECONDS = 60 * 60 * 24
const HOUR = 60 * 60 * 1000

function ago(milliseconds: number): Instant {
  return (NOW - milliseconds) as Instant
}

function agent(overrides: Partial<AgentHealthInput> = {}): AgentHealthInput {
  return {
    agentKey: 'nightly_rollups',
    enabled: true,
    // Long enough ago that `enabled_since` is never the binding constraint unless a test makes it so.
    enabledSince: ago(30 * 24 * HOUR),
    expectedIntervalSeconds: DAY_SECONDS,
    lastSuccessAt: ago(HOUR),
    ...overrides,
  }
}

describe('the boundary, which is the only interesting part of a threshold', () => {
  it('is healthy at 47h59m on a 24h interval', () => {
    // The manifest pins these two figures. A daily agent that is a few hours late is not an incident:
    // the queue was busy, a deploy shifted it, the poll landed on the wrong side of a minute.
    const health = evaluateAgentHealth(
      agent({ lastSuccessAt: ago(47 * HOUR + 59 * 60 * 1000) }),
      NOW,
    )
    expect(health.kind).toBe('healthy')
  })

  it('is overdue at 48h01m', () => {
    const health = evaluateAgentHealth(agent({ lastSuccessAt: ago(48 * HOUR + 60 * 1000) }), NOW)
    expect(health.kind).toBe('overdue')
    if (!isOverdue(health)) return
    expect(health.overdueBySeconds).toBe(60)
  })

  it('is healthy at exactly 48h, because at twice the interval it is due rather than late', () => {
    // Equality matters here for a mundane reason: most agents run on the hour, and so does the
    // watchdog. A threshold that alerted at equality would fire on the aligned ones daily, forever.
    const health = evaluateAgentHealth(agent({ lastSuccessAt: ago(48 * HOUR) }), NOW)
    expect(health.kind).toBe('healthy')
    expect(health.kind === 'healthy' && health.silentForSeconds).toBe(2 * DAY_SECONDS)
  })

  it('uses twice the declared interval, whatever that interval is', () => {
    // A five-minute agent and a weekly agent get the same rule, not the same number.
    const fiveMinutes = 5 * 60
    const justInside = evaluateAgentHealth(
      agent({ expectedIntervalSeconds: fiveMinutes, lastSuccessAt: ago(fiveMinutes * 2 * 1000) }),
      NOW,
    )
    const justOutside = evaluateAgentHealth(
      agent({
        expectedIntervalSeconds: fiveMinutes,
        lastSuccessAt: ago(fiveMinutes * 2 * 1000 + 1000),
      }),
      NOW,
    )
    expect(justInside.kind).toBe('healthy')
    expect(justOutside.kind).toBe('overdue')
    expect(OVERDUE_INTERVAL_MULTIPLE).toBe(2)
  })
})

describe('an agent that has never succeeded', () => {
  it('is measured from when it became enabled, not treated as healthy', () => {
    // The failure this catches: an agent added in a deploy whose cron was never registered. It has no
    // last success at all, and a watchdog that skipped rows with a null last_success_at would report
    // the whole system healthy on the day a new agent was silently never scheduled.
    const health = evaluateAgentHealth(
      agent({ lastSuccessAt: undefined, enabledSince: ago(72 * HOUR) }),
      NOW,
    )
    expect(health.kind).toBe('overdue')
  })

  it('is healthy while still inside its first two intervals', () => {
    // The control. A newly enabled agent has not failed at anything yet.
    const health = evaluateAgentHealth(
      agent({ lastSuccessAt: undefined, enabledSince: ago(4 * HOUR) }),
      NOW,
    )
    expect(health.kind).toBe('healthy')
  })
})

describe('disabled, and re-enabled', () => {
  it('never alerts while disabled, however long the silence', () => {
    const health = evaluateAgentHealth(
      agent({ enabled: false, lastSuccessAt: ago(365 * 24 * HOUR) }),
      NOW,
    )
    expect(health.kind).toBe('disabled')
  })

  it('does not alert for the window it was switched off', () => {
    // A week off, re-enabled a minute ago. Measuring from the last success would produce an immediate
    // alert for a week of deliberate silence — an alarm that fires the moment somebody finishes fixing
    // something, which is the fastest way to teach a team to ignore an alarm.
    const health = evaluateAgentHealth(
      agent({ enabled: true, enabledSince: ago(60 * 1000), lastSuccessAt: ago(7 * 24 * HOUR) }),
      NOW,
    )
    expect(health.kind).toBe('healthy')
    expect(health.kind === 'healthy' && health.silentForSeconds).toBe(60)
  })

  it('alerts once the re-enabled agent has itself been silent for two intervals', () => {
    // The control for the rule above: re-enabling suppresses the backdated alert, not every alert.
    const health = evaluateAgentHealth(
      agent({ enabled: true, enabledSince: ago(72 * HOUR), lastSuccessAt: ago(7 * 24 * HOUR) }),
      NOW,
    )
    expect(health.kind).toBe('overdue')
  })

  it('measures from the last success when that is later than the enable', () => {
    const input = agent({ enabledSince: ago(48 * HOUR), lastSuccessAt: ago(HOUR) })
    expect(silenceStartedAt(input)).toBe(ago(HOUR))
  })
})

describe('the incident key, which is what stops ninety-six alerts for one broken agent', () => {
  it('is the same on every pass during one unbroken silence', () => {
    const input = agent({ lastSuccessAt: ago(72 * HOUR) })
    const first = evaluateAgentHealth(input, NOW)
    const later = evaluateAgentHealth(input, (NOW + 6 * HOUR) as Instant)
    expect(isOverdue(first) && isOverdue(later) && first.incidentKey === later.incidentKey).toBe(
      true,
    )
  })

  it('changes as soon as a success lands, so a new silence is a new incident', () => {
    const before = evaluateAgentHealth(agent({ lastSuccessAt: ago(72 * HOUR) }), NOW)
    const after = evaluateAgentHealth(
      agent({ lastSuccessAt: ago(71 * HOUR) }),
      (NOW + 72 * HOUR) as Instant,
    )
    expect(isOverdue(before) && isOverdue(after) && before.incidentKey !== after.incidentKey).toBe(
      true,
    )
  })

  it('contains neither the current time nor anything random', () => {
    // The two ways this goes wrong: a key with `now` in it dedupes nothing, and a random key dedupes
    // nothing while looking as though it should.
    const silenceStarted = ago(72 * HOUR)
    expect(incidentKeyFor('seo_agent', silenceStarted)).toBe(`seo_agent:${silenceStarted}`)
    expect(incidentKeyFor('seo_agent', silenceStarted)).toBe(
      incidentKeyFor('seo_agent', silenceStarted),
    )
  })

  it('distinguishes two agents whose silence began at the same instant', () => {
    const at = ago(72 * HOUR)
    expect(incidentKeyFor('seo_agent', at)).not.toBe(incidentKeyFor('google_health', at))
  })
})

describe('a clock that misbehaves', () => {
  it('reports no silence rather than a negative duration', () => {
    // An `enabled_since` in the future, because somebody scheduled an enable; or a clock that stepped
    // backwards. A signed figure would compare as less than every threshold by accident, which is the
    // right answer for the wrong reason and stops being the right answer the moment a threshold is
    // expressed the other way round.
    const health = evaluateAgentHealth(
      agent({ lastSuccessAt: (NOW + 60 * 60 * 1000) as Instant }),
      NOW,
    )
    expect(health.kind).toBe('healthy')
    expect(health.kind === 'healthy' && health.silentForSeconds).toBe(0)
  })
})

describe('property: silence is monotone in time, and the verdict never flips back', () => {
  it('once overdue, stays overdue until a success moves', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60, max: 7 * DAY_SECONDS }),
        fc.integer({ min: 0, max: 30 * DAY_SECONDS }),
        fc.integer({ min: 0, max: 30 * DAY_SECONDS }),
        (intervalSeconds, silentSeconds, extraSeconds) => {
          const input = agent({
            expectedIntervalSeconds: intervalSeconds,
            lastSuccessAt: ago(silentSeconds * 1000),
            enabledSince: ago((silentSeconds + 1) * 1000),
          })
          const first = evaluateAgentHealth(input, NOW)
          const later = evaluateAgentHealth(input, (NOW + extraSeconds * 1000) as Instant)
          // Time only moves forwards here, so a healthy verdict may become overdue but never the
          // reverse. A watchdog that oscillated would alert, resolve and alert again on one incident.
          if (first.kind === 'overdue') expect(later.kind).toBe('overdue')
          if (later.kind === 'healthy') expect(first.kind).toBe('healthy')
        },
      ),
      { numRuns: 1000 },
    )
  })
})

describe('the per-run budget', () => {
  it('charges up to the cap and then refuses', () => {
    const budget = createRunBudget(1000)
    budget.charge(600)
    budget.charge(400)
    expect(budget.spentFils).toBe(1000)
    expect(() => budget.charge(1)).toThrow(BudgetExceeded)
  })

  it('leaves the recorded spend unchanged when a charge is refused', () => {
    // The refused charge must not be counted. A budget that added the amount and then threw would make
    // the persisted partial cost larger than the money actually spent, on the one row an auditor reads.
    const budget = createRunBudget(1000)
    budget.charge(900)
    expect(() => budget.charge(200)).toThrow(BudgetExceeded)
    expect(budget.spentFils).toBe(900)
  })

  it('reports what was spent, what the cap was and what was attempted', () => {
    const budget = createRunBudget(1000)
    budget.charge(900)
    try {
      budget.charge(200)
      expect.unreachable('expected BudgetExceeded')
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetExceeded)
      if (!(error instanceof BudgetExceeded)) return
      expect(error.spentFils).toBe(900)
      expect(error.capFils).toBe(1000)
      expect(error.attemptedFils).toBe(200)
    }
  })

  it('refuses a zero-budget agent its first charge, rather than treating zero as unlimited', () => {
    // Zero means this agent costs nothing to run. Read as "no cap", it would make every non-LLM agent
    // the only unbounded thing in the system.
    expect(() => createRunBudget(0).charge(1)).toThrow(BudgetExceeded)
    expect(() => createRunBudget(0).charge(0)).not.toThrow()
  })

  it('refuses a fractional or negative charge', () => {
    // Fils are integers, and a negative charge is a refund the budget has no business granting.
    expect(() => createRunBudget(1000).charge(1.5)).toThrow(RangeError)
    expect(() => createRunBudget(1000).charge(-100)).toThrow(RangeError)
  })

  it('property: spend never exceeds the cap however the charges are split', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.array(fc.integer({ min: 0, max: 3000 }), { maxLength: 40 }),
        (capFils, charges) => {
          const budget = createRunBudget(capFils)
          for (const charge of charges) {
            try {
              budget.charge(charge)
            } catch {
              // Refused. The invariant below is what matters.
            }
          }
          expect(budget.spentFils).toBeLessThanOrEqual(capFils)
        },
      ),
      { numRuns: 1000 },
    )
  })
})
