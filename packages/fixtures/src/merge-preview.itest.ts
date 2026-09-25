import {
  buildDuplicateQueue,
  type ConsentLog,
  type ConsentRecord,
  type CustomerMergeSubject,
  type DuplicateQueueRecord,
  duplicatePairKey,
  type Instant,
  planCustomerMerge,
  resolveConsent,
  scoreDuplicatePair,
} from '@berelax/core'
import {
  type Actor,
  type ConsentLogRead,
  type CustomerMergePlanInput,
  createConnection,
  type DuplicateQueueScan,
  MERGE_AUDIT_ACTIONS,
  MERGE_PARTICIPANTS,
  MERGE_UNDER_PREVIEW,
  mergeCustomers,
  mergeRefusalOf,
  mergeRowCounts,
  previewCustomerMerge,
  readConsentLog,
  readCustomerMergeSubject,
  readCustomerMergeSubjects,
  readMergedAwayCustomerIds,
  type Sql,
  scanDuplicateQueue,
  type UnitOfWork,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DUPLICATE_QUEUE_FIXTURE_INSTANTS,
  DUPLICATE_QUEUE_FIXTURE_TAGS,
  type SeededDuplicateQueueFixture,
  seedDuplicateQueueFixture,
} from './duplicate-queue.ts'

/**
 * C-CRM-06 — the review queue and the merge preview, against a real PostgreSQL.
 *
 * `packages/fixtures` is the only package that may import both halves, and this unit needs it twice over:
 * the queue is `@berelax/core`'s `buildDuplicateQueue` over `@berelax/db`'s scan, and the preview's central
 * claim is about a consent state that only `resolveConsent` — in core — can compute from rows only the
 * database holds.
 *
 * ## The claim this file exists for
 *
 * A preview must be computed by the same code that performs the merge, or it is a different answer wearing
 * the same label. That is asserted three ways, and none of them is sufficient alone:
 *
 *   1. **By reference.** `MERGE_UNDER_PREVIEW` IS `mergeCustomers` — the function object, not a
 *      re-implementation that agrees today.
 *   2. **By effect, inside.** The preview reports what it wrote (`wouldWrite`), counted from inside its own
 *      transaction. Zero there is a preview that performed no merge.
 *   3. **By absence, outside.** Every count and every per-table row count is unchanged afterwards. 0069's
 *      repository inserts `merge_record` BEFORE it moves a row — deliberately, because that unique index is
 *      where two concurrent merges serialise — so a preview that reused the merge path without a rollback
 *      would tombstone a customer nobody approved merging.
 *
 * Claims 2 and 3 are opposite directions of one thing, and a preview that cheated would fail one of them:
 * skip the merge and (2) reads zero; commit it and (3) moves.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind (brief
 * rule 12), so every queue assertion narrows through `customerIds` — the same instrument `/compliance` uses
 * with `?key=`. The fixture pairs are ensured rather than assumed, because `customer-identity.itest.ts`
 * clears the whole `customer` table between its cases.
 *
 * **Nothing here commits a merge.** A merge is not repeatable: `merge_record_one_merge_per_loser` makes the
 * second attempt `already_merged` and the copied consent rows cannot be removed, so a file that committed
 * one would pass once against a fresh database and answer `already_merged` for ever after. The two consent
 * rows the fixture needs ARE committed, at fixed instants, which makes them idempotent — `recordConsent` is
 * idempotent on (contact, channel, purpose, kind, instant) and reports `recorded: false` for a repeat.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const MARKER = 'ccrm06 duplicate queue itest'
const ACTOR: Actor = { kind: 'staff', label: 'Manager (fixture)' }

/**
 * Fixed instants. Nothing here reads a wall clock, and the orderings are readable.
 *
 * The two consent instants and the instant the log is resolved at come from the shared fixture, because
 * `apps/web/src/duplicates.itest.ts` resolves the same log and the answer depends on WHEN — see
 * `DUPLICATE_QUEUE_FIXTURE_INSTANTS`.
 */
const MERGED_AT = '2099-09-26T10:00:00.000Z'
const RESOLVED_AT = DUPLICATE_QUEUE_FIXTURE_INSTANTS.resolveAt

const MERGE_ARGS = {
  mergedAtIso: MERGED_AT,
  reason: 'One person, two records: the same handset was entered twice at the front desk.',
  actorKind: 'staff',
  actorLabel: 'Manager (fixture)',
} as const

let sql: Sql
let fixture: SeededDuplicateQueueFixture

