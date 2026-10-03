import { describe, expect, it } from 'vitest'
import { type FlowTemplateFact, serialiseFlowDefinition, validateFlowDefinition } from './dsl.ts'
import {
  BIRTHDAY_TODAY_TAG,
  birthdayJourney,
  LOW_INTERNAL_RATING_TAG,
  REVIEW_REQUEST_TEMPLATE_KEY,
  reviewSolicitationJourney,
  STOCK_JOURNEY_KEY_LIST,
  stockJourneys,
  WINBACK_DUE_TAG,
  winbackJourney,
} from './journeys.ts'

/**
 * C-AUTO-11's three stock journeys.
 *
 * The claim worth testing is that each one is a VALID document the publish path would accept, composed
 * through C-AUTO-09's composer — so each case is paired with a control: `validateFlowDefinition` with no
 * registry answers `flow-dsl-templates-not-checked` rather than passing, and a run with the registry is
 * what proves the class rule was actually applied.
 */

/** `message_template`'s two columns, as the registry hands them over. */
const TEMPLATES: readonly FlowTemplateFact[] = [
  { templateKey: REVIEW_REQUEST_TEMPLATE_KEY, messageClass: 'promotional' },
  { templateKey: 'booking.confirmed', messageClass: 'transactional' },
]

const validate = (definition: ReturnType<typeof winbackJourney>) =>
  validateFlowDefinition(definition, { templates: TEMPLATES })

describe('the three stock journeys', () => {
  it('are all three present and keyed as the seed and the triggers spell them', () => {
    const journeys = stockJourneys(TEMPLATES)
    expect(journeys).not.toBeNull()
    expect(journeys?.map((journey) => journey.key)).toEqual([...STOCK_JOURNEY_KEY_LIST])
  })

  it('each validate against the real registry, which is the publish path’s own judgement', () => {
    for (const journey of stockJourneys(TEMPLATES) ?? []) {
      const verdict = validate(journey)
      expect(
        verdict.ok,
        `${journey.key}: ${JSON.stringify('refusals' in verdict ? verdict.refusals : [])}`,
      ).toBe(true)
    }
  })

  it('are refused with no registry rather than passing unchecked', () => {
    // The control, and the reason it matters: a check that silently did not run is ADR 0002's failure.
    // The REVIEW journey, because it is the only one of the three that names a template — the other two
    // send nothing, so there is nothing for the registry to be absent for. That asymmetry is itself the
    // finding this unit reports: two of the three journeys carry no message because no human has
    // approved win-back or birthday copy.
    const verdict = validateFlowDefinition(reviewSolicitationJourney(TEMPLATES) as never)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.refusals.map((refusal) => refusal.rule)).toContain(
      'flow-dsl-templates-not-checked',
    )
  })

  it('serialise to the same bytes twice, so a reseed is byte-identical', () => {
    const first = stockJourneys(TEMPLATES) ?? []
    const second = stockJourneys(TEMPLATES) ?? []
    expect(first.map(serialiseFlowDefinition)).toEqual(second.map(serialiseFlowDefinition))
  })

  it('return null as a SET when the review template is not in the registry', () => {
    // Not a shorter list: a seed that wrote two of three would leave a database in which the review
    // journey does not exist and nothing would say so.
    expect(
      stockJourneys([{ templateKey: 'booking.confirmed', messageClass: 'transactional' }]),
    ).toBeNull()
    expect(reviewSolicitationJourney([])).toBeNull()
  })
})

