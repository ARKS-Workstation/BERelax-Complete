import type { DuplicateThresholds, DuplicateVerdict, LabelAgreement } from './duplicate-score.ts'
import { type PhoneAgreement, scoreDuplicatePair } from './duplicate-score.ts'
import type {
  CustomerMergeFieldPlan,
  CustomerMergeSubject,
  MergePlanRefusal,
} from './merge-plan.ts'
import { planCustomerMerge } from './merge-plan.ts'

/**
 * The duplicate review queue (C-CRM-06): the pairs a person is asked to look at, in the order they are
 * asked to look at them.
 *
 * The pure half of the staff surface. The database finds the candidates — that is
 * `packages/db/src/repositories/duplicate-candidates.ts`, and it is the database's job because only an
 * index can narrow 12.5 million pairs to a few — and the scorer decides how alike each one is. This is
 * what happens between those two and the screen, and every rule in it is a rule about what a reviewer is
 * shown rather than about similarity.
 *
 * ## Four things it does, and each one is a defect it prevents
 *
 *   1. **One row per PAIR, not per candidate.** The scan is run per record, so a duplicate pair is found
 *      twice — once from each side — and a queue built straight off the scan would ask the same question
 *      twice and let the second answer act on a record the first had already merged away.
 *   2. **Below the review threshold is not in the queue, and the PLAN is what says so.** C-CRM-02's
 *      floors are deliberately LOOSER than the scorer's boundaries, so the scan returns pairs the scorer
 *      calls `distinct` on purpose. They are candidates, not duplicates, and a queue that showed them
 *      would train a reviewer to skim. The test is not written here: every pair goes through
 *      {@link planCustomerMerge}, which refuses `distinct` under both authorities, so the screen cannot
 *      offer a pair the merge would then refuse. See {@link PLAN_REFUSAL_EXCLUSIONS}.
 *   3. **A tombstone is not a candidate for its own survivor.** This is C-CRM-05's NOTE (8c), deferred
 *      here by name: `findDuplicateCandidates` still returns a merged-away record, and left alone the
 *      queue would show every completed merge for ever, with a confirm button that answers
 *      `already_merged`. It is filtered HERE rather than in the scan because C-CRM-02's integration suite
 *      pins that query's EXPLAIN plan and its per-signal caps from both sides, and a `not exists` against
 *      `merge_record` inside it changes the plan.
 *   4. **The survivor is the plan's survivor.** {@link planCustomerMerge} decides it, and this module
 *      does not restate the rule. A queue that computed "earliest `created_at`" for itself would be a
 *      second statement of the survivor rule, and the first time they disagreed the screen would name one
 *      record and the merge would keep the other.
 *
 * ## The order is the score, and the tie-break is not decoration
 *
 * Descending score, then the survivor's id, then the loser's. A capped, unordered queue returns a
 * different set on two identical calls, and a reviewer working down a list that reshuffles under them
 * loses their place and re-reviews what they have already dismissed. The same argument
 * `findDuplicateCandidates` makes for its own `order by … , id asc`, one layer up.
 *
 * ## Counts, not silence
 *
 * Every pair this module drops is COUNTED and the counts travel with the rows
 * ({@link DuplicateQueue.excluded}). A queue is a filter over a search, and a filter whose output is
 * empty says nothing about which of the two found nothing: no candidates at all, every candidate below
 * the threshold, or every pair already merged are three different operational facts and only one of them
 * means the scan is misconfigured. The screen prints them for the same reason.
 */

/** One record as the queue takes it: the merge plan's subject, plus whether it is a tombstone. */
export interface DuplicateQueueRecord {
  readonly subject: CustomerMergeSubject
  /**
   * Whether this record was itself merged away.
   *
   * Supplied rather than derived: the fact lives in `merge_record`, which is a row in the database, and
   * this module reads nothing. `readMergedAwayCustomerIds` in `@berelax/db` is what answers it.
   */
  readonly isMergedAway: boolean
}

/** An unordered pair the candidate scan found. Which side probed is not information the queue keeps. */
export interface DuplicateQueueEdge {
  readonly aId: string
  readonly bId: string
}

export interface DuplicateQueueInput {
  readonly records: readonly DuplicateQueueRecord[]
  readonly edges: readonly DuplicateQueueEdge[]
  /**
   * The bands, injected, exactly as C-CRM-02 and C-CRM-05 pass them.
   *
   * `Y9-dedup-thresholds` is unanswered, so the owner's figures reach this screen by being passed in
   * rather than by this module knowing them. Omitted, the scorer's provisional pair applies.
   */
  readonly thresholds?: DuplicateThresholds
}

/** Why a pair the scan found is not in the queue. Counted rather than discarded silently. */
export const DUPLICATE_QUEUE_EXCLUSIONS = [
  /** Both ids are the same record. A self-join in the scan, or a probe that did not exclude itself. */
  'same_record',
  /** One of the two ids has no record in the input. The queue cannot score a record it cannot read. */
  'record_not_loaded',
  /** One of the two records was merged away. C-CRM-05's NOTE (8c). */
  'merged_away',
  /** The pair scores below the review threshold: a candidate, and not a duplicate. */
  'below_review_threshold',
  /** The plan refused the pair for a reason of its own. `refusals` names which. */
  'plan_refused',
] as const
export type DuplicateQueueExclusion = (typeof DUPLICATE_QUEUE_EXCLUSIONS)[number]

