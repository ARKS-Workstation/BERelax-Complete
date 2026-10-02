import {
  FLOW_CONDITION_FACTS,
  type FlowEdge,
  type FlowNode,
  MAX_FLOW_ACCUMULATED_DELAY_MINUTES,
  MAX_FLOW_NODES,
} from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CORPUS_TEMPLATES } from '../../test/fixtures/flow-definitions/index.ts'
import {
  connectJourneyDraft,
  disconnectJourneyDraft,
  draftDocument,
  freeOutletsOf,
  inletsOf,
  type JourneyDraft,
  journeyDraftVerdict,
  placeJourneyNode,
  removeJourneyNode,
  resolveJourneyInlet,
  resolveJourneyOutlet,
} from './dsl.ts'

/**
 * C-AUTO-09's first acceptance line, as a property: **200 randomly generated graph edits all produce
 * definitions that pass the C-AUTO-06 validator**, and an invalid intermediate state is refused by name.
 *
 * ## What "edits" means here, and why that reading is the narrow one
 *
 * Every graph below is built by applying a random sequence of the builder's own four edits — place a
 * node, draw an edge, remove an edge, delete a node — to an empty draft, and **every edge is drawn
 * through an OFFER** (`resolveJourneyOutlet` / `resolveJourneyInlet`), because that is the only way the
 * builder can draw one. So the property is a statement about the edit algebra and not about documents
 * somebody handed it: if an offered edge could produce an inexpressible routing, this would find it.
 *
 * It would be a weaker test to generate arbitrary documents and assert the validator refuses the bad
 * ones — C-AUTO-06's corpus already does that, from both sides. The claim this unit has to make is that
 * the BUILDER cannot reach a bad routing, so the generator drives the builder.
 *
 * ## Why the sequence finishes with a completion pass, and what that does NOT paper over
 *
 * A validator refuses an unreachable node, a dead end, a loop with no delay and a path longer than 180
 * days. None of those is a misrouting; all of them are legitimate intermediate states of somebody's
 * afternoon. So the generator grows the graph from the trigger outward — every node is placed by
 * connecting a free outlet to it, which makes reachability a property of the construction — and then
 * routes whatever outlets remain to an exit. What is left after that is exactly the class of claim a type
 * cannot make, and the second property in this file is the control: take ONE edge back out of each of
 * the 200 finished graphs and the verdict must flip to a NAMED refusal. If the completion pass were
 * hiding a defect, that control would be satisfied by a validator that refused everything — so it also
 * asserts which rules it saw.
 *
 * ## The floors are MEASURED (brief rule 22)
 *
 * A generator that produced 200 linear chains would satisfy the property while exercising none of the
 * branching the acceptance line is about. The run therefore counts how many of the 200 contain a
 * condition, a split, a join (a node two edges land on), a message node of each class and a note, and
 * asserts a floor against the lowest figure observed over repeated runs — set below the observed minimum
 * by a margin, because a floor set at it becomes its own flake.
 */

const JOURNEYS = 200

/** Enough to run out of budget before the node ceiling, so the ceiling is never the thing that binds. */
const MAX_PLACED_STEPS = 14

/**
 * Every delay is at most two days, and a graph is at most `MAX_PLACED_STEPS` deep.
 *
 * So the longest accumulated path is 14 x 2880 = 40,320 minutes against a ceiling of 259,200: the delay
 * rule can never be what refuses a generated graph, which is what makes the first property a statement
 * about routing rather than about arithmetic. Asserted below rather than left as a comment.
 */
const MAX_DELAY_MINUTES = 2880

const TEMPLATES = [...CORPUS_TEMPLATES]
const DEPS = { templates: TEMPLATES }
const PROMOTIONAL = TEMPLATES.filter((fact) => fact.messageClass === 'promotional')
const TRANSACTIONAL = TEMPLATES.filter((fact) => fact.messageClass === 'transactional')

