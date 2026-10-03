import { PROCESSOR_REGISTER, type Processor } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { processorPolicySection, processorPolicyText } from './processor-policy.ts'

/**
 * The privacy policy is GENERATED from the processor register, and every case here is about that word.
 *
 * "Generated" is not a claim a test can make by comparing the policy to the register as they both stand
 * today — that would pass equally well for a hand-written policy that happens to agree. It is a claim
 * about the FUNCTION: change the input and the output follows. So most of these cases build a fixture
 * register of their own and assert what the section says about it, which is the only shape that can tell
 * derivation from coincidence.
 */
const BASE: Processor = {
  id: 'fixture-service',
  vendor: 'Fixture Service',
  providerKey: null,
  configKeys: [],
  purpose: 'transactional_messaging',
  dataClasses: ['contact'],
  transferBasis: 'processed_in_uae',
  retention:
    'Nothing is sent to this fixture service, so there is nothing for it to keep and nothing to say ' +
    'about a period anybody controls.',
  agreementOnFile: false,
  why: 'A fixture, so that a case about derivation does not depend on which real services exist today.',
}

const withFields = (overrides: Partial<Processor>): Processor => ({ ...BASE, ...overrides })

describe('processorPolicySection follows the register', () => {
  it('names every processor in the register and nothing else', () => {
    const section = processorPolicySection()
    expect(section.processors.map((p) => p.id)).toEqual(PROCESSOR_REGISTER.map((p) => p.id))
    // In register order, which is reading order. Asserted because a set comparison would pass for a
    // policy that listed the payment gateway before the confirmation SMS a client actually meets first.
    expect(section.processors[0]?.heading).toBe(PROCESSOR_REGISTER[0]?.vendor)
  })

  it('grows a paragraph when a row is added and loses it when the row goes', () => {
    const one = processorPolicySection([BASE])
    expect(one.processors).toHaveLength(1)
    const two = processorPolicySection([
      BASE,
      withFields({ id: 'second', vendor: 'Second Service' }),
    ])
    expect(two.processors).toHaveLength(2)
    expect(
      processorPolicyText([BASE, withFields({ id: 'second', vendor: 'Second Service' })]),
    ).toContain('Second Service')
    // The control: the removed row's name is gone, not merely unmentioned in a heading somewhere.
    expect(processorPolicyText([BASE])).not.toContain('Second Service')
  })

  it('says what each processor can see, in the data classes the row declares', () => {
    const section = processorPolicySection([withFields({ dataClasses: ['contact', 'financial'] })])
    const paragraph = section.processors[0]?.sentences.join(' ') ?? ''
    expect(paragraph).toContain('your name and how to reach you')
    expect(paragraph).toContain('amounts, invoices and payment references')
    /*
      The negative is asserted on the PARAGRAPH and not on the whole text, and the distinction was found
      by writing it the wrong way round first: the whole text legitimately contains the words "health
      information", in the derived assurance that says none of these services receives any. A test
      asserting the phrase is absent from the document would therefore have been satisfied only by
      REMOVING that assurance — a passing test demanding the deletion of the sentence the register
      exists to earn.

      What is actually being claimed is narrower: a processor's own paragraph lists the classes its row
      declares and no others.
    */
    expect(paragraph).not.toContain('health information')
  })

  it('states the retention sentence the row holds rather than a period of its own', () => {
    const retention =
      'Held for exactly as long as this fixture says, which is a period THIS BUILD controls because it ' +
      'deletes the object itself.'
    expect(processorPolicyText([withFields({ retention })])).toContain(retention)
  })
})

describe('the policy cannot claim more than the register supports', () => {
  it('says the transfer basis is not established when any row says so, and not otherwise', () => {
    const unsettled = processorPolicySection([withFields({ transferBasis: 'not_yet_established' })])
    expect(unsettled.preamble.join(' ')).toContain('not yet established')
    expect(unsettled.openQuestionIds).toContain('Y5-residency')
    // The control. With every basis resolved the sentence must GO, because a policy that always says
    // "we have not established this" is a policy that says nothing about the day it is established.
    const settled = processorPolicySection([withFields({ transferBasis: 'processed_in_uae' })])
    expect(settled.preamble.join(' ')).not.toContain('not yet established')
    expect(settled.openQuestionIds).not.toContain('Y5-residency')
  })

  it('withdraws the clinical assurance the moment a row declares clinical data', () => {
    /*
      The most important case in this file. "None of these services receives health information" is
      exactly the sentence that survives the commit making it false — which is why it is DERIVED from
      the absence of the class rather than written in the policy's prose.
    */
    const clean = processorPolicySection([withFields({ dataClasses: ['contact'] })])
    expect(clean.derivedAssurances.join(' ')).toContain('receives health information')

    const leaking = processorPolicySection([withFields({ dataClasses: ['contact', 'clinical'] })])
    expect(leaking.derivedAssurances.join(' ')).not.toContain('receives health information')
    // And it says so positively instead, in the paragraph for that processor.
    expect(processorPolicyText([withFields({ dataClasses: ['clinical'] })])).toContain(
      'health information you have given us',
    )
  })

  it('holds the clinical assurance for the REAL register, which is the claim docs/04 §8 makes', () => {
    // Not a duplicate of the case above: that one proves the sentence is derived, this one proves the
    // committed register is in the state that earns it. Both are needed — a derived sentence about a
    // register nobody checked is a mechanism with no finding.
    expect(processorPolicySection().derivedAssurances.join(' ')).toContain(
      'receives health information',
    )
    for (const processor of PROCESSOR_REGISTER) {
      expect(processor.dataClasses, processor.id).not.toContain('clinical')
    }
  })

  it('says per processor that no agreement is on file, beside the service it is about', () => {
    const text = processorPolicyText([withFields({ agreementOnFile: false })])
    expect(text).toContain('do not yet have a written data processing agreement')
    // Said next to each service rather than once at the top, because it is a fact about each
    // relationship and a reader is entitled to it beside the name.
    const section = processorPolicySection([
      withFields({ agreementOnFile: false }),
      withFields({ id: 'second', vendor: 'Second Service', agreementOnFile: false }),
    ])
    for (const paragraph of section.processors) {
      expect(paragraph.sentences.join(' '), paragraph.id).toContain('data processing agreement')
    }
  })

  it('names no contact, no address and no legal entity anywhere in the generated text', () => {
    // Brief rule 15, as an assertion. A privacy policy is exactly the document somebody would expect to
    // carry a postal address and a data protection contact, and this build has neither on file — so the
    // generated text must not imply one. The route that eventually renders this is where a configured
    // value would be joined in, from `legal_entity`, and never from here.
    const text = processorPolicyText()
    for (const forbidden of ['@', 'P.O. Box', 'Dubai,', 'LLC', 'TRN', '+971']) {
      expect(text, `generated policy must not contain ${forbidden}`).not.toContain(forbidden)
    }
  })
})
