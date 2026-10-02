import { AppError, PLACEHOLDER_MARKERS } from '@berelax/shared'

/**
 * The data-subject rights policy engine (C-CRM-10): what each right DOES to each class of data, and the
 * argument for each class.
 *
 * ## Why this is a registry and not a function with a switch
 *
 * Erasure and statutory retention are in direct conflict and neither may silently win. A tax invoice
 * naming a customer must be kept; an append-only journal cannot be rewritten; a clinical submission is
 * sealed under a key this path may not hold. So "erase" cannot mean `delete from customer` — and it
 * equally cannot mean "we recorded the request and did nothing". What the request does to each class has
 * to be enumerated, and what is RETAINED has to be retained for a stated reason rather than by omission.
 *
 * The failure this is built against is not a wrong rule. It is a MISSING one: a table added by a later
 * unit that holds a phone number, that nobody classified, and that nothing notices — after which the
 * business messages somebody who asked to be forgotten. So the set of things to decide about is
 * enumerated FROM THE DATABASE by `erasureCoverage` in `packages/db/src/privacy-coverage.ts`, over five
 * catalogue probes, and a column that lands in neither {@link ERASURE_RULES} nor a table wildcard makes
 * `packages/fixtures/src/rights.itest.ts` FAIL. This file is not the authority on what exists; the
 * catalogue is. That is the difference between a check and a list, and it is `merge-participants.ts`'s
 * argument verbatim — deliberately, because that unit already solved "find every table holding a person"
 * and a second answer to that question is how the two come to disagree.
 *
 * **This file does not re-list the tables a merge knows about.** The merge registry's own coverage query
 * is one of the five probes, so the customer-reference axis has exactly one enumeration shared between the
 * two units: a table registered for merge with no erasure rule fails this unit's test, and a table with an
 * erasure rule that nobody registered for merge fails theirs. Neither can be satisfied from memory.
 *
 * ## The five probes, and why one axis was not enough
 *
 * Three of them were found by running the queries rather than by reasoning. The count is FIVE and not
 * four: this header said four for as long as the fifth probe had existed, which is the drift a reader
 * pays for — somebody checking whether free text is covered would have read a complete-looking list of
 * four and concluded it is not. `ERASURE_PROBE_AXES` is the list that cannot go stale, because
 * `rights.itest.ts` asserts every axis in it finds something:
 *
 *   1. **Customer-reference columns** — `(.*_)?(customer|contact)_id`. The merge's axis. It finds the
 *      twenty-four columns that say WHOSE a row is.
 *   2. **Contact-detail columns** — `phone_e164`, `recipient`, `display_name`, the match keys, the
 *      snapshots. This axis is the one reachability actually lives on, and it finds three tables the first
 *      one cannot see at all: `otp_challenge` and `otp_phone_lock` are keyed by the PHONE NUMBER and hold
 *      no customer id, and `message.recipient` holds the number every message was sent to with no
 *      customer id either. An erasure built on the merge's axis alone would have left a person's phone
 *      number in three tables and called itself complete.
 *   3. **Foreign-key children** — a table whose only link to a subject is an FK to a covered table
 *      (`appointment` through `booking`, `invoice_line` through `invoice`, `package_balance` through
 *      `package_sale`). Each is classified `inherits_parent` with the parent named, so "it follows its
 *      parent" is a decision on the record rather than an omission.
 *   4. **Credential columns** — `token`, `_sha256`, `code_hash`, `hmac`, `secret`. This one exists
 *      because of a single table: `booking_manage_grant` holds a live token that lets its bearer act on a
 *      booking, has NO customer id, NO contact detail and NO foreign key to `booking` — so it is invisible
 *      to the other three probes, and pseudonymising the customer does not make the link stop working.
 *      The fourth probe was added after the third one was written and did not find it.
 *   5. **Free-text note columns** — `notes`, or a name ending `_note`, on a subject-scoped table.
 *      This one exists because of `customer.notes`, which is where the front desk types a person's
 *      relationships, preferences and allergies in prose. It is not a reference, not a contact detail,
 *      not a credential and not a foreign key, so the first four probes are all blind to it. It is
 *      narrowed to subject-scoped tables deliberately, so that it makes a claim it can keep — see
 *      `privacy-coverage.ts` for what no row-level erasure can find, and ADR 0034.
 *
 * ## The clinical conflict, which is real and is not resolved by this unit's preference
 *
 * `regulatory_profile.erasure_overrides_retention` (migration 0004) defaults to **false**: erasure does
 * NOT override a retention obligation. `clinical_retention_years` defaults to 25, the healthcare-grade
 * figure, because `Y1-licence` is unanswered. Those two together say the clinical CONTENT is retained.
 * The manifest summary for this unit says erasure "destroys clinical DEKs". Both cannot be true of real
 * health data, and this file does not pretend otherwise — see {@link planClinicalErasure}, which is
 * three-valued and reads the profile instead of choosing.
 *
 * What makes the mechanism provable today rather than theoretical: `clinical.real_intake_permitted` is
 * false (`Y5-residency`), so every clinical row is `data_origin = 'synthetic'`. A synthetic row is not
 * anybody's health data, so no retention obligation attaches to it and no right is at stake — destroying
 * its key is safe under every reading, and it is the path the acceptance line exercises honestly.
 */

// ------------------------------------------------------------------------------------------------
// The five rights and their lifecycle
// ------------------------------------------------------------------------------------------------

export const RIGHTS_REQUEST_STATES = [
  'received',
  'in_progress',
  'completed',
  'partially_completed',
  'refused',
] as const
export type RightsRequestState = (typeof RIGHTS_REQUEST_STATES)[number]

/** The three states a request is finished in. `completed` is not the only honest ending. */
export const TERMINAL_RIGHTS_STATES: readonly RightsRequestState[] = Object.freeze([
  'completed',
  'partially_completed',
  'refused',
])

/**
 * How a requester was proved to be the subject. Required, with no default and no fourth value.
 *
 * An erasure performed for an unverified requester is a way to destroy somebody else's record, and it is
 * the cheapest attack on this whole engine: a phone number is not a secret, and "please erase +971…" in
 * an email costs nothing to send. `otp` is the customer proving possession of the number the identity IS
 * (ADR 0014); the other two are a human attesting to something they saw, and both record who.
 */
export const RIGHTS_VERIFICATION_METHODS = ['otp', 'in_person_id', 'staff_attested'] as const
export type RightsVerificationMethod = (typeof RIGHTS_VERIFICATION_METHODS)[number]

/**
 * The permitted transitions. A map rather than a predicate so the whole machine is readable at once.
 *
 * Nothing leaves a terminal state. A request answered wrongly is answered by a NEW request with its own
 * due date, for `merge_record`'s reason: the record of what was done is the only evidence that says so.
 */
const RIGHTS_TRANSITIONS: Readonly<Record<RightsRequestState, readonly RightsRequestState[]>> =
  Object.freeze({
    received: Object.freeze(['in_progress', 'refused'] as const),
    in_progress: Object.freeze(['completed', 'partially_completed', 'refused'] as const),
    completed: Object.freeze([] as const),
    partially_completed: Object.freeze([] as const),
    refused: Object.freeze([] as const),
  })

export function canTransition(from: RightsRequestState, to: RightsRequestState): boolean {
  return RIGHTS_TRANSITIONS[from].includes(to)
}

export const isTerminalRightsState = (state: RightsRequestState): boolean =>
  TERMINAL_RIGHTS_STATES.includes(state)

/**
 * When a request falls due.
 *
 * Whole days added to the instant it was RECEIVED, not to the start of that day, and the zone is not an
 * argument — which is a deliberate departure from brief rule 7 and the one place in this unit where it
 * would be wrong to follow it. A deadline measured in days from an instant is the same instant in every
 * zone; introducing a business day would make a request received at 01:30 fall due a day earlier than one
 * received at 02:30 on the same night (`resolveTradingDate` puts 01:30 on the previous trading date), and
 * a statutory deadline does not move with the salon's trading hours.
 */
export function dueDateFor(receivedAt: Date, slaDays: number): Date {
  if (!Number.isInteger(slaDays) || slaDays < 1) {
    throw new AppError(
      'validation',
      `A rights SLA must be a whole number of days of at least 1, received ${slaDays}. A deadline of ` +
        'zero is a request that is overdue the instant it is taken.',
      { details: { slaDays, refusal: 'rights_sla_not_a_deadline' } },
    )
  }
  return new Date(receivedAt.getTime() + slaDays * 24 * 60 * 60 * 1000)
}

/**
 * Whether a request is overdue at `now`.
 *
 * Named `isRightsRequestOverdue` and not `isOverdue`, which the barrel refused: `packages/core/src/agents`
 * already exports an `isOverdue` about an agent run, and two exports of one name through
 * `@berelax/core` is a TS2308 at the barrel. The fully-spelled name is also the one a caller wants —
 * "overdue" is a property of several things in this system and they have different deadlines.
 *
 * Strictly `>`, so a request is overdue only once the clock has PASSED its due instant rather than on
 * reaching it — the acceptance line says "once the frozen clock passes it" and the boundary case is the
 * one a frozen-clock test lands on exactly.
 */
export function isRightsRequestOverdue(
  request: { readonly dueAt: Date; readonly state: RightsRequestState },
  now: Date,
): boolean {
  if (isTerminalRightsState(request.state)) return false
  return now.getTime() > request.dueAt.getTime()
}

// ------------------------------------------------------------------------------------------------
// The stable pseudonym
// ------------------------------------------------------------------------------------------------

/**
 * `erased-` and thirty-two letters. What replaces `customer.phone_e164`.
 *
 * The column is `not null unique` and IS the identity (ADR 0014), so an erasure cannot null it and cannot
 * leave it. Whatever goes there has to satisfy three things at once, and every obvious candidate fails one:
 *
 *   - **It must not be a phone number.** Brief rule 15's argument at its sharpest: any value matching
 *     `^\+[1-9][0-9]{7,14}$` is a *plausible* number, and a plausible number may be somebody's. Erasing
 *     one customer would write a real stranger's number into the identity column, and the next send to
 *     that record would reach them. So migration 0085 widens the constraint to admit this shape instead,
 *     and the shape contains **no digits at all** — it cannot be dialled, cannot be normalised, and cannot
 *     collide with a real number.
 *   - **It must not produce a match key.** `phone_match_key` is generated as the trailing nine DIGITS of
 *     this column. With no digits it derives to the empty string, so an erased record can never surface as
 *     a merge candidate for a living person. A hex or base-36 pseudonym would have derived nine digits
 *     that could equal a real person's key, which is the same defect in a quieter costume.
 *   - **It must be stable and unique.** Both fall out of the encoding being a BIJECTION on the uuid's hex
 *     digits (`0-9 → a-j`, `a-f → k-p`): distinct customers cannot collide, and erasing the same record
 *     twice yields the same label, so the operation is idempotent.
 *
 * Deliberately NOT a hash, and this is the decision worth reading twice. A hash would be *reversible only
 * with a lookup table*, which sounds stronger and is worse here: the pseudonym replaces the PHONE NUMBER,
 * and it is the phone number that must become unrecoverable. The customer id is retained regardless — it
 * is on every invoice the FTA requires be kept — so a label derived from the id reveals nothing the
 * database did not already hold, needs no pepper, adds no key to rotate (`pnpm rotation`), and lets a
 * support engineer answer "which record is this" without one. A hash would have bought secrecy about a
 * value that is not secret, at the price of a secret to manage.
 */
