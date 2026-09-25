/**
 * The flow DSL's validator, and its canonical serialisation.
 *
 * The vocabulary, the limits and the zod schema are `@berelax/shared`'s (`schemas/flow.ts`), because
 * `@berelax/db` stores a definition and may not import this package. What lives here is everything that
 * is a JUDGEMENT about a document rather than a statement of its shape:
 *
 *   - the pre-pass that names an unknown node kind, so the refusal is a rule and not a union error;
 *   - the integrity checks that need the whole document at once — one trigger, no duplicate id, no edge
 *     naming a node that is not there, no action bound to a template of the other class;
 *   - the canonical byte form, which is what makes a stored definition comparable with a committed one.
 *
 * The graph itself is `static-analysis.ts`. The split is the same one `schemas/flow.ts` describes: a
 * document is validated field by field, a graph is traversed, and a traversal folded into a `refine` is
 * a traversal nobody can test on its own.
 *
 * ## Why the template class is checked here and not only in the builder
 *
 * C-AUTO-01 made `message_class` immutable on a template and removed the class argument from every send
 * API, so an automation cannot ASK for promotional routing. The remaining way to send promotional copy
 * down a transactional path is to bind a node that says `transactional` to a template whose words are an
 * offer — or the reverse, which is worse: a promotional node bound to `booking.confirmed` leaves from the
 * transactional sender identity, outside the promotional window, with no opt-out route, and every part of
 * that is a TDRA problem rather than a cosmetic one (docs/04 §5). The builder refuses it in the picker
 * (C-AUTO-09) and the API refuses it again here, because a builder is exactly where somebody will try.
 *
 * The registry is INJECTED — `{ templates }` — because the classes live in `message_template` and this
 * package may not read a database. `validateFlowDefinition` with no registry and a definition that names
 * a template returns `flow-dsl-templates-not-checked` rather than passing: a check that silently did not
 * run is the failure mode ADR 0002 is about.
 */
import {
  FLOW_NODE_KINDS,
  type FlowAnalysisRule,
  type FlowDefinition,
  type FlowDslRule,
  type FlowRefusal,
  type FlowRule,
  flowDefinitionSchema,
  isFlowRule,
  type MessageClass,
} from '@berelax/shared'
import { analyseFlowGraph } from './static-analysis.ts'

export type {
  FlowDefinition,
  FlowEdge,
  FlowNode,
  FlowNodeKind,
  FlowRefusal,
  FlowRule,
} from '@berelax/shared'

export type FlowParse =
  | { readonly ok: true; readonly definition: FlowDefinition }
  | { readonly ok: false; readonly refusals: readonly FlowRefusal[] }

/** A template's class as `message_template` holds it. The two columns the class rule needs, and no more. */
export interface FlowTemplateFact {
  readonly templateKey: string
  readonly messageClass: MessageClass
}

export interface FlowValidationDeps {
  /** Every current template and its class. Absent means "not checked", never "nothing to check". */
  readonly templates?: readonly FlowTemplateFact[]
}

const refusal = (rule: FlowRule, at: string | null, detail: string): FlowRefusal => ({
  rule,
  at,
  detail,
})

/**
 * The rule name a zod issue carries, or `flow-dsl-shape-invalid`.
 *
 * `flowRuleMessage` writes `<rule>: <sentence>` into the schema's own messages, so the name travels with
 * the constraint it belongs to. Anything else — zod's default for a bad type, a regex message, a length —
 * is a shape refusal, and its path and message are carried through in `detail` rather than flattened into
 * a rule that would misdescribe it.
 */
export function flowRuleOf(message: string): FlowRule {
  const head = message.split(':')[0]?.trim() ?? ''
  return isFlowRule(head) ? head : 'flow-dsl-shape-invalid'
}

/**
 * The document, parsed for SHAPE only.
 *
 * The kind pre-pass comes first and on the RAW candidate, which is the only place it can be: a union of
 * eight object schemas reports an unknown `kind` as a union failure over all eight, and the eight
 * messages that come back name every field of every branch and not the one thing that is wrong. So the
 * kinds are checked by name here, and the rule reported is the one a reader needs.
 */
export function parseFlowDefinition(candidate: unknown): FlowParse {
  const unknownKinds = unknownNodeKinds(candidate)
  if (unknownKinds.length > 0) return { ok: false, refusals: unknownKinds }

  const parsed = flowDefinitionSchema.safeParse(candidate)
  if (parsed.success) return { ok: true, definition: parsed.data }
  return {
    ok: false,
    refusals: parsed.error.issues.map((issue) =>
      refusal(flowRuleOf(issue.message), issue.path.join('.') || null, issue.message),
    ),
  }
}

