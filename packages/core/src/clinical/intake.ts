import { AppError } from '@berelax/shared'
import {
  type CompliancePolicy,
  lintPublicDisplayName,
  type PublicNameFinding,
} from '../compliance/lexicon.ts'
import type { Instant } from '../time.ts'

/**
 * The pure half of clinical intake (C-CRM-08).
 *
 * Everything a decision about intake depends on, expressed as functions of their arguments: which
 * questions a template asks, what a stored answer set renders as against the version it was captured
 * under, whether a template's copy may be shown to a client under the licence in force, and whether a
 * read of a clinical record is permitted at a given instant.
 *
 * Nothing here touches a payload's ciphertext, a key or a database. That is the point: the two rules a
 * reviewer most needs to be able to check by reading — "consent could not be established is a refusal"
 * and "a read outside the step-up window is refused" — are decisions over values, and a decision over
 * values is testable without a key, a clock or a server.
 *
 * ## Two open questions live in this file, both resolved to the strict reading
 *
 * **`Y1-licence`** decides whether this is a commercial wellness activity or a healthcare one, and with
 * it the public vocabulary and the permitted staff titles. Unconfirmed, so {@link lintIntakeTemplateCopy}
 * applies the narrower vocabulary: the template's own assertive copy — its title and its consent wording
 * — goes through the full publication lexicon, and so does every question label, minus the one rule that
 * cannot survive the grammatical mood (see {@link lintIntakeQuestionCopy}).
 *
 * **`Y5-residency`** decides whether intake notes are health data subject to UAE localisation. Resolved
 * as "they are": the retention basis is the profile's healthcare-grade figure and a payload whose origin
 * is real is refused outright until the owner answers. Neither of those decisions is in this file — the
 * first is a column the repository computes, the second is migration 0082's trigger — because both have
 * to hold for a `psql` session too.
 */

/**
 * The field kinds a template may ask for. A closed set; adding one is a migration plus a version.
 *
 * **There is deliberately no numeric kind, and that is a decision about exactness rather than an omission.**
 * An answer is JSON inside the ciphertext, so a numeric field would store a body measurement as a JSON
 * number — an IEEE double — and two readings of one measurement could then fail to compare equal. The
 * database has no column for an answer, so nothing in the schema could catch it: `payload_ciphertext` is
 * `bytea` whatever is inside it, and the convention gate that refuses `real` and `double precision` on a
 * column cannot see into a payload. ADR 0007 makes the same argument for money and answers it with integer
 * `fils`; the answer here is that a measurement is captured as `short_text`, which is exact, carries the
 * unit the question asked for, and compares byte for byte.
 *
 * So a template that needs a weight asks "Weight (kg)" as `short_text`, and the string "70.1" is what is
 * stored and what comes back. If a future unit needs arithmetic over measurements, the shape to add is a
 * kind that names its smallest unit — `mass_grams`, an integer — and never a float, for the reason above.
 */
export const INTAKE_FIELD_KINDS = ['boolean', 'short_text', 'long_text', 'date', 'choice'] as const
export type IntakeFieldKind = (typeof INTAKE_FIELD_KINDS)[number]

/**
 * Kind names that would store a measurement inexactly. Asserted absent from {@link INTAKE_FIELD_KINDS}.
 *
 * A list rather than a comment, so the rule is a test rather than an intention — and named here rather than
 * in the test file so that somebody adding a kind meets it in the same module.
 */
export const INEXACT_FIELD_KIND_NAMES = [
  'number',
  'numeric',
  'decimal',
  'float',
  'double',
  'real',
  'measurement',
  'quantity',
] as const

/**
 * One question.
 *
 * `key` is the stable identifier a stored answer is keyed by and is never shown; `label` is what the
 * client reads. They are separate columns of one object for the reason the catalogue keeps two name
 * columns: renaming a question must not orphan every answer already given to it, and a label is copy
 * that a lint has an opinion about while a key is not.
 */
export interface IntakeField {
  readonly key: string
  readonly label: string
  readonly kind: IntakeFieldKind
  /** Shown under the label. Client-facing copy, so the lint reads it too. */
  readonly help?: string
  readonly required: boolean
  /** Declared exactly when `kind` is `choice`, and never otherwise. */
  readonly choices?: readonly string[]
}

