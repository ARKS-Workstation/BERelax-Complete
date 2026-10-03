import {
  LOW_INTERNAL_RATING_TAG,
  REVIEW_REQUEST_TEMPLATE_KEY,
  STOCK_JOURNEY_KEYS,
} from '@berelax/core'
import { enrolOnLiveVersion, type Sql, withUnitOfWork } from '@berelax/db'
import { enrolAll, TRIGGER_ACTOR, type TriggerOutcome } from './shared.ts'

/**
 * Who is due a review request: every appointment that COMPLETED and whose invoice is settled.
 *
 * C-AUTO-11. The acceptance line is *"enrols only on a COMPLETED and paid appointment, never on
 * CONFIRMED"*, and the eligibility is HERE rather than in the journey because `FLOW_CONDITION_FACTS`
 * has no fact about money — it holds consent, VIP, blocklist, lifecycle, tag, locale and a future
 * appointment, and none of them can answer "was this paid for". That is a finding about the DSL and is
 * recorded in `journeys.ts`; it is also the right half of the system for the decision in any case, since
 * a contact who was enrolled and then found ineligible has already had the engine's attention.
 *
 * ## Why both halves are in the WHERE clause rather than in TypeScript
 *
 * A pass that read every completed appointment and filtered in the application would be a pass whose
 * answer depends on how many rows it read, and the two conditions are exactly the two that would be
 * cheapest to drop. `status = 'completed'` excludes a no-show (`no_show`), a cancellation and —
 * critically — `confirmed`, which is the status the acceptance line names. `outstanding_fils <= 0` over
 * `invoice_settlement` is "paid": that view is the one reading of what an invoice still owes, and a
 * second subtraction here would be a second answer to it.
 *
 * ## Why the rating is a TAG and not a column
 *
 * The internal rating arrives out of band — nothing in this build collects one yet — and the journey
 * branches on `tag`, which the DSL does have. This module does not write the tag: whoever collects the
 * rating does, under {@link LOW_INTERNAL_RATING_TAG}, which is spelled once in `@berelax/core` because
 * a tag spelled two ways is a condition that silently never matches, and on this journey that means
 * every unhappy customer being sent the public review link.
 */

/** One contact the review journey is due for, and the appointment that earned it. */
export interface ReviewCandidate {
  readonly customerId: string
  readonly appointmentId: string
  /** The appointment's trading date. Named so a report can say which visit this was about. */
  readonly tradingDate: string
}

/**
 * Every contact with a completed, settled appointment in the window, as ONE query.
 *
 * `since` is the business day the pass last covered. A pass that scanned all history would re-offer
 * every visit the salon has ever taken on every run; `enrolOnLiveVersion` would answer
 * `already_enrolled` for most of them, so the result would be correct and the pass would get slower
 * every day.
 */
export async function readReviewCandidates(
  sql: Sql,
  args: { readonly sinceTradingDate: string; readonly untilTradingDate: string },
): Promise<readonly ReviewCandidate[]> {
  return sql<ReviewCandidate[]>`
    select distinct on (b.customer_id)
           b.customer_id as "customerId",
           a.id as "appointmentId",
           a.trading_date::text as "tradingDate"
      from appointment a
      join booking b on b.id = a.booking_id
      join invoice_appointment ia on ia.appointment_id = a.id
      join invoice_settlement s on s.invoice_id = ia.invoice_id
      join customer c on c.id = b.customer_id
     where a.status = 'completed'
       and s.outstanding_fils <= 0
       and c.erased_at is null
       and a.trading_date >= ${args.sinceTradingDate}::date
       and a.trading_date <= ${args.untilTradingDate}::date
     order by b.customer_id, a.trading_date desc
  `
}

/**
 * Enrol every eligible contact on the review journey.
 *
 * The flow key and the template key are read from `@berelax/core` rather than spelled here, so the
 * journey the seed publishes and the journey this enrols on cannot drift apart.
 */
export async function runReviewSolicitationTrigger(
  sql: Sql,
  args: {
    readonly sinceTradingDate: string
    readonly untilTradingDate: string
    readonly at: Date
  },
): Promise<TriggerOutcome> {
  const candidates = await readReviewCandidates(sql, args)
  return enrolAll(sql, {
    flowKey: STOCK_JOURNEY_KEYS.reviewSolicitation,
    customerIds: candidates.map((candidate) => candidate.customerId),
    at: args.at,
  })
}

/** The template the journey's public path is bound to. Re-exported so one import serves a caller. */
/** Exported for the sweep, which records the actor once for all three triggers. */
export {
  enrolOnLiveVersion,
  LOW_INTERNAL_RATING_TAG,
  REVIEW_REQUEST_TEMPLATE_KEY,
  TRIGGER_ACTOR,
  withUnitOfWork,
}
