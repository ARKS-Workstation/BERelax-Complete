/**
 * The closed set of opaque egress category codes, and the total mapping onto it (A-MEAS-01).
 *
 * docs/01 decision 14, docs/03 §"Server-side push" and ADR 0018 all say the same sentence: an egress
 * guard maps services to opaque category codes before anything leaves, because *"'Arabic Hot Oil Massage'
 * is commercially sensitive and 'prenatal massage' would be a health disclosure"*. This module is the
 * mapping; `./egress-guard.ts` is the projection that uses it.
 *
 * ## What "opaque" is a claim about, and what it is not
 *
 * It is a claim about the WIRE. A code carries no natural-language token of the thing it stands for, so a
 * reader who has only the payload learns that a category exists and nothing about what it is. It is not a
 * claim that the assignment is secret: the table below is committed source, and anybody with the
 * repository can read it. Pretending otherwise would be security theatre, and the honest consequence is
 * stated where it bites — see `valueFils` in `./egress-guard.ts`, which is the field through which a
 * public price list would re-identify a code no matter how opaque the code itself is.
 *
 * ## Why the table is written out rather than derived from an index
 *
 * `CATEGORY_CODE_BY_REF` could be built by mapping over {@link enumerateCatalogueRefs} with a counter, and
 * then every assertion about it would be vacuous (brief rule 3): totality would hold by construction, the
 * shape would hold by construction, and injectivity would hold by construction. The introspection test
 * `contraindicationFlagSetSchema` carries the same note for the same reason.
 *
 * Written literally, four different defects are four real failures:
 *
 *   - an entry removed fails `pnpm typecheck` naming this file, because the `Record` is total over
 *     {@link CatalogueRefKey} and there is no index signature to fall into;
 *   - an entry duplicated fails the injectivity assertion — two categories sharing a code silently merge
 *     two conversion streams into one, which reads as a category that never converts;
 *   - a code added to {@link EGRESS_CATEGORY_CODES} that nothing maps to fails the both-directions
 *     assertion, so a code cannot become a bucket that is empty for ever (ADR 0046's note about
 *     `REACHABLE_FUNNEL_STAGES`);
 *   - a code renamed to something readable — `NORMAL_01` — fails both the shape assertion and the opacity
 *     assertion.
 *
 * ## Why the key is a template-literal union and not a `string`
 *
 * {@link CatalogueRefKey} is derived from `TREATMENT_STYLES`, `TREATMENT_KEYS` and `SERVICE_DURATIONS` in
 * `@berelax/shared`. So a fifth duration or a third style does not "need a mapping added": it fails
 * `tsc`, in this file, before any test runs. That is the `Record<AppointmentStatus, FunnelOutcome>` shape
 * ADR 0046 chose for the funnel, for the same reason — a lookup function with a default would answer the
 * wrong code for a new row rather than refusing to compile.
 */
import {
  SERVICE_DURATIONS,
  type ServiceDuration,
  TREATMENT_KEYS,
  TREATMENT_STYLES,
  type TreatmentKey,
  type TreatmentStyle,
} from '@berelax/shared'

/**
 * The resource footprints docs/13 §4 quotes at the desk, as `price_on_request.shape` spells them.
 *
 * Keyed on the FOOTPRINT rather than on `menu_label`, and that is the whole reason this set can be closed:
 * a label is a public name — the one thing this module exists to keep off the wire — while the footprint
 * is `shape`, a value of the `service_shape` enum, plus one sentinel for the row the catalogue cannot
 * express at all. Migration 0032's `price_on_request_shape_matches_modelling` makes
 * `shape is not null` and `modelled_as = 'service_resource_shape'` the same fact, so `shape ?? 'not_modelled'`
 * is a total, name-free projection of a row onto this set. `packages/fixtures/src/egress-catalogue.itest.ts`
 * is what holds it equal to the seeded rows in both directions.
 *
 * `solo` is deliberately absent. A solo offering with no figure is an ordinary service missing a priced
 * variant, which `assert_service_publishable()` (migration 0029) refuses to publish with ZC003 — it is a
 * half-built menu row rather than something quoted by hand, so it has no code here and a row claiming one
 * fails the integration assertion instead of being silently categorised.
 */