/** A template version, as the pure layer sees it. No ciphertext, no row ids beyond the template's own. */
export interface IntakeTemplate {
  readonly templateId: string
  readonly version: number
  readonly locale: 'en' | 'ar'
  readonly title: string
  readonly fields: readonly IntakeField[]
  readonly consentText: string
}

/** The rules a template definition must satisfy before it is a template at all. */
export const INTAKE_DEFINITION_RULES = [
  'intake_template_has_no_fields',
  'intake_template_duplicate_field_key',
  'intake_template_choice_without_choices',
  'intake_template_choices_without_choice_kind',
  'intake_template_blank_label',
] as const
export type IntakeDefinitionRule = (typeof INTAKE_DEFINITION_RULES)[number]

/**
 * Every structural problem with a definition, by rule name, in rule order.
 *
 * All of them rather than the first, for {@link lintPublicDisplayName}'s reason: somebody told about one
 * problem fixes that one and submits again, and a template is published once per version.
 */
export function lintIntakeDefinition(
  fields: readonly IntakeField[],
): readonly IntakeDefinitionRule[] {
  const problems: IntakeDefinitionRule[] = []
  if (fields.length === 0) problems.push('intake_template_has_no_fields')
  const keys = fields.map((field) => field.key)
  if (new Set(keys).size !== keys.length) problems.push('intake_template_duplicate_field_key')
  if (fields.some((field) => field.kind === 'choice' && (field.choices ?? []).length === 0)) {
    problems.push('intake_template_choice_without_choices')
  }
  if (fields.some((field) => field.kind !== 'choice' && field.choices !== undefined)) {
    problems.push('intake_template_choices_without_choice_kind')
  }
  if (fields.some((field) => field.label.trim().length === 0)) {
    problems.push('intake_template_blank_label')
  }
  return Object.freeze(problems)
}

/**
 * The one lexicon rule a QUESTION is exempt from, and the argument for the exemption.
 *
 * `banned_claim_term` refuses copy that CLAIMS a medical or therapeutic effect. A question does not
 * claim; it asks. "Are you taking any medication for a heart condition?" contains a banned word and
 * asserts nothing about what these premises deliver — and a lint that refused it would leave an intake
 * form that cannot ask about medication, which is not a stricter form, it is an unusable one, and an
 * unusable lint is one somebody switches off (the argument `lexicon.ts` makes about its own stemming).
 *
 * Every other rule applies to a question unchanged, and each for a reason that survives the mood:
 * `unpermitted_staff_title` because "our physiotherapist will review this" names a title the licence
 * may not permit whether it is asked or asserted; `style_as_therapist_attribute` because attaching a
 * treatment style to a person is an advertisement about people in either mood; and the lexicon's own
 * entries because an unlicensed activity is not made lawful by a question mark.
 *
 * `Y1-licence` is what makes this a decision rather than a detail. The exemption is ONE rule wide and
 * named here so that widening it is a visible edit; a confirmed healthcare licence flips
 * `medical_claims_permitted` in the profile and `lintPublicDisplayName` then skips the claim list for
 * the assertive copy too — which is the configuration change, not a code change, that answering Y1 costs.
 */
const QUESTION_EXEMPT_RULE = 'banned_claim_term'

/** The full lint, for copy in which the business is ASSERTING something: a title, a consent wording. */
export const lintIntakeAssertionCopy = (
  text: string,
  policy: CompliancePolicy,
): readonly PublicNameFinding[] => lintPublicDisplayName(text, policy)

/** The lint for copy that ASKS: a question label, its help text, a choice. See {@link QUESTION_EXEMPT_RULE}. */
export const lintIntakeQuestionCopy = (
  text: string,
  policy: CompliancePolicy,
): readonly PublicNameFinding[] =>
  Object.freeze(lintPublicDisplayName(text, policy).filter((f) => f.rule !== QUESTION_EXEMPT_RULE))

/** A finding with the template string it came from, so a refusal can name the field. */
export interface IntakeCopyFinding extends PublicNameFinding {
  /** `title`, `consent_text`, or `field:<key>` / `field:<key>:help` / `field:<key>:choice`. */
  readonly at: string
}