const BOOLEAN_FACTS = ['has_future_appointment', 'has_marketing_consent', 'is_vip'] as const
const VALUED_FACTS = ['tag', 'locale'] as const

/** A step the generator may place, as the node it becomes. The id is supplied by the caller. */
type StepArb = (id: string) => FlowNode

const noteArb = fc.option(fc.constantFrom('why this waits', 'agreed with the owner'), {
  nil: undefined,
  freq: 2,
})

const withNote = (node: FlowNode, note: string | undefined): FlowNode =>
  note === undefined ? node : ({ ...node, note } as FlowNode)

const delayArb: fc.Arbitrary<StepArb> = fc
  .tuple(fc.integer({ min: 1, max: MAX_DELAY_MINUTES }), noteArb)
  .map(
    ([minutes, note]) =>
      (id: string) =>
        withNote({ id, kind: 'delay', minutes }, note),
  )

const conditionArb: fc.Arbitrary<StepArb> = fc
  .tuple(
    fc.oneof(
      fc
        .constantFrom(...BOOLEAN_FACTS)
        .chain((fact) =>
          fc
            .constantFrom('is_true' as const, 'is_false' as const)
            .map((operator) => ({ fact, operator })),
        ),
      fc
        .constantFrom(...VALUED_FACTS)
        .chain((fact) =>
          fc
            .constantFrom('en', 'ar', 'review_requested')
            .map((value) => ({ fact, operator: 'equals' as const, value })),
        ),
    ),
    noteArb,
  )
  .map(
    ([test, note]) =>
      (id: string) =>
        withNote({ id, kind: 'condition', test } as FlowNode, note),
  )

const messageArb: fc.Arbitrary<StepArb> = fc
  .tuple(
    fc.constantFrom(...TEMPLATES),
    fc.constantFrom('sms' as const, 'email' as const, 'whatsapp' as const),
    noteArb,
  )
  .map(
    ([template, channel, note]) =>
      (id: string) =>
        withNote(
          {
            id,
            kind: 'action_message',
            messageClass: template.messageClass,
            templateKey: template.templateKey,
            channel,
          },
          note,
        ),
  )

const tagArb: fc.Arbitrary<StepArb> = fc
  .constantFrom('review_requested', 'vip_seen', 'win_back')
  .map((tag) => (id: string) => ({ id, kind: 'action_tag', tag }))

const stageArb: fc.Arbitrary<StepArb> = fc
  .constantFrom('nurture', 'booked', 'lost')
  .map((stage) => (id: string) => ({ id, kind: 'action_stage', stage }))

/** Weight sets that already sum to 1000, so a split is shape-valid by construction. */
const SPLIT_WEIGHTS: readonly (readonly number[])[] = [
  [500, 500],
  [333, 333, 334],
  [250, 250, 250, 250],
  [100, 900],
  [700, 200, 100],
]

const splitArb: fc.Arbitrary<StepArb> = fc
  .constantFrom(...SPLIT_WEIGHTS)
  .map((weights) => (id: string) => ({
    id,
    kind: 'split',
    branches: weights.map((weightPerMille, at) => ({
      label: `share_${at + 1}`,
      weightPerMille,
    })),
  }))

const exitArb: fc.Arbitrary<StepArb> = fc
  .constantFrom('completed' as const, 'goal_met' as const, 'not_eligible' as const)
  .map((reason) => (id: string) => ({ id, kind: 'exit', reason }))

/**
 * The branching kinds are weighted UP, and that is the whole of brief rule 22 applied here.
 *
 * Uniform over seven kinds would put a condition or a split in about a third of the nodes of a graph
 * whose median size is eight, which sounds like enough and is not: the claim is about routings with more
 * than one way out, and the cheapest way to satisfy a property about them is to generate mostly chains.
 */
