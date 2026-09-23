import { AppError } from '@berelax/shared'
import { can, ROLES, type Role } from '../access/permissions.ts'
import { normalisePhoneResult } from '../identity/normalise-phone.ts'

/**
 * The blocklist's pure half (C-CRM-01): what a key is, how a match is decided, and who may change one.
 *
 * "A blocklist that actually blocks" is the unit's title and the whole design follows from it. Three
 * decisions are made here and nowhere else, so that the endpoint, the repository and the admin screen
 * cannot each hold a slightly different one:
 *
 *   1. **A blocklist entry is a normalised CONTACT KEY, not a customer id.** The person the business
 *      needs to refuse frequently has no customer row — a walk-in who was abusive, a number that books
 *      and never arrives — and the one who does has already discovered that a new phone number makes a
 *      new record. Keying on `(kind, normalised value)` means the check runs on what the request
 *      carries, before any record is looked up or created.
 *   2. **The match is over normalised values on both sides.** `+971 59 000 0042` and `0590000042` are
 *      one key, and `Guest@Example.com` and `guest@example.com` are one key. A blocklist that matched
 *      raw strings would be bypassed by a space.
 *   3. **Changing the list is deny-by-default, including for a role nobody has declared.** See
 *      {@link mayChangeBlocklist}.
 *
 * ## What is deliberately NOT here
 *
 * No decision about what a blocked caller is told. That is the endpoint's, and the endpoint's rule is
 * that the refusal is byte-identical to a legitimate no-availability answer — see
 * `apps/web/app/api/v1/bookings/handler.ts`. A reason string reaching the caller would turn the
 * blocklist into an oracle: try a number, read the refusal, learn whether it is on the list.
 */

/**
 * The two kinds of key a blocklist entry can hold.
 *
 * Closed, and there is no `customer_id` member. An entry may still *reference* a customer row for the
 * admin screen (0053 keeps a nullable `customer_id`), but the MATCH is always on a contact detail:
 * matching on the record would mean a blocked person's second record is not blocked, which is the
 * failure mode of every blocklist that has ever been built on a foreign key.
 */
export const BLOCKLIST_KEY_KINDS = ['phone', 'email'] as const
export type BlocklistKeyKind = (typeof BLOCKLIST_KEY_KINDS)[number]

/** Why a value could not be made into a key. Callers branch on these, never on prose. */
export const BLOCKLIST_KEY_REJECTIONS = [
  'empty',
  /** The phone did not normalise. The reason from `normalisePhoneResult` is carried in `detail`. */
  'not_a_phone',
  'not_an_email',
  'too_long',
] as const
export type BlocklistKeyRejection = (typeof BLOCKLIST_KEY_REJECTIONS)[number]

export interface BlocklistKey {
  readonly kind: BlocklistKeyKind
  /** Canonical: E.164 for a phone, lower-cased address for an email. Never the raw input. */
  readonly value: string
}

export type BlocklistKeyResult =
  | { readonly ok: true; readonly key: BlocklistKey }
  | { readonly ok: false; readonly reason: BlocklistKeyRejection; readonly detail?: string }

/**
 * The longest address this system will store or compare.
 *
 * 254 is the RFC 5321 limit on a forward path. Refusing above it rather than truncating: a truncated
 * address is a DIFFERENT address, and a blocklist entry that silently became a prefix of somebody
 * else's address would refuse the wrong person.
 */
export const MAX_EMAIL_LENGTH = 254

/**
 * One `@`, something either side, no whitespace, and a dot in the domain.
 *
 * Deliberately not an RFC 5322 grammar. This is a comparison key, not a deliverability check: the
 * strict grammar accepts quoted local parts and address literals that no booking form will ever
 * produce, and every extra form it accepts is another spelling of one key. Delivery is
 * `packages/messaging`'s problem and it has the transport's own answer.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/

/**
 * A comparison key for an email address, or a typed refusal.
 *
 * **Lower-cased whole**, local part included. The local part is case-SENSITIVE per RFC 5321 and no
 * mail provider in practice treats it that way, and the choice here is between two failure modes: a
 * case-insensitive key can in theory block a second mailbox at the same domain, while a
 * case-sensitive one is bypassed by typing `A@x` where `a@x` is blocked. For a blocklist the second is
 * the one that matters, so this folds case and says so.
 *
 * Nothing else is folded. Gmail's dots and `+tags` are provider-specific, and applying them here would
 * over-block: `a.b@yourdomain.test` and `ab@yourdomain.test` are two different mailboxes at every
 * provider except one.
 */
