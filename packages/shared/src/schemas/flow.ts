/**
 * The automation flow DSL: its node kinds, its closed vocabularies, its two limits, and the zod schema
 * that refuses a malformed definition at the edge.
 *
 * It lives in `shared` for the reason `schemas/consent.ts` and `schemas/catalogue.ts` state about
 * themselves: three packages need one statement of it and no two of them may import each other.
 * `@berelax/core` validates and analyses a definition (`automation/dsl.ts`,
 * `automation/static-analysis.ts`), `@berelax/db` stores a published version as `jsonb` and may not
 * import core, and the builder (C-AUTO-09) validates what an operator drew before either sees it.
 *
 * ## The definition is authored DATA, and every rule about it is named
 *
 * A flow is drawn by an operator and stored as a document, so every refusal has to be a value a caller
 * can branch on and a message a person can read — never a stack trace and never prose alone. So each
 * rule in {@link FLOW_DSL_RULES} and {@link FLOW_ANALYSIS_RULES} is a NAME, the zod messages below are
 * built with {@link flowRuleMessage} so the name travels with the schema rather than being restated in a
 * mapping table, and `validateFlowDefinition` in core reports the names. A gate case can then assert
 * that a known-bad definition was refused BY RULE rather than merely refused (ADR 0003).
 *
 * ## What is provisional here, and what is pinned to something real
 *
 * The node kinds and the two limits are this unit's provisional answer (`build/manifest.yaml`,
 * C-AUTO-06 `provisional`): eight kinds, 60 nodes, 180 days of accumulated delay. Nobody has stated a
 * figure for any of them.
 *
 * {@link FLOW_TRIGGER_EVENTS} is deliberately NOT provisional and deliberately not invented: every
 * member but `manual` is an outbox event some appointment status already emits, and
 * `packages/core/src/automation/dsl.test.ts` asserts the two sets are EQUAL in both directions against
 * `eventTypeFor` over `APPOINTMENT_STATUSES`. So a lifecycle event added without deciding whether it may
 * start a flow fails the build, and a trigger naming an event nothing emits cannot be written at all.
 * `pipeline.stage_entered` is absent because C-AUTO-08 has not landed; it joins the list with that unit,
 * which is what its acceptance line about "the same enrolment API as any other trigger" needs.
 *
 * {@link FLOW_CONDITION_FACTS} names only facts this schema can already answer — a future appointment,
 * a marketing consent, the VIP flag, the blocklist, the lifecycle state, a tag, the locale. A fact for a
 * column that does not exist would be a condition the interpreter (C-AUTO-07) could only answer by
 * guessing, and a flow that silently took the false branch for every contact is worse than one that
 * could not be published.
 */
import { z } from 'zod'
import { MESSAGE_CHANNELS, MESSAGE_CLASSES } from '../messaging.ts'

/**
 * The DSL's own schema version, carried on every definition.
 *
 * Distinct from a flow's PUBLISHED version, which counts edits by an operator. This number changes only
 * when the shape of the document changes, and it is stored beside the document in `flow_definition` so a
 * reader can tell a version-1 document from a version-2 one without parsing it. A definition that
 * declares a version this build does not implement is refused rather than read optimistically: a shape
 * guessed at is a flow that sends something nobody drew.
 */
export const FLOW_DSL_VERSION = 1

/**
 * The most nodes one definition may hold. Provisional (manifest, C-AUTO-06).
 *
 * A bound rather than a guess at the right size: `flow_definition.node_count` is GENERATED from the
 * document in migration 0070 and CHECKed against this number, so the limit is enforced where the row is
 * written as well as here. Sixty is comfortably more than any flow docs/03 §5 describes and small enough
 * that the static analyser's condensation is instant.
 */
export const MAX_FLOW_NODES = 60

/** The most accumulated delay one path through a definition may carry. 180 days, provisional. */
export const MAX_FLOW_ACCUMULATED_DELAY_MINUTES = 180 * 24 * 60

