import { describe, expect, it } from 'vitest'
import type { Instant } from '../time.ts'
import { instantFromIso } from '../time.ts'
import {
  buildDuplicateQueue,
  DUPLICATE_QUEUE_EXCLUSIONS,
  type DuplicateQueueRecord,
  duplicatePairKey,
} from './duplicate-queue.ts'
import { PROVISIONAL_DUPLICATE_THRESHOLDS, scoreDuplicatePair } from './duplicate-score.ts'
import type { CustomerMergeSubject } from './merge-plan.ts'

/**
 * C-CRM-06's pure half: one row per pair, ordered by score, with three kinds of pair kept out.
 *
 * Every score here comes from `scoreDuplicatePair` over real fixture numbers rather than from a
 * hand-built figure, for the reason `merge-plan.test.ts` states: a written-in score can claim a band
 * C-CRM-02's table cannot produce, and then a test of "below the threshold is excluded" would be about
 * nothing. The numbers are on the unallocated `+971 59` prefix and every label is `Customer NNNN`
 * (ADR 0020) — nothing here is a name.
 */

const AT = (iso: string): Instant => instantFromIso(iso)

const ID = (tail: string): string => `00000000-0000-7000-8000-0000000${tail}`

/** The four fixture records. `a`/`b` are one digit apart and share a label: 900, review. */
const A = ID('0c6a01')
const B = ID('0c6a02')
/** `c`/`d` hold unrelated numbers and share a label: 710, review — the SIM-change shape. */
const C = ID('0c6b01')
const D = ID('0c6b02')
/** `e`/`f` are one digit apart with labels one character apart: 640, below the review threshold. */
const E = ID('0c6c01')
const F = ID('0c6c02')

const subject = (over: Partial<CustomerMergeSubject> & { id: string }): CustomerMergeSubject => ({
  createdAt: AT('2026-01-01T08:00:00.000Z'),
  phoneE164: '+971590009601',
  displayName: null,
  nameMatchKey: null,
  locale: 'en',
  notes: null,
  createdVia: 'front_desk',
  phoneVerifiedAt: null,
  ...over,
})

const record = (
  subjectValue: CustomerMergeSubject,
  isMergedAway = false,
): DuplicateQueueRecord => ({ subject: subjectValue, isMergedAway })

const RECORDS: readonly DuplicateQueueRecord[] = [
  record(
    subject({
      id: A,
      createdAt: AT('2025-02-03T08:00:00.000Z'),
      phoneE164: '+971590009601',
      displayName: 'Customer 9601',
    }),
  ),
  record(
    subject({
      id: B,
      createdAt: AT('2026-04-05T08:00:00.000Z'),
      phoneE164: '+971590009602',
      displayName: 'Customer 9601',
    }),
  ),
  record(
    subject({
      id: C,
      createdAt: AT('2025-06-07T08:00:00.000Z'),
      phoneE164: '+971590009611',
      displayName: 'Customer 9611',
    }),
  ),
  record(
    subject({
      id: D,
      createdAt: AT('2026-08-09T08:00:00.000Z'),
      phoneE164: '+971590009622',
      displayName: 'Customer 9611',
    }),
  ),
  record(subject({ id: E, phoneE164: '+971590009631', displayName: 'Customer 9631' })),
  record(subject({ id: F, phoneE164: '+971590009632', displayName: 'Customer 9641' })),
]

const scoreOf = (left: string, right: string): number =>
  scoreDuplicatePair(
    {
      phone: RECORDS.find((r) => r.subject.id === left)?.subject.phoneE164 ?? null,
      label: RECORDS.find((r) => r.subject.id === left)?.subject.displayName ?? null,
    },
    {
      phone: RECORDS.find((r) => r.subject.id === right)?.subject.phoneE164 ?? null,
      label: RECORDS.find((r) => r.subject.id === right)?.subject.displayName ?? null,
    },
  ).scorePerMille

describe('the fixture pairs really do land where this file says they do', () => {
  it('scores 900 for the near-miss pair, 710 for the SIM change and 640 for the pair below the band', () => {
    // The control on the whole file. Every assertion below depends on these three cells, and a test
    // whose fixtures had drifted into one band would still pass most of them.
    expect(scoreOf(A, B)).toBe(900)
    expect(scoreOf(C, D)).toBe(710)
    expect(scoreOf(E, F)).toBe(640)
    expect(PROVISIONAL_DUPLICATE_THRESHOLDS.review * 1000).toBe(700)
  })
})

