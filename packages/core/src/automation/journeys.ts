/**
 * The three stock journeys, composed through C-AUTO-09's typed composer.
 *
 * C-AUTO-11. Each one is a {@link composeJourney} literal, which means its wrong edges do not typecheck
 * rather than being refused at publish time: an edge out of an `exit`, an edge back into the trigger, an
 * edge on a branch the source does not declare, two edges on one branch, a branch with no edge, and a
 * message node bound to a template of the other class are all compile errors here (ADR 0081). Nothing in
 * this file writes a `FlowDefinition` literal, and that is deliberate — a second way to author a journey
 * is a second set of rules for a reviewer to know.
 *
 * ## What the DSL could NOT express, reported rather than worked around
 *
 * Three of C-AUTO-11's acceptance clauses do not have a vocabulary in `schemas/flow.ts`, and the
 * arrangement below is what they became. Each is a finding about the DSL rather than a gap in the
 * journeys:
 *
 *   1. **There is no `booking.created` trigger event.** `FLOW_TRIGGER_EVENTS` is appointment-level —
 *      `appointment.confirmed`, `appointment.completed` and six others — so a journey cannot be entered
 *      by a booking as such. The review journey is entered by `appointment.completed`, which is the
 *      booking event that matters for it, and the M3 proof uses the same event.
 *   2. **There is no "paid" condition fact.** `FLOW_CONDITION_FACTS` holds consent, VIP, blocklist,
 *      lifecycle, tag, locale and a future appointment, and none of them is about money. So *"enrols
 *      only on a COMPLETED and paid appointment"* is an ELIGIBILITY decision taken by the trigger before
 *      the enrolment, in `apps/worker/src/automation/triggers/review-solicitation.ts`, and not a
 *      condition node. That is the right half of the system for it in any case: a contact who was
 *      enrolled and then found ineligible has already had the engine's attention.
 *   3. **There is no rating fact.** The internal rating arrives out of band, so the private path branches
 *      on `tag`, which the DSL does have — the trigger writes the tag and the journey reads it. One fact,
 *      one place it is stated.
 *
 * ## Why two of the three journeys send no message
 *
 * Because no human has approved win-back or birthday copy, and this build may not invent any (brief rule
 * 15). The only promotional template it ships is `review.request`, which ships in `draft` *precisely* so
 * that its words cannot reach a customer until somebody with the authority to approve marketing copy has
 * done so — `templates.ts` says so in as many words. So the win-back and birthday journeys end in an
 * `action_tag`: the engine identifies the contact, the front desk acts, and the day the copy is approved
 * the message node is one edge away. A journey that shipped copy nobody agreed would be sending it.
 *
 * The review journey DOES carry a message node, bound to `review.request` — and the shipped behaviour of
 * that node today is a refusal, by name, because the template is `draft`. That is the system working:
 * the journey is complete, the gate is real, and what is missing is an approval rather than code.
 */
import type { FlowDefinition, MessageClass } from '@berelax/shared'
import {
  composeJourney,
  conditionStep,
  delayStep,
  exitStep,
  type FlowTemplateFact,
  messageStep,
  type TemplateRef,
  tagStep,
  templateRefFor,
} from './dsl.ts'

/** The flow keys the seed writes and the triggers enrol on. Spelled once. */
export const STOCK_JOURNEY_KEYS = {
  reviewSolicitation: 'review_solicitation',
  winback: 'winback',
  birthday: 'birthday',
} as const
export type StockJourneyKey = (typeof STOCK_JOURNEY_KEYS)[keyof typeof STOCK_JOURNEY_KEYS]

/** Every stock journey key, for a seeder or a test that has to prove none was forgotten. */
export const STOCK_JOURNEY_KEY_LIST: readonly StockJourneyKey[] = Object.freeze([
  STOCK_JOURNEY_KEYS.reviewSolicitation,
  STOCK_JOURNEY_KEYS.winback,
  STOCK_JOURNEY_KEYS.birthday,
])

/** The template the review journey's public path is bound to. Promotional, and shipped `draft`. */
export const REVIEW_REQUEST_TEMPLATE_KEY = 'review.request'

/**
 * The tag a low internal rating writes, and the tag the review journey branches on.
 *
 * One spelling, in one place, because the trigger writes it and the journey reads it — and a tag spelled
 * two ways is a condition that silently never matches, which on this journey means every unhappy
 * customer being sent the public review link.
 */
export const LOW_INTERNAL_RATING_TAG = 'internal_rating_low'

/** The tags the two message-less journeys write, for the front desk to act on. */
export const WINBACK_DUE_TAG = 'winback_due'
export const BIRTHDAY_TODAY_TAG = 'birthday_today'

