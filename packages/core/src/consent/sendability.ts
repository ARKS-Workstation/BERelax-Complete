import { AppError, SUPPRESSION_KINDS, type SuppressionKind } from '@berelax/shared'
import {
  BLOCKLIST_KEY_KINDS,
  type BlocklistKeyKind,
  normaliseBlocklistKey,
} from '../crm/blocklist.ts'
import { type Instant, instantToIso } from '../time.ts'
import type { ConsentResolution } from './resolve.ts'

/**
 * The suppression list's pure half, and the precedence rule (C-CRM-04).
 *
 * Three things live here and nothing else does:
 *
 *   - {@link resolveSuppression} — the fold from one key's append-only log to a state, the exact
 *     counterpart of `resolveConsent` next door;
 *   - {@link suppressionGateEvaluator} — the closure `evaluateGate`'s `isSuppressed` calls, built over
 *     a prefetched map, the exact counterpart of `consentGateEvaluator`;
 *   - {@link resolveSendability} — the precedence rule, stated once: **a suppression beats consent, with
 *     no exceptions.**
 *
 * ## Absence of a suppression IS an answer; absence of a consent is not
 *
 * This is the one asymmetry between the two resolvers and every other difference follows from it.
 * `resolveConsent` has a third state, `unknown`, because an empty log means "nobody has said we may" —
 * which is not permission and must never be read as any kind of yes. A suppression log has **two**
 * states, and an empty one means "nobody has asked us to stop", which is a complete answer to the
 * question this list asks. A `suppression_unknown` state would be a state that is true of every contact
 * this business has never heard of, and a send path that fail-closed on it would refuse every message
 * in the system.
 *
 * So the two resolvers fail closed in **opposite directions on the same input**, and that is deliberate:
 * given a tie on the newest instant, `resolveConsent` answers `unknown` (which the gate turns into a
 * refusal) and this one answers `suppressed` (which is a refusal directly). Both are the strict answer;
 * "strict" simply points a different way for a permission than for a prohibition.
 *
 * ## Why the suppression key is not a contact id
 *
 * The key is a hashed contact DETAIL — a normalised phone number or address — and never a customer id,
 * which is the choice 0053 made for `customer_blocklist` and 0064 repeats with its reasoning. Nothing in
 * this module knows how the key is derived: it arrives already hashed, because the HMAC needs a pepper
 * and `packages/core` reads no environment. What this module does guarantee is that the comparison is
 * over whatever the caller keyed with on both sides, which is why the log carries its own key.
 */

/*
 * The source set, the two record kinds and the unsuppression restriction are `@berelax/shared`'s, not
 * this module's. `packages/db` writes the rows and validates them against the same statement, and it may
 * not import this package — so a vocabulary declared here would be one the writer could not reach. It is
 * the placement `schemas/consent.ts` argues for, and the reason `resolveConsent` imports `ConsentKind`
 * from shared rather than declaring it beside the fold that reads it.
 */

/**
 * One row of the suppression log, as `@berelax/db` reads it back.
 *
 * `kind` and `source` are `string` rather than `SuppressionKind` and `SuppressionSource`, and that is
 * not laziness: the rows
 * arrive from Postgres enums through a `::text` cast, so the realistic wrong value is a label a later
 * migration added and this build has not learned about. {@link resolveSuppression} treats an unrecognised
 * `kind` as a suppression rather than narrowing with a cast — which is the direction an unknown value has
 * to fail in for a prohibition, and the opposite of the direction `decideBlocklist` fails in for a list
 * of keys being matched.
 */
export interface SuppressionRecord {
  readonly id: string
  readonly kind: string
  readonly source: string
  /** When the decision was made. The ordering key, and the only one. */
  readonly recordedAt: Instant
}

/**
 * Everything known about one key's suppression, as an argument.
 *
 * The log arrives whole for `resolveConsent`'s reason: `packages/core` performs no I/O, and a resolver
 * that fetched its own rows could not be proved insertion-order independent because the ordering would
 * be the query's.
 */
export interface SuppressionLog {
  /**
   * The key these records are about — the hex HMAC, never a phone number or an address.
   *
   * Carried so a detail string can name WHICH key resolved to a refusal without the caller having to
   * thread it separately, and so a log accidentally built for one key and consulted for another is
   * visible in the answer rather than silent.
   */
  readonly key: string
  readonly records: readonly SuppressionRecord[]
}

