import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Instant, instantFromIso } from '../time.ts'
import { scoreDuplicatePair } from './duplicate-score.ts'
import {
  type CustomerMergeDecision,
  type CustomerMergeSubject,
  type MergeAuthority,
  planCustomerMerge,
  unionByNaturalKey,
} from './merge-plan.ts'

/**
 * The two claims about `planCustomerMerge` and `unionByNaturalKey` that are properties rather than cases.
 *
 *   - **The plan is symmetric.** `planCustomerMerge(a, b)` and `planCustomerMerge(b, a)` are the same
 *     plan, so one candidate pair cannot propose two opposite merges depending on which record the
 *     candidate query returned first. A merge is where that would do real damage: whichever of the two
 *     proposals ran first would win, and the rows would have moved before anybody noticed the queue was
 *     unstable.
 *   - **The union is a count over distinct keys.** Every row of both sets is either kept or
 *     de-duplicated, exactly once, and the kept count is the number of distinct keys. That is the figure
 *     C-AUTO-03's rolling cap reads, and both directions of getting it wrong are harmful: too low hands a
 *     merged contact a fresh allowance, too high silences them on the strength of one message.
 *
 * ## Why each has to be a property, and what makes it non-vacuous
 *
 * The dangerous implementation of the survivor rule is `a.createdAt <= b.createdAt ? a : b`, which is
 * correct for every pair whose instants differ and wrong only on a TIE. A case file would have to guess
 * that; a property over a generator that produces ties often finds it. So the generator draws `createdAt`
 * from a small set — six candidates over two records — and the number of tied pairs is COUNTED and
 * asserted against a measured floor, because a run in which nothing tied would pass for exactly the
 * implementation this rules out (brief rule 22).
 *
 * The second control is the in-process known-bad one ADR 0003 asks for: `argumentOrderWins` below is that
 * implementation, and the property is asserted to catch it. Without that, a property that held for the
 * real function and for the broken one would be measuring nothing.
 *
 * The third is the refusal count. A generated pair that is refused produces no plan, and a run made
 * entirely of refusals would satisfy the symmetry claim trivially — so the phones are weighted towards
 * the identical-number case that reaches the auto band, and the number of pairs that actually produced a
 * plan is counted too.
 */

const at = (iso: string): Instant => instantFromIso(iso)

/**
 * Six candidate instants over a pair, so a tie is common rather than astronomically unlikely.
 *
 * Uniform over a range would put the probability of a tie at effectively zero, and the tie is the one
 * thing the id tiebreak exists for.
 */
const CREATED_AT = [
  '2025-01-01T08:00:00.000Z',
  '2025-06-15T09:30:00.000Z',
  '2026-01-01T08:00:00.000Z',
  '2026-02-02T11:00:00.000Z',
  '2026-03-03T12:00:00.000Z',
  '2026-04-04T13:00:00.000Z',
] as const

/** Two distinct ids, drawn so that neither the smaller nor the larger is systematically first. */
const IDS = [
  '00000000-0000-7000-8000-00000000c501',
  '00000000-0000-7000-8000-00000000c502',
  '00000000-0000-7000-8000-00000000c5aa',
  '00000000-0000-7000-8000-00000000c5ff',
] as const

/**
 * Numbers weighted 4:1 towards the shared handset, which is the only shape that reaches the auto band.
 *
 * Unweighted, most pairs would score `distinct` and be refused before a plan was built — and a property
 * over refusals says nothing about the plan. The other numbers still appear, because a refused pair is
 * part of the same claim: it must be refused whichever way round it arrives.
 */
const arbitraryPhone = fc.oneof(
  { arbitrary: fc.constant('+971590000501'), weight: 4 },
  { arbitrary: fc.constantFrom('+971590000502', '+971590000777'), weight: 1 },
)

/** Record labels, never names: a record with no display name is `Customer 0042` (ADR 0020). */
const arbitraryLabel = fc.constantFrom('Customer 0501', 'Customer 0502', null)