const stepArb: fc.Arbitrary<StepArb> = fc.oneof(
  { arbitrary: conditionArb, weight: 4 },
  { arbitrary: splitArb, weight: 3 },
  { arbitrary: messageArb, weight: 3 },
  { arbitrary: delayArb, weight: 2 },
  { arbitrary: tagArb, weight: 1 },
  { arbitrary: stageArb, weight: 1 },
  { arbitrary: exitArb, weight: 2 },
)

/** One edit the generator may attempt. `join` and `prune` are what make the sequence non-monotonic. */
type EditKind = 'grow' | 'join' | 'prune'

const editArb: fc.Arbitrary<EditKind> = fc.oneof(
  { arbitrary: fc.constant('grow' as const), weight: 8 },
  { arbitrary: fc.constant('join' as const), weight: 3 },
  { arbitrary: fc.constant('prune' as const), weight: 1 },
)

interface GeneratedPlan {
  readonly event: 'appointment.completed' | 'appointment.no_show' | 'manual'
  readonly edits: readonly {
    readonly kind: EditKind
    readonly step: StepArb
    readonly dice: number
  }[]
  readonly finalExit: StepArb
}

const planArb: fc.Arbitrary<GeneratedPlan> = fc.record({
  event: fc.constantFrom(
    'appointment.completed' as const,
    'appointment.no_show' as const,
    'manual' as const,
  ),
  edits: fc.array(
    fc.record({ kind: editArb, step: stepArb, dice: fc.double({ min: 0, max: 1, noNaN: true }) }),
    { minLength: 2, maxLength: MAX_PLACED_STEPS },
  ),
  finalExit: exitArb,
})

interface Outcome {
  readonly draft: JourneyDraft
  readonly placed: number
  readonly pruned: number
  readonly joins: number
}

/**
 * Applies the plan through the builder's own four edits, and nothing else.
 *
 * Every edge goes through `resolveJourneyOutlet` and `resolveJourneyInlet`, which is the point: a plan
 * that asked for an edge out of an exit, into the trigger, on a branch a kind does not declare, or on an
 * outlet that already has one gets `null` and the edit does not happen. So the sequence cannot reach a
 * misrouting even when the dice ask for one, and the property below is about what remains.
 */
function build(plan: GeneratedPlan, key: string): Outcome {
  let draft: JourneyDraft = {
    key,
    title: 'A generated journey',
    nodes: [{ id: 'entered', kind: 'trigger', event: plan.event }],
    edges: [],
  }
  let placed = 0
  let pruned = 0
  let joins = 0

  for (const edit of plan.edits) {
    if (draft.nodes.length >= MAX_FLOW_NODES) break
    const chosen = pick(freeOutletsOf(draft), edit.dice)
    if (chosen === null) break

    if (edit.kind === 'prune' && draft.nodes.length > 2) {
      const victim = pick(inletsOf(draft), edit.dice)
      if (victim !== null) {
        draft = removeJourneyNode(draft, victim.to)
        pruned += 1
      }
      continue
    }

    const joined = edit.kind === 'join' ? join(draft, chosen.from, chosen.branch, edit.dice) : null
    if (joined !== null) {
      draft = joined
      joins += 1
      continue
    }

    draft = grow(draft, chosen.from, chosen.branch, edit.step, `n${placed}`)
    placed += 1
  }

  return { draft: complete(draft, plan.finalExit), placed, pruned, joins }
}

/** The index a die lands on in a list, or null for an empty one. Total, so no caller branches twice. */
function pick<T>(from: readonly T[], dice: number): T | null {
  if (from.length === 0) return null
  return from[Math.min(from.length - 1, Math.floor(dice * from.length))] ?? null
}

/**
 * An edge to a node that is already there: a diamond rather than a tree.
 *
 * Only to a node that cannot reach the source, so the join is a DAG join — the cycle rules are not
 * routing rules, and a cycle is proven expressible by C-AUTO-06's `valid-04` corpus document instead.
 * Null when no such target exists, which tells the caller to grow instead.
 */
