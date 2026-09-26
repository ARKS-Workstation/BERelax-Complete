import {
  CONTRAINDICATION_DERIVATION_VERSION,
  CONTRAINDICATION_ESCALATION_FLAG,
  CONTRAINDICATION_FLAG_KEYS,
  type ContraindicationFlagKey,
  type ContraindicationFlagSet,
  contraindicationFlagSetSchema,
} from '@berelax/shared'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { ROLES, type Role } from '../access/permissions.ts'
import { type CompliancePolicy, lintPublicDisplayName } from '../compliance/lexicon.ts'
import { CLINICAL_FIELD_MARKERS } from '../identity/booking-token.ts'
import {
  CONTRAINDICATION_FALSE_MEANING,
  CONTRAINDICATION_FLAG_ACTIONS,
  CONTRAINDICATION_FLAG_LABELS,
  CONTRAINDICATION_SESSIONLESS_CEILING_ROLE,
  deriveContraindicationFlags,
  lintContraindicationCopy,
  lintContraindicationDefinition,
  narrowContraindicationAccess,
  resolveContraindicationAccess,
  resolveContraindicationFreshness,
} from './contraindication-flags.ts'
import type { IntakeField, IntakeTemplate } from './intake.ts'

/**
 * The boolean-only crossing, proved over values (C-CRM-09).
 *
 * Every claim in this file is a claim about a function of its arguments, which is why the derivation is pure:
 * no key, no clock, no database, no server. `packages/clinical/src/flags-view.itest.ts` proves the half only
 * a real database can — that the app role reads the view holding no clinical privilege, that the two layers
 * of each rule are separate, and that a sentinel in a stored payload reaches no table and no screen.
 */

