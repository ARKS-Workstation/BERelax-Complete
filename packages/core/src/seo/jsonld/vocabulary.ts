/**
 * Which schema.org types the licence permits this business to claim.
 *
 * docs/09 §"Schema types" states the rule and the reason: *"`DaySpa` (a subtype of `LocalBusiness` and
 * `HealthAndBeautyBusiness`) as the primary type. **Do not** claim `MedicalBusiness` or `MedicalClinic`
 * unless the licence classification supports it. Claiming a medical type the licence does not permit is a
 * compliance problem, not an SEO tactic."*
 *
 * `regulatory_profile.licence_class` is `unconfirmed` (0004, Y1-licence) and resolves to the **stricter**
 * combination — wellness vocabulary — exactly as ADR 0020 requires. So `DaySpa` is the primary type today
 * and the medical types are unreachable.
 *
 * ## Why this is a mapping and not four `if`s at the call sites
 *
 * Because "unreachable" has to be a property of the code rather than a claim about it. Every type in a
 * graph comes from one of the three functions below, each of which takes the licence class; there is no
 * other spelling of `MedicalClinic` anywhere in the builders. That makes the acceptance criterion —
 * *"flipping the profile to a healthcare class is the only code path that can emit them"* — checkable by
 * exhausting the enum rather than by grepping for a word.
 *
 * `assertVocabularyPermitted` closes the remaining hole from the other end: it walks a finished graph and
 * refuses any medical term anywhere in it, as a `@type` **or as a value** — a `serviceType` of
 * `'Medical therapy'` is the same claim to a regulator as an `@type` of `MedicalTherapy`, and a type list
 * is the only place anybody thinks to look.
 *
 * ## Why the licence class is a union here and not an import
 *
 * `packages/core` may not import `packages/db` (the dependency runs the other way), and
 * `licence_class` is a PostgreSQL enum. This union mirrors it, the way `CompliancePolicyRow` mirrors
 * `CompliancePolicy` in the other direction, and the pair is asserted against `pg_enum` by
 * `packages/fixtures/src/jsonld-graph.itest.ts` — so a licence class added to the database without a
 * vocabulary decision fails a test rather than defaulting to the permissive branch.
 */
import { AppError } from '@berelax/shared'
import { assertNever } from '../../assert-never.ts'

/** `regulatory_profile.licence_class` (0004), mirrored. */
export const LICENCE_CLASSES = ['unconfirmed', 'wellness', 'healthcare'] as const
export type LicenceClass = (typeof LICENCE_CLASSES)[number]

/**
 * The primary type, under every licence class. It never changes.
 *
 * `DaySpa` is a subtype of `HealthAndBeautyBusiness` and so of `LocalBusiness`, which is what makes the
 * address, the hours and the phone number mean what a consumer expects without also claiming a clinic.
 */
export const PRIMARY_BUSINESS_TYPE = 'DaySpa'

/**
 * The four terms the acceptance criterion names, and the closed list the assertion below scans for.
 *
 * `MedicalTherapy` is a `MedicalEntity` rather than a business type, and it is on the list because it is
 * the one that arrives by accident: it reads like a description of a massage and it is a claim that the
 * treatment is a medical intervention. `Physician` is here for the same reason on the `Person` side — a
 * therapist is not one, under any licence this business could hold.
 */
export const MEDICAL_VOCABULARY = [
  'MedicalBusiness',
  'MedicalClinic',
  'Physician',
  'MedicalTherapy',
] as const
export type MedicalTerm = (typeof MEDICAL_VOCABULARY)[number]

/**
 * The `@type` list for the business node.
 *
 * Only the `healthcare` branch adds a medical type, and it adds `MedicalClinic` rather than
 * `MedicalBusiness`: a clinic is the specific subtype, and a consumer that wants the general one gets it
 * by inference. `DaySpa` stays first in every branch — the business is still a day spa on the day the
 * licence is confirmed, and dropping it would throw away the type that carries the treatment menu.
 */
export function businessTypesFor(licence: LicenceClass): readonly string[] {
  switch (licence) {
    // The stricter resolution, which is the whole point of `unconfirmed` (ADR 0020): an unanswered
    // licence question must not read as permission. It is spelled as its own case rather than folded in
    // with `wellness` so that adding a fourth class is a compile error here.
    case 'unconfirmed':
      return [PRIMARY_BUSINESS_TYPE]
    case 'wellness':
      return [PRIMARY_BUSINESS_TYPE]
    case 'healthcare':
      return [PRIMARY_BUSINESS_TYPE, 'MedicalClinic']
    default:
      return assertNever(licence, 'businessTypesFor')
  }
}

