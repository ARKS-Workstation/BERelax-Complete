import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Instant } from '../time.ts'
import { CONSENT_STATES, type ConsentResolution } from './resolve.ts'
import {
  resolveSendability,
  resolveSuppression,
  SUPPRESSION_STATES,
  type SuppressionLog,
  type SuppressionRecord,
} from './sendability.ts'

/**
 * C-CRM-04's precedence rule, as a property over the full cross product.
 *
 * The acceptance criterion is one sentence — *resolved sendability is `blocked` whenever any suppression
 * exists, with zero exceptions* — and the reason it is a property rather than a handful of cases is that
 * "zero exceptions" is a claim about every combination and a case list is a claim about the combinations
 * somebody thought of. There are 3 consent states × 2 suppression states × 5 unknown reasons × 2 kinds of
 * consent record, and the interesting cell is the one nobody writes a case for: a **granted, current,
 * correctly-worded** marketing consent against a suppression, which every intuition says should send.
 *
 * The second property is the one that makes the first mean something: the fold is insertion-order
 * independent. A resolver that settled a tie by taking whichever row the query returned first passes every
 * fixed-order case in `sendability.test.ts`, and only a shuffle can see it.
 */

const KEY = 'c'.repeat(64)
const BASE = 1_800_000_000_000
const AT = (BASE + 1_000_000) as Instant

/** Every consent resolution the resolver can produce, as data. */
const consentResolutions: readonly ConsentResolution[] = [
  {
    state: 'granted',
    recordId: 'consent-granted',
    recordedAtIso: '2026-01-01T00:00:00.000Z',
    wordingId: 'wording-1',
    wordingVersion: 1,
    wordingHashHex: 'a'.repeat(64),
  },
  { state: 'withdrawn', recordId: 'consent-withdrawn', recordedAtIso: '2026-01-02T00:00:00.000Z' },
  { state: 'unknown', reason: 'no_record', detail: 'never asked', tiedRecordIds: [] },
  {
    state: 'unknown',
    reason: 'wording_unresolvable',
    detail: 'the words shown cannot be produced',
    tiedRecordIds: [],
  },
  {
    state: 'unknown',
    reason: 'ambiguous_timestamp',
    detail: 'two records share the newest instant',
    tiedRecordIds: ['a', 'b'],
  },
]

/** Every suppression log shape that resolves to each state, so the cross product is over real folds. */
const suppressionLogs: readonly { readonly label: string; readonly log: SuppressionLog }[] = [
  { label: 'no records', log: { key: KEY, records: [] } },
  {
    label: 'suppressed',
    log: { key: KEY, records: [suppression('a', 'suppressed', 'complaint', BASE)] },
  },
  {
    label: 'suppressed then lifted',
    log: {
      key: KEY,
      records: [
        suppression('a', 'suppressed', 'complaint', BASE),
        suppression('b', 'unsuppressed', 'manual', BASE + 1000),
      ],
    },
  },
  {
    label: 'lifted then suppressed again',
    log: {
      key: KEY,
      records: [
        suppression('a', 'suppressed', 'complaint', BASE),
        suppression('b', 'unsuppressed', 'manual', BASE + 1000),
        suppression('c', 'suppressed', 'preference_centre', BASE + 2000),
      ],
    },
  },
  {
    label: 'tied at the newest instant',
    log: {
      key: KEY,
      records: [
        suppression('a', 'suppressed', 'complaint', BASE + 1000),
        suppression('b', 'unsuppressed', 'manual', BASE + 1000),
      ],
    },
  },
  {
    label: 'a kind this build does not know',
    log: { key: KEY, records: [suppression('a', 'quarantined', 'manual', BASE)] },
  },
]

function suppression(
  id: string,
  kind: string,
  source: string,
  recordedAt: number,
): SuppressionRecord {
  return { id, kind, source, recordedAt: recordedAt as Instant }
}

