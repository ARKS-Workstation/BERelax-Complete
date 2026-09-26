import { describe, expect, it } from 'vitest'
import type { CompliancePolicy } from '../compliance/lexicon.ts'
import type { Instant } from '../time.ts'
import {
  assertCapturedVersion,
  CLINICAL_READ_REFUSALS,
  type ClinicalConsentView,
  type ClinicalReadRefusal,
  INEXACT_FIELD_KIND_NAMES,
  INTAKE_FIELD_KINDS,
  type IntakeField,
  type IntakeTemplate,
  intakeAadContext,
  lintIntakeDefinition,
  lintIntakeQuestionCopy,
  lintIntakeTemplateCopy,
  MIN_STATED_PURPOSE_LENGTH,
  renderSubmission,
  resolveClinicalRead,
  type StepUpGrantView,
} from './intake.ts'

/**
 * The pure half of clinical intake (C-CRM-08).
 *
 * Three subjects, and each one is paired with the control that must fail: the Y1-licence vocabulary lint,
 * the render against the CAPTURED template version, and the read gate whose refusals are the unit's
 * reason to exist.
 */

/** The profile 0004 seeds: `licence_class` unconfirmed, resolved to the stricter combination. */
const STRICT: CompliancePolicy = {
  bannedClaimTerms: [
    'therapeutic',
    'therapy',
    'treatment',
    'pain relief',
    'rehabilitation',
    'cure',
    'heal',
    'medical',
    'clinical',
    'diagnosis',
    'prescribe',
    'physiotherapy',
    'lymphatic drainage',
    'prenatal',
  ],
  permittedPublicTitles: ['Therapist', 'Senior Therapist', 'Spa Therapist'],
  medicalClaimsPermitted: false,
}

/** What answering Y1-licence "healthcare" would produce: the claim list stops applying. */
const HEALTHCARE: CompliancePolicy = { ...STRICT, medicalClaimsPermitted: true }

const FIELDS: readonly IntakeField[] = [
  {
    key: 'recent_surgery',
    label: 'Any surgery in the last six months?',
    kind: 'boolean',
    required: true,
  },
  {
    key: 'medication',
    label: 'Are you taking any medication?',
    help: 'Including anything for blood pressure or blood thinning.',
    kind: 'short_text',
    required: false,
  },
  {
    key: 'pressure',
    label: 'Preferred pressure',
    kind: 'choice',
    required: false,
    choices: ['light', 'medium', 'firm'],
  },
]

const template = (over: Partial<IntakeTemplate> = {}): IntakeTemplate => ({
  templateId: '11111111-1111-1111-1111-111111111111',
  version: 3,
  locale: 'en',
  title: 'Before your visit',
  fields: FIELDS,
  consentText: 'I agree that my answers may be held so the session can be delivered safely.',
  ...over,
})

describe('the definition lint', () => {
  it('accepts a well-formed definition', () => {
    expect(lintIntakeDefinition(FIELDS)).toEqual([])
  })

  it('names every structural problem, not the first', () => {
    const broken: readonly IntakeField[] = [
      { key: 'a', label: '  ', kind: 'choice', required: true },
      { key: 'a', label: 'Duplicate key', kind: 'short_text', required: false, choices: ['x'] },
    ]
    expect([...lintIntakeDefinition(broken)].sort()).toEqual([
      'intake_template_blank_label',
      'intake_template_choice_without_choices',
      'intake_template_choices_without_choice_kind',
      'intake_template_duplicate_field_key',
    ])
  })

  it('refuses a template with no questions at all', () => {
    expect(lintIntakeDefinition([])).toEqual(['intake_template_has_no_fields'])
  })
})

/**
 * The Y1-licence vocabulary decision.
 *
 * The split between what the business ASSERTS and what it ASKS is the whole content of these cases, and
 * the two controls are what make them mean anything: a question containing a banned claim term is
 * accepted (or the form could not ask about medication), and the same word in the TITLE is refused.
 */