const ROLLBACK = 'ccrm06 rollback'

/** Runs a body inside ONE real unit of work that is ALWAYS rolled back, carrying its answer out. */
async function probe<T>(body: (p: { tx: Sql; uow: UnitOfWork }) => Promise<T>): Promise<T> {
  let carried: T | undefined
  try {
    await withUnitOfWork(sql, ACTOR, async (uow) => {
      carried = await body({ tx: uow.sql, uow })
      throw new Error(ROLLBACK)
    })
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ROLLBACK) throw err
  }
  return carried as T
}

const raised = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => null,
    (err: unknown) => err,
  )

const at = (iso: string): Instant => Date.parse(iso) as Instant

/**
 * The scan's records in the shape the pure queue takes.
 *
 * `createdAt` is epoch milliseconds on both sides of the boundary and `Instant` is the brand core puts on
 * that number, so this is a brand and not a conversion — the same narrowing `asConsentLog` does for the
 * consent log, and the agreement is what `merge.itest.ts` asserts with `satisfies`.
 */
function asQueueRecords(
  records: DuplicateQueueScan['records'],
  isMergedAway: (id: string) => boolean = () => false,
): readonly DuplicateQueueRecord[] {
  return records.map((entry) => ({
    subject: entry.subject as CustomerMergeSubject,
    isMergedAway: isMergedAway(entry.subject.id) || entry.isMergedAway,
  }))
}

/**
 * The db read, narrowed to the resolver's own type.
 *
 * `recordedAt` is a plain `number` on the db side — that package may not import core's `Instant` brand — so
 * the cast is unavoidable, and the membership assertions are what make it honest rather than hopeful. The
 * arrangement `consent.itest.ts` and `merge.itest.ts` both use.
 */
function asConsentLog(read: ConsentLogRead): ConsentLog {
  for (const record of read.records) {
    expect(['granted', 'withdrawn'], 'kind is a label core knows').toContain(record.kind)
    expect(Number.isFinite(record.recordedAt), `${record.id} has a finite instant`).toBe(true)
  }
  return {
    contactId: read.contactId,
    records: read.records.map(
      (record): ConsentRecord => ({ ...record, recordedAt: record.recordedAt as Instant }),
    ),
    wordingVersions: read.wordingVersions,
  }
}

const marketingState = (log: ConsentLogRead): string =>
  resolveConsent(asConsentLog(log), 'sms', 'marketing', at(RESOLVED_AT)).state

async function subjectOf(tx: Sql, id: string): Promise<CustomerMergeSubject> {
  const subject = await readCustomerMergeSubject(tx, id)
  if (subject === null) throw new Error(`the fixture customer ${id} is missing`)
  return subject as CustomerMergeSubject
}

/**
 * The plan for the near-miss pair, from the real scorer and the real planner.
 *
 * `nominatedSurvivorId` is how the swap is asked for, which is C-CRM-05's NOTE (10) — "authority
 * operator_confirmed nominates the survivor explicitly" — exercised for the first time here.
 */
async function planFor(
  tx: Sql,
  pair: { survivorId: string; loserId: string },
  nominatedSurvivorId?: string,
): Promise<CustomerMergePlanInput> {
  const a = await subjectOf(tx, pair.survivorId)
  const b = await subjectOf(tx, pair.loserId)
  const score = scoreDuplicatePair(
    { phone: a.phoneE164, label: a.displayName },
    { phone: b.phoneE164, label: b.displayName },
  )
  const decision = planCustomerMerge(
    a,
    b,
    score,
    'operator_confirmed',
    nominatedSurvivorId === undefined ? {} : { nominatedSurvivorId },
  )
  if (decision.kind !== 'plan') throw new Error(`the fixture pair was refused: ${decision.refusal}`)
  return decision satisfies CustomerMergePlanInput
}

async function countIn(tx: Sql, statement: Promise<{ n: string }[]>): Promise<number> {
  void tx
  const [row] = await statement
  return Number(row?.n ?? '0')
}

/** The three counts a committed merge would move. Deltas only: every one of these tables only grows. */
async function writeFootprint(
  tx: Sql,
  loserId: string,
): Promise<{ records: number; tables: number; audits: number }> {
  return {
    records: await countIn(
      tx,
      tx<{ n: string }[]>`
        select count(*)::text as n from merge_record where loser_customer_id = ${loserId}::uuid
      `,
    ),
    tables: await countIn(
      tx,
      tx<{ n: string }[]>`
        select count(*)::text as n from merge_record_table t
          join merge_record r on r.id = t.merge_record_id
         where r.loser_customer_id = ${loserId}::uuid
      `,
    ),
    audits: await countIn(
      tx,
      tx<{ n: string }[]>`
        select count(*)::text as n from audit_event
         where action = ${MERGE_AUDIT_ACTIONS.merged} and entity_id = ${loserId}
      `,
    ),
  }
}

