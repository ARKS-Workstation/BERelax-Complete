import { FLOW_NODE_KINDS } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  INVALID_FLOW_FIXTURES,
  VALID_FLOW_FIXTURES,
} from '../../test/fixtures/flow-definitions/index.ts'
import { parseFlowDefinition } from './dsl.ts'
import { analyseFlowGraph, declaredBranchesOf } from './static-analysis.ts'

const parse = (document: unknown) => {
  const parsed = parseFlowDefinition(document)
  if (!parsed.ok) {
    throw new Error(
      `the fixture no longer parses: ${parsed.refusals.map((r) => r.rule).join(', ')}. The analysis ` +
        'tests below would then be asserting about a document nothing read.',
    )
  }
  return parsed.definition
}

const documentOf = (fragment: string, from = VALID_FLOW_FIXTURES) => {
  const fixture = from.find((candidate) => candidate.file.includes(fragment))
  if (fixture === undefined) throw new Error(`no fixture matching ${fragment}`)
  return parse(fixture.document)
}

describe('a loop is allowed when it can be left', () => {
  it('accepts the nurture loop and reports it as a cycle', () => {
    const analysis = analyseFlowGraph(documentOf('bounded-nurture-loop'))
    expect(analysis.refusals).toEqual([])
    // Reported rather than merely permitted: C-AUTO-07 reads this to decide whether an execution cap can
    // ever be reached, and a cycle the analyser does not SEE is one it cannot have judged.
    expect(analysis.facts.cycles).toHaveLength(1)
    expect(analysis.facts.cycles[0]).toEqual(['booked_yet', 'month', 'touch'])
  })

  it('refuses the same loop with nothing leaving it — the control', () => {
    // The two documents differ by one edge. Without this pair, "the loop is allowed" could be a cycle
    // rule that never fires at all.
    const analysis = analyseFlowGraph(
      documentOf('cycle-with-no-bounded-exit', INVALID_FLOW_FIXTURES),
    )
    expect(analysis.refusals.map((refusal) => refusal.rule)).toContain(
      'flow-analysis-cycle-has-no-bounded-exit',
    )
  })

  it('refuses a loop whose only escape leads into another loop with no exit', () => {
    // "Bounded" is not "has an edge leaving it". An escape into a second loop that cannot end is an
    // enrolment that still never finishes, and a check that only counted outgoing edges would accept it —
    // while accepting every document the corpus contains, because the corpus's bad loop has no escape at
    // all. This is the case that tells the two implementations apart.
    const trap = parse({
      dslVersion: 1,
      key: 'escape_into_a_trap',
      title: 'Escape into a trap',
      nodes: [
        { id: 'start', kind: 'trigger', event: 'manual' },
        { id: 'first_wait', kind: 'delay', minutes: 60 },
        { id: 'leave', kind: 'condition', test: { fact: 'is_vip', operator: 'is_true' } },
        { id: 'second_wait', kind: 'delay', minutes: 60 },
        { id: 'trapped', kind: 'action_tag', tag: 'trapped' },
        { id: 'done', kind: 'exit', reason: 'completed' },
      ],
      edges: [
        { branch: 'default', from: 'start', to: 'first_wait' },
        { branch: 'default', from: 'first_wait', to: 'leave' },
        // The first loop's escape: the `true` branch leaves it — into the second loop, which is closed.
        { branch: 'true', from: 'leave', to: 'second_wait' },
        { branch: 'false', from: 'leave', to: 'first_wait' },
        { branch: 'default', from: 'second_wait', to: 'trapped' },
        { branch: 'default', from: 'trapped', to: 'second_wait' },
      ],
    })
    const rules = analyseFlowGraph(trap).refusals.map((refusal) => refusal.rule)
    expect(rules).toContain('flow-analysis-cycle-has-no-bounded-exit')
    // Both loops are named, and the exit is unreachable — three facts about one document, so a reader is
    // not left to infer which loop is the problem.
    expect(rules.filter((rule) => rule === 'flow-analysis-cycle-has-no-bounded-exit')).toHaveLength(
      2,
    )
    expect(rules).toContain('flow-analysis-unreachable-node')
  })

  it('counts a cycle’s delay ONCE, not per pass', () => {
    // The condensation decision, asserted: the loop waits thirty days per pass and the accumulated figure
    // is thirty days, not a multiple of it and not infinity. A repeat is bounded by C-AUTO-07's execution
    // cap rather than by arithmetic here, and 0070's header and this module's say so.
    const analysis = analyseFlowGraph(documentOf('bounded-nurture-loop'))
    expect(analysis.facts.maxAccumulatedDelayMinutes).toBe(30 * 24 * 60)
  })
})

