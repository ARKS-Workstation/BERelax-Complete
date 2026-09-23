import type { ConsentKind } from '@berelax/shared'
import { AppError } from '@berelax/shared'
import { type Instant, instantToIso } from '../time.ts'

/**
 * `resolveConsent` — the point-in-time resolver every send path reads consent through (C-CRM-03).
 *
 * The consent table is append-only: a grant is a row, a withdrawal is a row, a correction is a row, and
 * nothing is ever edited (ADR 0008, brief rule 9). So "is this contact opted in?" is not a column
 * lookup, it is a **fold over a log at an instant**, and this is the only place that fold is written.
 *
 * ## It fails closed to `unknown`, and `unknown` is not a variant of `granted`
 *
 * Three states, and the type will not let a caller confuse them: `granted`, `withdrawn`, `unknown`.
 * `unknown` is returned for an empty log, for a log whose newest applicable record names a wording
 * version nobody can produce, and for a log whose newest applicable records are tied on the instant.
 * Every one of those is a question the system cannot answer, and an input that cannot be evaluated is
 * not permission — the same rule `evaluateGate` states for a throwing evaluator.
 *
 * The temptation each of the three defends against is different, which is why none of them is folded
 * into another:
 *
 *   - an empty log looks like "we have not asked yet", which is true, and is also what a half-applied
 *     import looks like;
 *   - an unresolvable wording version looks harmless — the record says `granted`, after all — but the
 *     record is only an opt-in **proof** if the words shown can be produced, and TDRA asks for the
 *     proof before the blast rather than after the complaint (docs/04 §5);
 *   - a tie on the instant is the one that reads as a bug rather than a decision. It is neither: two
 *     records at the same instant is what a double submit, an import, or a merge of two records for one
 *     person produces, and there is no ordering that says which of them is last. Picking either is
 *     guessing, and half the guesses say `granted`.
 *
 * ## It is insertion-order independent, on purpose and as a property
 *
 * Nothing here reads `records[0]`, `.at(-1)`, or relies on the array arriving sorted. The log is
 * filtered, the maximum instant is reduced to, and the records at that instant are counted — so a log
 * read back with a different `ORDER BY`, appended to by two writers, or unioned across a merge resolves
 * to the same answer. `resolve.property.test.ts` proves it over 1,000 shuffles of the same set, which is
 * the only form of the claim that a `sort` comparator cannot accidentally satisfy.
 *
 * ## What is deliberately NOT here
 *
 * The suppression list. C-CRM-04 owns it and its rule is stricter than anything here: a suppression
 * beats consent outright, with no exceptions. Folding it in would make this function answer two
 * questions, and the second one would be answered from a store this function has not been given.
 */

/** The three states, and the only three. `unknown` is a first-class answer, not an error. */
export const CONSENT_STATES = ['granted', 'withdrawn', 'unknown'] as const
export type ConsentState = (typeof CONSENT_STATES)[number]

/** Why the log could not answer. Callers branch on these, never on prose. */
export const CONSENT_UNKNOWN_REASONS = [
  /** Nothing in the log is about this (channel, purpose) at or before the instant asked about. */
  'no_record',
  /** The newest applicable record names a wording version the log cannot produce. */
  'wording_unresolvable',
  /** Two or more applicable records share the newest instant. Nothing says which is last. */
  'ambiguous_timestamp',
] as const
export type ConsentUnknownReason = (typeof CONSENT_UNKNOWN_REASONS)[number]

/**
 * One row of the consent log, as `@berelax/db` reads it back.
 *
 * `wordingId` is null on a withdrawal by design — see `consentRecordSchema` in `@berelax/shared` for
 * why a withdrawal is accepted without a wording version and a grant is not.
 */
export interface ConsentRecord {
  readonly id: string
  readonly channel: string
  readonly purpose: string
  readonly kind: ConsentKind
  /** When the person decided. The ordering key, and the only one. */
  readonly recordedAt: Instant
  readonly wordingId: string | null
}

/** A wording version, as much of it as resolving needs: which version, and the hash that was shown. */
export interface ConsentWordingVersion {
  readonly id: string
  readonly purpose: string
  readonly version: number
  /** Lower-case hex SHA-256 over the EN and AR text. The proof of which words were shown. */
  readonly contentHashHex: string
}

/**
 * Everything known about one contact's consent, as an argument.
 *
 * The log arrives whole rather than as a query this function runs, because `packages/core` performs no
 * I/O and because a resolver that fetched its own rows could not be proved order-independent: the
 * ordering would be the query's, and the property would be about PostgreSQL.
 */
