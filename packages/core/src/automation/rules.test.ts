import { FLOW_RULES, MAX_FLOW_ACCUMULATED_DELAY_MINUTES, MAX_FLOW_NODES } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  CORPUS_TEMPLATES,
  INVALID_FLOW_FIXTURES,
} from '../../test/fixtures/flow-definitions/index.ts'
import { type FlowRule, type FlowValidationDeps, validateFlowDefinition } from './dsl.ts'

/**
 * One known-bad document per RULE, and the assertion that the table covers every rule there is.
 *
 * ADR 0003 applied to a validator rather than to a gate: a rule that has never been seen to fire may not
 * be a rule at all. Twelve of the documents are the committed corpus (which is the acceptance line's
 * "12 invalid definitions"); the rest are inline, because a rule like "two branches share a label" is a
 * mistake a builder makes and not a flow anybody would commit.
 *
 * The LAST case is the one that keeps the file honest. `every rule is exercised` compares the rules this
 * table claims against `FLOW_RULES`, in both directions: a rule added to the vocabulary without a case
 * fails here, and a case naming a rule that no longer exists does not compile.
 */

/** A small, valid definition every case below breaks in one way. */
const base = () => ({
  dslVersion: 1,
  key: 'rule_probe',
  title: 'Rule probe',
  nodes: [
    { id: 'start', kind: 'trigger', event: 'appointment.completed' },
    { id: 'wait', kind: 'delay', minutes: 60 },
    { id: 'ask', kind: 'condition', test: { fact: 'is_vip', operator: 'is_true' } },
    {
      id: 'send',
      kind: 'action_message',
      messageClass: 'promotional',
      templateKey: 'review.request',
      channel: 'sms',
    },
    { id: 'done', kind: 'exit', reason: 'completed' },
    { id: 'skipped', kind: 'exit', reason: 'not_eligible' },
  ] as Record<string, unknown>[],
  edges: [
    { branch: 'default', from: 'start', to: 'wait' },
    { branch: 'default', from: 'wait', to: 'ask' },
    { branch: 'true', from: 'ask', to: 'send' },
    { branch: 'false', from: 'ask', to: 'skipped' },
    { branch: 'default', from: 'send', to: 'done' },
  ] as Record<string, unknown>[],
})

const TEMPLATES: FlowValidationDeps = { templates: [...CORPUS_TEMPLATES] }

/** A chain of `count` nodes: a trigger, tags, and one exit. Used for both sides of the node-count bound. */
const chainOf = (count: number) => {
  const document = base()
  document.nodes = [{ id: 'start', kind: 'trigger', event: 'manual' }]
  document.edges = []
  let previous = 'start'
  for (let step = 1; step <= count - 2; step += 1) {
    const id = `step_${String(step).padStart(2, '0')}`
    document.nodes.push({ id, kind: 'action_tag', tag: `step_${String(step).padStart(2, '0')}` })
    document.edges.push({ branch: 'default', from: previous, to: id })
    previous = id
  }
  document.nodes.push({ id: 'done', kind: 'exit', reason: 'completed' })
  document.edges.push({ branch: 'default', from: previous, to: 'done' })
  return document
}

interface RuleCase {
  readonly rule: FlowRule
  readonly why: string
  readonly document: unknown
  /** Only `flow-dsl-templates-not-checked` needs its own deps: it is the absence of the registry. */
  readonly deps?: FlowValidationDeps
}