describe('one row per pair', () => {
  it('asks the same question once when the scan found the pair from both sides', () => {
    const queue = buildDuplicateQueue({
      records: RECORDS,
      edges: [
        { aId: A, bId: B },
        { aId: B, bId: A },
      ],
    })
    expect(queue.rows).toHaveLength(1)
    expect(queue.pairsConsidered).toBe(1)
    // The control: two DIFFERENT pairs are two rows, so the de-duplication is on the pair and not on
    // "the first edge wins".
    const two = buildDuplicateQueue({
      records: RECORDS,
      edges: [
        { aId: A, bId: B },
        { aId: C, bId: D },
      ],
    })
    expect(two.rows).toHaveLength(2)
    expect(two.pairsConsidered).toBe(2)
  })

  it('keys a pair the same way whichever side is named first', () => {
    expect(duplicatePairKey(A, B)).toBe(duplicatePairKey(B, A))
    expect(duplicatePairKey(A, B)).toBe(`${A}|${B}`)
    // Equal ids are their own key rather than an error: the `same_record` exclusion is what reports it.
    expect(duplicatePairKey(A, A)).toBe(`${A}|${A}`)
  })
})

describe('the order a reviewer works down', () => {
  it('is descending score, then the survivor id, then the loser id', () => {
    const queue = buildDuplicateQueue({
      records: RECORDS,
      edges: [
        { aId: C, bId: D },
        { aId: A, bId: B },
      ],
    })
    expect(queue.rows.map((row) => row.scorePerMille)).toEqual([900, 710])
    // The edges arrived in the other order, so this is the sort and not the input order.
    expect(queue.rows[0]?.survivor.id).toBe(A)
    expect(queue.rows[1]?.survivor.id).toBe(C)
  })

  it('breaks an equal score on the ids, so two identical calls return the same list', () => {
    // Two pairs with the SAME score, which is what a tie-break has to be tested against.
    const g = ID('0c6d01')
    const h = ID('0c6d02')
    const records = [
      ...RECORDS,
      record(
        subject({
          id: g,
          createdAt: AT('2025-01-01T08:00:00.000Z'),
          phoneE164: '+971590009701',
          displayName: 'Customer 9701',
        }),
      ),
      record(
        subject({
          id: h,
          createdAt: AT('2026-01-01T08:00:00.000Z'),
          phoneE164: '+971590009702',
          displayName: 'Customer 9701',
        }),
      ),
    ]
    const edges = [
      { aId: g, bId: h },
      { aId: A, bId: B },
    ]
    const first = buildDuplicateQueue({ records, edges })
    const second = buildDuplicateQueue({ records, edges: [...edges].reverse() })
    expect(first.rows.map((row) => row.scorePerMille)).toEqual([900, 900])
    expect(first.rows.map((row) => row.pairKey)).toEqual(second.rows.map((row) => row.pairKey))
    // A is the smaller id, so it sorts first. The control: the two survivors differ, or an equal-score
    // pair would satisfy this assertion whatever the comparator did.
    expect(first.rows[0]?.survivor.id).toBe(A)
    expect(first.rows[1]?.survivor.id).toBe(g)
  })
})

