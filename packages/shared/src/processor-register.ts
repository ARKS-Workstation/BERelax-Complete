/**
 * The processor register: every external service that touches personal data, what it touches it for,
 * and on what basis it may be outside the UAE.
 *
 * docs/04 §8 asks for this, and it asks for it in a particular way: *"This register drives the privacy
 * policy and the deletion logic — it is a working artefact, not a formality."* The sentence is the
 * specification. A register that nothing reads and nothing compares to the services actually wired up
 * is a document that is right on the day it is written and quietly wrong a week later, when somebody
 * adds a provider key and nothing fails.
 *
 * So two things read it and one thing checks it:
 *
 *   - `packages/core/src/privacy/processor-policy.ts` GENERATES the privacy policy's processor section
 *     from these rows. There is no second list of processors in prose anywhere, which is what stops the
 *     policy and the register disagreeing about who has the data.
 *   - `scripts/check-processor-register.mjs` holds the register against `packages/config/src/env.ts` in
 *     both directions: a provider key in the config schema with no row here fails, and a row naming a
 *     config key the schema does not declare fails too. The known-bad fixtures are gate block 177.
 *
 * ## Why this is in `packages/shared` when the manifest says `packages/db`
 *
 * `crawlers.ts`'s reason and `alerts/registry.ts`'s: `packages/db` may reach `shared` and must never
 * import `core` (ADR 0001), and the policy generator is in `core`. Data that both sides derive from has
 * no business on the wrong side of that boundary — put here, `db` re-exports it from the path the
 * manifest names and `core` reads it directly, and there is exactly one statement of it.
 *
 * ## Nothing here is invented, and two fields say so out loud
 *
 * A processor's NAME is a fact about this build: every name below is a vendor this repository already
 * names in code — `message.vendor` has a CHECK listing two of them, `env.ts` declares the switches, and
 * the media adapter names the bucket provider. What is NOT on file is a signed contract, a data
 * processing agreement, a sub-processor list or a transfer mechanism anybody has executed. So
 * `transferBasis` is a declared ENUM including `not_yet_established`, and `agreementOnFile` is a boolean
 * that is `false` everywhere, because this build has never seen one. A register claiming a basis that
 * nobody has signed is the plausible-looking TRN of brief rule 15, applied to a legal instrument.
 */

/**
 * What a processor may do with personal data, as a closed set.
 *
 * The categories a data subject's question actually falls into — "who has my phone number and why" —
 * rather than a free-text purpose per row, because a purpose written per row is a purpose written
 * differently per row and a register nobody can aggregate.
 */
export const PROCESSOR_PURPOSES = [
  'transactional_messaging',
  'marketing_messaging',
  'payment_processing',
  'reputation_and_search',
  'file_storage',
  'error_monitoring',
  'accounting_export',
  'language_generation',
] as const
export type ProcessorPurpose = (typeof PROCESSOR_PURPOSES)[number]

/**
 * The classes of personal data, matching the vocabulary the erasure engine classifies columns by.
 *
 * Deliberately the same words as `rights-policy.ts`'s data classes rather than a second taxonomy: the
 * register says which classes leave the building, the erasure engine says what happens to each class
 * when somebody asks to be forgotten, and the two have to be about the same thing or the policy's
 * answer to "who has my clinical notes" is unrelated to what an erasure does about it.
 */
export const PROCESSOR_DATA_CLASSES = [
  'contact',
  'identity',
  'booking',
  'financial',
  'clinical',
  'marketing',
  'technical',
] as const
export type ProcessorDataClass = (typeof PROCESSOR_DATA_CLASSES)[number]

/**
 * On what basis personal data may sit outside the UAE.
 *
 * `not_yet_established` is a value and not an absence, which is the whole point. docs/04 marks the PDPL
 * `[UNVERIFIED]` and `Y1-entity` has not said which regime applies, so no transfer mechanism has been
 * chosen for any processor here. A NULL would read as "nobody filled this in"; this reads as "this is
 * unresolved", it is the same answer for every row, and `Y5-residency` is where it is recorded.
 *
 * The other three are the shapes a resolution could take. They exist so that answering the open question
 * is choosing a value rather than designing a column.
 */