/**
 * Every reason this template's copy may not be shown to a client, under the profile in force.
 *
 * The split between assertive and interrogative copy is the whole content of the function, and it is
 * the Y1-licence decision made concrete: the title and the consent wording are the business speaking,
 * and a question is the business asking.
 *
 * `lintQuestions` is REQUIRED and has no default, which is ADR 0025's closed-map argument applied to an
 * option object: a permissive default here would be a lint quietly not running, and the caller that
 * forgot to pass it would be the one with the newest template. It comes from
 * `clinical.intake_copy_lints_questions`, provisional against Y1-licence and true until the licence
 * classification is confirmed.
 */
export function lintIntakeTemplateCopy(
  template: Pick<IntakeTemplate, 'title' | 'consentText' | 'fields'>,
  policy: CompliancePolicy,
  options: { readonly lintQuestions: boolean },
): readonly IntakeCopyFinding[] {
  const at = (where: string, findings: readonly PublicNameFinding[]): IntakeCopyFinding[] =>
    findings.map((finding) => ({ ...finding, at: where }))

  const findings: IntakeCopyFinding[] = [
    ...at('title', lintIntakeAssertionCopy(template.title, policy)),
    ...at('consent_text', lintIntakeAssertionCopy(template.consentText, policy)),
  ]
  if (!options.lintQuestions) return Object.freeze(findings)
  for (const field of template.fields) {
    findings.push(...at(`field:${field.key}`, lintIntakeQuestionCopy(field.label, policy)))
    if (field.help !== undefined) {
      findings.push(...at(`field:${field.key}:help`, lintIntakeQuestionCopy(field.help, policy)))
    }
    for (const choice of field.choices ?? []) {
      findings.push(...at(`field:${field.key}:choice`, lintIntakeQuestionCopy(choice, policy)))
    }
  }
  return Object.freeze(findings)
}

/** Raised when a template may not be published. `userFacing`: whoever typed the copy has to change it. */
export class IntakeTemplateCopyRefused extends AppError {
  readonly findings: readonly IntakeCopyFinding[]

  constructor(findings: readonly IntakeCopyFinding[]) {
    super(
      'validation',
      `IntakeTemplateCopyRefused: ${findings.length} problem(s) with this template's copy under the ` +
        `regulatory profile in force — ${findings.map((f) => `${f.at}: "${f.term}"`).join('; ')}`,
      {
        userFacing: true,
        details: { rules: findings.map((f) => f.rule), at: findings.map((f) => f.at) },
      },
    )
    this.name = 'IntakeTemplateCopyRefused'
    this.findings = Object.freeze([...findings])
  }
}

/**
 * One answer as it renders, against the template version it was captured under.
 *
 * `label` comes from the CAPTURED version and never from the current one. That is the whole reason a
 * submission stores a template reference and a version rather than a snapshot of the labels: a stored
 * snapshot would be a second copy of the question set to keep in step, and reading the labels off the
 * current version would silently re-label old answers the day somebody rewords a question.
 */
export interface RenderedAnswer {
  readonly key: string
  readonly label: string
  readonly kind: IntakeFieldKind
  /** The answer, or null when the template asks something this submission has no answer for. */
  readonly value: string | null
  /** True when the captured version asked it and the payload has no value. */
  readonly missing: boolean
}

export interface RenderedSubmission {
  readonly templateId: string
  readonly templateVersion: number
  readonly answers: readonly RenderedAnswer[]
  /**
   * Keys in the payload that the captured version does not ask for.
   *
   * Reported rather than dropped. A payload holding an answer to a question its own version never asked
   * is a sign that a submission was written against a different definition, and silently hiding it is
   * how that goes unnoticed — the values are deliberately NOT included, only the keys, because this is
   * a diagnostic that appears on a screen.
   */
  readonly unknownKeys: readonly string[]
}

/** How a value of each kind is rendered. Deterministic, and never a locale-dependent format. */
function renderValue(kind: IntakeFieldKind, value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (kind === 'boolean') return value === true ? 'yes' : 'no'
  if (typeof value === 'string') return value.length === 0 ? null : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // An object or an array where the template asked for a scalar. Not rendered as JSON: a payload value
  // is health data and this string reaches a screen, so what is reported is the shape and not the content.
  return `[unrenderable ${Array.isArray(value) ? 'list' : typeof value}]`
}