/**
 * The eight node kinds. Provisional (manifest, C-AUTO-06).
 *
 * `exit` is the only TERMINAL kind, which is what makes "a non-terminal node with no outgoing edge" a
 * decidable rule rather than a judgement: every other kind must lead somewhere, and a flow that stops
 * without saying why leaves an enrolment in a state no report can explain.
 */
export const FLOW_NODE_KINDS = [
  'trigger',
  'delay',
  'condition',
  'action_message',
  'action_tag',
  'action_stage',
  'split',
  'exit',
] as const
export type FlowNodeKind = (typeof FLOW_NODE_KINDS)[number]

/** The kinds a path may end on. One member, and the analyser reads this rather than the literal. */
export const FLOW_TERMINAL_NODE_KINDS = ['exit'] as const

/**
 * What may start a flow.
 *
 * Every `appointment.*` member is an outbox event an appointment transition already publishes (0024,
 * B-LIFE-01), and `packages/core/src/automation/dsl.test.ts` asserts that set equals what the lifecycle
 * emits in BOTH directions — so a transition added without deciding whether a flow may start on it fails
 * the build, and a trigger naming an event nothing emits can never fire.
 *
 * Two members are not appointment events, and each one is here because something in this build can now
 * cause it:
 *
 *   - `manual` is an operator enrolling somebody by hand, which C-AUTO-07's enrolment API offers. It has
 *     no event because nothing happened to the customer.
 *   - `pipeline.stage_entered` is a card entering a pipeline column (C-AUTO-08). It was deliberately
 *     ABSENT while `pipeline_stage` did not exist — C-AUTO-06's NOTE says so and defers it here — because
 *     a trigger naming an event nothing can raise is a flow an operator draws and waits on for ever.
 *     WHICH column starts the flow is not in the document: `pipeline_stage.entry_flow_key` names the flow
 *     per column, because the trigger node below is `.strict()` and has no stage field, and a stage
 *     qualifier in the node would be a second place to configure one board. `moveCard` refuses to enrol
 *     on a flow whose live definition does not declare this event, so the two cannot drift.
 */
export const FLOW_TRIGGER_EVENTS = [
  'appointment.confirmed',
  'appointment.checked_in',
  'appointment.started',
  'appointment.completed',
  'appointment.no_show',
  'appointment.cancelled_by_customer',
  'appointment.cancelled_by_salon',
  'appointment.rescheduled',
  'pipeline.stage_entered',
  'manual',
] as const
export type FlowTriggerEvent = (typeof FLOW_TRIGGER_EVENTS)[number]

/** The facts a condition may test. Each one is answerable from a column this schema already has. */
export const FLOW_CONDITION_FACTS = [
  'has_future_appointment',
  'has_marketing_consent',
  'is_vip',
  'is_blocklisted',
  'lifecycle_state',
  'tag',
  'locale',
] as const
export type FlowConditionFact = (typeof FLOW_CONDITION_FACTS)[number]

/**
 * The facts that are true or false, as opposed to the ones that hold a value.
 *
 * Kept as its own list because the pairing is a RULE: `lifecycle_state is_true` and
 * `is_vip equals lapsed` are both nonsense, and both are the kind of nonsense a picker produces when a
 * fact is changed and the operator is left selected. `flow-dsl-condition-operator-does-not-fit-fact`
 * refuses each of them by name.
 */
export const FLOW_BOOLEAN_CONDITION_FACTS = [
  'has_future_appointment',
  'has_marketing_consent',
  'is_vip',
  'is_blocklisted',
] as const

export const FLOW_CONDITION_OPERATORS = ['is_true', 'is_false', 'equals', 'not_equals'] as const
export type FlowConditionOperator = (typeof FLOW_CONDITION_OPERATORS)[number]

/** True for a fact whose only sensible operators are `is_true` and `is_false`. */
export const isBooleanConditionFact = (fact: string): boolean =>
  (FLOW_BOOLEAN_CONDITION_FACTS as readonly string[]).includes(fact)

/** Why an enrolment ended. Required on every exit: a flow that stops for no reason is unreportable. */
export const FLOW_EXIT_REASONS = ['completed', 'goal_met', 'not_eligible'] as const
export type FlowExitReason = (typeof FLOW_EXIT_REASONS)[number]