export const ERASURE_PSEUDONYM_PREFIX = 'erased-'
/** The shape migration 0085 admits and `packages/fixtures/src/rights.itest.ts` asserts against. */
export const ERASURE_PSEUDONYM_PATTERN = /^erased-[a-p]{32}$/

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** `0-9 → a-j`, `a-f → k-p`. Sixteen entries, so the map is total over lower-case hex. */
const HEX_TO_LETTER: Readonly<Record<string, string>> = Object.freeze({
  '0': 'a',
  '1': 'b',
  '2': 'c',
  '3': 'd',
  '4': 'e',
  '5': 'f',
  '6': 'g',
  '7': 'h',
  '8': 'i',
  '9': 'j',
  a: 'k',
  b: 'l',
  c: 'm',
  d: 'n',
  e: 'o',
  f: 'p',
})

export function erasurePseudonym(customerId: string): string {
  const id = customerId.toLowerCase()
  if (!UUID_PATTERN.test(id)) {
    throw new AppError(
      'validation',
      `A pseudonym is derived from a customer uuid, received "${customerId}". Deriving one from ` +
        'anything else would put a value of unknown shape into the identity column.',
      { details: { refusal: 'erasure_pseudonym_source_not_a_uuid' } },
    )
  }
  let letters = ''
  for (const character of id) {
    if (character === '-') continue
    // Total over lower-case hex by construction, and the uuid pattern above is what makes it so.
    letters += HEX_TO_LETTER[character]
  }
  return `${ERASURE_PSEUDONYM_PREFIX}${letters}`
}

// ------------------------------------------------------------------------------------------------
// Data classes and the actions available to an erasure
// ------------------------------------------------------------------------------------------------

/**
 * The classes retention and legal hold are held per, as docs/04 §8 requires.
 *
 * `suppression_record` is its own class rather than part of `contact_channel`, and the distinction is the
 * whole of acceptance line four: every other class is data held ABOUT the subject, and this one is data
 * held FOR them. Folding it into the contact class is how an erasure comes to delete the row that keeps
 * the person un-messageable.
 */
export const DATA_CLASSES = [
  'identity',
  'contact_channel',
  'credential',
  'consent_record',
  'suppression_record',
  'operational',
  'clinical',
  'financial',
  'audit',
  'not_customer_data',
] as const
export type DataClass = (typeof DATA_CLASSES)[number]

/**
 * What an erasure may do to a column. Nine actions, and the four RETAIN-shaped ones are not one action.
 *
 * `retain_statutory` names an obligation and a number of years; `retain_append_only` names a table the
 * database refuses to change for every role; `retain_for_subject` is kept in the subject's own interest.
 * Collapsing them into "retained" would make the resolution row say the same thing about a tax invoice,
 * an audit log and a suppression entry — three retentions with three different justifications, of which
 * only one would survive being asked about.
 */
export const ERASURE_ACTIONS = [
  'pseudonymise',
  'redact',
  'delete_row',
  'crypto_erase',
  // There is no `revoke`. It existed for one rule — `booking_manage_grant.token_sha256`, pulling
  // `expires_at` back to the erasure instant — and that rule is now a `delete_row` for the two reasons its
  // `why` sets out, the first of which is that 0067 revokes UPDATE on that table from the application role.
  // The label is gone rather than left unused: an action nothing performs is an untested branch in the
  // executor and a value migration 0085's CHECK admits for no reason.
  'retain_statutory',
  'retain_append_only',
  'retain_for_subject',
  'retain_legitimate_interest',
  'inherits_parent',
  'not_customer_data',
] as const
export type ErasureAction = (typeof ERASURE_ACTIONS)[number]

/** The actions that leave readable data about the subject in place. Each one needs a reason. */
const RETAINING_ACTIONS: readonly ErasureAction[] = Object.freeze([
  'retain_statutory',
  'retain_append_only',
  'retain_for_subject',
  'retain_legitimate_interest',
])

export const isRetainingAction = (action: ErasureAction): boolean =>
  RETAINING_ACTIONS.includes(action)

export interface ErasureRule {
  /** `schema.table.column`, or `schema.table.*` for a table whose every probed column shares a rule. */
  readonly key: string
  readonly dataClass: DataClass
  readonly action: ErasureAction
  /**
   * Why this action and not the obvious alternative, for whoever MAINTAINS this. Required for every entry.
   *
   * Names migrations, SQLSTATEs, constraint names and the defect each rule is built against, because that
   * is what a reader of the registry needs. It is deliberately NOT what a data subject is told — see
   * {@link subjectReason}.
   */
  readonly why: string
  /**
   * The reason it is lawful to keep the data, in the words a DATA SUBJECT is given. Required for every
   * retaining rule and absent from every other.
   *
   * Separate from {@link why}, and the separation was forced by a constraint rather than chosen for
   * tidiness. `rights_resolution_class.retained_reason` is refused by `is_placeholder_text` (0026), which
   * rejects any text containing `pending`, `unknown`, `placeholder`, `tbc` and six other markers — and the
   * maintainer's prose legitimately contains several of them: `merge_record.phone_agreement`'s reason
   * quotes `'unknown'` as one of six enum labels, and half the clinical reasons say `unconfirmed`. Writing
   * `why` into that column made the whole erasure roll back with a constraint name that pointed at nothing.
   *
   * The constraint was right and the design was wrong. A sentence given to somebody exercising a statutory
   * right should not read "0064 keys this on the hashed DETAIL and says so as the answer to C-CRM-03's
   * question", and the fact that one could not be stored is the database saying so.
   *
   * {@link ruleRegistry} refuses a subject reason carrying a placeholder marker at MODULE LOAD, using the
   * same list 0026 uses, so the failure is a test rather than a rolled-back erasure.
   */
  readonly subjectReason?: string
  /** For `retain_statutory`: the profile column naming the obligation, so the figure is never a literal. */
  readonly obligationColumn?: 'financial_retention_years' | 'clinical_retention_years'
  /** For `inherits_parent`: the covered table whose fate governs this one. */
  readonly parent?: string
  /** The unit that classified it, so a question about an entry has somewhere to go. */
  readonly registeredBy: string
}

const rule = (r: ErasureRule): ErasureRule => Object.freeze(r)

/**
 * Freezes the rule set, refusing a key classified twice and a retaining action with no reason.
 *
 * At module load and throwing, for the reason `registry()` in `merge-participants.ts` throws: two rules
 * for one column is legal TypeScript, and the one that wins is whichever the lookup reaches first. If the
 * two disagree about whether a phone number is redacted or retained, an erasure quietly does the wrong
 * one — and the symptom is not an error, it is a message to somebody who asked to be forgotten, months
 * later. A module that refuses to load fails in `pnpm test` instead.
 */
function ruleRegistry(rules: readonly ErasureRule[]): ReadonlyMap<string, ErasureRule> {
  const byKey = new Map<string, ErasureRule>()
  const duplicated: string[] = []
  const unexplained: string[] = []
  for (const entry of rules) {
    if (byKey.has(entry.key)) duplicated.push(entry.key)
    byKey.set(entry.key, entry)
    if (isRetainingAction(entry.action) && entry.why.trim().length === 0) {
      unexplained.push(entry.key)
    }
    if (isRetainingAction(entry.action)) {
      const subjectReason = entry.subjectReason ?? ''
      // Required, and refused if it carries a marker `is_placeholder_text` would reject. The same list,
      // imported rather than restated: two spellings of it would let a reason through here and fail at the
      // insert, which is the rolled-back erasure this check exists to turn into a test failure.
      if (subjectReason.trim().length === 0 || PLACEHOLDER_MARKERS.test(subjectReason)) {
        unexplained.push(entry.key)
      }
    }
    if (entry.action === 'retain_statutory' && entry.obligationColumn === undefined) {
      unexplained.push(entry.key)
    }
    if (entry.action === 'inherits_parent' && entry.parent === undefined) {
      unexplained.push(entry.key)
    }
  }
  if (duplicated.length > 0 || unexplained.length > 0) {
    throw new AppError(
      'invariant_violated',
      `The erasure rule registry is not well formed. Classified more than once: ${
        duplicated.join(', ') || '(none)'
      }. Retained or inherited with nothing stating why: ${unexplained.join(', ') || '(none)'}. A ` +
        'column with two rules erases according to whichever lookup wins, and a retention with no ' +
        'stated reason is the omission this registry exists to prevent.',
      { details: { duplicated, unexplained, refusal: 'erasure_rule_registry_invalid' } },
    )
  }
  return byKey
}

/**
 * Every probed column, and what an erasure does to it.
 *
 * Ordered by data class rather than alphabetically, because the argument reads as a set: the identity
 * goes, the channels that could reach the person go, the credentials stop working, the records held FOR
 * the person stay, the documents a regulator reads stay with the obligation named, and the logs that are
 * the evidence of all of it stay because nothing may edit them.
 */