const inlineCases: readonly RuleCase[] = [
  {
    rule: 'flow-dsl-unsupported-dsl-version',
    why: 'A shape this build does not implement, read optimistically, is a flow that sends what nobody drew.',
    document: { ...base(), dslVersion: 2 },
  },
  {
    rule: 'flow-dsl-delay-exceeds-maximum',
    why: 'One delay longer than the maximum accumulated path delay could never be reached inside the bound.',
    document: (() => {
      const document = base()
      document.nodes[1] = {
        id: 'wait',
        kind: 'delay',
        minutes: MAX_FLOW_ACCUMULATED_DELAY_MINUTES + 1,
      }
      return document
    })(),
  },
  {
    rule: 'flow-dsl-split-weights-do-not-sum',
    why: 'Weights that do not sum to 1000 leave a share of the audience on no branch at all.',
    document: (() => {
      const document = base()
      document.nodes[1] = {
        id: 'wait',
        kind: 'split',
        branches: [
          { label: 'a', weightPerMille: 400 },
          { label: 'b', weightPerMille: 500 },
        ],
      }
      document.edges = [
        { branch: 'default', from: 'start', to: 'wait' },
        { branch: 'a', from: 'wait', to: 'done' },
        { branch: 'b', from: 'wait', to: 'skipped' },
      ]
      document.nodes = document.nodes.filter(
        (node) => node['id'] !== 'ask' && node['id'] !== 'send',
      )
      return document
    })(),
  },
  {
    rule: 'flow-dsl-split-branch-labels-not-unique',
    why: 'Two branches sharing a label are one branch, and the second is silently unreachable.',
    document: (() => {
      const document = base()
      document.nodes[1] = {
        id: 'wait',
        kind: 'split',
        branches: [
          { label: 'a', weightPerMille: 500 },
          { label: 'a', weightPerMille: 500 },
        ],
      }
      return document
    })(),
  },
  {
    rule: 'flow-dsl-condition-operator-does-not-fit-fact',
    why: 'A picker left on `equals` after the fact was changed to a boolean one: nonsense that parses.',
    document: (() => {
      const document = base()
      document.nodes[2] = {
        id: 'ask',
        kind: 'condition',
        test: { fact: 'is_vip', operator: 'equals', value: 'yes' },
      }
      return document
    })(),
  },
  {
    rule: 'flow-dsl-edge-into-the-trigger',
    why: 'An enrolment re-entering the flow it is already on is the loop no execution cap can explain.',
    document: (() => {
      const document = base()
      document.edges.push({ branch: 'default', from: 'send', to: 'start' })
      return document
    })(),
  },
  {
    rule: 'flow-dsl-unknown-template',
    why: 'A key the registry does not hold: its class could not be compared with the declared one at all.',
    document: (() => {
      const document = base()
      document.nodes[3] = {
        id: 'send',
        kind: 'action_message',
        messageClass: 'promotional',
        templateKey: 'offers.spring_sale',
        channel: 'sms',
      }
      return document
    })(),
  },
  {
    rule: 'flow-dsl-templates-not-checked',
    why: 'Fail closed. A class check that silently did not run is ADR 0002 in the messaging estate.',
    document: base(),
    deps: {},
  },
  {
    rule: 'flow-dsl-shape-invalid',
    why: 'An unexpected key is a field of a flow somebody drew that this build does not implement.',
    document: (() => {
      const document = base()
      document.nodes[1] = { id: 'wait', kind: 'delay', minutes: 60, untilReplied: true }
      return document
    })(),
  },
  {
    rule: 'flow-dsl-node-count-exceeds-maximum',
    why: 'The bound from above, inline as well as in the corpus, because the corpus case is generated.',
    document: chainOf(MAX_FLOW_NODES + 1),
  },
  {
    rule: 'flow-analysis-cycle-has-no-delay',
    why: 'A loop with no delay runs as fast as the worker can poll; the execution cap is a backstop.',
    document: (() => {
      const document = base()
      document.nodes = [
        { id: 'start', kind: 'trigger', event: 'manual' },
        { id: 'ask', kind: 'condition', test: { fact: 'is_vip', operator: 'is_true' } },
        { id: 'tag_one', kind: 'action_tag', tag: 'one' },
        { id: 'tag_two', kind: 'action_tag', tag: 'two' },
        { id: 'done', kind: 'exit', reason: 'completed' },
      ]
      document.edges = [
        { branch: 'default', from: 'start', to: 'ask' },
        { branch: 'true', from: 'ask', to: 'tag_one' },
        { branch: 'false', from: 'ask', to: 'done' },
        { branch: 'default', from: 'tag_one', to: 'tag_two' },
        { branch: 'default', from: 'tag_two', to: 'tag_one' },
      ]
      return document
    })(),
  },
  {
    rule: 'flow-analysis-split-branch-missing',
    why: 'A declared branch with a weight and no edge routes that share of the audience nowhere.',
    document: (() => {
      const document = base()
      document.nodes = [
        { id: 'start', kind: 'trigger', event: 'manual' },
        {
          id: 'half',
          kind: 'split',
          branches: [
            { label: 'a', weightPerMille: 500 },
            { label: 'b', weightPerMille: 500 },
          ],
        },
        { id: 'done', kind: 'exit', reason: 'completed' },
      ]
      document.edges = [
        { branch: 'default', from: 'start', to: 'half' },
        { branch: 'a', from: 'half', to: 'done' },
      ]
      return document
    })(),
  },
  {
    rule: 'flow-analysis-edge-branch-not-declared',
    why: 'An edge leaving an exit, which is terminal: the branch it names does not exist on that kind.',
    document: (() => {
      const document = base()
      document.edges.push({ branch: 'default', from: 'done', to: 'skipped' })
      return document
    })(),
  },
  {
    rule: 'flow-analysis-ambiguous-branch',
    why: 'Two edges on one branch leave the interpreter to choose, and two runs would differ unexplainably.',
    document: (() => {
      const document = base()
      document.edges.push({ branch: 'default', from: 'wait', to: 'done' })
      return document
    })(),
  },
  {
    rule: 'flow-analysis-no-exit-reachable',
    why:
      'The exit exists and nothing leads to it, so no enrolment on this flow can ever finish. Stated ' +
      'as its own rule rather than left to the cycle rules, because the question an operator asks is ' +
      '"can this end" and the answer has to be reported in those words.',
    document: (() => {
      const document = base()
      document.nodes = [
        { id: 'start', kind: 'trigger', event: 'manual' },
        { id: 'tag_it', kind: 'action_tag', tag: 'one' },
        { id: 'tag_two', kind: 'action_tag', tag: 'two' },
        { id: 'done', kind: 'exit', reason: 'completed' },
      ]
      document.edges = [
        { branch: 'default', from: 'start', to: 'tag_it' },
        { branch: 'default', from: 'tag_it', to: 'tag_two' },
        { branch: 'default', from: 'tag_two', to: 'tag_it' },
      ]
      return document
    })(),
  },
]

