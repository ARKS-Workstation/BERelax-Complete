import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { type Instant, instantFromIso } from '../time.ts'
import {
  CONSENT_STATES,
  CONSENT_UNKNOWN_REASONS,
  type ConsentLog,
  type ConsentRecord,
  type ConsentWordingVersion,
  resolveConsent,
} from './resolve.ts'

/**
 * C-CRM-03 — the cases `resolve.property.test.ts` cannot state as properties.
 *
 * The properties next door prove the two claims that have to hold over every input: insertion-order
 * independence, and that `unknown` is returned rather than `granted` whenever the log cannot answer.
 * What is here is the behaviour a property would obscure — which record wins, what a withdrawal looks
 * like, what happens either side of the instant asked about — and, in every case, the **control** that
 * would pass if the assertion were vacuous.
 */
const at = (iso: string): Instant => instantFromIso(iso)

const WORDING: ConsentWordingVersion = {
  id: 'w1',
  purpose: 'marketing',
  version: 1,
  contentHashHex: 'a'.repeat(64),
}
const WORDING_V2: ConsentWordingVersion = {
  id: 'w2',
  purpose: 'marketing',
  version: 2,
  contentHashHex: 'b'.repeat(64),
}

const grant = (id: string, iso: string, wordingId: string | null = WORDING.id): ConsentRecord => ({
  id,
  channel: 'sms',
  purpose: 'marketing',
  kind: 'granted',
  recordedAt: at(iso),
  wordingId,
})

const withdrawal = (id: string, iso: string): ConsentRecord => ({
  id,
  channel: 'sms',
  purpose: 'marketing',
  kind: 'withdrawn',
  recordedAt: at(iso),
  wordingId: null,
})

const log = (
  records: readonly ConsentRecord[],
  wordingVersions: readonly ConsentWordingVersion[] = [WORDING, WORDING_V2],
): ConsentLog => ({ contactId: 'contact-1', records, wordingVersions })

describe('the three states are exactly three, and unknown is one of them', () => {
  it('declares granted, withdrawn and unknown, and nothing else', () => {
    expect([...CONSENT_STATES]).toEqual(['granted', 'withdrawn', 'unknown'])
    expect([...CONSENT_UNKNOWN_REASONS]).toEqual([
      'no_record',
      'wording_unresolvable',
      'ambiguous_timestamp',
    ])
  })
})

describe('the newest applicable record decides', () => {
  it('resolves a lone grant, carrying the wording version it was given under', () => {
    const answer = resolveConsent(
      log([grant('c1', '2026-09-01T10:00:00Z')]),
      'sms',
      'marketing',
      at('2026-09-18T10:00:00Z'),
    )
    expect(answer.state).toBe('granted')
    if (answer.state !== 'granted') throw new Error('unreachable')
    expect(answer.recordId).toBe('c1')
    expect(answer.wordingVersion).toBe(1)
    expect(answer.wordingHashHex).toBe(WORDING.contentHashHex)
    expect(answer.recordedAtIso).toBe('2026-09-01T10:00:00.000Z')
  })

  it('resolves a grant then a withdrawal as withdrawn, and the grant is still in the log', () => {
    const records = [grant('c1', '2026-09-01T10:00:00Z'), withdrawal('c2', '2026-09-02T10:00:00Z')]
    const answer = resolveConsent(log(records), 'sms', 'marketing', at('2026-09-18T10:00:00Z'))
    expect(answer.state).toBe('withdrawn')
    if (answer.state !== 'withdrawn') throw new Error('unreachable')
    expect(answer.recordId).toBe('c2')
    // The append-only claim, asserted on the data rather than described: the granting record is
    // untouched, which is what makes the withdrawal a new row rather than an edit.
    expect(records[0]).toEqual(grant('c1', '2026-09-01T10:00:00Z'))
  })

  it('resolves a withdrawal then a re-grant as granted, under the NEW wording version', () => {
    // The control on the case above, and the realistic sequence: somebody opts out, then opts back in
    // at the front desk months later, by which time the statement has been reworded.
    const answer = resolveConsent(
      log([
        grant('c1', '2026-09-01T10:00:00Z'),
        withdrawal('c2', '2026-09-02T10:00:00Z'),
        grant('c3', '2026-09-10T10:00:00Z', WORDING_V2.id),
      ]),
      'sms',
      'marketing',
      at('2026-09-18T10:00:00Z'),
    )
    expect(answer.state).toBe('granted')
    if (answer.state !== 'granted') throw new Error('unreachable')
    expect(answer.wordingVersion).toBe(2)
    expect(answer.wordingHashHex).toBe(WORDING_V2.contentHashHex)
  })
})

