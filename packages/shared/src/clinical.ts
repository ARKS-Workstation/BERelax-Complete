import { z } from 'zod'

/**
 * The three clinical-intake settings' keys, schemas and provisional values (C-CRM-08).
 *
 * Here and not in `@berelax/config` for the reason `credential-window.ts` gives: three packages that may
 * not import one another read them — the registry that declares the setting, `@berelax/clinical` which
 * reads it at the point of a write, and migration 0082's own gate, whose key string is asserted against
 * this constant by an integration test. A key spelled twice is a gate that silently stops gating.
 */

/**
 * Whether real (non-synthetic) intake payloads may be stored at all.
 *
 * `false`, and provisional against `Y5-residency`. UAE Federal Law 2 of 2019 may prohibit storing health
 * data outside the country, DigitalOcean has no UAE region, and the licence classification that decides
 * whether the rule applies is unconfirmed (ADR 0010). The strict reading is the safe one: being wrong
 * this way costs a setting change, and being wrong the other way is a disclosure.
 *
 * Migration 0082's `clinical.real_intake_permitted()` reads this same row, so the refusal holds for a
 * `psql` session too, and an absent row reads as false — a gate that opened during a restore would open
 * at exactly the moment nobody is watching.
 */
export const CLINICAL_REAL_INTAKE_SETTING_KEY = 'clinical.real_intake_permitted'
export const PROVISIONAL_REAL_INTAKE_PERMITTED = false

/**
 * How long a step-up re-authentication is good for.
 *
 * Five minutes, and deliberately **not** marked provisional, which is a decision rather than an
 * oversight. A provisional marker means "the build guessed at something only the owner can answer", and
 * the Unconfirmed Assumptions panel is worth reading exactly to the extent that everything on it needs
 * an answer. This value does not: the strict direction is unambiguous (shorter is stricter), five
 * minutes is already at the short end of anything workable, and nothing about the licence, the emirate
 * or the entity changes it. Migration 0082 refuses any window above fifteen minutes whatever this says,
 * so the setting can only be made tighter than the ceiling.
 */
export const CLINICAL_STEP_UP_WINDOW_SETTING_KEY = 'clinical.step_up_window_minutes'
export const CLINICAL_STEP_UP_WINDOW_MINUTES = 5
/** The ceiling migration 0082 enforces. A setting above it would mint a grant the database refuses. */
export const CLINICAL_STEP_UP_WINDOW_CEILING_MINUTES = 15

export const clinicalStepUpWindowSchema = z
  .number()
  .int()
  .min(1)
  .max(CLINICAL_STEP_UP_WINDOW_CEILING_MINUTES)

/**
 * Whether an intake template's QUESTION copy is linted, as well as its assertive copy.
 *
 * `true`, and provisional against `Y1-licence`. The licence classification decides the permitted public
 * vocabulary and staff titles, and it is unconfirmed, so the narrower reading applies: a question label
 * goes through the publication lexicon too, for unpermitted staff titles, unlicensed activities and a
 * treatment style attached to a person. What a question is never linted for is the profile's claim list —
 * asking about medication is not claiming to prescribe it — and that exemption is one rule wide and
 * named in `packages/core/src/clinical/intake.ts`.
 *
 * What answering Y1 the other way buys: setting this false stops linting question copy at all, and a
 * confirmed healthcare licence additionally flips `regulatory_profile.medical_claims_permitted`, which
 * makes the claim list stop applying to the title and the consent wording as well. Both are
 * configuration, neither is a code change.
 */
export const CLINICAL_LINT_QUESTION_COPY_SETTING_KEY = 'clinical.intake_copy_lints_questions'
export const PROVISIONAL_LINT_QUESTION_COPY = true

/** The open questions these three settings carry, so a test can assert the pairing rather than a string. */
export const CLINICAL_OPEN_QUESTIONS = {
  residency: 'Y5-residency',
  licence: 'Y1-licence',
} as const

// ------------------------------------------------------------------------------------------------
// The boolean-only crossing (C-CRM-09)
// ------------------------------------------------------------------------------------------------