/** Two states, and the reason there is no third is in the module note. */
export const SUPPRESSION_STATES = ['suppressed', 'clear'] as const
export type SuppressionState = (typeof SUPPRESSION_STATES)[number]

/** Why the log resolved the way it did. Callers branch on these, never on prose. */
export const SUPPRESSION_REASONS = [
  /** No record at or before the instant. Nobody has asked us to stop, which is a complete answer. */
  'no_record',
  /** The newest applicable record suppresses. */
  'suppressed_by_record',
  /** The newest applicable record lifts an earlier suppression. */
  'unsuppressed_by_record',
  /**
   * Two or more applicable records share the newest instant, so nothing says which is last.
   *
   * Resolved to `suppressed`, which is the opposite of what `resolveConsent` does with the same input
   * and is the same principle: the strict answer. See the module note.
   */
  'ambiguous_timestamp',
  /**
   * The newest applicable record carries a `kind` this build does not know.
   *
   * Resolved to `suppressed`. A label added by a later migration is the realistic case, and a
   * prohibition whose unrecognised values read as "not prohibited" is a prohibition that a migration
   * can switch off.
   */
  'unknown_kind',
] as const
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number]

export interface SuppressionResolution {
  readonly state: SuppressionState
  readonly reason: SuppressionReason
  /** The record that decided it, or null when nothing did. */
  readonly recordId: string | null
  /** The source of the deciding record, when there is one. Null otherwise. */
  readonly source: string | null
  readonly detail: string
  /** The records that tied, for `ambiguous_timestamp`; empty otherwise. Named, so a clash is fixable. */
  readonly tiedRecordIds: readonly string[]
}

const isKnownKind = (kind: string): kind is SuppressionKind =>
  (SUPPRESSION_KINDS as readonly string[]).includes(kind)

/**
 * The state of one key, as at an instant.
 *
 * `at` is an argument and there is no default, for `resolveConsent`'s reason: "suppressed when the
 * campaign was assembled" and "suppressed now" are different questions, and a caller that could omit the
 * instant would silently get whichever one the implementation preferred.
 *
 * Records **after** `at` are ignored rather than rejected, again as `resolveConsent` does. An opt-out
 * recorded after the instant asked about is not evidence about that instant, and a resolver that let it
 * through would report every historical send as non-compliant the moment somebody unsubscribed.
 */
export function resolveSuppression(log: SuppressionLog, at: Instant): SuppressionResolution {
  if (!Number.isFinite(at)) {
    // Not a resolution. A caller that cannot say *when* has asked an unanswerable question, and
    // answering `suppressed` would hide a bug at the call site behind a refusal that looks correct.
    throw new AppError(
      'validation',
      `resolveSuppression was given a non-finite instant (${String(at)}) for key ${log.key}. A ` +
        'point-in-time answer needs a point in time; an absent clock is a bug at the call site, not a ' +
        'suppression state.',
      { details: { key: log.key } },
    )
  }

  const applicable = log.records.filter(
    (record) => Number.isFinite(record.recordedAt) && record.recordedAt <= at,
  )

  const first = applicable[0]
  if (first === undefined) {
    return {
      state: 'clear',
      reason: 'no_record',
      recordId: null,
      source: null,
      detail:
        `No suppression record for key ${log.key} at or before ${instantToIso(at)}. Nobody has asked ` +
        'this business to stop, which is a complete answer — unlike an empty consent log, which is not.',
      tiedRecordIds: [],
    }
  }

  // Reduced rather than sorted, for the reason `resolveConsent` states: a comparator over equal keys is
  // stable in V8, and the stability would settle a tie by taking whichever row the query returned first,
  // which is exactly the insertion-order dependence this function must not have.
  let newest = first
  for (const record of applicable) if (record.recordedAt > newest.recordedAt) newest = record
  const tied = applicable.filter((record) => record.recordedAt === newest.recordedAt)

  if (tied.length > 1) {
    return {
      state: 'suppressed',
      reason: 'ambiguous_timestamp',
      recordId: null,
      source: null,
      detail:
        `${tied.length} suppression records for key ${log.key} share the newest instant ` +
        `${instantToIso(newest.recordedAt)}. Nothing says which is last, so this resolves to ` +
        'SUPPRESSED — the strict answer, which for a prohibition points the opposite way from the ' +
        '`unknown` resolveConsent returns for the same shape of input. Settle it by recording a ' +
        'further row; the log is append-only and none of these may be edited.',
      // Sorted, so the detail a caller logs does not depend on the order the log arrived in either.
      tiedRecordIds: tied.map((record) => record.id).sort(),
    }
  }

  if (!isKnownKind(newest.kind)) {
    return {
      state: 'suppressed',
      reason: 'unknown_kind',
      recordId: newest.id,
      source: newest.source,
      detail:
        `Suppression record ${newest.id} carries kind '${newest.kind}', which is not one this build ` +
        `knows (${SUPPRESSION_KINDS.join(', ')}). It resolves to SUPPRESSED: a prohibition whose ` +
        'unrecognised values read as "not prohibited" is one a later migration can switch off.',
      tiedRecordIds: [],
    }
  }

  if (newest.kind === 'unsuppressed') {
    return {
      state: 'clear',
      reason: 'unsuppressed_by_record',
      recordId: newest.id,
      source: newest.source,
      detail:
        `Suppression for key ${log.key} was lifted by record ${newest.id} (${newest.source}) at ` +
        `${instantToIso(newest.recordedAt)}. The suppressing row is still in the log: the lift is a ` +
        'new record, never an edit.',
      tiedRecordIds: [],
    }
  }

  return {
    state: 'suppressed',
    reason: 'suppressed_by_record',
    recordId: newest.id,
    source: newest.source,
    detail:
      `Key ${log.key} was suppressed by record ${newest.id} (${newest.source}) at ` +
      `${instantToIso(newest.recordedAt)}.`,
    tiedRecordIds: [],
  }
}