/** The kinds the candidate's nodes declare that this build does not implement. */
function unknownNodeKinds(candidate: unknown): readonly FlowRefusal[] {
  if (typeof candidate !== 'object' || candidate === null) return []
  const nodes = (candidate as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return []
  const out: FlowRefusal[] = []
  nodes.forEach((node, index) => {
    if (typeof node !== 'object' || node === null) return
    const kind = (node as { kind?: unknown }).kind
    if (typeof kind !== 'string') return
    if ((FLOW_NODE_KINDS as readonly string[]).includes(kind)) return
    const id = (node as { id?: unknown }).id
    out.push(
      refusal(
        'flow-dsl-unknown-node-kind',
        typeof id === 'string' ? id : `nodes.${index}`,
        `"${kind}" is not one of the node kinds this build implements ` +
          `(${FLOW_NODE_KINDS.join(', ')}). A kind nobody interprets is a step nobody takes.`,
      ),
    )
  })
  return out
}

/**
 * The checks that need the whole document: identity, the single trigger, the edges' endpoints, and the
 * class of every template a message node names.
 *
 * Returned all at once rather than at the first failure, because an operator fixing a flow needs the
 * list. `validateFlowDefinition` is what a caller uses; this is exported so the builder can run the
 * integrity half against a definition it has already parsed.
 */
export function checkFlowIntegrity(
  definition: FlowDefinition,
  deps: FlowValidationDeps = {},
): readonly FlowRefusal[] {
  const out: FlowRefusal[] = []
  const seen = new Set<string>()
  for (const node of definition.nodes) {
    if (seen.has(node.id)) {
      out.push(
        refusal(
          'flow-dsl-duplicate-node-id',
          node.id,
          'Two nodes share an id, so every edge naming it is ambiguous and one of the two is ' +
            'unreachable without anything saying so.',
        ),
      )
    }
    seen.add(node.id)
  }

  const triggers = definition.nodes.filter((node) => node.kind === 'trigger')
  if (triggers.length === 0) {
    out.push(
      refusal(
        'flow-dsl-missing-trigger',
        null,
        'A definition with no trigger cannot be entered, so publishing it would create a flow that ' +
          'can never run and an enrolment API with nothing to enrol against.',
      ),
    )
  }
  if (triggers.length > 1) {
    out.push(
      refusal(
        'flow-dsl-more-than-one-trigger',
        triggers.map((node) => node.id).join(', '),
        'Two triggers are two flows sharing one node set: the interpreter would have two entry points ' +
          'and the pinned version could not say which one an enrolment came in by.',
      ),
    )
  }
  const triggerId = triggers[0]?.id ?? null

  for (const edge of definition.edges) {
    const where = `${edge.from} -${edge.branch}-> ${edge.to}`
    if (!seen.has(edge.from)) {
      out.push(refusal('flow-dsl-dangling-edge', where, `No node is called "${edge.from}".`))
    }
    if (!seen.has(edge.to)) {
      out.push(refusal('flow-dsl-dangling-edge', where, `No node is called "${edge.to}".`))
    }
    if (triggerId !== null && edge.to === triggerId) {
      out.push(
        refusal(
          'flow-dsl-edge-into-the-trigger',
          where,
          'The trigger is the way in. An edge back into it would let an enrolment re-enter the flow ' +
            'it is already on, which is the loop no execution cap can explain afterwards.',
        ),
      )
    }
  }

  out.push(...checkTemplateClasses(definition, deps))
  return out
}

/** The class rule, and the fail-closed refusal when no registry was supplied. */
function checkTemplateClasses(
  definition: FlowDefinition,
  deps: FlowValidationDeps,
): readonly FlowRefusal[] {
  const messageNodes = definition.nodes.filter((node) => node.kind === 'action_message')
  if (messageNodes.length === 0) return []
  const { templates } = deps
  if (templates === undefined) {
    return [
      refusal(
        'flow-dsl-templates-not-checked',
        messageNodes.map((node) => node.id).join(', '),
        'No template registry was injected, so no message class was checked. This package may not read ' +
          'a database, and a class check that silently did not run is how promotional copy comes to ' +
          'leave from the transactional identity.',
      ),
    ]
  }
  const classOf = new Map(templates.map((fact) => [fact.templateKey, fact.messageClass]))
  const out: FlowRefusal[] = []
  for (const node of messageNodes) {
    if (node.kind !== 'action_message') continue
    const actual = classOf.get(node.templateKey)
    if (actual === undefined) {
      out.push(
        refusal(
          'flow-dsl-unknown-template',
          node.id,
          `No template is registered as "${node.templateKey}", so its class could not be compared with ` +
            'the class this node declares.',
        ),
      )
      continue
    }
    if (actual !== node.messageClass) {
      out.push(
        refusal(
          'flow-dsl-message-class-mismatch',
          node.id,
          `The node declares ${node.messageClass} and "${node.templateKey}" is ${actual}. The class is ` +
            'immutable on the template (C-AUTO-01), so the node is what is wrong here — and binding the ' +
            'two would route one class of content down the other class of path.',
        ),
      )
    }
  }
  return out
}

/**
 * Sorted-key JSON with a trailing newline: the ONE byte form of a definition.
 *
 * Why a generic sort rather than a declared field order. A declared order is a list to maintain beside
 * the schema, and the first field somebody adds to the schema and not to the list is silently dropped on
 * the way to the database — which is precisely the failure the round-trip property exists to catch, so
 * the serialiser must not be the thing that causes it. Sorting every object's keys is decidable from the
 * document alone, needs no list, and cannot drop a field it has never heard of.
 *
 * It also makes the form invariant under `jsonb`. Postgres normalises a `jsonb` document — key order and
 * whitespace are not preserved — so a canonical form that depended on either could not survive a round
 * trip through `flow_definition.definition`, and "the pinned version is byte-identical to what was
 * published" would be unassertable.
 */
export function serialiseFlowDefinition(definition: FlowDefinition): string {
  return `${JSON.stringify(canonicalValue(definition), null, 2)}\n`
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      // An absent optional field is absent. Writing `null` for it would make "no note" and "a note
      // somebody cleared" the same document, and zod would then refuse the reparse of our own output.
      if (source[key] === undefined) continue
      out[key] = canonicalValue(source[key])
    }
    return out
  }
  return value
}

