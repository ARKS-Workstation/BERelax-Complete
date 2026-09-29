/**
 * The egress guard (A-MEAS-01): the one place an external analytics payload is built.
 *
 * docs/01 decision 14 and ADR 0018: *"Health data must never reach Google or Meta. An egress guard maps
 * services to opaque category codes before anything leaves, because a conversion event naming a treatment
 * is a disclosure."* docs/03 adds the commercial half — `'Arabic Hot Oil Massage'` is sensitive on its own
 * — and the sentence that decides the design: *"The internal store keeps real names because it never
 * shares them."*
 *
 * So there are two mechanisms here, and neither alone is enough:
 *
 *   1. **Substitution.** A catalogue thing reaches the wire as an opaque code from
 *      `./category-codes.ts`, whose mapping is total by compilation and asserted injective.
 *   2. **An ALLOWLIST, not a denylist.** The payload is built by walking {@link EGRESS_PAYLOAD_FIELDS} and
 *      copying what it names. Everything else is dropped and COUNTED. A denylist — "strip `notes`, strip
 *      `internalName`" — is the shape that fails on the field nobody thought of, which is every field
 *      added after the denylist was written. This is `strictObject` rather than `object` in
 *      `contraindicationFlagSetSchema`, for the reason stated there: *"a stripped key is exactly how a
 *      `notes` field reaches a caller that logs whatever it was handed."*
 *
 * ## Why the drops are returned rather than silently discarded
 *
 * A projection that drops quietly is indistinguishable from a projection that was never asked to carry the
 * field. ADR 0018 makes the same argument one layer up about ref-capture rate: a report that cannot
 * distinguish "no conversions" from "conversions we failed to attribute" is worse than no report. Here it
 * is the difference between "the dispatcher had nothing else" and "the dispatcher tried to send a
 * customer's intake answers and the guard removed them" — the second is an incident, and an incident with
 * no count is one nobody sees.
 *
 * ## Why `valueFils` is carried only for the terminal stage
 *
 * This is the field the opacity of a code stands or falls on, and it is the non-obvious half of the unit.
 * The 32 prices of docs/13 §4 are PUBLIC. A `price_viewed` event carrying `categoryCode: 'SVV_11'` and
 * `valueFils: 32000` therefore hands over one row of the mapping, and a few hundred such events hand over
 * the menu — so the guard would be substituting a code while transmitting a key to it. Opacity is not a
 * property of the code alone; it is a property of the whole payload, which is why this rule lives with the
 * builder and not in a comment beside the codes.
 *
 * The terminal stage is exempt because a conversion push with no value is not worth making, and that
 * residual is accepted deliberately and written down in ADR 0059: a settled document's total spans every
 * appointment, add-on and bundle on it and includes VAT, so it is not a menu cell. Every other stage gets
 * no figure at all, and the drop is counted like any other.
 *
 * `FUNNEL_TERMINAL_STAGE` is read rather than spelled, so a ninth funnel stage moves this rule with it
 * (ADR 0046's note on that constant). A literal `'paid'` here would be the second statement of the order
 * that module exists to prevent.
 *
 * ## Purity
 *
 * `packages/core` and nothing ambient: no clock, no `process`, no network, no `console`
 * (`scripts/check-core-purity.mjs`). The guard decides WHAT may leave; it never leaves with it. The
 * transmitting adapters are A-MEAS-03's, and `scripts/check-egress-guard.mjs` is what stops one of them
 * minting a payload of its own.
 */
import { AppError, FUNNEL_STAGES, FUNNEL_TERMINAL_STAGE, type FunnelStage } from '@berelax/shared'
import {
  type CatalogueRef,
  categoryCodeFor,
  EGRESS_CATEGORY_CODES,
  type EgressCategoryCode,
} from './category-codes.ts'

/**
 * The event types a payload may be built for: the funnel stages, DERIVED.
 *
 * Not a second list. ADR 0046 put the funnel vocabulary in one tuple precisely so that "what the funnel
 * counts" and "what the ad platforms are pushed" cannot come apart — and they are the same question, since
 * a platform optimising on a signal the funnel does not hold is optimising on something this business
 * cannot reconcile against the journal. `scripts/check-egress-guard.mjs` refuses a funnel-stage literal in
 * this module, so the derivation cannot quietly become a copy.
 */
