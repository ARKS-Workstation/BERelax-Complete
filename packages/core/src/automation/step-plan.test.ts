import {
  FLOW_CONDITION_FACTS,
  FLOW_CONDITION_OPERATORS,
  isBooleanConditionFact,
  MAX_DRY_RUN_PROJECTED_ROWS,
  MAX_FLOW_NODE_EXECUTIONS,
} from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { CUSTOMER_LIFECYCLE_STATES } from '../crm/lifecycle.ts'
import { type Instant, instantFromIso } from '../time.ts'
import { parseFlowDefinition, validateFlowDefinition } from './dsl.ts'
import {
  answerFlowCondition,
  chooseSplitBranch,
  type FlowContactFacts,
  planFlowStep,
  projectDryRun,
} from './step-plan.ts'

/**
 * The interpreter's decisions, driven with no queue and no clock.
 *
 * Everything here is a claim the integration suite cannot make cheaply: the execution cap has to be shown
 * to halt at exactly the ceiling rather than "eventually", the condition table has to be driven over its
 * whole cross product, and the dry-run cap has to be shown to REPORT its overflow rather than trim it.
 * `packages/fixtures/src/flow-interpreter.itest.ts` then proves the same rules against a real database
 * and a real transport.
 */

const AT = instantFromIso('2099-03-04T10:00:00.000Z')

const FACTS: FlowContactFacts = Object.freeze({
  hasFutureAppointment: false,
  hasMarketingConsent: true,
  isVip: false,
  isBlocklisted: false,
  lifecycleState: 'lapsed',
  tags: ['nurture_touch'],
  locale: 'en',
})

/**
 * A tight loop with a one-minute delay: legal to publish, and the graph the cap exists for.
 *
 * `analyseFlowGraph` passes it — the cycle has a delay and an escape from which an exit is reachable —
 * and a contact who never books goes round it for ever. That is the shape of every runaway this cap is a
 * backstop for, and it is why the fixture is a VALID document rather than one the validator refuses.
 */
const loopingFlow = () => ({
  dslVersion: 1,
  key: 'cap_probe',
  title: 'Cap probe',
  nodes: [
    { id: 'start', kind: 'trigger', event: 'manual' },
    { id: 'beat', kind: 'delay', minutes: 1 },
    {
      id: 'booked_yet',
      kind: 'condition',
      test: { fact: 'has_future_appointment', operator: 'is_true' },
    },
    { id: 'touch', kind: 'action_tag', tag: 'nurture_touch' },
    { id: 'done', kind: 'exit', reason: 'goal_met' },
  ],
  edges: [
    { branch: 'default', from: 'start', to: 'beat' },
    { branch: 'default', from: 'beat', to: 'booked_yet' },
    { branch: 'true', from: 'booked_yet', to: 'done' },
    { branch: 'false', from: 'booked_yet', to: 'touch' },
    { branch: 'default', from: 'touch', to: 'beat' },
  ],
})

/** A document parsed for SHAPE alone, for the one case whose whole point is that publish would refuse it. */
const shaped = (candidate: unknown) => {
  const verdict = parseFlowDefinition(candidate)
  if (!verdict.ok) {
    throw new Error(
      `the probe document is malformed: ${verdict.refusals.map((r) => r.rule).join(', ')}`,
    )
  }
  return verdict.definition
}

const parsed = (candidate: unknown) => {
  const verdict = validateFlowDefinition(candidate, { templates: [] })
  if (!verdict.ok) {
    throw new Error(
      `the probe document is invalid: ${verdict.refusals.map((r) => r.rule).join(', ')}`,
    )
  }
  return verdict.definition
}