export const ERASURE_RULES: ReadonlyMap<string, ErasureRule> = ruleRegistry([
  // --- identity: the CRM record itself -----------------------------------------------------------
  rule({
    key: 'public.customer.phone_e164',
    dataClass: 'identity',
    action: 'pseudonymise',
    why:
      'The phone number IS the identity (ADR 0014), so this is the column an erasure exists to empty — ' +
      'and it is `not null unique`, so it cannot be emptied, only replaced. It takes the digit-free ' +
      'pseudonym rather than a plausible number, because a plausible number may belong to a stranger ' +
      'who would then receive this record’s messages. After this write no lookup by phone can ' +
      'reach the record and no send path can resolve a recipient from it.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.customer.display_name',
    dataClass: 'identity',
    action: 'redact',
    why:
      'Nulled, which is the state a customer who never gave a name is already in — so an erased ' +
      'record reads as `Customer 0042` through the same path as an unnamed one (ADR 0020) and no screen ' +
      'needs to know the difference.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.customer.name_match_key',
    dataClass: 'identity',
    action: 'redact',
    why:
      'The fold of the name plus the last four digits of the number: it is a derivative of both erased ' +
      'values and would let the duplicate matcher find the person by either. Nullable, and null is what ' +
      'a record with no name holds.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.customer.phone_match_key',
    dataClass: 'identity',
    action: 'inherits_parent',
    parent: 'public.customer.phone_e164',
    why:
      'GENERATED ALWAYS from `phone_e164`, so it cannot be written and must not be: it is recomputed by ' +
      'the database from the pseudonym, and because the pseudonym holds no digits it derives to the ' +
      'empty string. That is the mechanism that stops an erased record surfacing as a merge candidate, ' +
      'and it is a consequence of the pseudonym’s shape rather than a second write anybody has to ' +
      'remember.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.customer.phone_verified_at',
    dataClass: 'identity',
    action: 'redact',
    why:
      'Nulled. It asserts that somebody proved possession of a number, and the number it referred to no ' +
      'longer exists on the row — left set, it would claim the PSEUDONYM had been verified by OTP.',
    registeredBy: 'C-CRM-10',
  }),

  // --- free text somebody typed about the person -------------------------------------------------
  rule({
    key: 'public.customer.notes',
    dataClass: 'identity',
    action: 'redact',
    why:
      'The fifth probe’s reason for existing. This column is not a contact detail, not a reference, ' +
      'not a credential and not a foreign key, so none of the other four axes can see it — and it is ' +
      'where the front desk types "prefers Fatima, sister of the +9715... booking, allergic to almond ' +
      'oil". It is unstructured personal data by definition and nulled.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.booking.notes',
    dataClass: 'operational',
    action: 'redact',
    why:
      '`customer.notes` on the booking a member of staff took. Nulled rather than kept with the booking, ' +
      'because the booking is retained by reference for the appointment and invoice chain and its notes ' +
      'are not part of either — nothing on a tax document reads them.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.customer_preference.music_note',
    dataClass: 'operational',
    action: 'inherits_parent',
    parent: 'public.customer_preference.customer_id',
    why: 'The whole preference row is deleted, so its three free-text notes go with it.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.customer_preference.oil_note',
    dataClass: 'operational',
    action: 'inherits_parent',
    parent: 'public.customer_preference.customer_id',
    why:
      '`music_note`’s case: one of three free-text preference notes on a row that is deleted whole, ' +
      'so it needs no action of its own.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.customer_preference.pressure_note',
    dataClass: 'operational',
    action: 'inherits_parent',
    parent: 'public.customer_preference.customer_id',
    why:
      '`music_note`’s case again, the third of the three. Deleted with the preference row rather ' +
      'than redacted, because the row itself has no purpose once there is nobody to serve.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.invoice.notes',
    dataClass: 'financial',
    action: 'retain_statutory',
    obligationColumn: 'financial_retention_years',
    why:
      'A note ON an issued tax invoice is part of the document, and the document is append-only and must ' +
      'be kept. Redacting it would alter a filed document, which is the one thing the FTA rule and the ' +
      '`invoice_no_update` trigger both refuse.',
    subjectReason:
      'Any note written on a tax invoice stays on it, because the invoice may not be altered after it ' +
      'is issued.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.credit_note.notes',
    dataClass: 'financial',
    action: 'retain_statutory',
    obligationColumn: 'financial_retention_years',
    why: '`invoice.notes`’s case on the correcting document.',
    subjectReason:
      'Any note written on a credit note stays on it, because the document may not be altered after it ' +
      'is issued.',
    registeredBy: 'C-CRM-10',
  }),

  // --- contact channels: where reachability actually lives ---------------------------------------
  rule({
    key: 'public.otp_challenge.phone_e164',
    dataClass: 'contact_channel',
    action: 'delete_row',
    why:
      'Found only by the SECOND catalogue probe: this table is keyed by the phone number and holds no ' +
      'customer id at all, so the merge registry’s axis cannot see it and an erasure built on that ' +
      'axis alone would leave the number here. The whole row goes rather than the column: it is a ' +
      'five-minute challenge whose only content is the number and a hash of a code sent to it, nothing ' +
      'references it (no foreign key points here), and a challenge for a number nobody holds is not a ' +
      'record of anything.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.otp_phone_lock.phone_e164',
    dataClass: 'contact_channel',
    action: 'delete_row',
    why:
      '`otp_challenge`’s case exactly — keyed by the number, no customer id, invisible to the ' +
      'reference axis. A fifteen-minute failed-attempt counter for a number the business no longer ' +
      'holds.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.booking_session.phone_e164',
    dataClass: 'contact_channel',
    action: 'inherits_parent',
    parent: 'public.booking_session.customer_id',
    why:
      '`not null`, so the column cannot be cleared and the row is deleted by the reference-axis rule ' +
      'below. A public booking session is a token and an expiry; one belonging to an erased person must ' +
      'not be completable, and deleting it is also what removes the number.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.booking_session.customer_id',
    dataClass: 'contact_channel',
    action: 'delete_row',
    why:
      'A session in flight would otherwise finish against an erased record and hang an appointment off ' +
      'it. Nothing references this table, so the row can go — and it must, because its ' +
      '`phone_e164` is `not null` and there is no other way to remove the number.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.booking_session.token_hash',
    dataClass: 'credential',
    action: 'inherits_parent',
    parent: 'public.booking_session.customer_id',
    why: 'The row is deleted, so the token stops resolving. Named so the credential probe is satisfied.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.message.recipient',
    dataClass: 'contact_channel',
    action: 'redact',
    why:
      'Every message ever sent, with the number in the clear and NO customer id — the second thing ' +
      'the reference axis cannot see. The row cannot be deleted: six tables reference `message` with ON ' +
      'DELETE RESTRICT (`frequency_ledger`, `scheduled_step`, three notice tables and the delivery ' +
      'receipt), so a delete would raise. Redaction is therefore the only available action and it is ' +
      'also the right one: the channel, class, cost, status and timestamps stay, so "we sent this person ' +
      'a promotional SMS on that date" is still answerable — which is what a do-not-contact dispute ' +
      'turns on — while the address it went to does not. **These rows are found BY the recipient, ' +
      'so they must be found before the identity is pseudonymised**, which is why the plan is ordered ' +
      'and identity is last.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.message.body',
    dataClass: 'contact_channel',
    action: 'redact',
    why:
      'A rendered body carries the name, the service and the appointment time. Replaced with a stated ' +
      'marker rather than nulled, because the column is `not null` and a blank body would read as a ' +
      'message that was sent empty.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.message.subject',
    dataClass: 'contact_channel',
    action: 'redact',
    why: '`body`’s case for the email channel. Nullable, so nulled.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.message.body_html',
    dataClass: 'contact_channel',
    action: 'redact',
    why: '`body`’s case for the rendered HTML alternative. Nullable, so nulled.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.message_template_variant.*',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'A TEMPLATE’s body and subject, caught by the contact probe on those two column names. It is ' +
      'the copy before anything is substituted into it; the rendered result is `message.body`, which IS ' +
      'redacted. A template holds placeholders, never a person. The distinction is why the probe is on ' +
      'the column name and the decision is on the table.',
    registeredBy: 'C-CRM-10',
  }),

  // --- credentials: links already in somebody's hand ---------------------------------------------
  rule({
    key: 'public.booking_manage_grant.token_sha256',
    dataClass: 'credential',
    action: 'delete_row',
    why:
      'The reason the FOURTH probe exists. This table holds a live token that lets its bearer view and ' +
      'cancel a booking, and it has no customer id, no contact detail and — checked, not assumed ' +
      '— no foreign key to `booking` either, so all three of the other probes miss it. ' +
      'Pseudonymising the customer does not make the link stop working. ' +
      'DELETED, and an earlier draft of this rule said `revoke` — `expires_at` pulled back to the ' +
      'erasure instant so the grant stopped resolving while the row survived. That was wrong twice over. ' +
      'It was wrong on PRIVILEGE: 0067 revokes UPDATE on this table from `berelax_app` in so many words ' +
      '("there is no legitimate edit to a capability ... an UPDATE here would move a live link onto ' +
      'somebody else’s booking in one statement") and grants DELETE as the revocation path, so the ' +
      'UPDATE raised `permission denied for table booking_manage_grant` the first time the erasure ran as ' +
      'the application role rather than as the owner — every test green, and the feature dead on the ' +
      'first real request. And it was wrong on the MERITS: the benefit claimed for keeping the row was ' +
      'that it kept "who was given a link to this booking" answerable, which this table cannot answer at ' +
      'all — it holds no customer id, which is the very fact that makes probe 4 necessary. So the ' +
      'surviving row would have been a digest of a live secret, kept about an erased person, for a ' +
      'question it could not answer. Deleting it is what 0067 already called revocation.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.optout_grant.token_sha256',
    dataClass: 'suppression_record',
    action: 'inherits_parent',
    parent: 'public.optout_grant.contact_customer_id',
    why:
      'The opt-out link is retained, so its token is too. See the reference-axis rule below for why ' +
      'this is the one credential an erasure must NOT revoke.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.otp_challenge.code_hash',
    dataClass: 'credential',
    action: 'inherits_parent',
    parent: 'public.otp_challenge.phone_e164',
    why:
      'The challenge row is deleted by the rule above, so the salted hash of the code goes with it. ' +
      'Nothing is left to match a guessed code against, and there is no separate redaction to make.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.obligation_evidence_grant.token_sha256',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'A grant to view an inspection evidence file. Scoped to an obligation instance and a staff viewer, ' +
      'never to a customer.',
    registeredBy: 'C-CRM-10',
  }),
  /*
   * W-SITE-10's publication control plane. Three columns, named individually rather than as
   * `publication_*.*`, and that is the point of naming them: a `*` key would silently classify a column
   * somebody adds to one of these tables later — an approver's email, a subject's name quoted in a
   * refusal — as not-customer-data, which is the exact silence ADR 0034 built the enumeration against.
   *
   * Probe 4 is what finds them. `CREDENTIAL_COLUMN_PATTERN` matches `(^|_)sha256(_|$)`, so
   * `content_sha256` reads to the probe like a token hash, and the probe is right to look: a column called
   * `<something>_sha256` usually IS a credential. These are not. Each is the digest of PUBLISHED PAGE
   * COPY — the anchor of the chain that ties a lint pass to an approval to a publication — and the pages
   * it hashes are the salon's own marketing, linted precisely so that they say nothing about any
   * individual. A customer cannot appear in one, because migration 0093 refuses the publication of copy
   * the profile's lexicon rejects and `PROVIDER_TITLES` refuses a named person on published copy at all
   * (B-CAT-05).
   *
   * They are also append-only for every role including the owner (ZZ001), so `not_customer_data` is the
   * only action the database would accept here even if the classification were wrong.
   */
  rule({
    key: 'public.publication_lint_pass.content_sha256',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'The sha256 of the page copy a lint pass examined. Found by probe 4 because the name ends `_sha256`, ' +
      'which usually means a credential; this one is a digest of the salon’s own published marketing and ' +
      'holds nothing about any individual. Append-only (ZZ001), so nothing could be done to it anyway.',
    registeredBy: 'W-SITE-10',
  }),
  rule({
    key: 'public.publication_approval.content_sha256',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'The same digest, on the row recording which named STAFF member approved that copy. The approver is ' +
      'an employee and is P-HR-01’s subject, not this CRM’s; the column itself is a hash of page copy.',
    registeredBy: 'W-SITE-10',
  }),
  rule({
    key: 'public.publication_record.content_sha256',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'The same digest again, on the publication ledger. It is the evidence of what was live on a given ' +
      'date, which is a fact about the site and not about a person.',
    registeredBy: 'W-SITE-10',
  }),

  /**
   * Two later digests probe 4 finds by the same name family, and they do NOT land the same way.
   *
   * `CREDENTIAL_COLUMN_PATTERN` matched both the moment their tables arrived, and both went unclassified
   * until `rights.itest.ts` refused a whole erasure over them — which is ADR 0034 working: an unclassified
   * column stops the erasure rather than being quietly passed over. What the two need is different, and
   * lumping them together as "another hash, not customer data" is the classification this comment exists to
   * refuse.
   */
  rule({
    key: 'public.private_document.content_sha256',
    dataClass: 'operational',
    action: 'retain_append_only',
    why:
      'The sha256 of the bytes of a filed document (0101). `private_document` refuses UPDATE and DELETE ' +
      'for every role including the owner, so neither a redaction nor a deletion of this column is ' +
      'available — the retention is structural before it is a policy. It is also the right answer: the ' +
      'register exists so that "what private documents exist" is a SELECT rather than a survey of five ' +
      'producers, and a digest is what says which BYTES an object is. It is not what says who the object ' +
      'is about — `subject_kind` and `subject_id` are, and they are a polymorphic pair with no foreign ' +
      'key, so no probe’s column-name pattern reaches them. That is stated here because the reader of ' +
      'this rule is the one most likely to need it.',
    subjectReason:
      'The register of which private documents this business holds — a class, a storage key, a size and a ' +
      'hash of the bytes — is append-only and outlives the erasure of the person a document is about. It ' +
      'carries no name, no contact detail and none of the content itself.',
    registeredBy: 'W-SYS-14',
  }),
  rule({
    key: 'public.wps_export.file_sha256',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'The sha256 of the salary-information file submitted for a payroll run (0104), found by probe 4 on ' +
      'the `_sha256` family. The subject of a WPS export is the EMPLOYEE — P-HR-01’s subject, not this ' +
      'CRM’s customer — which is the same direction as `publication_approval.content_sha256` above. ' +
      '`wps_export` is append-only for every role including the owner (ZY144) and the application role ' +
      'holds no UPDATE or DELETE on it, so nothing could be done here even if the classification were ' +
      'wrong.',
    registeredBy: 'P-HR-12',
  }),
  rule({
    key: 'public.google_connections.*',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'The business’s own OAuth material and the Google account it connected. `google_email` is a ' +
      'staff or owner mailbox, not a data subject of this CRM, and the ten token columns are the ' +
      'business’s credentials. An erasure that touched these would disconnect the salon’s own ' +
      'integration.',
    registeredBy: 'C-CRM-10',
  }),

  // --- records held FOR the subject: these must survive ------------------------------------------
  rule({
    key: 'public.suppression.key_hmac',
    dataClass: 'suppression_record',
    action: 'retain_for_subject',
    why:
      'The single most important retention in this unit, and the one an erasure most easily gets ' +
      'backwards. This column is an HMAC of the recipient and holds no number, so keeping it discloses ' +
      'nothing; deleting it would make the person MESSAGEABLE AGAIN — re-import the same number ' +
      'from a spreadsheet and a fresh customer record is created with a clean sheet. The list is keyed ' +
      'on the hashed detail rather than on a contact (0064) precisely so it outlives the identity, and ' +
      'the erasure WRITES one if none exists (source `erasure_request`), because somebody who never ' +
      'opted out has no entry to preserve. The lawful basis is the subject’s own objection, which ' +
      'an erasure request necessarily includes.',
    subjectReason:
      'We keep a one-way cryptographic fingerprint of your phone number so that our systems refuse to ' +
      'contact you, even if your number is later re-entered from another source. It cannot be reversed ' +
      'into your number, and it exists only to stop us reaching you.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.suppression.contact_customer_id',
    dataClass: 'suppression_record',
    action: 'retain_for_subject',
    why:
      'The back-reference saying which record an entry is about. Retained because the row is, and because ' +
      'it points at a record that no longer holds a contact detail — so it identifies nobody on its ' +
      'own. Nulling it would also be refused: 0064 makes this table append-only for every role (ZQ001).',
    subjectReason:
      'We keep the link between that fingerprint and the erased record so that we can show why a ' +
      'message was refused. It identifies nobody on its own, because the record it points to no longer ' +
      'holds any contact details.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.customer_blocklist.customer_id',
    dataClass: 'suppression_record',
    action: 'retain_legitimate_interest',
    why:
      'The hardest retention in this unit after the tax invoice, and the only one with no statute behind ' +
      'it. A blocklist entry is the business refusing service to somebody — abuse, threats, repeated ' +
      'no-shows — and deleting it on an erasure request would make a privacy right A MECHANISM FOR ' +
      'CLEARING A SAFETY BLOCK: ask to be forgotten, walk back in under a fresh record. The ground is the ' +
      'business’s own legitimate interest in refusing service, which is a different basis from ' +
      '`suppression`’s and is why it carries its own action rather than being folded in with the ' +
      'retentions that are FOR the subject.',
    subjectReason:
      'We keep our record that service was declined. Removing it on request would allow the decision to ' +
      'be reversed simply by asking, and the decision was made for the safety of our staff and clients.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.customer_blocklist.key_value',
    dataClass: 'suppression_record',
    action: 'retain_legitimate_interest',
    why:
      'This column holds the NORMALISED PLAINTEXT — an E.164 number or a lower-cased address, ' +
      'checked by 0053’s own shape constraints — and not a hash, so a completed erasure leaves ' +
      'a readable phone number here. That is worth stating flatly because the merge registry says the ' +
      'opposite: `merge-participants.ts`’s entry for this table claims 0053 "matches a blocklist ' +
      'entry on the hashed DETAIL", which is true of `suppression.key_hmac` and not of this column. The ' +
      'match is on the plaintext by design — 0053’s header says so — because the front ' +
      'desk has to be able to see WHICH number is blocked in order to review the block. Retained for the ' +
      'reason above; it is not a reachability path, because the list is read to REFUSE and no send path ' +
      'reads it to resolve a recipient, and a re-import of the same number is refused by both this entry ' +
      'and the suppression one.',
    subjectReason:
      'The number itself is kept on that record so our staff can see which number the decision applies ' +
      'to and review it. It is never used to contact anybody: the list is only ever read in order to ' +
      'refuse a booking.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.optout_grant.contact_customer_id',
    dataClass: 'suppression_record',
    action: 'retain_for_subject',
    why:
      'The one credential an erasure must not revoke. 0064 puts the contact in the opt-out URL as well as ' +
      'the token and refuses the request unless the two agree, so revoking the grant would make a link ' +
      'ALREADY IN SOMEBODY’S HAND stop working — and a link that has stopped working is an ' +
      'opt-out this business does not have. It resolves to the record either way and the suppression it ' +
      'writes keys on the hashed detail, so it keeps working for a re-imported number too.',
    subjectReason:
      'We keep the unsubscribe link we sent you working. Removing it would break a link already in your ' +
      'possession, which would take away a way of opting out that you currently have.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.customer_therapist_do_not_pair.customer_id',
    dataClass: 'suppression_record',
    action: 'retain_for_subject',
    why:
      'A request never to be paired with a named therapist — a safety and comfort decision made by ' +
      'the subject. Retained for the same reason the blocklist is: if the person returns under a new ' +
      'record the exclusion should still be findable, and dropping it on an erasure would put somebody ' +
      'back with a therapist they asked not to see. It identifies nobody by itself once the customer ' +
      'row is pseudonymised.',
    subjectReason:
      'We keep your request never to be seen by a particular therapist. It is kept so the request is ' +
      'still honoured if you return, and it holds no contact details.',
    registeredBy: 'C-CRM-10',
  }),

  // --- consent: the append-only log ---------------------------------------------------------------
  rule({
    key: 'public.consent.contact_customer_id',
    dataClass: 'consent_record',
    action: 'retain_append_only',
    why:
      'Append-only for every role including the owner (0056, ZP003), so neither an UPDATE nor a DELETE ' +
      'is available here — the retention is structural before it is a policy. It is also correct: ' +
      'the log is the only evidence of what this business was permitted to do and when it stopped being ' +
      'permitted, it is what a complaint about a past send is answered with, and 0056’s own header ' +
      'says the record has to outlive the erasure of the identity it is about. It carries an id and a ' +
      'purpose, never a contact detail.',
    subjectReason:
      'We keep the record of what you agreed to and when, and of when you withdrew it. It is the only ' +
      'evidence of what we were permitted to do, it is how we answer any question about a message we ' +
      'sent, and the law requires us to be able to demonstrate consent. It holds no contact details.',
    registeredBy: 'C-CRM-10',
  }),

  // --- operational: rows whose only customer content is the reference ----------------------------
  rule({
    key: 'public.booking.customer_id',
    dataClass: 'operational',
    action: 'inherits_parent',
    parent: 'public.customer.phone_e164',
    why:
      'The reference stays and points at a pseudonymised record, which is what pseudonymisation MEANS: ' +
      'the history stays joinable and stops being attributable. Re-pointing it at nothing would orphan ' +
      'the appointments the diary and the invoices are built from, and a booking carries no contact ' +
      'detail of its own — the send path resolves the recipient from `customer`, which no longer ' +
      'has one. Deleting it is also refused: `invoice` references the appointment chain and the ' +
      'financial record must be kept.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.waitlist.customer_id',
    dataClass: 'operational',
    action: 'delete_row',
    why:
      'The exception among the operational tables, and the reason it differs is that a waitlist entry is ' +
      'FORWARD-LOOKING: it is a standing instruction to contact this person when a slot opens. Left in ' +
      'place it is an outbound message waiting to happen, which is precisely what a completed erasure ' +
      'must make impossible. Nothing references it and it is not evidence of anything that happened.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.flow_enrolment.customer_id',
    dataClass: 'operational',
    action: 'delete_row',
    why:
      '`waitlist`’s case and the more dangerous one: an enrolment is a live automation that goes on ' +
      'sending. The suppression list would refuse each send, but a completed erasure should not leave a ' +
      'sequence running against the person and relying on a downstream gate to stop it every time.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.customer_preference.customer_id',
    dataClass: 'operational',
    action: 'delete_row',
    why:
      'Preferred therapist, room, pressure, language — held only to serve this person, of no value ' +
      'once there is nobody to serve, and it is the closest thing in the schema to a profile. One row ' +
      'per customer, `ON DELETE CASCADE`, referenced by nothing.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.customer_tag.customer_id',
    dataClass: 'operational',
    action: 'delete_row',
    why:
      'Staff-applied labels about a person. They are opinions held about a data subject with no ' +
      'operational or statutory purpose once the record is erased, and a retained tag on a pseudonymised ' +
      'record is the kind of residue that makes a pseudonym re-identifiable.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.customer_pipeline_card.customer_id',
    dataClass: 'operational',
    action: 'delete_row',
    why:
      'A card is where a human PUT somebody on a sales board. An erased record must not be draggable, ' +
      'and `readPipelineBoard` would otherwise draw a pseudonym in a column. The transitions the card ' +
      'produced are a separate, append-only matter — see `pipeline_stage_transition` below.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.package_sale.customer_id',
    dataClass: 'financial',
    action: 'retain_statutory',
    obligationColumn: 'financial_retention_years',
    why:
      'Money the customer handed over and treatments the salon owes, posted to the ledger as deferred ' +
      'revenue: it is part of the financial record the retention obligation covers, and it is joined to ' +
      'a journal entry that cannot be rewritten. Classified `financial` rather than `operational` for ' +
      'that reason, although the merge treats it as a re-pointable row — the two units ask ' +
      'different questions of the same table.',
    subjectReason:
      'We keep the record of treatments you paid for in advance, because it is part of our financial ' +
      'records and the tax authority requires those to be kept.',
    registeredBy: 'C-CRM-10',
  }),
  // --- the flow interpreter's two append-only tables (C-AUTO-07, 0091) -----------------------------
  rule({
    key: 'public.flow_node_effect.contact_customer_id',
    dataClass: 'operational',
    action: 'retain_append_only',
    why:
      'The idempotency token: THIS node of THIS run has already reached THIS contact. DELETE is refused ' +
      'for every role including the owner (0091, ZY012) and the application role holds `update ' +
      '(contact_customer_id)` and nothing more, so the retention is structural before it is a policy. It ' +
      'is also the right answer in the same direction as `frequency_ledger`: removing the tokens would ' +
      'hand a re-created record a run with no history, and the next tick would send every node the person ' +
      'had already received. `flow_enrolment.customer_id` is a `delete_row` beside this one and that is ' +
      'what stops the sequence — the token is the record that it already ran, not a reason to run it ' +
      'again. The row holds a run id, a node id, a channel and an instant; never a contact detail.',
    subjectReason:
      'We keep a record that each step of an automated message sequence had already reached you. It holds ' +
      'no contact details, and it is what stops a re-created record being sent the same messages again.',
    registeredBy: 'C-AUTO-07',
  }),
  rule({
    key: 'public.flow_step_log.contact_customer_id',
    dataClass: 'audit',
    action: 'retain_append_only',
    why:
      'The answer to "why did this contact receive this message", in one row: the flow, the pinned ' +
      'document version, the node, the consent record the send was gated on, the gate decision and the ' +
      'outcome. Append-only for every role including the owner (0091, ZY011) and the application role ' +
      'holds no UPDATE privilege on it, so there is no statement an erasure could issue — but the ' +
      'structural half is not the argument. The argument is `consent`\u2019s, one step further on: the ' +
      'consent log says what we were permitted to do and this says what we then did with that permission, ' +
      'and a complaint about a past message is answered from the two together. Erasing it would leave the ' +
      'consent record and destroy the evidence of what was sent under it. It carries ids, a decision and ' +
      'an instant; the recipient address lives on `message.recipient`, which is redacted.',
    subjectReason:
      'We keep the record of which automated messages were sent to you, when, and what permission each ' +
      'one was sent under. It holds no contact details, and it is how we answer any question or complaint ' +
      'about a message you received.',
    registeredBy: 'C-AUTO-07',
  }),
  rule({
    key: 'public.frequency_ledger.contact_customer_id',
    dataClass: 'operational',
    action: 'retain_append_only',
    why:
      'One row per promotional message counted against the rolling cap. Retained, and the direction is ' +
      'worth stating: deleting these rows would hand a re-imported record a FRESH ALLOWANCE, so an ' +
      'erasure would become a way to message somebody past the cap. The row holds a message id and an ' +
      'instant, never a recipient — the address lives on `message.recipient`, which is redacted.',
    subjectReason:
      'We keep a count of the marketing messages sent to you. It holds no contact details, and it is ' +
      'what stops a re-created record being sent a fresh allowance of messages.',
    registeredBy: 'C-CRM-10',
  }),

  // --- financial: the documents a regulator reads ------------------------------------------------
  rule({
    key: 'public.imported_package_sale.package_sale_id',
    dataClass: 'financial',
    action: 'inherits_parent',
    parent: 'public.package_sale.customer_id',
    why:
      'The reconstruction record points at the `package_sale` H-MIG-03 wrote from it. It carries no identity ' +
      'of its own — the holder is named by the sale, not by this row — so the column is a pointer at a sale ' +
      'whose own rule decides the matter, and a second answer beside it would be a second answer about one ' +
      'package. Classified at all because the foreign-key child probe finds it and ADR 0034 refuses an ' +
      'erasure over an unclassified column: 0119 landing made six of `rights.itest.ts`\u2019s cases fail, ' +
      'which is the probe working rather than a gap in it — the fourth time a new migration has been caught ' +
      'this way and the fourth time the catch was correct.',
    registeredBy: 'H-MIG-03',
  }),
  rule({
    key: 'public.commission_line.invoice_id',
    dataClass: 'financial',
    action: 'inherits_parent',
    parent: 'public.invoice.customer_id',
    why:
      'A commission line points at the invoice the commission was earned on. It carries no identity of its ' +
      'own — the employee is named by `staff_reference` and the customer appears nowhere on the row — so the ' +
      'column is a pointer at a document whose own rule decides the matter, which is what ' +
      '`inherits_parent` means here: whatever happens to `public.invoice.customer_id` happens to this, and ' +
      'a second answer beside it would be a second answer about one invoice. It is classified at all ' +
      "because the catalogue's foreign-key child probe finds it and the erasure REFUSES to run with an " +
      "unclassified column (ADR 0034) — it was P-HR-11 landing 0097 that made nine of this suite's cases " +
      'fail, which is the probe working rather than a gap in it.',
    registeredBy: 'P-HR-11',
  }),
  rule({
    key: 'public.invoice.customer_id',
    dataClass: 'financial',
    action: 'retain_statutory',
    obligationColumn: 'financial_retention_years',
    why:
      'docs/04 §4 states the conflict and its resolution in as many words: five-year record retention ' +
      'conflicts with erasure, and erasure anonymises the CRM identity and RETAINS the financial record ' +
      'under the statutory obligation, recording the conflict and the reason. Structurally there is no ' +
      'alternative either — an issued invoice is append-only (`invoice_no_update` raises) and the ' +
      'application role holds no UPDATE privilege on it. The years figure is read from ' +
      '`regulatory_profile_current.financial_retention_years` and never written as a literal, so a past ' +
      'decision stays explainable after the profile changes.',
    subjectReason:
      'We keep the tax invoices issued to you. The tax authority requires invoices to be kept for a set ' +
      'period and they may not be altered after they are issued.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.invoice.customer_phone',
    dataClass: 'financial',
    action: 'retain_statutory',
    obligationColumn: 'financial_retention_years',
    why:
      'The hardest thing in this unit to state honestly: a completed erasure LEAVES A PHONE NUMBER HERE, ' +
      'in the clear. The FTA requires customer details on a tax invoice and the document may not be ' +
      'edited, so the number is retained by obligation rather than by oversight. What makes that ' +
      'survivable is that it is not a reachability path: nothing in the send path reads an invoice to ' +
      'resolve a recipient — it resolves from `customer`, which now holds a pseudonym — and if ' +
      'the number were re-entered by hand the suppression entry refuses the send at `evaluateGate` ' +
      'before any transport sees it. This is exactly why acceptance line four asks for that to be proved ' +
      'THROUGH THE GATE rather than by inspecting a table.',
    subjectReason:
      'Your telephone number stays on any tax invoice issued to you, because the invoice must record ' +
      'the customer it was issued to and may not be altered. It is not used to contact you: our systems ' +
      'resolve contact details from your record, which no longer holds any.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.invoice.customer_address_snapshot',
    dataClass: 'financial',
    action: 'retain_statutory',
    obligationColumn: 'financial_retention_years',
    why: '`customer_phone`’s case for the address the invoice was issued to.',
    subjectReason:
      'Your address stays on any tax invoice issued to you, for the same reason as your telephone ' +
      'number: the invoice records who it was issued to and may not be altered.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.invoice.customer_name_snapshot',
    dataClass: 'financial',
    action: 'retain_statutory',
    obligationColumn: 'financial_retention_years',
    why:
      'The customer’s NAME as the document was issued, and the second thing a completed erasure ' +
      'leaves readable. docs/04 §4 names customer details among the mandatory tax-invoice contents, so ' +
      'this is the document saying who it was issued to, and an invoice whose addressee was erased is not ' +
      'the document that was filed. The merge registry makes the same argument for the same column from ' +
      'the other direction: a re-attributed invoice is a different document.',
    subjectReason:
      'Your name stays on any tax invoice issued to you. The invoice must record the customer it was ' +
      'issued to, and an invoice whose customer had been removed would no longer be the document that ' +
      'was filed.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.invoice.customer_trn',
    dataClass: 'financial',
    action: 'retain_statutory',
    obligationColumn: 'financial_retention_years',
    why:
      'The customer’s tax registration number where they gave one — a business identifier the ' +
      'FTA requires on a B2B tax invoice, and the number the counterparty recovers input VAT against. ' +
      'Erasing it would break the other party’s return as well as this one’s.',
    subjectReason:
      'Your tax registration number stays on any invoice that carries it, because it is a required part ' +
      'of a business-to-business tax invoice and your own tax return is filed against it.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.credit_note.customer_name_snapshot',
    dataClass: 'financial',
    action: 'retain_statutory',
    obligationColumn: 'financial_retention_years',
    why: '`invoice.customer_name_snapshot`’s case on the correcting document.',
    subjectReason:
      'Your name stays on any credit note issued to you, because the document records the customer it ' +
      'was issued to and may not be altered.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.credit_note.customer_trn',
    dataClass: 'financial',
    action: 'retain_statutory',
    obligationColumn: 'financial_retention_years',
    why: '`invoice.customer_trn`’s case on the correcting document.',
    subjectReason:
      'Your tax registration number stays on any credit note that carries it, for the same reason as on ' +
      'the invoice it corrects.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.credit_note.customer_id',
    dataClass: 'financial',
    action: 'retain_statutory',
    obligationColumn: 'financial_retention_years',
    why:
      '`invoice`’s case for the document that corrects one. Append-only (ZD009 for every role), ' +
      'filed with the same return, and a correction that could be erased while the invoice it corrects ' +
      'is kept would leave the record saying the wrong thing.',
    subjectReason:
      'We keep any credit note issued to you, for the same reason as the invoice it corrects: the tax ' +
      'authority requires it to be kept and it may not be altered.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.credit_note.customer_phone',
    dataClass: 'financial',
    action: 'retain_statutory',
    obligationColumn: 'financial_retention_years',
    why: '`invoice.customer_phone`’s case, on the correcting document.',
    subjectReason:
      'Your telephone number stays on any credit note issued to you, because the document records the ' +
      'customer it was issued to and may not be altered.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.credit_note.customer_address_snapshot',
    dataClass: 'financial',
    action: 'retain_statutory',
    obligationColumn: 'financial_retention_years',
    why: '`invoice.customer_address_snapshot`’s case, on the correcting document.',
    subjectReason:
      'Your address stays on any credit note issued to you, because the document records the customer ' +
      'it was issued to and may not be altered.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.checkout_finalisation.customer_id',
    dataClass: 'financial',
    action: 'retain_statutory',
    obligationColumn: 'financial_retention_years',
    why:
      'The till’s idempotency claim over a completed sale. 0063 revokes UPDATE and DELETE from the ' +
      'application role: editing it would change the history of a drawer that has already been counted ' +
      'and reconciled.',
    subjectReason:
      'We keep the record of a completed sale at the till. It is part of the day-end cash ' +
      'reconciliation and of our financial records, and it cannot be changed once the drawer has been ' +
      'counted.',
    registeredBy: 'C-CRM-10',
  }),

  // --- audit: the evidence that any of this happened ---------------------------------------------
  rule({
    key: 'public.pipeline_stage_transition.customer_id',
    dataClass: 'audit',
    action: 'retain_append_only',
    why:
      'A transition says a NAMED STAFF ACTOR moved this record between columns at an instant. Append-only ' +
      'for every role including the owner (0077, ZU009) and the application role holds no UPDATE, DELETE ' +
      'or TRUNCATE, so an erasure — an application operation — cannot reach it. What the row ' +
      'says happened does not stop being true, and it names a member of staff as much as a customer.',
    subjectReason:
      'We keep the log of when a member of staff moved your record between stages on our internal ' +
      'board. It records what our staff did and when, it names them as well as your record, and it ' +
      'cannot be altered.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.merge_record.survivor_customer_id',
    dataClass: 'audit',
    action: 'retain_append_only',
    why:
      'The tombstone. Append-only for every role (ZT005), and `merge_survivor_of()` follows the chain: ' +
      'erasing it would make a merged-away record unanswerable and would hide that two records were ever ' +
      'one person — which is the fact an erasure of the survivor most needs to be able to see.',
    subjectReason:
      'We keep the record that two of our entries turned out to be the same person. Without it we could ' +
      'not explain why an older reference now points to your current record.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.merge_record.loser_customer_id',
    dataClass: 'audit',
    action: 'retain_append_only',
    why:
      'The tombstone’s own id, UNIQUE and append-only (ZT005). Also the mechanism by which an ' +
      'erasure must cover BOTH records: a request naming the survivor has to erase the identity of every ' +
      'record merged into it, and this column is how they are found.',
    subjectReason:
      'We keep the record of which entry was merged away. It is how a request about you reaches every ' +
      'entry we ever held, including the ones that were joined together.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.merge_record.phone_agreement',
    dataClass: 'audit',
    action: 'not_customer_data',
    why:
      'Caught by the contact-detail probe on its name and checked rather than assumed: the column holds ' +
      'one of six LABELS (`identical`, `one_digit_apart`, `digits_transposed`, `one_digit_shifted`, ' +
      '`different`, `unknown`) describing how two numbers compared. It has never held a number.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.audit_event.ip_address',
    dataClass: 'audit',
    action: 'retain_append_only',
    why:
      'Append-only by rules in 0005 and partitioned so retention is a DETACH rather than a delete. An ' +
      'address recorded against an action is the evidence of who did it, including the evidence that ' +
      'this erasure was performed — a trail an erasure could edit is not a trail. Almost every row ' +
      'is a STAFF session rather than a customer one.',
    subjectReason:
      'We keep our security log of who did what and when, including the record of carrying out your own ' +
      'request. A log that could be edited would not be a log, and almost every entry in it is one of ' +
      'our own staff rather than a client.',
    registeredBy: 'C-CRM-10',
  }),

  // --- clinical: read the profile, do not choose --------------------------------------------------
  rule({
    key: 'clinical.intake_submission.customer_id',
    dataClass: 'clinical',
    action: 'crypto_erase',
    why:
      'The ciphertext and the row stay byte-identical and the WRAPPED DATA KEY is destroyed, so the ' +
      'content becomes unreadable while the fact of the submission, its template version, its consent ' +
      'hash, its capture instant and its `retain_until` all remain answerable. Nothing else is available: ' +
      '0009 revokes every privilege on this schema from the application role, 0043’s ZK002 freezes ' +
      'every column but the wrapped key, and the AAD binds the ciphertext to the customer id so the row ' +
      'cannot be re-pointed either. **This action is conditional** — see `planClinicalErasure`, ' +
      'which refuses it for a `real` payload while `erasure_overrides_retention` is false.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'clinical.treatment_note.customer_id',
    dataClass: 'clinical',
    action: 'crypto_erase',
    why: '`intake_submission`’s case for a note written after a treatment. Same key, same refusals.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'clinical.treatment_consent.customer_id',
    dataClass: 'clinical',
    action: 'retain_statutory',
    obligationColumn: 'clinical_retention_years',
    why:
      'The consent that authorised the clinical processing, kept beside the data it authorises. It holds ' +
      'no health CONTENT — a wording hash, a locale, how it was captured, whether a signature was ' +
      'present — so retaining it discloses nothing about the person’s health, and it is the ' +
      'only evidence that the destroyed submissions were lawfully taken. Destroying the record of ' +
      'consent while keeping the record that data was processed is the worst of both.',
    subjectReason:
      'We keep the record that you consented to a health questionnaire being taken, and which wording ' +
      'you were shown. It contains no health information at all, and it is the only evidence that the ' +
      'information we destroyed had been taken lawfully.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'clinical.contraindication_flag.customer_id',
    dataClass: 'clinical',
    action: 'delete_row',
    why:
      'The one clinical table with no ciphertext: five booleans derived from a submission, and the only ' +
      'clinical data that crosses the boundary into a booking decision. Crypto-erasure cannot apply — ' +
      'there is no key — and leaving it would keep "this person requires consultation" readable after the ' +
      'submission it came from had been destroyed, which is a health assertion with no evidence behind ' +
      'it. Deleted through the same SECURITY DEFINER function, since the application role cannot reach ' +
      'the schema.',
    registeredBy: 'C-CRM-10',
  }),

  // --- foreign-key children: whatever happened to the parent ------------------------------------
  rule({
    key: 'public.appointment.*',
    dataClass: 'operational',
    action: 'inherits_parent',
    parent: 'public.booking',
    why:
      'No customer reference and no contact detail of its own: an appointment is found through its ' +
      'booking, which is pseudonymised by reference. It is also the row an invoice line points at, so it ' +
      'is covered by the financial retention from the other direction.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.booking_idempotency.*',
    dataClass: 'operational',
    action: 'inherits_parent',
    parent: 'public.booking',
    why:
      'A request fingerprint keyed to a booking. It holds a hash of the request rather than its content, ' +
      'and it follows the booking.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.invoice_line.*',
    dataClass: 'financial',
    action: 'inherits_parent',
    parent: 'public.invoice',
    why: 'Retained with the invoice it belongs to, and append-only for the same reason.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.invoice_appointment.*',
    dataClass: 'financial',
    action: 'inherits_parent',
    parent: 'public.invoice',
    why: 'The join from an invoice to what was delivered. Retained with the invoice.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.credit_note_line.*',
    dataClass: 'financial',
    action: 'inherits_parent',
    parent: 'public.credit_note',
    why:
      'Retained with the credit note it belongs to, and append-only for the same reason: a line removed ' +
      'from a filed correction would change what the document says was corrected.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.payment.*',
    dataClass: 'financial',
    action: 'inherits_parent',
    parent: 'public.invoice',
    why: 'A receipt against an invoice. Part of the financial record and posted to the ledger.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.refund.*',
    dataClass: 'financial',
    action: 'inherits_parent',
    parent: 'public.credit_note',
    why: 'A refund against a credit note. Part of the same filed correction.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.package_balance.*',
    dataClass: 'financial',
    action: 'inherits_parent',
    parent: 'public.package_sale',
    why:
      'Carries no customer id and hangs off the sale, so it follows it — the same statement the ' +
      'merge registry makes about this table, and it has to be the same or the two units disagree about ' +
      'one row.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.merge_record_table.*',
    dataClass: 'audit',
    action: 'inherits_parent',
    parent: 'public.merge_record',
    why: 'The per-table report of one merge. Append-only with its parent (ZT005).',
    registeredBy: 'C-CRM-10',
  }),

  // --- this unit's own tables, which are themselves subject-scoped --------------------------------
  //
  // An erasure engine that did not classify its own tables would be the exact omission it exists to
  // prevent, and the probe finds them whether or not anybody remembers: `rights_request` carries a
  // subject id, so it is a subject-scoped table and its foreign-key children are probed too.
  rule({
    key: 'public.rights_request.subject_customer_id',
    dataClass: 'audit',
    action: 'retain_append_only',
    why:
      'The request is the evidence that a right was exercised and answered within its deadline, so it has ' +
      'to outlive the record it was about — a subject who later disputes the answer has nothing else ' +
      'to point at, and neither does a regulator. DELETE raises for every role (ZY001) and the columns an ' +
      'SLA is measured against are frozen (ZY002). It holds a uuid, a type, two instants and a stated ' +
      'reason; no contact detail reaches it, which is why `request_detail` is the subject’s words ' +
      'about what they want rather than their details.',
    subjectReason:
      'We keep the record of your request, when it arrived and when it was answered. It is the evidence ' +
      'that we answered you within the time allowed, and it is what you or a regulator would need if ' +
      'you disagreed with how it was handled.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.rights_resolution.*',
    dataClass: 'audit',
    action: 'inherits_parent',
    parent: 'public.rights_request',
    why:
      'The resolution and its per-class accounting. Append-only for every role (ZY004) and retained with ' +
      'the request: it is the row that says what was retained and on what basis, so erasing it would ' +
      'destroy the reasons this engine exists to record.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.rights_export.*',
    dataClass: 'audit',
    action: 'inherits_parent',
    parent: 'public.rights_request',
    why:
      'The export log. Append-only (ZY004), and it is the insider-threat trail — a record that could ' +
      'be erased on request would let somebody who exported the client list have the evidence removed.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.legal_hold.subject_customer_id',
    dataClass: 'audit',
    action: 'retain_append_only',
    why:
      'A hold is somebody’s decision that a subject’s rows are needed for a dispute or an ' +
      'investigation. A live hold must outlast an erasure request or the hold means nothing, and a lifted ' +
      'one is the record of a decision that was taken. Retained; the row holds a uuid and a stated reason.',
    subjectReason:
      'We keep the record of any instruction that data must be preserved for a dispute or an ' +
      'investigation, and of when that instruction was lifted.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'clinical.dek_destruction.customer_id',
    dataClass: 'clinical',
    action: 'retain_append_only',
    why:
      'The record that this person’s health data was destroyed and on whose authority. It has to ' +
      'outlive every other trace of the data it is about, which is the one retention in this unit that is ' +
      'a DIRECT consequence of the erasure rather than something surviving it. Append-only for every role ' +
      '(ZY005). It holds two uuids, an instant and a KEK version label — no health content and no ' +
      'contact detail.',
    subjectReason:
      'We keep the record that your health information was destroyed, when, and under which request. It ' +
      'has to outlive the information itself, or we could not show that your request was carried out.',
    registeredBy: 'C-CRM-10',
  }),

  // --- not customer data at all -----------------------------------------------------------------
  rule({
    key: 'public.staff_credential.*',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'A member of staff’s sign-in, not a data subject of the CRM — the same decision ' +
      '`public.employee.display_name` records one entry below, for the table W-SYS-11 added to hold what ' +
      'that person signs in with. A customer’s erasure request has nothing to erase here: the row holds ' +
      'an employee id, a role, a scrypt hash and a TOTP seed, and no customer ever appears in it. ' +
      'Reached by the CREDENTIAL probe on `totp_secret`, which is exactly why the entry has to exist: ' +
      'the probe is right to find a credential column and the answer is that it is not the subject’s. ' +
      'Staff records have their own retention under the labour obligations in docs/04 §7, and revoking ' +
      'access is `delete from staff_credential` (docs/runbooks/admin-access.md), which is an offboarding ' +
      'rather than an erasure.',
    registeredBy: 'W-SYS-11',
  }),
  rule({
    key: 'public.staff_session.*',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'The admin session a member of STAFF holds, not a data subject’s. Reached by the credential probe on ' +
      '`token_hash`. It cannot inherit a parent the way `booking_session.token_hash` does, and that ' +
      'contrast is the point: a booking session belongs to a customer and is deleted with them, while ' +
      'this one belongs to an employee and no customer erasure should touch it. Sessions end through ' +
      'their own lifecycle — expiry, sign-out, or the CASCADE from `staff_credential` when access is ' +
      'revoked.',
    registeredBy: 'W-SYS-11',
  }),
  rule({
    key: 'public.employee.display_name',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'A member of staff, not a data subject of the CRM. Staff records have their own retention under the ' +
      'labour obligations in docs/04 §7 and are not touched by a customer’s request. The probe ' +
      'catches it on the column name, and the entry is here so that "it is staff data" is a decision ' +
      'somebody made rather than a table nobody looked at.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.premises.*',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'The salon’s own name, address, landline, mobile, WhatsApp number and email — the NAP the ' +
      'public site publishes. Erasing one would take the business off its own website.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.service.public_display_name',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'A treatment’s published name, shown on the public site. Caught by the contact probe on the ' +
      'display-name family of column names, and it is the catalogue rather than a person.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.package_template_version.public_display_name',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'A package’s published name, shown at checkout and on the site. The versioned row is the ' +
      'catalogue’s own history and holds nobody’s data.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.agent_definition.display_name',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why: 'An automation agent’s label, e.g. the SEO agent. Not a person at all.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.google_reviews.reviewer_display_name',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'The name Google publishes beside a public review, mirrored from Google’s API. It is not held ' +
      'under this business’s CRM identity, it is not joinable to a customer record, and it is ' +
      'PUBLISHED by the platform — erasing the local mirror would neither remove it from Google nor ' +
      'make the review answerable. A reviewer exercising a right does so against Google. The absence of ' +
      'a join is what makes this true, and it is checked: there is no customer id on this table.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.google_reviews.reply_lint_content_sha256',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'The sha256 of the REPLY text a lint pass examined before that reply was delivered (0113, G-REV-05), ' +
      'found by probe 4 on the `_sha256` column-name family. The reply is this business’s own public words, ' +
      'not the reviewer’s: G-REV-05’s linter carries a quote-back rule precisely so that a reply cannot ' +
      'repeat what the customer wrote, and `reviewer_display_name` above records why nothing on this table ' +
      'is joinable to a customer record in the first place. The digest exists so that the stamp can be ' +
      'reproduced over the stored text — a reply whose hash no longer matches is a reply somebody edited ' +
      'after it was linted, which is the only thing this column is for.',
    registeredBy: 'G-REV-05',
  }),
  rule({
    key: 'public.review_intake_email.raw_body_sha256',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why:
      'The sha256 of a forwarded Google review notification (migration 0094), caught by the CREDENTIAL ' +
      'probe on the `_sha256` column-name family. It is a digest and not a credential: nothing resolves ' +
      'it, nothing authenticates against it, and it exists so a parsed intake row can be tied to the ' +
      'bytes it came from without holding a second copy of them. ' +
      'It is not customer data either, for the reason `google_reviews.reviewer_display_name` gives one ' +
      'entry along and on the same grounds: a review is left by a member of the public on a PUBLISHED ' +
      'Google listing, this table carries no customer id and no foreign key to one — checked, not ' +
      'assumed — and a reviewer exercising a right does so against Google. ' +
      'The `raw_body` column beside it is deliberately NOT named here, because no probe finds it and a ' +
      'rule for a column nobody probes would make this registry read as broader than it is. If a probe ' +
      'ever reaches it, the answer is the same one and it needs its own entry saying so.',
    registeredBy: 'G-REV-02',
  }),
  rule({
    key: 'public.invoice.issuer_phone',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why: 'The salon’s own number, snapshotted onto its own invoice. Required ON the document.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.invoice.issuer_address_snapshot',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why: 'The salon’s own address. Required on a tax invoice.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.invoice.issuer_address_snapshot_ar',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why: 'The Arabic rendering of the salon’s own address.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.credit_note.issuer_phone',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why: 'The salon’s own number on its own credit note.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.credit_note.issuer_address_snapshot',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why: 'The salon’s own address on its own credit note.',
    registeredBy: 'C-CRM-10',
  }),
  rule({
    key: 'public.credit_note.issuer_address_snapshot_ar',
    dataClass: 'not_customer_data',
    action: 'not_customer_data',
    why: 'The Arabic rendering of the salon’s own address on its own credit note.',
    registeredBy: 'C-CRM-10',
  }),

  // --- the migration's own records ---------------------------------------------------------------
  rule({
    key: 'public.imported_contact.contact_hmac',
    dataClass: 'operational',
    action: 'retain_append_only',
    why:
      'The record of what one line of a reconstructed contact list became (0121, H-MIG-04), found by ' +
      'the CREDENTIAL probe on the `_hmac` column-name family — and the column is named that way ON ' +
      'PURPOSE, so that this probe reaches it and an erasure cannot run until somebody classifies it. ' +
      'A column called `phone_digest` would have been invisible to all five probes, which is the exact ' +
      'accident Y9-import-ledger is about. ' +
      'It holds `HMAC-SHA256(json(number), SUPPRESSION_PEPPER)` and no number: 0064’s argument applies ' +
      'unchanged, so an unpeppered digest would be a phone number with extra steps and this one is not ' +
      'reversible without a secret the database does not hold. `imported_contact` refuses UPDATE and ' +
      'DELETE for every role including the owner (ZY272) and the application role holds neither ' +
      'privilege, so neither a redaction nor a deletion of this column is a statement an erasure could ' +
      'make — which is what `retain_append_only` says, and why it is not `retain_for_subject`: unlike ' +
      '`suppression.key_hmac`, nothing is kept here IN the subject’s interest. It is kept because it is ' +
      'the evidence that an import happened and what it did. ' +
      'The erasure is still COMPLETE in the sense that matters: the plaintext lives only in ' +
      '`customer.phone_e164`, which is pseudonymised one entry up, so after an erasure the digest ' +
      'cannot be recomputed from anything in this database and the row stops resolving to a person. ' +
      'That is the whole of H-MIG-04’s answer to Y9-import-ledger, and the reason the staging ledger ' +
      'stages this digest rather than the number it was computed over.',
    subjectReason:
      'We keep a one-way cryptographic fingerprint of the number that appeared on the contact list your ' +
      'record was created from, together with what we did with that line. It cannot be reversed into ' +
      'your number, and once your record is erased there is nothing left in our systems it can be ' +
      'matched against. We keep it so that we can always show where a record came from and that it was ' +
      'imported without any marketing consent.',
    registeredBy: 'H-MIG-04',
  }),
  rule({
    key: 'public.imported_appointment.contact_hmac',
    dataClass: 'operational',
    action: 'retain_append_only',
    why:
      'The record of what one line of a reconstructed VISIT HISTORY became (0130, H-MIG-05), found by ' +
      'the CREDENTIAL probe on the `_hmac` column-name family. Everything `imported_contact.contact_hmac` ' +
      'one entry up says applies unchanged, and it applies because this column is the same digest: ' +
      'H-MIG-05 keys the customer cell with the SAME pepper and the SAME two key kinds H-MIG-04 used, so ' +
      'a person’s visit record and their contact record join on this value. The name is deliberate for ' +
      'the same reason — a column called `customer_digest` would have been invisible to all five probes, ' +
      'which is the accident Y9-import-ledger is about. ' +
      '`retain_append_only` and not `retain_for_subject`: `imported_appointment` refuses UPDATE and ' +
      'DELETE for every role including the owner (ZY364) and the application role holds neither ' +
      'privilege, so neither a redaction nor a deletion of this column is a statement an erasure could ' +
      'make — and nothing is kept here in the subject’s interest. It is kept because it is the ' +
      'evidence that a visit was reconstructed and what could not be resolved about it. ' +
      'The erasure is still COMPLETE in the sense that matters, and for exactly H-MIG-04’s reason: ' +
      'the plaintext lives only in `customer.phone_e164`, which is pseudonymised, so after an erasure the ' +
      'digest cannot be recomputed from anything in this database and the row stops resolving to a ' +
      'person. The visit itself is in `appointment`, whose link to the person runs through ' +
      '`booking.customer_id` and is reached by probe 3.',
    subjectReason:
      'We keep a one-way cryptographic fingerprint of the number that appeared beside each visit in the ' +
      'records your history was reconstructed from, together with what we were able to resolve about ' +
      'that line. It cannot be reversed into your number, and once your record is erased there is ' +
      'nothing left in our systems it can be matched against. We keep it so that we can always show ' +
      'where a past appointment in your history came from.',
    registeredBy: 'H-MIG-05',
  }),
  /*
    H-MIG-03's column, classified here as COLLATERAL and not as this unit's work.

    `imported_package_sale.package_sale_id` is a foreign key to `package_sale`, which carries a customer
    id, so probe 3 enumerates it — and nothing classified it. That is not a latent tidiness problem: the
    engine REFUSES to run while any probed column is unclassified, so on the tree this unit started from
    C-CRM-10's erasure was non-functional for every subject, with `rights.itest.ts` red on the one case
    that reports it. The unit report carries the baseline proof.

    It is repaired here because H-MIG-04 cannot pass otherwise. This unit's own decision — that the
    plaintext number lives only in `customer.phone_e164` and that an erasure therefore reaches it — is only
    demonstrable by RUNNING an erasure, which is what `customer-import.itest.ts` does. Nothing else about
    0119, its registry entries or its suites was touched.
  */
  rule({
    key: 'public.imported_package_sale.*',
    dataClass: 'financial',
    action: 'retain_append_only',
    why:
      'What H-MIG-02’s workbook said about one reconstructed package, kept beside the `package_sale` it ' +
      'produced (0119, H-MIG-03). Found by probe 3 through `package_sale_id`, whose parent carries a ' +
      'customer id. ' +
      'Retained, and `retain_append_only` rather than `inherits_parent` because the two reasons are ' +
      'different and only one of them is about the parent: ZY255 refuses UPDATE and DELETE on this table ' +
      'for every role including the owner, so an erasure cannot act on it at all. The parent’s own rule ' +
      'is `retain_statutory` under the financial obligation, which this row is part of the evidence for — ' +
      'it is what an imported deferred-revenue balance rests on when it disagrees with what the owner ' +
      'believes, and `import_staging.entity_provenance` resolves it to the line of the file it was typed ' +
      'on. ' +
      'The wildcard covers the table because every column of it is one statement about the same ' +
      'reconstructed package and the same refusal applies to all of them; `holder_phone_e164` is the one ' +
      'worth noticing, and no probe reaches it today — probe 2 matches `phone_e164` exactly, not as a ' +
      'suffix. If a probe ever does, the answer is this one and it needs its own entry saying so.',
    subjectReason:
      'Where a prepaid package on your record came from: the line of the reconstructed list it was typed ' +
      'on, and what that line said. We are required to keep the records behind the balances in our ' +
      'accounts, and this is the evidence for one of them.',
    registeredBy: 'H-MIG-03',
  }),
])