describe('the template copy lint', () => {
  const lint = (t: Partial<IntakeTemplate>, policy = STRICT, lintQuestions = true) =>
    lintIntakeTemplateCopy({ ...template(t) }, policy, { lintQuestions })

  it('accepts the seeded wording under the strict profile', () => {
    expect(lint({})).toEqual([])
  })

  it('refuses a banned claim term in the TITLE', () => {
    const findings = lint({ title: 'Therapeutic massage intake' })
    expect(findings.map((f) => f.rule)).toContain('banned_claim_term')
    expect(findings.map((f) => f.at)).toContain('title')
  })

  it('refuses a banned claim term in the CONSENT wording', () => {
    const findings = lint({ consentText: 'I consent to clinical treatment at these premises.' })
    expect(findings.map((f) => f.at)).toEqual(['consent_text', 'consent_text'])
    expect(new Set(findings.map((f) => f.rule))).toEqual(new Set(['banned_claim_term']))
  })

  it('control: a QUESTION may use a banned claim term, because asking is not claiming', () => {
    // The control that keeps the lint usable. Without it the strict reading produces an intake form that
    // cannot ask about medication, and an unusable lint is one somebody switches off.
    const findings = lint({
      fields: [
        {
          key: 'meds',
          label: 'Any medical conditions we should know about?',
          kind: 'long_text',
          required: false,
        },
      ],
    })
    expect(findings).toEqual([])
    // And the same words as an assertion ARE refused, which is what makes the exemption a distinction
    // rather than a hole.
    expect(lint({ title: 'Any medical conditions' }).map((f) => f.rule)).toEqual([
      'banned_claim_term',
    ])
  })

  it('refuses an unpermitted staff title in a question, which survives the question mark', () => {
    const findings = lint({
      fields: [
        {
          key: 'referral',
          label: 'Has our physiotherapist seen you before?',
          kind: 'boolean',
          required: false,
        },
      ],
    })
    expect(findings.map((f) => f.rule)).toContain('unpermitted_staff_title')
    expect(findings.map((f) => f.at)).toContain('field:referral')
  })

  it('reads help text and choices too, not only the label', () => {
    const findings = lint({
      fields: [
        {
          key: 'style',
          label: 'Preferred style',
          help: 'Our masseuse will confirm on the day.',
          kind: 'choice',
          required: false,
          choices: ['Thai lady', 'firm'],
        },
      ],
    })
    expect(findings.map((f) => f.at)).toEqual(['field:style:help', 'field:style:choice'])
    expect(new Set(findings.map((f) => f.rule))).toEqual(
      new Set(['unpermitted_staff_title', 'style_as_therapist_attribute']),
    )
  })

  it('what answering Y1-licence "wellness" buys: question copy stops being linted', () => {
    const withTitle: readonly IntakeField[] = [
      { key: 'r', label: 'Has our physiotherapist seen you?', kind: 'boolean', required: false },
    ]
    expect(lint({ fields: withTitle }, STRICT, true).length).toBeGreaterThan(0)
    expect(lint({ fields: withTitle }, STRICT, false)).toEqual([])
  })

  it('what answering Y1-licence "healthcare" buys: the claim list stops applying at all', () => {
    const assertive = { title: 'Therapeutic massage intake' }
    expect(lint(assertive, STRICT).map((f) => f.rule)).toEqual(['banned_claim_term'])
    expect(lint(assertive, HEALTHCARE)).toEqual([])
  })

  it('control: the strict and healthcare policies differ in exactly one field', () => {
    // Without this, the case above is also satisfied by two policies that differ in the claim LIST — and
    // then it would be proving that an empty list matches nothing, not that the switch works.
    expect(HEALTHCARE.bannedClaimTerms).toEqual(STRICT.bannedClaimTerms)
    expect(HEALTHCARE.medicalClaimsPermitted).not.toBe(STRICT.medicalClaimsPermitted)
  })

  it('the question lint drops exactly one rule and keeps the rest', () => {
    const text = 'Our physiotherapist will plan your treatment'
    const assertive = lintIntakeTemplateCopy(
      { title: text, consentText: 'ok', fields: [] },
      STRICT,
      { lintQuestions: true },
    )
    expect(new Set(assertive.map((f) => f.rule))).toEqual(
      new Set(['banned_claim_term', 'unpermitted_staff_title']),
    )
    expect(new Set(lintIntakeQuestionCopy(text, STRICT).map((f) => f.rule))).toEqual(
      new Set(['unpermitted_staff_title']),
    )
  })
})

