import type { CapabilityState, GoogleCapability, GoogleCapabilityHealth } from './connection.ts'

/**
 * The daily health check, as arithmetic: what a probe proved, and whether the listing is still ours.
 *
 * `connection.ts` next door answers *"is this grant about to die"* and *"what is the owner shown"*.
 * This file answers the two questions the daily run adds, and both are here rather than in
 * `@berelax/google` for the same reason: they are decisions, and a decision taken inside the
 * `withGoogle` body is a decision the chokepoint launders into an upstream Google failure.
 *
 * That is not hypothetical. G-CONN-05 put `assertSiteSelectable` inside a `withGoogle` body and *our*
 * refusal came back as `TransientUpstream` with its reason discarded — **and wrote a
 * `health_check_failed` row onto the owner's dashboard for something Google had not done**. Listing
 * drift is exactly the same shape: Google answers 200 with a perfectly good location, and the
 * judgement *"that is not the listing the owner confirmed"* is ours alone. So the I/O stays inside the
 * chokepoint and every function in this file is pure, takes its inputs as arguments, and reads no
 * clock.
 */

/** The finding kinds the daily run can report. A closed set, so a surface can render each one. */
export const LISTING_DRIFT = 'listing_drift'
export const LISTING_NOT_VERIFIED = 'listing_not_verified'

export type HealthFindingKind = typeof LISTING_DRIFT | typeof LISTING_NOT_VERIFIED

/**
 * A Business Profile listing as somebody believes it to be.
 *
 * Three fields, and `address` is the one that does the work. "Be Relax" is also the name of an airport
 * spa chain, so a title alone does not identify this business's listing — which is why the picker shows
 * the full address and why a drift check on the title alone would miss a listing that Google merged
 * into a different premises under the same name (docs/10 §5, G-CONN-05).
 */
export interface ListingSnapshot {
  readonly placeId: string
  readonly title: string
  readonly address: string
}

export type DriftedListingField = 'placeId' | 'title' | 'address'

export interface DriftedValue {
  readonly field: DriftedListingField
  /** What the owner confirmed. */
  readonly stored: string
  /** What Google returned just now. */
  readonly returned: string
}

/**
 * One finding for one listing, carrying every field that moved.
 *
 * **One finding, not one per field**, and that is a deliberate shape rather than a convenience. A
 * listing that moved premises changes its title *and* its address in the same edit, and reporting that
 * as two findings would tell the owner there are two problems — then a third when the `placeId`
 * changes with them. The action is the same in every case and there is one of it: look at the listing
 * and either confirm the new details or pick again.
 */
export interface ListingDriftFinding {
  readonly kind: typeof LISTING_DRIFT
  readonly capability: GoogleCapability
  /** The `placeId` the owner confirmed, so the finding is attributable after the listing has moved. */
  readonly placeId: string
  readonly drifted: readonly DriftedValue[]
}

/**
 * Collapses runs of whitespace and trims, and does nothing else.
 *
 * The line between the two mistakes available here. Comparing raw strings reports drift when Google
 * returns the same postal address with a doubled space in it — a difference nobody made and nobody can
 * act on, and the third false alarm is when the owner stops reading them. Normalising harder —
 * case-folding, stripping punctuation — hides drift that matters: a listing retitled `BE RELAX SPA` by
 * whoever now manages it is a real edit to the business's public identity, and one this check exists to
 * surface.
 *
 * The example is described rather than written out, because the address belongs in
 * `packages/db/src/seed/premises.ts` and nowhere else — `nap-literal-outside-the-seed` caught it here,
 * in a comment, which is exactly where a second copy of a business's address starts.
 *
 * `\s` with the `u` flag covers the non-breaking space Google's own UI inserts, which is the one
 * invisible difference that would otherwise read as a retitle.
 */
export function normaliseListingText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/** The fields on which two snapshots of one listing disagree. Empty when they agree. */
export function driftedFields(
  stored: ListingSnapshot,
  returned: ListingSnapshot,
): readonly DriftedValue[] {
  const fields: readonly DriftedListingField[] = ['placeId', 'title', 'address']
  const drifted: DriftedValue[] = []
  for (const field of fields) {
    // The `placeId` is an opaque identifier rather than prose, so it is compared as Google returned
    // it; normalising an identifier would be inventing an equivalence Google does not have.
    const a = field === 'placeId' ? stored[field] : normaliseListingText(stored[field])
    const b = field === 'placeId' ? returned[field] : normaliseListingText(returned[field])
    if (a !== b) drifted.push({ field, stored: a, returned: b })
  }
  return drifted
}

/**
 * The drift finding for one listing, or null when nothing moved.
 *
 * Null rather than an empty finding, so *"no drift"* is a value a caller cannot accidentally render as
 * a problem — which is the mistake the equivalent boolean invites.
 */
export function listingDriftFinding(args: {
  readonly capability: GoogleCapability
  readonly stored: ListingSnapshot
  readonly returned: ListingSnapshot
}): ListingDriftFinding | null {
  const drifted = driftedFields(args.stored, args.returned)
  if (drifted.length === 0) return null
  return {
    kind: LISTING_DRIFT,
    capability: args.capability,
    placeId: args.stored.placeId,
    drifted,
  }
}

