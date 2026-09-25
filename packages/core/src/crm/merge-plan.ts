import type { Instant } from '../time.ts'
import { instantToIso } from '../time.ts'
import type { DuplicateScore, DuplicateVerdict } from './duplicate-score.ts'

/**
 * `planCustomerMerge` — who survives a merge, what the two records disagree about, and what a merge is
 * not allowed to do (C-CRM-05).
 *
 * The pure half of the merge. It decides, from two customer records and C-CRM-02's score, which record
 * survives and how each scalar field resolves; it performs no I/O and knows nothing about the tables the
 * merge re-points, which is `packages/db/src/merge-participants.ts`'s subject. `packages/db` may not
 * import `packages/core`, so the plan travels as data: the repository reads two rows, calls this, and
 * writes what it is told.
 *
 * ## The earliest record survives, and a tie is broken deterministically
 *
 * The survivor is the record with the earlier `createdAt`. That is the provisional rule in
 * `build/manifest.yaml`, and the reason it is the right default rather than an arbitrary one is that a
 * customer's history hangs off the record that has been there longest — its bookings, its invoices, its
 * clinical file. Merging the old record into the new one would move the larger set of rows and leave the
 * tombstone holding the history.
 *
 * A tie is broken by the SMALLER id, never by argument order. Two reasons, and the second is the one
 * that matters:
 *
 *   - `uuid_generate_v7()` is time-ordered, so within one millisecond the smaller id is very probably
 *     the earlier row anyway;
 *   - a tie broken by argument order would make the plan depend on which record the candidate query
 *     happened to return first. That is the defect C-CRM-02's symmetry property exists to prevent, and a
 *     merge is where it would do real damage: the same pair reviewed twice would propose two opposite
 *     merges, and whichever ran first would win. `planCustomerMerge(a, b)` and `planCustomerMerge(b, a)`
 *     are asserted equal over generated pairs in `merge-plan.property.test.ts`.
 *
 * ## A `distinct` pair is not mergeable under any authority
 *
 * `auto_merge` requires the score to be in the auto band, which C-CRM-02's table only ever reaches with
 * an identical phone number. `operator_confirmed` additionally accepts the review band, because that
 * band exists precisely to be looked at by a person. Neither accepts `distinct`, and the asymmetry is
 * deliberate: a false merge cannot be undone by a DELETE — the rows have moved and the append-only ones
 * have been copied — so the operation refuses the case where the evidence says these are two people, and
 * a genuine mistake in the scorer is fixed by fixing the scorer.
 *
 * ## Two fields are never transferred, and saying which is the point
 *
 * `phoneE164` cannot be: the column is UNIQUE (0019), so one record cannot hold both numbers. The
 * loser's number stays on the tombstone, which is where a later search for it still finds the person.
 * `phoneVerifiedAt` must not be: a verification is proof that somebody answered a code sent to ONE
 * number, and the survivor keeps its own number — so carrying the loser's verification across would
 * assert that a number nobody proved had been proved, which is what gates reading a clinical file back.
 *
 * Everything else follows `ensureCustomer`'s existing rule, which this deliberately does not restate
 * differently: a value is filled in where the survivor has none, and **never overwritten** where it has
 * one. The loser's discarded value is carried in the plan so that `merge_record.field_resolutions` can
 * store it — a merge that resolved a conflict must not be indistinguishable from one that found none.
 */

/** The scalar fields a merge resolves. In the order `merge_record.field_resolutions` stores them. */
export const CUSTOMER_MERGE_FIELDS = [
  'phoneE164',
  'displayName',
  'nameMatchKey',
  'locale',
  'notes',
  'createdVia',
  'phoneVerifiedAt',
] as const
export type CustomerMergeField = (typeof CUSTOMER_MERGE_FIELDS)[number]

/**
 * How one field resolved.
 *
 * `not_transferable` is not a variant of `survivor_wins`: the latter says a choice was made between two
 * values, and the former says the column could not hold the loser's value at all. A reader deciding
 * whether anything was lost needs to be able to tell those apart.
 */
