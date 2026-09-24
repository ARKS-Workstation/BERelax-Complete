import { type Instant, instantToIso } from '../time.ts'

/**
 * The opt-out token's pure half (C-CRM-04): what a token looks like, and what a presented one grants.
 *
 * ## It is a stored grant, not a signature
 *
 * The acceptance criterion says "signed", and this is deliberately not a signature. It is the shape
 * M-VAT-11 established for `obligation_evidence_grant` — 32 random bytes handed out once, only their
 * sha256 stored, an expiry on the row, revocation by DELETE — and the three reasons that unit records
 * apply here unchanged:
 *
 *   1. **No further signing secret.** An HMAC over the URL would be another entry in
 *      `build/secret-inventory.json` with a rotation section somebody follows at 02:00. This unit already
 *      adds one secret it cannot avoid — the suppression pepper, without which the stored digests are
 *      reversible — and a second one for a link is a poor trade.
 *   2. **Revocable.** A link minted for the wrong contact is a DELETE. A signature is valid until it
 *      expires and the only way to withdraw one is to rotate the key, which breaks every other link.
 *   3. **The row records that the link existed**, which is what a TDRA complaint about an opt-out that
 *      "did not work" actually asks. A signature answers nothing about itself.
 *
 * Nothing here mints a token: 32 bytes from a CSPRNG is `randomBytes`, and `packages/core` reads no
 * ambient source of anything — `Math.random` is refused by the purity gate for exactly this reason, and
 * a seedable generator would be worse than useless for a capability. Minting is
 * `packages/db/src/repositories/suppression.ts`'s, beside the row it writes.
 *
 * ## Every refusal answers the same thing
 *
 * {@link OPT_OUT_NOT_FOUND} is one frozen object and there is deliberately no way to return a different
 * body for a different reason. An expired token, a revoked one, a mistyped one, a forged one and a valid
 * token presented for somebody else's page are all one response. Anything else is an oracle: a caller
 * who can tell "expired" from "never existed" can test whether a given contact id has ever been sent a
 * promotional message, and a caller who can tell "not for this contact" from "unknown" can confirm that
 * a contact id exists at all. The named reasons here are for the SERVER's log and for
 * `optout_verification_attempt.outcome`; the acceptance's "the same 404 shape" is the only thing the
 * requester ever sees.
 */

/**
 * How many random bytes a token carries, and what that is in base64url.
 *
 * 32 bytes is 256 bits, so the token is not guessable and the rate limit beside it is not an
 * anti-guessing measure — it is an anti-flood measure, and `optout_verification_attempt`'s comment says
 * so rather than letting somebody believe the limit is what makes the token safe. base64url rather than
 * hex because it goes in a URL a customer taps, and rather than base64 because `+` and `/` would have to
 * be escaped by every caller that builds one.
 */
export const OPT_OUT_TOKEN_BYTES = 32
/** 43 characters: `ceil(32 * 4 / 3)` with no `=` padding, which base64url omits. */
export const OPT_OUT_TOKEN_LENGTH = 43
const OPT_OUT_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

/**
 * How long a token lives.
 *
 * Thirty days, which is two orders of magnitude longer than `EVIDENCE_GRANT_TTL_SECONDS` and is the one
 * number in this area that is not copied from M-VAT-11. An evidence link lives fifteen minutes because
 * somebody is looking at a screen when it is minted. This link is in a message, and the person who needs
 * it is reading a message they were sent three weeks ago, at the moment they have finally had enough. A
 * link that has expired by then is not a shorter-lived credential, it is an opt-out this business does
 * not have — and docs/04 §5 is clear that the link is the ONLY functional opt-out here, because an
 * alphanumeric sender ID cannot receive a reply.
 *
 * It is a technical policy with a stated reason and not a legal figure, the same status
 * `SCHEDULED_STEP_LATE_TOLERANCE_MINUTES` has.
 */
export const OPT_OUT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * What a token may be minted for. One value, and a column rather than an implied constant.
 *
 * The realistic second purpose is near — an unsubscribe confirmation, a PDPL data-export link — and a
 * token whose purpose was implicit would be valid for both of them retroactively, which is how a link
 * that lets somebody stop a text becomes a link that hands over their record. Pinned to
 * `optout_grant_purpose_known` in migration 0064 by `packages/fixtures/src/suppression.itest.ts`.
 */
export const OPT_OUT_TOKEN_PURPOSES = ['preference_centre'] as const
export type OptOutTokenPurpose = (typeof OPT_OUT_TOKEN_PURPOSES)[number]

/** Every reason a presented token grants nothing. For the server's log, never for the response. */
export const OPT_OUT_REFUSALS = [
  /** No token was presented at all. */
  'token_absent',
  /** Not the shape a token has, so nothing was looked up. See {@link optOutTokenShape}. */
  'token_malformed',
  /** Well-formed and no grant holds its digest: mistyped, forged, expired-and-swept, or revoked. */
  'token_unknown',
  /** The grant exists and its expiry has passed. */
  'token_expired',
  /** A valid grant, for a DIFFERENT contact than the page asked for. */
  'token_not_for_this_contact',
  /** A valid grant, minted for a different purpose than the one being redeemed. */
  'token_not_for_this_purpose',
] as const
export type OptOutRefusal = (typeof OPT_OUT_REFUSALS)[number]