const arbitrarySubject = (id: string): fc.Arbitrary<CustomerMergeSubject> =>
  fc
    .record({
      createdAt: fc.constantFrom(...CREATED_AT).map(at),
      phoneE164: arbitraryPhone,
      displayName: arbitraryLabel,
      locale: fc.constantFrom('en', 'ar'),
      notes: fc.constantFrom('Prefers the quiet room.', null),
      createdVia: fc.constantFrom('guest_booking', 'front_desk', 'import'),
      phoneVerifiedAt: fc.constantFrom('2026-05-05T10:00:00.000Z', null),
    })
    .map((fields) => ({
      id,
      createdAt: fields.createdAt,
      phoneE164: fields.phoneE164,
      displayName: fields.displayName,
      // The match key moves with the name, so it is derived rather than generated: a pair where one was
      // present without the other would be a row `ensureCustomer` refuses to write.
      nameMatchKey: fields.displayName === null ? null : `${fields.displayName}|key`,
      locale: fields.locale,
      notes: fields.notes,
      createdVia: fields.createdVia,
      phoneVerifiedAt: fields.phoneVerifiedAt === null ? null : at(fields.phoneVerifiedAt),
    }))

/** Two subjects with DIFFERENT ids: the same id is its own refusal and has its own case. */
const arbitraryPair: fc.Arbitrary<readonly [CustomerMergeSubject, CustomerMergeSubject]> = fc
  .tuple(fc.constantFrom(...IDS), fc.constantFrom(...IDS))
  .filter(([left, right]) => left !== right)
  .chain(([left, right]) => fc.tuple(arbitrarySubject(left), arbitrarySubject(right)))

const scoreOf = (a: CustomerMergeSubject, b: CustomerMergeSubject) =>
  scoreDuplicatePair(
    { phone: a.phoneE164, label: a.displayName },
    { phone: b.phoneE164, label: b.displayName },
  )

/** The decision as a comparable string, so "the same plan" means the same plan and not the same shape. */
const shapeOf = (decision: CustomerMergeDecision): string =>
  decision.kind === 'refused'
    ? `refused|${decision.refusal}`
    : [
        'plan',
        decision.survivorId,
        decision.loserId,
        decision.authority,
        String(decision.scorePerMille),
        decision.phoneAgreement,
        decision.labelAgreement,
        decision.fields
          .map(
            (field) =>
              `${field.field}:${field.resolution}:${String(field.survivorValue)}:${String(field.loserValue)}`,
          )
          .join(','),
        JSON.stringify(decision.survivorUpdates),
      ].join('|')

/**
 * The known-bad control: the survivor rule written the obvious way.
 *
 * `<=` rather than `<` plus an id tiebreak. Correct for every pair whose instants differ, and it takes
 * the FIRST ARGUMENT on a tie — so the same pair, reviewed from the other side, proposes the opposite
 * merge. This is what the property must catch, and it is asserted to.
 */
const argumentOrderWins = (
  a: CustomerMergeSubject,
  b: CustomerMergeSubject,
): { readonly survivorId: string; readonly loserId: string } => {
  const survivor = a.createdAt <= b.createdAt ? a : b
  const loser = survivor === a ? b : a
  return { survivorId: survivor.id, loserId: loser.id }
}

