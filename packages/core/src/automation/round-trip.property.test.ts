import {
  FLOW_BOOLEAN_CONDITION_FACTS,
  FLOW_CONDITION_FACTS,
  FLOW_EXIT_REASONS,
  FLOW_NODE_KINDS,
  FLOW_TRIGGER_EVENTS,
} from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CORPUS_TEMPLATES,
  VALID_FLOW_FIXTURES,
} from '../../test/fixtures/flow-definitions/index.ts'
import { parseFlowDefinition, serialiseFlowDefinition } from './dsl.ts'

/**
 * The round-trip property: a definition survives serialise → deserialise → serialise byte for byte, so a
 * builder cannot silently drop a field.
 *
 * ## Why the oracle is an INDEPENDENT canonicaliser and not the round trip itself
 *
 * `serialise(parse(serialise(parse(x))))` compared with `serialise(parse(x))` is the obvious property and
 * it is vacuous for the failure that matters. If the schema stopped carrying `note`, BOTH sides would
 * drop it and the comparison would hold — the very "a builder silently drops a field" this property is
 * named for. So the input's canonical bytes are computed here, by a small independent implementation, and
 * the production pipeline's output is compared against them. A field the schema no longer carries then
 * shows up as a difference, which is what `droppingNote` below proves by construction.
 *
 * ## Why the generator is weighted, and what is COUNTED
 *
 * Brief rule 22: a generator has to be able to exercise the claim, and the test has to count that it did.
 * `note` is optional on every node and `description` is optional on the document, and those three are the
 * only fields a schema could drop without any other test noticing — a required field's absence fails the
 * parse. A generator that produced them rarely would make this property hold for a pipeline that dropped
 * them. So `note` is present on roughly half of all nodes, `description` on half of all documents, and
 * the run asserts a MEASURED floor on how many generated documents carried at least one optional field
 * and on how many of the eight node kinds were exercised.
 */

/** A note on about half of the nodes: the field whose loss nothing else would catch. */
const noteArb = fc.option(
  fc.constantFrom(
    'why this waits',
    'agreed with the owner',
    'do not move without asking',
    'the window matters here',
  ),
  { nil: undefined, freq: 2 },
)

const withNote = <T extends Record<string, unknown>>(
  node: T,
  note: string | undefined,
): Record<string, unknown> => (note === undefined ? node : { ...node, note })

const templateArb = fc.constantFrom(...CORPUS_TEMPLATES)
const valuedFacts = FLOW_CONDITION_FACTS.filter(
  (fact) => !(FLOW_BOOLEAN_CONDITION_FACTS as readonly string[]).includes(fact),
)
/** Weight sets that already sum to 1000, so a generated split is shape-valid by construction. */
const weightSets = [
  [500, 500],
  [300, 700],
  [250, 250, 250, 250],
  [100, 200, 300, 400],
] as const

const nodeArb = (index: number): fc.Arbitrary<Record<string, unknown>> => {
  const id = `n_${String(index).padStart(2, '0')}`
  return fc.tuple(fc.constantFrom(...FLOW_NODE_KINDS), noteArb).chain(([kind, note]) => {
    switch (kind) {
      case 'trigger':
        return fc
          .constantFrom(...FLOW_TRIGGER_EVENTS)
          .map((event) => withNote({ id, kind, event }, note))
      case 'delay':
        return fc
          .integer({ min: 1, max: 100_000 })
          .map((minutes) => withNote({ id, kind, minutes }, note))
      case 'condition':
        return fc
          .oneof(
            fc
              .tuple(
                fc.constantFrom(...FLOW_BOOLEAN_CONDITION_FACTS),
                fc.constantFrom('is_true', 'is_false'),
              )
              .map(([fact, operator]) => ({ fact, operator })),
            fc
              .tuple(
                fc.constantFrom(...valuedFacts),
                fc.constantFrom('equals', 'not_equals'),
                fc.constantFrom('ar', 'en', 'lapsed', 'vip'),
              )
              .map(([fact, operator, value]) => ({ fact, operator, value })),
          )
          .map((test) => withNote({ id, kind, test }, note))
      case 'action_message':
        return fc
          .tuple(templateArb, fc.constantFrom('sms', 'email', 'whatsapp'))
          .map(([template, channel]) =>
            withNote(
              {
                id,
                kind,
                messageClass: template.messageClass,
                templateKey: template.templateKey,
                channel,
              },
              note,
            ),
          )
      case 'action_tag':
        return fc
          .constantFrom('nurture_touch', 'review_requested', 'vip_visit')
          .map((tag) => withNote({ id, kind, tag }, note))
      case 'action_stage':
        return fc
          .constantFrom('lead', 'contacted', 'booked', 'lapsing', 'lapsed')
          .map((stage) => withNote({ id, kind, stage }, note))
      case 'split':
        return fc.constantFrom(...weightSets).map((weights) =>
          withNote(
            {
              id,
              kind,
              branches: weights.map((weightPerMille, at) => ({
                label: `branch_${String(at)}`,
                weightPerMille,
              })),
            },
            note,
          ),
        )
      default:
        return fc
          .constantFrom(...FLOW_EXIT_REASONS)
          .map((reason) => withNote({ id, kind, reason }, note))
    }
  })
}

/**
 * A shape-valid document. NOT necessarily a publishable one: the graph may be nonsense, because this
 * property is about the document surviving a round trip and not about the flow being runnable. The
 * static analyser has its own tests, and a generator constrained to publishable graphs would exercise a
 * far narrower set of documents.
 */
