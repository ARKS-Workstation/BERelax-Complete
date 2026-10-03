import {
  PROCESSOR_AGREEMENT_OPEN_QUESTION_ID,
  PROCESSOR_REGISTER,
  PROCESSOR_RESIDENCY_OPEN_QUESTION_ID,
  type Processor,
  type ProcessorDataClass,
  type TransferBasis,
} from '@berelax/shared'

/**
 * The privacy policy's processor section, GENERATED from the register.
 *
 * docs/04 §8: *"This register drives the privacy policy and the deletion logic — it is a working
 * artefact, not a formality."* This is the first half of that sentence, and the shape is what makes it
 * true rather than aspirational: there is no list of processors in prose anywhere in this repository.
 * Add a row and the policy grows a paragraph; remove one and the paragraph goes; change a data class and
 * the sentence changes. A hand-written policy beside a register is two statements of who has the data,
 * and the one that drifts is the one a data subject reads.
 *
 * ## Why this returns a structure and not HTML
 *
 * `packages/core` is pure and renders nothing — and more usefully, a structure is what lets the same
 * generated content be asserted by a test, rendered into a page, and exported as text for a printed
 * notice without three copies of the wording. The caller renders.
 *
 * ## What the generated policy says that a hand-written one would not
 *
 * **That nothing is settled.** Every row's transfer basis is `not_yet_established`, so the section opens
 * by saying so and names the open question, rather than listing eight services under a heading that
 * implies a mechanism exists. A policy that implied a transfer mechanism nobody has executed would be
 * the plausible-looking legal instrument of brief rule 15.
 *
 * **What no processor can see.** The sentence about clinical data is derived — it is emitted only when
 * no row declares the `clinical` class — so it cannot become false while still being printed. A
 * hand-written "we never share your health information" survives the commit that makes it untrue.
 */

/** One paragraph about one processor, in the words the register holds. */
export interface ProcessorParagraph {
  readonly id: string
  readonly heading: string
  /** Sentences, in reading order. Rendered as separate paragraphs or joined; the caller decides. */
  readonly sentences: readonly string[]
}

export interface ProcessorPolicySection {
  readonly heading: string
  /** The sentences before the per-processor paragraphs, including every caveat that applies to all. */
  readonly preamble: readonly string[]
  readonly processors: readonly ProcessorParagraph[]
  /**
   * The claims the register's SHAPE supports, each emitted only while it is true.
   *
   * Derived rather than written, which is the point: a claim about what is never shared is exactly the
   * sentence that survives the commit making it false.
   */
  readonly derivedAssurances: readonly string[]
  /** The open questions this section is provisional against, so a reader can see what is unsettled. */
  readonly openQuestionIds: readonly string[]
}

const PURPOSE_WORDS: Readonly<Record<string, string>> = {
  transactional_messaging: 'to send you booking confirmations, reminders and receipts',
  marketing_messaging: 'to send you marketing messages, if you have agreed to them',
  payment_processing: 'to take a card payment',
  reputation_and_search: 'to manage this business’s public listing and the reviews on it',
  file_storage: 'to store files, including documents that are kept privately',
  error_monitoring: 'to record software errors so they can be fixed',
  accounting_export: 'to keep the business’s books and file its tax returns',
  language_generation: 'to draft wording that a person then reviews',
}

const DATA_CLASS_WORDS: Readonly<Record<ProcessorDataClass, string>> = {
  contact: 'your name and how to reach you',
  identity: 'identity details, including a photograph where one has been taken',
  booking: 'your appointments and the treatments on them',
  financial: 'amounts, invoices and payment references',
  clinical: 'health information you have given us',
  marketing: 'what you have agreed to be contacted about',
  technical: 'technical information about a request, such as a page address or an error',
}

const TRANSFER_WORDS: Readonly<Record<TransferBasis, string>> = {
  not_yet_established:
    'Where this service holds data outside the United Arab Emirates, the basis on which it may do so ' +
    'has not yet been established',
  processed_in_uae: 'Nothing is sent to this service by our systems',
  adequacy_or_equivalent_regime:
    'This service operates under a regime assessed as offering equivalent protection',
  contractual_safeguards: 'This service is covered by contractual safeguards',
}

/** The sentences for one processor, each derived from a field rather than written per row. */
function paragraphFor(processor: Processor): ProcessorParagraph {
  const purpose = PURPOSE_WORDS[processor.purpose] ?? processor.purpose
  const classes = processor.dataClasses.map((c) => DATA_CLASS_WORDS[c])
  const list =
    classes.length === 1
      ? (classes[0] ?? '')
      : `${classes.slice(0, -1).join(', ')} and ${classes[classes.length - 1] ?? ''}`
  const sentences = [
    `We use ${processor.vendor} ${purpose}.`,
    `It can see ${list}.`,
    `${TRANSFER_WORDS[processor.transferBasis]}.`,
    `How long it keeps the data: ${processor.retention}`,
  ]
  if (!processor.agreementOnFile) {
    // Said per processor and not once at the top, because it is a fact about each relationship and a
    // reader deciding whether to give us their number is entitled to it next to the service's name.
    sentences.push(
      'We do not yet have a written data processing agreement with this service, and we say so rather ' +
        'than implying one exists.',
    )
  }
  return { id: processor.id, heading: processor.vendor, sentences }
}

/**
 * The section, generated.
 *
 * `register` is an argument with the real one as its default, so a test can generate the section from a
 * fixture set and assert that the OUTPUT follows the INPUT — which is the only way to prove the policy
 * is derived rather than coincidentally agreeing with the register today.
 */
export function processorPolicySection(
  register: readonly Processor[] = PROCESSOR_REGISTER,
): ProcessorPolicySection {
  const declaresClinical = register.some((p) => p.dataClasses.includes('clinical'))
  const anyUnestablished = register.some((p) => p.transferBasis === 'not_yet_established')
  const anyWithoutAgreement = register.some((p) => !p.agreementOnFile)

  const preamble: string[] = [
    'We use the services below to run this business. Each one is listed with what it is for, what it ' +
      'can see, and how long it keeps it.',
  ]
  if (anyUnestablished) {
    preamble.push(
      'Some of these services may hold data outside the United Arab Emirates. We have not yet ' +
        'established the basis on which they may do so, and we would rather tell you that than name a ' +
        'legal mechanism we have not put in place.',
    )
  }

  const derivedAssurances: string[] = []
  if (!declaresClinical) {
    derivedAssurances.push(
      'None of these services receives health information you have given us. That is enforced in our ' +
        'software and not only promised here.',
    )
  }
  if (anyWithoutAgreement) {
    derivedAssurances.push(
      'Where we have no written agreement with a service, the entry above says so. We do not list one ' +
        'we have not signed.',
    )
  }

  const openQuestionIds = [
    ...(anyUnestablished ? [PROCESSOR_RESIDENCY_OPEN_QUESTION_ID] : []),
    ...(anyWithoutAgreement ? [PROCESSOR_AGREEMENT_OPEN_QUESTION_ID] : []),
  ]

  return {
    heading: 'Who else can see your information',
    preamble,
    // Register order, which is reading order: the services a client actually meets first.
    processors: register.map(paragraphFor),
    derivedAssurances,
    openQuestionIds,
  }
}

/** The whole section as plain text, for a test, a printed notice or a diff. */
export function processorPolicyText(register?: readonly Processor[]): string {
  const section = processorPolicySection(register)
  const lines = [section.heading, '', ...section.preamble, '']
  for (const processor of section.processors) {
    lines.push(processor.heading, ...processor.sentences, '')
  }
  lines.push(...section.derivedAssurances)
  return lines.join('\n')
}