// ------------------------------------------------------------------------------------------------
// Looking a rule up, and the refusal when there is none
// ------------------------------------------------------------------------------------------------

/**
 * One catalogue row: a column the database actually has, and which probe found it.
 *
 * Supplied by `packages/db`, never constructed here — `packages/core` may not read a database, and
 * that separation is what stops this file becoming the list of what exists.
 */
export interface ProbedColumn {
  readonly schema: string
  readonly table: string
  readonly column: string
  /** Which of the five probes found it. A column found by several carries them all. */
  readonly axes: readonly ErasureProbeAxis[]
}

export const ERASURE_PROBE_AXES = [
  'customer_reference',
  'contact_detail',
  'foreign_key_child',
  'credential',
  'free_text_note',
] as const
export type ErasureProbeAxis = (typeof ERASURE_PROBE_AXES)[number]

/**
 * The rule for a probed column: the exact key first, then the table wildcard.
 *
 * The wildcard exists so a table whose every probed column shares one argument is one entry rather than
 * eleven identical ones (`google_connections` has ten token columns). It is a fallback and never a
 * default: a table with NO entry of either kind resolves to `undefined`, which is what fails the test.
 */
export function ruleForColumn(probed: ProbedColumn): ErasureRule | undefined {
  const exact = ERASURE_RULES.get(`${probed.schema}.${probed.table}.${probed.column}`)
  if (exact !== undefined) return exact
  return ERASURE_RULES.get(`${probed.schema}.${probed.table}.*`)
}