describe('the execution cap halts inside the bound', () => {
  it('performs exactly the ceiling number of executions and refuses the next one', () => {
    const definition = parsed(loopingFlow())
    // The clock is pushed past every delay, which is how a real runaway looks: a one-minute delay in a
    // loop is not a schedule, it is the worker polling. `at` far in the future means every `wait` is
    // already elapsed, so nothing here is waiting for anything.
    const at = (AT + 1_000 * 60 * 60 * 24 * 365) as Instant
    const ceiling = 12
    let cursor: string | null = null
    let executions = 0
    let halted: string | null = null

    for (let tick = 0; tick < ceiling * 10 + 50; tick += 1) {
      const plan = planFlowStep({
        definition,
        cursorNodeId: cursor,
        executionsSoFar: executions,
        maxNodeExecutions: ceiling,
        at,
        delayElapsedFrom: AT,
        facts: FACTS,
        splitSeedPrefix: 'run',
      })
      if (plan.kind === 'halt') {
        halted = plan.reason
        break
      }
      if (plan.kind === 'execute') {
        executions += 1
        cursor = plan.nextNodeId
        continue
      }
      throw new Error(
        `the looping probe produced ${plan.kind}, which it cannot: ${JSON.stringify(plan)}`,
      )
    }

    expect(halted, 'a loop with no escaping fact must reach the cap').toBe('loop_detected')
    // INSIDE the bound, and exactly at it. Not `toBeLessThanOrEqual`: a cap that halted at 3 would
    // satisfy that and would be a different defect.
    expect(executions).toBe(ceiling)
  })

  it('the control: one execution short of the ceiling still executes', () => {
    const definition = parsed(loopingFlow())
    const plan = planFlowStep({
      definition,
      cursorNodeId: 'touch',
      executionsSoFar: 11,
      maxNodeExecutions: 12,
      at: AT,
      delayElapsedFrom: AT,
      facts: FACTS,
      splitSeedPrefix: 'run',
    })
    expect(plan.kind).toBe('execute')
    // And one MORE does not, so the boundary is the ceiling and not a number near it.
    const refused = planFlowStep({
      definition,
      cursorNodeId: 'touch',
      executionsSoFar: 12,
      maxNodeExecutions: 12,
      at: AT,
      delayElapsedFrom: AT,
      facts: FACTS,
      splitSeedPrefix: 'run',
    })
    expect(refused.kind).toBe('halt')
  })

  it('a delay that is not yet due is a wait and does NOT spend an execution', () => {
    const definition = parsed(loopingFlow())
    const plan = planFlowStep({
      definition,
      cursorNodeId: 'beat',
      // Already at the ceiling: a wait must still be a wait, because the cap is a runaway detector and
      // not a budget for how long a flow may take. If a wait counted, a hundred short delays would halt
      // a flow that had done nothing.
      executionsSoFar: MAX_FLOW_NODE_EXECUTIONS,
      maxNodeExecutions: MAX_FLOW_NODE_EXECUTIONS,
      at: AT,
      delayElapsedFrom: AT,
      facts: FACTS,
      splitSeedPrefix: 'run',
    })
    expect(plan.kind).toBe('wait')
    if (plan.kind !== 'wait') return
    // One minute past the instant the run last resumed, and nothing else. No window is consulted here:
    // whether that instant is inside quiet hours is the gate's answer, later.
    expect(plan.resumeAt).toBe(AT + 60_000)
  })
})

