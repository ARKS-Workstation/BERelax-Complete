import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Instant, instantFromIso } from '../time.ts'
import {
  type ConsentLog,
  type ConsentRecord,
  type ConsentResolution,
  type ConsentWordingVersion,
  resolveConsent,
} from './resolve.ts'

/**
 * C-CRM-03's two acceptance lines that are properties rather than cases:
 *
 *   - "resolveConsent(contact, channel, purpose, instant) is insertion-order independent — 1000 random
 *     shuffles of the same record set yield the identical resolved state";
 *   - "resolveConsent returns typed 'unknown' (never 'granted') when no record exists, when the wording
 *     version is unresolvable, and when two records share an identical timestamp — fail-closed proven as
 *     a property, not as three cases".
 *
 * ## Why each of these has to be a property
 *
 * Order independence cannot be shown by cases. The dependence it rules out is exactly the kind a case
 * does not reveal: `sort` is stable in V8, so a comparator over equal keys resolves a tie by taking
 * whichever row arrived first, and every fixed-order test agrees with itself. The only way to see it is
 * to permute the same set and compare the answers.
 *
 * Fail-closed likewise. "Returns unknown when there is no record" is one case; "never returns granted
 * for a log that cannot answer" is a claim about every log, and the interesting logs are the ones nobody
 * would write down — a grant under a version that was not supplied, sitting behind an older grant that
 * *was*, with a tie somewhere in the middle.
 *
 * ## The controls, because a property over an empty or degenerate space proves nothing
 *
 * Four:
 *
 *   1. **The generator must actually produce each state.** A generator that only ever built empty logs
 *      would satisfy "never granted" trivially. The distribution is counted and every state asserted to
 *      occur, with `granted` among them.
 *   2. **A deliberately order-DEPENDENT resolver is run against the same shuffles and must fail.** This
 *      is the known-bad control ADR 0003 asks for, in-process: `lastWins` takes the final applicable
 *      record, which is what a resolver reading `records.at(-1)` does, and the property is asserted to
 *      catch it.
 *   3. **A deliberately fail-OPEN resolver must be caught too.** `optimistic` answers `granted` whenever
 *      any grant exists, which is the shape of every consent check that was written before somebody
 *      thought about withdrawals.
 *   4. **Shuffling must really shuffle.** A permutation generator that returned its input would make
 *      point 1 of the acceptance vacuous, so the number of distinct orderings seen is asserted.
 */
const at = (iso: string): Instant => instantFromIso(iso)
const NOW = at('2026-09-18T10:00:00.000Z')

/** Three versions, of which only two are ever supplied to the resolver. See `arbitraryLog`. */
const VERSIONS: readonly ConsentWordingVersion[] = [
  { id: 'w1', purpose: 'marketing', version: 1, contentHashHex: '1'.repeat(64) },
  { id: 'w2', purpose: 'marketing', version: 2, contentHashHex: '2'.repeat(64) },
]
/** Published, then lost — the shape of a version a merge or a partial import leaves behind. */
const UNSUPPLIED_VERSION_ID = 'w3'

const CHANNEL = 'sms'
const PURPOSE = 'marketing'

/**
 * A record whose instant is drawn from a SMALL set of candidates, on purpose.
 *
 * A generator over the whole instant range would make a tie astronomically unlikely, and the tie is one
 * of the three things being proved. Six candidate instants over eight records makes collisions common,
 * which is the distribution this property needs.
 */
const INSTANTS = [
  '2026-09-01T10:00:00.000Z',
  '2026-09-02T10:00:00.000Z',
  '2026-09-03T10:00:00.000Z',
  '2026-09-04T10:00:00.000Z',
  '2026-09-05T10:00:00.000Z',
  // After `NOW`, so the point-in-time filter is exercised as well.
  '2026-09-25T10:00:00.000Z',
] as const