export interface ConsentLog {
  readonly contactId: string
  readonly records: readonly ConsentRecord[]
  /**
   * Every wording version the caller could produce. A record naming one absent from here is
   * unresolvable, which is `unknown` — not `granted` with a missing detail.
   */
  readonly wordingVersions: readonly ConsentWordingVersion[]
}

export type ConsentResolution =
  | {
      readonly state: 'granted'
      readonly recordId: string
      readonly recordedAtIso: string
      readonly wordingId: string
      readonly wordingVersion: number
      readonly wordingHashHex: string
    }
  | { readonly state: 'withdrawn'; readonly recordId: string; readonly recordedAtIso: string }
  | {
      readonly state: 'unknown'
      readonly reason: ConsentUnknownReason
      readonly detail: string
      /** The records that tied, for `ambiguous_timestamp`; empty otherwise. Named, so a clash is fixable. */
      readonly tiedRecordIds: readonly string[]
    }

const unknown = (
  reason: ConsentUnknownReason,
  detail: string,
  tiedRecordIds: readonly string[] = [],
): ConsentResolution => ({ state: 'unknown', reason, detail, tiedRecordIds })

/**
 * The state of one (channel, purpose) for one contact, as at an instant.
 *
 * `at` is an argument and there is no default: `packages/core` reads no clock, and "consent as it was
 * when the campaign was assembled" is a different question from "consent now" — a campaign built at
 * 09:00 and sent at 09:40 must be evaluated against the second, and a caller that could omit the
 * instant would silently get whichever one the implementation preferred.
 *
 * Records **after** `at` are ignored rather than rejected. A withdrawal recorded after the instant asked
 * about is not evidence about that instant, and a resolver that let it through would report a historical
 * send as non-compliant every time somebody later opted out.
 */
export function resolveConsent(
  contact: ConsentLog,
  channel: string,
  purpose: string,
  at: Instant,
): ConsentResolution {
  if (!Number.isFinite(at)) {
    // Not a resolution: a caller that cannot say *when* has asked an unanswerable question, and
    // returning `unknown` would make it indistinguishable from a contact nobody has asked.
    throw new AppError(
      'validation',
      `resolveConsent was given a non-finite instant (${String(at)}) for ${channel}/${purpose}. A ` +
        'point-in-time answer needs a point in time; an absent clock is a bug at the call site, not a ' +
        'consent state.',
      { details: { contactId: contact.contactId, channel, purpose } },
    )
  }

  const applicable = contact.records.filter(
    (record) =>
      record.channel === channel &&
      record.purpose === purpose &&
      Number.isFinite(record.recordedAt) &&
      record.recordedAt <= at,
  )

  const first = applicable[0]
  if (first === undefined) {
    return unknown(
      'no_record',
      `No consent record for ${channel}/${purpose} at or before ${instantToIso(at)}. Never asked is ` +
        'not permission.',
    )
  }

  // Reduced rather than sorted. A comparator over equal keys is stable in V8, and the stability is the
  // problem: it would settle a tie by taking whichever row the query returned first, which is exactly
  // the insertion-order dependence this function must not have.
  let newest = first
  for (const record of applicable) if (record.recordedAt > newest.recordedAt) newest = record
  const tied = applicable.filter((record) => record.recordedAt === newest.recordedAt)

  if (tied.length > 1) {
    return unknown(
      'ambiguous_timestamp',
      `${tied.length} consent records for ${channel}/${purpose} share the newest instant ` +
        `${instantToIso(newest.recordedAt)}. Nothing says which is last, so nothing says this contact ` +
        'opted in. Settle it by recording a further row; the log is append-only and none of these may ' +
        'be edited.',
      // Sorted, so the detail a caller logs does not depend on the order the log arrived in either.
      tied.map((record) => record.id).sort(),
    )
  }

  if (newest.kind === 'withdrawn') {
    return {
      state: 'withdrawn',
      recordId: newest.id,
      recordedAtIso: instantToIso(newest.recordedAt),
    }
  }

  const wordingId = newest.wordingId
  if (wordingId === null) {
    return unknown(
      'wording_unresolvable',
      `Consent record ${newest.id} grants ${channel}/${purpose} and names no wording version. A grant ` +
        'with no record of the words shown is not an opt-in proof.',
    )
  }
  const wording = contact.wordingVersions.find((version) => version.id === wordingId)
  if (wording === undefined) {
    return unknown(
      'wording_unresolvable',
      `Consent record ${newest.id} grants ${channel}/${purpose} under wording ${wordingId}, which is ` +
        'not among the versions supplied. The words shown cannot be produced, so neither can the proof.',
    )
  }

  return {
    state: 'granted',
    recordId: newest.id,
    recordedAtIso: instantToIso(newest.recordedAt),
    wordingId,
    wordingVersion: wording.version,
    wordingHashHex: wording.contentHashHex,
  }
}