export const EGRESS_EVENT_TYPES = FUNNEL_STAGES
export type EgressEventType = FunnelStage

/** The one currency this business trades in. Not a lookup: AED is in the legal entity, not in a payload. */
export const EGRESS_CURRENCY = 'AED'
export type EgressCurrency = typeof EGRESS_CURRENCY

/**
 * Every field that may appear in an external payload, and nothing else may.
 *
 * Five, and each one earns its place by being something an ad platform cannot work without: what happened,
 * to which opaque category, how many, and — for a conversion only — how much and in what. A sixth field is
 * a deliberate committed diff to this tuple, which is the whole difference between an allowlist and a
 * habit.
 */
export const EGRESS_PAYLOAD_FIELDS = [
  'eventType',
  'categoryCode',
  'quantity',
  'valueFils',
  'currency',
] as const
export type EgressPayloadField = (typeof EGRESS_PAYLOAD_FIELDS)[number]

/**
 * The phantom brand. Declared, never assigned, and impossible to forge without a cast.
 *
 * `unique symbol` rather than a string tag: a string tag is a field a caller can write, so a hand-rolled
 * object would be assignable and the branded parameter type in A-MEAS-03's adapters would accept it. This
 * one cannot be produced at all — the symbol has no runtime value — so the only way to obtain an
 * {@link EgressPayload} is {@link buildEgressPayload}, and the one cast that mints it is asserted to be the
 * only one in the repository by `scripts/check-egress-guard.mjs`.
 *
 * Being phantom also means it does not serialise. A brand that appeared on the wire would be a field the
 * allowlist never approved.
 */
declare const egressPayloadBrand: unique symbol

/** The fields of a built payload, before branding. Optional pair is present together or not at all. */
export interface EgressPayloadFields {
  readonly eventType: EgressEventType
  readonly categoryCode: EgressCategoryCode
  readonly quantity: number
  readonly valueFils?: number
  readonly currency?: EgressCurrency
}

/**
 * A payload the guard built. The type A-MEAS-03's adapters accept, and the type nothing else can produce.
 */
export type EgressPayload = EgressPayloadFields & {
  readonly [egressPayloadBrand]: 'built-by-the-egress-guard'
}

/** Why a field did not make it onto the wire. Two reasons, and they are not the same incident. */
export const EGRESS_DROP_REASONS = ['not_allowlisted', 'value_outside_the_terminal_stage'] as const
export type EgressDropReason = (typeof EGRESS_DROP_REASONS)[number]

export interface EgressDroppedField {
  readonly field: string
  readonly reason: EgressDropReason
}

/**
 * What the dispatcher knows, in the only vocabulary the guard accepts.
 *
 * Keys and enum members only — see {@link CatalogueRef}'s header. There is no name, label or free-text
 * field to drop, because the strongest form of "no service name leaves the building" is a guard that
 * cannot be handed one.
 */
export interface EgressSubject {
  readonly ref: CatalogueRef
  readonly eventType: EgressEventType
  /** Treatments, bundles or sessions the event is about. A positive whole number. */
  readonly quantity: number
  /** Money received, integer fils, VAT-inclusive (ADR 0007). Carried for the terminal stage only. */
  readonly valueFils?: number | undefined
}

export interface EgressBuildResult {
  readonly payload: EgressPayload
  /** Every field that did not travel, with its reason. `length` is the count the acceptance line names. */
  readonly dropped: readonly EgressDroppedField[]
}