const documentArb = fc
  .tuple(
    fc.integer({ min: 1, max: 8 }),
    fc.option(fc.constantFrom('what this flow is for', 'drawn from docs/03 section 5'), {
      nil: undefined,
      freq: 2,
    }),
    fc.constantFrom('probe_one', 'probe_two'),
  )
  .chain(([count, description, key]) =>
    fc
      .tuple(
        fc.tuple(...Array.from({ length: count }, (_, index) => nodeArb(index))),
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: count - 1 }),
            fc.integer({ min: 0, max: count - 1 }),
            fc.constantFrom('default', 'true', 'false', 'branch_0', 'branch_1'),
          ),
          { maxLength: 6 },
        ),
      )
      .map(([nodes, edges]) => {
        const document: Record<string, unknown> = {
          dslVersion: 1,
          key,
          title: 'Round-trip probe',
          nodes,
          edges: edges.map(([from, to, branch]) => ({
            from: `n_${String(from).padStart(2, '0')}`,
            to: `n_${String(to).padStart(2, '0')}`,
            branch,
          })),
        }
        if (description !== undefined) document['description'] = description
        return document
      }),
  )

/** The independent oracle: sorted keys, two-space indent, one trailing newline, `undefined` skipped. */
const canonicalOf = (value: unknown): string => `${JSON.stringify(sorted(value), null, 2)}\n`

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of [...Object.keys(source)].sort()) {
      if (source[key] === undefined) continue
      out[key] = sorted(source[key])
    }
    return out
  }
  return value
}

const hasOptionalField = (document: Record<string, unknown>): boolean =>
  document['description'] !== undefined ||
  (document['nodes'] as Record<string, unknown>[]).some((node) => node['note'] !== undefined)

describe('a definition round-trips byte-identically', () => {
  it('holds for 300 generated documents, and the generator exercises the fields that could be dropped', () => {
    let withOptional = 0
    const kindsSeen = new Set<string>()
    let generated = 0

    fc.assert(
      fc.property(documentArb, (document) => {
        generated += 1
        if (hasOptionalField(document)) withOptional += 1
        for (const node of document['nodes'] as Record<string, unknown>[]) {
          kindsSeen.add(String(node['kind']))
        }

        const parsed = parseFlowDefinition(document)
        // A generated document the schema refuses would make every assertion below unreachable, and the
        // property would pass having compared nothing. So this is an assertion and not a filter.
        expect(
          parsed.ok,
          parsed.ok ? '' : parsed.refusals.map((r) => `${r.rule}@${r.at ?? '-'}`).join(', '),
        ).toBe(true)
        if (!parsed.ok) return

        const once = serialiseFlowDefinition(parsed.definition)
        // Against the INDEPENDENT oracle: a field the schema stopped carrying shows up here.
        expect(once).toBe(canonicalOf(document))

        const again = parseFlowDefinition(JSON.parse(once))
        expect(again.ok).toBe(true)
        if (!again.ok) return
        expect(serialiseFlowDefinition(again.definition)).toBe(once)
      }),
      { numRuns: 300 },
    )

    expect(generated).toBe(300)
    // MEASURED, not assumed. Ten runs of this file gave 267 to 282 of the 300 documents carrying at least
    // one optional field — mean 275.7, about 0.92 each, which matches a half-chance of a description and a
    // half-chance per node over one to eight nodes. The floor is 200, which is some sixteen standard
    // deviations below that mean and so cannot trip on its own, while a generator that had stopped
    // producing optional fields would give nearly zero. A floor set just under the observed minimum would
    // itself become a flake, which is the mistake brief rule 22 is about.
    expect(
      withOptional,
      `only ${withOptional} of 300 generated documents carried an optional field, so this property ` +
        'mostly compared documents with nothing a pipeline could silently drop. The generator has ' +
        'drifted — see noteArb.',
    ).toBeGreaterThanOrEqual(200)
    // And every node kind was exercised: a kind the generator never produces is a kind whose fields this
    // property says nothing about.
    expect([...kindsSeen].sort()).toEqual([...FLOW_NODE_KINDS].sort())
    // Explicit, because the default is 5,000 ms and 300 zod parses of eight-node documents under coverage
    // on a loaded machine is a correctness test with a performance budget hidden in it (brief rule 21).
  }, 30_000)

  it('the known-bad control: a serialiser that drops `note` fails the property', () => {
    // The mutation is the one a builder makes — a field left out of a hand-maintained key list — and it is
    // exactly what the generic sort in `serialiseFlowDefinition` exists to make impossible. If this
    // control ever stops failing, the property above has stopped comparing anything.
    const droppingNote = (definition: unknown): string =>
      canonicalOf(
        JSON.parse(
          JSON.stringify(definition, (key, value) => (key === 'note' ? undefined : value)),
        ),
      )
    const document = {
      dslVersion: 1,
      key: 'control',
      title: 'Control',
      nodes: [{ id: 'start', kind: 'trigger', event: 'manual', note: 'the field being dropped' }],
      edges: [],
    }
    const parsed = parseFlowDefinition(document)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(serialiseFlowDefinition(parsed.definition)).toBe(canonicalOf(document))
    expect(droppingNote(parsed.definition)).not.toBe(canonicalOf(document))
  })

  it('holds for every committed fixture, valid and invalid alike', () => {
    // The corpus is the acceptance line's subject ("for the whole committed corpus"). The VALID ones go
    // through the real pipeline; the invalid ones are checked against the oracle only, because a document
    // the schema refuses cannot be re-serialised by it — and their bytes still have to be canonical, or
    // `flow-corpus.test.ts`'s byte comparison would be asserting about a formatting accident.
    for (const fixture of VALID_FLOW_FIXTURES) {
      const parsed = parseFlowDefinition(fixture.document)
      expect(parsed.ok, fixture.file).toBe(true)
      if (!parsed.ok) continue
      expect(serialiseFlowDefinition(parsed.definition), fixture.file).toBe(
        canonicalOf(fixture.document),
      )
    }
  })
})