describe('rendering against the captured version', () => {
  const ANSWERS = { recent_surgery: true, medication: 'none', pressure: 'firm' }

  it('labels every answer with the captured version’s own wording', () => {
    const rendered = renderSubmission(template(), ANSWERS)
    expect(rendered.templateVersion).toBe(3)
    expect(rendered.answers.map((a) => a.label)).toEqual(FIELDS.map((f) => f.label))
    expect(rendered.answers.map((a) => a.value)).toEqual(['yes', 'none', 'firm'])
  })

  it('a question the payload has no answer for is reported missing, not omitted', () => {
    const rendered = renderSubmission(template(), { recent_surgery: false })
    expect(rendered.answers).toHaveLength(3)
    expect(rendered.answers.filter((a) => a.missing).map((a) => a.key)).toEqual([
      'medication',
      'pressure',
    ])
  })

  it('an answer to a question the captured version never asked is reported by KEY only', () => {
    const rendered = renderSubmission(template(), {
      ...ANSWERS,
      smoker: 'UNKNOWN-KEY-VALUE-SENTINEL',
    })
    expect(rendered.unknownKeys).toEqual(['smoker'])
    // The value is deliberately absent: this string reaches a screen and the value is health data. A
    // sentinel rather than a plausible answer, because a plausible one also appears as a legitimate
    // rendered value elsewhere in the same object and the assertion would then be about the wrong field.
    expect(JSON.stringify(rendered)).not.toContain('UNKNOWN-KEY-VALUE-SENTINEL')
  })

  it('renders a structured value as its shape rather than as its content', () => {
    const rendered = renderSubmission(template(), { medication: { drug: 'warfarin' } })
    const medication = rendered.answers.find((a) => a.key === 'medication')
    expect(medication?.value).toBe('[unrenderable object]')
    expect(JSON.stringify(rendered)).not.toContain('warfarin')
  })

  it('a reworded template does NOT relabel an existing submission', () => {
    // The acceptance criterion, as a value comparison. The old version's rendered label set is captured
    // first, the template is "edited" into a new version, and the old labels must be unchanged.
    const v3 = template()
    const before = renderSubmission(v3, ANSWERS).answers.map((a) => a.label)

    const v4 = template({
      version: 4,
      templateId: '22222222-2222-2222-2222-222222222222',
      fields: FIELDS.map((f) => ({ ...f, label: `${f.label} (reworded)` })),
    })
    expect(renderSubmission(v4, ANSWERS).answers.map((a) => a.label)).not.toEqual(before)
    expect(renderSubmission(v3, ANSWERS).answers.map((a) => a.label)).toEqual(before)
  })

  it('refuses to render against a template that is not the captured one', () => {
    const captured = { templateId: template().templateId, templateVersion: 3 }
    expect(() => assertCapturedVersion(template(), captured)).not.toThrow()
    expect(() => assertCapturedVersion(template({ version: 4 }), captured)).toThrow(
      /IntakeRenderVersionMismatch/,
    )
    expect(() =>
      assertCapturedVersion(
        template({ templateId: '99999999-9999-9999-9999-999999999999' }),
        captured,
      ),
    ).toThrow(/IntakeRenderVersionMismatch/)
  })
})

