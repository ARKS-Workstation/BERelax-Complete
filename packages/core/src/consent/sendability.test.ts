import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import type { Instant } from '../time.ts'
import {
  resolveSuppression,
  SUPPRESSION_STATES,
  type SuppressionLog,
  type SuppressionRecord,
  suppressionGateEvaluator,
  suppressionKeyNormaliser,
} from './sendability.ts'

/**
 * C-CRM-04 — the suppression fold and the gate evaluator built over it.
 *
 * Every case here is paired with the one that must move if the fold stops working, because almost every
 * claim is about something NOT happening: a resolver that settles a tied timestamp is correct in every
 * fixed-order test, and an evaluator that answers `false` for a recipient it never read reports a clean
 * campaign run in which nothing was refused.
 */

const KEY = 'f'.repeat(64)
const T0 = 1_800_000_000_000 as Instant
const T1 = (T0 + 60_000) as Instant
const T2 = (T0 + 120_000) as Instant

const record = (overrides: Partial<SuppressionRecord> = {}): SuppressionRecord => ({
  id: 'record-1',
  kind: 'suppressed',
  source: 'manual',
  recordedAt: T1,
  ...overrides,
})

const log = (records: readonly SuppressionRecord[]): SuppressionLog => ({ key: KEY, records })

describe('resolveSuppression', () => {
  it('has two states, and the absence of a third is the point', () => {
    // A `suppression_unknown` state would be true of every contact this business has never heard of, and
    // a send path failing closed on it would refuse every message in the system. `resolveConsent` needs
    // its third state for the opposite reason: an empty consent log is not permission.
    expect(SUPPRESSION_STATES).toEqual(['suppressed', 'clear'])
  })

  it('reads an empty log as CLEAR, with a named reason', () => {
    const resolved = resolveSuppression(log([]), T2)
    expect(resolved.state).toBe('clear')
    expect(resolved.reason).toBe('no_record')
    expect(resolved.recordId).toBeNull()
  })

  it('reads a suppression as suppressed, and names the record and the source', () => {
    const resolved = resolveSuppression(log([record({ source: 'complaint' })]), T2)
    expect(resolved.state).toBe('suppressed')
    expect(resolved.reason).toBe('suppressed_by_record')
    expect(resolved.recordId).toBe('record-1')
    expect(resolved.source).toBe('complaint')
  })

  it('reads a later lift as clear, and the suppressing row is still in the log', () => {
    const records = [
      record({ id: 'a', recordedAt: T0 }),
      record({ id: 'b', kind: 'unsuppressed', source: 'manual', recordedAt: T1 }),
    ]
    const resolved = resolveSuppression(log(records), T2)
    expect(resolved.state).toBe('clear')
    expect(resolved.reason).toBe('unsuppressed_by_record')
    expect(resolved.recordId).toBe('b')
    // The control on "a lift is a new row": the log still holds both, and resolving at an EARLIER instant
    // reaches the suppression. A fold that had edited the first row could not answer both questions.
    expect(resolveSuppression(log(records), T0).state).toBe('suppressed')
  })

  it('ignores records after the instant asked about', () => {
    const records = [record({ id: 'a', recordedAt: T0 })]
    expect(resolveSuppression(log(records), T0).state).toBe('suppressed')
    // Before the record exists: nothing has been asked of this business yet.
    expect(resolveSuppression(log(records), (T0 - 1) as Instant).state).toBe('clear')
  })

  it('fails closed to SUPPRESSED on a tie, which is the opposite of what consent does', () => {
    const records = [
      record({ id: 'b', recordedAt: T1 }),
      record({ id: 'a', kind: 'unsuppressed', recordedAt: T1 }),
    ]
    const resolved = resolveSuppression(log(records), T2)
    expect(resolved.state).toBe('suppressed')
    expect(resolved.reason).toBe('ambiguous_timestamp')
    // Sorted, so the detail a caller logs does not depend on the order the log arrived in.
    expect(resolved.tiedRecordIds).toEqual(['a', 'b'])
    // The control: the same two records at DIFFERENT instants resolve to the later one, so the tie arm is
    // reached because of the tie and not because a lift never works.
    expect(
      resolveSuppression(
        log([
          record({ id: 'b', recordedAt: T0 }),
          record({ id: 'a', kind: 'unsuppressed', recordedAt: T1 }),
        ]),
        T2,
      ).state,
    ).toBe('clear')
  })

  it('fails closed to SUPPRESSED for a kind this build does not know', () => {
    const resolved = resolveSuppression(log([record({ kind: 'paused_until_further_notice' })]), T2)
    expect(resolved.state).toBe('suppressed')
    expect(resolved.reason).toBe('unknown_kind')
  })

  it('ignores a record with a non-finite instant rather than ordering on it', () => {
    const records = [
      record({ id: 'a', recordedAt: T0 }),
      record({ id: 'nonsense', kind: 'unsuppressed', recordedAt: Number.NaN as Instant }),
    ]
    // NaN compares false against everything, so a fold that did not filter would either drop the real
    // record or pick the nonsense one depending on the comparison it happened to use.
    expect(resolveSuppression(log(records), T2).recordId).toBe('a')
  })

  it('throws rather than answering when the caller cannot say WHEN', () => {
    // Not a resolution: answering `suppressed` would hide a bug at the call site behind a refusal that
    // looks correct, which is the one way a fail-closed default does harm.
    expect(() => resolveSuppression(log([record()]), Number.NaN as Instant)).toThrow(AppError)
    expect(() => resolveSuppression(log([record()]), Number.POSITIVE_INFINITY as Instant)).toThrow(
      /non-finite instant/,
    )
  })
})