/** Every participant's row count for both records of a pair, as one comparable object. */
async function pairRowCounts(
  tx: Sql,
  pair: { survivorId: string; loserId: string },
): Promise<Record<string, number>> {
  const survivor = await mergeRowCounts(tx, pair.survivorId)
  const loser = await mergeRowCounts(tx, pair.loserId)
  const counts: Record<string, number> = {}
  for (const [name, n] of survivor) counts[`survivor:${name}`] = n
  for (const [name, n] of loser) counts[`loser:${name}`] = n
  return counts
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  fixture = await seedDuplicateQueueFixture(sql, MARKER)
}, 120_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

// ------------------------------------------------------------------------------------------------
// The preview is the merge
// ------------------------------------------------------------------------------------------------

describe('the preview is computed by the merge itself', () => {
  it('runs the merge function by reference, not a second implementation of it', () => {
    // The assertion the unit turns on. Two functions that agree today is exactly the evidence a preview
    // which has since drifted also produces, so the agreement is an identity rather than a comparison.
    expect(MERGE_UNDER_PREVIEW).toBe(mergeCustomers)
  })

  it('reports from INSIDE that it wrote the merge, and leaves nothing behind OUTSIDE', async () => {
    const pair = fixture.nearMiss
    const before = await writeFootprint(sql, pair.loserId)
    const rowsBefore = await pairRowCounts(sql, pair)

    const plan = await planFor(sql, pair)
    const preview = await previewCustomerMerge(sql, { ...MERGE_ARGS, plan })
    if (preview.kind !== 'preview') throw new Error(`expected a preview, got ${preview.kind}`)

    // (2) From inside: the merge really happened. A preview that quietly performed no merge — because it
    // described the work instead of doing it — reports zeros here.
    expect(preview.wouldWrite.mergeRecords, 'a merge_record would be written').toBe(1)
    expect(preview.wouldWrite.mergeRecordTables, 'one report per participant').toBe(
      MERGE_PARTICIPANTS.length,
    )
    expect(preview.wouldWrite.auditEvents, 'one audit row').toBe(1)
    expect(preview.rolledBack).toBe(true)

    // (3) From outside: nothing survived. `merge_record` is inserted BEFORE any row moves, so a preview
    // that committed would have tombstoned a customer nobody approved merging — and the pair would answer
    // `already_merged` for ever, with no way back: the table refuses DELETE for every role (ZT001).
    expect(await writeFootprint(sql, pair.loserId), 'the preview wrote nothing').toEqual(before)
    // And the acceptance line's own words: per-table row counts are unchanged after a preview.
    expect(await pairRowCounts(sql, pair), 'no row moved').toEqual(rowsBefore)
  })

  it('shows which rows would move, per participant, with the retention reason', async () => {
    const pair = fixture.nearMiss
    const preview = await previewCustomerMerge(sql, {
      ...MERGE_ARGS,
      plan: await planFor(sql, pair),
    })
    if (preview.kind !== 'preview') throw new Error(`expected a preview, got ${preview.kind}`)

    // One report per registered participant, which is what makes the screen a statement about the whole
    // registry rather than about the tables somebody remembered.
    expect(preview.tables.map((table) => table.participant).sort()).toEqual(
      MERGE_PARTICIPANTS.map((p) => `${p.schema}.${p.table}`).sort(),
    )

    // The tags are the asymmetric pair: `repeat-guest` is on both records so the re-point is refused by
    // `customer_tag`'s primary key and the row is RETAINED with a reason; `walk-in` is on the loser only
    // and moves. A reviewer needs both numbers, because the retained row is the one that looks lost.
    const tags = preview.tables.find((table) => table.participant === 'public.customer_tag')
    expect(tags?.rowsMoved, `${DUPLICATE_QUEUE_FIXTURE_TAGS.onLoserOnly} moves`).toBe(1)
    expect(tags?.rowsRetainedOnLoser, `${DUPLICATE_QUEUE_FIXTURE_TAGS.onBoth} is retained`).toBe(1)
    expect(tags?.retainedReason, 'a retained row states why').toContain('already carries that tag')

    // The consent log is COPIED rather than moved (0056 refuses UPDATE), so the survivor gains a row and
    // the loser keeps every row it had. The control on the tag numbers above: two strategies, two shapes.
    const consent = preview.tables.find((table) => table.participant === 'public.consent')
    expect(consent?.strategy).toBe('repoint_insert')
    expect(consent?.rowsInserted).toBe(1)
    expect(consent?.rowsMoved).toBe(0)
    expect(consent?.rowsAfterLoser).toBe(consent?.rowsBeforeLoser)
  })

  it('surfaces the merge’s own refusal instead of showing a screen for a merge that cannot run', async () => {
    // A dedupe key one column too COARSE to describe `consent_one_record_per_instant`. Nothing else can
    // see it — the copy does what it is told and every row count balances — so the merge checks the key
    // against pg_index before issuing anything, and the preview must pass that refusal through rather
    // than reporting a preview of a merge the database would refuse.
    const tooCoarse = MERGE_PARTICIPANTS.map((p) =>
      p.table === 'consent' ? { ...p, dedupeKey: ['channel'] } : p,
    )
    const plan = await planFor(sql, fixture.nearMiss)
    const error = await raised(previewCustomerMerge(sql, { ...MERGE_ARGS, plan }, tooCoarse))
    expect(mergeRefusalOf(error)).toBe('merge_key_is_not_a_unique_index')
    // The control: the REGISTERED registry previews cleanly, so the refusal is about the mutant.
    expect(
      (
        await previewCustomerMerge(sql, {
          ...MERGE_ARGS,
          plan: await planFor(sql, fixture.nearMiss),
        })
      ).kind,
    ).toBe('preview')
  })
})