/**
 * The channel and purpose are WEIGHTED towards the ones being asked about, and that is load-bearing.
 *
 * Uniform `constantFrom` over three channels and three purposes was the first version, and it made this
 * property vacuous most of the time. A record is applicable only when its channel is `sms`, its purpose
 * is `marketing` and its instant is at or before `NOW`: 1/3 x 1/3 x 5/6, about 0.09. Over a set averaging
 * four records that is 0.37 applicable records expected, so the overwhelming majority of generated sets
 * had fewer than TWO applicable records — and with fewer than two, no permutation can change the answer
 * and the property holds for a resolver that is completely order-dependent.
 *
 * It was not a theory. Gate case 72a breaks `resolveConsent`'s newest-record reduce and asserts the
 * mutant is caught by name; run eight times against the identical mutant it named the rule in seven and
 * missed it in one, because that eighth run drew forty sets none of which could tell first from newest.
 * The mutant always failed the suite — the fixed-order cases next door see it — so the visible symptom
 * was a gate reporting a rule as missing, which reads as a gate that does not fire.
 *
 * 4:1 puts the applicable probability at 0.8 x 0.8 x 5/6 = 0.556, and `orderSensitiveSets` below counts
 * what that actually yields rather than trusting the arithmetic. The other channels and purposes still
 * appear, because "the filter is applied at all" is part of the same claim.
 */
const arbitraryRecord = (index: number): fc.Arbitrary<ConsentRecord> =>
  fc.record({
    id: fc.constant(`c${index}`),
    channel: fc.oneof(
      { arbitrary: fc.constant(CHANNEL), weight: 4 },
      { arbitrary: fc.constantFrom('whatsapp', 'email'), weight: 1 },
    ),
    purpose: fc.oneof(
      { arbitrary: fc.constant(PURPOSE), weight: 4 },
      { arbitrary: fc.constantFrom('review_request', 'photography'), weight: 1 },
    ),
    kind: fc.constantFrom('granted' as const, 'withdrawn' as const),
    recordedAt: fc.constantFrom(...INSTANTS).map(at),
    wordingId: fc.constantFrom('w1', 'w2', UNSUPPLIED_VERSION_ID, null),
  })

/**
 * Whether a different order of THIS set could give a different answer.
 *
 * Two applicable records are necessary and not sufficient: two that agree on kind, wording and instant
 * are interchangeable, so permuting them proves nothing. The condition is two applicable records that
 * differ in at least one of the three.
 */
const couldDisagreeUnderAnotherOrder = (records: readonly ConsentRecord[]): boolean => {
  const applicable = records.filter(
    (record) =>
      record.channel === CHANNEL && record.purpose === PURPOSE && record.recordedAt <= NOW,
  )
  if (applicable.length < 2) return false
  const shapes = new Set(
    applicable.map((record) => `${record.kind}|${record.wordingId}|${String(record.recordedAt)}`),
  )
  return shapes.size > 1
}

const arbitraryRecords: fc.Arbitrary<readonly ConsentRecord[]> = fc
  .integer({ min: 0, max: 8 })
  .chain((count) => fc.tuple(...Array.from({ length: count }, (_, i) => arbitraryRecord(i))))

const logOf = (records: readonly ConsentRecord[]): ConsentLog => ({
  contactId: 'contact-1',
  records,
  wordingVersions: VERSIONS,
})

/** The answer as a comparable string, so "identical" means identical and not "same state". */
const shapeOf = (answer: ConsentResolution): string =>
  answer.state === 'granted'
    ? `granted|${answer.recordId}|${answer.recordedAtIso}|${answer.wordingId}|${answer.wordingVersion}|${answer.wordingHashHex}`
    : answer.state === 'withdrawn'
      ? `withdrawn|${answer.recordId}|${answer.recordedAtIso}`
      : `unknown|${answer.reason}|${[...answer.tiedRecordIds].join(',')}`

/** A deterministic permutation of an array, from a seed. No `Math.random`: core forbids it. */
function permute<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let state = seed >>> 0 || 0x2f6e_2b1
  for (let i = out.length - 1; i > 0; i -= 1) {
    // xorshift32. A named generator rather than a library, because the whole point is that the
    // permutation is reproducible from the seed the failure message prints.
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    const j = Math.abs(state) % (i + 1)
    const a = out[i] as T
    const b = out[j] as T
    out[i] = b
    out[j] = a
  }
  return out
}

