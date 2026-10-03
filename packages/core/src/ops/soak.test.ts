import { describe, expect, it } from 'vitest'
import {
  AVAILABILITY_BUDGET_CONCURRENCY,
  AVAILABILITY_P95_BUDGET_MS,
  budgetVerdict,
  SOAK_BACKLOG_EVENTS,
  SOAK_CONTENTION_ATTEMPTS,
  SOAK_REPORT_VERSION,
  SOAK_RULES,
  type SoakReport,
  soakProblems,
} from './soak.ts'

/** Twenty-five samples, at a declared concurrency of 25, whose nearest-rank p95 is 123. */
const SAMPLES = Array.from({ length: 25 }, (_, at) => 100 + at)
const P95 = 123

const report = (overrides: Partial<SoakReport> = {}): SoakReport => ({
  reportVersion: SOAK_REPORT_VERSION,
  runAtIso: '2026-10-03T12:00:00.000Z',
  machine: {
    platform: 'linux',
    cpus: 4,
    totalMemoryBytes: 16_000_000_000,
    loadAverage1m: 4.2,
    postgresVersion: '16.13',
    measuredOn: 'agent_container',
  },
  contention: {
    attempts: SOAK_CONTENTION_ATTEMPTS,
    successes: 1,
    refusalsByName: { slot_taken: SOAK_CONTENTION_ATTEMPTS - 1 },
    untypedFailures: 0,
    rawSqlstateFailures: [],
    overCapacityRooms: 0,
  },
  availability: {
    concurrency: 25,
    batches: 3,
    samples: SAMPLES,
    p95Ms: P95,
    medianMs: 112,
    budgetMs: null,
  },
  backlog: {
    events: SOAK_BACKLOG_EVENTS,
    handlers: 2,
    drainers: 2,
    batchSize: 200,
    deliveries: SOAK_BACKLOG_EVENTS * 2,
    distinctPairs: SOAK_BACKLOG_EVENTS * 2,
    unpublishedAfter: 0,
    drainMs: 61_000,
  },
  invariants: { name: 'money-invariants', ran: true, exitCode: 0, skippedReason: null },
  notProved: ['the p95 is a measurement of this container'],
  openQuestionId: 'Y13-perf-budget',
  ...overrides,
})

const rules = (problems: readonly { rule: string }[]) => problems.map((problem) => problem.rule)

describe('the claims about the code, which are asserted unconditionally', () => {
  it('passes a run that committed exactly one of 200 and delivered each event once per handler', () => {
    expect(soakProblems(report())).toEqual([])
  })

  it('refuses two successes and refuses zero', () => {
    for (const successes of [0, 2]) {
      expect(
        rules(soakProblems(report({ contention: { ...report().contention, successes } }))),
      ).toContain(SOAK_RULES.contentionNotExactlyOne)
    }
  })

  // The acceptance line's "zero unhandled constraint-violation 5xx responses", as the thing it is at the
  // service layer: a rejection that carried no refusal name is a raw constraint violation reaching a
  // caller, and a 23xxx or 40P01 is what it would be.
  it('refuses an untyped rejection and a raw SQLSTATE', () => {
    expect(
      rules(
        soakProblems(
          report({
            contention: {
              ...report().contention,
              untypedFailures: 1,
              refusalsByName: { slot_taken: SOAK_CONTENTION_ATTEMPTS - 2 },
            },
          }),
        ),
      ),
    ).toContain(SOAK_RULES.refusalUntyped)
    expect(
      rules(
        soakProblems(
          report({ contention: { ...report().contention, rawSqlstateFailures: ['23505'] } }),
        ),
      ),
    ).toContain(SOAK_RULES.refusalUntyped)
  })

  it('refuses a run whose refusals do not account for every attempt', () => {
    expect(
      rules(
        soakProblems(
          report({ contention: { ...report().contention, refusalsByName: { slot_taken: 10 } } }),
        ),
      ),
    ).toContain(SOAK_RULES.refusalUntyped)
  })

  it('refuses a room over capacity, and a smaller race than the line names', () => {
    expect(
      rules(soakProblems(report({ contention: { ...report().contention, overCapacityRooms: 1 } }))),
    ).toContain(SOAK_RULES.overCapacity)
    expect(
      rules(
        soakProblems(
          report({
            contention: {
              ...report().contention,
              attempts: 20,
              refusalsByName: { slot_taken: 19 },
            },
          }),
        ),
      ),
    ).toContain(SOAK_RULES.examinedNothing)
  })

  it('refuses a second delivery per pair and refuses a missing one', () => {
    const base = report().backlog
    expect(
      rules(soakProblems(report({ backlog: { ...base, deliveries: base.deliveries + 1 } }))),
    ).toContain(SOAK_RULES.backlogNotExactlyOnce)
    expect(
      rules(soakProblems(report({ backlog: { ...base, deliveries: base.deliveries - 1 } }))),
    ).toContain(SOAK_RULES.backlogNotExactlyOnce)
    // More rows than distinct pairs is the duplicate the unique key would have to have lost.
    expect(
      rules(soakProblems(report({ backlog: { ...base, distinctPairs: base.deliveries - 1 } }))),
    ).toContain(SOAK_RULES.backlogNotExactlyOnce)
  })

  it('refuses a backlog that did not drain, and one smaller than the line names', () => {
    expect(
      rules(soakProblems(report({ backlog: { ...report().backlog, unpublishedAfter: 3 } }))),
    ).toContain(SOAK_RULES.backlogNotExactlyOnce)
    expect(
      rules(
        soakProblems(
          report({
            backlog: { ...report().backlog, events: 100, deliveries: 200, distinctPairs: 200 },
          }),
        ),
      ),
    ).toContain(SOAK_RULES.examinedNothing)
  })

  it('refuses a report whose domain invariants did not run or did not pass', () => {
    expect(
      rules(
        soakProblems(
          report({
            invariants: {
              name: 'money-invariants',
              ran: false,
              exitCode: null,
              skippedReason: 'off',
            },
          }),
        ),
      ),
    ).toContain(SOAK_RULES.invariantsFailed)
    expect(
      rules(
        soakProblems(
          report({
            invariants: { name: 'money-invariants', ran: true, exitCode: 1, skippedReason: null },
          }),
        ),
      ),
    ).toContain(SOAK_RULES.invariantsFailed)
  })
})