describe('a condition is answered from the facts, or the run halts', () => {
  it('answers every fact and operator pair the schema permits', () => {
    let answered = 0
    for (const fact of FLOW_CONDITION_FACTS) {
      for (const operator of FLOW_CONDITION_OPERATORS) {
        const boolean = isBooleanConditionFact(fact)
        if (boolean !== (operator === 'is_true' || operator === 'is_false')) continue
        const value = boolean
          ? undefined
          : fact === 'lifecycle_state'
            ? 'lapsed'
            : fact === 'locale'
              ? 'en'
              : 'nurture_touch'
        const verdict = answerFlowCondition({ fact, operator, value }, FACTS)
        expect(verdict.kind, `${fact} ${operator}`).toBe('answered')
        answered += 1
      }
    }
    // The cross product has to be big enough for the loop above to mean something (ADR 0002): four
    // boolean facts with two operators and three valued facts with two operators is fourteen pairs.
    expect(answered).toBe(14)
  })

  it('negates rather than re-asking, so is_false is exactly not is_true', () => {
    for (const fact of FLOW_CONDITION_FACTS.filter(isBooleanConditionFact)) {
      const positive = answerFlowCondition({ fact, operator: 'is_true' }, FACTS)
      const negative = answerFlowCondition({ fact, operator: 'is_false' }, FACTS)
      expect(positive.kind === 'answered' && negative.kind === 'answered').toBe(true)
      if (positive.kind !== 'answered' || negative.kind !== 'answered') continue
      expect(positive.branch, fact).not.toBe(negative.branch)
    }
  })

  it('refuses a lifecycle_state nobody can be in, and answers every state somebody can', () => {
    const unreadable = answerFlowCondition(
      { fact: 'lifecycle_state', operator: 'equals', value: 'dormant' },
      FACTS,
    )
    expect(unreadable.kind).toBe('unreadable')
    // The control, over the WHOLE vocabulary rather than one member: a guard that refused everything
    // would satisfy the assertion above and halt every run in the business.
    for (const state of CUSTOMER_LIFECYCLE_STATES) {
      expect(
        answerFlowCondition({ fact: 'lifecycle_state', operator: 'equals', value: state }, FACTS)
          .kind,
        state,
      ).toBe('answered')
    }
  })

  it('halts the run rather than taking the false branch when it cannot read the condition', () => {
    // Parsed for SHAPE only, on purpose: `validateFlowDefinition` now refuses this document by name
    // (`flow-dsl-unknown-lifecycle-state`), so the only way to hold one is to bypass the check — which is
    // exactly the case the halt exists for, a document published by a build that did not have it.
    const definition = shaped({
      ...loopingFlow(),
      nodes: [
        { id: 'start', kind: 'trigger', event: 'manual' },
        { id: 'beat', kind: 'delay', minutes: 1 },
        {
          id: 'booked_yet',
          kind: 'condition',
          // A state the vocabulary does not hold. `validateFlowDefinition` refuses this at publish time
          // now; the halt is what protects a document published before that check existed.
          test: { fact: 'lifecycle_state', operator: 'equals', value: 'dormant' },
        },
        { id: 'touch', kind: 'action_tag', tag: 'nurture_touch' },
        { id: 'done', kind: 'exit', reason: 'goal_met' },
      ],
    })
    const plan = planFlowStep({
      definition,
      cursorNodeId: 'booked_yet',
      executionsSoFar: 0,
      maxNodeExecutions: MAX_FLOW_NODE_EXECUTIONS,
      at: AT,
      delayElapsedFrom: AT,
      facts: FACTS,
      splitSeedPrefix: 'run',
    })
    expect(plan.kind).toBe('halt')
    if (plan.kind !== 'halt') return
    expect(plan.reason).toBe('condition_unreadable')
  })
})

