/**
 * The consent signal a request carries, and nothing about how it came to be there (A-FIRST-05).
 *
 * ## What this module is, and what it deliberately is not
 *
 * It is the **transport** of a decision the visitor has already made: a cookie name, the four Consent
 * Mode v2 signal names, and the parse that turns a `Cookie` header into the set of signals that were
 * granted. It is not the record of that decision. The record — the exact wording version shown, its
 * hash, the instant, the Arabic and English copy — is A-MEAS-02's, in the database, and docs/04 §8 is
 * what requires it to exist at all. Two things follow and both matter:
 *
 *   - **A cookie is not evidence of consent.** It is the browser telling the server what the visitor
 *     chose, on this device, a moment ago. So nothing here may be read as proof: the proof is the row.
 *   - **What the cookie may decide is bounded.** It gates one thing only — whether the visitor's OWN
 *     measurement may be stored under an identifier. It authorises no read, names no principal and
 *     reaches no other subject's data. That bound is what makes a client-supplied value acceptable here
 *     and unacceptable for anything a session cookie does (ADR 0039), and it is the same distinction
 *     ADR 0062 draws about a user agent: a claim may describe the claimant and may not authorise.
 *
 * ## Why absent means denied
 *
 * `analytics.session` and `analytics.visitor` are created **at** consent and never before it, which is
 * the stricter reading of Y5-analytics-basis this build takes while the lawful basis for the internal
 * store is open (docs/03, "A privacy distinction that must not be blurred"). A default of "granted" for
 * a missing cookie would make every first request an identified one, and a parse failure would do the
 * same thing quietly — so an absent cookie, an unreadable cookie and an empty cookie all resolve to the
 * same answer, and that answer is deny.
 *
 * ## No clock, and not even the word
 *
 * `scripts/check-core-purity.mjs` scans this directory with the scoped no-`Date`, no-`Intl` treatment. A
 * consent cookie's expiry is the browser's to enforce through `Max-Age`; a module that read an instant
 * out of the value and compared it to a clock would be a second, weaker expiry that disagreed with the
 * first for exactly as long as somebody's clock was wrong.
 */

/**
 * Google's four Consent Mode v2 signals, in the order Consent Mode itself lists them.
 *
 * These names are not ours to choose — they are the strings the outbound tags and the server-side push
 * are keyed on (docs/00 §"Consent Mode v2", A-MEAS-02), so spelling them differently here would produce
 * a store whose consent state could not be handed to the thing it gates. A-MEAS-02 captures all four;
 * this unit reads exactly one of them and says so out loud below.
 */
export const CONSENT_MODE_SIGNALS = [
  'ad_storage',
  'ad_user_data',
  'ad_personalization',
  'analytics_storage',
] as const

export type ConsentModeSignal = (typeof CONSENT_MODE_SIGNALS)[number]

/**
 * The one signal the internal first-party store is gated on.
 *
 * `analytics_storage` and not `ad_storage`, and the difference is the distinction docs/03 insists must
 * not be blurred: storing a measurement in our own database with no third-party sharing is a different
 * processing operation from pushing a hashed identifier to Meta. Gating the internal store on an
 * advertising signal would over-block reporting; gating the outbound push on this one would
 * under-protect the push. The push is A-MEAS-02's and A-MEAS-03's, and it reads the other three.
 */
export const ANALYTICS_STORAGE_SIGNAL: ConsentModeSignal = 'analytics_storage'

/**
 * The cookie the decision travels in.
 *
 * `berelax_consent`, matching `berelax_admin` and `berelax_book` — an underscore and not the colon
 * `berelax:theme` uses in `localStorage`, because RFC 6265 forbids a colon in a cookie name.
 *
 * NOT `HttpOnly`, and that is the one attribute worth arguing about: A-MEAS-02's banner is a client
 * component and has to be able to write it, and the gate that stops a tag loading runs in the browser and
 * has to be able to read it. Nothing is protected by hiding it from the page — it carries no credential
 * and no identifier, only which of four named signals its own owner agreed to.
 */
export const ANALYTICS_CONSENT_COOKIE = 'berelax_consent'

/**
 * How the granted signals are written in the value: the signal names, comma separated.
 *
 * A list of what was GRANTED rather than a map of granted-and-denied, because the absence of a signal
 * has to mean denied anyway — a truncated cookie, an older banner version, a signal added next year. One
 * representation for "not granted" instead of two.
 */
export const CONSENT_SIGNAL_SEPARATOR = ','

const isConsentModeSignal = (value: string): value is ConsentModeSignal =>
  (CONSENT_MODE_SIGNALS as readonly string[]).includes(value)

/**
 * One cookie's value out of a `Cookie` header, by exact name.
 *
 * Compared after trimming and by EQUALITY, never by prefix, for the reason `adminSessionTokenFrom`
 * records: a cookie called `berelax_consent_version` must not be read as this one, and a `startsWith` is
 * how that happens.
 */
function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (cookieHeader === null) return null
  for (const pair of cookieHeader.split(';')) {
    const index = pair.indexOf('=')
    if (index === -1) continue
    if (pair.slice(0, index).trim() !== name) continue
    const value = pair.slice(index + 1).trim()
    return value === '' ? null : value
  }
  return null
}

/**
 * The signals this request claims were granted.
 *
 * Total and never throwing: whatever arrives — nothing, an empty value, a name nobody defined, a
 * megabyte of punctuation — this returns a set, and an unrecognised entry is discarded rather than
 * treated as a grant. A collector posting `analytics_storage_denied` must not be read as granting
 * `analytics_storage`, which is what a substring test would do.
 */
export function grantedConsentSignals(cookieHeader: string | null): ReadonlySet<ConsentModeSignal> {
  const raw = cookieValue(cookieHeader, ANALYTICS_CONSENT_COOKIE)
  if (raw === null) return new Set()
  const granted = new Set<ConsentModeSignal>()
  for (const entry of raw.split(CONSENT_SIGNAL_SEPARATOR)) {
    const name = entry.trim().toLowerCase()
    if (isConsentModeSignal(name)) granted.add(name)
  }
  return granted
}

/**
 * Whether identified first-party measurement may be stored for this request.
 *
 * The one question `/api/collect` asks about consent, and the only place in this unit that asks it. A
 * boolean and not a nullable tri-state, because "denied" and "not yet decided" are the same instruction
 * to the ingest: do not create an identifier. They are NOT the same fact, and the difference is visible
 * where it is actionable — the pre-consent landing counter records the visit either way, so a funnel
 * still has a denominator, and A-MEAS-02's record is where a deliberate denial is distinguishable from
 * a banner nobody answered.
 */
export function analyticsStorageGranted(cookieHeader: string | null): boolean {
  return grantedConsentSignals(cookieHeader).has(ANALYTICS_STORAGE_SIGNAL)
}
