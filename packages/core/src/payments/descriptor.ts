/**
 * The statement descriptor: what a cardholder's bank statement says the money went to.
 *
 * Y-PAY-10. The unit's word is *discreet*, and that word is a privacy claim, so it needs stating
 * precisely before any of the rules below mean anything.
 *
 * ## What a discreet descriptor does and does not conceal
 *
 * It conceals **what was bought**. A descriptor reading the trading name and the city says that money
 * went to this business; it does not say that the money bought a massage, which treatment, how long it
 * lasted or who gave it. That is the whole of the protection, and it is worth having: a bank statement is
 * read by whoever shares the account, and a line naming a treatment is a disclosure the cardholder did
 * not choose to make.
 *
 * It conceals **nothing else**, and four of those are worth writing down because somebody will assume
 * otherwise:
 *
 *   1. **It does not conceal that a payment was made, or its amount.** The line, the date and the figure
 *      are on the statement whatever the descriptor says.
 *   2. **It does not conceal the business.** The descriptor's purpose is to be recognisable — an
 *      unrecognisable one produces a cardholder dispute, which is worse for everybody — so anybody who
 *      can search the name can find out what this business does.
 *   3. **It does not conceal anything from the acquirer, the issuer or the card schemes.** They hold the
 *      MCC, and the MCC is a category of business. The descriptor is a string on a statement, not a
 *      confidentiality boundary.
 *   4. **It does not conceal anything from anyone with access to the account's full transaction
 *      history**, which includes the cardholder's bank, and in a dispute the merchant.
 *
 * So the honest claim is narrow: *the statement line names the business and not the treatment*. This
 * module enforces that claim and nothing wider, and {@link DESCRIPTOR_PRIVACY_CLAIM} is the sentence a
 * screen may show. A screen saying "your visit is private" would be saying something this build cannot
 * deliver.
 *
 * ## Nothing here holds a descriptor
 *
 * No descriptor string appears in this file, in `packages/config` or in any migration. `Y7-descriptor` is
 * open: nobody has chosen a descriptor and no acquirer has told this business how long one may be, so
 * both the value and the ceiling are `provisional` F09 settings and every function here takes the limit
 * as an argument. A plausible descriptor written into a default is indistinguishable from one a processor
 * accepted (brief rule 15), and the one place it would be read is the line on a customer's statement.
 *
 * Pure: no I/O, no clock.
 */

/** The OPEN-QUESTIONS id the descriptor and its length ceiling are provisional until. */
export const DESCRIPTOR_OPEN_QUESTION = 'Y7-descriptor'

/** The OPEN-QUESTIONS id the merchant category code is unanswered under. */
export const MCC_OPEN_QUESTION = 'Y7-mcc'

/**
 * The sentence a screen may show about what a discreet descriptor achieves.
 *
 * One sentence, in one place, and deliberately a narrow claim. A reassurance wider than the mechanism is
 * worse than no reassurance: a customer who believed their visit was concealed and found a recognisable
 * business name on a shared statement was misled by this system rather than by the bank.
 */
export const DESCRIPTOR_PRIVACY_CLAIM =
  'The statement line names the business, not the treatment. It does not hide that a payment was ' +
  'made, its amount or its date, and it does not hide the business from anyone who looks the name up.'

/**
 * Terms a statement descriptor may not contain, lower-cased.
 *
 * Three groups, and the third is the one that would be missed:
 *
 *   - the **service** words, which are what the descriptor exists not to say;
 *   - the **style** words from the catalogue's own vocabulary, because "THAI" on a statement line names
 *     a treatment as surely as "MASSAGE" does;
 *   - the **euphemisms**, which are worse than the plain words rather than better: a statement line
 *     reading `RELAXATION` or `WELLNESS CENTRE` is read by a suspicious reader as concealment, and a
 *     descriptor that invites a question has failed at the one thing it is for.
 *
 * Matched as whole words against a normalised descriptor, so `SPAIN` is not `SPA` — see
 * {@link lintStatementDescriptor} for why the match is on word boundaries and not on substrings.
 */