export interface ErasureCoverage {
  readonly classified: readonly (ProbedColumn & { readonly rule: ErasureRule })[]
  /** Columns the catalogue produced and nothing classified. Non-empty means the suite fails. */
  readonly unclassified: readonly ProbedColumn[]
  /** Rules matching no column the catalogue produced. A rule for a table somebody dropped. */
  readonly staleRuleKeys: readonly string[]
}

/**
 * Classifies every probed column, and reports what nothing classified.
 *
 * Both directions are reported, for `pnpm db:drift`'s reason: an unclassified column is a table that will
 * ship with a person’s data in it, and a stale rule is a decision about a table that no longer
 * exists, which makes the registry read as covering more than it does.
 */
export function classifyErasureCoverage(
  probed: readonly ProbedColumn[],
  rules: ReadonlyMap<string, ErasureRule> = ERASURE_RULES,
): ErasureCoverage {
  const classified: (ProbedColumn & { rule: ErasureRule })[] = []
  const unclassified: ProbedColumn[] = []
  const used = new Set<string>()

  for (const column of probed) {
    const exactKey = `${column.schema}.${column.table}.${column.column}`
    const wildcardKey = `${column.schema}.${column.table}.*`
    const resolved = rules.get(exactKey) ?? rules.get(wildcardKey)
    if (resolved === undefined) {
      unclassified.push(column)
      continue
    }
    used.add(resolved.key)
    classified.push({ ...column, rule: resolved })
  }

  const staleRuleKeys = [...rules.keys()].filter((key) => !used.has(key)).sort()
  return {
    classified: Object.freeze(classified),
    unclassified: Object.freeze(unclassified),
    staleRuleKeys: Object.freeze(staleRuleKeys),
  }
}