/**
 * Builds the one payload shape that may leave, from a subject and whatever else the caller was holding.
 *
 * `carried` is the realistic hazard and the reason this signature has a second parameter at all: a
 * dispatcher reads a row, a session and an appointment, and the cheap thing to do is hand the lot to the
 * adapter. Every key of it is dropped and counted — including a key the allowlist names, because the
 * SUBJECT is the only source of a value and a `carried.categoryCode` would otherwise be a second
 * assignment nothing holds equal to the table.
 *
 * The projection walks the allowlist rather than the candidate. That direction is the point: a field added
 * to the candidate and not to {@link EGRESS_PAYLOAD_FIELDS} is dropped and counted, where a projection
 * that walked the candidate and skipped known-bad names would carry it.
 */
export function buildEgressPayload(
  subject: EgressSubject,
  carried: Readonly<Record<string, unknown>> = {},
): EgressBuildResult {
  const dropped: EgressDroppedField[] = []

  /** Everything the guard is willing to consider, assembled from the subject alone. */
  const candidate = new Map<string, unknown>([
    ['eventType', subject.eventType],
    ['categoryCode', categoryCodeFor(subject.ref)],
    ['quantity', subject.quantity],
  ])

  // The value rule, before the projection, so a refused figure is a counted drop rather than an absence.
  // See the module header: a figure on a non-terminal stage is one row of the code mapping, in public.
  if (subject.valueFils !== undefined) {
    if (subject.eventType === FUNNEL_TERMINAL_STAGE) {
      candidate.set('valueFils', subject.valueFils)
      candidate.set('currency', EGRESS_CURRENCY)
    } else {
      dropped.push({ field: 'valueFils', reason: 'value_outside_the_terminal_stage' })
    }
  }

  for (const key of Object.keys(carried)) {
    dropped.push({ field: key, reason: 'not_allowlisted' })
  }

  // --- the projection: the allowlist is walked, never the candidate -------------------------------
  const fields: Record<string, unknown> = {}
  for (const field of EGRESS_PAYLOAD_FIELDS) {
    if (candidate.has(field)) fields[field] = candidate.get(field)
    candidate.delete(field)
  }
  for (const leftover of candidate.keys()) {
    dropped.push({ field: leftover, reason: 'not_allowlisted' })
  }

  // The three fields every payload must carry. Unreachable while EGRESS_PAYLOAD_FIELDS names them, and
  // checked anyway: "unreachable by construction" stops being true the moment somebody edits the tuple, and
  // the alternative failure is a payload with no event type, which an adapter would post as a conversion of
  // unknown kind rather than refuse. The cast below is what makes this the last point it could be caught.
  for (const required of REQUIRED_EGRESS_FIELDS) {
    if (Object.hasOwn(fields, required)) continue
    throw new AppError(
      'invariant_violated',
      `The egress payload has no ${required}, so EGRESS_PAYLOAD_FIELDS no longer names it. A payload ` +
        'without one of the three required fields is not a smaller payload: it is a conversion an ad ' +
        'platform cannot attribute and will not refuse.',
      { details: { allowlist: [...EGRESS_PAYLOAD_FIELDS], built: Object.keys(fields) } },
    )
  }

  // The ONE cast that mints a branded payload, and `scripts/check-egress-guard.mjs` asserts it is the only
  // one in the repository. `as unknown as` because the projection is dynamic by design — walking the
  // allowlist is what makes a new field a counted drop — so the compiler cannot see the three fields the
  // loop above has just proved are there.
  return { payload: fields as unknown as EgressPayload, dropped }
}

/**
 * The fields a payload is worthless without, named separately from the allowlist.
 *
 * A subset rather than a derivation: `valueFils` and `currency` are legitimately absent, so "every
 * allowlisted field is present" is the wrong invariant and would refuse every non-conversion event.
 */
const REQUIRED_EGRESS_FIELDS = [
  'eventType',
  'categoryCode',
  'quantity',
] as const satisfies readonly EgressPayloadField[]

/**
 * The one serialisation of a payload, with the fields in allowlist order.
 *
 * Deterministic order because two adapters serialising the same payload differently is two payloads for
 * deduplication purposes, and A-MEAS-03's `event_id` is supposed to make one delivery out of both. Built
 * by walking the allowlist again rather than by `JSON.stringify(payload)` directly: an object that somehow
 * carried an extra own key would serialise it, and this is the last point at which that could be stopped.
 */
