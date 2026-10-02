import {
  CONSENT_MODE_SIGNALS,
  type ConsentModeSignal,
  grantedConsentSignals,
} from '@berelax/shared'

/**
 * The consent gate (A-MEAS-02): one decision, asked in two places, with one answer.
 *
 * ## The defect this module's SHAPE exists to prevent
 *
 * Both halves of this unit's title are gates — "client tags never load and server dispatches never
 * enqueue without the matching signal" — and the obvious way to build that is two gates, one in the tag
 * loader and one in the dispatch writer. Two gates is two statements of the same fact, and a second
 * statement of a fact drifts: the day Meta's Conversions API starts needing a signal the pixel does not,
 * one of the two is edited and the other is not, and the symptom is not an error. It is an outbound push
 * that happens while the on-page tag correctly refuses, for a visitor who said no.
 *
 * So there is ONE function, {@link gateConsent}, and {@link CONSENT_GATED_TARGETS} is the one table of
 * which target needs which signal. The two call sites differ only in where the STATE comes from:
 *
 *   - a **client tag** is gated on the `berelax_consent` cookie, in the browser, before first paint —
 *     {@link mayLoadClientTag};
 *   - a **server dispatch** is gated on the four signal columns `analytics.session` recorded for the
 *     session the dispatch is about, because a dispatch is enqueued by a booking or a payment where
 *     there is no cookie to read — {@link gateConsent} over {@link consentStateFromSessionRow}.
 *
 * A-FIRST-05 already owns the one question `/api/collect` asks (`analyticsStorageGranted`: may this
 * request's own measurement be stored under an identifier). This module does not re-answer it; it imports
 * `grantedConsentSignals` and gates the other three signals on top, which is the division ADR 0066 and
 * `consent-signal.ts` both state in so many words.
 *
 * ## Absent, unreadable and denied are one answer, and that answer is DENY
 *
 * Every resolver here fails CLOSED. No record, an empty record, a record whose signal names nobody
 * defined, a boolean column that arrived as the string `'f'` from a driver that did not coerce, a number,
 * a null: all of them resolve to the same empty state, and an empty state permits nothing. A gate that
 * defaults to granted is a gate that opens by accident, and the accident is silent — nothing errors, the
 * tag loads, the push goes out, and the only evidence is in somebody else's ad account.
 *
 * `=== true` is the whole of {@link consentStateFromSessionRow}, and it is not fussiness. `'false'`,
 * `'f'`, `'0'`, `0`, `1` and `'true'` are all truthy or all falsy in ways that differ between drivers,
 * and three of those six spellings are what a boolean column reads back as somewhere in this stack. A
 * truthiness test would read `'f'` as consent.
 *
 * ## No host, no vendor endpoint, and that is enforced elsewhere
 *
 * A target is an opaque id. `scripts/check-egress-guard.mjs` rule 6 refuses any module that names an
 * analytics destination host outside `DECLARED_ADAPTERS`, which is empty until A-MEAS-03 writes the
 * adapters — so this table maps ids to SIGNALS and says nothing about where a payload goes. The hosts
 * appear in exactly one place in this repository, and it is the integration spec that asserts no request
 * reaches them, which is the enforcement rather than a leak.
 *
 * ## Pure
 *
 * No clock, no I/O, no configuration. That last one is an acceptance line rather than a nicety: the gate
 * is code and not configuration, and `packages/fixtures/src/consent-gate-arch.test.ts` enumerates every
 * setting key and every environment variable this build has and asserts that none of them appears
 * anywhere in this module's estate.
 */

/** Which of the two surfaces a gated target is on. The STATE's source differs; the decision does not. */
export const CONSENT_GATE_SURFACES = ['client_tag', 'server_dispatch'] as const
export type ConsentGateSurface = (typeof CONSENT_GATE_SURFACES)[number]

export interface ConsentGatedTarget {
  readonly surface: ConsentGateSurface
  /**
   * The Consent Mode v2 signals this target may not act without, ALL of them.
   *
   * `every` and not `some`: a target that needed any one of two signals would be permitted by the weaker
   * grant, and the weaker grant is the one a visitor who read the banner carefully gave.
   */
  readonly requires: readonly ConsentModeSignal[]
  /** Why these signals and not others. Read by nobody and the reason the table is reviewable. */
  readonly why: string
}