/**
 * The `@type` list for a `Service` node.
 *
 * `MedicalTherapy` under a healthcare licence and nothing else ever. Note what is *not* here: the
 * treatment style. Style is a property of the treatment (ADR 0021) and is carried by `serviceType`, not
 * by a type — an `@type` of `ThaiMassage` is not a schema.org term and an invented one is read by nobody.
 */
export function serviceTypesFor(licence: LicenceClass): readonly string[] {
  switch (licence) {
    case 'unconfirmed':
    case 'wellness':
      return ['Service']
    case 'healthcare':
      return ['Service', 'MedicalTherapy']
    default:
      return assertNever(licence, 'serviceTypesFor')
  }
}

/**
 * The `@type` list for a therapist.
 *
 * `Physician` only under a healthcare licence, and even then it is the licence's answer rather than this
 * module's opinion: whether the person delivering a treatment is a licensed practitioner is exactly the
 * question `licence_class` records. Under anything else a therapist is a `Person`, which is what docs/09
 * §"Schema types" asks for — `Person` with `knowsAbout` and `knowsLanguage`.
 */
export function personTypesFor(licence: LicenceClass): readonly string[] {
  switch (licence) {
    case 'unconfirmed':
    case 'wellness':
      return ['Person']
    case 'healthcare':
      return ['Person', 'Physician']
    default:
      return assertNever(licence, 'personTypesFor')
  }
}

/** True when the licence class permits a medical claim in published structured data. */
export function medicalVocabularyPermitted(licence: LicenceClass): boolean {
  return licence === 'healthcare'
}

/**
 * A string reduced to comparable words, camelCase boundaries included.
 *
 * `MedicalClinic`, `medical clinic` and `Medical-Clinic` all reduce to `['medical', 'clinic']`, which is
 * what makes one comparison cover a `@type`, a sentence of prose and a hyphenated label. Splitting only
 * on non-letters would leave `medicalclinic` as one word and the `@type` — the single most important place
 * to catch the term — would be the one spelling the rule missed.
 */
function vocabularyWords(value: string): readonly string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
}

/**
 * Every medical term appearing anywhere in a value, as a type or as text.
 *
 * Walks strings, arrays and objects, and matches a term as **consecutive whole words** — so
 * `MedicalTherapy`, `medical therapy` and `Medical-Therapy` are all found while `biomedical` is not,
 * because a substring rule would fire on words nobody banned and a rule that fires on innocent copy gets
 * switched off.
 *
 * Exported because two callers need it: `assertVocabularyPermitted` below, and the graph validator, which
 * reports it as a finding rather than a throw when it is handed a graph parsed out of a rendered page.
 */
export function medicalTermsIn(value: unknown): readonly MedicalTerm[] {
  const found = new Set<MedicalTerm>()
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const term of termsInString(node)) found.add(term)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node === 'object' && node !== null) {
      for (const item of Object.values(node)) walk(item)
    }
  }
  walk(value)
  return [...found].sort()
}

/** The terms one string contains, as consecutive whole words. */
function termsInString(value: string): readonly MedicalTerm[] {
  const words = vocabularyWords(value)
  return MEDICAL_VOCABULARY.filter((term) => containsWords(words, vocabularyWords(term)))
}

/** Does `words` contain `phrase` as a consecutive run? */
function containsWords(words: readonly string[], phrase: readonly string[]): boolean {
  for (let start = 0; start + phrase.length <= words.length; start += 1) {
    if (phrase.every((word, offset) => words[start + offset] === word)) return true
  }
  return false
}

/**
 * Refuses to publish a graph that claims a medical type the licence does not carry.
 *
 * A throw rather than a finding, because this is the builders' own guard and there is no sensible
 * recovery: a page that rendered the graph minus the offending node would publish a `Service` with no
 * type. The one thing worse than failing the render is serving the claim.
 *
 * It is the second half of the design and not a redundant one. `businessTypesFor` and its siblings make
 * the medical types unreachable *through the type functions*; this makes them unreachable through
 * anything — a hard-coded `'@type': 'MedicalClinic'`, a `serviceType` copied off a competitor's site, a
 * CMS `description` an editor typed. All three have the same regulatory consequence and only the first
 * looks like a type.
 */
export function assertVocabularyPermitted(graph: unknown, licence: LicenceClass): void {
  if (medicalVocabularyPermitted(licence)) return
  const found = medicalTermsIn(graph)
  if (found.length === 0) return
  throw new AppError(
    'invariant_violated',
    `Structured data may not claim ${found.join(', ')} while regulatory_profile.licence_class is ` +
      `'${licence}'. docs/09 §"Schema types": claiming a medical type the licence does not permit is a ` +
      'compliance problem, not an SEO tactic. Resolve Y1-licence and record a healthcare licence class ' +
      'before any of these terms may be published.',
    { details: { rule: 'medical_vocabulary_outside_healthcare', licence, terms: found } },
  )
}