/**
 * Renders a decrypted answer map against the template version it was captured under.
 *
 * The `template` argument is the CAPTURED version, and it is the caller's job to have fetched that row
 * rather than the current one; `assertCapturedVersion` is the guard for callers that hold both.
 */
export function renderSubmission(
  template: IntakeTemplate,
  answers: Readonly<Record<string, unknown>>,
): RenderedSubmission {
  const asked = new Set(template.fields.map((field) => field.key))
  return {
    templateId: template.templateId,
    templateVersion: template.version,
    answers: Object.freeze(
      template.fields.map((field) => {
        const value = renderValue(field.kind, answers[field.key])
        return {
          key: field.key,
          label: field.label,
          kind: field.kind,
          value,
          missing: value === null,
        }
      }),
    ),
    unknownKeys: Object.freeze(
      Object.keys(answers)
        .filter((key) => !asked.has(key))
        .sort(),
    ),
  }
}

/**
 * Refuses to render a submission against a template that is not the one it was captured under.
 *
 * The mistake this exists for is one line long and looks right: fetching the CURRENT template for the
 * locale instead of the one `template_id` names. Every label then comes from the newest version, every
 * answer still renders, and the screen is a plausible lie about what somebody was asked.
 */
export function assertCapturedVersion(
  template: IntakeTemplate,
  captured: { readonly templateId: string; readonly templateVersion: number },
): void {
  if (
    template.templateId !== captured.templateId ||
    template.version !== captured.templateVersion
  ) {
    throw new AppError(
      'invariant_violated',
      `IntakeRenderVersionMismatch: this submission was captured against template ` +
        `${captured.templateId} version ${captured.templateVersion}, and the template supplied is ` +
        `${template.templateId} version ${template.version}. An answer rendered against another ` +
        'version is labelled with questions nobody was asked.',
      { details: { suppliedVersion: template.version, capturedVersion: captured.templateVersion } },
    )
  }
}

// --- the read gate ------------------------------------------------------------------------------

/** Every reason a clinical read is refused, by name. A refusal names one of these. */
export const CLINICAL_READ_REFUSALS = [
  'clinical_consent_not_established',
  'clinical_consent_withdrawn',
  'clinical_step_up_required',
  'clinical_step_up_expired',
  'clinical_step_up_revoked',
  'clinical_step_up_purpose_mismatch',
  'clinical_read_purpose_not_stated',
] as const
export type ClinicalReadRefusal = (typeof CLINICAL_READ_REFUSALS)[number]

/** A step-up grant as the decision sees it. Instants, not rows. */
export interface StepUpGrantView {
  readonly grantId: string
  readonly employeeId: string
  readonly grantedAt: Instant
  readonly expiresAt: Instant
  readonly revokedAt: Instant | null
  readonly statedPurpose: string
}

/** The consent state for the wording the record being read was captured under. */
export interface ClinicalConsentView {
  readonly consentHash: string
  readonly consentedAt: Instant
  readonly withdrawnAt: Instant | null
}

export interface ClinicalReadRequest {
  readonly employeeId: string
  /** Why. Recorded on the audit row, and required to match the grant's own stated purpose. */
  readonly statedPurpose: string
  readonly at: Instant
  /** The live grant for this employee, or null when they have not stepped up. */
  readonly grant: StepUpGrantView | null
  /**
   * The consent record covering the wording this record was captured under, or null when there is none.
   *
   * Null is the case this whole function exists for. "We could not establish consent" and "consent was
   * refused" have to reach the same place, because the alternative — an absent record read as no
   * objection — is the one failure that cannot be recovered from after the fact.
   */
  readonly consent: ClinicalConsentView | null
}

export type ClinicalReadDecision =
  | { readonly permitted: true; readonly grantId: string; readonly statedPurpose: string }
  | { readonly permitted: false; readonly refusal: ClinicalReadRefusal; readonly because: string }

/** The shortest purpose this accepts, matching migration 0082's own CHECK so the two cannot disagree. */
export const MIN_STATED_PURPOSE_LENGTH = 8

