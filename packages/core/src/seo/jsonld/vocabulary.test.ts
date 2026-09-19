import { describe, expect, it } from 'vitest'
import {
  assertVocabularyPermitted,
  businessTypesFor,
  LICENCE_CLASSES,
  MEDICAL_VOCABULARY,
  medicalTermsIn,
  medicalVocabularyPermitted,
  PRIMARY_BUSINESS_TYPE,
  personTypesFor,
  serviceTypesFor,
} from './vocabulary.ts'

/**
 * The licence-class gate, which is the compliance half of this unit.
 *
 * docs/09 §"Schema types": *"Do not claim `MedicalBusiness` or `MedicalClinic` unless the licence
 * classification supports it. Claiming a medical type the licence does not permit is a compliance problem,
 * not an SEO tactic."* `regulatory_profile.licence_class` is `unconfirmed` (Y1-licence), so the claim under
 * test is that the four medical terms are **unreachable** — and the only way to assert unreachability rather
 * than absence is to exhaust the enum, which is what these tests do.
 */
describe('the licence class decides the vocabulary, and nothing else does', () => {
  it('is DaySpa first under every licence class, including the one nobody has confirmed', () => {
    for (const licence of LICENCE_CLASSES) {
      expect(businessTypesFor(licence)[0], licence).toBe(PRIMARY_BUSINESS_TYPE)
    }
    // The business is still a day spa on the day the licence is confirmed. Dropping the type would throw
    // away the one that carries the treatment menu.
    expect([...businessTypesFor('healthcare')]).toContain('DaySpa')
  })

  it('emits no medical term under any class but healthcare — exhausting the enum, not sampling it', () => {
    for (const licence of LICENCE_CLASSES) {
      const emitted = [
        ...businessTypesFor(licence),
        ...serviceTypesFor(licence),
        ...personTypesFor(licence),
      ]
      const medical = emitted.filter((type) => MEDICAL_VOCABULARY.includes(type as never))
      if (licence === 'healthcare') {
        // The control. If the healthcare branch emitted nothing either, the assertion below would be
        // satisfied by a mapping that had stopped producing types at all.
        expect(medical.length, licence).toBeGreaterThan(0)
      } else {
        expect(medical, licence).toEqual([])
      }
    }
  })

  it('names the seeded class explicitly rather than folding it into a default', () => {
    // `unconfirmed` is the seeded value (0004) and it resolves to the wellness vocabulary. Spelled as its
    // own case so a fourth licence class is a compile error rather than a silent reuse of this answer.
    expect([...businessTypesFor('unconfirmed')]).toEqual([...businessTypesFor('wellness')])
    expect(medicalVocabularyPermitted('unconfirmed')).toBe(false)
    expect(medicalVocabularyPermitted('wellness')).toBe(false)
    expect(medicalVocabularyPermitted('healthcare')).toBe(true)
  })

  it('puts Physician behind the licence and not behind a job title', () => {
    expect([...personTypesFor('unconfirmed')]).toEqual(['Person'])
    expect([...personTypesFor('healthcare')]).toContain('Physician')
    expect([...serviceTypesFor('healthcare')]).toContain('MedicalTherapy')
  })

  it('mirrors the licence_class enum exactly, in the order the type declares', () => {
    // The union in this module stands in for a PostgreSQL enum, because packages/core may not import
    // packages/db. `packages/fixtures/src/jsonld-graph.itest.ts` asserts the pair against `pg_enum`; this
    // asserts the list has not been quietly reordered or extended here without a vocabulary decision.
    expect([...LICENCE_CLASSES]).toEqual(['unconfirmed', 'wellness', 'healthcare'])
  })
})

describe('medicalTermsIn finds the claim wherever it was written', () => {
  it('matches a @type, a hyphenated label and a sentence of prose alike', () => {
    expect([...medicalTermsIn({ '@type': 'MedicalClinic' })]).toEqual(['MedicalClinic'])
    expect([...medicalTermsIn('Medical-Clinic')]).toEqual(['MedicalClinic'])
    expect([...medicalTermsIn('delivered in our medical clinic')]).toEqual(['MedicalClinic'])
    expect([...medicalTermsIn({ jobTitle: 'PHYSICIAN' })]).toEqual(['Physician'])
  })

  it('walks nested objects and arrays, because that is where a graph hides one', () => {
    const graph = {
      '@graph': [
        { '@type': ['DaySpa'], name: 'fine' },
        { '@type': 'Service', serviceType: 'Medical therapy', offers: [{ name: 'fine' }] },
      ],
    }
    expect([...medicalTermsIn(graph)]).toEqual(['MedicalTherapy'])
  })

  it('does not fire on a word that merely contains one, which is what keeps the rule usable', () => {
    // A rule that refused "biomedical" or "physicians of Abu Dhabi" as a place name would be a rule
    // somebody switched off. Whole consecutive words only.
    for (const innocent of [
      'biomedical waste is handled off site',
      'a therapy room',
      'medical',
      'clinic',
      'our therapists',
    ]) {
      expect([...medicalTermsIn(innocent)], innocent).toEqual([])
    }
  })

  it('reports every term it found, sorted, so a message names all the edits', () => {
    const found = medicalTermsIn({
      a: 'MedicalBusiness',
      b: ['MedicalClinic', { c: 'Physician' }],
      d: 'MedicalTherapy',
    })
    expect([...found]).toEqual(['MedicalBusiness', 'MedicalClinic', 'MedicalTherapy', 'Physician'])
  })

  it('finds nothing in a value that carries no strings', () => {
    expect([...medicalTermsIn(42)]).toEqual([])
    expect([...medicalTermsIn(null)]).toEqual([])
    expect([...medicalTermsIn(undefined)]).toEqual([])
    expect([...medicalTermsIn(true)]).toEqual([])
  })
})

describe('assertVocabularyPermitted is the gate the builders cannot go round', () => {
  it('refuses a hard-coded medical type under the seeded licence class', () => {
    const graph = { '@context': 'https://schema.org', '@graph': [{ '@type': 'MedicalClinic' }] }
    expect(() => assertVocabularyPermitted(graph, 'unconfirmed')).toThrow(/MedicalClinic/)
    expect(() => assertVocabularyPermitted(graph, 'unconfirmed')).toThrow(/Y1-licence/)
  })

  it('refuses the same claim written as a value rather than as a type', () => {
    // The failure the type functions cannot see: a `serviceType` copied off a competitor's site is the same
    // claim to a regulator, and a type list is the only place anybody thinks to look.
    const graph = { '@graph': [{ '@type': 'Service', serviceType: 'medical therapy' }] }
    expect(() => assertVocabularyPermitted(graph, 'wellness')).toThrow(/MedicalTherapy/)
  })

  it('permits it once the profile says healthcare, which is the only path that does', () => {
    const graph = { '@graph': [{ '@type': ['DaySpa', 'MedicalClinic'] }] }
    expect(() => assertVocabularyPermitted(graph, 'healthcare')).not.toThrow()
  })

  it('passes a graph with no medical term at all, so the refusals above are about the term', () => {
    const graph = {
      '@context': 'https://schema.org',
      '@graph': [{ '@type': ['DaySpa'], name: 'a spa', serviceType: 'asian massage' }],
    }
    for (const licence of LICENCE_CLASSES) {
      expect(() => assertVocabularyPermitted(graph, licence), licence).not.toThrow()
    }
  })
})