/**
 * Which exclusion each of the plan's refusals is reported as. Total over {@link MergePlanRefusal}.
 *
 * The queue does NOT test the threshold itself, and this map is why it does not have to. A pair below the
 * review band is refused by {@link planCustomerMerge} — under both authorities, which is the rule the
 * merge acts on — so the screen and the merge cannot disagree about which pairs are mergeable. A queue
 * with its own `verdict === 'distinct'` check would be a second statement of that rule, and the first
 * edit to the bands would move one of them.
 */
const PLAN_REFUSAL_EXCLUSIONS: Readonly<Record<MergePlanRefusal, DuplicateQueueExclusion>> =
  Object.freeze({
    merge_same_record: 'same_record',
    merge_verdict_is_distinct: 'below_review_threshold',
    // The three below cannot arise from this module: it passes `operator_confirmed` and nominates
    // nobody. Mapped rather than thrown, because a refusal a caller cannot see is a queue that is
    // quietly shorter than the scan, and a `default` branch would hide a refusal added later.
    merge_needs_an_operator: 'plan_refused',
    merge_survivor_not_in_the_pair: 'plan_refused',
    merge_nomination_needs_an_operator: 'plan_refused',
  })

export interface DuplicateQueueRow {
  /** The pair, canonically ordered, so one pair has one key whichever side the scan probed from. */
  readonly pairKey: string
  readonly survivor: CustomerMergeSubject
  readonly loser: CustomerMergeSubject
  /** The authoritative figure: a cell of `AGREEMENT_SCORES`. */
  readonly scorePerMille: number
  readonly verdict: DuplicateVerdict
  readonly phoneAgreement: PhoneAgreement
  readonly labelAgreement: LabelAgreement
  /** What the two records disagree about, from the plan. The reviewer's whole question. */
  readonly fields: readonly CustomerMergeFieldPlan[]
}

export interface DuplicateQueue {
  readonly rows: readonly DuplicateQueueRow[]
  /** Distinct pairs the scan found, before any of the four filters. The control on an empty queue. */
  readonly pairsConsidered: number
  readonly excluded: Readonly<Record<DuplicateQueueExclusion, number>>
  /** The plan refusals encountered, by name, so `plan_refused` is never a mystery. */
  readonly refusals: readonly MergePlanRefusal[]
}

/** `a|b` with the smaller id first: one pair, one key, whichever side probed. */
export function duplicatePairKey(left: string, right: string): string {
  return left <= right ? `${left}|${right}` : `${right}|${left}`
}

const noExclusions = (): Record<DuplicateQueueExclusion, number> => ({
  same_record: 0,
  record_not_loaded: 0,
  merged_away: 0,
  below_review_threshold: 0,
  plan_refused: 0,
})

/**
 * The queue, from the records the database loaded and the pairs its scan found.
 *
 * Total: every input produces a queue, and nothing throws. A pair that cannot be scored is counted under
 * the reason it could not be, because the alternative — dropping it — is the silence this module's header
 * argues against.
 *
 * The authority is `operator_confirmed` for every pair, and that is not a shortcut: this IS the review
 * queue, so by construction a person is looking at it. An `auto_merge` plan would refuse every pair in the
 * review band, which is most of the queue, and the rows would then be present with no plan behind them.
 * What the queue does NOT do is act on that authority — `previewCustomerMerge` and the confirm step are
 * where a person's decision is taken, and the provisional line on this unit is that no merge happens
 * without one.
 */
export function buildDuplicateQueue(input: DuplicateQueueInput): DuplicateQueue {
  const byId = new Map(input.records.map((record) => [record.subject.id, record]))
  const excluded = noExclusions()
  const refusals: MergePlanRefusal[] = []
  const seen = new Set<string>()
  const rows: DuplicateQueueRow[] = []
  let pairsConsidered = 0

  for (const edge of input.edges) {
    const pairKey = duplicatePairKey(edge.aId, edge.bId)
    // The de-duplication, and it happens BEFORE the counters: a pair found from both sides is one pair
    // considered once, or `pairsConsidered` would report the scan's row count rather than the queue's
    // question count and the exclusion tallies would double.
    if (seen.has(pairKey)) continue
    seen.add(pairKey)
    pairsConsidered += 1

    const left = byId.get(edge.aId)
    const right = byId.get(edge.bId)
    if (left === undefined || right === undefined) {
      excluded.record_not_loaded += 1
      continue
    }
    if (left.isMergedAway || right.isMergedAway) {
      excluded.merged_away += 1
      continue
    }

    const score = scoreDuplicatePair(
      { phone: left.subject.phoneE164, label: left.subject.displayName },
      { phone: right.subject.phoneE164, label: right.subject.displayName },
      input.thresholds,
    )
    const decision = planCustomerMerge(left.subject, right.subject, score, 'operator_confirmed')
    if (decision.kind !== 'plan') {
      excluded[PLAN_REFUSAL_EXCLUSIONS[decision.refusal]] += 1
      if (!refusals.includes(decision.refusal)) refusals.push(decision.refusal)
      continue
    }
    // Read back off the plan rather than chosen here: see the header's fourth point.
    const survivor = decision.survivorId === left.subject.id ? left.subject : right.subject
    const loser = decision.loserId === left.subject.id ? left.subject : right.subject
    rows.push({
      pairKey,
      survivor,
      loser,
      scorePerMille: score.scorePerMille,
      verdict: score.verdict,
      phoneAgreement: score.phone,
      labelAgreement: score.label,
      fields: decision.fields,
    })
  }

  rows.sort(
    (left, right) =>
      right.scorePerMille - left.scorePerMille ||
      left.survivor.id.localeCompare(right.survivor.id) ||
      left.loser.id.localeCompare(right.loser.id),
  )

  return { rows, pairsConsidered, excluded, refusals }
}