/** The OPEN-QUESTIONS ids these journeys' provisional figures are tracked under. */
export const STOCK_JOURNEY_OPEN_QUESTIONS = Object.freeze({
  reviewLink: 'Y2-gbp-status',
  winbackInterval: 'Y9-crm-pipeline',
  birthdayHour: 'Y9-crm-pipeline',
})

/**
 * How long after a completed visit the review journey asks.
 *
 * One day, which is the shortest interval that is not the same evening: a review request that arrives
 * while the customer is still in the car park is asking about something they have not finished thinking
 * about, and one that arrives a week later is asking about something they have. It is an argument on
 * {@link reviewSolicitationJourney} rather than a figure this module reads.
 */
export const REVIEW_DELAY_MINUTES = 24 * 60

/**
 * The review-solicitation journey.
 *
 * ```
 * completed ──▶ wait 1 day ──▶ rating low? ──true──▶ tag: private follow-up ──▶ exit (completed)
 *                                          ──false─▶ ask for a review ────────▶ exit (completed)
 * ```
 *
 * The condition comes AFTER the delay and not before, and the order is the acceptance clause: the
 * internal rating is collected after the visit, so a condition evaluated at enrolment would read the tag
 * before anything had written it and route every customer down the public path. The delay is what makes
 * the tag a fact the condition can read.
 *
 * The true branch TAGS rather than messaging, for the file header's reason: a private follow-up to an
 * unhappy customer is the most sensitive message in this build and there is no approved copy for it. The
 * tag is what puts that customer in front of a person, which is the right answer for an unhappy customer
 * in any case.
 *
 * `templates` is the registry, injected: `messageStep` takes a {@link TemplateRef}, which is minted only
 * by the registry, so the node's `messageClass` is DERIVED from the template row rather than declared
 * beside it (ADR 0081). A caller with no registry gets `null` rather than a journey bound to a template
 * nobody checked.
 */
export function reviewSolicitationJourney(
  templates: readonly FlowTemplateFact[],
  options: { readonly delayMinutes?: number } = {},
): FlowDefinition | null {
  const reviewTemplate: TemplateRef<MessageClass> | null = templateRefFor(
    templates,
    'promotional',
    REVIEW_REQUEST_TEMPLATE_KEY,
  )
  if (reviewTemplate === null) return null

  return composeJourney({
    key: STOCK_JOURNEY_KEYS.reviewSolicitation,
    title: 'Review solicitation',
    description:
      'Asks for a public review one day after a visit that COMPLETED and was paid, unless the internal ' +
      'rating says the customer was unhappy — in which case the contact is tagged for a person to ' +
      'follow up privately instead. Eligibility is the trigger’s: the DSL has no "paid" fact.',
    trigger: {
      id: 'completed',
      event: 'appointment.completed',
      note:
        'Entered by the daily sweep for an appointment that COMPLETED and was paid. Never on ' +
        'appointment.confirmed: a review request for a visit that has not happened is the clause ' +
        'this journey exists for.',
    },
    steps: {
      wait: delayStep({
        minutes: options.delayMinutes ?? REVIEW_DELAY_MINUTES,
        note:
          'One day. Short enough that the visit is fresh, long enough that the internal rating has been ' +
          'collected, which is what the condition below reads.',
      }),
      rating_low: conditionStep({
        test: { fact: 'tag', operator: 'equals', value: LOW_INTERNAL_RATING_TAG },
        note:
          'The rating arrives out of band and the DSL has no rating fact, so the trigger writes a TAG ' +
          'and this reads it. One statement of the fact, in one place.',
      }),
      private_follow_up: tagStep({
        tag: 'needs_private_follow_up',
        note:
          'A person, not a message. No approved copy exists for a private follow-up to an unhappy ' +
          'customer, and this is where inventing some would cost the most (brief rule 15).',
      }),
      ask_for_review: messageStep({
        template: reviewTemplate,
        channel: 'sms',
        note:
          'Promotional, and the class comes from the template row rather than from here. It ships in ' +
          'draft, so the choke point refuses it by name until somebody approves the words.',
      }),
      done: exitStep({ reason: 'completed' }),
    },
    edges: {
      'completed:default': 'wait',
      'wait:default': 'rating_low',
      'rating_low:true': 'private_follow_up',
      'rating_low:false': 'ask_for_review',
      'private_follow_up:default': 'done',
      'ask_for_review:default': 'done',
    },
  })
}