export const MERGE_FIELD_RESOLUTIONS = [
  /** Both records say the same thing, or neither says anything. Nothing was discarded. */
  'agreed',
  /** Both present and different. The survivor's value stands and the loser's is recorded. */
  'survivor_wins',
  /** The survivor had none and the loser supplied one. The survivor's row is updated. */
  'loser_supplies',
  /** The column cannot hold the loser's value — see the header for the two that cannot. */
  'not_transferable',
] as const
export type MergeFieldResolution = (typeof MERGE_FIELD_RESOLUTIONS)[number]

/** One record as the plan needs it. `notes` and `displayName` are null for most rows (ADR 0020). */
export interface CustomerMergeSubject {
  readonly id: string
  /** When the row was created. The survivor is the earlier of the two. */
  readonly createdAt: Instant
  readonly phoneE164: string
  readonly displayName: string | null
  /** `nameMatchKey(displayName, phoneE164)`, or null with no name. Moves with `displayName`. */
  readonly nameMatchKey: string | null
  readonly locale: string
  readonly notes: string | null
  readonly createdVia: string
  readonly phoneVerifiedAt: Instant | null
}

export interface CustomerMergeFieldPlan {
  readonly field: CustomerMergeField
  readonly resolution: MergeFieldResolution
  /** Rendered for the record: an instant becomes an ISO string, everything else stays as it is. */
  readonly survivorValue: string | null
  readonly loserValue: string | null
  /** Present on `not_transferable` only, and required there. Why the value could not move. */
  readonly why?: string
}

export const MERGE_PLAN_REFUSALS = [
  /** One record cannot be merged into itself: every count would double and nothing would move. */
  'merge_same_record',
  /** The scorer says these are two people. No authority overrides that — see the header. */
  'merge_verdict_is_distinct',
  /** The score is in the review band and nobody confirmed it. */
  'merge_needs_an_operator',
] as const
export type MergePlanRefusal = (typeof MERGE_PLAN_REFUSALS)[number]

/** Who is taking responsibility. `auto_merge` is the score alone; there is no third value. */
export const MERGE_AUTHORITIES = ['auto_merge', 'operator_confirmed'] as const
export type MergeAuthority = (typeof MERGE_AUTHORITIES)[number]

export interface CustomerMergePlan {
  readonly kind: 'plan'
  readonly survivorId: string
  readonly loserId: string
  readonly authority: MergeAuthority
  readonly scorePerMille: number
  readonly phoneAgreement: string
  readonly labelAgreement: string
  readonly fields: readonly CustomerMergeFieldPlan[]
  /**
   * The columns to set on the survivor's row, from the `loser_supplies` fields alone.
   *
   * `displayName` and `nameMatchKey` move together or not at all: a name written without its match key
   * is a record the duplicate scan can no longer find (0019 writes that key from the application
   * because `unaccent` is STABLE and cannot appear in a generated column).
   */
  readonly survivorUpdates: {
    readonly displayName?: string
    readonly nameMatchKey?: string | null
    readonly notes?: string
  }
}

export type CustomerMergeRefusal = {
  readonly kind: 'refused'
  readonly refusal: MergePlanRefusal
  readonly detail: string
}

export type CustomerMergeDecision = CustomerMergePlan | CustomerMergeRefusal

const refused = (refusal: MergePlanRefusal, detail: string): CustomerMergeRefusal => ({
  kind: 'refused',
  refusal,
  detail,
})

/** Which verdicts each authority may act on. Neither may act on `distinct`. */
const PERMITTED_VERDICTS: Readonly<Record<MergeAuthority, readonly DuplicateVerdict[]>> =
  Object.freeze({
    auto_merge: Object.freeze(['auto_merge'] as const),
    operator_confirmed: Object.freeze(['auto_merge', 'review'] as const),
  })