export function serialiseEgressPayload(payload: EgressPayload): string {
  const ordered: Record<string, unknown> = {}
  const source = payload as unknown as Readonly<Record<string, unknown>>
  for (const field of EGRESS_PAYLOAD_FIELDS) {
    if (Object.hasOwn(source, field)) ordered[field] = source[field]
  }
  return JSON.stringify(ordered)
}

/**
 * The health-term lexicon: words whose presence in an egress payload would be a health disclosure.
 *
 * Committed, because the claim "no health term leaves" is only as good as the list it is measured against,
 * and a list assembled at runtime from whatever the catalogue happens to contain would shrink the claim
 * silently. The acceptance line names the first seven; the rest are the same class of fact.
 *
 * Each entry declares HOW it is matched — see {@link HealthTermMatch}. Most are stems, the shape
 * `INBOUND_VERB_STEMS` in `scripts/test-no-autofile.mjs` takes for the same reason; three are whole words
 * because a stem of them would fire on ordinary English.
 *
 * The stems are chosen to be long enough not to fire on ordinary words, and the test asserts BOTH
 * directions over a measured list: `cardio` and `cardiac` rather than `card`, which would flag
 * `cardholder`. The negative list in `egress-guard.test.ts` is the one that earns its place — it holds
 * every token a real payload can contain, because a guard that flags `paid` is a guard somebody switches
 * off (the `readFileSync` lesson from M-VAT-09, ADR 0052).
 *
 * `CONTRAINDICATION_FLAG_KEYS` in `@berelax/shared` is the clinical enum this must not fall behind, and
 * the test holds the two in step: every condition-naming flag key is covered by a stem here. The enum is
 * not imported and mapped, because `requires_consultation` names no condition — a derivation would put
 * `requires` in a health lexicon.
 */
/**
 * How an entry is matched, and the three modes are not interchangeable.
 *
 * `stem` matches at the start of a word, because `pregnancies` is the same disclosure as `pregnancy` and a
 * lexicon of exact words is defeated by a plural. `word` matches a whole word or its plural, for a term
 * short enough that a prefix would hit ordinary English — `pain` as a stem flags `painting`, which the
 * negative control in `egress-guard.test.ts` caught on the first run. It is the substring-versus-segment
 * hazard M-VAT-09 records (ADR 0052), where an unaligned match on a five-letter term hits `readFileSync`
 * and `writeFileSync` about forty times: a gate that fires on legitimate content is a gate somebody
 * switches off rather than fixes. `phrase` is for a term that is two words, which a word-by-word scan
 * cannot see at all.
 *
 * The forbidden term itself is deliberately NOT quoted here. `pnpm no-autofile` scans every raw line in the
 * repository, comments included, and it is right to: a shipped module has no business carrying the name of
 * a filing capability even as a citation, and the alternative — adding this file to that gate's
 * IDENTIFIER_ALLOWED — would excuse `packages/core` from the one check that says the build cannot file a
 * return. The scan caught this comment on its first run against this unit.
 */
export type HealthTermMatch = 'stem' | 'word' | 'phrase'