describe('it is a point-in-time function', () => {
  it('ignores a withdrawal recorded after the instant asked about', () => {
    const records = [grant('c1', '2026-09-01T10:00:00Z'), withdrawal('c2', '2026-09-20T10:00:00Z')]
    // As at the 10th, the contact was opted in. A resolver that read the whole log would report every
    // historical send as non-compliant the moment somebody later opted out.
    expect(resolveConsent(log(records), 'sms', 'marketing', at('2026-09-10T10:00:00Z')).state).toBe(
      'granted',
    )
    // The control: at an instant after it, the same log answers withdrawn.
    expect(resolveConsent(log(records), 'sms', 'marketing', at('2026-09-21T10:00:00Z')).state).toBe(
      'withdrawn',
    )
  })

  it('includes a record made at exactly the instant asked about', () => {
    const answer = resolveConsent(
      log([grant('c1', '2026-09-10T10:00:00Z')]),
      'sms',
      'marketing',
      at('2026-09-10T10:00:00Z'),
    )
    expect(answer.state).toBe('granted')
    // The control on the boundary being inclusive rather than accidental: one millisecond earlier and
    // the same record is not yet evidence.
    expect(
      resolveConsent(
        log([grant('c1', '2026-09-10T10:00:00Z')]),
        'sms',
        'marketing',
        at('2026-09-10T09:59:59.999Z'),
      ).state,
    ).toBe('unknown')
  })

  it('refuses a non-finite instant rather than answering unknown', () => {
    // `unknown` here would be indistinguishable from a contact nobody had asked, and the actual fault
    // is a caller with no clock. Asserted because `NaN <= NaN` is false, so the filter would silently
    // empty the log and the function would answer "never asked" for every contact in the campaign.
    expect(() =>
      resolveConsent(
        log([grant('c1', '2026-09-01T10:00:00Z')]),
        'sms',
        'marketing',
        NaN as Instant,
      ),
    ).toThrow(AppError)
    // A record with a broken instant is skipped rather than throwing: one bad row must not make the
    // rest of the log unreadable. Skipping it leaves nothing, which is `unknown` — fail closed.
    const broken: ConsentRecord = {
      ...grant('c1', '2026-09-01T10:00:00Z'),
      recordedAt: NaN as Instant,
    }
    expect(
      resolveConsent(log([broken]), 'sms', 'marketing', at('2026-09-18T10:00:00Z')).state,
    ).toBe('unknown')
  })
})

describe('channel and purpose are both part of the question', () => {
  it('does not answer for a channel the record is not about', () => {
    const records = [grant('c1', '2026-09-01T10:00:00Z')] // sms
    expect(resolveConsent(log(records), 'sms', 'marketing', at('2026-09-18T10:00:00Z')).state).toBe(
      'granted',
    )
    // The whole reason consent is per channel: a client who agreed to WhatsApp did not agree to SMS.
    expect(
      resolveConsent(log(records), 'whatsapp', 'marketing', at('2026-09-18T10:00:00Z')).state,
    ).toBe('unknown')
    expect(
      resolveConsent(log(records), 'sms', 'review_request', at('2026-09-18T10:00:00Z')).state,
    ).toBe('unknown')
  })

  it('does not let a withdrawal on one purpose withdraw another', () => {
    const answer = resolveConsent(
      log([
        grant('c1', '2026-09-01T10:00:00Z'),
        {
          id: 'c2',
          channel: 'sms',
          purpose: 'review_request',
          kind: 'withdrawn',
          recordedAt: at('2026-09-05T10:00:00Z'),
          wordingId: null,
        },
      ]),
      'sms',
      'marketing',
      at('2026-09-18T10:00:00Z'),
    )
    expect(answer.state).toBe('granted')
  })
})