/**
 * Every outcome one verification can have, which is exactly what is recorded against an attempt.
 *
 * Pinned to `optout_verification_attempt_outcome_known` in migration 0064 by
 * `packages/fixtures/src/suppression.itest.ts`, so a refusal added here without widening the CHECK fails
 * the build rather than failing at 02:00 on the one path that produces it. `rate_limited` is in the list
 * and is not an {@link OptOutRefusal}: the limit is refused before anything is verified, so it is an
 * outcome of the ATTEMPT rather than a verdict on a token.
 */
export const OPT_OUT_ATTEMPT_OUTCOMES = ['granted', ...OPT_OUT_REFUSALS, 'rate_limited'] as const
export type OptOutAttemptOutcome = (typeof OPT_OUT_ATTEMPT_OUTCOMES)[number]

/**
 * The one response body every refusal produces. Frozen, and there is no variant of it.
 *
 * `status` is carried alongside so that no call site gets to choose one: a 403 for an expired token and a
 * 404 for an unknown one would be the oracle this constant exists to remove, and the difference is one
 * line at whichever route somebody adds next.
 */
export const OPT_OUT_NOT_FOUND = Object.freeze({
  status: 404 as const,
  body: Object.freeze({ error: 'not_found' as const }),
})

export type OptOutTokenShapeResult =
  | { readonly ok: true; readonly token: string }
  | {
      readonly ok: false
      readonly reason: Extract<OptOutRefusal, 'token_absent' | 'token_malformed'>
    }

/**
 * Whether a presented string could be a token at all.
 *
 * Checked before anything is looked up, which is the point: a malformed token costs one regex rather than
 * a query, so a flood of rubbish cannot be turned into a flood of database round trips. It is also the
 * only refusal that can be decided without I/O, which is why it is here and the rest of the decision
 * takes the grant as an argument.
 *
 * The length is exact rather than a minimum. A token is always 43 characters because it is always 32
 * bytes, and a range would accept a truncated paste — which would then be looked up, miss, and be
 * indistinguishable from a forgery in the log.
 */
export function optOutTokenShape(presented: string | null | undefined): OptOutTokenShapeResult {
  if (presented === null || presented === undefined || presented.trim() === '') {
    return { ok: false, reason: 'token_absent' }
  }
  // Not trimmed before the shape test. A token with a space in it is not a token with a space trimmed
  // off it: the URL that produced it is wrong, and accepting the trimmed version would hide that for
  // ever behind a link that works.
  if (!OPT_OUT_TOKEN_SHAPE.test(presented)) return { ok: false, reason: 'token_malformed' }
  return { ok: true, token: presented }
}

/**
 * The accumulated difference between two digests, as bits.
 *
 * Zero means identical. Anything else means they differ, and the VALUE is the bitwise OR of every
 * position's difference — which is what makes the guarantee assertable. A comparator that returned on the
 * first differing character would produce a different number here, so `optout-token.test.ts` pins exact
 * values for inputs that differ in more than one place, and the mutant that adds an early return fails.
 *
 * What that test proves and does not prove is worth being exact about, because "constant time" is easy to
 * claim and hard to check: it proves **no short circuit** — every position is read and combined, whatever
 * the first difference is. It does not prove a constant wall-clock time, which no unit test can, and this
 * function makes no claim beyond the one it can support. `node:crypto`'s `timingSafeEqual` is not used
 * because `packages/core` imports no Node builtin at all; the comparison it would perform is this one,
 * over two 64-character hex strings whose equal length is already guaranteed by the column's CHECK.
 *
 * The length is folded in FIRST rather than short-circuited on, and the missing positions of a shorter
 * string are read as 0. Returning early on a length mismatch would leak the length of the stored value,
 * and comparing only the shared prefix would make a truncated digest equal to its own prefix.
 */
export function digestDifference(a: string, b: string): number {
  let difference = a.length ^ b.length
  const span = a.length > b.length ? a.length : b.length
  for (let i = 0; i < span; i += 1) {
    difference |= codeAt(a, i) ^ codeAt(b, i)
  }
  return difference
}

/** The character code, or 0 past the end. `charCodeAt` answers NaN there, and `NaN ^ x` is `x`. */
const codeAt = (value: string, index: number): number =>
  index < value.length ? value.charCodeAt(index) : 0

/** True when the two digests are identical, compared without a short circuit. */
export const digestsEqual = (a: string, b: string): boolean => digestDifference(a, b) === 0

/**
 * Epoch milliseconds as ISO-8601, through the one formatter this package has.
 *
 * The cast is the boundary made explicit in one place rather than at each of the three call sites: the
 * values arrive as primitives because the port they cross is spelled in primitives, and `instantToIso`
 * takes the branded type because everything else in `packages/core` does.
 */