/**
 * Every target the gate governs, and the signal each one needs.
 *
 * The signal NAMES are Google's and not ours (`CONSENT_MODE_SIGNALS`, A-FIRST-05). The MAPPING below is
 * this build's decision and is what ADR 0076 records, because it is the one thing here that could
 * reasonably have been decided another way:
 *
 *   - an **analytics** tag or push measures use and is gated on `analytics_storage`;
 *   - an **advertising** tag sets and reads advertising storage in the browser, so it is gated on
 *     `ad_storage`, and it passes the visitor's own data to an advertising service, so it is gated on
 *     `ad_user_data` as well;
 *   - a **server-side advertising push** sets nothing in any browser, so `ad_storage` does not apply to
 *     it — what it does is send the visitor's data to an advertising service, which is `ad_user_data`,
 *     and that is this unit's acceptance line in so many words.
 *
 * `ad_personalization` governs whether the data may be used to personalise advertising, which is a
 * decision the receiving platform makes and this build does not take. It is CAPTURED on every record and
 * forwarded as part of the state, and it gates nothing here — stated rather than omitted, because a
 * signal collected and never used looks like an oversight, and because the unit that forwards the state
 * to a platform (A-MEAS-03) is the one that has to pass it on.
 */
export const CONSENT_GATED_TARGETS = Object.freeze({
  analytics_tag: Object.freeze({
    surface: 'client_tag',
    requires: Object.freeze(['analytics_storage'] as const),
    why: 'An on-page measurement tag stores a measurement identifier in the browser and reads it back.',
  }),
  advertising_tag: Object.freeze({
    surface: 'client_tag',
    requires: Object.freeze(['ad_storage', 'ad_user_data'] as const),
    why:
      'An on-page advertising tag both writes advertising storage in the browser (ad_storage) and ' +
      'passes what it observes to an advertising service (ad_user_data), so it needs both.',
  }),
  analytics_measurement_push: Object.freeze({
    surface: 'server_dispatch',
    requires: Object.freeze(['analytics_storage'] as const),
    why: 'A server-side measurement push records the same measurement the on-page tag would have.',
  }),
  advertising_conversion_push: Object.freeze({
    surface: 'server_dispatch',
    requires: Object.freeze(['ad_user_data'] as const),
    why:
      'A server-side conversion push sets nothing in any browser, so ad_storage does not describe it. ' +
      "What it does is send the visitor's own data to an advertising service, which is ad_user_data.",
  }),
} satisfies Record<string, ConsentGatedTarget>)

export type ConsentGatedTargetId = keyof typeof CONSENT_GATED_TARGETS & string

/**
 * One target by id, for an id that is a plain `string`.
 *
 * The table is declared with LITERAL keys rather than annotated `Record<string, …>`, so
 * `CONSENT_GATED_TARGETS.advertising_tag` is checked at compile time and a typo'd target written into the
 * tag loader is a tsc error. The cost is that a lookup by a runtime string needs this helper, and that is
 * the right trade: the ids that appear in code are literals, and the ones that arrive as data are exactly
 * the ones {@link gateConsent} has to be able to REFUSE.
 *
 * `satisfies` on the table itself would not do: it keeps the literal keys and still refuses the index.
 * Exported, because the suites that hold this table against the database and against the migration all
 * index it by a string read out of one of those — and a cast per call site is a cast per call site.
 */
export const consentGatedTarget = (id: string): ConsentGatedTarget | undefined =>
  (CONSENT_GATED_TARGETS as Readonly<Record<string, ConsentGatedTarget>>)[id]

/** Every target id, sorted, so a caller enumerating them cannot depend on object key order. */
export const CONSENT_GATED_TARGET_IDS: readonly string[] = Object.freeze(
  Object.keys(CONSENT_GATED_TARGETS).sort(),
)