describe('resolveConsent is insertion-order independent', () => {
  it('yields the identical resolution for 1,000 shuffles of the same record set', () => {
    let orderSensitiveSets = 0
    fc.assert(
      fc.property(arbitraryRecords, (records) => {
        if (couldDisagreeUnderAnotherOrder(records)) orderSensitiveSets += 1
        const expected = shapeOf(resolveConsent(logOf(records), CHANNEL, PURPOSE, NOW))
        for (let seed = 1; seed <= 25; seed += 1) {
          const shuffled = permute(records, seed * 2_654_435_761)
          expect(shapeOf(resolveConsent(logOf(shuffled), CHANNEL, PURPOSE, NOW))).toBe(expected)
        }
      }),
      // 40 generated sets x 25 permutations each = 1,000 shuffles, which is the acceptance line's
      // number. Stated as the product rather than as `numRuns: 1000` with one shuffle, because one
      // shuffle of a thousand different sets would not compare a set against itself at all.
      { numRuns: 40 },
    )
    // The control that stops the 1,000 shuffles above being 1,000 comparisons of an answer with itself.
    //
    // A set with fewer than two DIFFERING applicable records cannot disagree under any permutation, so a
    // run made entirely of those would pass for a resolver that reads `records[0]`.
    //
    // MEASURED, not assumed: twenty runs of this file with the weighted generator gave 15 to 29 of the 40
    // sets qualifying, mean 21.1, median 21 — about 0.53 each, which matches the 0.8 x 0.8 x 5/6 the
    // generator's comment works out. The floor is 6, which is roughly five standard deviations below that
    // mean and so will not trip on its own; the failure it is here to catch is the uniform generator's
    // nought-to-two, an order of magnitude away. A floor set just under the observed minimum would itself
    // become a flake, which is the mistake this whole change is about.
    expect(
      orderSensitiveSets,
      `only ${orderSensitiveSets} of 40 generated sets had two applicable records that differ, so the ` +
        'shuffles mostly compared an answer with itself and this property would pass for an ' +
        'order-dependent resolver. The generator has drifted — see arbitraryRecord.',
    ).toBeGreaterThanOrEqual(6)
  })

  it('catches a resolver that takes the LAST applicable record — the known-bad control', () => {
    // `records.at(-1)` is the obvious implementation and it is wrong in exactly the way no fixed-order
    // test can see. If this control ever stops failing, the property above has stopped comparing.
    const lastWins = (records: readonly ConsentRecord[]): string => {
      const applicable = records.filter(
        (r) => r.channel === CHANNEL && r.purpose === PURPOSE && r.recordedAt <= NOW,
      )
      const last = applicable.at(-1)
      return last === undefined ? 'unknown' : `${last.kind}|${last.id}`
    }
    // A set with a tie in it, which is what makes the two orders disagree.
    const records = [
      {
        id: 'a',
        channel: CHANNEL,
        purpose: PURPOSE,
        kind: 'granted' as const,
        recordedAt: at(INSTANTS[0]),
        wordingId: 'w1',
      },
      {
        id: 'b',
        channel: CHANNEL,
        purpose: PURPOSE,
        kind: 'withdrawn' as const,
        recordedAt: at(INSTANTS[0]),
        wordingId: null,
      },
    ]
    expect(lastWins(records)).not.toBe(lastWins([...records].reverse()))
    // And the real resolver does not move.
    expect(shapeOf(resolveConsent(logOf(records), CHANNEL, PURPOSE, NOW))).toBe(
      shapeOf(resolveConsent(logOf([...records].reverse()), CHANNEL, PURPOSE, NOW)),
    )
  })

  it('shuffles, rather than returning its input', () => {
    // The control on the control. A permutation that was the identity would make the property above
    // compare a log with itself twenty-five times.
    const items = ['a', 'b', 'c', 'd', 'e', 'f']
    const orderings = new Set(
      Array.from({ length: 25 }, (_, i) => permute(items, (i + 1) * 2_654_435_761).join('')),
    )
    expect(orderings.size).toBeGreaterThan(5)
    expect(permute(items, 7)).toHaveLength(items.length)
    expect([...permute(items, 7)].sort()).toEqual(items)
  })
})