describe('the accumulated delay is the longest path, not the total', () => {
  const branching = parse({
    dslVersion: 1,
    key: 'branching_delays',
    title: 'Branching delays',
    nodes: [
      { id: 'start', kind: 'trigger', event: 'manual' },
      { id: 'which', kind: 'condition', test: { fact: 'is_vip', operator: 'is_true' } },
      { id: 'long', kind: 'delay', minutes: 10 * 24 * 60 },
      { id: 'short', kind: 'delay', minutes: 3 * 24 * 60 },
      { id: 'done', kind: 'exit', reason: 'completed' },
    ],
    edges: [
      { branch: 'default', from: 'start', to: 'which' },
      { branch: 'true', from: 'which', to: 'long' },
      { branch: 'false', from: 'which', to: 'short' },
      { branch: 'default', from: 'long', to: 'done' },
      { branch: 'default', from: 'short', to: 'done' },
    ],
  })

  it('reports the longer branch', () => {
    expect(analyseFlowGraph(branching).facts.maxAccumulatedDelayMinutes).toBe(10 * 24 * 60)
  })

  it('does NOT report the sum of the branches — the control', () => {
    // Summing every delay in the document is the obvious implementation and it is wrong: no enrolment
    // takes both branches. It would also make every branching flow fail the 180-day bound as soon as it
    // had enough branches, which is a refusal an operator cannot act on.
    expect(analyseFlowGraph(branching).facts.maxAccumulatedDelayMinutes).not.toBe(13 * 24 * 60)
  })

  it('adds a delay AFTER the loop to the loop’s own', () => {
    const afterLoop = parse({
      dslVersion: 1,
      key: 'delay_after_loop',
      title: 'Delay after a loop',
      nodes: [
        { id: 'start', kind: 'trigger', event: 'manual' },
        { id: 'month', kind: 'delay', minutes: 30 * 24 * 60 },
        { id: 'again', kind: 'condition', test: { fact: 'is_vip', operator: 'is_true' } },
        { id: 'work', kind: 'action_tag', tag: 'touched' },
        { id: 'cool_off', kind: 'delay', minutes: 5 * 24 * 60 },
        { id: 'done', kind: 'exit', reason: 'completed' },
      ],
      edges: [
        { branch: 'default', from: 'start', to: 'month' },
        { branch: 'default', from: 'month', to: 'again' },
        { branch: 'true', from: 'again', to: 'work' },
        { branch: 'false', from: 'again', to: 'cool_off' },
        { branch: 'default', from: 'work', to: 'month' },
        { branch: 'default', from: 'cool_off', to: 'done' },
      ],
    })
    expect(analyseFlowGraph(afterLoop).facts.maxAccumulatedDelayMinutes).toBe(35 * 24 * 60)
  })
})

describe('reachability', () => {
  it('excludes a node nothing leads to, and says so', () => {
    const analysis = analyseFlowGraph(documentOf('unreachable-node', INVALID_FLOW_FIXTURES))
    expect(analysis.facts.reachableNodeIds).not.toContain('orphan')
    expect(analysis.refusals.map((refusal) => refusal.rule)).toContain(
      'flow-analysis-unreachable-node',
    )
  })

  it('reaches every node of the sixty-node ceiling flow', () => {
    // The widest document the DSL permits, analysed for correctness and not for speed: a wall-clock
    // assertion here would measure the machine (brief rule 23), so what is asserted is the WORK — every
    // one of the sixty nodes is reached and nothing is refused.
    const analysis = analyseFlowGraph(documentOf('sixty-node-ceiling'))
    expect(analysis.facts.reachableNodeIds).toHaveLength(60)
    expect(analysis.refusals).toEqual([])
  })
})

describe('declaredBranchesOf is total over the node kinds', () => {
  const sample: Record<string, unknown> = {
    trigger: { id: 'n', kind: 'trigger', event: 'manual' },
    delay: { id: 'n', kind: 'delay', minutes: 1 },
    condition: { id: 'n', kind: 'condition', test: { fact: 'is_vip', operator: 'is_true' } },
    action_message: {
      id: 'n',
      kind: 'action_message',
      messageClass: 'promotional',
      templateKey: 'review.request',
      channel: 'sms',
    },
    action_tag: { id: 'n', kind: 'action_tag', tag: 'tagged' },
    action_stage: { id: 'n', kind: 'action_stage', stage: 'lapsed' },
    split: {
      id: 'n',
      kind: 'split',
      branches: [
        { label: 'a', weightPerMille: 500 },
        { label: 'b', weightPerMille: 500 },
      ],
    },
    exit: { id: 'n', kind: 'exit', reason: 'completed' },
  }

  it('answers for every kind, and the sample covers all of them', () => {
    // The totality is the test. A kind added to the vocabulary and not to the switch would fall into the
    // `default` arm and be given a `default` branch — which for a second terminal kind would mean the
    // analyser demanding an outgoing edge from a node that ends the flow.
    expect([...Object.keys(sample)].sort()).toEqual([...FLOW_NODE_KINDS].sort())
    const answers = new Map<string, readonly string[]>()
    for (const kind of FLOW_NODE_KINDS) {
      const node = parse({
        dslVersion: 1,
        key: 'branch_probe',
        title: 'Branch probe',
        nodes: [sample[kind]],
        edges: [],
      }).nodes[0]
      if (node === undefined) throw new Error(`the ${kind} sample did not parse`)
      answers.set(kind, declaredBranchesOf(node))
    }
    expect(answers.get('exit')).toEqual([])
    expect(answers.get('condition')).toEqual(['true', 'false'])
    expect(answers.get('split')).toEqual(['a', 'b'])
    for (const kind of ['trigger', 'delay', 'action_message', 'action_tag', 'action_stage']) {
      expect(answers.get(kind), `${kind} has one way out`).toEqual(['default'])
    }
  })
})