/**
 * The part of an outbound message this evaluator reads.
 *
 * Structural, and deliberately not `OutboundMessage`, for `ConsentAskedOf`'s reason: `packages/core` may
 * not import `@berelax/messaging`, and a function taking this shape is still assignable to
 * `GateEvaluators.isSuppressed` because a parameter type may be widened.
 */
export interface SuppressionAskedOf {
  readonly channel: string
  /** E.164 for sms and whatsapp, an address for email. The key the prefetched map is built on. */
  readonly recipient: string
}

export interface SuppressionEvaluatorInput {
  /**
   * One log per recipient, keyed exactly as `message.recipient` will spell it — the PLAINTEXT recipient,
   * not the HMAC.
   *
   * That is not a leak of the thing the table exists not to hold: the recipient is already in the
   * message being sent, and this map lives for the length of one send run. What the pepper protects is
   * the STORED list, which is what a dump discloses. Keying this map on the HMAC instead would mean the
   * gate had to hash every recipient, which would put the pepper on the send path for no gain.
   *
   * A `Map` rather than a record, because the keys are E.164 numbers and addresses and a plain object
   * would silently answer for `__proto__`, `constructor` and `toString`. `Map.get` does not.
   */
  readonly logs: ReadonlyMap<string, SuppressionLog>
  /** The instant the decision is made at, from the same clock `sendMessage` uses. */
  readonly at: Instant
}

/**
 * Builds the gate's suppression evaluator over a prefetched set of logs.
 *
 * A recipient with no entry **throws**, exactly as `consentGateEvaluator` does, and the gate records
 * that as `blocked_unevaluable` with `evaluator: 'suppression'`. The distinction is the same one and it
 * matters more here, not less: `false` means the list was read and this recipient is not on it, and a
 * throw means the list was not read about this recipient at all. A campaign that quietly answered
 * `false` for every recipient its prefetch missed would be a campaign that sent to everybody who opted
 * out and reported a clean run.
 */
export function suppressionGateEvaluator(
  input: SuppressionEvaluatorInput,
): (message: SuppressionAskedOf) => boolean {
  return (message) => {
    const log = input.logs.get(message.recipient)
    if (log === undefined) {
      throw new AppError(
        'invariant_violated',
        `No suppression log was prefetched for the recipient of this ${message.channel} message. An ` +
          'unread list is not a clearance: the recipient list and the suppression prefetch have drifted ' +
          'apart, and the send stops until they agree.',
        { details: { channel: message.channel } },
      )
    }
    return resolveSuppression(log, input.at).state === 'suppressed'
  }
}

// ------------------------------------------------------------------------------------------------
// The precedence rule
// ------------------------------------------------------------------------------------------------

export type SendabilityDecision =
  | { readonly kind: 'sendable'; readonly consentRecordId: string }
  | {
      readonly kind: 'blocked'
      readonly reason: 'suppressed' | 'no_consent'
      readonly detail: string
    }

