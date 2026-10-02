import {
  FLOW_CONDITION_BRANCHES,
  FLOW_DEFAULT_BRANCH,
  FLOW_DSL_VERSION,
  type FlowNode,
  MESSAGE_CLASSES,
} from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { CORPUS_TEMPLATES } from '../../test/fixtures/flow-definitions/index.ts'
import {
  classedMessageStep,
  composeJourney,
  conditionStep,
  connectJourneyDraft,
  delayStep,
  disconnectJourneyDraft,
  draftDocument,
  draftOf,
  exitStep,
  freeOutletsOf,
  inletsOf,
  type JourneyDraft,
  journeyDraftVerdict,
  journeyOutletKey,
  messageStep,
  placeJourneyNode,
  removeJourneyNode,
  resolveJourneyInlet,
  resolveJourneyOutlet,
  serialiseFlowDefinition,
  splitStep,
  stageStep,
  tagStep,
  templateChoicesFor,
  templateRefFor,
  validateFlowDefinition,
} from './dsl.ts'
import { declaredBranchesOf } from './static-analysis.ts'

/**
 * C-AUTO-09 — the typed authoring surface, and the six misroutings that have no name.
 *
 * The acceptance line is "with misrouting made impossible", which is a claim about a TYPE. So the cases
 * that matter most in this file are not assertions at all: they are `@ts-expect-error` directives, and
 * they are a check rather than a comment because a directive that stops erroring is `TS2578: Unused
 * '@ts-expect-error' directive` and fails `pnpm typecheck`. Widen `JourneyEdgeMap`'s value type, make it
 * `Partial`, give `exitStep` a branch, or drop `TemplateRef`'s class parameter, and the corresponding
 * directive below goes unused and the build stops.
 *
 * `packages/core/src/automation/journey.property.test.ts` holds the 200-journey property. The HALF of
 * each acceptance line that is about a screen or an HTTP body — the picker's options, the save control,
 * the API's named refusal, the enrolment count — is `apps/web/src/flow-builder.itest.ts`, because none
 * of it can be checked without the built application.
 *
 * Nothing here is a message body or a person's name: every template is a KEY from the registry
 * (`CORPUS_TEMPLATES`, which `flow-corpus.test.ts` holds equal to `message_template`'s own rows), and the
 * only words are the authored notes a flow carries (brief rules 10 and 15).
 */

const TEMPLATES = [...CORPUS_TEMPLATES]
const PROMOTIONAL = templateChoicesFor(TEMPLATES, 'promotional')
const TRANSACTIONAL = templateChoicesFor(TEMPLATES, 'transactional')

/**
 * A reference the type system knows is THERE, not one it knows might be missing.
 *
 * `PROMOTIONAL[0]` is `TemplateRef<'promotional'> | undefined` and an `if (… === undefined) throw` at
 * module scope does not narrow it inside a nested function. That mattered, and it is the defect gate
 * case 159e found: directives 5a and 5b below were suppressing `Type 'undefined' is not assignable`
 * rather than the class mismatch they are written for, so they went on erroring even with the class tie
 * cut — a check satisfied for the wrong reason, which is ADR 0003's whole subject. Narrowing in a
 * function that RETURNS the value is what makes the only possible error at those two sites the one the
 * directives claim.
 */
function mustHold<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(what)
  return value
}

const review = mustHold(
  PROMOTIONAL[0],
  'the corpus registry holds no promotional template, so the class rule has nothing to bind',
)
const confirmed = mustHold(
  TRANSACTIONAL.find((ref) => ref.templateKey === 'booking.confirmed'),
  'the corpus registry no longer holds booking.confirmed as a transactional template',
)

/**
 * The journey every case below is a variation on: the post-visit review ask, composed rather than parsed.
 *
 * Deliberately the same journey as `valid-01-post-visit-review-request.json`, because the strongest
 * statement this file can make about the composer is that it expresses a journey the build already has a
 * committed document for — and the case below compares the two node and edge SETS, so a composer that
 * produced something subtly different would fail against bytes nobody wrote for it.
 */
