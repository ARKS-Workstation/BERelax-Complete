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