/** The branch label a node with one way out uses. `true`/`false` belong to a condition. */
export const FLOW_DEFAULT_BRANCH = 'default'

/** A condition's two branches, in the order a reader expects them. */
export const FLOW_CONDITION_BRANCHES = ['true', 'false'] as const

/**
 * Every reason a definition is refused for its SHAPE or its integrity, as a value.
 *
 * Shape rules are produced by the schema below; integrity rules are produced by
 * `validateFlowDefinition` in core, which is where a definition meets the template estate it references.
 */
export const FLOW_DSL_RULES = [
  /** A node kind this build does not implement. Checked before zod, so the name can be reported. */
  'flow-dsl-unknown-node-kind',
  'flow-dsl-unsupported-dsl-version',
  'flow-dsl-duplicate-node-id',
  'flow-dsl-node-count-exceeds-maximum',
  'flow-dsl-delay-exceeds-maximum',
  'flow-dsl-split-weights-do-not-sum',
  'flow-dsl-split-branch-labels-not-unique',
  'flow-dsl-condition-operator-does-not-fit-fact',
  'flow-dsl-missing-trigger',
  'flow-dsl-more-than-one-trigger',
  /** An edge naming a node the definition does not contain, in either direction. */
  'flow-dsl-dangling-edge',
  'flow-dsl-edge-into-the-trigger',
  /** An action node whose declared class is not the class of the template it names. */
  'flow-dsl-message-class-mismatch',
  /** The named template is not in the registry at all, so its class could not be checked. */
  'flow-dsl-unknown-template',
  /** No template registry was supplied, so no class was checked. Fail closed, never skip. */
  'flow-dsl-templates-not-checked',
  /** Anything zod refused that no rule above names. The issue's path and message are carried with it. */
  'flow-dsl-shape-invalid',
] as const
export type FlowDslRule = (typeof FLOW_DSL_RULES)[number]

/** Every reason the static analyser refuses a definition whose shape is already valid. */
export const FLOW_ANALYSIS_RULES = [
  'flow-analysis-non-terminal-node-has-no-outgoing-edge',
  'flow-analysis-unreachable-node',
  'flow-analysis-cycle-has-no-bounded-exit',
  'flow-analysis-cycle-has-no-delay',
  'flow-analysis-accumulated-delay-exceeds-maximum',
  'flow-analysis-condition-branch-missing',
  'flow-analysis-split-branch-missing',
  'flow-analysis-edge-branch-not-declared',
  'flow-analysis-ambiguous-branch',
  'flow-analysis-no-exit-reachable',
] as const
export type FlowAnalysisRule = (typeof FLOW_ANALYSIS_RULES)[number]

export type FlowRule = FlowDslRule | FlowAnalysisRule

/** Every rule name in one list, so a test can assert each one is reachable. */
export const FLOW_RULES: readonly FlowRule[] = Object.freeze([
  ...FLOW_DSL_RULES,
  ...FLOW_ANALYSIS_RULES,
])

export const isFlowRule = (value: string): value is FlowRule =>
  (FLOW_RULES as readonly string[]).includes(value)

/**
 * One refusal: the rule it broke, where, and a sentence a person can read.
 *
 * Declared here rather than in core for a structural reason and not a preference: the validator
 * (`automation/dsl.ts`) and the static analyser (`automation/static-analysis.ts`) both produce these and
 * the validator calls the analyser, so a shape declared in either of them makes the pair a cycle —
 * `tsPreCompilationDeps` counts a type-only import as an edge, and `no-circular` is an error.
 *
 * `at` is a node id, an edge description or a zod path — whatever identifies the part of the document at
 * fault — because a builder that says "this flow is invalid" and not WHERE is a builder an operator
 * cannot use. It is nullable rather than optional so a refusal with no location says so in the type.
 */
export interface FlowRefusal {
  readonly rule: FlowRule
  readonly at: string | null
  readonly detail: string
}

