import {
  FLOW_TRIGGER_EVENTS,
  MAX_FLOW_ACCUMULATED_DELAY_MINUTES,
  MAX_FLOW_NODES,
} from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  CORPUS_TEMPLATES,
  VALID_FLOW_FIXTURES,
} from '../../test/fixtures/flow-definitions/index.ts'
import { APPOINTMENT_STATUSES, eventTypeFor } from '../lifecycle/transitions.ts'
import {
  checkFlowIntegrity,
  deserialiseFlowDefinition,
  flowRuleOf,
  parseFlowDefinition,
  serialiseFlowDefinition,
  validateFlowDefinition,
} from './dsl.ts'

const TEMPLATES = { templates: [...CORPUS_TEMPLATES] }

describe('the trigger vocabulary is pinned to events that exist', () => {
  it('is exactly the appointment lifecycle events plus `manual`, in both directions', () => {
    // The strong version, for `message-template.itest.ts`'s reason about the sixteen approval pairs: two
    // lists that refuse everything agree perfectly, so the permitted set has to be compared as well.
    //
    // What each direction catches. A lifecycle event MISSING from FLOW_TRIGGER_EVENTS means B-LIFE added
    // a transition and nobody decided whether a flow may start on it — the decision is then made by
    // omission, and the flow an operator wants cannot be drawn. An event here that the lifecycle does NOT
    // emit is a trigger that can never fire: the flow publishes, the operator waits, and nothing happens
    // for a reason no log contains.
    const emitted = new Set(
      APPOINTMENT_STATUSES.map((status) => eventTypeFor(status)).filter(
        (event): event is string => event !== null,
      ),
    )
    const declared = new Set(FLOW_TRIGGER_EVENTS.filter((event) => event !== 'manual'))
    expect([...declared].sort(), 'a trigger naming an event nothing emits can never fire').toEqual(
      [...emitted].sort(),
    )
    expect(FLOW_TRIGGER_EVENTS).toContain('manual')
  })

  it('the control: a made-up event is not in the vocabulary', () => {
    // Without this, the equality above would also hold for a vocabulary somebody widened to `string`.
    expect((FLOW_TRIGGER_EVENTS as readonly string[]).includes('appointment.reviewed')).toBe(false)
  })
})

describe('the committed corpus of valid definitions', () => {
  it('holds twelve documents', () => {
    expect(VALID_FLOW_FIXTURES).toHaveLength(12)
  })

  for (const fixture of VALID_FLOW_FIXTURES) {
    it(`validates ${fixture.file}`, () => {
      const result = validateFlowDefinition(fixture.document, TEMPLATES)
      expect(
        result.ok,
        result.ok ? '' : result.refusals.map((r) => `${r.rule}@${r.at ?? '-'}`).join(', '),
      ).toBe(true)
      if (!result.ok) return
      // The facts are asserted rather than merely produced: a validator that returned `{ok: true}` with
      // an empty fact set would satisfy every "it validates" assertion ever written against it.
      expect(result.facts.nodeCount).toBe(result.definition.nodes.length)
      expect(result.facts.key).toBe(result.definition.key)
      expect(result.facts.dslVersion).toBe(1)
      expect(result.facts.reachableNodeIds.length).toBe(result.definition.nodes.length)
      expect(result.facts.maxAccumulatedDelayMinutes).toBeLessThanOrEqual(
        MAX_FLOW_ACCUMULATED_DELAY_MINUTES,
      )
    })
  }

  it('includes both boundaries, which is what makes the two bounds asserted from both sides', () => {
    const ceiling = VALID_FLOW_FIXTURES.find((f) => f.file.includes('sixty-node-ceiling'))
    const delayCeiling = VALID_FLOW_FIXTURES.find((f) => f.file.includes('delay-ceiling'))
    const nodes = validateFlowDefinition(ceiling?.document, TEMPLATES)
    const delays = validateFlowDefinition(delayCeiling?.document, TEMPLATES)
    expect(nodes.ok && nodes.facts.nodeCount).toBe(MAX_FLOW_NODES)
    expect(delays.ok && delays.facts.maxAccumulatedDelayMinutes).toBe(
      MAX_FLOW_ACCUMULATED_DELAY_MINUTES,
    )
  })

  it('every message node in the corpus names a template the registry holds', () => {
    // The corpus is authored against the SEEDED template estate, and `flow-corpus.itest.ts` asserts that
    // estate against the database. Without this assertion the corpus could reference a key nobody has,
    // and every validation above would still pass — because a document with no message node needs no
    // registry at all.
    const keys = new Set(CORPUS_TEMPLATES.map((template) => template.templateKey))
    let messageNodes = 0
    for (const fixture of VALID_FLOW_FIXTURES) {
      const parsed = parseFlowDefinition(fixture.document)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) continue
      for (const node of parsed.definition.nodes) {
        if (node.kind !== 'action_message') continue
        messageNodes += 1
        expect(keys, `${fixture.file} names ${node.templateKey}`).toContain(node.templateKey)
      }
    }
    // The control: if no fixture had a message node the loop above would assert nothing, and the class
    // rule — the one thing in this DSL that can cause a regulatory breach — would be untested here.
    expect(messageNodes).toBeGreaterThanOrEqual(4)
  })
})