export const PRICE_ON_REQUEST_FOOTPRINTS = ['four_hands', 'couple', 'not_modelled'] as const
export type PriceOnRequestFootprint = (typeof PRICE_ON_REQUEST_FOOTPRINTS)[number]

/**
 * A catalogue thing, as the guard is allowed to hear about it.
 *
 * Every member carries keys and enum members only — never a name, a label, a slug or a note. The absence
 * is the content, in the shape `ContraindicationFlagSet` uses: "no service name can ever leave the
 * building" starts with a guard that cannot be HANDED one, because a field that is not in the type cannot
 * be dropped by mistake.
 *
 * `package_template` carries nothing at all, and that is not an oversight. `package_template.template_key`
 * is an owner-authored snake_case string (migration 0078's `package_template_key_is_snake_case` CHECK), so
 * the set of keys is OPEN — a mapping over it could never be total, and a guard whose mapping can be
 * incomplete has to either throw on a live push or fall back to a default, and a default is the leak. So a
 * prepaid bundle is one category: the payload says "a bundle was bought" and nothing about which one.
 * Where the specific treatment matters to the push, the caller has a `variant` ref for it.
 */
export type CatalogueRef =
  | {
      readonly kind: 'service'
      readonly style: TreatmentStyle
      readonly treatmentKey: TreatmentKey
    }
  | {
      readonly kind: 'variant'
      readonly style: TreatmentStyle
      readonly treatmentKey: TreatmentKey
      readonly durationMinutes: ServiceDuration
    }
  | { readonly kind: 'price_on_request'; readonly footprint: PriceOnRequestFootprint }
  | { readonly kind: 'package_template' }

/**
 * The canonical key of a ref, as a union `tsc` can count.
 *
 * 8 services, 32 variants, 3 quoted footprints and one bundle category: 44 keys, every one of them a
 * cross product of enums that live in `@berelax/shared`. This is the type that makes
 * {@link CATEGORY_CODE_BY_REF} total by compilation rather than by a test that has to remember to run.
 */
export type CatalogueRefKey =
  | `service:${TreatmentStyle}:${TreatmentKey}`
  | `variant:${TreatmentStyle}:${TreatmentKey}:${ServiceDuration}`
  | `price_on_request:${PriceOnRequestFootprint}`
  | 'package_template'

/** The key of a ref. Total over {@link CatalogueRef} with no default branch. */
export function catalogueRefKey(ref: CatalogueRef): CatalogueRefKey {
  switch (ref.kind) {
    case 'service':
      return `service:${ref.style}:${ref.treatmentKey}`
    case 'variant':
      return `variant:${ref.style}:${ref.treatmentKey}:${ref.durationMinutes}`
    case 'price_on_request':
      return `price_on_request:${ref.footprint}`
    case 'package_template':
      return 'package_template'
  }
}

/**
 * Every ref that exists, from ONE statement of each axis.
 *
 * The enumeration and the mapping are deliberately built differently — this walks the enums, the mapping
 * is a literal table — so that the assertion holding them equal in both directions is a real one. Two
 * halves derived from the same loop could not disagree, and a test that cannot fail is the thing ADR 0002
 * is about.
 */