/**
 * A zod message that CARRIES its rule name, as `<rule>: <sentence>`.
 *
 * The alternative is a table mapping zod issue paths to rule names, kept beside the schema and drifting
 * from it the first time a field moves — and the symptom of that drift is a refusal reported under the
 * wrong rule, which reads exactly like a correct one. `flowRuleOf` in core splits this back apart, and
 * `flow-dsl-shape-invalid` is what a message with no rule name becomes rather than a crash.
 */
export const flowRuleMessage = (rule: FlowDslRule, sentence: string): string =>
  `${rule}: ${sentence}`

const NODE_ID = /^[a-z][a-z0-9_]{0,31}$/
const FLOW_KEY = /^[a-z][a-z0-9_]{0,63}$/
const LABEL = /^[a-z][a-z0-9_]{0,31}$/
const VOCABULARY_VALUE = /^[a-z][a-z0-9_]{0,47}$/
/** A template key as `message_template.template_key` spells one: `booking.confirmed`, `review.request`. */
const TEMPLATE_KEY = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

const nodeId = z.string().regex(NODE_ID, 'A node id is lower snake_case, 1-32 characters.')

/** Authored documentation on a node. Optional, and the field the round-trip property exists to protect. */
const note = z.string().trim().min(1).max(200)

const triggerNode = z
  .object({
    id: nodeId,
    kind: z.literal('trigger'),
    event: z.enum(FLOW_TRIGGER_EVENTS),
    note: note.optional(),
  })
  .strict()

const delayNode = z
  .object({
    id: nodeId,
    kind: z.literal('delay'),
    minutes: z
      .number()
      .int()
      .min(1, 'A delay of no minutes is not a delay; remove the node instead.')
      .max(
        MAX_FLOW_ACCUMULATED_DELAY_MINUTES,
        flowRuleMessage(
          'flow-dsl-delay-exceeds-maximum',
          'one delay may not exceed the maximum accumulated path delay of ' +
            `${MAX_FLOW_ACCUMULATED_DELAY_MINUTES} minutes`,
        ),
      ),
    note: note.optional(),
  })
  .strict()

const conditionNode = z
  .object({
    id: nodeId,
    kind: z.literal('condition'),
    test: z
      .object({
        fact: z.enum(FLOW_CONDITION_FACTS),
        operator: z.enum(FLOW_CONDITION_OPERATORS),
        /** Required for `equals`/`not_equals` and refused for the two boolean operators. */
        value: z.string().trim().min(1).max(64).optional(),
      })
      .strict()
      .refine(
        (test) =>
          isBooleanConditionFact(test.fact)
            ? (test.operator === 'is_true' || test.operator === 'is_false') &&
              test.value === undefined
            : (test.operator === 'equals' || test.operator === 'not_equals') &&
              test.value !== undefined,
        {
          message: flowRuleMessage(
            'flow-dsl-condition-operator-does-not-fit-fact',
            'a boolean fact takes is_true or is_false and no value; a valued fact takes equals or ' +
              'not_equals and a value',
          ),
        },
      ),
    note: note.optional(),
  })
  .strict()

const actionMessageNode = z
  .object({
    id: nodeId,
    kind: z.literal('action_message'),
    /**
     * The class the operator DECLARED, checked against the named template's own class by
     * `validateFlowDefinition`. Declared rather than derived so a mismatch is a refusal with a name
     * instead of a silent adoption of whatever class the template happens to carry — which is how
     * promotional copy ends up leaving from the transactional identity (C-AUTO-01).
     */
    messageClass: z.enum(MESSAGE_CLASSES),
    templateKey: z.string().regex(TEMPLATE_KEY, 'A template key looks like `booking.confirmed`.'),
    channel: z.enum(MESSAGE_CHANNELS),
    note: note.optional(),
  })
  .strict()

const actionTagNode = z
  .object({
    id: nodeId,
    kind: z.literal('action_tag'),
    tag: z.string().regex(VOCABULARY_VALUE, 'A tag is lower snake_case, 1-48 characters.'),
    note: note.optional(),
  })
  .strict()