/** The profile in force, as migration 0004 seeds it. Y1-licence unconfirmed resolves to this. */
const SEEDED_POLICY: CompliancePolicy = {
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

const field = (over: Partial<IntakeField> & Pick<IntakeField, 'key'>): IntakeField => ({
  label: `Question ${over.key}`,
  kind: 'boolean',
  required: false,
  ...over,
})

const template = (fields: readonly IntakeField[], version = 3): IntakeTemplate => ({
  templateId: '11111111-1111-7111-8111-111111111111',
  version,
  locale: 'en',
  title: 'Before your massage',
  fields,
  consentText: 'I agree that the answers above may be held and read by the staff treating me.',
})

// ------------------------------------------------------------------------------------------------
// The crossing type
// ------------------------------------------------------------------------------------------------

describe('acceptance — the exported crossing type is Record<FlagKey, boolean> and nothing else', () => {
  it('is exactly the closed record, at the type level', () => {
    expectTypeOf<ContraindicationFlagSet>().toEqualTypeOf<
      Readonly<Record<ContraindicationFlagKey, boolean>>
    >()
    // The control. Without it the assertion above is satisfied by a type that is merely ASSIGNABLE to the
    // record, which every wider object is — a shape with a `note` on it included.
    expectTypeOf<ContraindicationFlagSet>().not.toEqualTypeOf<
      Readonly<Record<ContraindicationFlagKey, boolean>> & { readonly note: string }
    >()
    expectTypeOf<ContraindicationFlagSet>().not.toEqualTypeOf<
      Readonly<Record<ContraindicationFlagKey, boolean>> & { readonly updatedAt: Date }
    >()
  })

  it('has a runtime shape whose every field is a boolean and whose keys are the committed enum', () => {
    const shape = contraindicationFlagSetSchema.shape
    expect(Object.keys(shape).sort()).toEqual([...CONTRAINDICATION_FLAG_KEYS].sort())
    for (const [key, member] of Object.entries(shape)) {
      expect(member.def.type, `${key} is not a boolean in the schema`).toBe('boolean')
    }
    // The control on the introspection itself: `def.type` has to be able to report something other than
    // 'boolean', or the loop above is a loop over a property that always reads the same.
    expect(contraindicationFlagSetSchema.def.type).toBe('object')
  })

  it('refuses a string field added to the crossing, at run time', () => {
    const valid = Object.fromEntries(CONTRAINDICATION_FLAG_KEYS.map((key) => [key, false]))
    expect(contraindicationFlagSetSchema.safeParse(valid).success).toBe(true)
    // A `notes` field is the one somebody adds, and `strictObject` is why it is an error rather than a
    // property that is stripped and then travels in whatever the caller logged before parsing.
    const leaking = contraindicationFlagSetSchema.safeParse({ ...valid, notes: 'recent surgery' })
    expect(leaking.success).toBe(false)
    expect(leaking.error?.issues[0]?.code).toBe('unrecognized_keys')
    // And a flag that is not a boolean.
    expect(contraindicationFlagSetSchema.safeParse({ ...valid, pregnancy: 'yes' }).success).toBe(
      false,
    )
  })
})

// ------------------------------------------------------------------------------------------------
// The derivation
// ------------------------------------------------------------------------------------------------

describe('acceptance — the derivation is pure, deterministic and total', () => {
  const asked = [
    field({ key: 'pregnancy', label: 'Are you pregnant?' }),
    field({ key: 'recent_surgery', label: 'Any surgery in the last six months?' }),
  ]

  it('sets a flag from an affirmative boolean answer and from nothing else', () => {
    const out = deriveContraindicationFlags(template(asked), {
      pregnancy: true,
      recent_surgery: false,
    })
    expect(out.flags.pregnancy).toBe(true)
    expect(out.flags.recent_surgery).toBe(false)
    expect(out.flags[CONTRAINDICATION_ESCALATION_FLAG]).toBe(false)
    expect(out.undetermined).toEqual([])
    expect(out.derivationVersion).toBe(CONTRAINDICATION_DERIVATION_VERSION)
    expect(out.sourceTemplateVersion).toBe(3)
  })

  it('yields the same set for the same payload, every time', () => {
    const answers = { pregnancy: true, recent_surgery: false }
    const first = deriveContraindicationFlags(template(asked), answers)
    const second = deriveContraindicationFlags(template(asked), answers)
    expect(second.flags).toEqual(first.flags)
    expect(second.provenance).toEqual(first.provenance)
    // The control: a different payload must produce a different set, or the equality above is satisfied by
    // a derivation that ignores its argument.
    const other = deriveContraindicationFlags(template(asked), {
      pregnancy: false,
      recent_surgery: true,
    })
    expect(other.flags).not.toEqual(first.flags)
  })

  it('always answers every key of the closed set', () => {
    const out = deriveContraindicationFlags(template([]), {})
    expect(Object.keys(out.flags).sort()).toEqual([...CONTRAINDICATION_FLAG_KEYS].sort())
    for (const key of CONTRAINDICATION_FLAG_KEYS) {
      expect(typeof out.flags[key], `${key} is not a boolean`).toBe('boolean')
    }
  })

  /**
   * Three shapes of unreadable, because they arrive by different routes: the question was skipped, the
   * payload carries a string where the form asked a boolean, and the value is explicitly null.
   */
  const UNREADABLE: readonly Readonly<Record<string, unknown>>[] = [
    {},
    { pregnancy: 'yes' },
    { pregnancy: null },
  ]

  it('escalates an answer it cannot read', () => {
    for (const answers of UNREADABLE) {
      const out = deriveContraindicationFlags(template([asked[0] as IntakeField]), answers)
      expect(out.undetermined).toEqual(['pregnancy'])
      expect(out.flags[CONTRAINDICATION_ESCALATION_FLAG]).toBe(true)
    }
  })

  /**
   * The other half, in a test of its own rather than a second assertion in the one above.
   *
   * Two mutations produce opposite defects — dropping the escalation, and letting the escalation ALSO set
   * the specific flag — and both fail one combined test, so a gate case could not say which it had caught.
   * Split, each has an assertion that only it breaks.
   */
  it('never asserts the condition from an answer it could not read', () => {
    for (const answers of UNREADABLE) {
      const out = deriveContraindicationFlags(template([asked[0] as IntakeField]), answers)
      expect(out.flags.pregnancy).toBe(false)
    }
    // The control: the same flag IS set from an answer that says so, or the assertion above is satisfied by
    // a derivation that never sets anything.
    expect(
      deriveContraindicationFlags(template([asked[0] as IntakeField]), { pregnancy: true }).flags
        .pregnancy,
    ).toBe(true)
  })

  it('does NOT escalate a question the captured version never asked', () => {
    const out = deriveContraindicationFlags(template([asked[0] as IntakeField]), {
      pregnancy: false,
    })
    expect(out.notAsked).toContain('blood_thinners')
    expect(out.flags.blood_thinners).toBe(false)
    // The whole reason `not_asked` and `undetermined` are separate readings: escalating every unasked flag
    // would light the marker for every submission of every real template, and a marker that is always lit
    // is a marker nobody reads.
    expect(out.flags[CONTRAINDICATION_ESCALATION_FLAG]).toBe(false)
  })

  it('never reads free text, and the payload value reaches nothing it returns', () => {
    // The form asks about medication as free text and asks NO boolean about blood thinners. A derivation
    // that pattern-matched the answer would set the flag and would be asserting a fact about somebody's
    // health that nobody stated.
    const drug = 'SYNTHETIC-DRUG-NAME-4QK7'
    const out = deriveContraindicationFlags(
      template([
        field({ key: 'medication', label: 'Are you taking any medication?', kind: 'short_text' }),
        field({ key: 'pregnancy', label: 'Are you pregnant?' }),
      ]),
      { medication: drug, pregnancy: false },
    )
    expect(out.flags.blood_thinners).toBe(false)
    expect(out.undetermined).toEqual([])
    // Asserted on the BYTES of everything that comes back, not on one field. A round trip that checked
    // `flags.blood_thinners` alone would pass for a derivation that put the answer in its provenance.
    expect(JSON.stringify(out)).not.toContain(drug)
    // The control on that search: the sweep has to be able to find the value it is looking for.
    expect(JSON.stringify({ ...out, planted: drug })).toContain(drug)
  })

  it('treats a flag-keyed question of the wrong kind as unreadable rather than as a no', () => {
    const out = deriveContraindicationFlags(
      template([
        field({ key: 'recent_surgery', label: 'Describe any recent surgery', kind: 'long_text' }),
      ]),
      { recent_surgery: 'nothing to report' },
    )
    expect(out.undetermined).toEqual(['recent_surgery'])
    expect(out.flags.recent_surgery).toBe(false)
    expect(out.flags[CONTRAINDICATION_ESCALATION_FLAG]).toBe(true)
  })

  it('lets any affirmative win when one version asks a flag twice', () => {
    const two = [
      field({ key: 'pregnancy', label: 'Are you pregnant?' }),
      field({ key: 'pregnancy', label: 'Are you expecting?' }),
    ]
    expect(deriveContraindicationFlags(template(two), { pregnancy: true }).flags.pregnancy).toBe(
      true,
    )
    // And the safe ordering when they disagree in the other direction: unreadable beats denied.
    const undecided = deriveContraindicationFlags(template(two), {})
    expect(undecided.undetermined).toEqual(['pregnancy'])
  })

  it('traces every determined flag to the wording the CAPTURED version stored', () => {
    const wording = 'Any surgery in the last six months?'
    const out = deriveContraindicationFlags(
      template([field({ key: 'recent_surgery', label: wording })]),
      { recent_surgery: true },
    )
    const entry = out.provenance.find((p) => p.flag === 'recent_surgery')
    expect(entry?.reading).toBe('affirmed')
    expect(entry?.fieldKey).toBe('recent_surgery')
    expect(entry?.label).toBe(wording)
    // A flag nothing asked about has no wording to name, and claiming one would be the invention this
    // whole field exists to prevent.
    expect(out.provenance.find((p) => p.flag === 'pregnancy')?.label).toBeNull()
  })

  it('says in words what a false flag means, so nobody reads it as ruled out', () => {
    expect(CONTRAINDICATION_FALSE_MEANING.toLowerCase()).toContain('does not mean')
    expect(CONTRAINDICATION_FALSE_MEANING.toLowerCase()).toContain('ruled out')
  })
})

// ------------------------------------------------------------------------------------------------
// The publication rules
// ------------------------------------------------------------------------------------------------

describe('a template that could not derive the flags it appears to is refused', () => {
  it('refuses a flag-keyed question asked as anything but a boolean', () => {
    const problems = lintContraindicationDefinition([
      field({ key: 'recent_surgery', kind: 'long_text' }),
    ])
    expect(problems.map((p) => p.rule)).toEqual(['contraindication_field_must_be_boolean'])
    expect(problems[0]?.fieldKey).toBe('recent_surgery')
  })

  it('refuses asking the client to answer the escalation flag', () => {
    const problems = lintContraindicationDefinition([
      field({ key: CONTRAINDICATION_ESCALATION_FLAG }),
    ])
    expect(problems.map((p) => p.rule)).toEqual(['escalation_flag_is_not_a_question'])
  })

  it('permits a boolean flag question and any shape of non-flag question', () => {
    expect(
      lintContraindicationDefinition([
        field({ key: 'pregnancy' }),
        field({ key: 'medication', kind: 'short_text' }),
        field({ key: 'pressure', kind: 'choice', choices: ['light', 'firm'] }),
      ]),
    ).toEqual([])
  })
})

// ------------------------------------------------------------------------------------------------
// Staleness
// ------------------------------------------------------------------------------------------------

describe('acceptance — a stale flag set is detectable rather than silently used', () => {
  const live = { submissionId: 'aaaa', templateVersion: 3 }
  const stored = { derivationVersion: 1, sourceSubmissionId: 'aaaa', sourceTemplateVersion: 3 }
  const fresh = {
    stored,
    liveSubmission: live,
    currentTemplateVersion: 3,
    currentDerivationVersion: 1,
  }

  it('is fresh when the derivation, the submission and the version all agree', () => {
    expect(resolveContraindicationFreshness(fresh)).toEqual({ fresh: true })
  })

  it('reports a bumped TEMPLATE version, which is the acceptance case', () => {
    const verdict = resolveContraindicationFreshness({ ...fresh, currentTemplateVersion: 4 })
    expect(verdict).toMatchObject({ fresh: false, reason: 'template_version_changed' })
    // The control: the verdict has to turn on the NUMBERS and not on the field being present.
    expect(resolveContraindicationFreshness({ ...fresh, currentTemplateVersion: 3 }).fresh).toBe(
      true,
    )
  })

  it('reports a bumped DERIVATION version', () => {
    expect(
      resolveContraindicationFreshness({ ...fresh, currentDerivationVersion: 2 }),
    ).toMatchObject({ fresh: false, reason: 'derivation_version_changed' })
  })

  it('reports a newer submission the flags did not come from', () => {
    expect(
      resolveContraindicationFreshness({
        ...fresh,
        liveSubmission: { submissionId: 'bbbb', templateVersion: 3 },
      }),
    ).toMatchObject({ fresh: false, reason: 'source_submission_changed' })
  })

  it('reports a submission with no flag row as a gap, never as "no contraindications"', () => {
    expect(resolveContraindicationFreshness({ ...fresh, stored: null })).toMatchObject({
      fresh: false,
      reason: 'no_flags_derived',
    })
  })

  it('is fresh for a client who has filled in no form at all', () => {
    // Nothing to be stale about, and this must not report `no_flags_derived`: a client with no submission
    // has no flags, which is a complete answer rather than a missing one.
    expect(
      resolveContraindicationFreshness({
        stored: null,
        liveSubmission: null,
        currentTemplateVersion: null,
        currentDerivationVersion: 1,
      }),
    ).toEqual({ fresh: true })
  })
})

// ------------------------------------------------------------------------------------------------
// Who may read what
// ------------------------------------------------------------------------------------------------

describe('acceptance — field-level RBAC over the crossing', () => {
  const THERAPIST = 'e1111111-1111-7111-8111-111111111111'
  const OTHER = 'e2222222-2222-7222-8222-222222222222'

  it('a receptionist reads the flag set and is refused the note BY NAME', () => {
    const access = resolveContraindicationAccess({
      role: 'receptionist',
      employeeId: OTHER,
      assignedTherapistIds: [THERAPIST],
    })
    expect(access.flags.permitted).toBe(true)
    expect(access.note).toMatchObject({
      permitted: false,
      refusal: 'note_not_permitted_for_role',
    })
  })

  it('the therapist assigned to the appointment reads both', () => {
    const access = resolveContraindicationAccess({
      role: 'therapist',
      employeeId: THERAPIST,
      assignedTherapistIds: [THERAPIST],
    })
    expect(access.flags.permitted).toBe(true)
    expect(access.note.permitted).toBe(true)
  })

  it('an unassigned therapist is refused BOTH, and the refusal names the assignment', () => {
    const access = resolveContraindicationAccess({
      role: 'therapist',
      employeeId: OTHER,
      assignedTherapistIds: [THERAPIST],
    })
    expect(access.flags).toMatchObject({ permitted: false, refusal: 'therapist_not_assigned' })
    expect(access.note).toMatchObject({ permitted: false, refusal: 'therapist_not_assigned' })
  })

  it('refuses a role that holds neither permission', () => {
    const access = resolveContraindicationAccess({
      role: 'marketer',
      employeeId: OTHER,
      assignedTherapistIds: [OTHER],
    })
    expect(access.flags).toMatchObject({
      permitted: false,
      refusal: 'flags_not_permitted_for_role',
    })
  })

  it('answers every role, and the assignment scope binds the therapist alone', () => {
    // An enumeration rather than four cases, so a ninth role added to the matrix is decided here rather
    // than silently outside the four the acceptance names.
    const flagRoles: Role[] = []
    for (const role of ROLES) {
      const withAssignment = resolveContraindicationAccess({
        role,
        employeeId: THERAPIST,
        assignedTherapistIds: [THERAPIST],
      })
      const without = resolveContraindicationAccess({
        role,
        employeeId: THERAPIST,
        assignedTherapistIds: [],
      })
      if (withAssignment.flags.permitted) flagRoles.push(role)
      // Only the therapist's answer moves with the assignment. A receptionist's justification is the
      // booking they are taking, and a walk-in has no appointment to be assigned to.
      expect(without.flags.permitted, `${role} changed its flags answer with the assignment`).toBe(
        role === 'therapist' ? false : withAssignment.flags.permitted,
      )
    }
    expect(flagRoles.sort()).toEqual(['manager', 'owner', 'receptionist', 'therapist'])
  })
})

describe('acceptance — the sessionless ceiling can only NARROW', () => {
  const THERAPIST = 'e1111111-1111-7111-8111-111111111111'
  const ceilingFor = (assignedTherapistIds: readonly string[]) =>
    resolveContraindicationAccess({
      role: CONTRAINDICATION_SESSIONLESS_CEILING_ROLE,
      employeeId: THERAPIST,
      assignedTherapistIds,
    })

  it('refuses the note for every claimed role, including one that holds it', () => {
    // The escalation `?role=` would otherwise be: an assigned therapist holds `clinical_note:read`, so
    // without the ceiling a query string would unlock the detail behind a marker on an unauthenticated page.
    for (const role of ROLES) {
      const narrowed = narrowContraindicationAccess(
        resolveContraindicationAccess({
          role,
          employeeId: THERAPIST,
          assignedTherapistIds: [THERAPIST],
        }),
        ceilingFor([THERAPIST]),
      )
      expect(narrowed.note.permitted, `?role=${role} unlocked the note`).toBe(false)
    }
    // The control: the ceiling role itself may see the flags, or the page would serve nobody.
    expect(
      narrowContraindicationAccess(ceilingFor([THERAPIST]), ceilingFor([THERAPIST])).flags
        .permitted,
    ).toBe(true)
  })

  it('keeps a claimed role`s OWN refusal rather than replacing it with the ceiling`s', () => {
    // A refusal has to arrive with its own reason: "your job title does not cover this" and "you are not
    // assigned to this client" have different remedies, and a ceiling that flattened them to one would send
    // an unassigned therapist to ask for a permission they already hold.
    const unassigned = narrowContraindicationAccess(
      resolveContraindicationAccess({
        role: 'therapist',
        employeeId: 'e9999999-9999-7999-8999-999999999999',
        assignedTherapistIds: [THERAPIST],
      }),
      ceilingFor([THERAPIST]),
    )
    expect(unassigned.flags).toMatchObject({
      permitted: false,
      refusal: 'therapist_not_assigned',
    })
    const marketer = narrowContraindicationAccess(
      resolveContraindicationAccess({
        role: 'marketer',
        employeeId: THERAPIST,
        assignedTherapistIds: [THERAPIST],
      }),
      ceilingFor([THERAPIST]),
    )
    expect(marketer.flags).toMatchObject({
      permitted: false,
      refusal: 'flags_not_permitted_for_role',
    })
  })
})

// ------------------------------------------------------------------------------------------------
// The copy, and the Y1-licence decision it encodes
// ------------------------------------------------------------------------------------------------

describe('acceptance — every flag label is permitted under the profile in force (Y1-licence)', () => {
  it('produces no finding for any label or action line', () => {
    expect(lintContraindicationCopy(SEEDED_POLICY)).toEqual([])
  })

  it('refuses the manifest own practitioner wording, which is why the key is requires_consultation', () => {
    // THE CONTROL, and the reason the test above is not decoration. `Y1-licence` is open, so the narrower
    // reading applies: `practitioner` is a provider title and is not in the profile's permitted list, so
    // the wording the manifest proposed for the eighth key is refused — by the same lint, over the same
    // policy that passes every label this build ships.
    const refused = lintPublicDisplayName('Practitioner review required', SEEDED_POLICY)
    expect(refused.map((f) => f.rule)).toContain('unpermitted_staff_title')
    expect(refused.some((f) => f.term === 'practitioner')).toBe(true)
    // And the label actually shipped for that key passes, so the difference is the word and not the lint.
    expect(
      lintPublicDisplayName(
        CONTRAINDICATION_FLAG_LABELS[CONTRAINDICATION_ESCALATION_FLAG],
        SEEDED_POLICY,
      ),
    ).toEqual([])
  })

  it('names every key of the closed set, in both maps', () => {
    for (const key of CONTRAINDICATION_FLAG_KEYS) {
      expect(CONTRAINDICATION_FLAG_LABELS[key]?.length ?? 0).toBeGreaterThan(0)
      expect(CONTRAINDICATION_FLAG_ACTIONS[key]?.length ?? 0).toBeGreaterThan(0)
    }
    expect(Object.keys(CONTRAINDICATION_FLAG_LABELS).sort()).toEqual(
      [...CONTRAINDICATION_FLAG_KEYS].sort(),
    )
  })
})

// ------------------------------------------------------------------------------------------------
// The egress guard
// ------------------------------------------------------------------------------------------------

describe('acceptance — every FlagKey is rejected by the egress allowlist', () => {
  it('matches every key of the closed set against a clinical field marker', () => {
    for (const key of CONTRAINDICATION_FLAG_KEYS) {
      expect(
        CLINICAL_FIELD_MARKERS.some((marker) => key.includes(marker)),
        `${key} is not caught by any clinical field marker, so a response body naming it passes the sweep`,
      ).toBe(true)
    }
  })

  it('does not match an ordinary booking field, which is what keeps the guard usable', () => {
    // The control. A marker list that matched everything would pass the loop above and would be switched
    // off the first time it refused a treatment name.
    for (const innocuous of ['bookingReference', 'tradingDate', 'serviceName', 'durationMinutes']) {
      expect(
        CLINICAL_FIELD_MARKERS.some((marker) => innocuous.toLowerCase().includes(marker)),
        `${innocuous} is caught by a clinical marker`,
      ).toBe(false)
    }
  })
})