export function enumerateCatalogueRefs(): readonly CatalogueRef[] {
  const refs: CatalogueRef[] = []
  for (const style of TREATMENT_STYLES) {
    for (const treatmentKey of TREATMENT_KEYS) {
      refs.push({ kind: 'service', style, treatmentKey })
    }
  }
  for (const style of TREATMENT_STYLES) {
    for (const treatmentKey of TREATMENT_KEYS) {
      for (const durationMinutes of SERVICE_DURATIONS) {
        refs.push({ kind: 'variant', style, treatmentKey, durationMinutes })
      }
    }
  }
  for (const footprint of PRICE_ON_REQUEST_FOOTPRINTS) {
    refs.push({ kind: 'price_on_request', footprint })
  }
  refs.push({ kind: 'package_template' })
  return refs
}

/**
 * The shape every code has, and the only thing about a code a reader of this repository may rely on.
 *
 * Quoted character for character from A-MEAS-01's acceptance line, in the restraint
 * `FORBIDDEN_IDENTIFIER` in `scripts/test-no-autofile.mjs` states: this pattern is a SPECIFICATION, so a
 * module that quietly enforced something narrower or wider would make the manifest and the code disagree
 * in the direction nobody checks.
 */
export const EGRESS_CATEGORY_CODE_PATTERN = /^[A-Z]+_[0-9]{2,}$/

/**
 * The closed set of codes, in the order they are assigned.
 *
 * A second list beside the table, on purpose — see the module header. The prefixes say what KIND of
 * catalogue thing a code stands for (`SVC` a service, `SVV` a service variant, `POR` a quoted footprint,
 * `PKG` a prepaid bundle) and nothing else: the kind is not sensitive, and an ad platform that cannot tell
 * a bundle purchase from a treatment purchase is being handed noise rather than privacy.
 */
export const EGRESS_CATEGORY_CODES = [
  'SVC_01',
  'SVC_02',
  'SVC_03',
  'SVC_04',
  'SVC_05',
  'SVC_06',
  'SVC_07',
  'SVC_08',
  'SVV_01',
  'SVV_02',
  'SVV_03',
  'SVV_04',
  'SVV_05',
  'SVV_06',
  'SVV_07',
  'SVV_08',
  'SVV_09',
  'SVV_10',
  'SVV_11',
  'SVV_12',
  'SVV_13',
  'SVV_14',
  'SVV_15',
  'SVV_16',
  'SVV_17',
  'SVV_18',
  'SVV_19',
  'SVV_20',
  'SVV_21',
  'SVV_22',
  'SVV_23',
  'SVV_24',
  'SVV_25',
  'SVV_26',
  'SVV_27',
  'SVV_28',
  'SVV_29',
  'SVV_30',
  'SVV_31',
  'SVV_32',
  'POR_01',
  'POR_02',
  'POR_03',
  'PKG_01',
] as const

export type EgressCategoryCode = (typeof EGRESS_CATEGORY_CODES)[number]

/**
 * The assignment. Total over {@link CatalogueRefKey} by compilation, injective by assertion.
 *
 * The keys spell the treatment words because they are SOURCE — the whole point of the table is that those
 * words stop here and the value is what travels. `scripts/check-egress-guard.mjs` is what keeps a value
 * from being spelled anywhere else, because a code written at a call site is a second assignment that
 * nothing holds equal to this one.
 */
