import type { Sql } from '../connection.ts'
import { type DuplicateCandidateOptions, findDuplicateCandidates } from './duplicate-candidates.ts'
import {
  type CustomerMergeSubjectRead,
  readCustomerMergeSubjects,
  readMergedAwayCustomerIds,
} from './merge.ts'

/**
 * The reads behind the duplicate review queue (C-CRM-06): which records to probe, what the scan found,
 * and which of them are tombstones.
 *
 * The queue itself is `buildDuplicateQueue` in `@berelax/core` — it scores, de-duplicates and orders — and
 * this file hands it data. `packages/db` may not import `packages/core`, so nothing here scores anything;
 * the split is C-CRM-02's, stated at the top of `duplicate-candidates.ts`, and this is the read half of
 * the "C-CRM-05's review queue tomorrow" the comment there names.
 *
 * ## Why the probe runs per record and not as one self-join
 *
 * A single query pairing the table with itself over the trigram indexes would be one round trip, and it
 * would also be a SECOND definition of the candidate scan. C-CRM-02's integration suite pins
 * `findDuplicateCandidates`' EXPLAIN plan and both of its per-signal caps, and the caps are the part that
 * cannot be expressed in a join at all: the label signal is intrinsically unselective in this system
 * (every label is `Customer NNNN`, ADR 0020, so they all share the word `customer`), and a shared cap
 * across the two signals dropped a real duplicate — the comment on `candidateQuery` records it. So the
 * queue calls the scan the suite pins, once per record, and accepts the round trips.
 *
 * ## Why the probe set is bounded, and what the bound costs
 *
 * `subjectLimit` caps how many records are probed, newest first. The scan is O(records) round trips and a
 * review queue is read by a person, so an unbounded pass over a growing table is a page that gets slower
 * for ever. Newest first because a duplicate is created by a record being created: the pair this screen
 * exists to catch is minutes old, not years.
 *
 * The bound is stated rather than hidden, and it is the reason {@link DuplicateQueueScan.recordsProbed} is
 * reported: a queue over the newest 100 records of 5,000 is not a queue over the database, and a screen
 * that did not say so would read as "there are no duplicates".
 *
 * ## Scoping, and why it exists at all
 *
 * `customerIds` narrows the whole pass to a named set — both the records probed and the candidates kept.
 * It is what the integration and Playwright suites assert through, for brief rule 12's reason: the
 * integration suite runs sequentially against ONE database and earlier files leave rows behind, so a test
 * that asserted the contents of the whole queue would pass until another unit seeded a customer. The same
 * instrument `/compliance` uses with `?key=`.
 */

export interface DuplicateQueueScanOptions {
  /**
   * Probe and keep only these records. Omitted, the newest `subjectLimit` records are probed.
   *
   * Candidates OUTSIDE the set are dropped rather than loaded, which is what makes a scoped queue a
   * statement about the set: a pair with one foot outside it would otherwise appear from one side only.
   */
  readonly customerIds?: readonly string[]
  readonly subjectLimit?: number
  /** Passed through to `findDuplicateCandidates` — the floors and the per-signal cap. */
  readonly candidateOptions?: DuplicateCandidateOptions
}

export interface DuplicateQueueScan {
  /** Every record either side of any pair, loaded once, in id order. */
  readonly records: readonly {
    readonly subject: CustomerMergeSubjectRead
    readonly isMergedAway: boolean
  }[]
  /** The unordered pairs the scan found, as (probe, candidate). Duplicated pairs are the queue's to fold. */
  readonly edges: readonly { readonly aId: string; readonly bId: string }[]
  /** How many records were probed. Below the table's size when the bound bit — see the header. */
  readonly recordsProbed: number
  /** How many scans were issued, which is the work this read did. Asserted instead of a wall clock. */
  readonly scansIssued: number
  /** True when `subjectLimit` cut the probe set short, so the screen can say the queue is partial. */
  readonly bounded: boolean
}