/**
 * The closed set of contraindication flags — the ONLY thing permitted to leave the clinical boundary.
 *
 * Here in `@berelax/shared` rather than in `@berelax/core` for the reason the three settings above are
 * here: four packages that may not import one another need the key set. `@berelax/core` derives the flags,
 * `@berelax/clinical` writes the row, `@berelax/db` reads the public view over the application credential,
 * and `apps/web` renders them. Core cannot hold it, because `packages/db` may never import core (brief
 * rule 4) and the reader of the crossing is a db repository — which is the whole point: the booking layer
 * reads booleans out of a view and imports nothing from the clinical package at all.
 *
 * **Adding a key is a migration plus a template version, never a free-text field.** A flag is a column of
 * `clinical.contraindication_flag` and a column of `public.customer_contraindication_flags`, and it can
 * only ever be derived from a question a template actually asked. There is deliberately no "other" key and
 * no `notes` companion: an open-ended flag is a free-text field with a boolean's name, and the first thing
 * anybody would put in it is the thing this boundary exists to keep in.
 *
 * ## Why `requires_consultation` and not `practitioner_review_required`
 *
 * The manifest's provisional set named the eighth key `practitioner_review_required`. It is
 * `requires_consultation` for two independent reasons, and either alone would decide it.
 *
 * The committed schema already has the column: migration 0008 created
 * `clinical.contraindication_flag.requires_consultation` and 0009's view exposes it. Renaming it would be a
 * migration whose only product is a synonym.
 *
 * And `Y1-licence` is open. It decides the permitted public vocabulary and the permitted staff titles, and
 * unconfirmed resolves to the NARROWER reading — commercial wellness. `practitioner` is in
 * `PROVIDER_TITLES` (`packages/core/src/compliance/lexicon.ts`) and is not in the seeded
 * `regulatory_profile.permitted_public_titles` (`['Therapist','Senior Therapist','Spa Therapist']`, 0004),
 * so a label built on that word is refused by `unpermitted_staff_title` — asserted, with a control, in
 * `packages/core/src/clinical/contraindication-flags.test.ts`. Being wrong this way costs a reworded label;
 * being wrong the other way is a staff title this business may not be licensed to use, printed beside a
 * health marker.
 *
 * **What widens if the owner answers `healthcare`:** `permitted_public_titles` gains the clinical titles
 * and `CONTRAINDICATION_FLAG_LABELS` may then name who reviews. The KEY does not change — a database column
 * is not copy, and a synonym migration is not a licence classification.
 */
export const CONTRAINDICATION_FLAG_KEYS = [
  'pregnancy',
  'recent_surgery',
  'cardiovascular',
  'skin_condition',
  'allergy_present',
  'blood_thinners',
  'acute_injury',
  'requires_consultation',
] as const

export type ContraindicationFlagKey = (typeof CONTRAINDICATION_FLAG_KEYS)[number]

/**
 * The crossing. Booleans keyed by the closed set, and nothing else.
 *
 * No customer id, no instant, no count, no derivation version, no free text. Each of those is a value that
 * would be true to add and wrong to carry here: an id belongs to the row this was read for, an instant says
 * when somebody filled in a health form, and a count of set flags is a measure of how ill somebody is. What
 * the booking layer needs is whether to route or to ask, and that is eight booleans.
 *
 * **`false` means "not affirmed by an answer on record". It never means "ruled out".** A template that does
 * not ask about blood thinners produces `blood_thinners: false`, because the crossing has no third state and
 * inventing an affirmative from silence would be inventing a clinical fact. The screens say so in words, and
 * `deriveContraindicationFlags` reports the undetermined answers separately — inside the boundary, where
 * they can be acted on.
 */
export type ContraindicationFlagSet = Readonly<Record<ContraindicationFlagKey, boolean>>

/**
 * The runtime shape of the crossing, written out key by key ON PURPOSE.
 *
 * A schema built by mapping over {@link CONTRAINDICATION_FLAG_KEYS} could not disagree with the key set, so
 * the introspection test asserting they are equal would be vacuous (brief rule 3). Written literally, the
 * test is a real one: it walks `.shape`, asserts every entry is a `ZodBoolean` and asserts the key set
 * equals the committed enum, so a ninth field — of any type — fails, and so does a key spelled differently
 * here from the way the enum spells it.
 *
 * `strictObject`, so an unknown key is an error rather than a value that is stripped and forgotten. A
 * stripped key is exactly how a `notes` field reaches a caller that logs whatever it was handed.
 */
export const contraindicationFlagSetSchema = z.strictObject({
  pregnancy: z.boolean(),
  recent_surgery: z.boolean(),
  cardiovascular: z.boolean(),
  skin_condition: z.boolean(),
  allergy_present: z.boolean(),
  blood_thinners: z.boolean(),
  acute_injury: z.boolean(),
  requires_consultation: z.boolean(),
})

/**
 * The one flag that means "a human has to look", rather than naming a condition.
 *
 * Named as a constant because two rules turn on it and neither may spell it: an answer the derivation
 * cannot read sets THIS flag rather than the specific one, and migration 0084 holds the same rule as a
 * CHECK (`undetermined_count = 0 or requires_consultation`). Three spellings of it would be three rules.
 */
export const CONTRAINDICATION_ESCALATION_FLAG =
  'requires_consultation' as const satisfies ContraindicationFlagKey

/**
 * The version of the DERIVATION, not of the template and not of the schema.
 *
 * Stored on every flag row so a stale set is detectable rather than silently used. It is bumped when the
 * rules change what the same answers would produce — a new key, a changed field mapping, a changed reading
 * of a missing answer. It is NOT bumped when a template changes: that is what `source_template_version`
 * records, and conflating the two would make every reword look like a code change.
 */
export const CONTRAINDICATION_DERIVATION_VERSION = 1