// ------------------------------------------------------------------------------------------------
// The consent state on the screen is the consent state afterwards
// ------------------------------------------------------------------------------------------------

describe('the previewed consent state is the post-merge consent state', () => {
  it('equals what resolveConsent says after the real merge, and differs from before it', async () => {
    const pair = fixture.nearMiss
    const preview = await previewCustomerMerge(sql, {
      ...MERGE_ARGS,
      plan: await planFor(sql, pair),
    })
    if (preview.kind !== 'preview') throw new Error(`expected a preview, got ${preview.kind}`)

    // The screen's answer: the same `resolveConsent` the send path reads through, over the log the
    // preview produced.
    const previewed = marketingState(preview.survivorConsentAfter)
    expect(previewed).toBe('withdrawn')

    // The control that stops the equality below being vacuous: the state BEFORE the merge is different.
    // Without it, a preview that returned the survivor's current log unchanged would satisfy everything.
    expect(marketingState(preview.survivorConsentBefore)).toBe('granted')
    expect(marketingState(await readConsentLog(sql, pair.survivorId))).toBe('granted')

    // And the real merge, in a transaction this file rolls back: the same answer.
    const afterMerge = await probe(async ({ tx, uow }) => {
      const outcome = await mergeCustomers(uow, { ...MERGE_ARGS, plan: await planFor(tx, pair) })
      expect(outcome.kind).toBe('merged')
      return await readConsentLog(tx, pair.survivorId)
    })
    expect(marketingState(afterMerge)).toBe(previewed)
    // Not only the folded state: the whole log the resolver folds. A preview that agreed on the answer
    // and disagreed on the records would be a screen that cannot be trusted about anything else on it.
    expect(preview.survivorConsentAfter.records.map((r) => [r.channel, r.purpose, r.kind])).toEqual(
      afterMerge.records.map((r) => [r.channel, r.purpose, r.kind]),
    )
  })
})

// ------------------------------------------------------------------------------------------------
// Swapping the survivor
// ------------------------------------------------------------------------------------------------

