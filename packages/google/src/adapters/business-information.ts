// Subpath import, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type {
  BusinessProfileProvider,
  GbpAccount,
  GbpLocation,
  GbpPostalAddress,
} from '@berelax/providers/google'
import { AppError } from '@berelax/shared'

/**
 * Business Information v1 — `locations.list` and `locations.get`, with `readMask` made non-optional.
 *
 * ## Why the read mask is enforced here rather than left to Google
 *
 * `readMask` is **mandatory** on both calls (docs/10 §7): Google answers 400 without one. Letting that
 * round trip happen would be merely wasteful; what makes it worth a guard is the *partial* mask, which
 * Google accepts happily. A mask without `metadata` returns locations with **no `placeId`**, and `placeId`
 * is what the picker dedupes by and what a selection persists. Deduping on a missing key merges two
 * different businesses into one row — this fixture set contains an unrelated airport spa also called
 * *Be Relax* — and a selection with no `placeId` cannot be re-resolved later, which is exactly the check
 * the daily health run exists to make (G-CONN-06).
 *
 * So the adapter refuses **before the transport is touched**, with two distinguishable reasons, and the one
 * mask this system sends lives in a single constant — `LOCATION_READ_MASK`. The refusal and the constant are
 * both needed: the constant is what stops a per-call mask becoming a per-call opportunity to omit the field
 * the next reader depends on, and the refusal is what catches the call that arrived without it anyway.
 *
 * ## What is deliberately not here
 *
 * No write path. `business.manage` has no read-only variant — *the scope that reads reviews also rewrites
 * the address and the opening hours* (docs/10 §3) — and the picker needs to read. A module that could also
 * PATCH would eventually be asked to, and a naive PATCH wipes the `specialHours` that carry Ramadan
 * variations. When a write is needed it arrives with its own narrow `updateMask` and its own module.
 */

/** `details.reason` on each refusal. A caller branches on these, never on prose. */
export const READ_MASK_MISSING = 'google_read_mask_missing'
export const READ_MASK_INCOMPLETE = 'google_read_mask_incomplete'

/**
 * The mask every location read in this system sends.
 *
 * `metadata` carries the `placeId`; `storefrontAddress` is what disambiguates two listings with the same
 * title, which is the whole job of the picker. `websiteUri` is here because Google's own Basic API Access
 * prerequisites require a website on the profile (docs/10 §1), so an empty one is worth showing the owner.
 */
export const LOCATION_READ_MASK: readonly string[] = [
  'name',
  'title',
  'storefrontAddress',
  'websiteUri',
  'metadata',
]

/** Fields that must be in any mask this system sends, because a later reader depends on each. */
export const REQUIRED_READ_MASK_FIELDS: readonly string[] = ['name', 'title', 'metadata']

/**
 * Refuses a read mask that Google would reject, or that would return an unusable location.
 *
 * Exported because it is the guard the acceptance criterion names: a call constructed without a mask must
 * be rejected *before* the transport sees it, and a guard nobody has watched fire is not a guard.
 */
export function assertReadMask(
  operation: 'locations.list' | 'locations.get',
  readMask: readonly string[] | undefined,
): asserts readMask is readonly string[] {
  if (readMask === undefined || readMask.length === 0) {
    throw new AppError(
      'invariant_violated',
      `${operation} was constructed with no readMask. Google answers 400, and the request would be ` +
        'spent proving what this check already knows (docs/10 §7).',
      { details: { reason: READ_MASK_MISSING, operation } },
    )
  }
  const missing = REQUIRED_READ_MASK_FIELDS.filter((field) => !readMask.includes(field))
  if (missing.length > 0) {
    throw new AppError(
      'invariant_violated',
      `${operation} was constructed with a readMask missing ${missing.join(', ')}. Google would accept ` +
        'it and answer without those fields: a location with no metadata carries no placeId, and the ' +
        'picker dedupes by placeId — two different businesses would merge into one row.',
      { details: { reason: READ_MASK_INCOMPLETE, operation, missing } },
    )
  }
}

/**
 * One location as the picker needs it: flattened, with the account it was found under.
 *
 * The account is carried because **v1 returns `locations/{l}` and the legacy v4 reviews path is
 * `accounts/{a}/locations/{l}/reviews`** (docs/10 §7). A selection that stored only the location would
 * leave the reviews adapter unable to build its own URL, and the account is not recoverable from the
 * location — it is the thing you enumerated under.
 */
export interface EnumeratedLocation {
  readonly account: string
  readonly accountName: string
  readonly accountType: GbpAccount['type']
  /** `locations/{location}`. */
  readonly location: string
  readonly title: string
  readonly placeId: string
  readonly address: string
  readonly websiteUri: string | null
}