describe('planCustomerMerge is symmetric in its arguments', () => {
  it('gives the identical decision whichever way round the pair arrives', () => {
    let tiedPairs = 0
    let planned = 0
    let caughtArgumentOrder = 0
    fc.assert(
      fc.property(
        arbitraryPair,
        fc.constantFrom<MergeAuthority>('auto_merge', 'operator_confirmed'),
        ([a, b], authority) => {
          const score = scoreOf(a, b)
          // scoreDuplicatePair is itself symmetric (C-CRM-02 proves it), so one score serves both calls
          // and the plan is the only thing under test here.
          const forward = planCustomerMerge(a, b, score, authority)
          const backward = planCustomerMerge(b, a, score, authority)
          expect(shapeOf(backward)).toBe(shapeOf(forward))

          if (a.createdAt === b.createdAt) {
            tiedPairs += 1
            const wrong = argumentOrderWins(a, b)
            const alsoWrong = argumentOrderWins(b, a)
            if (wrong.survivorId !== alsoWrong.survivorId) caughtArgumentOrder += 1
          }
          if (forward.kind === 'plan') planned += 1
        },
      ),
      { numRuns: 200 },
    )

    // The control that stops the 200 comparisons above comparing an answer with itself.
    //
    // MEASURED rather than assumed: six candidate instants over two independent draws puts a tie at 1/6,
    // so about 33 of 200. Twelve runs of this generator gave 28 to 42 tied pairs, mean 34.1. The floor is
    // 8, which is far below that and far above the zero a uniform instant generator would produce — a
    // floor set just under the observed minimum would become its own flake, which is the mistake brief
    // rule 22 is about.
    expect(
      tiedPairs,
      'generated pairs whose createdAt ties, so only the id tiebreak decides',
    ).toBeGreaterThanOrEqual(8)
    // And a floor for pairs that produced a PLAN: a run made entirely of refusals would satisfy the
    // property trivially. Weighted 4:1 towards the shared handset, this measured 120 to 133 of 200 over
    // the same twelve runs, mean 125.6. The floor is 60 — half of it, and an order of magnitude above
    // the handful an unweighted phone generator would leave.
    expect(
      planned,
      'generated pairs that produced a plan rather than a refusal',
    ).toBeGreaterThanOrEqual(60)
    // The known-bad control itself: every tied pair is one the argument-order rule answers two ways, so
    // the property above is testing something the broken implementation fails.
    expect(caughtArgumentOrder).toBe(tiedPairs)
  })
})

describe('unionByNaturalKey counts distinct keys', () => {
  interface Row {
    readonly window: string
    readonly messageId: string
  }
  const key = (row: Row) => `${row.window}|${row.messageId}`

  /** Three message ids over two windows, so an overlap between the two sets is common. */
  const arbitraryRow: fc.Arbitrary<Row> = fc.record({
    window: fc.constantFrom('2026-05-01', '2026-05-08'),
    messageId: fc.constantFrom('m-1', 'm-2', 'm-3'),
  })
  const arbitraryRows = fc.array(arbitraryRow, { minLength: 0, maxLength: 6 })

  it('keeps every key once and de-duplicates the rest, whatever the two sets hold', () => {
    let overlapping = 0
    fc.assert(
      fc.property(arbitraryRows, arbitraryRows, (survivorRows, loserRows) => {
        const result = unionByNaturalKey(survivorRows, loserRows, key)
        const distinct = new Set([...survivorRows, ...loserRows].map(key))

        // The count the cap reads is the number of distinct keys, never the number of rows.
        expect(result.keptCount).toBe(distinct.size)
        // Nothing is invented and nothing is lost: every row of both sets is in exactly one bucket.
        expect(result.kept.length + result.deduplicated.length).toBe(
          survivorRows.length + loserRows.length,
        )
        // And the kept set holds no key twice, which is what makes it safe to count by length.
        expect(new Set(result.kept.map(key)).size).toBe(result.kept.length)

        const survivorKeys = new Set(survivorRows.map(key))
        if (loserRows.some((row) => survivorKeys.has(key(row)))) overlapping += 1
      }),
      { numRuns: 200 },
    )

    // The counted control. A run in which the two sets never shared a key would prove that the union
    // unions, and nothing about the de-duplication — which is the half that decides whether one message
    // recorded against both records silences somebody for a fortnight. Six message-window combinations
    // over two sets of up to six rows measured 98 to 125 of 200 overlapping across twelve runs, mean
    // 106.1; the floor is 50, which is half of it rather than just under the minimum.
    expect(
      overlapping,
      'generated pairs of sets that actually shared a key',
    ).toBeGreaterThanOrEqual(50)
  })
})