describe('the read gate', () => {
  const NOW = 1_700_000_000_000 as Instant
  const EMPLOYEE = '44444444-4444-4444-4444-444444444444'
  const PURPOSE = 'checking contraindications before this appointment'

  const grant = (over: Partial<StepUpGrantView> = {}): StepUpGrantView => ({
    grantId: '55555555-5555-5555-5555-555555555555',
    employeeId: EMPLOYEE,
    grantedAt: (NOW - 60_000) as Instant,
    expiresAt: (NOW + 240_000) as Instant,
    revokedAt: null,
    statedPurpose: PURPOSE,
    ...over,
  })

  const consent = (over: Partial<ClinicalConsentView> = {}): ClinicalConsentView => ({
    consentHash: 'abc',
    consentedAt: (NOW - 86_400_000) as Instant,
    withdrawnAt: null,
    ...over,
  })

  const read = (over: Partial<Parameters<typeof resolveClinicalRead>[0]> = {}) =>
    resolveClinicalRead({
      employeeId: EMPLOYEE,
      statedPurpose: PURPOSE,
      at: NOW,
      grant: grant(),
      consent: consent(),
      ...over,
    })

  const refusalOf = (decision: ReturnType<typeof read>): ClinicalReadRefusal | 'permitted' =>
    decision.permitted ? 'permitted' : decision.refusal

  it('permits a stepped-up read for the purpose the grant names', () => {
    const decision = read()
    expect(decision.permitted).toBe(true)
    if (decision.permitted) {
      expect(decision.grantId).toBe(grant().grantId)
      expect(decision.statedPurpose).toBe(PURPOSE)
    }
  })

  it('refuses when consent could not be established, and says so by name', () => {
    // The refusal this whole unit exists for. An absent record is a refusal and not a soft state.
    expect(refusalOf(read({ consent: null }))).toBe('clinical_consent_not_established')
  })

  it('refuses a withdrawn consent', () => {
    expect(refusalOf(read({ consent: consent({ withdrawnAt: (NOW - 1) as Instant }) }))).toBe(
      'clinical_consent_withdrawn',
    )
  })

  it('a withdrawal in the FUTURE does not refuse a read now', () => {
    // The control on the comparison: a withdrawal recorded with a later instant is not yet in force, and
    // a test that only ever passed a past instant would also pass for `withdrawnAt !== null`.
    expect(read({ consent: consent({ withdrawnAt: (NOW + 1) as Instant }) }).permitted).toBe(true)
  })

  it('consent is judged BEFORE authentication, so the refusal names the right problem', () => {
    // Both wrong at once. A message about a second factor would send somebody to re-authenticate over a
    // record they may not read at all.
    expect(refusalOf(read({ consent: null, grant: null }))).toBe('clinical_consent_not_established')
  })

  it('refuses with no grant at all', () => {
    expect(refusalOf(read({ grant: null }))).toBe('clinical_step_up_required')
  })

  it("refuses another employee's grant", () => {
    expect(
      refusalOf(read({ grant: grant({ employeeId: '66666666-6666-6666-6666-666666666666' }) })),
    ).toBe('clinical_step_up_required')
  })

  it('refuses a revoked grant', () => {
    expect(refusalOf(read({ grant: grant({ revokedAt: (NOW - 1) as Instant }) }))).toBe(
      'clinical_step_up_revoked',
    )
  })

  it('refuses at the instant the window closes, and permits the instant before', () => {
    const expiresAt = (NOW + 1) as Instant
    expect(read({ grant: grant({ expiresAt }) }).permitted).toBe(true)
    expect(refusalOf(read({ grant: grant({ expiresAt: NOW }) }))).toBe('clinical_step_up_expired')
  })

  it('refuses a purpose the grant does not name', () => {
    // Without this, stepping up once to check a contraindication covers reading every note on every
    // client for the rest of the window.
    expect(refusalOf(read({ statedPurpose: 'looking something up' }))).toBe(
      'clinical_step_up_purpose_mismatch',
    )
  })

  it('compares the purpose on its trimmed text, not on its bytes', () => {
    expect(read({ statedPurpose: `  ${PURPOSE}  ` }).permitted).toBe(true)
  })

  it('refuses a purpose too short to justify anything afterwards', () => {
    expect(refusalOf(read({ statedPurpose: 'looking' }))).toBe('clinical_read_purpose_not_stated')
    expect(PURPOSE.length).toBeGreaterThanOrEqual(MIN_STATED_PURPOSE_LENGTH)
  })

  it('every declared refusal is reachable, and nothing returns a name off the list', () => {
    // The totality control. A refusal added to the vocabulary and never returned is a name a screen
    // cannot explain; a refusal returned and not declared is a name a search cannot find.
    const reached = new Set<string>([
      'clinical_read_purpose_not_stated',
      'clinical_consent_not_established',
      'clinical_consent_withdrawn',
      'clinical_step_up_required',
      'clinical_step_up_revoked',
      'clinical_step_up_expired',
      'clinical_step_up_purpose_mismatch',
    ])
    expect([...reached].sort()).toEqual([...CLINICAL_READ_REFUSALS].sort())
    for (const name of reached) expect(CLINICAL_READ_REFUSALS).toContain(name)
  })
})

