import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { type Instant, instantFromIso } from '../time.ts'
import type { ConsentLog, ConsentRecord, ConsentWordingVersion } from './resolve.ts'
import { consentGateEvaluator } from './send-permission.ts'

/**
 * The evaluator the promotional gate calls, and the distinction that is the whole reason it exists: a
 * `false` and a throw are different answers, and only one of them is a refusal.
 *
 * `evaluateGate` turns a throw into `blocked_unevaluable` with `evaluator: 'consent'` and a `false` into
 * `refused_no_consent`. The temptation is to return `false` for a recipient no log was read for — it is
 * fewer lines, it never throws, and every test passes. It is also the bug: a campaign whose recipient
 * list and consent prefetch have drifted apart then reports a clean run in which every message was
 * "refused for no consent", and nothing anywhere says the store was never asked.
 */
const at = (iso: string): Instant => instantFromIso(iso)
const NOW = at('2026-09-18T10:00:00.000Z')
const PHONE = '+971590000042'
const OTHER = '+971590000043'

const WORDING: ConsentWordingVersion = {
  id: 'w1',
  purpose: 'marketing',
  version: 1,
  contentHashHex: 'a'.repeat(64),
}

const record = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
  id: 'c1',
  channel: 'sms',
  purpose: 'marketing',
  kind: 'granted',
  recordedAt: at('2026-09-01T10:00:00.000Z'),
  wordingId: WORDING.id,
  ...over,
})

const logFor = (records: readonly ConsentRecord[]): ConsentLog => ({
  contactId: 'contact-1',
  records,
  wordingVersions: [WORDING],
})

const message = { channel: 'sms', recipient: PHONE }

describe('the evaluator answers true only for a resolved grant', () => {
  it('is true for a granted contact', () => {
    const hasConsent = consentGateEvaluator({
      logs: new Map([[PHONE, logFor([record()])]]),
      purpose: 'marketing',
      at: NOW,
    })
    expect(hasConsent(message)).toBe(true)
  })

  it('is false for a withdrawn contact', () => {
    const hasConsent = consentGateEvaluator({
      logs: new Map([
        [
          PHONE,
          logFor([
            record(),
            record({ id: 'c2', kind: 'withdrawn', wordingId: null, recordedAt: NOW }),
          ]),
        ],
      ]),
      purpose: 'marketing',
      at: NOW,
    })
    expect(hasConsent(message)).toBe(false)
  })

  it('is false for a contact with an empty log — a read that answered "never asked"', () => {
    const hasConsent = consentGateEvaluator({
      logs: new Map([[PHONE, logFor([])]]),
      purpose: 'marketing',
      at: NOW,
    })
    expect(hasConsent(message)).toBe(false)
  })

  it('is false when the wording version cannot be produced', () => {
    const hasConsent = consentGateEvaluator({
      logs: new Map([[PHONE, logFor([record({ wordingId: 'w-gone' })])]]),
      purpose: 'marketing',
      at: NOW,
    })
    expect(hasConsent(message)).toBe(false)
  })

  it('is false for the channel the grant is not about', () => {
    const hasConsent = consentGateEvaluator({
      logs: new Map([[PHONE, logFor([record({ channel: 'whatsapp' })])]]),
      purpose: 'marketing',
      at: NOW,
    })
    expect(hasConsent({ channel: 'sms', recipient: PHONE })).toBe(false)
    // The control: the same log answers true for the channel it IS about.
    expect(hasConsent({ channel: 'whatsapp', recipient: PHONE })).toBe(true)
  })
})

describe('an unread log is neither permission nor refusal', () => {
  it('throws for a recipient that is not in the prefetch', () => {
    const hasConsent = consentGateEvaluator({
      logs: new Map([[PHONE, logFor([record()])]]),
      purpose: 'marketing',
      at: NOW,
    })
    expect(() => hasConsent({ channel: 'sms', recipient: OTHER })).toThrow(AppError)
    expect(() => hasConsent({ channel: 'sms', recipient: OTHER })).toThrow(/drifted apart/)
    // The control, and the whole point of the case: the SAME evaluator answers `false` rather than
    // throwing for a recipient whose log was read and is empty. If both were `false`, a drifted campaign
    // and an un-consented contact would be one outcome.
    const withEmpty = consentGateEvaluator({
      logs: new Map([[OTHER, logFor([])]]),
      purpose: 'marketing',
      at: NOW,
    })
    expect(withEmpty({ channel: 'sms', recipient: OTHER })).toBe(false)
  })

  it('does not answer for inherited object keys', () => {
    // A `Map`, not a record. A plain object would answer for `constructor` and `toString`, and a
    // recipient string is arbitrary input from a contact list.
    const hasConsent = consentGateEvaluator({
      logs: new Map([[PHONE, logFor([record()])]]),
      purpose: 'marketing',
      at: NOW,
    })
    for (const key of ['constructor', 'toString', '__proto__']) {
      expect(() => hasConsent({ channel: 'sms', recipient: key })).toThrow(AppError)
    }
  })
})

describe('the purpose must be one a send may be gated on', () => {
  it('refuses a non-messaging purpose when the evaluator is built', () => {
    for (const purpose of ['clinical_processing', 'photography', 'not_a_purpose']) {
      expect(() => consentGateEvaluator({ logs: new Map(), purpose, at: NOW }), purpose).toThrow(
        AppError,
      )
    }
  })

  it('accepts the two that are, so the refusal above is not a blanket one', () => {
    for (const purpose of ['marketing', 'review_request']) {
      expect(() => consentGateEvaluator({ logs: new Map(), purpose, at: NOW })).not.toThrow()
    }
  })

  it('refuses at build time rather than on the message', () => {
    // Asserted because the alternative — checking inside the closure — would leave a campaign to
    // discover its own misconfiguration on message 200 of 400, with the first 199 already sent.
    let built = false
    try {
      consentGateEvaluator({ logs: new Map(), purpose: 'photography', at: NOW })
      built = true
    } catch {
      built = false
    }
    expect(built).toBe(false)
  })
})

describe('the point-in-time instant is the one supplied', () => {
  it('reads consent as at the given instant, not as at the newest record', () => {
    const hasConsent = consentGateEvaluator({
      logs: new Map([
        [
          PHONE,
          logFor([
            record(),
            record({
              id: 'c2',
              kind: 'withdrawn',
              wordingId: null,
              recordedAt: at('2026-09-20T10:00:00.000Z'),
            }),
          ]),
        ],
      ]),
      purpose: 'marketing',
      at: NOW,
    })
    // The withdrawal is after `NOW`, so as at `NOW` this contact was opted in.
    expect(hasConsent(message)).toBe(true)
    // The control: an evaluator built at a later instant sees it.
    const later = consentGateEvaluator({
      logs: new Map([
        [
          PHONE,
          logFor([
            record(),
            record({
              id: 'c2',
              kind: 'withdrawn',
              wordingId: null,
              recordedAt: at('2026-09-20T10:00:00.000Z'),
            }),
          ]),
        ],
      ]),
      purpose: 'marketing',
      at: at('2026-09-21T10:00:00.000Z'),
    })
    expect(later(message)).toBe(false)
  })
})
