/**
 * The analytics consent RECORD's wire contract and the banner's own words (A-MEAS-02).
 *
 * ## What is here, and what is deliberately next door
 *
 * `analytics/consent-signal.ts` (A-FIRST-05) holds the four Consent Mode v2 signal names, the cookie they
 * travel in, and the parse that turns a `Cookie` header into the set of signals a request claims were
 * granted. That is the TRANSPORT of a decision, and it stays the only statement of it — this module
 * imports those names rather than respelling them, because a second list of signal names is a store whose
 * consent state cannot be handed to the thing it gates.
 *
 * What is here is the other half, which that file names as this unit's: the **record**. The exact words
 * the banner showed, in English and Arabic, and the shape of the request that writes one.
 *
 * ## Why the banner's words are a committed constant rather than a database read
 *
 * `/` and `/ar` are statically prerendered, so a component's render runs during `next build`. A build-time
 * read of `consent_wording` would therefore either fail the build on a machine with no database — which
 * includes CI, where the build runs before the migrations — or bake whatever that machine's database held,
 * which is a hard-coded string with extra steps and no way to tell it had gone stale.
 *
 * So the words are stated HERE, once, and the database row is derived from them: `seedConsentWording`
 * publishes version 1 from this constant, and `recordAnalyticsConsent` resolves the wording row BY THE
 * HASH OF THESE BYTES. That inverts the usual failure. A tree whose copy has been edited without a new
 * version being published does not silently record consent against words nobody showed — it cannot find a
 * wording row at all, and every analytics consent write is refused by name until version 2 is published.
 * `packages/fixtures/src/analytics-consent.itest.ts` is where that is proved in both directions.
 *
 * ## No clock and no crypto
 *
 * `scripts/check-core-purity.mjs` scans this directory with the scoped treatment — no `Date`, no `Intl`,
 * no `node:crypto` — so the instant arrives as an ISO string and the HASH is computed by the database's
 * own `consent_wording_hash()`, which is the one definition the GENERATED column and the INSERT trigger
 * already use (0056). A second hash implementation here would agree today and be two things to change
 * tomorrow, and the symptom of a disagreement is a valid consent record refused as tampered.
 */
import { z } from 'zod'
import { ANALYTICS_CONSENT_PURPOSE } from '../schemas/consent.ts'
import { CONSENT_MODE_SIGNALS, type ConsentModeSignal } from './consent-signal.ts'

/** The path the banner posts a decision to. Written once, so a rename cannot leave the banner behind. */
export const ANALYTICS_CONSENT_PATH = '/api/v1/consent/analytics'

/**
 * The three kinds of analytics consent record, and there are only three.
 *
 * `granted` and `denied` are the banner's two buttons. `withdrawn` is the third because a withdrawal is a
 * NEW ROW and never an edit — 0056's argument, which applies here unchanged: a column that could be
 * cleared is a column an UPDATE can un-clear, and the evidence that somebody opted out would then be a
 * value rather than a record.
 *
 * "Never asked" is the ABSENCE of a row and is never stored. It is also the state the gate treats
 * identically to `denied`, which is the whole of {@link resolveAnalyticsConsentState}'s fail-closed
 * default — but they are not the same FACT, and this record is the only place the difference is visible.
 */
export const ANALYTICS_CONSENT_DECISIONS = ['granted', 'denied', 'withdrawn'] as const
export type AnalyticsConsentDecision = (typeof ANALYTICS_CONSENT_DECISIONS)[number]

/**
 * The surface a decision was captured on, and today there is exactly one.
 *
 * One value rather than an optimistic vocabulary, because a value with no producer is indistinguishable
 * from a value whose producer stopped working. A preference centre that lets a visitor revisit the choice
 * is A-MEAS-04's or later; adding it is a row in the CHECK and a value here.
 */
export const ANALYTICS_CONSENT_SURFACES = ['consent_banner'] as const
export type AnalyticsConsentSurface = (typeof ANALYTICS_CONSENT_SURFACES)[number]

/**
 * The exact words the banner shows, in both languages, always both.
 *
 * Both because `consent_wording` requires both (0056: a statement published in English only is a record
 * that cannot answer what an Arabic-speaking visitor agreed to) and because this site serves both
 * locales from two root layouts.
 *
 * Every string opens with a visible draft marker and contains no token `is_placeholder_text()` refuses —
 * the same arrangement `CONSENT_WORDING_DRAFTS` uses, and for the same reason: the row has to be
 * storable, the marker is for the person reading it, and `is_provisional` plus an OPEN-QUESTIONS id is
 * for the system. The copy a visitor is shown is legal text and this build has seen none
 * (`Y9-consent-wording`); answering that question publishes version 2 rather than editing version 1,
 * because `consent_wording` is append-only.
 *
 * It names no third-party vendor and no destination host, deliberately. `scripts/check-egress-guard.mjs`
 * rule 6 refuses a module that names an analytics destination outside a declared adapter, and this one is
 * shipped to the browser on every public page — the one place where naming a host would be both a
 * violation and a visible one.
 */