/**
 * The address on one line, in the order a person in Abu Dhabi reads it.
 *
 * Built from the structured fields rather than from a single string, because the structured fields are what
 * the API returns and the one-line form is a rendering. An empty part is dropped rather than rendered as a
 * gap: an address with `, , Abu Dhabi` in it reads as a data fault and undermines the one screen whose
 * whole purpose is to make the owner confident they are looking at their own listing.
 */
export function oneLineAddress(address: GbpPostalAddress): string {
  return [...address.addressLines, address.locality, address.administrativeArea, address.postalCode]
    .filter((part): part is string => part !== undefined && part.trim() !== '')
    .join(', ')
}

function flatten(account: GbpAccount, location: GbpLocation): EnumeratedLocation {
  return {
    account: account.name,
    accountName: account.accountName,
    accountType: account.type,
    location: location.name,
    title: location.title,
    placeId: location.metadata.placeId,
    address: oneLineAddress(location.storefrontAddress),
    websiteUri: location.websiteUri ?? null,
  }
}

/**
 * Lists the locations under one account.
 *
 * The mask is a **required parameter that accepts `undefined`**, which looks odd and is the point. Making it
 * optional would let a call site forget it and silently inherit a default; making it non-nullable would put
 * the refusal beyond the reach of any test, because the compiler would reject the fixture instead — and a
 * guard nothing has watched fail is not a guard (ADR 0003). So forgetting the argument is a compile error,
 * passing a bad one is a refusal *before the transport is touched*, and the one call site in this package
 * passes `LOCATION_READ_MASK`.
 */
export async function listLocationsUnder(
  transport: Pick<BusinessProfileProvider, 'listLocations'>,
  account: GbpAccount,
  readMask: readonly string[] | undefined,
): Promise<readonly EnumeratedLocation[]> {
  assertReadMask('locations.list', readMask)
  const locations = await transport.listLocations({ parent: account.name, readMask })
  return locations.map((location) => flatten(account, location))
}

/**
 * One location as the daily health check needs it: no account, because it is not enumerating.
 *
 * A separate return shape from `EnumeratedLocation`, and the difference is the point. The picker found a
 * location *under an account* and has to persist which one, because the legacy v4 reviews path is built
 * from it. The health check already has the account — it is in the stored `resource_ref` — and is asking
 * a different question: *is the listing behind this reference still the listing the owner confirmed.*
 * Reusing the enumerated shape would have meant fabricating a `GbpAccount` to flatten against, and the
 * `accountName` and `type` on it would have been invented values in a structure that also carries real
 * ones (the brief's rule 15).
 */
export interface LocationSnapshot {
  /** `locations/{location}`, as returned. */
  readonly location: string
  readonly title: string
  readonly placeId: string
  readonly address: string
  readonly websiteUri: string | null
}

/**
 * Reads one location for comparison against what the owner confirmed.
 *
 * The mask is a required parameter that accepts `undefined` for the same reason `listLocationsUnder`'s
 * is: forgetting it must be a compile error, and passing a bad one must be a refusal *before* the
 * transport is touched — and a non-nullable parameter would put that refusal beyond the reach of any
 * test. Without `metadata` in the mask Google answers 200 with no `placeId` at all, and a drift check
 * comparing `undefined` against the stored id would report every listing as moved.
 */
export async function readLocationSnapshot(
  transport: Pick<BusinessProfileProvider, 'getLocation'>,
  locationName: string,
  readMask: readonly string[] | undefined,
): Promise<LocationSnapshot> {
  assertReadMask('locations.get', readMask)
  const location = await transport.getLocation({ name: locationName, readMask })
  return {
    location: location.name,
    title: location.title,
    placeId: location.metadata.placeId,
    address: oneLineAddress(location.storefrontAddress),
    websiteUri: location.websiteUri ?? null,
  }
}

/**
 * Re-reads one location, so a selection is confirmed against Google rather than against a stale list.
 *
 * The list the owner clicked may be seconds or minutes old, and a listing can be merged or moved between
 * accounts by Google itself. Re-reading costs one cheap call and is the difference between *"the owner
 * chose this"* and *"the owner chose something that was on the screen"*.
 */
export async function getLocationUnder(
  transport: Pick<BusinessProfileProvider, 'getLocation'>,
  account: GbpAccount,
  locationName: string,
  readMask: readonly string[] | undefined,
): Promise<EnumeratedLocation> {
  assertReadMask('locations.get', readMask)
  const location = await transport.getLocation({ name: locationName, readMask })
  return flatten(account, location)
}