describe('the review journey routes a low rating away from the public link', () => {
  const journey = reviewSolicitationJourney(TEMPLATES)

  it('branches on the tag the trigger writes, with one spelling of it', () => {
    const condition = journey?.nodes.find((node) => node.kind === 'condition')
    expect(condition).toBeDefined()
    if (condition === undefined || condition.kind !== 'condition') return
    expect(condition.test).toEqual({
      fact: 'tag',
      operator: 'equals',
      value: LOW_INTERNAL_RATING_TAG,
    })
  })

  it('sends the review request on the FALSE branch and tags on the TRUE one', () => {
    const condition = journey?.nodes.find((node) => node.kind === 'condition')
    const trueEdge = journey?.edges.find(
      (edge) => edge.from === condition?.id && edge.branch === 'true',
    )
    const falseEdge = journey?.edges.find(
      (edge) => edge.from === condition?.id && edge.branch === 'false',
    )
    const nodeOf = (id: string | undefined) => journey?.nodes.find((node) => node.id === id)

    // The true branch is the LOW rating, and it must not reach the public review link.
    expect(nodeOf(trueEdge?.to)?.kind).toBe('action_tag')
    expect(nodeOf(falseEdge?.to)?.kind).toBe('action_message')
    // The control: the public link is reachable at all, so the assertion above is about a routing
    // decision rather than about a journey with no message in it.
    const message = nodeOf(falseEdge?.to)
    if (message?.kind !== 'action_message') throw new Error('the false branch is the message')
    expect(message.templateKey).toBe(REVIEW_REQUEST_TEMPLATE_KEY)
    expect(message.messageClass).toBe('promotional')
  })

  it('asks the condition AFTER the delay, because the rating does not exist at enrolment', () => {
    const trigger = journey?.nodes.find((node) => node.kind === 'trigger')
    const fromTrigger = journey?.edges.find((edge) => edge.from === trigger?.id)
    const delay = journey?.nodes.find((node) => node.id === fromTrigger?.to)
    expect(delay?.kind).toBe('delay')
  })

  it('is entered by appointment.completed and never by appointment.confirmed', () => {
    const trigger = journey?.nodes.find((node) => node.kind === 'trigger')
    if (trigger?.kind !== 'trigger') throw new Error('a journey has a trigger')
    expect(trigger.event).toBe('appointment.completed')
  })
})

describe('the two journeys with no approved copy send nothing', () => {
  /**
   * Asserted as VALUES and not as booleans, so a failure prints what is actually there.
   *
   * `expect(journey.nodes.some(...)).toBe(true)` fails with `expected false to be true`, which names
   * neither the tag nor the node kind — and a gate case asserting rejection BY NAME (ADR 0003) has to be
   * able to find the name in the output it is given. The list form prints both sides.
   */
  const tagsOf = (journey: ReturnType<typeof winbackJourney>): readonly string[] =>
    journey.nodes.flatMap((node) => (node.kind === 'action_tag' ? [node.tag] : []))
  const messageIdsOf = (journey: ReturnType<typeof winbackJourney>): readonly string[] =>
    journey.nodes.flatMap((node) => (node.kind === 'action_message' ? [node.id] : []))
  const exitReasonsOf = (journey: ReturnType<typeof winbackJourney>): readonly string[] =>
    journey.nodes.flatMap((node) => (node.kind === 'exit' ? [node.reason] : [])).sort()

  it('win-back tags and exits, and carries no message node at all', () => {
    const journey = winbackJourney()
    expect(messageIdsOf(journey)).toEqual([])
    expect(tagsOf(journey)).toEqual([WINBACK_DUE_TAG])
    // `not_eligible` is a recorded outcome and not an absence: it is how "we identified them and did
    // not act" becomes a fact somebody can read.
    expect(exitReasonsOf(journey)).toEqual(['completed', 'not_eligible'])
  })

  it('birthday tags and exits, and reads nothing about a year', () => {
    const journey = birthdayJourney()
    expect(messageIdsOf(journey)).toEqual([])
    expect(tagsOf(journey)).toEqual([BIRTHDAY_TODAY_TAG])
    // The whole document, as bytes: no reference to a year, an age or a date of birth can hide in it.
    const document = serialiseFlowDefinition(journey)
    expect(document).not.toMatch(/birth_year|birthYear|\bage\b|date_of_birth/)
  })

  it('both ask for marketing consent inside the journey as well as in the sweep', () => {
    for (const journey of [winbackJourney(), birthdayJourney()]) {
      const condition = journey.nodes.find((node) => node.kind === 'condition')
      if (condition?.kind !== 'condition') throw new Error('both journeys branch on consent')
      expect(condition.test).toEqual({ fact: 'has_marketing_consent', operator: 'is_true' })
    }
  })
})