export const DESCRIPTOR_BLOCKED_TERMS: readonly string[] = Object.freeze([
  // The service.
  'massage',
  'spa',
  'treatment',
  'therapy',
  'therapist',
  'facial',
  'scrub',
  'sauna',
  'steam',
  'hammam',
  'jacuzzi',
  // The styles, as `TREATMENT_STYLES` spells them.
  'thai',
  'swedish',
  'balinese',
  'shiatsu',
  'moroccan',
  'deep tissue',
  'hot stone',
  'aromatherapy',
  'reflexology',
  // The euphemisms, which invite the question the descriptor exists to avoid.
  'relax',
  'relaxation',
  'wellness',
  'wellbeing',
  'holistic',
  'sensual',
  'oriental',
  'parlour',
  'parlor',
])

export const DESCRIPTOR_RULES = [
  'descriptor-not-configured',
  'descriptor-is-blank',
  'descriptor-exceeds-provider-limit',
  'descriptor-limit-not-configured',
  'descriptor-contains-a-blocked-term',
  'descriptor-has-unsupported-characters',
] as const
export type DescriptorRule = (typeof DESCRIPTOR_RULES)[number]

export interface DescriptorRefusal {
  readonly rule: DescriptorRule
  /** A sentence an operator can act on, naming what to change. */
  readonly detail: string
  /** The blocked terms found, for `descriptor-contains-a-blocked-term`; empty otherwise. */
  readonly terms: readonly string[]
}

export type DescriptorVerdict =
  | { readonly ok: true; readonly descriptor: string; readonly limit: number }
  | { readonly ok: false; readonly refusals: readonly DescriptorRefusal[] }

const refusal = (
  rule: DescriptorRule,
  detail: string,
  terms: readonly string[] = [],
): DescriptorRefusal => ({ rule, detail, terms })

/**
 * The markers `is_placeholder_text()` (migration 0026) refuses, lower-cased.
 *
 * Restated here rather than imported, because `packages/core` may not read a database and the function
 * is SQL — and the two are held equal by `descriptor.test.ts`, which asserts that the shipped default
 * matches this list, so the pair cannot drift into a descriptor that the schema refuses and the lint
 * accepts. That is the shape the brief asks for when a fact is stated twice.
 */
const PLACEHOLDER_MARKERS: readonly string[] = Object.freeze([
  '[confirm]',
  'to be confirmed',
  'tbc',
  'tbd',
  'pending',
  'placeholder',
  'not configured',
  'unknown',
  'todo',
  'xxx',
])

/**
 * True when a stored descriptor is a MARKER rather than a value.
 *
 * `app_setting.value` is NOT NULL, so "nobody has chosen a descriptor" is stored as a marker the schema
 * refuses rather than as a null (brief rule 15). This is what makes the marker and a real absence the
 * same answer to the lint — `descriptor-not-configured` — so a caller never has to know which shape the
 * absence arrived in.
 */
export function isPlaceholderDescriptor(descriptor: string): boolean {
  const value = descriptor.trim().toLowerCase()
  if (value === '') return true
  return PLACEHOLDER_MARKERS.some((marker) => value.includes(marker))
}

/**
 * The characters a card network will carry on a statement line.
 *
 * Upper-case letters, digits, space and a handful of punctuation. Not a guess about one processor: every
 * scheme's descriptor field is a restricted ASCII subset, and the failure mode of sending anything else
 * is silent — the character is dropped or transliterated by whichever system is strictest, and the line
 * a customer reads is not the line that was configured. An Arabic descriptor is therefore refused here
 * rather than mangled downstream, and that is a real limitation worth naming rather than hiding:
 * `Y7-descriptor` is where an Arabic statement line, if one is possible at all, gets answered.
 */