describe('the canonical form', () => {
  it('sorts keys at every level, ends with a newline, and is idempotent', () => {
    const parsed = parseFlowDefinition(VALID_FLOW_FIXTURES[0]?.document)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const once = serialiseFlowDefinition(parsed.definition)
    expect(once.endsWith('\n')).toBe(true)
    const again = deserialiseFlowDefinition(once)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(serialiseFlowDefinition(again.definition)).toBe(once)

    const document = JSON.parse(once) as { nodes: Record<string, unknown>[] }
    for (const node of document.nodes) {
      expect([...Object.keys(node)], 'node keys are sorted').toEqual([...Object.keys(node)].sort())
    }
  })

  it('is insensitive to the key order it is given — and the control, which is that this is work', () => {
    // Two documents that differ only in key order must serialise identically, because the form has to
    // survive a round trip through `jsonb` (which preserves neither key order nor whitespace).
    const straight = {
      dslVersion: 1,
      key: 'order_probe',
      title: 'Order probe',
      nodes: [{ id: 'start', kind: 'trigger', event: 'manual' }],
      edges: [{ branch: 'default', from: 'start', to: 'start' }],
    }
    const shuffled = {
      edges: [{ to: 'start', from: 'start', branch: 'default' }],
      nodes: [{ kind: 'trigger', event: 'manual', id: 'start' }],
      title: 'Order probe',
      key: 'order_probe',
      dslVersion: 1,
    }
    const first = parseFlowDefinition(straight)
    const second = parseFlowDefinition(shuffled)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(serialiseFlowDefinition(second.definition)).toBe(
      serialiseFlowDefinition(first.definition),
    )
    // And the bytes are SORTED, which is the assertion that can actually fail. Equality between the two
    // alone cannot: zod builds its result by walking the schema's own keys, so both parses come out in
    // schema order whatever order they went in — a serialiser that had stopped sorting would satisfy the
    // line above and produce `nodes` before `edges`.
    const keys = Object.keys(JSON.parse(serialiseFlowDefinition(second.definition)) as object)
    expect(keys).toEqual([...keys].sort())
    // The control. A plain `JSON.stringify` of the shuffled document is NOT the canonical form, so the
    // equality above is the sorting doing something rather than two documents that were already equal.
    expect(`${JSON.stringify(shuffled, null, 2)}\n`).not.toBe(
      serialiseFlowDefinition(second.definition),
    )
  })

  it('survives rubbish in the place of a document, and still names what it can', () => {
    // The pre-pass that names an unknown kind reads a RAW candidate, so it meets whatever an API was
    // handed. Every guard in it is here because the alternative is a TypeError reaching a route as a 500,
    // and a 500 is not a refusal an operator can act on.
    for (const rubbish of [null, 42, 'a string', [], { nodes: 'not an array' }]) {
      const result = parseFlowDefinition(rubbish)
      expect(result.ok, `${JSON.stringify(rubbish)} is not a definition`).toBe(false)
      if (result.ok) continue
      expect(result.refusals.length).toBeGreaterThan(0)
    }
    // A node that is not an object, and a kind that is not a string: both skipped by the pre-pass and
    // left to zod, which is the division of labour rather than an oversight.
    const oddNodes = parseFlowDefinition({
      dslVersion: 1,
      edges: [],
      key: 'odd_nodes',
      nodes: ['not an object', { id: 'x', kind: 7 }, { kind: 'wait_for_it' }],
      title: 'Odd nodes',
    })
    expect(oddNodes.ok).toBe(false)
    if (oddNodes.ok) return
    const rules = oddNodes.refusals.map((refusal) => refusal.rule)
    expect(rules).toContain('flow-dsl-unknown-node-kind')
    // The unknown kind is reported at its INDEX when the node has no usable id, so a builder can still
    // point at it.
    expect(
      oddNodes.refusals.find((refusal) => refusal.rule === 'flow-dsl-unknown-node-kind')?.at,
    ).toBe('nodes.2')
  })

  it('refuses text that is not JSON as a shape refusal rather than throwing', () => {
    const result = deserialiseFlowDefinition('{ not json at all')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusals[0]?.rule).toBe('flow-dsl-shape-invalid')
  })
})