const actionStageNode = z
  .object({
    id: nodeId,
    kind: z.literal('action_stage'),
    /**
     * A pipeline stage, by name. NOT checked against `pipeline_stage` here: C-AUTO-08 owns that table
     * and this package may not read a database at all. The publish path checks it once that unit lands.
     */
    stage: z.string().regex(VOCABULARY_VALUE, 'A stage is lower snake_case, 1-48 characters.'),
    note: note.optional(),
  })
  .strict()

const splitNode = z
  .object({
    id: nodeId,
    kind: z.literal('split'),
    branches: z
      .array(
        z
          .object({
            label: z.string().regex(LABEL, 'A branch label is lower snake_case, 1-32 characters.'),
            weightPerMille: z.number().int().min(1).max(999),
          })
          .strict(),
      )
      .min(2, 'A split with one branch is not a split.')
      .max(4),
    note: note.optional(),
  })
  .strict()
  .refine(
    (node) => node.branches.reduce((total, branch) => total + branch.weightPerMille, 0) === 1000,
    {
      message: flowRuleMessage(
        'flow-dsl-split-weights-do-not-sum',
        'the branch weights must sum to 1000 per mille, so every enrolment lands on exactly one branch',
      ),
    },
  )
  .refine(
    (node) => new Set(node.branches.map((branch) => branch.label)).size === node.branches.length,
    {
      message: flowRuleMessage(
        'flow-dsl-split-branch-labels-not-unique',
        'two branches sharing a label are one branch as far as the edges are concerned, and the second ' +
          'one is silently unreachable',
      ),
    },
  )

const exitNode = z
  .object({
    id: nodeId,
    kind: z.literal('exit'),
    reason: z.enum(FLOW_EXIT_REASONS),
    note: note.optional(),
  })
  .strict()

const flowEdge = z
  .object({
    from: nodeId,
    to: nodeId,
    /** `default`, a condition's `true`/`false`, or one of a split's branch labels. */
    branch: z.string().regex(LABEL, 'A branch is `default`, `true`, `false` or a split label.'),
  })
  .strict()

/**
 * One definition, shape only.
 *
 * `.strict()` everywhere, for `schemas/suppression.ts`'s reason one step further: an unexpected key here
 * is not a column that does not exist, it is a field of a flow SOMEBODY DREW that this build does not
 * implement — a delay nobody waits, a condition nobody evaluates. Dropping it silently would publish a
 * flow that does less than the operator was shown.
 *
 * The graph itself — reachability, cycles, branch completeness, accumulated delay — is NOT here. It is
 * `packages/core/src/automation/static-analysis.ts`, because zod validates a document and a flow is a
 * graph, and a `refine` big enough to hold a traversal is a traversal nobody can test on its own.
 */
export const flowDefinitionSchema = z
  .object({
    dslVersion: z
      .number()
      .int()
      .refine((value) => value === FLOW_DSL_VERSION, {
        message: flowRuleMessage(
          'flow-dsl-unsupported-dsl-version',
          `this build implements DSL version ${FLOW_DSL_VERSION} and refuses to guess at any other`,
        ),
      }),
    key: z.string().regex(FLOW_KEY, 'A flow key is lower snake_case, 1-64 characters.'),
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(280).optional(),
    nodes: z
      .array(
        z.union([
          triggerNode,
          delayNode,
          conditionNode,
          actionMessageNode,
          actionTagNode,
          actionStageNode,
          splitNode,
          exitNode,
        ]),
      )
      .min(1, 'A definition with no nodes is not a flow.')
      .max(
        MAX_FLOW_NODES,
        flowRuleMessage(
          'flow-dsl-node-count-exceeds-maximum',
          `a definition may hold at most ${MAX_FLOW_NODES} nodes`,
        ),
      ),
    edges: z.array(flowEdge).max(MAX_FLOW_NODES * 4),
  })
  .strict()

export type FlowDefinition = z.infer<typeof flowDefinitionSchema>
export type FlowNode = FlowDefinition['nodes'][number]
export type FlowEdge = FlowDefinition['edges'][number]