const SUPPORTED_DESCRIPTOR_CHARACTERS = /^[A-Z0-9 .,\-*&/']+$/

/**
 * Judges one descriptor against one provider's limit.
 *
 * ## Why the limit is an argument with no default
 *
 * Every card network and every acquirer has its own descriptor length, and this business has neither. A
 * default would be a figure read as configured in the one place a truncation is invisible: a descriptor
 * silently cut to the processor's length is still a valid line on a statement, and the part that was cut
 * is the part that made it recognisable. `descriptor-limit-not-configured` is therefore a REFUSAL rather
 * than a fallback.
 *
 * ## Why the term match is on word boundaries
 *
 * `SPA` as a substring matches `SPAIN`, `SPARE` and `BESPAKE`; `THAI` matches `THAILAND`, which is a
 * place. A substring rule would refuse legitimate descriptors, and the way a rule that refuses
 * legitimate values dies is by being switched off. So the match is on whole words over a descriptor
 * normalised to spaces — which also catches `SPA-AUH` and `BR*SPA`, because the punctuation a card
 * network permits is treated as a separator rather than as part of a word.
 */
export function lintStatementDescriptor(input: {
  readonly descriptor: string | null | undefined
  readonly limit: number | null | undefined
}): DescriptorVerdict {
  const out: DescriptorRefusal[] = []

  if (
    input.limit === null ||
    input.limit === undefined ||
    !Number.isInteger(input.limit) ||
    input.limit < 1
  ) {
    out.push(
      refusal(
        'descriptor-limit-not-configured',
        'No descriptor length limit is configured, so there is nothing to judge the descriptor against. ' +
          'Every card network and every acquirer has its own, and this business has neither — ' +
          `${DESCRIPTOR_OPEN_QUESTION}. Refusing rather than assuming one: a descriptor silently cut to ` +
          'a processor’s length is still a valid statement line, and the part that was cut is the ' +
          'part that made it recognisable.',
      ),
    )
  }

  if (
    input.descriptor === null ||
    input.descriptor === undefined ||
    isPlaceholderDescriptor(input.descriptor)
  ) {
    out.push(
      refusal(
        'descriptor-not-configured',
        'No statement descriptor is configured. Unset is a first-class state: no acquirer has been ' +
          `chosen and nobody has approved a statement line (${DESCRIPTOR_OPEN_QUESTION}), and a ` +
          'plausible one written into a default would be indistinguishable from one a processor ' +
          'accepted. A stored MARKER answers here too, because `app_setting.value` is NOT NULL so the ' +
          'absence is stored as a value the schema refuses rather than as a blank.',
      ),
    )
    return { ok: false, refusals: out }
  }

  const descriptor = input.descriptor.trim()
  if (descriptor === '') {
    out.push(
      refusal(
        'descriptor-is-blank',
        'A blank descriptor is not an unset one. Unset means nobody has chosen; blank means somebody ' +
          'saved an empty box, and the processor would substitute whatever it likes.',
      ),
    )
    return { ok: false, refusals: out }
  }

  const upper = descriptor.toUpperCase()
  if (!SUPPORTED_DESCRIPTOR_CHARACTERS.test(upper)) {
    out.push(
      refusal(
        'descriptor-has-unsupported-characters',
        `"${descriptor}" contains characters a card network will not carry. The descriptor field is a ` +
          'restricted ASCII subset on every scheme, and the failure is silent: the character is dropped ' +
          'or transliterated by whichever system is strictest, so the line the customer reads is not the ' +
          `line that was configured. Whether an Arabic statement line is possible at all is ` +
          `${DESCRIPTOR_OPEN_QUESTION}.`,
      ),
    )
  }

  if (typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit >= 1) {
    if (descriptor.length > input.limit) {
      out.push(
        refusal(
          'descriptor-exceeds-provider-limit',
          `"${descriptor}" is ${descriptor.length} characters and the configured limit is ` +
            `${input.limit}. A descriptor over the limit is not rejected by the processor — it is ` +
            'TRUNCATED, and the characters that go are the ones at the end, which is where the city and ' +
            'the branch are. Shorten it to something that is still recognisable at ' +
            `${input.limit} characters.`,
        ),
      )
    }
  }

  // The normalised form: every permitted punctuation character becomes a separator, so `BR*SPA` and
  // `SPA-AUH` are both three words rather than one. See the function's note on word boundaries.
  const words = upper
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
  const normalised = ` ${words.join(' ')} `
  const found = DESCRIPTOR_BLOCKED_TERMS.filter((term) =>
    normalised.includes(` ${term.toUpperCase()} `),
  )
  if (found.length > 0) {
    out.push(
      refusal(
        'descriptor-contains-a-blocked-term',
        `"${descriptor}" contains ${found.map((term) => `"${term}"`).join(', ')}, which names what was ` +
          'bought rather than who was paid. A statement line is read by whoever shares the account, and ' +
          'naming the treatment is a disclosure the cardholder did not choose to make. The euphemisms ' +
          'are blocked too, and for a sharper reason: a line reading RELAXATION or WELLNESS is read as ' +
          'concealment, and a descriptor that invites a question has failed at the one thing it is for.',
        found,
      ),
    )
  }

  if (out.length > 0) return { ok: false, refusals: out }
  return { ok: true, descriptor, limit: input.limit as number }
}

/**
 * Whether a real payment provider may be selected, as a value.
 *
 * Y-PAY-10's acceptance line: *"config refuses `PAYMENT_PROVIDER=real` unless `APP_ENV=production` and
 * `legal_entity` carries a non-null `mcc_confirmed_at` with the recorded MCC"*. Both halves, and they are
 * different kinds of fact — one is configuration and one is a row — which is why this takes them as two
 * arguments and `packages/config` cannot answer it alone: `parseConfig` reads no database, so the
 * environment half is refused there (ADR 0005) and the MCC half is refused where the gateway is
 * constructed.
 *
 * Every refusal is NAMED and they accumulate, because an operator fixing a go-live needs the list rather
 * than the first item on it.
 */
export type RealProviderVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly RealProviderRefusal[] }