export const TRANSFER_BASES = [
  'not_yet_established',
  'processed_in_uae',
  'adequacy_or_equivalent_regime',
  'contractual_safeguards',
] as const
export type TransferBasis = (typeof TRANSFER_BASES)[number]

export interface Processor {
  /** Stable handle, named in the policy's anchors and in refusals. */
  readonly id: string
  /**
   * The vendor, as this repository already names it elsewhere. Never a legal entity name, a registered
   * address or a contact: none of those is on file, and a plausible one reads as configured.
   */
  readonly vendor: string
  /**
   * The `env.ts` key that switches this processor on, or `null` for one that has no switch.
   *
   * Checked against the config schema in both directions. `null` is for a processor reached through a
   * key that is not a mode switch — a DSN, a bucket — and those name their key in `configKeys` instead.
   */
  readonly providerKey: string | null
  /** Every `env.ts` key this processor is configured by. At least one, and all are checked to exist. */
  readonly configKeys: readonly string[]
  readonly purpose: ProcessorPurpose
  /** The classes of personal data this processor can see. At least one. */
  readonly dataClasses: readonly ProcessorDataClass[]
  readonly transferBasis: TransferBasis
  /**
   * How long the processor holds the data, as the build knows it.
   *
   * A sentence and not a number of days, because for every one of these the honest answer is about the
   * provider's own policy, which this build has not been shown. What the sentence must say is which of
   * the two it is: a period this build CONTROLS (it deletes, or it never sends) or a period the
   * PROVIDER controls (and then that it is unverified).
   */
  readonly retention: string
  /** Whether a data processing agreement is on file. `false` everywhere: none has been seen. */
  readonly agreementOnFile: boolean
  /** Why this processor exists at all, in one sentence a reader could disagree with. */
  readonly why: string
}

/**
 * Where the unresolved parts are recorded. Two questions, because they are two conversations.
 *
 * `Y5-residency` is whether health data may leave the UAE at all, which decides the transfer basis for
 * the processors that could see clinical data — and therefore whether some of these rows may exist.
 * `Y1-processor-agreements` is the narrower and more immediate one: no data processing agreement has
 * been signed with any of them.
 */
export const PROCESSOR_RESIDENCY_OPEN_QUESTION_ID = 'Y5-residency'
export const PROCESSOR_AGREEMENT_OPEN_QUESTION_ID = 'Y1-processor-agreements'

/**
 * The register.
 *
 * One row per external service the config schema can switch on, and nothing speculative: a processor
 * this build cannot reach is a row in a document rather than a working artefact, which is exactly what
 * docs/04 §8 says this must not be.
 *
 * `clinical` appears in NO row's `dataClasses`, and that is the single most important fact in this file.
 * Health data never enters marketing tooling or analytics (docs/04 §8) and the egress guard enforces it;
 * what the register adds is that no processor here is declared able to see it either, so the policy
 * generated from these rows says so rather than being silent about it.
 */