function join(
  draft: JourneyDraft,
  from: string,
  branch: string,
  dice: number,
): JourneyDraft | null {
  const targets = inletsOf(draft).filter(
    (inlet) => inlet.to !== from && !reaches(draft, inlet.to, from),
  )
  const inlet = pick(targets, dice)
  const outlet = resolveJourneyOutlet(draft, from, branch)
  if (inlet === null || outlet === null) return null
  return connectJourneyDraft(draft, outlet, inlet)
}

/** Places a new node and routes one free outlet to it, so reachability holds by construction. */
function grow(
  draft: JourneyDraft,
  from: string,
  branch: string,
  step: StepArb,
  id: string,
): JourneyDraft {
  const placed = placeJourneyNode(draft, step(id))
  const outlet = resolveJourneyOutlet(placed, from, branch)
  const inlet = resolveJourneyInlet(placed, id)
  return outlet === null || inlet === null ? placed : connectJourneyDraft(placed, outlet, inlet)
}

/**
 * Routes every outlet still free to one exit, then removes whatever the pruning orphaned.
 *
 * Both halves are about rules a type cannot make: a dead end and an unreachable node are legitimate
 * intermediate states of an afternoon's work, and leaving them in would make the property a test of the
 * reachability rule rather than of the routing.
 */
function complete(draft: JourneyDraft, finalExit: StepArb): JourneyDraft {
  let out = draft
  const existing = out.nodes.find((node) => node.kind === 'exit')
  const exitId = existing?.id ?? 'finished'
  if (existing === undefined) out = placeJourneyNode(out, finalExit(exitId))
  for (;;) {
    const next = freeOutletsOf(out)[0]
    if (next === undefined) break
    const outlet = resolveJourneyOutlet(out, next.from, next.branch)
    const inlet = resolveJourneyInlet(out, exitId)
    if (outlet === null || inlet === null) break
    out = connectJourneyDraft(out, outlet, inlet)
  }
  for (const node of out.nodes) {
    if (node.kind === 'trigger') continue
    if (!reaches(out, 'entered', node.id)) out = removeJourneyNode(out, node.id)
  }
  return out
}

/** Can `from` reach `to` along the draft's edges? Used to keep a generated join acyclic. */
function reaches(draft: JourneyDraft, from: string, to: string): boolean {
  const seen = new Set<string>([from])
  const queue = [from]
  for (let at = 0; at < queue.length; at += 1) {
    const here = queue[at] as string
    if (here === to && at > 0) return true
    for (const edge of draft.edges) {
      if (edge.from !== here || seen.has(edge.to)) continue
      if (edge.to === to) return true
      seen.add(edge.to)
      queue.push(edge.to)
    }
  }
  return false
}

const inDegrees = (edges: readonly FlowEdge[]): ReadonlyMap<string, number> => {
  const degrees = new Map<string, number>()
  for (const edge of edges) degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1)
  return degrees
}

interface Tally {
  withCondition: number
  withSplit: number
  withJoin: number
  withPromotional: number
  withTransactional: number
  withNoteField: number
  pruningHappened: number
  maxNodes: number
}

const EMPTY_TALLY: Tally = {
  withCondition: 0,
  withSplit: 0,
  withJoin: 0,
  withPromotional: 0,
  withTransactional: 0,
  withNoteField: 0,
  pruningHappened: 0,
  maxNodes: 0,
}

/** Does any message node in the draft name a template of this class? */
const sends = (draft: JourneyDraft, of: readonly { readonly templateKey: string }[]): boolean =>
  draft.nodes.some(
    (node) =>
      node.kind === 'action_message' && of.some((fact) => fact.templateKey === node.templateKey),
  )