describe('a split divides by weight and never re-draws', () => {
  const branches = [
    { label: 'a', weightPerMille: 250 },
    { label: 'b', weightPerMille: 250 },
    { label: 'c', weightPerMille: 500 },
  ]

  it('answers the same branch for the same seed, however many times it is asked', () => {
    // The replay property, and the reason `Math.random` would be wrong here even if it were permitted:
    // an at-least-once queue delivers the same node twice, and two draws would put one contact on two
    // paths through one flow.
    const first = chooseSplitBranch(branches, 'run-7:split_node')
    for (let again = 0; again < 100; again += 1) {
      expect(chooseSplitBranch(branches, 'run-7:split_node')).toBe(first)
    }
  })

  it('divides 4,000 runs in roughly the declared proportions', () => {
    const counts = new Map<string, number>(branches.map((branch) => [branch.label, 0]))
    const draws = 4_000
    for (let run = 0; run < draws; run += 1) {
      const label = chooseSplitBranch(branches, `run-${run}:split_node`)
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    for (const branch of branches) {
      const share = (counts.get(branch.label) ?? 0) / draws
      const expected = branch.weightPerMille / 1000
      // A generous band, and deliberately so: the claim is that the hash divides rather than that it is
      // a uniform generator, and a tight band over a fixed seed set would be its own flake (brief rule
      // 22). Measured at 0.247/0.253/0.500 on this seed set; the band is three points either side.
      expect(Math.abs(share - expected), `${branch.label} got ${share}`).toBeLessThan(0.03)
    }
    // And the control: no branch is starved, which a hash that always answered the first label would be.
    for (const branch of branches) expect(counts.get(branch.label) ?? 0).toBeGreaterThan(draws / 10)
  })
})

describe('a dry run projects the whole plan, or reports what it left out', () => {
  const audience = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      customerId: `contact-${String(index).padStart(4, '0')}`,
      facts: { ...FACTS, hasFutureAppointment: true },
    }))

  it('projects every row when the audience fits, and reports nothing omitted', () => {
    const definition = parsed(loopingFlow())
    const projection = projectDryRun({
      definition,
      audience: audience(3),
      startAt: AT,
      maxProjectedRows: MAX_DRY_RUN_PROJECTED_ROWS,
      maxNodeExecutions: MAX_FLOW_NODE_EXECUTIONS,
      splitSeedPrefix: 'dry',
    })
    expect(projection.audienceSize).toBe(3)
    expect(projection.projectedRowsOmitted).toBe(0)
    expect(projection.contactsOmitted).toBe(0)
    // Every contact reached the exit, which is the plan being COMPLETE rather than merely non-empty.
    const finished = projection.rows.filter((row) => row.nodeKind === 'exit')
    expect(finished).toHaveLength(3)
    // And the projection walks THROUGH the delay rather than stopping at it: the exit's planned instant
    // is a minute after the start, which is the delay this flow declares.
    expect(finished.every((row) => row.plannedAt === AT + 60_000)).toBe(true)
  })

  it('reports the overflow rather than truncating the plan in silence', () => {
    const definition = parsed(loopingFlow())
    const cap = 7
    const projection = projectDryRun({
      definition,
      audience: audience(40),
      startAt: AT,
      maxProjectedRows: cap,
      maxNodeExecutions: MAX_FLOW_NODE_EXECUTIONS,
      splitSeedPrefix: 'dry',
    })
    expect(projection.rows.length).toBeLessThanOrEqual(cap)
    // The whole point of the line: a non-zero figure, so a reader can tell this is not the whole plan.
    expect(projection.projectedRowsOmitted).toBeGreaterThan(0)
    expect(projection.contactsOmitted).toBeGreaterThan(0)
    // The audience size is reported WHOLE even though most of it was not projected, because "how many
    // people would this reach" is the question a cap must not change the answer to.
    expect(projection.audienceSize).toBe(40)
  })

  it('records a halt as the last projected row, so a plan that stops says why', () => {
    const definition = parsed(loopingFlow())
    const projection = projectDryRun({
      definition,
      // The contact who never books: the projection walks the loop until the cap and then halts.
      audience: [{ customerId: 'contact-loops', facts: { ...FACTS, hasFutureAppointment: false } }],
      startAt: AT,
      maxProjectedRows: MAX_DRY_RUN_PROJECTED_ROWS,
      maxNodeExecutions: 6,
      splitSeedPrefix: 'dry',
    })
    expect(projection.rows.at(-1)?.nodeKind).toBe('halt')
    expect(projection.projectedRowsOmitted).toBe(0)
    // The control: a contact who DOES book ends on an exit over the same document, so the halt above is
    // the loop and not the projection giving up on every input.
    const booking = projectDryRun({
      definition,
      audience: [{ customerId: 'contact-books', facts: { ...FACTS, hasFutureAppointment: true } }],
      startAt: AT,
      maxProjectedRows: MAX_DRY_RUN_PROJECTED_ROWS,
      maxNodeExecutions: 6,
      splitSeedPrefix: 'dry',
    })
    expect(booking.rows.at(-1)?.nodeKind).toBe('exit')
  })
})
