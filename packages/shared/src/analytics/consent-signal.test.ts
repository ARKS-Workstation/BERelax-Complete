import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_STORAGE_SIGNAL,
  analyticsStorageGranted,
  CONSENT_MODE_SIGNALS,
  grantedConsentSignals,
} from './consent-signal.ts'

/**
 * The consent signal, and the one answer this unit takes from it.
 *
 * Every case here is about the DENY direction, because that is the one that has to hold: a parse that
 * answered "granted" for anything it could not read would make every first request an identified one, and
 * the failure would be invisible — the store would fill with rows that look exactly like consented rows.
 */

const granted = (value: string) => `${ANALYTICS_CONSENT_COOKIE}=${value}`

describe('reading the consent signal off a request', () => {
  it('grants analytics storage when the cookie names it', () => {
    expect(analyticsStorageGranted(granted('analytics_storage'))).toBe(true)
    expect(analyticsStorageGranted(granted('ad_storage,analytics_storage'))).toBe(true)
    expect(analyticsStorageGranted(granted(' analytics_storage , ad_user_data '))).toBe(true)
  })

  it('denies when there is no cookie, no header, or an empty value', () => {
    // Three spellings of "no decision", and all three are deny. The default is what docs/03's stricter
    // reading of Y5-analytics-basis requires and what A-MEAS-02's provisional states: all four signals
    // default to denied until an affirmative record exists.
    expect(analyticsStorageGranted(null)).toBe(false)
    expect(analyticsStorageGranted('')).toBe(false)
    expect(analyticsStorageGranted('berelax_admin=abc; berelax_book=def')).toBe(false)
    expect(analyticsStorageGranted(granted(''))).toBe(false)
  })

  it('denies when the cookie grants the other three signals and not this one', () => {
    // The distinction docs/03 says must not be blurred. Pushing a hashed identifier to Meta and storing a
    // page view in our own database are different processing operations, so a visitor who allowed
    // advertising and not measurement is a state the store has to be able to be in.
    const advertising = 'ad_storage,ad_user_data,ad_personalization'
    expect(analyticsStorageGranted(granted(advertising))).toBe(false)
    expect(grantedConsentSignals(granted(advertising)).size).toBe(3)
  })

  it('denies a value that merely CONTAINS the signal name', () => {
    // The control that the parse is by membership and not by substring. A collector posting
    // `analytics_storage_denied` must not be read as granting `analytics_storage`, and a `.includes()`
    // implementation would grant it — which is a consent gate opened by a string that says the opposite.
    expect(analyticsStorageGranted(granted('analytics_storage_denied'))).toBe(false)
    expect(analyticsStorageGranted(granted('not_analytics_storage'))).toBe(false)
    expect(analyticsStorageGranted(granted('xanalytics_storage'))).toBe(false)
  })

  it('reads the cookie by exact name, never by prefix', () => {
    // `berelax_consent_version` must not be read as this cookie. A `startsWith` here is how a differently
    // named cookie comes to decide whether an identifier is created.
    expect(analyticsStorageGranted('berelax_consent_version=analytics_storage')).toBe(false)
    expect(analyticsStorageGranted('xberelax_consent=analytics_storage')).toBe(false)
    // And it finds the cookie wherever it sits in the header.
    expect(analyticsStorageGranted(`a=1; ${ANALYTICS_CONSENT_COOKIE}=analytics_storage; z=2`)).toBe(
      true,
    )
  })

  it('never throws, and grants nothing, on arbitrary rubbish', () => {
    for (const value of [
      '=',
      ';;;',
      `${ANALYTICS_CONSENT_COOKIE}`,
      `${ANALYTICS_CONSENT_COOKIE}=,,,`,
      `${ANALYTICS_CONSENT_COOKIE}=${'x'.repeat(10_000)}`,
      `${ANALYTICS_CONSENT_COOKIE}=${'analytics_storage,'.repeat(500)}`,
    ]) {
      expect(() => analyticsStorageGranted(value)).not.toThrow()
    }
    expect(analyticsStorageGranted(`${ANALYTICS_CONSENT_COOKIE}=,,,`)).toBe(false)
    // The last one DOES grant it, repeated five hundred times — and the set collapses it to one, which is
    // why the answer is a set rather than a count.
    expect(
      grantedConsentSignals(`${ANALYTICS_CONSENT_COOKIE}=${'analytics_storage,'.repeat(500)}`).size,
    ).toBe(1)
  })

  it('is case-insensitive about the signal name and discards anything it does not know', () => {
    expect(analyticsStorageGranted(granted('ANALYTICS_STORAGE'))).toBe(true)
    const signals = grantedConsentSignals(granted('analytics_storage,invented_signal'))
    expect([...signals]).toEqual(['analytics_storage'])
  })

  it('names Google’s four signals, and gates the internal store on exactly one of them', () => {
    expect([...CONSENT_MODE_SIGNALS]).toEqual([
      'ad_storage',
      'ad_user_data',
      'ad_personalization',
      'analytics_storage',
    ])
    expect(ANALYTICS_STORAGE_SIGNAL).toBe('analytics_storage')
    expect(CONSENT_MODE_SIGNALS).toContain(ANALYTICS_STORAGE_SIGNAL)
  })
})