export const REAL_PROVIDER_REFUSALS = [
  'not-production',
  'mcc-not-confirmed',
  'mcc-not-recorded',
  'mcc-confirmation-has-no-recorder',
] as const
export type RealProviderRefusal = (typeof REAL_PROVIDER_REFUSALS)[number]

export function mayUseRealPaymentProvider(input: {
  readonly isProduction: boolean
  readonly mcc: string | null
  readonly mccConfirmedAtIso: string | null
  readonly mccConfirmedBy: string | null
}): RealProviderVerdict {
  const reasons: RealProviderRefusal[] = []
  if (!input.isProduction) reasons.push('not-production')
  if (input.mccConfirmedAtIso === null) reasons.push('mcc-not-confirmed')
  if (input.mcc === null || input.mcc.trim() === '') reasons.push('mcc-not-recorded')
  if (input.mccConfirmedBy === null || input.mccConfirmedBy.trim() === '') {
    reasons.push('mcc-confirmation-has-no-recorder')
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}

/** The sentence a refusal from {@link mayUseRealPaymentProvider} reads as. One wording, one meaning. */
export function realProviderRefusalDetail(reasons: readonly RealProviderRefusal[]): string {
  const parts: Record<RealProviderRefusal, string> = {
    'not-production':
      'APP_ENV is not production, and a real provider outside production can take a ' +
      'real payment from a test run (ADR 0005)',
    'mcc-not-confirmed':
      'legal_entity.mcc_confirmed_at is null, so no acquirer has confirmed a merchant category code ' +
      `in writing (${MCC_OPEN_QUESTION})`,
    'mcc-not-recorded': 'legal_entity.mcc is null, so there is no code to be confirmed',
    'mcc-confirmation-has-no-recorder':
      'legal_entity.mcc_confirmed_by is null, so the confirmation has nobody behind it — which is the ' +
      'one question an acquirer dispute asks',
  }
  return (
    `A real payment provider may not be selected: ${reasons.map((reason) => parts[reason]).join('; ')}. ` +
    'The manual adapter remains the only live path, and it takes cash, the in-salon card machine and a ' +
    'bank transfer.'
  )
}