export const CATEGORY_CODE_BY_REF: Readonly<Record<CatalogueRefKey, EgressCategoryCode>> =
  Object.freeze({
    'service:asian:normal_massage': 'SVC_01',
    'service:asian:hot_oil_balm_massage': 'SVC_02',
    'service:asian:morocco_bath_jacuzzi': 'SVC_03',
    'service:asian:massage_with_shaving': 'SVC_04',
    'service:arabic:normal_massage': 'SVC_05',
    'service:arabic:hot_oil_balm_massage': 'SVC_06',
    'service:arabic:morocco_bath_jacuzzi': 'SVC_07',
    'service:arabic:massage_with_shaving': 'SVC_08',
    'variant:asian:normal_massage:45': 'SVV_01',
    'variant:asian:normal_massage:60': 'SVV_02',
    'variant:asian:normal_massage:90': 'SVV_03',
    'variant:asian:normal_massage:120': 'SVV_04',
    'variant:asian:hot_oil_balm_massage:45': 'SVV_05',
    'variant:asian:hot_oil_balm_massage:60': 'SVV_06',
    'variant:asian:hot_oil_balm_massage:90': 'SVV_07',
    'variant:asian:hot_oil_balm_massage:120': 'SVV_08',
    'variant:asian:morocco_bath_jacuzzi:45': 'SVV_09',
    'variant:asian:morocco_bath_jacuzzi:60': 'SVV_10',
    'variant:asian:morocco_bath_jacuzzi:90': 'SVV_11',
    'variant:asian:morocco_bath_jacuzzi:120': 'SVV_12',
    'variant:asian:massage_with_shaving:45': 'SVV_13',
    'variant:asian:massage_with_shaving:60': 'SVV_14',
    'variant:asian:massage_with_shaving:90': 'SVV_15',
    'variant:asian:massage_with_shaving:120': 'SVV_16',
    'variant:arabic:normal_massage:45': 'SVV_17',
    'variant:arabic:normal_massage:60': 'SVV_18',
    'variant:arabic:normal_massage:90': 'SVV_19',
    'variant:arabic:normal_massage:120': 'SVV_20',
    'variant:arabic:hot_oil_balm_massage:45': 'SVV_21',
    'variant:arabic:hot_oil_balm_massage:60': 'SVV_22',
    'variant:arabic:hot_oil_balm_massage:90': 'SVV_23',
    'variant:arabic:hot_oil_balm_massage:120': 'SVV_24',
    'variant:arabic:morocco_bath_jacuzzi:45': 'SVV_25',
    'variant:arabic:morocco_bath_jacuzzi:60': 'SVV_26',
    'variant:arabic:morocco_bath_jacuzzi:90': 'SVV_27',
    'variant:arabic:morocco_bath_jacuzzi:120': 'SVV_28',
    'variant:arabic:massage_with_shaving:45': 'SVV_29',
    'variant:arabic:massage_with_shaving:60': 'SVV_30',
    'variant:arabic:massage_with_shaving:90': 'SVV_31',
    'variant:arabic:massage_with_shaving:120': 'SVV_32',
    'price_on_request:four_hands': 'POR_01',
    'price_on_request:couple': 'POR_02',
    'price_on_request:not_modelled': 'POR_03',
    package_template: 'PKG_01',
  })

/**
 * The code for a ref.
 *
 * No default and no fall-back: the `Record` is total, so this cannot answer `undefined`, and there is
 * therefore no "unknown category" code for a caller to lean on. A ref the table does not hold is a
 * compile error at the call site rather than an `UNKNOWN_00` that reaches an ad platform.
 */
export function categoryCodeFor(ref: CatalogueRef): EgressCategoryCode {
  return CATEGORY_CODE_BY_REF[catalogueRefKey(ref)]
}

/**
 * Every word the catalogue uses for the things above, derived from the enums rather than listed.
 *
 * This is the vocabulary the opacity assertion measures a code against, and it has to be derived: a
 * hand-written list of words would go stale the moment a treatment key changed, and a stale list makes the
 * opacity test pass over a code that now shares a token with a name. The words in the seeded
 * `internal_name` and `public_display_name` columns are exactly these plus punctuation and the joining
 * words `or`, `with` and `bath` — `packages/fixtures/src/egress-catalogue.itest.ts` asserts that against
 * the real rows, which is what stops this derivation being a claim about a tree nobody read.
 */
export function catalogueVocabulary(): readonly string[] {
  const words = new Set<string>()
  for (const style of TREATMENT_STYLES) words.add(style)
  for (const key of TREATMENT_KEYS) {
    for (const word of key.split('_')) words.add(word)
  }
  for (const footprint of PRICE_ON_REQUEST_FOOTPRINTS) {
    for (const word of footprint.split('_')) words.add(word)
  }
  return [...words]
}