// An explicit timeout, because `vitest.config.ts` declares none and the default is 5,000 ms. That is
// ample for this on an idle machine and not ample under `pnpm coverage` on a box running several
// worktrees' suites at once — which is where three tests in this repository have already failed for
// want of a spare core rather than for want of correctness. The number is generous on purpose: it is
// a ceiling on a hang, not a performance budget, and nothing here measures a clock.
describe('the precedence rule, over the whole cross product', () => {
  it('blocks whenever a suppression exists, whatever the consent log says', () => {
    let blockedBySuppression = 0
    let sendable = 0
    for (const consent of consentResolutions) {
      for (const { label, log } of suppressionLogs) {
        const resolved = resolveSuppression(log, AT)
        const decision = resolveSendability({ consent, suppression: resolved })
        if (resolved.state === 'suppressed') {
          expect(decision.kind, `${consent.state} × ${label}`).toBe('blocked')
          if (decision.kind !== 'blocked') continue
          // Not merely blocked — blocked BY the suppression. A decision that named `no_consent` for a
          // suppressed contact would still be a refusal, and it would mean the precedence was an accident
          // of the order the two checks happen to run in.
          expect(decision.reason, `${consent.state} × ${label}`).toBe('suppressed')
          blockedBySuppression += 1
          continue
        }
        if (consent.state === 'granted') {
          expect(decision.kind, `${consent.state} × ${label}`).toBe('sendable')
          sendable += 1
          continue
        }
        expect(decision, `${consent.state} × ${label}`).toMatchObject({
          kind: 'blocked',
          reason: 'no_consent',
        })
      }
    }
    // The two controls, and they are what stop the whole loop passing vacuously. Without the second, a
    // `resolveSendability` that returned `blocked` unconditionally would satisfy every expectation above
    // — which is exactly the shape of the bug that makes a compliance gate look perfect.
    expect(blockedBySuppression).toBeGreaterThan(0)
    expect(sendable).toBeGreaterThan(0)
    // And the count is exact, so a state added to either vocabulary without a cell here fails rather than
    // silently going unexercised.
    expect(consentResolutions.length * suppressionLogs.length).toBe(
      CONSENT_STATES.length * SUPPRESSION_STATES.length * 5,
    )
  })

  it('never sends to a suppressed recipient, over a thousand random logs', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 6 }),
            kind: fc.constantFrom('suppressed', 'unsuppressed'),
            source: fc.constantFrom('manual', 'complaint', 'hard_bounce', 'dnc_register'),
            offset: fc.integer({ min: 0, max: 5000 }),
          }),
          { maxLength: 8 },
        ),
        fc.integer({ min: 0, max: consentResolutions.length - 1 }),
        (records, consentIndex) => {
          const log: SuppressionLog = {
            key: KEY,
            records: records.map((r) => suppression(r.id, r.kind, r.source, BASE + r.offset)),
          }
          const resolved = resolveSuppression(log, AT)
          const consent = consentResolutions[consentIndex] as ConsentResolution
          const decision = resolveSendability({ consent, suppression: resolved })
          if (resolved.state === 'suppressed') return decision.kind === 'blocked'
          // The other direction, which is the half that keeps the property from being satisfied by a
          // function that blocks everything: a clear key with a granted consent MUST send.
          return consent.state === 'granted'
            ? decision.kind === 'sendable'
            : decision.kind === 'blocked'
        },
      ),
      { numRuns: 1000 },
    )
  }, 30_000)
})

describe('the fold is insertion-order independent', () => {
  it('resolves identically over a thousand shuffles of one record set', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 8 }),
            kind: fc.constantFrom('suppressed', 'unsuppressed'),
            source: fc.constantFrom('manual', 'complaint', 'preference_centre'),
            // Distinct offsets are NOT enforced: a tie is the case the property exists for, and a
            // generator that avoided one would prove order-independence only where it is easy.
            offset: fc.integer({ min: 0, max: 20 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (records) => {
          type Generated = (typeof records)[number]
          const build = (order: readonly Generated[]): SuppressionLog => ({
            key: KEY,
            records: order.map((r) => suppression(r.id, r.kind, r.source, BASE + r.offset)),
          })
          const first = resolveSuppression(build(records), AT)
          // Reversed and rotated rather than randomly shuffled inside the property: fast-check is already
          // generating the set, and two deterministic permutations per case make a counterexample
          // reproducible rather than a report about a shuffle nobody can repeat.
          const reversed = resolveSuppression(build([...records].reverse()), AT)
          const rotated = resolveSuppression(
            build([...records.slice(1), records[0] as Generated]),
            AT,
          )
          for (const other of [reversed, rotated]) {
            if (other.state !== first.state) return false
            if (other.reason !== first.reason) return false
            if (other.recordId !== first.recordId) return false
            if (other.tiedRecordIds.join(',') !== first.tiedRecordIds.join(',')) return false
          }
          return true
        },
      ),
      { numRuns: 1000 },
    )
  }, 30_000)
})