/** What this generated journey exercised, added to the running tally. Brief rule 22's counting half. */
function count(tally: Tally, outcome: Outcome): void {
  const kinds = outcome.draft.nodes.map((node) => node.kind)
  if (kinds.includes('condition')) tally.withCondition += 1
  if (kinds.includes('split')) tally.withSplit += 1
  if (
    outcome.joins > 0 &&
    [...inDegrees(outcome.draft.edges).values()].some((degree) => degree > 1)
  ) {
    tally.withJoin += 1
  }
  if (outcome.pruned > 0) tally.pruningHappened += 1
  if (sends(outcome.draft, PROMOTIONAL)) tally.withPromotional += 1
  if (sends(outcome.draft, TRANSACTIONAL)) tally.withTransactional += 1
  if (outcome.draft.nodes.some((node) => node.note !== undefined)) tally.withNoteField += 1
  tally.maxNodes = Math.max(tally.maxNodes, outcome.draft.nodes.length)
}

describe('acceptance — 200 generated graph edits all produce definitions the validator passes', () => {
  it('builds 200 journeys through the builder edits, and every one is accepted', () => {
    const plans = fc.sample(planArb, { numRuns: JOURNEYS, seed: 20_260_209 })
    expect(plans).toHaveLength(JOURNEYS)

    const tally = { ...EMPTY_TALLY }
    const refused: string[] = []

    plans.forEach((plan, at) => {
      const outcome = build(plan, `cauto09_generated_${at}`)
      const verdict = journeyDraftVerdict(outcome.draft, DEPS)
      if (!verdict.ok) {
        refused.push(
          `#${at}: ${verdict.refusals.map((refusal) => `${refusal.rule}@${refusal.at ?? '-'}`).join(', ')}`,
        )
        return
      }
      count(tally, outcome)
      // The accumulated delay can never be what binds, so the first property really is about routing.
      expect(verdict.facts.maxAccumulatedDelayMinutes).toBeLessThan(
        MAX_FLOW_ACCUMULATED_DELAY_MINUTES,
      )
    })

    expect(
      refused,
      `${refused.length} of ${JOURNEYS} were refused:\n${refused.join('\n')}`,
    ).toEqual([])
    const {
      withCondition,
      withSplit,
      withJoin,
      withPromotional,
      withTransactional,
      withNoteField,
      pruningHappened,
      maxNodes,
    } = tally

    /*
      The floors, MEASURED and not guessed (brief rule 22).

      The seed below is fixed, so this run's figures are exact; the floors are nevertheless set below the
      LOWEST figure observed over seven seeds (20260209, 1, 7314, 99991, 424242, 555 and 123456789, each
      at 200 journeys — 1,400 generated graphs, not one of them refused), because a floor set at the
      observed minimum becomes its own flake and because the figure that matters is what the GENERATOR
      produces rather than what one seed did. The observed minima were: condition 91, split 64, join 65,
      promotional 13, transactional 75, note 102, pruned 44, largest graph 13 nodes.

      `withPromotional` is the low one and legitimately so: the registry holds one promotional template
      against thirteen transactional ones (`message_template`, C-AUTO-01), so a uniform draw over the
      registry puts a promotional send in about a fourteenth of the message nodes. Weighting it up would
      make this a property about a registry nobody has.
    */
    expect(withCondition, 'journeys containing a condition').toBeGreaterThanOrEqual(75)
    expect(withSplit, 'journeys containing a split').toBeGreaterThanOrEqual(50)
    expect(withJoin, 'journeys where two edges land on one node').toBeGreaterThanOrEqual(50)
    expect(withPromotional, 'journeys sending a promotional template').toBeGreaterThanOrEqual(8)
    expect(withTransactional, 'journeys sending a transactional template').toBeGreaterThanOrEqual(
      60,
    )
    expect(withNoteField, 'journeys carrying an authored note').toBeGreaterThanOrEqual(85)
    expect(
      pruningHappened,
      'journeys where a node was deleted mid-sequence',
    ).toBeGreaterThanOrEqual(30)
    // And the graphs are not all tiny: a property over 200 three-node chains is a property about nothing.
    expect(maxNodes, 'the largest generated journey').toBeGreaterThanOrEqual(10)
  }, 60_000)

  it('flips to a NAMED refusal when one edge is taken back out of each of the 200', () => {
    // The control, and it is the acceptance line's second half: an invalid intermediate state is refused
    // by the API with a named error. Without it, the property above would be satisfied by a validator
    // that accepted everything.
    const plans = fc.sample(planArb, { numRuns: JOURNEYS, seed: 20_260_209 })
    const seen = new Map<string, number>()
    let checked = 0

    plans.forEach((plan, at) => {
      const { draft } = build(plan, `cauto09_generated_${at}`)
      const edge = draft.edges[0]
      if (edge === undefined) return
      const broken = disconnectJourneyDraft(draft, edge.from, edge.branch)
      const verdict = journeyDraftVerdict(broken, DEPS)
      expect(verdict.ok, `#${at}: removing ${edge.from}:${edge.branch} left a valid document`).toBe(
        false,
      )
      if (!verdict.ok) {
        for (const refusal of verdict.refusals) {
          seen.set(refusal.rule, (seen.get(refusal.rule) ?? 0) + 1)
        }
      }
      checked += 1
    })

    expect(checked).toBe(JOURNEYS)
    // Named, and the names are the ones a missing edge should produce — not an arbitrary refusal that
    // happened to fire. `flow-dsl-shape-invalid` among them would mean the draft had stopped being a
    // document at all, which is a different defect.
    const names = [...seen.keys()].sort()
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(
        [
          'flow-analysis-condition-branch-missing',
          'flow-analysis-non-terminal-node-has-no-outgoing-edge',
          'flow-analysis-no-exit-reachable',
          'flow-analysis-split-branch-missing',
          'flow-analysis-unreachable-node',
        ],
        `${name} is not a rule a missing edge should produce`,
      ).toContain(name)
    }
    /*
      The first edge of a generated graph leaves the trigger, so everything downstream of it becomes
      unreachable — asserted with a floor so that "named" is not satisfied by one rule firing once in one
      graph. Measured over the same seven seeds: 760 to 844 refusals of this rule across the 200, and
      every one of the 1,400 broken graphs was refused, which is what makes `expect(verdict.ok).toBe(
      false)` above a claim rather than a hope.
    */
    expect(seen.get('flow-analysis-unreachable-node') ?? 0).toBeGreaterThanOrEqual(600)
  }, 60_000)
})