describe('the survivor choice is explicit, and the preview follows it', () => {
  it('previews different row counts in the two directions', async () => {
    const pair = fixture.nearMiss
    const asDefault = await previewCustomerMerge(sql, {
      ...MERGE_ARGS,
      plan: await planFor(sql, pair),
    })
    const swapped = await previewCustomerMerge(sql, {
      ...MERGE_ARGS,
      plan: await planFor(sql, pair, pair.loserId),
    })
    if (asDefault.kind !== 'preview' || swapped.kind !== 'preview') {
      throw new Error('expected two previews')
    }

    expect(asDefault.survivorCustomerId).toBe(pair.survivorId)
    expect(swapped.survivorCustomerId).toBe(pair.loserId)

    const tagsOf = (preview: typeof asDefault) =>
      preview.tables.find((table) => table.participant === 'public.customer_tag')

    // Keeping the EARLIER record (one tag) moves the loser's `walk-in` and retains the shared
    // `repeat-guest` on the tombstone, because `customer_tag`'s primary key refuses the second copy.
    expect(tagsOf(asDefault)?.rowsBeforeSurvivor).toBe(1)
    expect(tagsOf(asDefault)?.rowsBeforeLoser).toBe(2)
    expect(tagsOf(asDefault)?.rowsMoved).toBe(1)
    expect(tagsOf(asDefault)?.rowsRetainedOnLoser).toBe(1)
    // Keeping the LATER record (two tags) moves NOTHING: the loser's only tag is one the survivor already
    // carries. Both directions asserted, because a preview that ignored the nomination would report the
    // first set of numbers twice — and `rowsMoved` is the figure that tells them apart, which is why the
    // reviewer is shown it rather than only the resulting total (2 either way).
    expect(tagsOf(swapped)?.rowsBeforeSurvivor).toBe(2)
    expect(tagsOf(swapped)?.rowsBeforeLoser).toBe(1)
    expect(tagsOf(swapped)?.rowsMoved).toBe(0)
    expect(tagsOf(swapped)?.rowsRetainedOnLoser).toBe(1)
    expect(tagsOf(asDefault)).not.toEqual(tagsOf(swapped))

    // And still nothing was written, in either direction.
    expect((await readMergedAwayCustomerIds(sql, fixture.customerIds)).size).toBe(0)
  })

  it('refuses a nomination that is not one of the two records', async () => {
    const pair = fixture.nearMiss
    const a = await subjectOf(sql, pair.survivorId)
    const b = await subjectOf(sql, pair.loserId)
    const score = scoreDuplicatePair(
      { phone: a.phoneE164, label: a.displayName },
      { phone: b.phoneE164, label: b.displayName },
    )
    const decision = planCustomerMerge(a, b, score, 'operator_confirmed', {
      nominatedSurvivorId: fixture.simChange.survivorId,
    })
    expect(decision.kind === 'refused' && decision.refusal).toBe('merge_survivor_not_in_the_pair')
  })
})

// ------------------------------------------------------------------------------------------------
// The queue
// ------------------------------------------------------------------------------------------------