/**
 * The bound, and it is a default rather than a policy.
 *
 * 100 records is 100 candidate scans, each of which is two index lookups and a cap of 50 rows per signal.
 * It is a figure to revisit with a real table and no measurement here pretends otherwise; what it is NOT
 * is silent, because {@link DuplicateQueueScan.bounded} says when it bit.
 */
export const DUPLICATE_QUEUE_SUBJECT_LIMIT = 100

interface ProbeRow {
  readonly id: string
  readonly phone_match_key: string | null
  readonly label_key: string | null
}

/**
 * The records to probe: a named set, or the newest ones.
 *
 * `split_part(name_match_key, ':', 1)` is the folded label WITHOUT its `:last-4` tail, which is exactly
 * what `DuplicateCandidateProbe.labelKey` asks for — 0055 stores the tail in the column and the scan
 * strips it on both sides, so stripping it here is agreeing with the scan rather than duplicating it.
 */
async function probeRows(
  sql: Sql,
  options: DuplicateQueueScanOptions,
): Promise<readonly ProbeRow[]> {
  const limit = options.subjectLimit ?? DUPLICATE_QUEUE_SUBJECT_LIMIT
  if (options.customerIds !== undefined) {
    return await sql<ProbeRow[]>`
      select id::text as id, phone_match_key,
             split_part(name_match_key, ':', 1) as label_key
        from customer where id = any(${[...options.customerIds]}::uuid[])
        order by created_at, id
    `
  }
  return await sql<ProbeRow[]>`
    select id::text as id, phone_match_key,
           split_part(name_match_key, ':', 1) as label_key
      from customer
      order by created_at desc, id
      limit ${limit}
  `
}

/**
 * Probes each record in scope and returns the pairs found, with every record either side loaded.
 *
 * Two passes over the ids, deliberately. The scan names candidates that may be OUTSIDE the probe set — an
 * older record the bound did not reach is exactly the pair worth showing — so the records are loaded from
 * the union of both ends afterwards rather than from the probe set. A queue built from the probe set alone
 * would silently drop every pair that reached back past the bound, which is the majority of them.
 */
export async function scanDuplicateQueue(
  sql: Sql,
  options: DuplicateQueueScanOptions = {},
): Promise<DuplicateQueueScan> {
  const limit = options.subjectLimit ?? DUPLICATE_QUEUE_SUBJECT_LIMIT
  const probes = await probeRows(sql, options)
  const inScope = options.customerIds === undefined ? null : new Set(options.customerIds)

  const edges: { aId: string; bId: string }[] = []
  const mentioned = new Set<string>()
  let scansIssued = 0

  for (const probe of probes) {
    mentioned.add(probe.id)
    const phoneMatchKey = probe.phone_match_key ?? null
    const labelKey = probe.label_key === null || probe.label_key === '' ? null : probe.label_key
    // A record with neither key has no candidates BY CONSTRUCTION, and `findDuplicateCandidates` refuses
    // an empty probe by name rather than answering "none found" — which is the distinction it exists to
    // make. Skipping it here is agreeing with that refusal, not working around it.
    if (phoneMatchKey === null && labelKey === null) continue

    const candidates = await findDuplicateCandidates(
      sql,
      { phoneMatchKey, labelKey, excludeCustomerId: probe.id },
      options.candidateOptions ?? {},
    )
    scansIssued += 1
    for (const candidate of candidates) {
      if (inScope !== null && !inScope.has(candidate.customerId)) continue
      mentioned.add(candidate.customerId)
      edges.push({ aId: probe.id, bId: candidate.customerId })
    }
  }

  const ids = [...mentioned]
  const subjects = await readCustomerMergeSubjects(sql, ids)
  const tombstones = await readMergedAwayCustomerIds(sql, ids)

  return {
    records: subjects.map((subject) => ({ subject, isMergedAway: tombstones.has(subject.id) })),
    edges,
    recordsProbed: probes.length,
    scansIssued,
    bounded: options.customerIds === undefined && probes.length >= limit,
  }
}