const renderInstant = (instant: Instant | null): string | null =>
  instant === null ? null : instantToIso(instant)

/**
 * One scalar field, resolved.
 *
 * `agreed` covers two-nulls as well as two-equals, and that is not a convenience: a field neither record
 * holds has nothing to discard, and reporting it as `survivor_wins` would fill
 * `merge_record.field_resolutions` with rows that record no decision.
 */
function resolveField(
  field: CustomerMergeField,
  survivorValue: string | null,
  loserValue: string | null,
): CustomerMergeFieldPlan {
  if (survivorValue === loserValue)
    return { field, resolution: 'agreed', survivorValue, loserValue }
  if (survivorValue === null)
    return { field, resolution: 'loser_supplies', survivorValue, loserValue }
  return { field, resolution: 'survivor_wins', survivorValue, loserValue }
}

/**
 * Decides a merge from the two records and C-CRM-02's score.
 *
 * Total: every input produces a plan or a named refusal, and nothing throws. The score arrives as
 * `DuplicateScore` — the whole answer, including which cell of C-CRM-02's table it came from — rather
 * than as a bare number, because `merge_record` stores the cell and a number alone cannot say whether
 * the phones were identical or only the labels were.
 */
export function planCustomerMerge(
  a: CustomerMergeSubject,
  b: CustomerMergeSubject,
  score: DuplicateScore,
  authority: MergeAuthority,
): CustomerMergeDecision {
  if (a.id === b.id) {
    return refused(
      'merge_same_record',
      `Customer ${a.id} cannot be merged into itself. Every row count would be doubled by the same ` +
        'row and nothing would move; a pair query that produced this has a self-join in it.',
    )
  }

  if (score.verdict === 'distinct') {
    return refused(
      'merge_verdict_is_distinct',
      `The pair scores ${score.scorePerMille} per mille (phone ${score.phone}, label ${score.label}), ` +
        'which is below the review threshold — the evidence says these are two people. A false merge ' +
        'cannot be undone by a DELETE, so no authority overrides this: fix the scorer if it is wrong.',
    )
  }

  if (!PERMITTED_VERDICTS[authority].includes(score.verdict)) {
    return refused(
      'merge_needs_an_operator',
      `The pair scores ${score.scorePerMille} per mille, which is in the review band, and the ` +
        'authority given is `auto_merge`. The review band exists to be looked at by a person: ' +
        're-submit with `operator_confirmed` once somebody has.',
    )
  }

  // The earlier record survives; a tie goes to the smaller id, never to the argument order. See the
  // header — the symmetry is what stops one pair proposing two opposite merges.
  const aFirst = a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id)
  const survivor = aFirst ? a : b
  const loser = aFirst ? b : a

  const fields: CustomerMergeFieldPlan[] = [
    {
      field: 'phoneE164',
      resolution: 'not_transferable',
      survivorValue: survivor.phoneE164,
      loserValue: loser.phoneE164,
      why:
        'customer.phone_e164 is UNIQUE (0019), so one record cannot hold both numbers. The loser’s ' +
        'number stays on the tombstone, which is where a later search for it still finds the person.',
    },
    resolveField('displayName', survivor.displayName, loser.displayName),
    resolveField('nameMatchKey', survivor.nameMatchKey, loser.nameMatchKey),
    resolveField('locale', survivor.locale, loser.locale),
    resolveField('notes', survivor.notes, loser.notes),
    resolveField('createdVia', survivor.createdVia, loser.createdVia),
    {
      field: 'phoneVerifiedAt',
      resolution: 'not_transferable',
      survivorValue: renderInstant(survivor.phoneVerifiedAt),
      loserValue: renderInstant(loser.phoneVerifiedAt),
      why:
        'A verification proves somebody answered a code sent to ONE number, and the survivor keeps its ' +
        'own. Carrying it across would assert that a number nobody proved had been proved, and that is ' +
        'what gates reading a clinical file back.',
    },
  ]

  const survivorUpdates: {
    displayName?: string
    nameMatchKey?: string | null
    notes?: string
  } = {}
  // `displayName` and `nameMatchKey` move together or not at all; see CustomerMergePlan.
  if (survivor.displayName === null && loser.displayName !== null) {
    survivorUpdates.displayName = loser.displayName
    survivorUpdates.nameMatchKey = loser.nameMatchKey
  }
  if (survivor.notes === null && loser.notes !== null) survivorUpdates.notes = loser.notes

  return {
    kind: 'plan',
    survivorId: survivor.id,
    loserId: loser.id,
    authority,
    scorePerMille: score.scorePerMille,
    phoneAgreement: score.phone,
    labelAgreement: score.label,
    fields,
    survivorUpdates,
  }
}

