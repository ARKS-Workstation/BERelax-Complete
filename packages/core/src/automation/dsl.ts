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
 * ## Two halves, and the second one is C-AUTO-09's
 *
 * Everything in the first half JUDGES a document somebody already wrote. The second half — below the
 * banner that says so — is the typed authoring surface the node-graph builder composes a journey with,
 * and its subject is the one thing a validator cannot do: make the wrong edge unexpressible rather than
 * refused. Its own header states the six impossibilities and the mechanism for each.
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
  FLOW_CONDITION_BRANCHES,
  FLOW_DEFAULT_BRANCH,
  FLOW_DSL_VERSION,
  FLOW_NODE_KINDS,
  type FlowAnalysisRule,
  type FlowDefinition,
  type FlowDslRule,
  type FlowEdge,
  type FlowExitReason,
  type FlowNode,
  type FlowRefusal,
  type FlowRule,
  type FlowTriggerEvent,
  flowDefinitionSchema,
  isFlowRule,
  type MessageChannel,
  type MessageClass,
} from '@berelax/shared'
import { CUSTOMER_LIFECYCLE_STATES } from '../crm/lifecycle.ts'
import { analyseFlowGraph, declaredBranchesOf } from './static-analysis.ts'

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
  out.push(...checkLifecycleStateValues(definition))
  return out
}

/**
 * A `lifecycle_state` condition must name a state the customer lifecycle vocabulary holds.
 *
 * C-AUTO-06's NOTE (5) deferred this to C-AUTO-07 and C-AUTO-08's NOTE restated it. It is cheap HERE and
 * only here: `CUSTOMER_LIFECYCLE_STATES` lives in this package (`crm/lifecycle.ts`), so the check READS the
 * one vocabulary rather than taking an injected registry that could be omitted — no fail-closed arm is
 * needed, because there is no way for the list not to have arrived.
 *
 * Why it is worth making at publish time although the interpreter also halts on it: a value that is not a
 * state can never become one, so unlike an archived pipeline stage there is nothing about the world that
 * could change the answer later. Refusing the publish is therefore the earliest moment the answer is
 * final, and the operator is holding the builder. The interpreter's `condition_unreadable` halt remains
 * for a document published by a build that did not have this check.
 */