export function normaliseEmail(raw: string): BlocklistKeyResult {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'empty' }
  if (trimmed.length > MAX_EMAIL_LENGTH) return { ok: false, reason: 'too_long' }
  const lowered = trimmed.toLowerCase()
  if (!EMAIL_SHAPE.test(lowered)) return { ok: false, reason: 'not_an_email' }
  return { ok: true, key: { kind: 'email', value: lowered } }
}

/** A comparison key for a phone number, through the one normaliser this system has. */
export function normalisePhoneKey(raw: string): BlocklistKeyResult {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'empty' }
  const result = normalisePhoneResult(trimmed)
  if (!result.ok) return { ok: false, reason: 'not_a_phone', detail: result.reason }
  return { ok: true, key: { kind: 'phone', value: result.e164 } }
}

/** Either normaliser, chosen by kind. The one entry point an admin screen needs. */
export function normaliseBlocklistKey(kind: BlocklistKeyKind, raw: string): BlocklistKeyResult {
  return kind === 'phone' ? normalisePhoneKey(raw) : normaliseEmail(raw)
}

/**
 * Every key a booking request offers for matching, in the order they are checked.
 *
 * Both are collected even when the first one matches, because the audit row records **which kind**
 * matched and a caller that stopped at the phone could never record an email match. Values that do not
 * normalise are dropped rather than compared raw: an unnormalisable input cannot equal a stored key,
 * and comparing the raw string would be the one path on which a match could be made by accident.
 */
export function blocklistKeysFor(contact: {
  readonly phone?: string | null
  readonly email?: string | null
}): readonly BlocklistKey[] {
  const keys: BlocklistKey[] = []
  const phone = contact.phone ?? null
  if (phone !== null) {
    const result = normalisePhoneKey(phone)
    if (result.ok) keys.push(result.key)
  }
  const email = contact.email ?? null
  if (email !== null) {
    const result = normaliseEmail(email)
    if (result.ok) keys.push(result.key)
  }
  return keys
}

/**
 * An active blocklist entry, as the repository reads it.
 *
 * `kind` is `string` and not {@link BlocklistKeyKind}, and that is not laziness. The rows arrive from a
 * `text` column behind a CHECK constraint, so the realistic value is a label this build has not learned
 * about, and a signature that promised the union would move the narrowing to a cast at the call site.
 * {@link decideBlocklist} compares against `BLOCKLIST_KEY_KINDS` instead, so an unknown kind simply
 * matches nothing — the direction an unrecognised value has to fail in for a list of KEYS being matched.
 * It is also what lets `decideBlocklist satisfies BlocklistMatcher` hold across the db boundary, where
 * the port is declared in strings because `packages/db` may not import this package.
 */
export interface BlocklistEntry {
  readonly id: string
  readonly kind: string
  /** Normalised by the repository's own CHECK constraint (0053), so no folding happens here. */
  readonly value: string
  readonly reason: string
}

/** A key as it arrives from across the db boundary: the same shape, spelled in strings. */
export interface ContactKeyLike {
  readonly kind: string
  readonly value: string
}

/**
 * The verdict on one booking attempt. `matched` carries the entry so the audit row can name it.
 *
 * A single shape rather than a boolean, because the audit requirement is "actor, matched key kind and
 * reason" and a boolean cannot carry either. The **caller** must never put `reason` into a response;
 * see the module note.
 */