/** The named refusal on a decision, or null when it is a plan. Callers branch on this, never on prose. */
export function mergePlanRefusalOf(decision: CustomerMergeDecision): MergePlanRefusal | null {
  return decision.kind === 'refused' ? decision.refusal : null
}

// ------------------------------------------------------------------------------------------------
// The union of two ledgers
// ------------------------------------------------------------------------------------------------

/**
 * Union two sets of rows onto the survivor, de-duplicating by a NATURAL key.
 *
 * This is the semantics of the `union_dedupe` merge strategy, written here as a pure function because
 * the table it exists for does not exist yet: C-AUTO-03 owns `frequency_ledger` and depends on this
 * unit, so the SQL that unions it is registered later while the RULE is settled and tested now.
 *
 * The rule has two halves and both are load-bearing in opposite directions:
 *
 *   - **A send recorded against BOTH records counts once.** The rolling cap is "one promotional message
 *     per contact per seven days"; a merge that double-counted would silence somebody for a fortnight
 *     on the strength of one message, and a support ticket about it is unanswerable because the ledger
 *     says two sends happened.
 *   - **Two DIFFERENT sends count twice.** A merge that de-duplicated by contact alone — or that took
 *     the survivor's rows and dropped the loser's — would hand the merged contact a fresh allowance,
 *     which turns a merge into a way to message somebody past the cap.
 *
 * So the worked example the acceptance criterion names: one in-window send on each record, different
 * messages, gives a survivor count of exactly **2** — never 1 (a row dropped) and never 4 (both sets
 * counted twice). The same example with one message recorded against both records gives **1**.
 *
 * `key` returns the natural key as a string. For the frequency ledger that is
 * (contact, window, message id) with the contact resolved to the survivor — which is why the contact is
 * not part of what this function compares: after a merge both sides ARE the survivor's rows, so keying
 * on the contact would make every pair of rows look distinct.
 */
export interface UnionByNaturalKeyResult<T> {
  /** The survivor's rows after the merge: its own, plus the loser's that were not already there. */
  readonly kept: readonly T[]
  /** The loser's rows whose key the survivor already held. Counted once, not twice. */
  readonly deduplicated: readonly T[]
  /** `kept.length`, which is the figure the cap reads. Named so an assertion cannot drift onto a set. */
  readonly keptCount: number
}

export function unionByNaturalKey<T>(
  survivorRows: readonly T[],
  loserRows: readonly T[],
  key: (row: T) => string,
): UnionByNaturalKeyResult<T> {
  const seen = new Set<string>()
  const kept: T[] = []
  const deduplicated: T[] = []

  // The survivor's own rows first, and its own duplicates are folded too: a ledger that already held one
  // key twice is a ledger the cap over-counts, and a merge is not the place to preserve that.
  for (const row of survivorRows) {
    const k = key(row)
    if (seen.has(k)) {
      deduplicated.push(row)
      continue
    }
    seen.add(k)
    kept.push(row)
  }
  for (const row of loserRows) {
    const k = key(row)
    if (seen.has(k)) {
      deduplicated.push(row)
      continue
    }
    seen.add(k)
    kept.push(row)
  }

  return { kept, deduplicated, keptCount: kept.length }
}