// ------------------------------------------------------------------------------------------------
// The clinical conflict
// ------------------------------------------------------------------------------------------------

export interface ClinicalErasureDecision {
  readonly action: Extract<ErasureAction, 'crypto_erase' | 'retain_statutory'>
  /** The reason, which is the sentence the resolution row carries. */
  readonly reason: string
  /** Set when the decision retained data an erasure asked to destroy. */
  readonly conflict: {
    readonly obligation: 'clinical_retention_years'
    readonly years: number
    readonly openQuestionId: string
  } | null
}

/**
 * Whether a clinical row's data key may be destroyed. Three-valued, and it READS the profile.
 *
 * This is the conflict the unit exists to resolve without either side silently winning, and the three
 * cases are not a hedge — they are three genuinely different situations:
 *
 *   1. **`synthetic`** — the row is not anybody's health data. `clinical.real_intake_permitted` is false
 *      (`Y5-residency`), so this is every row that exists today. No retention obligation attaches to a
 *      fixture and no right is at stake, so the key is destroyed. That this path is the exercisable one
 *      is what makes the mechanism proved rather than asserted.
 *   2. **`real` with `erasure_overrides_retention` true** — the owner has decided that an erasure request
 *      prevails over the clinical retention obligation. Destroy the key.
 *   3. **`real` with `erasure_overrides_retention` false** — the profile IN FORCE, and the default. The
 *      content is retained and the conflict is RECORDED with the obligation, the number of years and the
 *      open question whose answer changes it. This is not "we did nothing": the identity is still
 *      pseudonymised, every contact channel is still destroyed, the person is still unreachable. What is
 *      retained is health CONTENT, which is not a channel — the clinical schema holds no phone number,
 *      no email and no name, which is checked by the coverage probe rather than assumed.
 *
 * The manifest summary says erasure "destroys clinical DEKs" without qualification. That is right about
 * the mechanism and wrong about case 3, and a function that always destroyed would be defeating a
 * retention obligation the profile records — silently, which is the one thing forbidden here.
 */
