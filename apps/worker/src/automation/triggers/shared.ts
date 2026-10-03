import {
  type Actor,
  enrolOnLiveVersion,
  flowRefusalOf,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'

/**
 * What the three stock-journey triggers share: the actor, the outcome shape and the enrolment loop.
 *
 * One loop rather than three, and the reason is the one `promotionalGateEvaluators` gives for being one
 * assembly: three copies of "enrol this list, tolerating a contact who is already running" is three
 * places for the tolerance to be written differently, and the difference would show up as a journey that
 * dead-letters a whole pass because one contact was enrolled yesterday.
 */

/** The actor a sweep's enrolments are recorded under. The SURFACE, stated rather than invented. */
export const TRIGGER_ACTOR: Actor = { kind: 'system', label: 'Stock journey triggers' }

export interface TriggerOutcome {
  readonly considered: number
  readonly enrolled: number
  /** Already running on this flow. An OUTCOME and not a failure — see `enrolOnLiveVersion`. */
  readonly alreadyEnrolled: number
  /** The flow is not active, or its cap is full. Named, because a silent zero reads as "nobody due". */
  readonly refused: readonly string[]
}

/**
 * Enrol a list, one transaction per contact.
 *
 * Per contact and not one transaction for the pass, deliberately: `enrolOnLiveVersion` takes the flow
 * row's lock, so a single transaction holding it for five thousand contacts would block every other
 * enrolment path — the pipeline board among them — for the length of the pass. And a pass that failed
 * half way would otherwise enrol nobody, which turns one unenrolable contact into a day with no
 * journeys entered at all.
 *
 * A flow-level refusal (`flow_not_active`, the per-flow cap) stops the pass for that flow rather than
 * being counted per contact, because it is the same answer for every remaining contact and a list of
 * five thousand identical refusals is a log nobody reads.
 */
export async function enrolAll(
  sql: Sql,
  args: {
    readonly flowKey: string
    readonly customerIds: readonly string[]
    readonly at: Date
  },
): Promise<TriggerOutcome> {
  let enrolled = 0
  let alreadyEnrolled = 0
  const refused: string[] = []

  for (const customerId of args.customerIds) {
    try {
      const result = await withUnitOfWork(sql, TRIGGER_ACTOR, (uow) =>
        enrolOnLiveVersion(uow, {
          flowKey: args.flowKey,
          customerId,
          createdBy: TRIGGER_ACTOR.label ?? 'Stock journey triggers',
          at: args.at,
        }),
      )
      if (result.outcome === 'enrolled') enrolled += 1
      else alreadyEnrolled += 1
    } catch (error) {
      const refusal = flowRefusalOf(error)
      if (refusal === null) throw error
      // Flow-level and the same for every remaining contact, so the pass stops for this flow and says
      // why once. A per-contact list of five thousand identical refusals is a log nobody reads.
      refused.push(refusal)
      break
    }
  }

  return { considered: args.customerIds.length, enrolled, alreadyEnrolled, refused }
}