export const ANALYTICS_CONSENT_WORDING: {
  readonly purpose: typeof ANALYTICS_CONSENT_PURPOSE
  readonly textEn: string
  readonly textAr: string
} = Object.freeze({
  purpose: ANALYTICS_CONSENT_PURPOSE,
  textEn:
    '[DRAFT WORDING — not approved copy] We measure how this site is used, and we can share that ' +
    'measurement with advertising services. Nothing is measured and nothing is shared until you ' +
    'choose. You can change your mind at any time.',
  textAr:
    '[صياغة مسودة — ليست نصًا معتمدًا] نقيس كيفية استخدام هذا الموقع، ويمكننا مشاركة هذا القياس مع خدمات ' +
    'الإعلان. لا يُقاس شيء ولا يُشارك شيء حتى تختار. يمكنك تغيير رأيك في أي وقت.',
})

/**
 * The OPEN-QUESTIONS id the drafted banner copy is filed under, and it is NOT a new one.
 *
 * `Y9-consent-wording` is C-CRM-03's, and its wording is exactly this question: "the consent statement a
 * customer is shown is legal copy and the build has seen none". A fifth statement under the same
 * unanswered question is the same question, so a `Y5-analytics-consent-copy` would have been a second id
 * for one open decision — and `unconfirmedAssumptionRows` holds every provisional `consent_wording` row
 * to this id, which is how the duplication would have shown up: as a panel that listed two questions
 * where somebody has to answer one.
 */
export const ANALYTICS_CONSENT_COPY_OPEN_QUESTION = 'Y9-consent-wording'

/**
 * Every reason the record endpoint refuses, as a value. Callers branch on these, never on prose.
 *
 * A named refusal and not a bare 400, for the reason `/api/collect`'s refusals are named: a 400 is also
 * what a malformed body produces, and a case asserting only the status passes for any of them.
 */
export const ANALYTICS_CONSENT_REFUSALS = [
  /** The body is not a readable decision. */
  'invalid_decision',
  /**
   * No `consent_wording` row hashes to the words this tree's banner shows.
   *
   * The refusal a tree whose copy was edited without a new version being published gets, and the reason
   * the hash is the lookup key rather than a version number somebody types.
   */
  'wording_not_published',
  /** A `granted` decision that grants no signal, which is a denial wearing the wrong name. */
  'granted_without_a_signal',
  /** A non-grant that claims a granted signal. */
  'refusal_claiming_a_signal',
] as const
export type AnalyticsConsentRefusal = (typeof ANALYTICS_CONSENT_REFUSALS)[number]

/**
 * The decision the banner posts.
 *
 * `strictObject`, so an unknown extra property is refused rather than ignored — `collectBatchSchema`'s
 * argument, and here it matters more: a field the server silently drops is a consent qualification the
 * visitor expressed and nobody recorded.
 *
 * `granted` is a list of the signals GRANTED and never a map of granted-and-denied, which is the one
 * representation `consent-signal.ts` chose for the cookie and the reason it gives: the absence of a
 * signal has to mean denied anyway — a truncated value, an older banner version, a signal Google adds
 * next year — so there is one spelling for "not granted" instead of two.
 */
export const analyticsConsentDecisionSchema = z.strictObject({
  decision: z.enum(ANALYTICS_CONSENT_DECISIONS),
  granted: z.array(z.enum(CONSENT_MODE_SIGNALS)).max(CONSENT_MODE_SIGNALS.length),
  locale: z.enum(['en', 'ar']),
  surface: z.enum(ANALYTICS_CONSENT_SURFACES),
})

export type AnalyticsConsentDecisionBody = z.infer<typeof analyticsConsentDecisionSchema>

/**
 * The signals a decision of each kind may claim.
 *
 * A grant must claim at least one — a grant of nothing is a denial, and recording it as a grant would
 * report a consent rate this build did not earn. A denial and a withdrawal must claim none: a withdrawal
 * that kept one signal is a NEW GRANT of that signal and has to be recorded as one, or the log says
 * somebody opted out while the gate goes on opening.
 *
 * Stated here rather than only in the CHECK constraint because the endpoint gives a person a readable
 * refusal and the constraint is what holds when the write arrives from a psql session — the same
 * deliberate duplication `repositories/consent.ts` records, and
 * `packages/fixtures/src/analytics-consent.itest.ts` asserts both halves.
 */
export function analyticsConsentShapeRefusal(
  body: AnalyticsConsentDecisionBody,
): AnalyticsConsentRefusal | null {
  const granted = new Set<ConsentModeSignal>(body.granted)
  if (body.decision === 'granted') return granted.size === 0 ? 'granted_without_a_signal' : null
  return granted.size === 0 ? null : 'refusal_claiming_a_signal'
}
