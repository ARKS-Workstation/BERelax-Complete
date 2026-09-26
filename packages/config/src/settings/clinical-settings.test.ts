import {
  CLINICAL_LINT_QUESTION_COPY_SETTING_KEY,
  CLINICAL_OPEN_QUESTIONS,
  CLINICAL_REAL_INTAKE_SETTING_KEY,
  CLINICAL_STEP_UP_WINDOW_CEILING_MINUTES,
  CLINICAL_STEP_UP_WINDOW_SETTING_KEY,
} from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { defaultsForSeeding, getDefinition, provisionalSettings } from './registry.ts'

/**
 * The three clinical-intake settings (C-CRM-08), and the two provisional readings they carry.
 *
 * Asserted here rather than only through the integration suite, because the integration suite reads the
 * `app_setting` ROW and a seeded row is whatever the last seed wrote. The DEFAULT — the value a fresh
 * database and an unseeded key both fall back to — is only visible in the registry, and it is the default
 * that decides what an uncorrected assumption does. A gate case that flipped
 * `PROVISIONAL_REAL_INTAKE_PERMITTED` to `true` therefore changed nothing any integration assertion could
 * see, which is how this file came to exist.
 *
 * docs/12 §2 is the specification: *"Provisional values are always the strictest safe option, never the
 * convenient one."* For these two the strict option is the demanding one — treat intake as health data,
 * assume the narrower vocabulary — because that is the reading where being wrong costs a configuration
 * change rather than a disclosure.
 */

describe('clinical.real_intake_permitted (Y5-residency)', () => {
  const def = getDefinition(CLINICAL_REAL_INTAKE_SETTING_KEY)

  it('defaults to FALSE, which is the strict reading of an unanswered residency question', () => {
    expect(def.defaultValue).toBe(false)
  })

  it('is provisional against Y5-residency, so it reaches the Unconfirmed Assumptions panel', () => {
    expect(def.provisional?.openQuestionId).toBe(CLINICAL_OPEN_QUESTIONS.residency)
    const listed = provisionalSettings().find((s) => s.key === CLINICAL_REAL_INTAKE_SETTING_KEY)
    expect(listed?.openQuestionId).toBe('Y5-residency')
    expect(listed?.defaultValue).toBe(false)
    expect(listed?.note.length ?? 0).toBeGreaterThan(80)
  })

  it('is compliance-locked and owner-only, because what it relaxes is a legal position', () => {
    expect(def.tier).toBe('compliance_locked')
    expect(def.editableBy).toEqual(['owner'])
    expect(def.audited).toBe(true)
  })

  it('refuses anything but a boolean', () => {
    expect(def.schema.safeParse(true).success).toBe(true)
    expect(def.schema.safeParse('yes').success).toBe(false)
    expect(def.schema.safeParse(1).success).toBe(false)
  })

  it('is seeded carrying its provisional marker and its question id', () => {
    // The seeder is what puts the marker in `app_setting`, and the panel reads the ROW rather than the
    // registry. A provisional value whose row is not marked is an assumption nobody is shown.
    const row = defaultsForSeeding().find((s) => s.key === CLINICAL_REAL_INTAKE_SETTING_KEY)
    expect(row?.isProvisional).toBe(true)
    expect(row?.openQuestionId).toBe('Y5-residency')
    expect(row?.value).toBe(false)
  })
})

describe('clinical.intake_copy_lints_questions (Y1-licence)', () => {
  const def = getDefinition(CLINICAL_LINT_QUESTION_COPY_SETTING_KEY)

  it('defaults to TRUE, which is the narrower vocabulary an unconfirmed licence resolves to', () => {
    expect(def.defaultValue).toBe(true)
  })

  it('is provisional against Y1-licence, so it reaches the Unconfirmed Assumptions panel', () => {
    expect(def.provisional?.openQuestionId).toBe(CLINICAL_OPEN_QUESTIONS.licence)
    const listed = provisionalSettings().find(
      (s) => s.key === CLINICAL_LINT_QUESTION_COPY_SETTING_KEY,
    )
    expect(listed?.openQuestionId).toBe('Y1-licence')
    expect(listed?.defaultValue).toBe(true)
    // The note has to say what answering it the other way buys, or the panel names an assumption without
    // naming the decision. docs/12 §2.
    expect(listed?.note).toContain('wellness')
    expect(listed?.note).toContain('healthcare')
  })

  it('is compliance-locked and owner-only', () => {
    expect(def.tier).toBe('compliance_locked')
    expect(def.editableBy).toEqual(['owner'])
  })
})

describe('clinical.step_up_window_minutes', () => {
  const def = getDefinition(CLINICAL_STEP_UP_WINDOW_SETTING_KEY)

  it('is five minutes', () => {
    expect(def.defaultValue).toBe(5)
  })

  it('is deliberately NOT provisional, and that is a claim rather than an omission', () => {
    // ADR 0031's last section is the argument: the panel is worth reading exactly to the extent that
    // everything on it needs an owner's answer, and this needs none — shorter is unambiguously stricter,
    // five minutes is already short, and nothing about the licence or the entity moves it. Asserted so
    // that adding a marker here is a deliberate edit rather than a copy-paste.
    expect(def.provisional).toBeUndefined()
    expect(provisionalSettings().map((s) => s.key)).not.toContain(
      CLINICAL_STEP_UP_WINDOW_SETTING_KEY,
    )
  })

  it('cannot be set above the ceiling migration 0082 enforces', () => {
    expect(def.schema.safeParse(CLINICAL_STEP_UP_WINDOW_CEILING_MINUTES).success).toBe(true)
    expect(def.schema.safeParse(CLINICAL_STEP_UP_WINDOW_CEILING_MINUTES + 1).success).toBe(false)
    // And not below one minute, which would be a window nothing can be read in.
    expect(def.schema.safeParse(0).success).toBe(false)
    expect(def.schema.safeParse(2.5).success).toBe(false)
  })

  it('is compliance-locked, because widening it is the change that matters', () => {
    expect(def.tier).toBe('compliance_locked')
    expect(def.editableBy).toEqual(['owner'])
  })
})

describe('the two clinical open questions', () => {
  it('are exactly the two ids this unit was blocked on', () => {
    // The control on the pairing: a setting carrying the wrong question id surfaces on the panel under a
    // heading the owner cannot answer, and nothing else in the system compares the two.
    expect(CLINICAL_OPEN_QUESTIONS).toEqual({ residency: 'Y5-residency', licence: 'Y1-licence' })
  })

  it('both appear on the panel, and no clinical setting carries a question id nothing declares', () => {
    const clinical = provisionalSettings().filter((s) => s.key.startsWith('clinical.'))
    expect(clinical.map((s) => s.key).sort()).toEqual([
      CLINICAL_LINT_QUESTION_COPY_SETTING_KEY,
      CLINICAL_REAL_INTAKE_SETTING_KEY,
    ])
    const declared = new Set(Object.values(CLINICAL_OPEN_QUESTIONS))
    for (const setting of clinical) expect(declared).toContain(setting.openQuestionId)
  })
})