export const HEALTH_TERM_LEXICON = [
  { term: 'prenatal', match: 'stem' },
  { term: 'antenatal', match: 'stem' },
  { term: 'postnatal', match: 'stem' },
  { term: 'pregnan', match: 'stem' },
  { term: 'injur', match: 'stem' },
  { term: 'sprain', match: 'stem' },
  { term: 'fractur', match: 'stem' },
  { term: 'diabet', match: 'stem' },
  { term: 'insulin', match: 'stem' },
  { term: 'hypertens', match: 'stem' },
  { term: 'hypotens', match: 'stem' },
  { term: 'lymph', match: 'stem' },
  { term: 'oedema', match: 'stem' },
  { term: 'edema', match: 'stem' },
  { term: 'cardio', match: 'stem' },
  { term: 'cardiac', match: 'stem' },
  { term: 'surger', match: 'stem' },
  { term: 'surgic', match: 'stem' },
  { term: 'allerg', match: 'stem' },
  { term: 'anticoagul', match: 'stem' },
  { term: 'eczema', match: 'stem' },
  { term: 'psoriasis', match: 'stem' },
  { term: 'dermatit', match: 'stem' },
  { term: 'medicat', match: 'stem' },
  { term: 'medical', match: 'stem' },
  { term: 'clinical', match: 'stem' },
  { term: 'diagnos', match: 'stem' },
  { term: 'symptom', match: 'stem' },
  { term: 'disease', match: 'stem' },
  { term: 'disorder', match: 'stem' },
  { term: 'contraindicat', match: 'stem' },
  { term: 'physiotherap', match: 'stem' },
  { term: 'rehabilitat', match: 'stem' },
  { term: 'inflammat', match: 'stem' },
  { term: 'arthrit', match: 'stem' },
  { term: 'migraine', match: 'stem' },
  { term: 'sciatica', match: 'stem' },
  { term: 'varicose', match: 'stem' },
  { term: 'thrombo', match: 'stem' },
  { term: 'epilep', match: 'stem' },
  { term: 'asthma', match: 'stem' },
  { term: 'oncolog', match: 'stem' },
  { term: 'chemotherap', match: 'stem' },
  { term: 'blood pressure', match: 'phrase' },
  { term: 'blood thinner', match: 'phrase' },
  { term: 'pain', match: 'word' },
  { term: 'painful', match: 'word' },
  { term: 'skin', match: 'word' },
] as const satisfies readonly { readonly term: string; readonly match: HealthTermMatch }[]

export type HealthTerm = (typeof HEALTH_TERM_LEXICON)[number]['term']

/** Words of a text, lower-cased, with every non-alphanumeric run treated as a separator. */
export function egressTokensOf(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
}

/**
 * Every health stem the text carries, or an empty list.
 *
 * A single-word stem matches at the start of a word; a multi-word stem is matched against the
 * space-normalised text, because `blood pressure` is two words and a word-by-word scan cannot see it.
 */
export function healthTermsIn(text: string): readonly HealthTerm[] {
  const tokens = egressTokensOf(text)
  const normalised = ` ${tokens.join(' ')} `
  const carried: HealthTerm[] = []
  for (const { term, match } of HEALTH_TERM_LEXICON) {
    const hit =
      match === 'phrase'
        ? normalised.includes(` ${term}`)
        : match === 'stem'
          ? tokens.some((token) => token.startsWith(term))
          : tokens.some((token) => token === term || token === `${term}s`)
    if (hit) carried.push(term)
  }
  return carried
}

/**
 * Every token a serialised payload is permitted to contain, as a closed set.
 *
 * The strong form of the claim, and the one worth asserting: not "no health term appears" — which holds
 * for a payload that leaked a service name instead — but "nothing appears except these". Derived from the
 * allowlist, the code set and the event types, so it cannot fall behind any of the three.
 */
export function egressPermittedVocabulary(): readonly string[] {
  const permitted = new Set<string>()
  for (const field of EGRESS_PAYLOAD_FIELDS) {
    for (const token of egressTokensOf(field)) permitted.add(token)
  }
  for (const code of EGRESS_CATEGORY_CODES) {
    for (const token of egressTokensOf(code)) permitted.add(token)
  }
  for (const eventType of EGRESS_EVENT_TYPES) {
    for (const token of egressTokensOf(eventType)) permitted.add(token)
  }
  for (const token of egressTokensOf(EGRESS_CURRENCY)) permitted.add(token)
  return [...permitted]
}

/**
 * Tokens of a serialised payload that the closed vocabulary does not permit.
 *
 * Digits are permitted wherever they stand alone: a quantity and a figure are numbers, and a number is not
 * a word. A token that is part digits and part letters is NOT permitted — `svv11` would be one — because
 * that is the shape a smuggled identifier takes.
 */
export function unpermittedEgressTokens(serialised: string): readonly string[] {
  const permitted = new Set(egressPermittedVocabulary())
  return egressTokensOf(serialised).filter(
    (token) => !permitted.has(token) && !/^[0-9]+$/.test(token),
  )
}