/**
 * May this employee read this clinical record, at this instant, for this reason?
 *
 * Ordered so the refusal a caller sees is the most fundamental one. Consent first: if there is no
 * lawful basis for holding the record, no amount of authentication makes reading it permitted, and a
 * message about a second factor would send somebody to re-authenticate over a record they may not see
 * at all.
 *
 * The purpose match is the part worth arguing for. A grant that authorised any read for its window
 * would make step-up a turnstile: step up once to check a contraindication before a treatment, and the
 * same five minutes covers reading every note on every client. Requiring the read's purpose to equal
 * the grant's makes the window cover ONE stated reason, and the audit row then records a purpose
 * somebody committed to before they saw anything.
 */
export function resolveClinicalRead(request: ClinicalReadRequest): ClinicalReadDecision {
  const purpose = request.statedPurpose.trim()
  if (purpose.length < MIN_STATED_PURPOSE_LENGTH) {
    return {
      permitted: false,
      refusal: 'clinical_read_purpose_not_stated',
      because:
        `a read of a clinical record must state why, in at least ${MIN_STATED_PURPOSE_LENGTH} ` +
        'characters. An audit row whose purpose is blank cannot justify the access afterwards, which ' +
        'is the only thing the row is for',
    }
  }

  if (request.consent === null) {
    return {
      permitted: false,
      refusal: 'clinical_consent_not_established',
      because:
        'no consent record covers the wording this record was captured under. "Consent could not be ' +
        'established" is a refusal and never a default: an absent record read as no objection is the ' +
        'one mistake here that cannot be undone afterwards',
    }
  }
  if (request.consent.withdrawnAt !== null && request.consent.withdrawnAt <= request.at) {
    return {
      permitted: false,
      refusal: 'clinical_consent_withdrawn',
      because:
        'consent to this wording was withdrawn. The record is retained — a clinical record is ' +
        'evidence and is not deleted (ADR 0010) — and it may not be read',
    }
  }

  const grant = request.grant
  if (grant === null || grant.employeeId !== request.employeeId) {
    return {
      permitted: false,
      refusal: 'clinical_step_up_required',
      because:
        'reading a clinical record needs a second factor re-entered for this purpose. An ordinary ' +
        'admin session is not enough: a stolen session cookie would otherwise reach health data',
    }
  }
  if (grant.revokedAt !== null && grant.revokedAt <= request.at) {
    return {
      permitted: false,
      refusal: 'clinical_step_up_revoked',
      because: 'the step-up grant for this purpose was revoked before this read',
    }
  }
  if (request.at >= grant.expiresAt) {
    return {
      permitted: false,
      refusal: 'clinical_step_up_expired',
      because:
        'the step-up window has closed. The window is short on purpose: it bounds how much can be ' +
        'read on one re-authentication, which is what makes the audit trail a record of decisions ' +
        'rather than of one login',
    }
  }
  if (grant.statedPurpose.trim() !== purpose) {
    return {
      permitted: false,
      refusal: 'clinical_step_up_purpose_mismatch',
      because:
        `this grant was given for "${grant.statedPurpose}" and this read declares "${purpose}". A ` +
        'grant covers one stated reason; without that, stepping up once to check a contraindication ' +
        'would cover reading every note on every client for the rest of the window',
    }
  }

  return { permitted: true, grantId: grant.grantId, statedPurpose: purpose }
}

/** Raised by a caller that turns a refusal into an error. The refusal name is on `details.refusal`. */
export class ClinicalReadRefused extends AppError {
  readonly refusal: ClinicalReadRefusal

  constructor(decision: Extract<ClinicalReadDecision, { permitted: false }>) {
    super('forbidden', `${decision.refusal}: ${decision.because}`, {
      details: { refusal: decision.refusal },
    })
    this.name = 'ClinicalReadRefused'
    this.refusal = decision.refusal
  }
}

/**
 * The AAD's fourth term for an intake payload, spelled in exactly one place.
 *
 * Migration 0082 stores this string in `aad_context` and a CHECK ties it to the `template_version`
 * column, so the format is asserted in the database as well. Two spellings of it would be two AADs,
 * and the second one presents as a payload nothing can decrypt.
 */
export const intakeAadContext = (templateVersion: number): string => {
  if (!Number.isInteger(templateVersion) || templateVersion < 1) {
    throw new AppError(
      'validation',
      `A template version must be a positive integer, received ${String(templateVersion)}`,
    )
  }
  return `template_version=${templateVersion}`
}