describe('what is kept out, and counted', () => {
  it('excludes a pair below the review threshold and says so', () => {
    const queue = buildDuplicateQueue({ records: RECORDS, edges: [{ aId: E, bId: F }] })
    expect(queue.rows).toEqual([])
    expect(queue.pairsConsidered).toBe(1)
    expect(queue.excluded.below_review_threshold).toBe(1)
    // The plan is what refused it, which is the point: the queue runs no threshold test of its own.
    expect(queue.refusals).toEqual(['merge_verdict_is_distinct'])
    // The control: the SAME pair is in the queue under a review threshold the owner lowered, so the
    // exclusion is the threshold's doing and not the pair being unscorable. Y9-dedup-thresholds is
    // exactly this question, which is why the bands are injected.
    const lowered = buildDuplicateQueue({
      records: RECORDS,
      edges: [{ aId: E, bId: F }],
      thresholds: { autoMerge: 0.95, review: 0.6 },
    })
    expect(lowered.rows.map((row) => row.scorePerMille)).toEqual([640])
    expect(lowered.excluded.below_review_threshold).toBe(0)
  })

  it('excludes a pair either side of which was merged away', () => {
    const withTombstone = RECORDS.map((entry) =>
      entry.subject.id === B ? record(entry.subject, true) : entry,
    )
    const queue = buildDuplicateQueue({
      records: withTombstone,
      edges: [
        { aId: A, bId: B },
        { aId: C, bId: D },
      ],
    })
    // C-CRM-05's NOTE (8c): without this the completed merge is in the queue for ever.
    expect(queue.rows.map((row) => row.pairKey)).toEqual([duplicatePairKey(C, D)])
    expect(queue.excluded.merged_away).toBe(1)
    // And the SURVIVOR side, not only the loser side: a record merged INTO another is a tombstone too
    // once it is merged onward, and a queue that only filtered one side would show half of them.
    const otherSide = buildDuplicateQueue({
      records: RECORDS.map((entry) =>
        entry.subject.id === A ? record(entry.subject, true) : entry,
      ),
      edges: [{ aId: A, bId: B }],
    })
    expect(otherSide.rows).toEqual([])
    expect(otherSide.excluded.merged_away).toBe(1)
  })

  it('excludes an edge whose record was not loaded, rather than scoring half a pair', () => {
    const queue = buildDuplicateQueue({
      records: RECORDS.filter((entry) => entry.subject.id !== B),
      edges: [{ aId: A, bId: B }],
    })
    expect(queue.rows).toEqual([])
    expect(queue.excluded.record_not_loaded).toBe(1)
  })

  it('excludes a self-edge, named by the refusal the plan gave', () => {
    // A self-edge is a self-join in the scan or a probe that did not exclude itself, and it scores 1000
    // against itself — so nothing but the plan's own refusal keeps it out of the auto band.
    const queue = buildDuplicateQueue({ records: RECORDS, edges: [{ aId: A, bId: A }] })
    expect(queue.rows).toEqual([])
    expect(queue.excluded.same_record).toBe(1)
    expect(queue.refusals).toEqual(['merge_same_record'])
  })

  it('tallies every exclusion reason under the name the vocabulary gives it', () => {
    const queue = buildDuplicateQueue({
      records: RECORDS,
      edges: [
        { aId: A, bId: A },
        { aId: E, bId: F },
        { aId: A, bId: B },
      ],
    })
    // Every exclusion reason is spelled the same way in the tally as in the vocabulary, so a reason
    // added to one and not the other cannot pass unnoticed.
    expect(Object.keys(queue.excluded).sort()).toEqual([...DUPLICATE_QUEUE_EXCLUSIONS].sort())
    expect(queue.pairsConsidered).toBe(3)
    expect(queue.rows).toHaveLength(1)
    // A refusal is listed once however many pairs it refused, so the list reads as reasons rather than
    // as a tally that disagrees with `excluded`.
    expect([...queue.refusals].sort()).toEqual(['merge_same_record', 'merge_verdict_is_distinct'])
  })

  it('reports an empty queue as three different facts', () => {
    // The whole reason the counters exist. All three of these render as "nothing to review", and only
    // one of them means the scan is misconfigured.
    const nothingFound = buildDuplicateQueue({ records: RECORDS, edges: [] })
    expect(nothingFound.pairsConsidered).toBe(0)
    const allBelow = buildDuplicateQueue({ records: RECORDS, edges: [{ aId: E, bId: F }] })
    expect(allBelow.pairsConsidered).toBe(1)
    expect(allBelow.excluded.below_review_threshold).toBe(1)
    const allMerged = buildDuplicateQueue({
      records: RECORDS.map((entry) =>
        entry.subject.id === B ? record(entry.subject, true) : entry,
      ),
      edges: [{ aId: A, bId: B }],
    })
    expect(allMerged.excluded.merged_away).toBe(1)
    for (const queue of [nothingFound, allBelow, allMerged]) expect(queue.rows).toEqual([])
  })
})

describe('the survivor on the screen is the survivor of the merge', () => {
  it('is the plan’s survivor, which is the earlier record', () => {
    const queue = buildDuplicateQueue({ records: RECORDS, edges: [{ aId: B, bId: A }] })
    const row = queue.rows[0]
    expect(row?.survivor.id).toBe(A)
    expect(row?.loser.id).toBe(B)
    // The control: A really is the earlier record AND the larger id would not have chosen it, so this
    // is the instant and not an id comparison that happens to agree.
    expect(row?.survivor.createdAt).toBeLessThan(row?.loser.createdAt ?? 0)
  })

  it('carries the fields the two records disagree about', () => {
    const queue = buildDuplicateQueue({ records: RECORDS, edges: [{ aId: A, bId: B }] })
    const fields = queue.rows[0]?.fields ?? []
    // The number is the one thing a merge can never transfer (customer.phone_e164 is UNIQUE), and the
    // reviewer has to see both numbers to decide — so it is on every plan.
    const phone = fields.find((field) => field.field === 'phoneE164')
    expect(phone?.resolution).toBe('not_transferable')
    expect(phone?.survivorValue).toBe('+971590009601')
    expect(phone?.loserValue).toBe('+971590009602')
    expect(fields.length).toBeGreaterThan(1)
  })

  it('carries both agreement cells, so a reviewer can see WHICH signal matched', () => {
    const queue = buildDuplicateQueue({
      records: RECORDS,
      edges: [
        { aId: A, bId: B },
        { aId: C, bId: D },
      ],
    })
    expect(queue.rows[0]?.phoneAgreement).toBe('one_digit_apart')
    expect(queue.rows[0]?.labelAgreement).toBe('identical')
    // The SIM-change pair: the label is what matched and the numbers are unrelated. A single score
    // cannot say that, which is why merge_record stores both cells and the queue prints both.
    expect(queue.rows[1]?.phoneAgreement).toBe('different')
    expect(queue.rows[1]?.labelAgreement).toBe('identical')
    expect(queue.rows.map((row) => row.verdict)).toEqual(['review', 'review'])
  })
})
