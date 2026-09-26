/**
 * The edge wiring: what happens when a store was not read about a recipient, and when it was read too
 * shallowly.
 *
 * These are the two failures that look like success. A recipient the prefetch missed and a ledger read
 * whose horizon is too new both produce a plausible answer from a correct evaluator, and in both cases the
 * plausible answer is the permissive one. `invariants.property.test.ts` drives the states the stores DO
 * know about; this file drives the two ways they do not know.
 */
import {
  type ConsentLog,
  type ConsentRecord,
  frequencyLedgerHorizonSeconds,
  type Instant,
  instantFromIso,
  PROVISIONAL_FREQUENCY_CAPS,
  type SuppressionLog,
} from '@berelax/core'
import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import type { MessageId, OutboundMessage } from '../port.ts'
import { promotionalGateEvaluators } from './wire.ts'

const RECIPIENT = '+971528239069'
const OTHER = '+971500000001'
const AT = instantFromIso('2026-09-18T10:00:00.000Z')
const HORIZON_SECONDS = frequencyLedgerHorizonSeconds(PROVISIONAL_FREQUENCY_CAPS)
const REACHES_BACK = (AT - HORIZON_SECONDS * 1000) as Instant

/**
 * The grant, named separately so a case that needs to re-date it does not have to index into the log.
 *
 * `records[0]` is `ConsentRecord | undefined` under `noUncheckedIndexedAccess`, and the first version of the
 * one-instant case below spread `GRANTED.records[0] as never` to get past that — which vitest happily ran
 * (it transpiles, it does not typecheck) while `pnpm typecheck` died on TS2698 at step 2 of 38. Brief rule
 * 28, in the file that was written last.
 */
const GRANT: ConsentRecord = {
  id: 'consent-1',
  channel: 'sms',
  purpose: 'marketing',
  kind: 'granted',
  recordedAt: instantFromIso('2026-01-05T08:00:00.000Z'),
  wordingId: 'wording-1',
}

const GRANTED: ConsentLog = {
  contactId: 'c1',
  records: [GRANT],
  wordingVersions: [
    { id: 'wording-1', purpose: 'marketing', version: 3, contentHashHex: 'a'.repeat(64) },
  ],
}

const CLEAR: SuppressionLog = { key: 'hmac', records: [] }

const message = (recipient: string): OutboundMessage => ({
  id: 'm1' as MessageId,
  channel: 'sms',
  messageClass: 'promotional',
  recipient,
  body: 'Two treatments for the price of one at BE RELAX this week.',
  templateKey: 'campaign.offer',
  locale: 'en',
})

const wire = (overrides: Record<string, unknown> = {}) =>
  promotionalGateEvaluators({
    purpose: 'marketing',
    at: AT,
    reads: {
      consentLogs: new Map([[RECIPIENT, GRANTED]]),
      suppressionLogs: new Map([[RECIPIENT, CLEAR]]),
      ledgerCountedAt: new Map<string, readonly Instant[]>([[RECIPIENT, []]]),
      ledgerReadFrom: REACHES_BACK,
      ...overrides,
    },
  })

describe('a store that was not read about a recipient is not a clearance', () => {
  it('answers for the recipient it read, so the throws below are not the only behaviour', () => {
    const evaluators = wire()
    expect(evaluators.hasConsent(message(RECIPIENT))).toBe(true)
    expect(evaluators.isSuppressed(message(RECIPIENT))).toBe(false)
    expect(evaluators.frequencyCapReached(message(RECIPIENT))).toBe(false)
  })

  it('throws for a recipient missing from each of the three prefetches, one at a time', () => {
    // One at a time, because a single case with all three missing would pass if only one of the three
    // threw. The recipient list and the prefetch drifting apart is the realistic fault — a campaign whose
    // audience query and whose consent query filter differently by a row somebody archived — and a
    // campaign that answered `false` for every recipient it missed would report a clean run having sent to
    // exactly the contacts it knew least about.
    const evaluators = wire()
    expect(() => evaluators.hasConsent(message(OTHER))).toThrow(AppError)
    expect(() => evaluators.hasConsent(message(OTHER))).toThrow(/No consent log was prefetched/)
    expect(() => evaluators.isSuppressed(message(OTHER))).toThrow(
      /No suppression log was prefetched/,
    )
    expect(() => evaluators.frequencyCapReached(message(OTHER))).toThrow(
      /No frequency-ledger state was prefetched/,
    )
  })

  it('answers false for a TRANSACTIONAL message the cap prefetch never mentioned', () => {
    // The gate returns `allow` before ever calling this, so the case is unreachable from a send — which is
    // exactly why it is asserted. A missing prefetch entry must not be able to turn an OTP into a refusal
    // through a path nobody exercises.
    const evaluators = wire()
    expect(
      evaluators.frequencyCapReached({ ...message(OTHER), messageClass: 'transactional' }),
    ).toBe(false)
  })
})