/** Text to definition. A document that is not JSON at all is a shape refusal, not an exception. */
export function deserialiseFlowDefinition(text: string): FlowParse {
  let candidate: unknown
  try {
    candidate = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      refusals: [
        refusal(
          'flow-dsl-shape-invalid',
          null,
          `The document is not JSON: ${error instanceof Error ? error.message : 'unparseable'}`,
        ),
      ],
    }
  }
  return parseFlowDefinition(candidate)
}

export interface FlowValidationFacts {
  /** The flow key the DOCUMENT declares, which the publish path holds to the flow it is publishing to. */
  readonly key: string
  /** The DSL schema version the document declares. Stored beside the document as `dsl_version`. */
  readonly dslVersion: number
  readonly nodeCount: number
  readonly maxAccumulatedDelayMinutes: number
  readonly reachableNodeIds: readonly string[]
  readonly cycles: readonly (readonly string[])[]
}

export type FlowValidation =
  | {
      readonly ok: true
      readonly definition: FlowDefinition
      readonly canonical: string
      readonly facts: FlowValidationFacts
    }
  | { readonly ok: false; readonly refusals: readonly FlowRefusal[] }

/** Every rule that can come back from `validateFlowDefinition`, for a test that asserts each is reachable. */
export type FlowValidationRule = FlowDslRule | FlowAnalysisRule

/**
 * The whole judgement on a candidate definition: shape, then integrity, then the graph.
 *
 * The ORDER is the design. Shape first, because nothing else can read a document it cannot parse.
 * Integrity next, because the analyser's preconditions are integrity's guarantees — one trigger, unique
 * ids, every edge landing on a node that exists. The graph last, and only if nothing above it refused:
 * an analyser run over a broken document reports unreachable nodes and missing branches that are
 * artefacts of the breakage, and an operator shown nine refusals for one mistake fixes the wrong thing.
 *
 * On success it returns the CANONICAL bytes as well as the definition, because the publish path needs
 * exactly that and deriving it twice is how two callers come to disagree about what was published.
 */
export function validateFlowDefinition(
  candidate: unknown,
  deps: FlowValidationDeps = {},
): FlowValidation {
  const parsed = parseFlowDefinition(candidate)
  if (!parsed.ok) return { ok: false, refusals: parsed.refusals }

  const integrity = checkFlowIntegrity(parsed.definition, deps)
  if (integrity.length > 0) return { ok: false, refusals: integrity }

  const analysis = analyseFlowGraph(parsed.definition)
  if (analysis.refusals.length > 0) return { ok: false, refusals: analysis.refusals }

  return {
    ok: true,
    definition: parsed.definition,
    canonical: serialiseFlowDefinition(parsed.definition),
    facts: {
      key: parsed.definition.key,
      dslVersion: parsed.definition.dslVersion,
      nodeCount: parsed.definition.nodes.length,
      maxAccumulatedDelayMinutes: analysis.facts.maxAccumulatedDelayMinutes,
      reachableNodeIds: analysis.facts.reachableNodeIds,
      cycles: analysis.facts.cycles,
    },
  }
}