/**
 * What one capability's probe established, in the vocabulary the health column understands.
 *
 * A closed union rather than the seven-class Google taxonomy, because the taxonomy answers *"what do
 * we do about this call"* and this answers *"what do we now know about this capability"* — and the two
 * differ in exactly the cases that matter. A rate limit is a fact about a call and no fact at all
 * about a capability, so it arrives here as `no_evidence` and the stored health survives.
 */
export type CapabilityProbe =
  /** The grant does not carry the scope, so no call was made. Decided before any I/O. */
  | { readonly kind: 'scope_missing'; readonly scope: string }
  /** A real read succeeded. The only thing that may write `ok`. */
  | { readonly kind: 'ok' }
  /** The read succeeded and said the listing is not verified with Google (Voice of Merchant). */
  | { readonly kind: 'listing_not_verified' }
  /** The taxonomy classified the failure as evidence about the capability itself. */
  | { readonly kind: 'evidence'; readonly health: GoogleCapabilityHealth }
  /** A blip: a rate limit, a 500, a dropped connection. Evidence of nothing. */
  | { readonly kind: 'no_evidence' }
  /** Nothing has been chosen for this capability yet, so there was nothing to read. */
  | { readonly kind: 'no_resource' }

/**
 * The health a capability carries after a probe.
 *
 * `ok` is written **only** by a successful read, which is the boundary G-CONN-02 and G-CONN-05 both
 * deferred to this unit: a consent proves the owner ticked the product and a `locations.get` proves the
 * resource resolves, and neither proves the legacy v4 reviews path works. So a granted scope resolves
 * to `unknown` at consent, a selection leaves `health` alone, and this function is the only thing in
 * the system that moves a capability to `ok`.
 *
 * The two branches that return the **existing** health are the substance. Writing amber on a working
 * capability because one call was throttled is the same mistake as marking a grant dead on a 500, and
 * its cost is identical: an owner who has been shown a fault that was not one ignores the next badge.
 */
export function healthAfterProbe(
  probe: CapabilityProbe,
  existing: GoogleCapabilityHealth,
): GoogleCapabilityHealth {
  switch (probe.kind) {
    case 'scope_missing':
      return 'permission_missing'
    case 'ok':
      return 'ok'
    case 'listing_not_verified':
      return 'not_verified'
    case 'evidence':
      return probe.health
    case 'no_evidence':
      // A blip. The capability is whatever it was before the connection dropped.
      return existing
    case 'no_resource':
      // Also unchanged, and for a different reason worth keeping distinct in the union: there is
      // nothing wrong with the capability, the onboarding step that chooses its resource is unfinished.
      return existing
  }
}

/**
 * Whether an authenticated call was made and answered.
 *
 * Deliberately **not** derived from the probe kind, which was the first shape of this and was wrong in
 * both directions. A Search Console property the account has lost access to produces
 * `evidence: permission_missing` from a `sites.list` that Google answered perfectly — the connection
 * works and the property does not — so reading the probe would have withheld `last_ok_at` from a
 * healthy grant. And `listing_not_verified` is likewise a *successful* read. Whether Google answered is
 * a fact about the call, so the caller records it as one.
 */
export interface CapabilityCall {
  readonly reachedGoogle: boolean
}

/** True when at least one authenticated call in the pass was answered. Drives `last_ok_at`. */
export function anyCallSucceeded(calls: readonly CapabilityCall[]): boolean {
  return calls.some((call) => call.reachedGoogle)
}

/**
 * The capability rows whose health is evidence about the **connection**.
 *
 * A consent registers a row for every capability the schema knows, which is four — and one of them,
 * `gbp_performance`, has no consumer, no adapter and no resolved API hostname (docs/10 §7). Nothing can
 * ever read it, so its health is permanently `unknown`, so `deriveConnectionHealth` would report every
 * connection in the system as `degraded` or `pending_gbp_approval` for ever. That is not a cosmetic
 * problem: an amber badge that is always on is a badge nobody looks at, and the badge is the mechanism
 * the whole unit exists to make trustworthy.
 *
 * So the derivation is taken over the capabilities somebody actually consumes, and the filter is
 * **scoped to the declared set** rather than to a health value. Filtering out `unknown` instead would
 * have been one character shorter and would have hidden the real case: a declared capability that no
 * pass has managed to exercise is exactly what the owner needs told about.
 *
 * `declared` is passed in because the consumer table lives in `@berelax/google` and core may not import
 * it — which is also what makes this function testable against a declared set of one.
 */
export function capabilityStatesForDisplay(args: {
  readonly rows: readonly CapabilityState[]
  readonly declared: readonly GoogleCapability[]
}): readonly CapabilityState[] {
  const declared = new Set(args.declared)
  return args.rows.filter((row) => declared.has(row.capability))
}

/**
 * True when calls were made on a connection and not one of them was answered.
 *
 * The condition docs/10 §4's hardest rule is written against: *a pg-boss job failure is not evidence
 * anybody has seen, because nobody reads `pgboss.job`.* A run in this state must leave a row the
 * owner's dashboard renders, and `false` for an empty list is the guard that stops a connection with no
 * capability to call at all — one where every scope is missing, so nothing was attempted — reporting a
 * total outage it never observed.
 */
export function everyCallFailed(calls: readonly CapabilityCall[]): boolean {
  return calls.length > 0 && !anyCallSucceeded(calls)
}