describe('a ledger read that does not reach back far enough is refused at assembly', () => {
  it('refuses a horizon one millisecond short of the widest cap window', () => {
    // One millisecond, not a day. The interesting version of this fault is a read that is very nearly deep
    // enough — a caller using the WEEK window because that is the cap they were thinking about — and the
    // symptom is a plausible count that is simply too low. Refusing at assembly time makes it a
    // configuration error where the read was configured, rather than a refusal on the first promotional
    // message after both other prefetches have been paid for.
    expect(() => wire({ ledgerReadFrom: (REACHES_BACK + 1) as Instant })).toThrow(AppError)
    expect(() => wire({ ledgerReadFrom: (REACHES_BACK + 1) as Instant })).toThrow(
      /does not reach back to/,
    )
  })

  it('accepts a horizon exactly at the window start, and one that reaches further', () => {
    // The boundary is inclusive, and the control that stops the refusal above being "any horizon is
    // refused": a read exactly at the window start misses nothing.
    expect(() => wire()).not.toThrow()
    expect(() => wire({ ledgerReadFrom: (REACHES_BACK - 86_400_000) as Instant })).not.toThrow()
  })

  it('refuses a read deep enough for the week cap but not for the month cap', () => {
    // The realistic spelling of the fault, in the caps' own terms rather than in milliseconds.
    const weekOnly = (AT - 7 * 86_400_000) as Instant
    expect(() => wire({ ledgerReadFrom: weekOnly })).toThrow(/does not reach back to/)
    expect(HORIZON_SECONDS).toBe(30 * 86_400)
  })
})

describe('the purpose is validated once, when the evaluators are built', () => {
  it('refuses a purpose a promotional send may not be gated on', () => {
    // `clinical_processing` is the lawful basis for holding an intake form, not permission to message
    // anybody, and a gate built on one would allow every send while looking entirely correct. Validated at
    // assembly rather than per message: discovering it on message 200 of 400 leaves 199 already sent.
    expect(() =>
      promotionalGateEvaluators({
        purpose: 'clinical_processing',
        at: AT,
        reads: {
          consentLogs: new Map([[RECIPIENT, GRANTED]]),
          suppressionLogs: new Map([[RECIPIENT, CLEAR]]),
          ledgerCountedAt: new Map<string, readonly Instant[]>([[RECIPIENT, []]]),
          ledgerReadFrom: REACHES_BACK,
        },
      }),
    ).toThrow(/not a purpose a promotional send may be gated on/)
  })

  it('accepts the two purposes that do gate a send', () => {
    for (const purpose of ['marketing', 'review_request']) {
      expect(() =>
        promotionalGateEvaluators({
          purpose,
          at: AT,
          reads: {
            consentLogs: new Map([[RECIPIENT, GRANTED]]),
            suppressionLogs: new Map([[RECIPIENT, CLEAR]]),
            ledgerCountedAt: new Map<string, readonly Instant[]>([[RECIPIENT, []]]),
            ledgerReadFrom: REACHES_BACK,
          },
        }),
      ).not.toThrow()
    }
  })
})

describe('the three evaluators decide at ONE instant', () => {
  it('reads the same instant for consent, suppression and the cap', () => {
    // Consent can expire, a suppression can be withdrawn and a ledger window rolls. Three evaluators
    // reading three clocks can answer about three different moments, and the combination that lets a
    // message through is the one where each read happened to be on the permissive side of its own
    // boundary. A consent granted at T and a suppression recorded at T is the pair that shows it: at T
    // both apply, so consent is granted and suppression suppresses, and there is no instant at which the
    // first is true and the second is not.
    const recordedAt = instantFromIso('2026-09-18T10:00:00.000Z')
    const evaluators = promotionalGateEvaluators({
      purpose: 'marketing',
      at: recordedAt,
      reads: {
        consentLogs: new Map([[RECIPIENT, { ...GRANTED, records: [{ ...GRANT, recordedAt }] }]]),
        suppressionLogs: new Map([
          [
            RECIPIENT,
            {
              key: 'hmac',
              records: [{ id: 's1', kind: 'phone', source: 'dnc_register', recordedAt }],
            },
          ],
        ]),
        ledgerCountedAt: new Map<string, readonly Instant[]>([[RECIPIENT, []]]),
        ledgerReadFrom: (recordedAt - HORIZON_SECONDS * 1000) as Instant,
      },
    })

    expect(evaluators.hasConsent(message(RECIPIENT))).toBe(true)
    expect(evaluators.isSuppressed(message(RECIPIENT))).toBe(true)
  })
})