/** The target ids on one surface, DERIVED from the table so a third list cannot exist. */
export const consentGatedTargetsOn = (surface: ConsentGateSurface): readonly string[] =>
  CONSENT_GATED_TARGET_IDS.filter((id) => consentGatedTarget(id)?.surface === surface)

/**
 * The reasons a dispatch is not transmitted, as values.
 *
 * `consent_denied` is the acceptance line's own spelling: a dispatch for a session lacking the signal is
 * not enqueued and a row is written carrying this reason, so the suppression is VISIBLE rather than
 * silent. `consent_withdrawn` is the second kind, and the two are deliberately different values: a
 * dispatch nobody was ever permitted to send and one that was cancelled because somebody changed their
 * mind are different facts, and a single `consent` reason would make the second invisible.
 */
export const DISPATCH_SUPPRESSION_REASONS = ['consent_denied', 'consent_withdrawn'] as const
export type DispatchSuppressionReason = (typeof DISPATCH_SUPPRESSION_REASONS)[number]

export interface ConsentGateDecision {
  readonly target: string
  /** True only when every required signal is present. There is no third answer and no default. */
  readonly permitted: boolean
  /**
   * The required signals the state does not carry, sorted. **Empty exactly when permitted**, which is an
   * invariant rather than a description: `missing.length === 0` is the branch a caller writes instead of
   * reading `permitted`, so the two must never disagree. An unknown target therefore reports all four.
   */
  readonly missing: readonly ConsentModeSignal[]
  /** `consent_denied` when refused, null when permitted. The value a suppression row records. */
  readonly reason: DispatchSuppressionReason | null
}

/**
 * The set of signals a request or a session claims were GRANTED.
 *
 * `AnalyticsConsentState` and not `ConsentState`, which `packages/core/src/consent/resolve.ts` already
 * exports for MESSAGING consent — a three-valued `granted | withdrawn | unknown` per contact, channel and
 * purpose. `pnpm typecheck` caught the collision at the barrel, and the rename is worth more than the
 * shorter name: the two are different subjects (a web visitor's four signals against a contact's
 * permission to be messaged) and reading them as one answer is this unit's defining defect one package
 * over.
 *
 * A set of the granted ones rather than a map of granted-and-denied, which is the representation
 * `consent-signal.ts` chose for the cookie and the reason it gives: absence has to mean denied anyway, so
 * one spelling for "not granted" instead of two. A `ReadonlySet` at the type level; every function here
 * returns a FRESH set, because a shared one a caller could add to would turn every later denial into a
 * grant.
 */
export type AnalyticsConsentState = ReadonlySet<ConsentModeSignal>

/** The state that permits nothing: no record, an unreadable record, a denial, a withdrawal. */
export const deniedAnalyticsConsentState = (): AnalyticsConsentState => new Set<ConsentModeSignal>()

const isConsentModeSignal = (value: unknown): value is ConsentModeSignal =>
  typeof value === 'string' && (CONSENT_MODE_SIGNALS as readonly string[]).includes(value)

/**
 * A state from a list of claimed signal names, discarding anything unrecognised.
 *
 * Total and never throwing. A claim of `analytics_storage_denied` must not be read as granting
 * `analytics_storage`, which is what a substring test would do and what `grantedConsentSignals` already
 * refuses one package over; this is the same rule applied to a list that arrived as JSON rather than in a
 * cookie. An input that is not iterable — a number, a string, null, an object — is not a partial claim to
 * be salvaged: it resolves to the denied state.
 */
export function consentStateFromClaimedSignals(claimed: unknown): AnalyticsConsentState {
  const state = new Set<ConsentModeSignal>()
  if (claimed === null || typeof claimed !== 'object') return state
  if (!(Symbol.iterator in (claimed as Record<symbol, unknown>))) return state
  for (const entry of claimed as Iterable<unknown>) {
    if (isConsentModeSignal(entry)) state.add(entry)
  }
  return state
}