const postVisitReviewAsk = () =>
  composeJourney({
    key: 'post_visit_review_request',
    title: 'Ask for a review after a visit',
    description:
      'The flow docs/07 describes: a day after a completed treatment, ask for a review — but only ' +
      'from a contact who has given marketing consent, because review.request is promotional.',
    trigger: { id: 'visit_completed', event: 'appointment.completed' },
    steps: {
      settle: delayStep({ minutes: 1440, note: 'A day, so the ask does not arrive at the door.' }),
      may_we_ask: conditionStep({
        test: { fact: 'has_marketing_consent', operator: 'is_true' },
      }),
      ask: messageStep({ template: review, channel: 'sms' }),
      mark_asked: tagStep({ tag: 'review_requested' }),
      done: exitStep({ reason: 'goal_met' }),
      no_consent: exitStep({ reason: 'not_eligible' }),
    },
    edges: {
      'visit_completed:default': 'settle',
      'settle:default': 'may_we_ask',
      'may_we_ask:true': 'ask',
      'may_we_ask:false': 'no_consent',
      'ask:default': 'mark_asked',
      'mark_asked:default': 'done',
    },
  })

describe('acceptance — a composed journey is a definition the C-AUTO-06 validator accepts', () => {
  it('composes the committed post-visit review journey, and the validator passes it', () => {
    const verdict = validateFlowDefinition(postVisitReviewAsk(), { templates: TEMPLATES })
    expect(verdict.ok ? [] : verdict.refusals.map((refusal) => refusal.rule)).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  it('derives the message node class from the template and never from a second field', () => {
    const definition = postVisitReviewAsk()
    const ask = definition.nodes.find((node) => node.id === 'ask')
    expect(ask?.kind).toBe('action_message')
    if (ask?.kind !== 'action_message') throw new Error('unreachable')
    // The class on the node is the class the REGISTRY holds for that key, because it was read off the
    // ref rather than typed beside it. The control: the registry really says so, and really says
    // something else for the other template, so this is not two names for one value.
    expect(ask.messageClass).toBe('promotional')
    expect(TEMPLATES.find((fact) => fact.templateKey === ask.templateKey)?.messageClass).toBe(
      'promotional',
    )
    expect(TEMPLATES.find((fact) => fact.templateKey === 'booking.confirmed')?.messageClass).toBe(
      'transactional',
    )
  })

  it('orders its output from the document rather than from the literal, so two spellings agree', () => {
    // One ordering rule, shared with the builder's `draftDocument` — a journey DRAWN in one order and
    // the identical journey written as a literal in another must serialise to the same bytes, or the
    // canonical form is a property of the author rather than of the journey.
    // The bytes are the thing a pinned version is compared against, so "the same journey written in a
    // different order is the same document" has to be true of the composer and not only hoped for.
    const reordered = composeJourney({
      key: 'post_visit_review_request',
      title: 'Ask for a review after a visit',
      description:
        'The flow docs/07 describes: a day after a completed treatment, ask for a review — but only ' +
        'from a contact who has given marketing consent, because review.request is promotional.',
      trigger: { id: 'visit_completed', event: 'appointment.completed' },
      steps: {
        no_consent: exitStep({ reason: 'not_eligible' }),
        done: exitStep({ reason: 'goal_met' }),
        mark_asked: tagStep({ tag: 'review_requested' }),
        ask: messageStep({ template: review, channel: 'sms' }),
        may_we_ask: conditionStep({
          test: { fact: 'has_marketing_consent', operator: 'is_true' },
        }),
        settle: delayStep({
          minutes: 1440,
          note: 'A day, so the ask does not arrive at the door.',
        }),
      },
      edges: {
        'mark_asked:default': 'done',
        'ask:default': 'mark_asked',
        'may_we_ask:false': 'no_consent',
        'may_we_ask:true': 'ask',
        'settle:default': 'may_we_ask',
        'visit_completed:default': 'settle',
      },
    })
    expect(serialiseFlowDefinition(reordered)).toBe(serialiseFlowDefinition(postVisitReviewAsk()))
  })

  it('composes every kind, including a split, and the validator passes that too', () => {
    const journey = composeJourney({
      key: 'cauto09_every_kind',
      title: 'Every node kind, routed',
      trigger: { id: 'entered', event: 'manual' },
      steps: {
        hold: delayStep({ minutes: 60 }),
        arm: splitStep({
          branches: [
            { label: 'ask_now', weightPerMille: 500 },
            { label: 'ask_later', weightPerMille: 500 },
          ],
        }),
        now: messageStep({ template: review, channel: 'sms' }),
        later: delayStep({ minutes: 2880 }),
        then_ask: messageStep({ template: review, channel: 'email' }),
        label_it: tagStep({ tag: 'review_requested' }),
        move_it: stageStep({ stage: 'nurture' }),
        is_vip: conditionStep({ test: { fact: 'is_vip', operator: 'is_true' } }),
        finished: exitStep({ reason: 'completed' }),
        ineligible: exitStep({ reason: 'not_eligible' }),
      },
      edges: {
        'entered:default': 'hold',
        'hold:default': 'arm',
        'arm:ask_now': 'now',
        'arm:ask_later': 'later',
        'now:default': 'label_it',
        'later:default': 'then_ask',
        'then_ask:default': 'label_it',
        'label_it:default': 'is_vip',
        'is_vip:true': 'move_it',
        'is_vip:false': 'ineligible',
        'move_it:default': 'finished',
      },
    })
    const verdict = validateFlowDefinition(journey, { templates: TEMPLATES })
    expect(verdict.ok ? [] : verdict.refusals.map((refusal) => refusal.rule)).toEqual([])
    // Every kind really is present, or the case above is a claim about a smaller journey.
    expect([...new Set(journey.nodes.map((node) => node.kind))].sort()).toEqual([
      'action_message',
      'action_stage',
      'action_tag',
      'condition',
      'delay',
      'exit',
      'split',
      'trigger',
    ])
  })
})

describe('acceptance — misrouting has no name: the six edges a type refuses to express', () => {
  /*
    Every case in this block is a DIRECTIVE and not an assertion, and the assertion at the end of the
    block is what stops the block being vacuous: a file of `@ts-expect-error` comments with no runtime
    case still has to compile, and `tsc` is what reads them.

    They are gathered in one function so `noUnusedLocals` does not reject the drafts, and the function is
    never called: the claim is about what the compiler says, and running it would prove nothing more.
  */
  function theSixThatDoNotTypecheck(): void {
    // 1. An edge OUT of an exit. `exitStep` is `JourneyStep<never>`, so `finished:default` is not an
    //    outlet key of this journey at all.
    composeJourney({
      key: 'cauto09_no_edge_out_of_an_exit',
      title: 'An exit is terminal',
      trigger: { id: 'entered', event: 'manual' },
      steps: { finished: exitStep({ reason: 'completed' }), spare: tagStep({ tag: 'unused' }) },
      edges: {
        'entered:default': 'finished',
        'spare:default': 'finished',
        // @ts-expect-error — an exit has no way out, so this key does not exist on the edge map.
        'finished:default': 'spare',
      },
    })

    // 2. An edge back INTO the trigger. The edge map's value type is `keyof steps`, and the trigger is
    //    not a step — which is why it is a field of its own rather than a member of the record.
    composeJourney({
      key: 'cauto09_no_edge_into_the_trigger',
      title: 'The trigger is the way in',
      trigger: { id: 'entered', event: 'manual' },
      steps: { hold: delayStep({ minutes: 60 }), finished: exitStep({ reason: 'completed' }) },
      edges: {
        'entered:default': 'hold',
        // @ts-expect-error — `entered` is the trigger: no edge may land on it.
        'hold:default': 'entered',
        'finished:default': 'finished',
      },
    })

    // 3. An edge on a branch the source does not DECLARE. A split's outlets are its own labels, so a
    //    condition's `true` is not among them.
    composeJourney({
      key: 'cauto09_no_undeclared_branch',
      title: 'A split has the branches it declares',
      trigger: { id: 'entered', event: 'manual' },
      steps: {
        arm: splitStep({
          branches: [
            { label: 'left', weightPerMille: 500 },
            { label: 'right', weightPerMille: 500 },
          ],
        }),
        finished: exitStep({ reason: 'completed' }),
      },
      edges: {
        'entered:default': 'arm',
        'arm:left': 'finished',
        'arm:right': 'finished',
        // @ts-expect-error — a split has no `true` branch; `arm:left` and `arm:right` are its outlets.
        'arm:true': 'finished',
      },
    })

    // 4. A branch with NO edge. Every outlet key is required, so a condition with one answer is a
    //    missing property rather than a save-time refusal.
    composeJourney({
      key: 'cauto09_no_unrouted_branch',
      title: 'A condition answers both ways',
      trigger: { id: 'entered', event: 'manual' },
      steps: {
        is_vip: conditionStep({ test: { fact: 'is_vip', operator: 'is_true' } }),
        finished: exitStep({ reason: 'completed' }),
      },
      // @ts-expect-error — `is_vip:false` is missing, so half of every audience is routed nowhere.
      edges: {
        'entered:default': 'is_vip',
        'is_vip:true': 'finished',
      },
    })

    // 5. A node the operator declared PROMOTIONAL, bound to a transactional template. This is the
    //    acceptance line itself — "an operator must not be able to route promotional content through a
    //    transactional template" — and it is a compile error rather than a save-time refusal.
    classedMessageStep({
      messageClass: 'promotional',
      // @ts-expect-error — `booking.confirmed` is transactional: it is not bindable to this node.
      template: confirmed,
      channel: 'sms',
    })
    // And the reverse, because a transactional node bound to an offer is the same defect the other way
    // round: it would leave from the transactional identity, inside no window, with no opt-out route.
    classedMessageStep({
      messageClass: 'transactional',
      // @ts-expect-error — `review.request` is promotional.
      template: review,
      channel: 'sms',
    })

    // 6. A template reference a caller MINTED rather than read from the registry. Without the witness
    //    symbol, "this key is promotional" would be an assertion by whoever typed it.
    // @ts-expect-error — the class witness is private to dsl.ts, so no literal satisfies TemplateRef.
    const forged: (typeof PROMOTIONAL)[number] = {
      templateKey: 'booking.confirmed',
      messageClass: 'promotional',
    }
    messageStep({ template: forged, channel: 'sms' })
  }

  it('keeps the six directives above load-bearing, and the compiler is what reads them', () => {
    // The vacuity guard. `theSixThatDoNotTypecheck` is never called, so nothing in it runs — this case
    // asserts the function is in the module and that the two classes it contrasts are really two, which
    // is the premise every directive rests on. The directives themselves are checked by `tsc`.
    expect(typeof theSixThatDoNotTypecheck).toBe('function')
    // The premise directive 5 rests on: the constrained constructor really does build a node when the
    // class and the template agree, so the two directives above are about the MISMATCH and not about a
    // function nothing can call.
    expect(
      classedMessageStep({ messageClass: 'promotional', template: review, channel: 'sms' }).node(
        'ask',
      ),
    ).toMatchObject({ kind: 'action_message', messageClass: 'promotional' })
    expect(
      classedMessageStep({
        messageClass: 'transactional',
        template: confirmed,
        channel: 'sms',
      }).node('tell'),
    ).toMatchObject({ kind: 'action_message', templateKey: 'booking.confirmed' })
    expect([...MESSAGE_CLASSES]).toEqual(['transactional', 'promotional'])
    expect(PROMOTIONAL.length).toBeGreaterThan(0)
    expect(TRANSACTIONAL.length).toBeGreaterThan(0)
    expect(PROMOTIONAL.map((ref) => ref.templateKey)).not.toContain('booking.confirmed')
  })
})

describe('the template picker is the binding, derived once', () => {
  it('offers exactly the registry rows of the class asked for, sorted, and nothing else', () => {
    for (const messageClass of MESSAGE_CLASSES) {
      const offered = templateChoicesFor(TEMPLATES, messageClass).map((ref) => ref.templateKey)
      const expected = TEMPLATES.filter((fact) => fact.messageClass === messageClass)
        .map((fact) => fact.templateKey)
        .sort()
      expect(offered).toEqual(expected)
      // Sorted, because the list is rendered: an unsorted registry would make a screenshot of the
      // picker depend on row order in `message_template`.
      expect(offered).toEqual([...offered].sort())
    }
    // The partition is a partition: no key is offered for both classes, and every row is offered once.
    const both = MESSAGE_CLASSES.flatMap((messageClass) =>
      templateChoicesFor(TEMPLATES, messageClass).map((ref) => ref.templateKey),
    )
    expect(both.length).toBe(TEMPLATES.length)
    expect(new Set(both).size).toBe(TEMPLATES.length)
  })

  it('resolves a stored key back to a ref only under the class the registry holds for it', () => {
    expect(templateRefFor(TEMPLATES, 'promotional', 'review.request')?.templateKey).toBe(
      'review.request',
    )
    // The same key under the other class resolves to nothing, which is what makes a stored node whose
    // template was RECLASSIFIED after publication unopenable in the builder rather than silently
    // re-bound — C-AUTO-06's residual gap, reported at the one moment a person is looking at it.
    expect(templateRefFor(TEMPLATES, 'transactional', 'review.request')).toBeNull()
    expect(templateRefFor(TEMPLATES, 'promotional', 'no.such_template')).toBeNull()
  })
})

describe('each step constructor agrees with the analyser about its own branches', () => {
  it('states the same branch set the static analyser reads off the node it builds', () => {
    // The check the brief asks for when a fact is stated twice. `JourneyStep.branches` is what the
    // builder's pickers read; `declaredBranchesOf` is what the analyser refuses an edge against. An
    // outlet offered for a branch the analyser will reject is a builder that invites the mistake.
    const steps = [
      delayStep({ minutes: 1 }),
      conditionStep({ test: { fact: 'is_vip', operator: 'is_true' } }),
      messageStep({ template: review, channel: 'sms' }),
      tagStep({ tag: 'review_requested' }),
      stageStep({ stage: 'nurture' }),
      splitStep({
        branches: [
          { label: 'left', weightPerMille: 400 },
          { label: 'right', weightPerMille: 600 },
        ],
      }),
      exitStep({ reason: 'completed' }),
    ]
    expect(steps).toHaveLength(7)
    for (const step of steps) {
      const node = step.node('probe')
      expect([...step.branches].sort(), node.kind).toEqual([...declaredBranchesOf(node)].sort())
    }
    // The control: the three answers really are three, so the comparison above is not seven copies of
    // one list.
    expect(declaredBranchesOf(exitStep({ reason: 'completed' }).node('a'))).toEqual([])
    expect(declaredBranchesOf(delayStep({ minutes: 1 }).node('a'))).toEqual([FLOW_DEFAULT_BRANCH])
    expect(
      declaredBranchesOf(
        conditionStep({ test: { fact: 'is_vip', operator: 'is_true' } }).node('a'),
      ),
    ).toEqual([...FLOW_CONDITION_BRANCHES])
  })
})

// ------------------------------------------------------------------------------------------------
// The interactive half: a half-drawn graph, and edits that can only name an offered edge
// ------------------------------------------------------------------------------------------------

const emptyDraft = (): JourneyDraft => ({
  key: 'cauto09_draft',
  title: 'A journey being drawn',
  nodes: [{ id: 'entered', kind: 'trigger', event: 'manual' }],
  edges: [],
})

const node = (value: FlowNode): FlowNode => value

describe('acceptance — an invalid intermediate state is a draft, and the one verdict refuses it', () => {
  it('refuses a draft with a dead end by name, and accepts it the moment the edge is drawn', () => {
    let draft = placeJourneyNode(emptyDraft(), node({ id: 'hold', kind: 'delay', minutes: 60 }))
    draft = placeJourneyNode(draft, node({ id: 'finished', kind: 'exit', reason: 'completed' }))

    // Nothing is connected yet: this is what the builder holds a second after two nodes are placed.
    const half = journeyDraftVerdict(draft, { templates: TEMPLATES })
    expect(half.ok).toBe(false)
    expect(half.ok ? [] : half.refusals.map((refusal) => refusal.rule)).toContain(
      'flow-analysis-non-terminal-node-has-no-outgoing-edge',
    )

    // Now draw both edges, through offers rather than through a literal.
    for (const [from, branch, to] of [
      ['entered', FLOW_DEFAULT_BRANCH, 'hold'],
      ['hold', FLOW_DEFAULT_BRANCH, 'finished'],
    ] as const) {
      const outlet = resolveJourneyOutlet(draft, from, branch)
      const inlet = resolveJourneyInlet(draft, to)
      if (outlet === null || inlet === null) throw new Error(`${from}:${branch} was not offered`)
      draft = connectJourneyDraft(draft, outlet, inlet)
    }
    const whole = journeyDraftVerdict(draft, { templates: TEMPLATES })
    expect(whole.ok ? [] : whole.refusals.map((refusal) => refusal.rule)).toEqual([])
    expect(whole.ok).toBe(true)
  })

  it('fails closed on a draft with a message node when no registry was injected', () => {
    let draft = placeJourneyNode(
      emptyDraft(),
      node({
        id: 'ask',
        kind: 'action_message',
        messageClass: 'promotional',
        templateKey: 'review.request',
        channel: 'sms',
      }),
    )
    draft = placeJourneyNode(draft, node({ id: 'finished', kind: 'exit', reason: 'goal_met' }))
    const verdict = journeyDraftVerdict(draft)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok ? [] : verdict.refusals.map((refusal) => refusal.rule)).toContain(
      'flow-dsl-templates-not-checked',
    )
  })
})

describe('acceptance — an edge the draft did not offer cannot be named', () => {
  const drawn = (): JourneyDraft => {
    let draft = placeJourneyNode(
      emptyDraft(),
      node({ id: 'is_vip', kind: 'condition', test: { fact: 'is_vip', operator: 'is_true' } }),
    )
    draft = placeJourneyNode(draft, node({ id: 'finished', kind: 'exit', reason: 'completed' }))
    const outlet = resolveJourneyOutlet(draft, 'entered', FLOW_DEFAULT_BRANCH)
    const inlet = resolveJourneyInlet(draft, 'is_vip')
    if (outlet === null || inlet === null) throw new Error('the trigger outlet was not offered')
    return connectJourneyDraft(draft, outlet, inlet)
  }

  it('offers no outlet on an exit, no inlet on the trigger, and no branch a kind does not have', () => {
    const draft = drawn()
    const outlets = freeOutletsOf(draft).map((outlet) =>
      journeyOutletKey(outlet.from, outlet.branch),
    )
    // The exit contributes nothing, the trigger's one outlet is already taken, and the condition
    // contributes exactly its two answers.
    expect([...outlets].sort()).toEqual(['is_vip:false', 'is_vip:true'])
    expect(
      inletsOf(draft)
        .map((inlet) => inlet.to)
        .sort(),
    ).toEqual(['finished', 'is_vip'])
    expect(inletsOf(draft).map((inlet) => inlet.to)).not.toContain('entered')
  })

  it('resolves nothing for the four edges a misrouting would need', () => {
    const draft = drawn()
    // Out of an exit; into the trigger; a branch the condition does not declare; and a second edge on
    // an outlet that already has one. Each of these is `null` rather than a refusal, which is the whole
    // difference between "the builder said no" and "the builder never offered it".
    expect(resolveJourneyOutlet(draft, 'finished', FLOW_DEFAULT_BRANCH)).toBeNull()
    expect(resolveJourneyInlet(draft, 'entered')).toBeNull()
    expect(resolveJourneyOutlet(draft, 'is_vip', 'default')).toBeNull()
    expect(resolveJourneyOutlet(draft, 'entered', FLOW_DEFAULT_BRANCH)).toBeNull()
    // The control: the two edges that ARE offered do resolve, so the four nulls above are about those
    // four edges and not about a resolver that answers null for everything.
    expect(resolveJourneyOutlet(draft, 'is_vip', 'true')?.from).toBe('is_vip')
    expect(resolveJourneyOutlet(draft, 'is_vip', 'false')?.branch).toBe('false')
    expect(resolveJourneyInlet(draft, 'finished')?.to).toBe('finished')
    // And a body that is not a string at all resolves to nothing rather than throwing.
    expect(resolveJourneyOutlet(draft, 42, null)).toBeNull()
    expect(resolveJourneyInlet(draft, { to: 'finished' })).toBeNull()
  })

  it('takes every edge with the node, so deleting one cannot leave a dangling edge', () => {
    let draft = drawn()
    const trueOutlet = resolveJourneyOutlet(draft, 'is_vip', 'true')
    const inlet = resolveJourneyInlet(draft, 'finished')
    if (trueOutlet === null || inlet === null) throw new Error('not offered')
    draft = connectJourneyDraft(draft, trueOutlet, inlet)
    expect(draft.edges).toHaveLength(2)

    const without = removeJourneyNode(draft, 'is_vip')
    expect(without.nodes.map((candidate) => candidate.id).sort()).toEqual(['entered', 'finished'])
    // Both edges went with it: the one INTO the node and the one out of it. A delete that removed only
    // the node would leave `flow-dsl-dangling-edge`, which is a refusal about the builder's own
    // bookkeeping rather than about anything the operator did.
    expect(without.edges).toHaveLength(0)
    const verdict = journeyDraftVerdict(without, { templates: TEMPLATES })
    expect(verdict.ok ? [] : verdict.refusals.map((refusal) => refusal.rule)).not.toContain(
      'flow-dsl-dangling-edge',
    )
  })

  it('frees an outlet again when its edge is disconnected', () => {
    const draft = drawn()
    expect(resolveJourneyOutlet(draft, 'entered', FLOW_DEFAULT_BRANCH)).toBeNull()
    const released = disconnectJourneyDraft(draft, 'entered', FLOW_DEFAULT_BRANCH)
    expect(resolveJourneyOutlet(released, 'entered', FLOW_DEFAULT_BRANCH)?.from).toBe('entered')
    expect(resolveJourneyOutlet(released, 'entered', FLOW_DEFAULT_BRANCH)?.branch).toBe(
      FLOW_DEFAULT_BRANCH,
    )
    expect(released.edges).toHaveLength(0)
  })
})

describe('the ordering is a property of the journey and not of the author', () => {
  it('serialises a journey drawn in reverse to the same bytes as the composed one', () => {
    // The claim `orderJourneyDocument` exists for, over a DRAFT rather than a literal: the builder
    // appends each node and edge in the order the operator clicked, and the bytes must not depend on
    // that. Built backwards on purpose.
    const definition = postVisitReviewAsk()
    const backwards: JourneyDraft = {
      key: definition.key,
      title: definition.title,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      nodes: [...definition.nodes].reverse(),
      edges: [...definition.edges].reverse(),
    }
    const verdict = journeyDraftVerdict(backwards, { templates: TEMPLATES })
    expect(verdict.ok ? [] : verdict.refusals.map((refusal) => refusal.rule)).toEqual([])
    if (!verdict.ok) throw new Error('unreachable')
    expect(verdict.canonical).toBe(serialiseFlowDefinition(definition))
    // The control: the reversed arrays really were different, so the equality above is about the
    // ordering and not about two identical inputs.
    expect(backwards.nodes.map((node) => node.id)).not.toEqual(
      definition.nodes.map((node) => node.id),
    )
  })

  it('leaves serialiseFlowDefinition alone, which is what keeps the committed corpus valid', () => {
    // `orderJourneyDocument` is deliberately NOT inside the serialiser: `flow-corpus.test.ts` asserts
    // every committed corpus file equals `serialiseFlowDefinition`'s output exactly, and those files
    // are written in traversal order because that is how a person reads a flow. This asserts the
    // serialiser is order-PRESERVING, which is the property that claim rests on.
    const definition = postVisitReviewAsk()
    const reversed = { ...definition, nodes: [...definition.nodes].reverse() }
    expect(serialiseFlowDefinition(reversed)).not.toBe(serialiseFlowDefinition(definition))
  })
})

describe('acceptance — save and reload reproduce an identical serialised graph', () => {
  it('round-trips a composed journey through a draft and back to the same bytes', () => {
    // The pure half of the Playwright claim. `draftOf` and `draftDocument` are the two halves of what the
    // builder does between one request and the next, so a composed journey that does not survive them
    // byte-for-byte would be a screen that redraws something else — and the itest's reload assertion
    // would then be about a defect this file could have found in a millisecond.
    const definition = postVisitReviewAsk()
    const reloaded = validateFlowDefinition(draftDocument(draftOf(definition)), {
      templates: TEMPLATES,
    })
    expect(reloaded.ok ? [] : reloaded.refusals.map((refusal) => refusal.rule)).toEqual([])
    if (!reloaded.ok) throw new Error('unreachable')
    expect(reloaded.canonical).toBe(serialiseFlowDefinition(definition))
    // And the document carries the DSL version it was composed under, or a reader could not tell a
    // version-1 document from a version-2 one without parsing it.
    expect(reloaded.definition.dslVersion).toBe(FLOW_DSL_VERSION)
  })
})