const corpusCases: readonly RuleCase[] = INVALID_FLOW_FIXTURES.map((fixture) => ({
  rule: fixture.rule,
  why: `${fixture.file}: ${fixture.why}`,
  document: fixture.document,
}))

const allCases: readonly RuleCase[] = [...corpusCases, ...inlineCases]

describe('every flow rule fires, by name', () => {
  for (const probe of allCases) {
    it(`refuses ${probe.rule} — ${probe.why}`, () => {
      const result = validateFlowDefinition(probe.document, probe.deps ?? TEMPLATES)
      expect(result.ok, 'the document must be refused').toBe(false)
      if (result.ok) return
      expect(
        result.refusals.map((refusal) => refusal.rule),
        `refused, but not by ${probe.rule}`,
      ).toContain(probe.rule)
      // Every refusal says something. A rule reported with an empty detail is a rule an operator cannot
      // act on, and the builder shows this text.
      for (const refusal of result.refusals) expect(refusal.detail.length).toBeGreaterThan(20)
    })
  }

  it('covers every rule in the vocabulary, and names none that does not exist', () => {
    const covered = new Set<string>(allCases.map((probe) => probe.rule))
    const missing = FLOW_RULES.filter((rule) => !covered.has(rule))
    expect(
      missing,
      'a rule with no known-bad document may not be a rule at all (ADR 0003). Add a case above.',
    ).toEqual([])
    // The other direction. `RuleCase.rule` is typed as `FlowRule`, so a stale name is a compile error
    // rather than a runtime one — this assertion is the reason that typing is load-bearing.
    expect(
      [...covered].filter((rule) => !(FLOW_RULES as readonly string[]).includes(rule)),
    ).toEqual([])
  })

  it('the control: the unbroken probe passes, so the refusals above are the breakage', () => {
    // Without this, every case above could be failing for a reason the document shares with the base —
    // a stale vocabulary, a template key nobody registered — and each one would still report PASS.
    const result = validateFlowDefinition(base(), TEMPLATES)
    expect(
      result.ok,
      result.ok ? '' : result.refusals.map((r) => `${r.rule}@${r.at}`).join(', '),
    ).toBe(true)
  })
})