describe('suppressionGateEvaluator', () => {
  const message = { channel: 'sms', recipient: '+971590009101' }

  it('answers true for a suppressed recipient and false for a clear one', () => {
    const suppressed = suppressionGateEvaluator({
      logs: new Map([[message.recipient, log([record()])]]),
      at: T2,
    })
    expect(suppressed(message)).toBe(true)
    // The positive control. An evaluator that answered true for everybody would satisfy the line above.
    const clear = suppressionGateEvaluator({
      logs: new Map([[message.recipient, log([])]]),
      at: T2,
    })
    expect(clear(message)).toBe(false)
  })

  it('THROWS for a recipient it has no log for, rather than answering false', () => {
    const evaluate = suppressionGateEvaluator({ logs: new Map(), at: T2 })
    // `false` here is the shorter, never-throwing version, and it turns a campaign whose recipient list
    // and suppression prefetch have drifted apart into a clean run that messaged everybody who opted out.
    expect(() => evaluate(message)).toThrow(/unread list is not a clearance/)
  })

  it('reads a Map rather than an object, so a prototype key cannot answer', () => {
    const evaluate = suppressionGateEvaluator({ logs: new Map(), at: T2 })
    for (const recipient of ['__proto__', 'constructor', 'toString']) {
      expect(() => evaluate({ channel: 'email', recipient })).toThrow(AppError)
    }
  })
})

describe('suppressionKeyNormaliser', () => {
  it('delegates to the one normaliser this system has', () => {
    const result = suppressionKeyNormaliser('phone', '0501234567')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Exactly what `normaliseBlocklistKey` produces, which delegates the UAE decision to B-LIFE-02's
    // normaliser. A second opinion about what canonical means would be a key nothing ever matches.
    expect(result.key).toEqual({ kind: 'phone', value: '+971501234567' })
    expect(suppressionKeyNormaliser('email', ' Guest@Example.COM ')).toEqual({
      ok: true,
      key: { kind: 'email', value: 'guest@example.com' },
    })
  })

  it('refuses a kind nobody declared, by name, rather than guessing one', () => {
    const result = suppressionKeyNormaliser('whatsapp', '+971501234567')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unknown_key_kind')
  })

  it('forwards the normaliser own refusal for a value that cannot be keyed', () => {
    const result = suppressionKeyNormaliser('phone', '042221234')
    expect(result.ok).toBe(false)
    if (result.ok) return
    // B-LIFE-02's verdict, passed through unchanged: a UAE landline is not an SMS target and this module
    // holds no second opinion about UAE number shapes.
    expect(result.reason).toBe('not_a_phone')
  })
})