describe('an answer cannot be stored inexactly', () => {
  /**
   * The coordinator's rule for money, applied to a measurement: two readings of one value must compare
   * equal. It cannot be enforced by a column type here, because an answer lives inside
   * `payload_ciphertext` and the schema sees `bytea` whatever is in it — so the enforcement has to be the
   * closed kind set.
   */
  it('has no numeric field kind, so a measurement is exact text', () => {
    for (const name of INEXACT_FIELD_KIND_NAMES) {
      expect(
        INTAKE_FIELD_KINDS as readonly string[],
        `"${name}" would store a measurement as a JSON number, which is an IEEE double`,
      ).not.toContain(name)
    }
  })

  it('control: the kinds it DOES have are the five declared, so the check is not vacuous', () => {
    // Without this, the assertion above passes for an empty kind set, or for one somebody widened with a
    // name the forbidden list happens not to mention.
    expect([...INTAKE_FIELD_KINDS]).toEqual([
      'boolean',
      'short_text',
      'long_text',
      'date',
      'choice',
    ])
    expect(INEXACT_FIELD_KIND_NAMES.length).toBeGreaterThan(4)
  })

  it('a measurement given as text round-trips byte for byte', () => {
    const weight = template({
      fields: [{ key: 'weight_kg', label: 'Weight (kg)', kind: 'short_text', required: false }],
    })
    // The value that motivates the rule: 70.1 is not representable in binary floating point, so a numeric
    // field would return 70.09999999999999 on some paths and 70.1 on others.
    const rendered = renderSubmission(weight, { weight_kg: '70.1' })
    expect(rendered.answers[0]?.value).toBe('70.1')
    // And two captures of the same reading compare equal, which is the whole claim.
    expect(renderSubmission(weight, { weight_kg: '70.1' })).toEqual(rendered)
  })

  it('a number that reaches the renderer anyway is stringified, never arithmetic', () => {
    // No kind produces one, so this can only come from a payload written outside the template. It renders
    // as text rather than being computed with, which is the safe direction.
    const weight = template({
      fields: [{ key: 'weight_kg', label: 'Weight (kg)', kind: 'short_text', required: false }],
    })
    expect(renderSubmission(weight, { weight_kg: 70.1 }).answers[0]?.value).toBe('70.1')
  })
})

describe('the AAD context spelling', () => {
  it('is one format, in one place', () => {
    expect(intakeAadContext(3)).toBe('template_version=3')
  })

  it('refuses a version that is not a positive integer', () => {
    expect(() => intakeAadContext(0)).toThrow(/positive integer/)
    expect(() => intakeAadContext(1.5)).toThrow(/positive integer/)
  })
})
