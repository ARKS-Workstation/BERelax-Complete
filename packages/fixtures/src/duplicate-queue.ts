import { nameMatchKey, normalisePhone, scoreDuplicatePair } from '@berelax/core'
import {
  type Actor,
  addCustomerTag,
  ensureCustomer,
  readCurrentConsentWording,
  recordConsent,
  type Sql,
  withdrawConsent,
  withUnitOfWork,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import { customerLabel, syntheticPerson } from './synthetic.ts'

/**
 * The three pairs C-CRM-06's review queue and preview are asserted against, seeded once.
 *
 * Shared by `packages/fixtures/src/merge-preview.itest.ts` and `apps/web/src/duplicates.itest.ts`, the
 * way `seedMessagingFixture` is shared by the inbox's two suites. A copy of these numbers in each file
 * would be two fixtures that drift: the scores below are cells of C-CRM-02's table, and the whole point of
 * the set is that one pair is in the review band from the PHONE, one from the LABEL, and one is in neither
 * — so a pair that quietly moved band would leave the two suites asserting different things.
 *
 * ## The three pairs, and why each one is here
 *
 *   - **`nearMiss`** — one digit apart, labels identical: **900**, review. The mistyped handset, which is
 *     the case this whole area exists for. It is also the pair whose tags are asymmetric, so the preview
 *     has different row counts depending on which record survives.
 *   - **`simChange`** — unrelated numbers, labels identical: **710**, review. The same person with a new
 *     number. It is in the queue because of the LABEL signal, which is what makes it worth seeding: a
 *     queue built from the phone branch alone would be missing it and every assertion about the near miss
 *     would still pass.
 *   - **`belowBand`** — one digit apart, labels one character apart: **640**, `distinct`. The candidate
 *     scan finds it (both of C-CRM-02's floors are deliberately looser than the scorer's classes) and the
 *     queue must NOT show it. That is the known-bad fixture the acceptance list asks for, and it only
 *     means something because the scan really does return it — which the suites assert.
 *
 * ## Fixed numbers, and what that costs
 *
 * The records are on the unallocated `+971 59` prefix in a band nothing else uses (`generateSalon`'s
 * 1–140, the CRM suites' 4411 upward, the consent loaders' 9101–9104 and 9111–9112, the suppression
 * loader's 9201–9203, the bands at 9301 and 9401, and C-CRM-05's 9501–9503), and they are ENSURED rather
 * than created: `customer-identity.itest.ts` clears the whole `customer` table between its cases, so a
 * suite that trusted an earlier run would pass or fail on vitest's file ordering (brief rule 12).
 *
 * Nothing here is ever merged. A merge is not repeatable — `merge_record_one_merge_per_loser` makes the
 * second attempt `already_merged` and the copied consent rows cannot be removed — so a suite that merged a
 * fixed pair would pass once against a fresh database and answer `already_merged` for ever after. The
 * suite that has to CONFIRM a merge over HTTP mints its own pair per run; see
 * `apps/web/src/duplicates.itest.ts`.
 *
 * Nothing here is a name: every label is `Customer NNNN` (ADR 0020), and a record's label being typed the
 * same way twice is precisely what makes two rows look like one person.
 */

/** The fixture indexes, so a reader can find the rows in the database by number. */
export const DUPLICATE_QUEUE_FIXTURE_INDEXES = {
  nearMissSurvivor: 9_601,
  nearMissLoser: 9_602,
  simChangeSurvivor: 9_611,
  simChangeLoser: 9_622,
  belowBandFirst: 9_631,
  belowBandSecond: 9_632,
  /** The label the second record of the below-band pair carries: one character from the first's. */
  belowBandSecondLabel: 9_641,
} as const

/**
 * The two tags on the near-miss pair, and why they are asymmetric.
 *
 * `customer_tag`'s primary key is `(customer_id, tag)`, so a re-point of a tag the survivor already
 * carries is refused by the key and RETAINED on the tombstone with a stated reason — and a tag it does not
 * carry moves. One of each is what makes the previewed counts differ between the two survivor choices,
 * which is the acceptance line about swapping the survivor.
 */
/**
 * The instants the consent log is written and read at, and why they are here rather than in a suite.
 *
 * The worked example C-CRM-05's acceptance names, and C-CRM-06's preview is the screen that has to show it:
 * the record that SURVIVES granted marketing on sms at `grantedAt`, the record that is merged AWAY withdrew
 * it at `withdrawnAt`, so the merged log resolves to `withdrawn` — the newest decision either of them made,
 * which is what `resolveConsent` reads and what the send path therefore obeys.
 *
 * They are exported constants because two suites resolve the same log and the answer depends on WHEN:
 * `resolveConsent` ignores records after the instant asked about, deliberately (a withdrawal recorded after
 * the moment in question is not evidence about it). The web suite renders the page at a fixed `?at=` so it
 * can be photographed twice, and the first version of it picked its own year — 2094, before these rows
 * existed — so every consent cell on the page read `unknown` and the failure named the assertion rather
 * than the date. One instant, declared beside the rows it is about.
 */
export const DUPLICATE_QUEUE_FIXTURE_INSTANTS = {
  grantedAt: '2099-08-01T10:00:00.000Z',
  withdrawnAt: '2099-08-02T10:00:00.000Z',
  /** After both decisions, so a resolution at this instant sees the whole log. */
  resolveAt: '2099-10-01T10:00:00.000Z',
} as const

export const DUPLICATE_QUEUE_FIXTURE_TAGS = {
  /** On both records, so it collides and is retained whichever way the merge runs. */
  onBoth: 'repeat-guest',
  /** On the later record only, so it moves when the later record is the loser and not when it survives. */
  onLoserOnly: 'walk-in',
} as const

export interface SeededDuplicatePair {
  readonly survivorId: string
  readonly loserId: string
  readonly survivorPhone: string
  readonly loserPhone: string
  readonly survivorLabel: string
  readonly loserLabel: string
  /** The cell of `AGREEMENT_SCORES` this pair lands in, computed here so a suite cannot assume it. */
  readonly scorePerMille: number
}

export interface SeededDuplicateQueueFixture {
  readonly nearMiss: SeededDuplicatePair
  readonly simChange: SeededDuplicatePair
  readonly belowBand: SeededDuplicatePair
  /** Every id the fixture owns, for the `customerIds` scope every assertion narrows through. */
  readonly customerIds: readonly string[]
}

/** One record, ensured in its OWN transaction — see {@link seedDuplicateQueueFixture}. */
async function ensureRecord(
  sql: Sql,
  actor: Actor,
  index: number,
  label: string,
): Promise<{ id: string; phone: string }> {
  const person = syntheticPerson(index)
  const e164 = normalisePhone(person.phone)
  const id = await withUnitOfWork(sql, actor, async (uow) => {
    const result = await ensureCustomer(uow, {
      phoneE164: e164,
      displayName: label,
      // The key core computes, and not a hand-rolled approximation of it: the candidate scan compares
      // `split_part(name_match_key, ':', 1)` against a probe built the same way, so a key in the wrong
      // shape would make the label branch find nothing and the `simChange` pair would vanish.
      nameMatchKey: nameMatchKey(label, e164),
      locale: 'en',
      createdVia: 'front_desk',
    })
    return result.customer.id
  })
  return { id, phone: e164 }
}

/**
 * Seeds the three pairs and returns their ids, with each pair's score computed rather than assumed.
 *
 * Each record is ensured in its own unit of work, and that is load-bearing: `created_at` defaults to
 * `now()`, which in PostgreSQL is the TRANSACTION's timestamp, so two records created in one transaction
 * share an instant to the microsecond and `planCustomerMerge` would be deciding the survivor on the
 * id tie-break instead of on the instant. The survivor of each pair is ensured first, so it is the earlier
 * record and the default survivor is the one these suites name.
 */
export async function seedDuplicateQueueFixture(
  sql: Sql,
  actorLabel: string,
): Promise<SeededDuplicateQueueFixture> {
  const actor: Actor = { kind: 'staff', label: actorLabel }
  const i = DUPLICATE_QUEUE_FIXTURE_INDEXES

  const pair = async (
    survivorIndex: number,
    loserIndex: number,
    survivorLabel: string,
    loserLabel: string,
  ): Promise<SeededDuplicatePair> => {
    const survivor = await ensureRecord(sql, actor, survivorIndex, survivorLabel)
    const loser = await ensureRecord(sql, actor, loserIndex, loserLabel)
    return {
      survivorId: survivor.id,
      loserId: loser.id,
      survivorPhone: survivor.phone,
      loserPhone: loser.phone,
      survivorLabel,
      loserLabel,
      scorePerMille: scoreDuplicatePair(
        { phone: survivor.phone, label: survivorLabel },
        { phone: loser.phone, label: loserLabel },
      ).scorePerMille,
    }
  }

  const nearMiss = await pair(
    i.nearMissSurvivor,
    i.nearMissLoser,
    customerLabel(i.nearMissSurvivor),
    customerLabel(i.nearMissSurvivor),
  )
  const simChange = await pair(
    i.simChangeSurvivor,
    i.simChangeLoser,
    customerLabel(i.simChangeSurvivor),
    customerLabel(i.simChangeSurvivor),
  )
  const belowBand = await pair(
    i.belowBandFirst,
    i.belowBandSecond,
    customerLabel(i.belowBandFirst),
    customerLabel(i.belowBandSecondLabel),
  )

  await withUnitOfWork(sql, actor, async (uow) => {
    for (const customerId of [nearMiss.survivorId, nearMiss.loserId]) {
      await addCustomerTag(uow, { customerId, tag: DUPLICATE_QUEUE_FIXTURE_TAGS.onBoth })
    }
    await addCustomerTag(uow, {
      customerId: nearMiss.loserId,
      tag: DUPLICATE_QUEUE_FIXTURE_TAGS.onLoserOnly,
    })
  })

  /*
    The consent log, seeded HERE rather than in either suite.

    It is what makes the preview's central claim assertable — the state after a merge is not the state
    before it — and both suites read it. Seeding it in one of them would make the other depend on vitest's
    file ordering: `apps/web/src/duplicates.itest.ts` sorts BEFORE
    `packages/fixtures/src/merge-preview.itest.ts`, so the web suite would have asserted a consent state
    against rows that did not exist yet on a fresh database (brief rule 12, and the third recorded case of
    it in this repository).

    Committed rather than written inside a rolled-back probe, because `previewCustomerMerge` opens its own
    transaction from the POOL and cannot see another transaction's uncommitted rows. It is idempotent
    because the instants are fixed: `consent_one_record_per_instant` is the key `recordConsent`
    de-duplicates on, so a second run writes nothing and reports `recorded: false`.
  */
  const wording = await readCurrentConsentWording(sql, 'marketing')
  if (wording === null) {
    throw new AppError(
      'invariant_violated',
      'No marketing consent wording is published, so the duplicate fixture cannot record a grant. Run ' +
        '`pnpm seed` (brief rule 24).',
    )
  }
  const capture = {
    source: 'front_desk',
    actorKind: 'staff',
    actorLabel,
    locale: 'en',
  } as const
  await withUnitOfWork(sql, actor, async (uow) => {
    await recordConsent(uow, {
      contactCustomerId: nearMiss.survivorId,
      channel: 'sms',
      purpose: 'marketing',
      kind: 'granted',
      recordedAtIso: DUPLICATE_QUEUE_FIXTURE_INSTANTS.grantedAt,
      wordingId: wording.id,
      wordingHashHex: wording.contentHashHex,
      capture,
    })
    await withdrawConsent(uow, {
      contactCustomerId: nearMiss.loserId,
      channel: 'sms',
      purpose: 'marketing',
      recordedAtIso: DUPLICATE_QUEUE_FIXTURE_INSTANTS.withdrawnAt,
      wordingId: null,
      wordingHashHex: null,
      capture,
    })
  })

  // The bands, asserted at the point of creation rather than in each suite. A fixture whose scores had
  // drifted would otherwise be discovered as a confusing failure in whichever suite ran first — and the
  // set only means something if one pair is above the threshold on the phone, one on the label, and one is
  // below it altogether.
  const expected: readonly [string, SeededDuplicatePair, number][] = [
    ['nearMiss', nearMiss, 900],
    ['simChange', simChange, 710],
    ['belowBand', belowBand, 640],
  ]
  const wrong = expected
    .filter(([, seeded, score]) => seeded.scorePerMille !== score)
    .map(([name, seeded, score]) => `${name} scores ${seeded.scorePerMille}, not ${score}`)
  if (wrong.length > 0) {
    throw new AppError(
      'invariant_violated',
      `The C-CRM-06 duplicate fixture does not land where its suites expect:\n${wrong
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
      { details: { wrong } },
    )
  }

  return {
    nearMiss,
    simChange,
    belowBand,
    customerIds: [
      nearMiss.survivorId,
      nearMiss.loserId,
      simChange.survivorId,
      simChange.loserId,
      belowBand.survivorId,
      belowBand.loserId,
    ],
  }
}