function checkLifecycleStateValues(definition: FlowDefinition): readonly FlowRefusal[] {
  const out: FlowRefusal[] = []
  for (const node of definition.nodes) {
    if (node.kind !== 'condition') continue
    if (node.test.fact !== 'lifecycle_state') continue
    const { value } = node.test
    if (value === undefined) continue
    if ((CUSTOMER_LIFECYCLE_STATES as readonly string[]).includes(value)) continue
    out.push(
      refusal(
        'flow-dsl-unknown-lifecycle-state',
        node.id,
        `"${value}" is not one of the customer lifecycle states ` +
          `(${CUSTOMER_LIFECYCLE_STATES.join(', ')}). The interpreter cannot answer the condition, and ` +
          'the branch it would have to guess is the false one — which silences the condition for every ' +
          'contact while the flow goes on looking as though it works.',
      ),
    )
  }
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

// ------------------------------------------------------------------------------------------------
// The typed authoring surface (C-AUTO-09): a graph whose WRONG EDGES CANNOT BE EXPRESSED
// ------------------------------------------------------------------------------------------------

/**
 * Everything above this line judges a document somebody already wrote. Everything below it is how a
 * document gets written, and the difference is the whole of C-AUTO-09's acceptance line.
 *
 * "Misrouting made impossible" is a claim about a TYPE, not about validation. A builder that lets an
 * operator wire a node to a node that cannot receive it and then refuses at save time has made
 * misrouting possible and caught it; the enrolments already on the live version were never at risk, but
 * the operator was told "no" about a thing the screen offered them. So the authoring surface is built so
 * that the wrong edge has no NAME:
 *
 *   1. **An edge out of an `exit`.** `exitStep` is `JourneyStep<never>`, so it contributes no outlet key
 *      to {@link JourneyEdgeMap} and no outlet to {@link freeOutletsOf}.
 *   2. **An edge back into the trigger.** The trigger is a separate field rather than a member of the
 *      step record, so the edge map's VALUE type is `keyof steps` and the trigger id is not in it; and
 *      {@link inletsOf} never offers it.
 *   3. **An edge on a branch the source does not declare.** The outlet keys are
 *      `` `${id}:${branch}` `` literal types derived from each step's own branch labels, so
 *      `'split_a:true'` is not a key of the map at all.
 *   4. **Two edges leaving one branch.** The edge map is a record keyed by outlet, and an object literal
 *      with the same key twice is a TypeScript error; {@link freeOutletsOf} offers an outlet exactly
 *      until it has an edge.
 *   5. **A branch with no edge.** Every outlet key is REQUIRED by the mapped type, so a condition with
 *      one branch, a split with an unrouted share and a non-terminal node with no way out are all
 *      missing-property errors.
 *   6. **A message node bound to a template of the other class.** {@link messageStep} takes a
 *      {@link TemplateRef}, which carries the class as a type parameter and is minted only by
 *      {@link templateChoicesFor} from the injected registry — so the node's `messageClass` is DERIVED
 *      from the template rather than declared beside it, and there are no longer two statements that
 *      could disagree.
 *
 * `packages/core/src/automation/journey.test.ts` proves all six with `@ts-expect-error`, which is a
 * check and not a comment: a directive that stops erroring is `TS2578` and fails `pnpm typecheck`.
 *
 * ## What is still a runtime refusal, and why that is not a retreat
 *
 * A type can express the SHAPE of a routing and cannot express a quantity or a reachability. The node
 * ceiling, the delay ceiling, the accumulated path delay, an unreachable node, a loop with no delay or
 * no bounded exit, a duplicate node id and an unknown template key all stay with
 * {@link validateFlowDefinition} — and so does the class rule, because a definition also arrives as JSON
 * over HTTP from a caller that never saw a type. Both layers, which is exactly what the acceptance asks
 * for: the picker cannot offer the wrong template and the API refuses it again by name.
 *
 * ## And the interactive half, for a surface where the graph is not a literal
 *
 * A builder screen holds a graph that is half-drawn, so it cannot be a `composeJourney` literal. The
 * second half of this section is {@link JourneyDraft} and the four edits over it, where the same six
 * impossibilities are kept by a different mechanism: an edge is drawn by passing an OFFER
 * ({@link JourneyOutlet}, {@link JourneyInlet}) that only {@link freeOutletsOf} and {@link inletsOf}
 * can mint. An untyped HTTP body therefore cannot name an edge either — it can only pick one of the
 * offers, and {@link resolveJourneyOutlet} is where a body that names something else stops.
 */

/**
 * The witness that a template's class was read from the registry rather than asserted by a caller.
 *
 * A `unique symbol` that this module does not export, so {@link TemplateRef} cannot be written as an
 * object literal anywhere else — which is the point. Without it `{ templateKey: 'booking.confirmed',
 * messageClass: 'promotional' }` is a perfectly assignable `TemplateRef<'promotional'>`, and the type
 * would then say only "somebody typed a class next to a key", which is the thing that goes wrong.
 *
 * Present at runtime as well as in the type, and that is deliberate: a `TemplateRef` recovered from
 * `JSON.parse` does not carry a symbol key, so a reference cannot be smuggled in through a request body.
 */
const TEMPLATE_CLASS_READ_FROM_REGISTRY = Symbol('berelax.flow.templateClassReadFromRegistry')

/**
 * A template key whose class is known, with the class in the TYPE.
 *
 * `TemplateRef<'transactional'>` is not assignable to `TemplateRef<'promotional'>`, so
 * {@link messageStep} binding one to a node of the other class is a compile error rather than a save-time
 * refusal. The only mint is {@link templateChoicesFor}.
 */
export interface TemplateRef<C extends MessageClass> {
  readonly templateKey: string
  readonly messageClass: C
  readonly [TEMPLATE_CLASS_READ_FROM_REGISTRY]: C
}

/**
 * The templates of ONE class, from the registry — the picker's list and the binding's type, from one call.
 *
 * This is the function the acceptance line "the template picker lists only templates whose message_class
 * matches the node's declared class" is satisfied by, and it is satisfied by DERIVATION rather than by a
 * filter somebody remembered to write in the view: the list the screen renders and the type
 * {@link messageStep} accepts are the same value. A picker that showed more could not produce a
 * `TemplateRef` for the extra rows, and a picker that showed fewer would be a shorter list of the same
 * type — so the two cannot drift into disagreeing about which bindings are legal.
 *
 * Sorted by key, because the list is rendered and an unsorted registry would make a screenshot of the
 * picker depend on row order in `message_template`.
 */
export function templateChoicesFor<C extends MessageClass>(
  templates: readonly FlowTemplateFact[],
  messageClass: C,
): readonly TemplateRef<C>[] {
  return templates
    .filter((fact) => fact.messageClass === messageClass)
    .map((fact) => ({
      templateKey: fact.templateKey,
      messageClass,
      [TEMPLATE_CLASS_READ_FROM_REGISTRY]: messageClass,
    }))
    .sort((left, right) => (left.templateKey < right.templateKey ? -1 : 1))
}

/** The one template of a class with this key, or null. What a stored node's key resolves back to. */
export function templateRefFor<C extends MessageClass>(
  templates: readonly FlowTemplateFact[],
  messageClass: C,
  templateKey: string,
): TemplateRef<C> | null {
  return (
    templateChoicesFor(templates, messageClass).find((ref) => ref.templateKey === templateKey) ??
    null
  )
}

/** Every node kind but the trigger: a step is something the trigger leads to. */
export type FlowStepNode = Exclude<FlowNode, { readonly kind: 'trigger' }>

/**
 * One placed step, with the branch labels it routes on CARRIED IN THE TYPE.
 *
 * `node` is a function of the id rather than a body to spread, for a plain compiler reason that is worth
 * the line: spreading a union of eight object types loses the discriminant, and the result is no longer
 * assignable to `FlowNode`. Each constructor building its own node keeps every field checked against the
 * kind it belongs to.
 *
 * `branches` is the same information at runtime, for the builder's pickers. It is not a second statement
 * of it: {@link declaredBranchesOf} in `static-analysis.ts` answers the same question about a NODE, and
 * `journey.test.ts` asserts the two agree for every constructor — which is the check the brief asks for
 * when a fact is stated twice.
 */
export interface JourneyStep<Branch extends string> {
  readonly node: (id: string) => FlowStepNode
  readonly branches: readonly Branch[]
}

/** A step record: what the builder holds, and what {@link composeJourney} reads its outlets out of. */
export type JourneySteps = Readonly<Record<string, JourneyStep<string>>>

type BranchesOf<S> = S extends JourneyStep<infer B> ? B : never

type StepOutletKeys<N extends JourneySteps> = {
  [K in keyof N & string]: `${K}:${BranchesOf<N[K]>}`
}[keyof N & string]

/** Every way OUT of this journey's nodes, as `` `${nodeId}:${branch}` ``. An `exit` contributes none. */
export type JourneyOutletKey<T extends string, N extends JourneySteps> =
  | `${T}:${typeof FLOW_DEFAULT_BRANCH}`
  | StepOutletKeys<N>

/**
 * The edges of a journey: every outlet, exactly once, pointing at a node that can receive.
 *
 * A mapped type over the outlet keys rather than an array of `{from, to, branch}`, and that single
 * decision is what makes five of the six impossibilities above impossibilities. An array can hold two
 * edges on one branch, none at all, a branch that does not exist and a target that is the trigger; a
 * total record keyed by outlet can hold exactly one of each legal edge and nothing else.
 */
export type JourneyEdgeMap<T extends string, N extends JourneySteps> = {
  readonly [K in JourneyOutletKey<T, N>]: keyof N & string
}

export interface JourneyTriggerSpec<Id extends string> {
  readonly id: Id
  readonly event: FlowTriggerEvent
  readonly note?: string
}

export interface JourneySpec<T extends string, N extends JourneySteps> {
  readonly key: string
  readonly title: string
  readonly description?: string
  /**
   * The one way in, as its own field.
   *
   * Separate from `steps` for two reasons that are both structural rather than tidy: it is what makes
   * "exactly one trigger" unrepresentable-otherwise instead of a refusal, and it is what keeps the
   * trigger id out of `keyof N` — which is the edge map's value type, and therefore why no edge can land
   * on it.
   */
  readonly trigger: JourneyTriggerSpec<T>
  readonly steps: N
  readonly edges: JourneyEdgeMap<T, N>
}

/**
 * A journey, composed from a specification whose wrong edges do not typecheck.
 *
 * Returns the DOCUMENT and not a verdict: the quantitative and reachability rules are
 * {@link validateFlowDefinition}'s, there is one judgement on a document in this build, and a second
 * `ok` returned from here would be a second opinion for the publish path to choose between.
 *
 * The output order is derived rather than authored — trigger first, then steps by id, then edges by
 * outlet key — so two spellings of the same journey serialise to the same bytes. That matters because
 * the canonical form is what "the pinned version is byte-identical to what was published" is asserted
 * against, and a reordered step list would make an equivalent journey a different document.
 */
export function composeJourney<const T extends string, const N extends JourneySteps>(
  spec: JourneySpec<T, N>,
): FlowDefinition {
  const trigger: FlowNode = {
    id: spec.trigger.id,
    kind: 'trigger',
    event: spec.trigger.event,
    ...(spec.trigger.note === undefined ? {} : { note: spec.trigger.note }),
  }
  const nodes: FlowNode[] = [
    trigger,
    ...Object.keys(spec.steps).map((id) => (spec.steps[id] as JourneyStep<string>).node(id)),
  ]
  const edges: FlowEdge[] = Object.keys(spec.edges).map((key) => {
    const { from, branch } = parseJourneyOutletKey(key)
    return { from, branch, to: (spec.edges as Readonly<Record<string, string>>)[key] as string }
  })
  return orderJourneyDocument({
    key: spec.key,
    title: spec.title,
    ...(spec.description === undefined ? {} : { description: spec.description }),
    nodes,
    edges,
  })
}

/**
 * One journey, with its arrays in the ONE order a journey's bytes depend on.
 *
 * The trigger first, then the steps by id, then the edges by outlet key — so two spellings of the same
 * journey produce the same document, whichever order they were written or DRAWN in.
 *
 * Shared by {@link composeJourney} and {@link draftDocument} rather than written twice, and the reason
 * is a defect this file had: the composer sorted and the builder kept the order the operator clicked
 * in, so a journey drawn on the screen and the identical journey written as a literal serialised to
 * different bytes. `flow-builder.itest.ts`'s final comparison is what found it. It matters beyond
 * tidiness, because the canonical bytes are what "the pinned version is byte-identical to what was
 * published" is asserted against: with two orders, two operators drawing one journey publish two
 * documents and a reviewer comparing them sees a diff that means nothing.
 *
 * It does NOT belong in {@link serialiseFlowDefinition}. That function's contract is the BYTE form of a
 * document it is given, and `flow-corpus.test.ts` asserts every committed corpus file equals its output
 * exactly — those files are written in traversal order, which is how a person reads a flow. Reordering
 * inside the serialiser would rewrite twelve committed documents to make a builder tidy.
 */
export function orderJourneyDocument(document: {
  readonly key: string
  readonly title: string
  readonly description?: string
  readonly nodes: readonly FlowNode[]
  readonly edges: readonly FlowEdge[]
}): FlowDefinition {
  const byId = (left: FlowNode, right: FlowNode): number => (left.id < right.id ? -1 : 1)
  const triggers = document.nodes.filter((node) => node.kind === 'trigger').sort(byId)
  const steps = document.nodes.filter((node) => node.kind !== 'trigger').sort(byId)
  const edges = [...document.edges].sort((left, right) => {
    const leftKey = journeyOutletKey(left.from, left.branch)
    const rightKey = journeyOutletKey(right.from, right.branch)
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1
    // Two edges on one outlet is `flow-analysis-ambiguous-branch` and cannot be written through the
    // typed surface at all; ordering them by target anyway keeps this function total rather than
    // leaving one invalid document with two possible spellings.
    return left.to < right.to ? -1 : 1
  })
  return {
    dslVersion: FLOW_DSL_VERSION,
    key: document.key,
    title: document.title,
    ...(document.description === undefined ? {} : { description: document.description }),
    nodes: [...triggers, ...steps],
    edges,
  }
}

/**
 * `node:branch` back into its two halves — the inverse of {@link journeyOutletKey}.
 *
 * On the FIRST colon, and a node id cannot contain one (`/^[a-z][a-z0-9_]{0,31}$/`), so the split is
 * unambiguous in one direction — and a branch label is the same alphabet, so it is unambiguous in the
 * other too.
 *
 * Exported, and the reason is the builder's `<select>`. An outlet is a PAIR, and a `<select>` has one
 * value, so the control's option value has to be the key — which means the screen and the edge map
 * spell an outlet the same way. The first version of the builder had the select encode `from|branch`
 * and the handler read two separate fields, so the branch never arrived and every connection was
 * refused as `edge_not_offered`; `flow-builder.itest.ts`'s keyboard pass is what found it, and one
 * exported key format is what stops the pair of spellings existing at all.
 */
export function parseJourneyOutletKey(key: string): {
  readonly from: string
  readonly branch: string
} {
  const at = key.indexOf(':')
  return at === -1
    ? { from: key, branch: FLOW_DEFAULT_BRANCH }
    : { from: key.slice(0, at), branch: key.slice(at + 1) }
}

export const journeyOutletKey = (from: string, branch: string): string => `${from}:${branch}`

// ---- the step constructors, one per kind, each carrying its branch labels in its return type --------

export function delayStep(spec: {
  readonly minutes: number
  readonly note?: string
}): JourneyStep<typeof FLOW_DEFAULT_BRANCH> {
  return {
    node: (id) => ({
      id,
      kind: 'delay',
      minutes: spec.minutes,
      ...(spec.note === undefined ? {} : { note: spec.note }),
    }),
    branches: [FLOW_DEFAULT_BRANCH],
  }
}

export type JourneyConditionTest = Extract<FlowNode, { readonly kind: 'condition' }>['test']

export function conditionStep(spec: {
  readonly test: JourneyConditionTest
  readonly note?: string
}): JourneyStep<(typeof FLOW_CONDITION_BRANCHES)[number]> {
  return {
    node: (id) => ({
      id,
      kind: 'condition',
      test: spec.test,
      ...(spec.note === undefined ? {} : { note: spec.note }),
    }),
    branches: [...FLOW_CONDITION_BRANCHES],
  }
}

/**
 * A message step, whose class comes from the TEMPLATE and is not declared beside it.
 *
 * The acceptance line this exists for: "an operator must not be able to route promotional content
 * through a transactional template". `spec.template` is a {@link TemplateRef}, minted only from the
 * registry, and `messageClass` on the node is read off it — so there is one statement of the class and
 * nothing for a second one to contradict. A node that says `promotional` about `booking.confirmed`
 * cannot be constructed here at all, which is a stronger claim than the one
 * `flow-dsl-message-class-mismatch` makes about a document that already exists.
 */
export function messageStep<C extends MessageClass>(spec: {
  readonly template: TemplateRef<C>
  readonly channel: MessageChannel
  readonly note?: string
}): JourneyStep<typeof FLOW_DEFAULT_BRANCH> {
  return {
    node: (id) => ({
      id,
      kind: 'action_message',
      messageClass: spec.template.messageClass,
      templateKey: spec.template.templateKey,
      channel: spec.channel,
      ...(spec.note === undefined ? {} : { note: spec.note }),
    }),
    branches: [FLOW_DEFAULT_BRANCH],
  }
}

/**
 * A message step whose class the OPERATOR declared, bindable only to a template of that class.
 *
 * This is the function the builder screen calls, and the difference from {@link messageStep} is the
 * whole acceptance line. In the builder the class is chosen FIRST — the operator adds "a promotional
 * message" — and the picker is then filled with {@link templateChoicesFor} of that class. So the class
 * is an input rather than something to derive, and the binding has to be refused when the two disagree.
 *
 * `NoInfer` is what makes it a refusal and not a shrug, and that is MEASURED (gate case 159e). Without
 * it, `C` is inferred from BOTH arguments, TypeScript unions the two candidates, and
 * `{ messageClass: 'promotional', template: <a transactional ref> }` typechecks against
 * `C = 'transactional' | 'promotional'` — a generic that accepts everything, which is the failure mode a
 * type-level claim has to be able to show cannot happen.
 *
 * ## The measurement that went wrong first, because it is the more useful half of this comment
 *
 * 159e reported "exited zero; nothing was rejected" the first time it ran, and the conclusion drawn —
 * that `NoInfer` was belt and braces — was wrong. The two directives in `journey.test.ts` were erroring
 * for a different reason: `PROMOTIONAL[0]` is `TemplateRef<'promotional'> | undefined`, an `if (… ===
 * undefined) throw` at module scope does not narrow it inside a nested function, and what the
 * directives were suppressing was `Type 'undefined' is not assignable`. So the claim "a promotional node
 * on a transactional template does not compile" was satisfied for the wrong reason and would have gone
 * on being satisfied with the tie cut entirely. `mustHold` in that file is the fix, and re-measured
 * against it both weakenings now flip: removing `NoInfer` reports TS2578 twice, and so does widening the
 * template to `TemplateRef<MessageClass>`. ADR 0003 is about exactly this, and the gate case is what
 * found it rather than a review.
 *
 * The body is {@link messageStep}'s, so there is one statement of what a message node is.
 */
export function classedMessageStep<C extends MessageClass>(spec: {
  readonly messageClass: C
  readonly template: TemplateRef<NoInfer<C>>
  readonly channel: MessageChannel
  readonly note?: string
}): JourneyStep<typeof FLOW_DEFAULT_BRANCH> {
  return messageStep({
    template: spec.template,
    channel: spec.channel,
    ...(spec.note === undefined ? {} : { note: spec.note }),
  })
}

export function tagStep(spec: {
  readonly tag: string
  readonly note?: string
}): JourneyStep<typeof FLOW_DEFAULT_BRANCH> {
  return {
    node: (id) => ({
      id,
      kind: 'action_tag',
      tag: spec.tag,
      ...(spec.note === undefined ? {} : { note: spec.note }),
    }),
    branches: [FLOW_DEFAULT_BRANCH],
  }
}

export function stageStep(spec: {
  readonly stage: string
  readonly note?: string
}): JourneyStep<typeof FLOW_DEFAULT_BRANCH> {
  return {
    node: (id) => ({
      id,
      kind: 'action_stage',
      stage: spec.stage,
      ...(spec.note === undefined ? {} : { note: spec.note }),
    }),
    branches: [FLOW_DEFAULT_BRANCH],
  }
}

export function splitStep<const L extends string>(spec: {
  readonly branches: readonly { readonly label: L; readonly weightPerMille: number }[]
  readonly note?: string
}): JourneyStep<L> {
  return {
    node: (id) => ({
      id,
      kind: 'split',
      branches: spec.branches.map((branch) => ({ ...branch })),
      ...(spec.note === undefined ? {} : { note: spec.note }),
    }),
    branches: spec.branches.map((branch) => branch.label),
  }
}

/**
 * The only terminal step, and the only one whose branch type is `never`.
 *
 * `JourneyStep<never>` is what makes an edge out of an exit unwritable: `` `${id}:${never}` `` is
 * `never`, so the step contributes no key to {@link JourneyEdgeMap} and an `edges` literal naming one is
 * an excess property.
 */
export function exitStep(spec: {
  readonly reason: FlowExitReason
  readonly note?: string
}): JourneyStep<never> {
  return {
    node: (id) => ({
      id,
      kind: 'exit',
      reason: spec.reason,
      ...(spec.note === undefined ? {} : { note: spec.note }),
    }),
    branches: [],
  }
}

// ---- the interactive half: a half-drawn graph, and edits that can only name an offered edge ---------

/**
 * The graph an operator is drawing: a candidate document that may not be finished yet.
 *
 * Deliberately the same SHAPE as a {@link FlowDefinition} rather than a model of its own, and plain data
 * rather than the {@link JourneyStep} record — because the builder's draft travels through a form field
 * and back, and a representation holding functions could not. {@link draftDocument} is therefore the
 * identity on the interesting part, which is what makes "save, reload, identical serialised graph" a
 * property of one structure instead of a round trip between two.
 *
 * It is not a `FlowDefinition`: a draft with no trigger, with a dead end, with an unrouted condition
 * branch is a legitimate intermediate state of an operator's work and an illegitimate document. That is
 * the whole reason the type above and this type are different types.
 */
export interface JourneyDraft {
  readonly key: string
  readonly title: string
  readonly description?: string
  readonly nodes: readonly FlowNode[]
  readonly edges: readonly FlowEdge[]
}

const OUTLET_OFFERED_BY_THE_DRAFT = Symbol('berelax.flow.outletOfferedByTheDraft')
const INLET_OFFERED_BY_THE_DRAFT = Symbol('berelax.flow.inletOfferedByTheDraft')

/**
 * A way out of a node that has NO edge yet, offered by the draft itself.
 *
 * Branded with a symbol this module does not export, so the only way to hold one is to have asked
 * {@link freeOutletsOf} for it. {@link connectJourneyDraft} takes one of these rather than a
 * `{from, branch}` pair, which is how "a second edge on one branch" and "an edge on a branch this kind
 * does not have" stop being refusals and become things with no name.
 */
export interface JourneyOutlet {
  readonly from: string
  readonly branch: string
  /** What the source node is, so a picker can say `delay` rather than only `settle`. */
  readonly kind: FlowNode['kind']
  readonly [OUTLET_OFFERED_BY_THE_DRAFT]: true
}

/** A node an edge may LAND on. Never the trigger, which is why no edge can re-enter the flow. */
export interface JourneyInlet {
  readonly to: string
  readonly kind: FlowStepNode['kind']
  readonly [INLET_OFFERED_BY_THE_DRAFT]: true
}

/**
 * Every outlet with no edge on it, in document order.
 *
 * Reads {@link declaredBranchesOf} rather than switching on the kind again: the branches a node has are
 * stated once, in `static-analysis.ts`, and the analyser refuses an edge on a branch that list does not
 * hold. A second switch here would be a second opinion about what a split's branches are, and the
 * direction it would disagree in is the bad one — an outlet offered for a branch the analyser will
 * refuse is a builder that invites the mistake it exists to prevent.
 */
export function freeOutletsOf(draft: JourneyDraft): readonly JourneyOutlet[] {
  const taken = new Set(draft.edges.map((edge) => journeyOutletKey(edge.from, edge.branch)))
  const out: JourneyOutlet[] = []
  for (const node of draft.nodes) {
    for (const branch of declaredBranchesOf(node)) {
      if (taken.has(journeyOutletKey(node.id, branch))) continue
      out.push({
        from: node.id,
        branch,
        kind: node.kind,
        [OUTLET_OFFERED_BY_THE_DRAFT]: true,
      })
    }
  }
  return out
}

/** Every node an edge may land on: all of them but the trigger. */
export function inletsOf(draft: JourneyDraft): readonly JourneyInlet[] {
  const out: JourneyInlet[] = []
  for (const node of draft.nodes) {
    if (node.kind === 'trigger') continue
    out.push({ to: node.id, kind: node.kind, [INLET_OFFERED_BY_THE_DRAFT]: true })
  }
  return out
}

/**
 * The offer a request names, or null — the ONE place an untyped body becomes a typed edge.
 *
 * A form posts strings and a type cannot reach across HTTP, so the boundary resolves what was posted
 * against what was offered instead of trusting it. Null is "that is not one of the edges this draft can
 * draw", which the handler reports by name; there is deliberately no branch that constructs an outlet
 * from the body's own fields, because that branch is the misrouting this unit exists to remove.
 */
export function resolveJourneyOutlet(
  draft: JourneyDraft,
  from: unknown,
  branch: unknown,
): JourneyOutlet | null {
  if (typeof from !== 'string' || typeof branch !== 'string') return null
  return (
    freeOutletsOf(draft).find((outlet) => outlet.from === from && outlet.branch === branch) ?? null
  )
}

export function resolveJourneyInlet(draft: JourneyDraft, to: unknown): JourneyInlet | null {
  if (typeof to !== 'string') return null
  return inletsOf(draft).find((inlet) => inlet.to === to) ?? null
}

/** Draws one edge. Total: both arguments are offers, so there is no failing case to report. */
export function connectJourneyDraft(
  draft: JourneyDraft,
  outlet: JourneyOutlet,
  inlet: JourneyInlet,
): JourneyDraft {
  return {
    ...draft,
    edges: [...draft.edges, { from: outlet.from, branch: outlet.branch, to: inlet.to }],
  }
}

/** Removes one edge, named by the outlet it leaves. An outlet with no edge is a no-op by construction. */
export function disconnectJourneyDraft(
  draft: JourneyDraft,
  from: string,
  branch: string,
): JourneyDraft {
  return {
    ...draft,
    edges: draft.edges.filter((edge) => !(edge.from === from && edge.branch === branch)),
  }
}

/** Places a node. The id is the caller's; a duplicate is `flow-dsl-duplicate-node-id` at save time. */
export function placeJourneyNode(draft: JourneyDraft, node: FlowNode): JourneyDraft {
  return { ...draft, nodes: [...draft.nodes, node] }
}

/**
 * Removes a node AND every edge that touched it, in one operation.
 *
 * One operation because the alternative is a draft holding an edge to a node that is not there, which is
 * `flow-dsl-dangling-edge` — a refusal about the builder's own bookkeeping rather than about anything the
 * operator did. Deleting a node is the one edit that can invalidate edges it was not named in, so it is
 * the one edit that has to clean up after itself.
 */
export function removeJourneyNode(draft: JourneyDraft, id: string): JourneyDraft {
  return {
    ...draft,
    nodes: draft.nodes.filter((node) => node.id !== id),
    edges: draft.edges.filter((edge) => edge.from !== id && edge.to !== id),
  }
}

/**
 * The candidate document a draft stands for. The shape {@link validateFlowDefinition} judges.
 *
 * Ordered through {@link orderJourneyDocument}, so the bytes depend on the journey and not on the order
 * the operator happened to click in — the same order {@link composeJourney} produces, from the same
 * function. `unknown` rather than `FlowDefinition` because a draft may be incomplete: it is a CANDIDATE,
 * and typing it as a definition would be the claim this whole half exists to withhold.
 */
export function draftDocument(draft: JourneyDraft): unknown {
  return orderJourneyDocument(draft)
}

/** A draft of a journey the typed composer produced, for a screen that opens a published version. */
export function draftOf(definition: FlowDefinition): JourneyDraft {
  return {
    key: definition.key,
    title: definition.title,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    nodes: definition.nodes,
    edges: definition.edges,
  }
}

/**
 * The verdict on a draft: the ONE judgement, over the document the draft stands for.
 *
 * `ok` is what enables the save control, and it is the same function the API runs on the body it
 * receives — so "save was disabled" and "the API refused it" can never be two different answers about
 * one graph. That is the acceptance line's "refused in the UI and again at the API" read as one rule
 * applied twice rather than two rules that agree today.
 */
export function journeyDraftVerdict(
  draft: JourneyDraft,
  deps: FlowValidationDeps = {},
): FlowValidation {
  return validateFlowDefinition(draftDocument(draft), deps)
}