describe('the queue over the real candidate scan', () => {
  it('lists the pairs above the review threshold, ordered by score', async () => {
    const scan = await scanDuplicateQueue(sql, { customerIds: fixture.customerIds })
    const queue = buildDuplicateQueue({ records: asQueueRecords(scan.records), edges: scan.edges })

    // Two rows: the near miss from the PHONE signal at 900, then the SIM change from the LABEL signal at
    // 710. Both are needed: a queue built from one branch of the scan would list one of them and every
    // assertion about the other would pass by absence.
    expect(queue.rows.map((row) => row.scorePerMille)).toEqual([900, 710])
    expect(queue.rows.map((row) => row.pairKey)).toEqual([
      duplicatePairKey(fixture.nearMiss.survivorId, fixture.nearMiss.loserId),
      duplicatePairKey(fixture.simChange.survivorId, fixture.simChange.loserId),
    ])
    expect(queue.rows[0]?.phoneAgreement).toBe('one_digit_apart')
    expect(queue.rows[1]?.phoneAgreement).toBe('different')
    expect(queue.rows[1]?.labelAgreement).toBe('identical')

    // The default survivor is the earlier record, read off the plan rather than decided by the queue.
    expect(queue.rows[0]?.survivor.id).toBe(fixture.nearMiss.survivorId)
    expect(queue.rows[0]?.loser.id).toBe(fixture.nearMiss.loserId)
    expect(queue.rows[0]?.survivor.createdAt).toBeLessThan(queue.rows[0]?.loser.createdAt ?? 0)

    // The scan found each pair from BOTH sides — six probes over six records — and the queue asks about
    // each pair once. Without this the de-duplication could be doing nothing and the list would still
    // look right whenever the scan happened to be one-sided.
    expect(scan.scansIssued).toBe(6)
    expect(scan.edges.length).toBeGreaterThan(queue.pairsConsidered)
  })

  it('leaves a pair below the review threshold out, although the scan returns it', async () => {
    const scan = await scanDuplicateQueue(sql, {
      customerIds: [fixture.belowBand.survivorId, fixture.belowBand.loserId],
    })
    // The control, and the whole force of this case: the SCAN found the pair. C-CRM-02's floors are
    // deliberately looser than the scorer's classes, so a candidate below the band is the normal case and
    // not a misconfiguration — which means the absence below is the threshold's doing and not the scan's.
    expect(scan.edges.length).toBeGreaterThan(0)
    expect(
      scan.edges.some(
        (edge) =>
          duplicatePairKey(edge.aId, edge.bId) ===
          duplicatePairKey(fixture.belowBand.survivorId, fixture.belowBand.loserId),
      ),
    ).toBe(true)

    const queue = buildDuplicateQueue({ records: asQueueRecords(scan.records), edges: scan.edges })
    expect(queue.rows).toEqual([])
    expect(queue.excluded.below_review_threshold).toBeGreaterThan(0)
    expect(queue.refusals).toEqual(['merge_verdict_is_distinct'])
  })

  it('drops a pair whose record was merged away, which is C-CRM-05’s deferral', async () => {
    const scan = await scanDuplicateQueue(sql, { customerIds: fixture.customerIds })
    const pair = fixture.nearMiss
    const key = duplicatePairKey(pair.survivorId, pair.loserId)
    // Before: the pair is in the queue, so the absence below is the tombstone and nothing else.
    expect(
      buildDuplicateQueue({ records: asQueueRecords(scan.records), edges: scan.edges }).rows.map(
        (r) => r.pairKey,
      ),
    ).toContain(key)

    await probe(async ({ tx, uow }) => {
      const outcome = await mergeCustomers(uow, { ...MERGE_ARGS, plan: await planFor(tx, pair) })
      expect(outcome.kind).toBe('merged')

      // The db read that answers "is this a tombstone", inside the merge's own transaction.
      const tombstones = await readMergedAwayCustomerIds(tx, fixture.customerIds)
      expect(tombstones.has(pair.loserId)).toBe(true)
      expect(tombstones.has(pair.survivorId)).toBe(false)

      const queue = buildDuplicateQueue({
        records: asQueueRecords(scan.records, (id) => tombstones.has(id)),
        edges: scan.edges,
      })
      // Without this filter `findDuplicateCandidates` goes on returning the merged-away record as a
      // candidate for its own survivor, so the completed merge would sit in the queue for ever with a
      // confirm button that answers `already_merged`.
      expect(queue.rows.map((row) => row.pairKey)).not.toContain(key)
      expect(queue.excluded.merged_away).toBeGreaterThan(0)
      // The other pair is untouched, so the filter is about the tombstone and not about the queue
      // emptying itself.
      expect(queue.rows.map((row) => row.pairKey)).toContain(
        duplicatePairKey(fixture.simChange.survivorId, fixture.simChange.loserId),
      )
    })

    // And the tombstone was rolled back with the probe: this file commits no merge.
    expect((await readMergedAwayCustomerIds(sql, fixture.customerIds)).size).toBe(0)
  })

  it('loads every record either side of a pair, and keeps a scoped queue scoped', async () => {
    // The two-pass read. A queue built from the probe set alone would drop every pair that reached back
    // past the bound, which is most of them once the table is bigger than the bound.
    const scan = await scanDuplicateQueue(sql, {
      customerIds: [fixture.nearMiss.survivorId, fixture.nearMiss.loserId],
    })
    const loaded = new Set(scan.records.map((entry) => entry.subject.id))
    expect(loaded).toContain(fixture.nearMiss.survivorId)
    expect(loaded).toContain(fixture.nearMiss.loserId)
    // The scope is what keeps the rest out: the same scan unscoped reaches records this one does not.
    expect(loaded.has(fixture.simChange.survivorId)).toBe(false)
    // And the subject read is the merge's own, so the queue and the merge agree about what a record is.
    const subjects = await readCustomerMergeSubjects(sql, [...loaded])
    expect(subjects.map((subject) => subject.id).sort()).toEqual([...loaded].sort())
  })

  it('says when the bound bit, so an empty queue is not read as an empty database', async () => {
    const bounded = await scanDuplicateQueue(sql, { subjectLimit: 2 })
    expect(bounded.recordsProbed).toBe(2)
    expect(bounded.bounded).toBe(true)
    // The control: a scope is never "bounded", because it is a statement about a named set rather than a
    // window over the newest records.
    const scoped = await scanDuplicateQueue(sql, { customerIds: fixture.customerIds })
    expect(scoped.bounded).toBe(false)
    expect(scoped.recordsProbed).toBe(fixture.customerIds.length)
  }, 60_000)
})