describe('resolveConsent fails closed to unknown, never to granted', () => {
  it('never answers granted for a log that cannot answer, over every generated log', () => {
    fc.assert(
      fc.property(arbitraryRecords, (records) => {
        const answer = resolveConsent(logOf(records), CHANNEL, PURPOSE, NOW)
        const applicable = records.filter(
          (r) => r.channel === CHANNEL && r.purpose === PURPOSE && r.recordedAt <= NOW,
        )
        if (applicable.length === 0) {
          expect(answer.state).toBe('unknown')
          return
        }
        const newest = Math.max(...applicable.map((r) => r.recordedAt))
        const tied = applicable.filter((r) => r.recordedAt === newest)
        if (tied.length > 1) {
          // The tie case, as a property: whatever the records say, the answer is unknown.
          expect(answer.state).toBe('unknown')
          if (answer.state === 'unknown') expect(answer.reason).toBe('ambiguous_timestamp')
          return
        }
        const decider = tied[0] as ConsentRecord
        if (decider.kind === 'withdrawn') {
          expect(answer.state).toBe('withdrawn')
          return
        }
        const resolvable = VERSIONS.some((version) => version.id === decider.wordingId)
        // The wording case, as a property: a grant under a version nobody supplied is unknown, and a
        // grant under one that was supplied is granted. Both directions, so neither is vacuous.
        expect(answer.state).toBe(resolvable ? 'granted' : 'unknown')
        if (!resolvable && answer.state === 'unknown') {
          expect(answer.reason).toBe('wording_unresolvable')
        }
      }),
      { numRuns: 1_000 },
    )
  })

  it('generates every state, so the property above is not satisfied by an empty space', () => {
    const seen = new Map<string, number>()
    fc.assert(
      fc.property(arbitraryRecords, (records) => {
        const answer = resolveConsent(logOf(records), CHANNEL, PURPOSE, NOW)
        const key = answer.state === 'unknown' ? `unknown:${answer.reason}` : answer.state
        seen.set(key, (seen.get(key) ?? 0) + 1)
      }),
      { numRuns: 1_000 },
    )
    for (const key of [
      'granted',
      'withdrawn',
      'unknown:no_record',
      'unknown:wording_unresolvable',
      'unknown:ambiguous_timestamp',
    ]) {
      expect(seen.get(key) ?? 0, `${key} was never generated`).toBeGreaterThan(0)
    }
  })

  it('catches an optimistic resolver — the fail-open known-bad control', () => {
    // "Any grant means granted", which is what a consent check written before anybody thought about
    // withdrawals looks like. It disagrees with the real resolver on a withdrawn log and on a log whose
    // grant names an unsupplied version, which are the two states this unit exists to get right.
    const optimistic = (records: readonly ConsentRecord[]): string =>
      records.some(
        (r) =>
          r.channel === CHANNEL &&
          r.purpose === PURPOSE &&
          r.kind === 'granted' &&
          r.recordedAt <= NOW,
      )
        ? 'granted'
        : 'unknown'

    const withdrawn: readonly ConsentRecord[] = [
      {
        id: 'a',
        channel: CHANNEL,
        purpose: PURPOSE,
        kind: 'granted',
        recordedAt: at(INSTANTS[0]),
        wordingId: 'w1',
      },
      {
        id: 'b',
        channel: CHANNEL,
        purpose: PURPOSE,
        kind: 'withdrawn',
        recordedAt: at(INSTANTS[1]),
        wordingId: null,
      },
    ]
    expect(optimistic(withdrawn)).toBe('granted')
    expect(resolveConsent(logOf(withdrawn), CHANNEL, PURPOSE, NOW).state).toBe('withdrawn')

    const strandedWording: readonly ConsentRecord[] = [
      {
        id: 'a',
        channel: CHANNEL,
        purpose: PURPOSE,
        kind: 'granted',
        recordedAt: at(INSTANTS[0]),
        wordingId: UNSUPPLIED_VERSION_ID,
      },
    ]
    expect(optimistic(strandedWording)).toBe('granted')
    expect(resolveConsent(logOf(strandedWording), CHANNEL, PURPOSE, NOW).state).toBe('unknown')
  })
})