export const PROCESSOR_REGISTER: readonly Processor[] = [
  {
    id: 'sms',
    vendor: 'SMSala',
    providerKey: 'SMS_PROVIDER',
    configKeys: ['SMS_PROVIDER', 'OUTBOUND_ALLOWLIST'],
    purpose: 'transactional_messaging',
    // The recipient's number and what the message says, which for a booking confirmation names a
    // treatment. `booking` and not `clinical`: a service name is catalogue data, and 0004's regulatory
    // profile already refuses a clinical CLAIM on one.
    dataClasses: ['contact', 'booking'],
    transferBasis: 'not_yet_established',
    retention:
      'Controlled by the provider and NOT on file. This build keeps the message and its delivery ' +
      'receipt itself (migration 0035), so what the provider holds beyond delivery is unverified.',
    agreementOnFile: false,
    why:
      'The only channel that reaches a client who gave a number and no email, and the one a booking ' +
      'confirmation goes out on.',
  },
  {
    id: 'email',
    vendor: 'Resend',
    providerKey: 'EMAIL_PROVIDER',
    configKeys: ['EMAIL_PROVIDER', 'OUTBOUND_ALLOWLIST'],
    purpose: 'transactional_messaging',
    dataClasses: ['contact', 'booking'],
    transferBasis: 'not_yet_established',
    retention:
      'Controlled by the provider and NOT on file. The rendered HTML part is stored here for the ' +
      'inbox preview; what the provider retains is unverified.',
    agreementOnFile: false,
    why: 'Statements, receipts and anything with a document attached, which SMS cannot carry.',
  },
  {
    id: 'payment-gateway',
    vendor: 'the payment gateway, which has not been chosen',
    providerKey: 'PAYMENT_PROVIDER',
    configKeys: [
      'PAYMENT_PROVIDER',
      'PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN',
      'PAYMENT_HOSTED_FIELDS_SCRIPT_ORIGIN',
    ],
    purpose: 'payment_processing',
    // NOT `financial` in the card sense: the SAQ-A design means no card number ever reaches this
    // system, so what the gateway sees from here is who is paying and for what.
    dataClasses: ['contact', 'financial'],
    transferBasis: 'not_yet_established',
    retention:
      'Controlled by the provider. This build stores no card data at all (the SAQ-A design and its ' +
      'gate), so the gateway holds the instrument and this system holds only its own references.',
    agreementOnFile: false,
    why:
      'Card payment, through hosted fields so the card number never touches this system. The vendor ' +
      'is deliberately unnamed: Y7-gateway is open, and naming a plausible one would read as chosen.',
  },
  {
    id: 'google',
    vendor: 'Google',
    providerKey: 'GOOGLE_PROVIDER',
    configKeys: ['GOOGLE_PROVIDER', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
    purpose: 'reputation_and_search',
    // The reviewer's display name and the words of their review arrive FROM Google; what goes to it is
    // a reply and a search-console query. No client record is sent.
    dataClasses: ['contact', 'technical'],
    transferBasis: 'not_yet_established',
    retention:
      'Google holds the listing and the reviews; this build holds a copy of the reviews it has read ' +
      'and the replies it has approved. Nothing about a client is sent to Google by this system.',
    agreementOnFile: false,
    why:
      'The Business Profile is where this business is found and reviewed, and Search Console is the ' +
      'only measurement of that which does not require a tracker.',
  },
  {
    id: 'object-storage',
    vendor: 'DigitalOcean Spaces',
    providerKey: 'MEDIA_STORAGE',
    configKeys: ['MEDIA_STORAGE'],
    purpose: 'file_storage',
    // Staff portraits are identity data about nineteen people whose photography consent is not on
    // record (Y12-consent-photo), which is why the private bucket exists at all.
    dataClasses: ['identity', 'financial'],
    transferBasis: 'not_yet_established',
    retention:
      'Held until this build deletes the object. A period this system CONTROLS: the private-document ' +
      'register (migration 0101) knows every object it wrote and the retention purge removes them.',
    agreementOnFile: false,
    why:
      'Media derivatives and every private document — a filed tax invoice, a payslip, a staff ' +
      'portrait at full resolution — none of which may sit on a public path.',
  },
  {
    id: 'error-monitoring',
    vendor: 'Sentry',
    providerKey: null,
    configKeys: ['SENTRY_DSN'],
    purpose: 'error_monitoring',
    // `technical` only, and that is a claim the egress guard is what keeps true: an exception payload
    // is where personal data leaks by accident, in a URL, a query parameter or a serialised row.
    dataClasses: ['technical'],
    transferBasis: 'not_yet_established',
    retention:
      'Controlled by the provider and NOT on file. The exposure is bounded by what is SENT rather ' +
      'than by what is kept, which is the egress guard’s subject.',
    agreementOnFile: false,
    why:
      'An unhandled exception that nobody sees is the failure the alert registry exists to remove, one ' +
      'floor down. Declared here because an error report is the likeliest accidental egress there is.',
  },
  {
    id: 'accounting-export',
    vendor: 'Zoho Books',
    providerKey: null,
    configKeys: [],
    purpose: 'accounting_export',
    dataClasses: ['contact', 'financial'],
    // The one row with a basis, and it is the strongest one available: nothing is transmitted. The
    // export is a FILE this build writes and a person carries.
    transferBasis: 'processed_in_uae',
    retention:
      'Nothing is transmitted by this system: the export is a file written locally and handed over by ' +
      'a person, so what happens to it afterwards is outside this build and is recorded as such.',
    agreementOnFile: false,
    why:
      'The VAT return and the books are kept in accounting software, and there is no API integration ' +
      '(M-VAT-09 proved the absence of a filing capability). It is in the register because the FILE ' +
      'contains customer names and amounts, and a register that only listed network calls would miss ' +
      'the most direct disclosure this build makes.',
  },
  {
    id: 'language-generation',
    vendor: 'the LLM provider, which has not been chosen',
    providerKey: 'LLM_PROVIDER',
    configKeys: ['LLM_PROVIDER'],
    purpose: 'language_generation',
    // `technical` only, deliberately. Nothing in this build sends a client record to a model, and the
    // row exists to say that rather than to leave the question open.
    dataClasses: ['technical'],
    transferBasis: 'not_yet_established',
    retention:
      'No personal data is sent, so there is nothing for the provider to retain. If that changes, this ' +
      'row changes with it and the privacy policy generated from it changes in the same commit.',
    agreementOnFile: false,
    why:
      'Draft copy and reply suggestions. The vendor is unnamed because none is configured, and a ' +
      'register naming one would be claiming a processing relationship that does not exist.',
  },
]

/** The ids, for an anchor or a lookup. */
export const PROCESSOR_IDS: readonly string[] = PROCESSOR_REGISTER.map((p) => p.id)

export function processorById(id: string): Processor {
  const found = PROCESSOR_REGISTER.find((p) => p.id === id)
  if (found === undefined) {
    throw new Error(
      `No processor is registered as "${id}". Every external service that touches personal data is a ` +
        'row in PROCESSOR_REGISTER; one named from a string is one the privacy policy cannot describe.',
    )
  }
  return found
}

/** Every `env.ts` key the register depends on, so the gate can hold the two sets equal. */
export const PROCESSOR_CONFIG_KEYS: readonly string[] = [
  ...new Set(
    PROCESSOR_REGISTER.flatMap((p): readonly string[] => [
      ...(p.providerKey === null ? [] : [p.providerKey]),
      ...p.configKeys,
    ]),
  ),
]

/**
 * The register's own invariants, at module load.
 *
 * Here as well as in the gate because a module that loads with a processor declaring no data class has
 * already shipped a row the privacy policy will render as a service that touches nothing. The gate
 * proves the claims that reach outside this file; these are the ones that do not.
 */
function assertRegister(): void {
  const ids = PROCESSOR_REGISTER.map((p) => p.id)
  const duplicate = ids.find((id, at) => ids.indexOf(id) !== at)
  if (duplicate !== undefined) {
    throw new Error(`Processor "${duplicate}" is registered twice. One service, one row.`)
  }
  for (const processor of PROCESSOR_REGISTER) {
    if (processor.dataClasses.length === 0) {
      throw new Error(
        `Processor "${processor.id}" declares no data class. A processor that touches no personal ` +
          'data does not belong in a processor register, and one that does must say which.',
      )
    }
    if (processor.providerKey === null && processor.configKeys.length === 0) {
      // Zoho is the only legitimate case and it carries `processed_in_uae` for the reason its row
      // gives: nothing is transmitted. Anything else with no key at all is a processor this build
      // cannot reach, which is the document-rather-than-artefact failure docs/04 §8 names.
      if (processor.transferBasis !== 'processed_in_uae') {
        throw new Error(
          `Processor "${processor.id}" has no provider key and no config key, so nothing in this ` +
            'build can reach it — and it does not claim to be processed in the UAE either. A row for ' +
            'a service that cannot be reached is a formality, which is what docs/04 §8 says this ' +
            'register must not be.',
        )
      }
    }
    if (processor.agreementOnFile) {
      throw new Error(
        `Processor "${processor.id}" claims a data processing agreement is on file. None has been ` +
          'seen by this build, and a claimed legal instrument is worse than a blank one (brief rule ' +
          `15). ${PROCESSOR_AGREEMENT_OPEN_QUESTION_ID} is where this is recorded.`,
      )
    }
  }
}

assertRegister()