describe('the generator can only name an edge the draft offered', () => {
  it('never produces an edge out of an exit, into the trigger, or twice on one branch', () => {
    const plans = fc.sample(planArb, { numRuns: 40, seed: 7_314 })
    for (const [at, plan] of plans.entries()) {
      const { draft } = build(plan, `cauto09_offer_${at}`)
      const exits = new Set(
        draft.nodes.filter((node) => node.kind === 'exit').map((node) => node.id),
      )
      const triggers = new Set(
        draft.nodes.filter((node) => node.kind === 'trigger').map((node) => node.id),
      )
      const outlets = new Set<string>()
      for (const edge of draft.edges) {
        expect(exits.has(edge.from), `#${at}: an edge leaves exit ${edge.from}`).toBe(false)
        expect(triggers.has(edge.to), `#${at}: an edge lands on trigger ${edge.to}`).toBe(false)
        const key = `${edge.from}:${edge.branch}`
        expect(outlets.has(key), `#${at}: ${key} has two edges`).toBe(false)
        outlets.add(key)
      }
      // The document really is one the validator reads, so the three assertions above are about a graph
      // and not about an empty edge list.
      expect(draft.edges.length).toBeGreaterThan(0)
      expect((draftDocument(draft) as { nodes: unknown[] }).nodes.length).toBeGreaterThan(1)
    }
    // The condition vocabulary the generator draws from is a subset of the real one, so a fact removed
    // from the schema would fail here rather than silently narrowing the generator.
    for (const fact of [...BOOLEAN_FACTS, ...VALUED_FACTS]) {
      expect(FLOW_CONDITION_FACTS as readonly string[]).toContain(fact)
    }
  }, 30_000)
})