/**
 * The win-back journey.
 *
 * ```
 * manual ──▶ has marketing consent? ──true──▶ tag: winback_due ──▶ exit (completed)
 *                                   ──false─▶ exit (not_eligible)
 * ```
 *
 * `manual` is the trigger event, and it is the honest one: `FLOW_TRIGGER_EVENTS` has no
 * `customer.lapsed`, because a contact becoming lapsed is not an event anything in this build emits — it
 * is a FACT about an absence, which is why the win-back is a daily sweep measuring business days rather
 * than a handler reacting to something. `winback.ts` is the arithmetic and its worked example is the
 * acceptance line.
 *
 * The consent condition is in the JOURNEY and not only in the trigger, and that is not belt and braces:
 * a contact can withdraw consent between the sweep and the tag, and the exit reason `not_eligible` is
 * what makes "we identified them and did not act" a recorded outcome rather than an absence.
 */
export function winbackJourney(): FlowDefinition {
  return composeJourney({
    key: STOCK_JOURNEY_KEYS.winback,
    title: 'Win-back',
    description:
      'Identifies a contact whose last completed visit is older than the configured interval, measured ' +
      'on BUSINESS DAYS, and tags them for the front desk. It sends nothing: no human has approved ' +
      'win-back copy and this build may not invent any.',
    trigger: {
      id: 'lapsed',
      event: 'manual',
      note:
        'Entered by the daily sweep. `manual` because FLOW_TRIGGER_EVENTS has no customer.lapsed - a ' +
        'contact becoming lapsed is a fact about an absence rather than an event anything emits.',
    },
    steps: {
      consented: conditionStep({
        test: { fact: 'has_marketing_consent', operator: 'is_true' },
        note:
          'Asked again HERE as well as in the sweep, because consent can be withdrawn between the two ' +
          'and the exit below is what records that we identified somebody and did not act.',
      }),
      flag: tagStep({
        tag: WINBACK_DUE_TAG,
        note:
          'A tag and not a message: there is no approved win-back copy. The day there is, the message ' +
          'node is one edge away.',
      }),
      done: exitStep({ reason: 'completed' }),
      not_eligible: exitStep({ reason: 'not_eligible' }),
    },
    edges: {
      'lapsed:default': 'consented',
      'consented:true': 'flag',
      'consented:false': 'not_eligible',
      'flag:default': 'done',
    },
  })
}

/**
 * The birthday journey.
 *
 * ```
 * manual ──▶ has marketing consent? ──true──▶ tag: birthday_today ──▶ exit (completed)
 *                                   ──false─▶ exit (not_eligible)
 * ```
 *
 * The journey reads NOTHING about a date of birth, and it could not: migration 0155 stores a day and a
 * month and there is no birth-year column anywhere in the schema, so there is no age for this journey or
 * anything downstream of it to derive. Whose birthday it is today is the sweep's query, and the sweep
 * reads two `smallint`s on `customer` — never the clinical schema, which is asserted by counting the
 * statements the pass issues rather than by reading the code.
 */
export function birthdayJourney(): FlowDefinition {
  return composeJourney({
    key: STOCK_JOURNEY_KEYS.birthday,
    title: 'Birthday',
    description:
      'Tags a contact whose recorded birth day and month are today. It knows the day and the month and ' +
      'cannot know the year: there is no birth-year column in this schema (0155). It sends nothing — ' +
      'no human has approved birthday copy.',
    trigger: {
      id: 'birthday',
      event: 'manual',
      note:
        'Entered by the daily sweep at the configured hour, inside the promotional window. `manual` ' +
        'because a birthday is a date arriving rather than something happening.',
    },
    steps: {
      consented: conditionStep({
        test: { fact: 'has_marketing_consent', operator: 'is_true' },
      }),
      flag: tagStep({
        tag: BIRTHDAY_TODAY_TAG,
        note: 'A tag and not a message, for the win-back journey’s reason: no approved copy exists.',
      }),
      done: exitStep({ reason: 'completed' }),
      not_eligible: exitStep({ reason: 'not_eligible' }),
    },
    edges: {
      'birthday:default': 'consented',
      'consented:true': 'flag',
      'consented:false': 'not_eligible',
      'flag:default': 'done',
    },
  })
}

/**
 * All three, or `null` when the review journey's template is not in the registry.
 *
 * `null` for the whole set rather than a shorter list, because a seed that wrote two of three would leave
 * a database in which the review journey simply does not exist, and nothing would say so. The registry
 * is `message_template`'s rows, so an empty one means the templates have not been seeded yet — which is
 * an ordering problem the loader must fix, not a state to carry on from.
 */
export function stockJourneys(
  templates: readonly FlowTemplateFact[],
): readonly FlowDefinition[] | null {
  const review = reviewSolicitationJourney(templates)
  if (review === null) return null
  return Object.freeze([review, winbackJourney(), birthdayJourney()])
}