describe('flowRuleOf', () => {
  it('reads the rule a schema message carries, and falls back to the shape rule', () => {
    expect(flowRuleOf('flow-dsl-delay-exceeds-maximum: one delay may not exceed')).toBe(
      'flow-dsl-delay-exceeds-maximum',
    )
    expect(flowRuleOf('Invalid input: expected string')).toBe('flow-dsl-shape-invalid')
    // The control: a plausible-looking name that is not in the vocabulary is not adopted. A mapper that
    // trusted the prefix would report refusals under rules nothing else in the system knows.
    expect(flowRuleOf('flow-dsl-not-a-real-rule: hello')).toBe('flow-dsl-shape-invalid')
  })
})

describe('checkFlowIntegrity', () => {
  it('passes a valid document and fails closed with no registry', () => {
    const parsed = parseFlowDefinition(VALID_FLOW_FIXTURES[0]?.document)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(checkFlowIntegrity(parsed.definition, TEMPLATES)).toEqual([])
    expect(checkFlowIntegrity(parsed.definition, {}).map((refusal) => refusal.rule)).toEqual([
      'flow-dsl-templates-not-checked',
    ])
  })

  it('reports a dangling edge in BOTH directions', () => {
    // Two different mistakes with one rule name: a deleted TARGET (the corpus's case) and a deleted
    // SOURCE, which is what a builder leaves behind when it removes the step a wire came from. Only the
    // first was exercised by the corpus, and a check that looked at `to` alone would have passed it.
    const base = {
      dslVersion: 1,
      edges: [
        { branch: 'default', from: 'start', to: 'done' },
        { branch: 'default', from: 'ghost', to: 'done' },
      ],
      key: 'dangling_from',
      nodes: [
        { event: 'manual', id: 'start', kind: 'trigger' },
        { id: 'done', kind: 'exit', reason: 'completed' },
      ],
      title: 'Dangling from',
    }
    const parsed = parseFlowDefinition(base)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const refusals = checkFlowIntegrity(parsed.definition, TEMPLATES)
    expect(refusals.map((refusal) => refusal.rule)).toEqual(['flow-dsl-dangling-edge'])
    expect(refusals[0]?.detail).toContain('ghost')
  })

  it('needs no registry for a definition that sends nothing', () => {
    // A flow of tags and stage moves has no class to check, so demanding a registry for it would make
    // the fail-closed rule fire on documents it has nothing to say about — and the first response to
    // that would be to pass an empty registry everywhere, which disables the check for real flows too.
    const noMessages = VALID_FLOW_FIXTURES.find((f) => f.file.includes('no-show-stage-move'))
    const parsed = parseFlowDefinition(noMessages?.document)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(checkFlowIntegrity(parsed.definition, {})).toEqual([])
  })
})