describe('the latency reading, which is judged by its own arithmetic and by its machine', () => {
  // The edit nobody would notice, and the one a reader would quote.
  it('refuses a p95 the samples do not give', () => {
    expect(
      rules(soakProblems(report({ availability: { ...report().availability, p95Ms: 11 } }))),
    ).toContain(SOAK_RULES.arithmeticInconsistent)
  })

  it('refuses a run with fewer samples than queries', () => {
    expect(
      rules(
        soakProblems(
          report({ availability: { ...report().availability, samples: [1, 2], p95Ms: 2 } }),
        ),
      ),
    ).toContain(SOAK_RULES.examinedNothing)
  })

  // Brief rule 23 as a rule rather than a comment: an agent-container reading is NOT judged against the
  // committed budget, and a reading from a machine somebody chose is.
  it('does not judge an agent-container reading against the budget, and judges a chosen machine', () => {
    const over = {
      availability: { ...report().availability, budgetMs: AVAILABILITY_P95_BUDGET_MS, p95Ms: P95 },
      contention: report().contention,
    }
    const breaching = {
      ...over.availability,
      samples: [AVAILABILITY_P95_BUDGET_MS + 100],
      p95Ms: AVAILABILITY_P95_BUDGET_MS + 100,
      concurrency: 1,
    }
    expect(rules(soakProblems(report({ availability: breaching })))).not.toContain(
      SOAK_RULES.budgetBreached,
    )
    expect(
      rules(
        soakProblems(
          report({
            availability: breaching,
            machine: { ...report().machine, measuredOn: 'chosen_machine' },
          }),
        ),
      ),
    ).toContain(SOAK_RULES.budgetBreached)
  })

  it('refuses a stated budget with no measurement behind it', () => {
    expect(
      rules(
        soakProblems(
          report({
            availability: {
              ...report().availability,
              budgetMs: AVAILABILITY_P95_BUDGET_MS,
              samples: [],
              p95Ms: null,
              concurrency: 0,
            },
          }),
        ),
      ),
    ).toContain(SOAK_RULES.arithmeticInconsistent)
  })

  it('refuses a report that does not say which machine the figures came from', () => {
    expect(
      rules(
        soakProblems(
          report({
            machine: {
              ...report().machine,
              measuredOn: 'somewhere' as unknown as 'agent_container',
            },
          }),
        ),
      ),
    ).toContain(SOAK_RULES.machineNotStated)
  })

  it('refuses a report claiming the applied load establishes everything', () => {
    expect(rules(soakProblems(report({ notProved: [] })))).toContain(SOAK_RULES.malformed)
  })
})

describe('the budget verdict', () => {
  // Three states and not two. "Not judged" has to be distinguishable from "within budget", which is
  // ADR 0070's rule applied to a latency.
  it('is not_judged with no committed figure, not_judged on a container, and judged on a chosen machine', () => {
    expect(budgetVerdict(report()).kind).toBe('not_judged')
    const withBudget = report({
      availability: { ...report().availability, budgetMs: AVAILABILITY_P95_BUDGET_MS },
    })
    expect(budgetVerdict(withBudget).kind).toBe('not_judged')
    expect(
      budgetVerdict({
        ...withBudget,
        machine: { ...withBudget.machine, measuredOn: 'chosen_machine' },
      }).kind,
    ).toBe('within_budget')
  })

  it('names the only latency commitment this build holds, and the concurrency it was made at', () => {
    const verdict = budgetVerdict(report())
    expect(verdict.kind).toBe('not_judged')
    const reason = verdict.kind === 'not_judged' ? verdict.reason : ''
    expect(reason).toContain(String(AVAILABILITY_P95_BUDGET_MS))
    expect(reason).toContain(String(AVAILABILITY_BUDGET_CONCURRENCY))
    expect(reason).toContain('Y13-perf-budget')
  })
})