export function planClinicalErasure(input: {
  readonly dataOrigin: 'synthetic' | 'real'
  readonly erasureOverridesRetention: boolean
  readonly clinicalRetentionYears: number
}): ClinicalErasureDecision {
  if (input.dataOrigin === 'synthetic') {
    return {
      action: 'crypto_erase',
      // THE MAINTAINER'S reasoning, here in a comment because `reason` is not the place for it: the row is
      // `data_origin = 'synthetic'`, which `clinical.real_intake_permitted` being false (Y5-residency)
      // makes true of every clinical row that exists today. A fixture is nobody's health data, so no
      // retention obligation attaches to it and no right is at stake; the wrapped data key is destroyed
      // and the ciphertext is left byte-identical.
      //
      // The sentence below is the SUBJECT's, and it is this path's that matters most: while
      // `real_intake_permitted` is false this is the ONLY branch reachable, so it is the sentence an
      // erasure actually writes to `rights_resolution_class.retained_reason`. An earlier draft left the
      // maintainer's prose above in that column — naming a setting key and an OPEN-QUESTIONS id to
      // somebody exercising a statutory right — and `is_placeholder_text` did not catch it, because the
      // words happened to carry none of its nine markers. The constraint is a floor, not a reviewer.
      reason:
        'This questionnaire held only synthetic test data and never any real health information about ' +
        'anybody, so there is nothing about your health for us to keep and nothing to destroy. The key ' +
        'that protected the record has been destroyed regardless, so it cannot be read by anybody.',
      conflict: null,
    }
  }
  if (input.erasureOverridesRetention) {
    return {
      action: 'crypto_erase',
      reason:
        'Your health information has been destroyed: the key that was the only means of reading it has ' +
        'been erased, so it cannot be read by us or by anybody else. The record that a questionnaire was ' +
        'taken, which wording you consented to, and when, is kept as the evidence that it was taken ' +
        'lawfully, and it contains no health information.',
      conflict: null,
    }
  }
  return {
    action: 'retain_statutory',
    reason:
      'Your health information is kept, because health records must be retained for ' +
      `${input.clinicalRetentionYears} years and that duty overrides a request to delete them. It is held ` +
      'encrypted and separately from the rest of our systems, it contains no way of contacting you, and ' +
      'your contact details have been destroyed regardless, so we cannot reach you.',
    conflict: {
      obligation: 'clinical_retention_years',
      years: input.clinicalRetentionYears,
      openQuestionId: 'Y1-licence',
    },
  }
}

