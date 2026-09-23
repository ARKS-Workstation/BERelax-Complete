import { AppError } from '@berelax/shared'
import type { BlocklistKeyKind } from './blocklist.ts'
import type { CustomerAcquisitionSource, CustomerLifecycleState } from './lifecycle.ts'

/**
 * The client record and the three audiences it is serialised for (C-CRM-01). Pure.
 *
 * ## Why the record is CLOSED
 *
 * `redactForRole` in `../access/permissions.ts` keeps an unmapped field, and its own comment says why
 * that is right for a customer record: most fields are innocuous and the map names the exceptions. That
 * default is wrong for this record, because of one field. `doNotPairTherapistIds` is a therapist's
 * refusal to work with a named person, recorded by a manager, and it is the single most damaging thing
 * in the CRM to hand to either party — so the field somebody forgets to classify must be DROPPED, not
 * returned. `packages/core/src/hr/employee.ts` closed the employment record for the same reason and this
 * follows it: {@link CLIENT_RECORD_AUDIENCES} classifies every field of {@link ClientRecordFacts}, and
 * `satisfies Readonly<Record<keyof ClientRecordFacts, ClientRecordAudience>>` makes a field added to the
 * facts and not classified a `pnpm typecheck` failure naming this file.
 *
 * ## The three audiences, and why the flag is in none of the two outer ones
 *
 *   - `public` — an anonymous visitor. Nothing identifies a customer here, so a per-customer fact has no
 *     business in it at all.
 *   - `customer` — an OTP-verified customer reading their own record (ADR 0014: verification gates
 *     reading, never booking). The flag IS about them, which is exactly why it must not appear: telling
 *     a customer which therapist will not work with them is the disclosure the flag exists to prevent,
 *     and it is also a fact about an employee that the employee did not agree to publish.
 *   - `staff` — the admin screen, behind a role check.
 *
 * The audiences nest: `public` ⊆ `customer` ⊆ `staff`, asserted in `client-record.test.ts` along with the
 * three key sets written out as literals. Enumerating the key sets rather than checking for the absence
 * of one field is the point of that test: an absence check passes for a record that has stopped carrying
 * the field for an unrelated reason, and it says nothing about the NEXT internal field somebody adds.
 */

/** The widest audience a field may reach. Ordered from narrowest to widest reach. */
export const CLIENT_RECORD_AUDIENCES_ORDER = ['public', 'customer', 'staff'] as const
export type ClientRecordAudience = (typeof CLIENT_RECORD_AUDIENCES_ORDER)[number]

/**
 * The treatment preferences (docs/03 §5).
 *
 * Three of the six are typed against vocabularies the system already owns — the two locales `customer`
 * accepts, `employee_gender`, and `room_type` — and three are free text. That split is deliberate: a
 * closed vocabulary for pressure, oil and music would be this build's guess at words nobody has
 * supplied, and a preference the customer cannot express is worse than a note the therapist reads
 * (brief rule 15). When the business states its vocabulary, those three become enums and the notes
 * migrate; until then nothing here pretends to be configured.
 */
export interface ClientPreferences {
  /** The language to speak and to write in. `customer.locale` is the record's; this is the preference. */
  readonly preferredLanguage: 'en' | 'ar' | null
  /**
   * A preference, and it can never WIDEN the same-gender rule.
   *
   * B-AVAIL-05 is a hard constraint and not a preference (ADR 0020, docs/04 §3): under strict matching
   * the solver already refuses a cross-gender pairing, so this field can only ever narrow what the
   * constraint allows. It is deliberately not read by the availability query — a preference that could
   * relax a compliance constraint by being set is the one shape this must not have.
   */
  readonly preferredTherapistGender: 'female' | 'male' | null
  readonly preferredRoomType: string | null
  /** As the customer said it. See the interface note on why these three are not enums. */
  readonly pressureNote: string | null
  readonly oilNote: string | null
  readonly musicNote: string | null
}

/** Every field of the client record, as the repository returns it. Closed; see the module note. */
export interface ClientRecordFacts {
  /** `Customer 0042`, or the display name once an admin sets one. Never an invented name (ADR 0020). */
  readonly label: string
  readonly displayName: string | null
  readonly locale: string
  readonly phoneE164: string
  readonly preferences: ClientPreferences
  readonly customerId: string
  readonly lifecycleState: CustomerLifecycleState
  readonly lifecycleChangedAtIso: string
  readonly acquisitionSource: CustomerAcquisitionSource
  readonly isVip: boolean
  readonly vipSinceIso: string | null
  readonly tags: readonly string[]
  /** The therapists this customer is not to be paired with. Staff only, always. */
  readonly doNotPairTherapistIds: readonly string[]
  /** Which kinds of contact detail are currently blocklisted for this record. Staff only, always. */
  readonly blocklistedKeyKinds: readonly BlocklistKeyKind[]
  readonly staffNotes: string | null
}