/**
 * Whether a promotional message to one recipient is permitted, given both resolutions.
 *
 * **Suppression is checked first and returns first, with no exceptions**, which is the acceptance
 * criterion this unit is measured by: resolved sendability is `blocked` whenever any suppression exists,
 * whatever the consent log says. A granted, freshly-captured, correctly-worded marketing consent does
 * not survive an opt-out, and the reason is not legal subtlety — the consent is *older* than the
 * suppression by construction, because somebody can only opt out of something they opted into.
 *
 * ## This is not a second answer to the send question
 *
 * `evaluateGate` is the choke point and it stays the choke point. It reads consent through
 * `consentGateEvaluator` and suppression through {@link suppressionGateEvaluator}, in that order, and a
 * suppressed recipient is refused there whether or not this function is ever called. What this function
 * adds is the **rule in one place, in a form that can be cross-producted**: `sendability.property.test.ts`
 * runs every (consent state × suppression state) pair through it, which is an assertion no arrangement of
 * two independent boolean evaluators can make about itself.
 *
 * The two therefore agree about the ANSWER and may differ about which of two simultaneously true reasons
 * they name — the gate reaches consent first, so a recipient who is both un-consented and suppressed is
 * refused there as `refused_no_consent`. `packages/fixtures/src/suppression.itest.ts` asserts the
 * agreement about the answer over the whole cross product by driving the real `sendMessage` and this
 * function over the same rows, because "they agree" is the claim, not "they are the same code".
 */
export function resolveSendability(input: {
  readonly consent: ConsentResolution
  readonly suppression: SuppressionResolution
}): SendabilityDecision {
  if (input.suppression.state === 'suppressed') {
    return {
      kind: 'blocked',
      reason: 'suppressed',
      detail:
        `Suppressed, so nothing promotional may be sent whatever the consent log says (consent ` +
        `resolved to '${input.consent.state}'). ${input.suppression.detail}`,
    }
  }
  if (input.consent.state !== 'granted') {
    return {
      kind: 'blocked',
      reason: 'no_consent',
      detail:
        `No affirmative consent: the log resolves to '${input.consent.state}'. ` +
        `${input.consent.state === 'unknown' ? input.consent.detail : 'The recipient withdrew.'}`,
    }
  }
  return { kind: 'sendable', consentRecordId: input.consent.recordId }
}

// ------------------------------------------------------------------------------------------------
// The one normaliser, widened for the port that crosses the db boundary
// ------------------------------------------------------------------------------------------------

/** What {@link suppressionKeyNormaliser} answers. Spelled in primitives; see its note. */
export type SuppressionKeyResult =
  | { readonly ok: true; readonly key: { readonly kind: string; readonly value: string } }
  | { readonly ok: false; readonly reason: string; readonly detail?: string | undefined }

/**
 * `normaliseBlocklistKey`, widened to take a `kind` of `string`, and deny-by-default for a kind nobody
 * declared.
 *
 * This exists for one reason and it is a boundary reason: `packages/db` writes the suppression rows,
 * cannot import this package, and therefore declares the normaliser as a port spelled in primitives —
 * exactly as it declares `BlocklistMatcher`. `normaliseBlocklistKey` takes the narrow union, so it is not
 * assignable to that port, and the choice is between a cast at every call site and one adaptor here.
 *
 * It is emphatically NOT a second normaliser. Every decision about what a canonical phone number or
 * address is stays in `crm/blocklist.ts`, which delegates the UAE half to B-LIFE-02's
 * `normalisePhoneResult` (brief rule 12). What this adds is the refusal `normaliseBlocklistKey` cannot
 * express because its signature makes it unreachable: a kind outside `BLOCKLIST_KEY_KINDS` is refused by
 * name rather than reaching a ternary that treats everything-that-is-not-phone as an email. That is the
 * same unknown-value arm `mayChangeBlocklist` needed for an undeclared ROLE, and for the same reason —
 * the realistic input at a boundary is a `string` widened somewhere behind it.
 */
export function suppressionKeyNormaliser(kind: string, raw: string): SuppressionKeyResult {
  if (!(BLOCKLIST_KEY_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      reason: 'unknown_key_kind',
      detail:
        `'${kind}' is not a contact key kind (${BLOCKLIST_KEY_KINDS.join(', ')}). Refused rather than ` +
        'treated as an address, because a kind this build does not know cannot be normalised and a ' +
        'guessed normalisation produces a key nothing will ever match.',
    }
  }
  return normaliseBlocklistKey(kind as BlocklistKeyKind, raw)
}