// ------------------------------------------------------------------------------------------------
// The written response, and the fact this build refuses to invent
// ------------------------------------------------------------------------------------------------

export type RightsResponseDecision =
  | { readonly issued: true; readonly supervisoryAuthority: string }
  | { readonly issued: false; readonly refusal: 'rights_response_authority_absent' }

/**
 * Whether the written response to a data subject may be issued.
 *
 * It may not, while no supervisory authority is recorded, and this refusal is the point rather than a gap.
 * A response has to tell the subject where to complain if they are dissatisfied. `Y1-entity` decides
 * whether that is the federal authority, DIFC's or ADGM's, and the build has not been told — docs/04 §8
 * records the question as open. A response naming an invented authority would send somebody with a real
 * complaint to an office that cannot hear it, and it would look exactly like a correct one.
 *
 * So the rights themselves are performed and the LETTER is withheld, by name. The erasure still happens,
 * the export is still produced, the audit row is still written; what is refused is the document that would
 * have to contain a fact this build does not have. Blank is visibly unanswered; plausible is
 * indistinguishable from configured (brief rule 15).
 */
export function decideRightsResponse(input: {
  readonly supervisoryAuthority: string | null
}): RightsResponseDecision {
  const authority = input.supervisoryAuthority?.trim() ?? ''
  if (authority.length === 0) {
    return { issued: false, refusal: 'rights_response_authority_absent' }
  }
  return { issued: true, supervisoryAuthority: authority }
}

// ------------------------------------------------------------------------------------------------
// Retention purge
// ------------------------------------------------------------------------------------------------

export interface RetentionRule {
  readonly dataClass: DataClass
  /** How long after the anchor instant a row may be kept. Null means "no purge for this class". */
  readonly retainDays: number | null
  readonly why: string
}

export interface PurgeCandidate {
  readonly rowId: string
  readonly dataClass: DataClass
  /** The instant retention is measured from — capture, issue or last activity. */
  readonly anchoredAt: Date
}

export interface LegalHold {
  /** Null means every subject. */
  readonly subjectCustomerId: string | null
  /** Null means every class. */
  readonly dataClass: DataClass | null
}

export type PurgeVerdict =
  | { readonly rowId: string; readonly outcome: 'purge' }
  | { readonly rowId: string; readonly outcome: 'keep'; readonly because: 'within_retention' }
  | { readonly rowId: string; readonly outcome: 'keep'; readonly because: 'no_purge_for_class' }
  | { readonly rowId: string; readonly outcome: 'skip'; readonly because: 'legal_hold' }

/**
 * Which candidates a purge takes, which it keeps, and which it SKIPS under hold.
 *
 * `skip` and `keep` are different outcomes and the acceptance line is explicit that they must be: a row
 * under legal hold is "skipped AND REPORTED rather than silently retained". A hold is somebody's decision
 * that this row is needed for a dispute or an investigation, and a purge that folded it in with the rows
 * that were simply too young would leave nothing saying the hold had bitten — so the next person to ask
 * "did the purge touch this" would have to reason about dates instead of reading an answer.
 */
export function planRetentionPurge(input: {
  readonly candidates: readonly PurgeCandidate[]
  readonly rules: readonly RetentionRule[]
  readonly holds: readonly LegalHold[]
  readonly subjectOf: ReadonlyMap<string, string>
  readonly now: Date
}): readonly PurgeVerdict[] {
  const byClass = new Map(input.rules.map((r) => [r.dataClass, r]))
  return input.candidates.map((candidate): PurgeVerdict => {
    const subject = input.subjectOf.get(candidate.rowId) ?? null
    const held = input.holds.some(
      (hold) =>
        (hold.subjectCustomerId === null || hold.subjectCustomerId === subject) &&
        (hold.dataClass === null || hold.dataClass === candidate.dataClass),
    )
    // The hold is tested FIRST and independently of the dates. A hold on a row that is also within its
    // retention period still reports `legal_hold`, because the answer to "why is this row still here"
    // has to be the reason that would outlast the other one.
    if (held) return { rowId: candidate.rowId, outcome: 'skip', because: 'legal_hold' }

    const rule = byClass.get(candidate.dataClass)
    if (rule === undefined || rule.retainDays === null) {
      return { rowId: candidate.rowId, outcome: 'keep', because: 'no_purge_for_class' }
    }
    const dueAt = candidate.anchoredAt.getTime() + rule.retainDays * 24 * 60 * 60 * 1000
    if (input.now.getTime() <= dueAt) {
      return { rowId: candidate.rowId, outcome: 'keep', because: 'within_retention' }
    }
    return { rowId: candidate.rowId, outcome: 'purge' }
  })
}