const iso = (at: number): string => instantToIso(at as Instant)

/** A grant as `@berelax/db` reads it back. The digest, never the token. */
export interface StoredOptOutGrant {
  readonly grantId: string
  /** Lower-case hex of the sha256 of the token. The only representation of it that is stored. */
  readonly tokenSha256Hex: string
  readonly contactCustomerId: string
  readonly purpose: string
  /** Which message carried the link. Recorded, and not part of the decision. */
  readonly channel: string
  /**
   * Epoch milliseconds, and deliberately a plain `number` rather than an `Instant`.
   *
   * This shape crosses the package boundary: `packages/db` declares the decision as an injected port and
   * may not import this package, so the port is spelled in primitives — the same reason `ContactKeyLike`
   * spells a blocklist key's kind as `string`. An `Instant` is a branded `number`, so a caller holding one
   * still passes it unchanged, and the branded type would only mean that the port `decideOptOutAccess` is
   * assigned to could not be written at all.
   */
  readonly expiresAt: number
}

export type OptOutAccessDecision =
  | {
      readonly kind: 'granted'
      readonly grantId: string
      readonly contactCustomerId: string
      readonly channel: string
      readonly expiresAtIso: string
    }
  | { readonly kind: 'refused'; readonly reason: OptOutRefusal; readonly detail: string }

/**
 * What a presented token grants, given the grant a lookup on its digest found.
 *
 * Pure, and the grant arrives as an argument for the reason `resolveConsent`'s log does: `packages/db`
 * may not import `packages/core`, so the repository declares this decision as an injected PORT — the same
 * seam `BlocklistMatcher` uses — and the composition happens at the route, which may import both.
 *
 * `presentedDigestHex` is compared against the stored digest even though the lookup already matched on
 * it. That is not redundant: the lookup's equality is PostgreSQL's, over a `text` column, and what that
 * comparison does about collation, padding and short-circuiting is not this module's to assume. The
 * second comparison is the one whose behaviour is pinned by a test.
 *
 * `at` is an argument, and expiry is judged against it rather than against a clock this module reads —
 * which it could not do anyway. The caller passes the instant the request arrived, and the repository
 * passes the one PostgreSQL reported, so two containers serving one link cannot disagree about whether
 * it is dead.
 */
export function decideOptOutAccess(input: {
  readonly grant: StoredOptOutGrant | null
  readonly presentedDigestHex: string
  /** The contact whose page was asked for. See the header on why the URL names it as well as the token. */
  readonly requestedContactId: string
  readonly expectedPurpose: OptOutTokenPurpose
  /** Epoch milliseconds. A plain `number` for the reason {@link StoredOptOutGrant.expiresAt} states. */
  readonly at: number
}): OptOutAccessDecision {
  const grant = input.grant
  if (grant === null) {
    return {
      kind: 'refused',
      reason: 'token_unknown',
      detail: 'No grant holds this token digest: mistyped, forged, revoked, or already swept.',
    }
  }
  if (!digestsEqual(grant.tokenSha256Hex, input.presentedDigestHex)) {
    // Reachable only if the lookup returned a row whose digest is not the one asked for, which means the
    // query and this decision disagree about what "equal" is. Refused as unknown rather than raised: the
    // requester learns nothing either way, and the server's log carries the reason.
    return {
      kind: 'refused',
      reason: 'token_unknown',
      detail:
        `The grant found for this digest stores a different one. The lookup and the comparison ` +
        'disagree about equality, which is a fault in the query rather than in the token.',
    }
  }
  if (grant.purpose !== input.expectedPurpose) {
    return {
      kind: 'refused',
      reason: 'token_not_for_this_purpose',
      detail:
        `This grant was minted for '${grant.purpose}' and is being redeemed for ` +
        `'${input.expectedPurpose}'. A single-purpose token is the whole reason the purpose is a column.`,
    }
  }
  if (grant.expiresAt <= input.at) {
    return {
      kind: 'refused',
      reason: 'token_expired',
      detail:
        `This grant expired at ${iso(grant.expiresAt)}, before ` +
        `${iso(input.at)}. Expiry is inclusive of the boundary: a link is dead at its expiry ` +
        'instant, not one millisecond after it.',
    }
  }
  if (grant.contactCustomerId !== input.requestedContactId) {
    return {
      kind: 'refused',
      reason: 'token_not_for_this_contact',
      detail:
        'A valid grant, for a different contact than the page asked for. The two halves of the link ' +
        'disagree, which is what a template loop that paired one recipient with another recipient’s ' +
        'token produces — and the token alone would have looked perfectly valid.',
    }
  }
  return {
    kind: 'granted',
    grantId: grant.grantId,
    contactCustomerId: grant.contactCustomerId,
    channel: grant.channel,
    expiresAtIso: iso(grant.expiresAt),
  }
}