describe('an unresolvable wording version is unknown, not granted', () => {
  it('reports wording_unresolvable when the version is not among those supplied', () => {
    const answer = resolveConsent(
      log([grant('c1', '2026-09-01T10:00:00Z', 'w-missing')]),
      'sms',
      'marketing',
      at('2026-09-18T10:00:00Z'),
    )
    expect(answer.state).toBe('unknown')
    if (answer.state !== 'unknown') throw new Error('unreachable')
    expect(answer.reason).toBe('wording_unresolvable')
    expect(answer.detail).toContain('w-missing')
  })

  it('reports wording_unresolvable for a grant that names no version at all', () => {
    const answer = resolveConsent(
      log([grant('c1', '2026-09-01T10:00:00Z', null)]),
      'sms',
      'marketing',
      at('2026-09-18T10:00:00Z'),
    )
    expect(answer.state).toBe('unknown')
    if (answer.state !== 'unknown') throw new Error('unreachable')
    expect(answer.reason).toBe('wording_unresolvable')
  })

  it('still resolves a WITHDRAWAL that names no version', () => {
    // The asymmetry the schema fences with `consent_grant_carries_its_wording`. A withdrawal taken over
    // the phone has no wording version, and refusing to resolve it would leave a contact who asked to
    // be left alone reading as `unknown` — which is safe here only by luck, and would be `granted` the
    // moment an earlier grant existed.
    const answer = resolveConsent(
      log([grant('c1', '2026-09-01T10:00:00Z'), withdrawal('c2', '2026-09-05T10:00:00Z')]),
      'sms',
      'marketing',
      at('2026-09-18T10:00:00Z'),
    )
    expect(answer.state).toBe('withdrawn')
  })
})

describe('a tie on the newest instant is unknown', () => {
  it('names the tied records rather than picking one', () => {
    const answer = resolveConsent(
      log([grant('c2', '2026-09-05T10:00:00Z'), withdrawal('c1', '2026-09-05T10:00:00Z')]),
      'sms',
      'marketing',
      at('2026-09-18T10:00:00Z'),
    )
    expect(answer.state).toBe('unknown')
    if (answer.state !== 'unknown') throw new Error('unreachable')
    expect(answer.reason).toBe('ambiguous_timestamp')
    // Sorted, so the detail does not depend on the order the log arrived in either.
    expect(answer.tiedRecordIds).toEqual(['c1', 'c2'])
  })

  it('is unknown even when both tied records agree', () => {
    // Deliberately stricter than it has to be. Two identical grants at one instant could be resolved as
    // `granted`, and the rule "any tie is unknown" is both simpler to prove as a property and the one
    // that cannot be got wrong: the version with an exception is the version somebody widens.
    const answer = resolveConsent(
      log([grant('c1', '2026-09-05T10:00:00Z'), grant('c2', '2026-09-05T10:00:00Z')]),
      'sms',
      'marketing',
      at('2026-09-18T10:00:00Z'),
    )
    expect(answer.state).toBe('unknown')
  })

  it('resolves normally when an older tie has been settled by a later record', () => {
    // The control on the rule above, and the reason it is scoped to the NEWEST instant. A resolver that
    // gave up on any historical tie would leave one clash at the front desk permanently unresolvable,
    // and the append-only table offers no way to remove the clashing rows.
    const answer = resolveConsent(
      log([
        grant('c1', '2026-09-05T10:00:00Z'),
        withdrawal('c2', '2026-09-05T10:00:00Z'),
        grant('c3', '2026-09-06T10:00:00Z'),
      ]),
      'sms',
      'marketing',
      at('2026-09-18T10:00:00Z'),
    )
    expect(answer.state).toBe('granted')
    if (answer.state !== 'granted') throw new Error('unreachable')
    expect(answer.recordId).toBe('c3')
  })
})

describe('an empty log is no_record', () => {
  it('reports no_record with the instant asked about', () => {
    const answer = resolveConsent(log([]), 'sms', 'marketing', at('2026-09-18T10:00:00Z'))
    expect(answer.state).toBe('unknown')
    if (answer.state !== 'unknown') throw new Error('unreachable')
    expect(answer.reason).toBe('no_record')
    expect(answer.detail).toContain('2026-09-18T10:00:00.000Z')
    expect(answer.tiedRecordIds).toEqual([])
  })
})