/**
 * The column name each signal is recorded in on `analytics.session`.
 *
 * The one place the external vocabulary meets this schema's spelling, so a renamed column is one edit.
 * `packages/fixtures/src/analytics-consent.itest.ts` holds these four names against the columns the
 * database actually has — without which this object would be a map to columns that no longer exist, every
 * lookup would be `undefined`, every signal would read as denied, and every dispatch would be suppressed
 * while every test about suppression passed.
 */
export const SESSION_CONSENT_COLUMNS: Readonly<Record<ConsentModeSignal, string>> = Object.freeze({
  ad_storage: 'consent_ad_storage',
  ad_user_data: 'consent_ad_user_data',
  ad_personalization: 'consent_ad_personalization',
  analytics_storage: 'consent_analytics_storage',
})

/**
 * A state from a session row's four boolean columns.
 *
 * `=== true` and nothing looser. See the header: a boolean column reads back as `true`, `'t'`, `'true'`
 * or `1` depending on the driver and the query, and three of those four are truthy. A truthiness test
 * would therefore read a FALSE column as consent wherever the value arrived as `'f'` — which is a string,
 * and a non-empty string is truthy. So the only value that grants a signal is the boolean `true`, and
 * every other shape, including a missing column, leaves the signal out.
 */
export function consentStateFromSessionRow(row: unknown): AnalyticsConsentState {
  const state = new Set<ConsentModeSignal>()
  if (row === null || typeof row !== 'object') return state
  const record = row as Record<string, unknown>
  for (const signal of CONSENT_MODE_SIGNALS) {
    if (record[SESSION_CONSENT_COLUMNS[signal]] === true) state.add(signal)
  }
  return state
}

/**
 * **The gate.** Whether this target may act, given this consent state.
 *
 * The only function in this build that answers the question, and it answers it the same way for a script
 * tag and for an outbound HTTP push. There is no parameter that relaxes it, no options object, and no
 * environment argument — ADR 0076 and the arch test are what keep it that way.
 *
 * An unknown target id is REFUSED rather than permitted, and refused with every signal listed as missing.
 * The alternative — an unknown target falling through to permitted because the table had nothing to
 * require of it — is the fail-open an id typo would reach, and a typo is exactly how a new destination
 * arrives.
 */
export function gateConsent(input: {
  readonly target: string
  readonly state: AnalyticsConsentState
}): ConsentGateDecision {
  const target = consentGatedTarget(input.target)
  /*
   * An unknown target reports EVERY signal missing, whatever the state carries, and the first version of
   * this function did not — it filtered `CONSENT_MODE_SIGNALS` by the state, so an unknown target under a
   * full grant came back `{ permitted: false, missing: [] }`. Its own test case caught it. The pair is
   * incoherent, and worse than incoherent: `missing.length === 0` is the branch a caller writes instead
   * of reading `permitted`, and under that branch an unknown target was PERMITTED. So the invariant is
   * the contract — `missing` is empty exactly when `permitted` — and it is asserted.
   */
  if (target === undefined) {
    return {
      target: input.target,
      permitted: false,
      missing: [...CONSENT_MODE_SIGNALS].toSorted(),
      reason: 'consent_denied',
    }
  }
  const missing = target.requires.filter((signal) => !input.state.has(signal)).toSorted()
  const permitted = missing.length === 0
  return {
    target: input.target,
    permitted,
    missing,
    reason: permitted ? null : 'consent_denied',
  }
}

/**
 * Whether a client tag may be injected, decided from the request's or the document's cookie.
 *
 * The composition the tag loader calls (A-MEAS-04), written here so the loader has nothing to decide. It
 * refuses a target that is not on the `client_tag` surface, which is not pedantry: a loader that passed a
 * server destination's id would be gated on `ad_user_data` alone and would inject an advertising tag for
 * a visitor who granted that and refused `ad_storage`.
 */
export function mayLoadClientTag(target: string, cookieHeader: string | null): ConsentGateDecision {
  if (consentGatedTarget(target)?.surface !== 'client_tag') {
    return {
      target,
      permitted: false,
      missing: [...CONSENT_MODE_SIGNALS].toSorted(),
      reason: 'consent_denied',
    }
  }
  return gateConsent({ target, state: grantedConsentSignals(cookieHeader) })
}