export type BlocklistVerdict =
  | {
      readonly kind: 'matched'
      readonly matchedKeyKind: BlocklistKeyKind
      readonly entryId: string
      readonly reason: string
    }
  | { readonly kind: 'clear'; readonly keyKindsChecked: readonly string[] }

/**
 * Decides one booking attempt against the entries the repository read.
 *
 * Pure, and the reason it is pure rather than a `where` clause is the assertion it makes possible: the
 * same function decides a phone match, an email match and a clear answer in the unit suite with no
 * database, and `packages/fixtures` then proves the SQL hands it the right rows. A `where key_value =
 * any(...)` alone would have no place to put the "which kind matched" fact that the audit row needs.
 *
 * Phone before email, deterministically, so two entries covering one person produce one stable audit
 * trail rather than whichever row the planner returned first.
 */
export function decideBlocklist(
  keys: readonly ContactKeyLike[],
  entries: readonly BlocklistEntry[],
): BlocklistVerdict {
  for (const kind of BLOCKLIST_KEY_KINDS) {
    const offered = keys.filter((key) => key.kind === kind)
    if (offered.length === 0) continue
    const hit = entries.find(
      (entry) => entry.kind === kind && offered.some((key) => key.value === entry.value),
    )
    if (hit !== undefined) {
      return { kind: 'matched', matchedKeyKind: kind, entryId: hit.id, reason: hit.reason }
    }
  }
  return { kind: 'clear', keyKindsChecked: keys.map((key) => key.kind) }
}

/** Why a role may not change the blocklist. Two reasons, and they are different facts. */
export const BLOCKLIST_AUTHORISATION_REFUSALS = [
  /** A declared role that does not hold `customer:blocklist`. */
  'permission_not_granted',
  /** Not a declared role at all. See {@link mayChangeBlocklist}. */
  'unknown_role',
] as const
export type BlocklistAuthorisationRefusal = (typeof BLOCKLIST_AUTHORISATION_REFUSALS)[number]

export type BlocklistAuthorisation =
  | { readonly allowed: true; readonly role: Role }
  | { readonly allowed: false; readonly refusal: BlocklistAuthorisationRefusal }

/** The permission adding or lifting an entry requires. Declared once, consulted through `can()`. */
export const BLOCKLIST_PERMISSION = 'customer:blocklist' as const

/**
 * May this role add or lift a blocklist entry? Deny by default, including for a role nobody declared.
 *
 * The unknown-role arm is the reason this function exists instead of a bare `can(role, ...)` at the
 * call site. `can()` refuses an unknown PERMISSION string by name, and it does not refuse an unknown
 * ROLE: `ROLE_DEFINITIONS[role]` is `undefined` for a string outside `ROLES`, and reading
 * `.permissions` off it **throws a TypeError**. At an API boundary the role arrives from a session
 * claim or a header — a `string` widened to `Role` somewhere behind it — so the realistic input is
 * exactly the one that throws, and a TypeError inside a catch block that maps errors to 500 is a
 * deny-by-default failure that presents as an outage. This narrows first and refuses by name.
 *
 * `ROLES.includes` rather than a second list: a role added to F07 is a role this function knows about
 * in the same commit.
 */
export function mayChangeBlocklist(role: string): BlocklistAuthorisation {
  if (!(ROLES as readonly string[]).includes(role)) {
    return { allowed: false, refusal: 'unknown_role' }
  }
  const declared = role as Role
  if (!can(declared, BLOCKLIST_PERMISSION)) {
    return { allowed: false, refusal: 'permission_not_granted' }
  }
  return { allowed: true, role: declared }
}

/** Throws rather than returning, for a call site that must not proceed. Carries the refusal as data. */
export function assertMayChangeBlocklist(role: string): Role {
  const verdict = mayChangeBlocklist(role)
  if (!verdict.allowed) {
    throw new AppError(
      'forbidden',
      `Role "${role}" may not add or lift a blocklist entry (${verdict.refusal}).`,
      { details: { role, refusal: verdict.refusal, permission: BLOCKLIST_PERMISSION } },
    )
  }
  return verdict.role
}