/**
 * The widest audience each field may reach. Every field, or the build fails.
 *
 * The four `staff` entries at the end are the ones this classification exists for. `lifecycleState` is
 * there with them and it is not an oversight: it is a segmentation the business applies TO the customer
 * — including `blocked` — and a customer who can read their own lifecycle state can read whether they
 * have been blocked, which defeats the endpoint's refusal being indistinguishable from a full diary.
 */
export const CLIENT_RECORD_AUDIENCES = Object.freeze({
  // Public: the label and nothing else. A booking confirmation rendered for a guest who has proved
  // nothing (ADR 0014) shows how to address them, and the label is derived from the record number.
  label: 'public',
  // The customer's own contact details and their own preferences. Theirs to read and to correct.
  displayName: 'customer',
  locale: 'customer',
  phoneE164: 'customer',
  preferences: 'customer',
  // Staff only.
  customerId: 'staff',
  lifecycleState: 'staff',
  lifecycleChangedAtIso: 'staff',
  acquisitionSource: 'staff',
  isVip: 'staff',
  vipSinceIso: 'staff',
  tags: 'staff',
  doNotPairTherapistIds: 'staff',
  blocklistedKeyKinds: 'staff',
  staffNotes: 'staff',
} as const satisfies Readonly<Record<keyof ClientRecordFacts, ClientRecordAudience>>)

export type ClientRecordField = keyof typeof CLIENT_RECORD_AUDIENCES

const REACH: Readonly<Record<ClientRecordAudience, number>> = Object.freeze({
  public: 0,
  customer: 1,
  staff: 2,
})

/**
 * Named so a refusal is greppable and a test can assert the rule rather than an exit code.
 *
 * There is deliberately no `unknownField` error beside it. An unclassified field is **dropped** by
 * {@link serialiseClientRecord} rather than refused, because the record leaves the data layer on a
 * request path: refusing would turn a forgotten classification into a 500 on the client's own details
 * page, and dropping turns it into a missing field somebody notices. The refusal is at build time
 * instead — `satisfies Readonly<Record<keyof ClientRecordFacts, …>>` on the classification.
 */
export const CLIENT_RECORD_ERRORS = Object.freeze({
  unknownAudience: 'UnknownClientRecordAudience',
})

/**
 * The key set one audience receives, sorted.
 *
 * Derived from the classification rather than written out three times, so the serialiser and the key
 * set cannot disagree — a DTO that carries a key its declared set omits is the leak this whole module is
 * arranged to make impossible. `client-record.test.ts` pins all three sets against literals, which is
 * what stops a classification changed by accident from changing the "expected" answer with it.
 */
export function clientRecordKeysFor(audience: ClientRecordAudience): readonly ClientRecordField[] {
  if (!Object.hasOwn(REACH, audience)) {
    throw new AppError(
      'invariant_violated',
      `${CLIENT_RECORD_ERRORS.unknownAudience}: "${audience}" is not one of ${CLIENT_RECORD_AUDIENCES_ORDER.join(', ')}.`,
      { details: { audience } },
    )
  }
  const limit = REACH[audience]
  return (Object.keys(CLIENT_RECORD_AUDIENCES) as ClientRecordField[])
    .filter((field) => REACH[CLIENT_RECORD_AUDIENCES[field]] <= limit)
    .sort()
}

/** The three key sets, precomputed. What a serialiser test enumerates. */
export const CLIENT_RECORD_KEYS: Readonly<
  Record<ClientRecordAudience, readonly ClientRecordField[]>
> = Object.freeze({
  public: clientRecordKeysFor('public'),
  customer: clientRecordKeysFor('customer'),
  staff: clientRecordKeysFor('staff'),
})

/**
 * The record as one audience may see it.
 *
 * Built by **picking** the classified fields rather than by deleting the unclassified ones, so a field
 * this module has never heard of cannot survive into the output even if the caller's object carries it.
 * That is the direction a closed record has to fail in: `delete` leaves anything the deleting code did
 * not know about.
 */
export function serialiseClientRecord(
  audience: ClientRecordAudience,
  facts: ClientRecordFacts,
): Partial<ClientRecordFacts> {
  const out: Record<string, unknown> = {}
  for (const field of clientRecordKeysFor(audience)) {
    out[field] = facts[field]
  }
  return out as Partial<ClientRecordFacts>
}

/** The audience governing a field, or `undefined` for a field this module does not classify. */
export function clientRecordFieldAudience(field: string): ClientRecordAudience | undefined {
  return Object.hasOwn(CLIENT_RECORD_AUDIENCES, field)
    ? CLIENT_RECORD_AUDIENCES[field as ClientRecordField]
    : undefined
}
