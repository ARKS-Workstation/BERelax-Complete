// Subpath import, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type {
  BusinessProfileProvider,
  GbpBusinessPeriod,
  GbpLocation,
  GbpSpecialHourPeriod,
} from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import {
  businessInformationEditLimit,
  type PerProfileRateLimit,
  type RateLimitClock,
} from '../rate-limit/token-bucket.ts'
import { assertReadMask, LOCATION_READ_MASK } from './business-information.ts'

/**
 * Business Information v1 `locations.patch` — the ONE write this build makes to a Google profile.
 *
 * It is a separate module from `business-information.ts` and that separation is load-bearing twice over.
 * The read adapter's own header says why it holds no write path: *"a module that could also PATCH would
 * eventually be asked to, and a naive PATCH wipes the `specialHours` that carry Ramadan variations."*
 * This is the module that arrives "with its own narrow `updateMask` and its own module". The second
 * reason is the consistency checker: `.dependency-cruiser.cjs`'s `gbp-consistency-check-is-read-only`
 * asserts `packages/google/src/seo/gbp-consistency.ts` cannot reach this file, which is only a checkable
 * claim while the write lives somewhere the checker could have imported and does not.
 *
 * ## The three refusals, and why each is before the transport
 *
 * docs/10 §7, in one clause: *"`updateMask` on patch. Hours use structured `periods`; Ramadan variations
 * belong in `specialHours` and a naive write wipes them — always read-modify-write with a narrow
 * `updateMask`, never PATCH the whole object."* Three different mistakes hide in that sentence and each
 * one is a separate refusal here, because each has a different fix:
 *
 *   1. **No mask.** Google answers 400 and the round trip is spent proving what this check knows.
 *   2. **A mask this build has not approved.** `UPDATABLE_FIELDS` is the closed set, and it holds one
 *      field. A patch of `storefrontAddress` is a change of the business's address on Google, and
 *      nothing in this build has the authority to make it — the NAP authority is the `premises` row and
 *      the direction of travel is from it, not towards it.
 *   3. **A payload wider than its mask.** This is the naive whole-object PATCH, and it is the one that
 *      destroys data rather than failing. A field mask CLEARS a named field the payload does not carry,
 *      so a request assembled from a full `getLocation` answer with `updateMask: ['*']` wipes every
 *      field the read mask did not cover — `specialHours` among them. The fake reproduces exactly that,
 *      so the refusal is asserted against a transport that would really have done it.
 *
 * All three throw before `transport.updateLocation` is called, which `business-information-write.test.ts`
 * asserts with a spy at zero calls rather than by reading this comment.
 *
 * ## Why the read-modify-write reads through the READ adapter
 *
 * `readLocationSnapshot` is not used — it flattens, and a patch needs the structured fields — but
 * `assertReadMask` and `LOCATION_READ_MASK` are, so there is one statement of which mask this system
 * sends. The modify step then sends **only** `regularHours`, so the write carries no copy of the fields
 * it read. That is what makes "the special hours survive" a property of the request rather than of the
 * server's merge behaviour.
 *
 * ## Why the rate limit is here and not at the call site
 *
 * The cap is per PROFILE and shared with the reviews path (docs/10 §7, and see
 * `../rate-limit/token-bucket.ts`). A limiter at the call site would be one limiter per caller, which is
 * no limiter at all: the eleventh edit of the minute is the eleventh across every caller.
 */

/** `details.reason` on each refusal. A caller branches on these, never on prose. */
export const UPDATE_MASK_MISSING = 'google_update_mask_missing'
export const UPDATE_MASK_NOT_APPROVED = 'google_update_mask_not_approved'
export const UPDATE_PAYLOAD_WIDER_THAN_MASK = 'google_update_payload_wider_than_mask'

/**
 * Every field this build may patch on a Google profile. One.
 *
 * A closed set rather than a convention, and short on purpose. The hours are the only profile field this
 * system holds a better answer for than the profile does — `premises_hours` is the authority (0003) and a
 * human has approved the change — and every other field is either copy somebody wrote on the profile or
 * part of the NAP, whose authority runs the other way. Widening this list is a decision, which is why it
 * is a list and not a parameter.
 */
export const UPDATABLE_FIELDS: readonly string[] = ['regularHours']

/**
 * Refuses a patch Google would reject, a patch nobody approved, and a patch that would destroy data.
 *
 * Exported because it is the guard the acceptance criterion names: *"a full-object PATCH fixture is
 * asserted to be refused by the adapter before the transport"*. A guard nobody has watched fire is not a
 * guard (ADR 0003).
 */
export function assertUpdateMask(
  updateMask: readonly string[] | undefined,
  payload: Partial<GbpLocation>,
): asserts updateMask is readonly string[] {
  if (updateMask === undefined || updateMask.length === 0) {
    throw new AppError(
      'invariant_violated',
      'locations.patch was constructed with no updateMask. Google answers 400, and a mask is also the ' +
        'only thing that stops a patch clearing the fields it did not mean to touch (docs/10 §7).',
      { details: { reason: UPDATE_MASK_MISSING } },
    )
  }
  const notApproved = updateMask.filter((field) => !UPDATABLE_FIELDS.includes(field))
  if (notApproved.length > 0) {
    throw new AppError(
      'invariant_violated',
      `locations.patch was constructed with an updateMask naming ${notApproved.join(', ')}. This build ` +
        `may patch ${UPDATABLE_FIELDS.join(', ')} and nothing else: '*' is the whole-object PATCH that ` +
        'wipes the Ramadan specialHours, and the address and the title are the premises row’s to ' +
        'state rather than this system’s to overwrite.',
      { details: { reason: UPDATE_MASK_NOT_APPROVED, notApproved } },
    )
  }
  // The payload may carry NOTHING the mask does not name. A request assembled from a whole `getLocation`
  // answer is the naive write even when its mask is narrow: the extra fields are ignored today and are
  // one mask edit away from being sent, and a reviewer reading the call site cannot tell which.
  const beyond = Object.keys(payload).filter(
    (field) => field !== 'name' && !updateMask.includes(field),
  )
  if (beyond.length > 0) {
    throw new AppError(
      'invariant_violated',
      `locations.patch was constructed with a payload carrying ${beyond.join(', ')}, which its ` +
        'updateMask does not name. A read-modify-write sends only the fields it is changing; a request ' +
        'built from a whole location is the PATCH docs/10 §7 forbids, one mask edit away from wiping ' +
        'every field it carries a stale copy of.',
      { details: { reason: UPDATE_PAYLOAD_WIDER_THAN_MASK, beyond } },
    )
  }
}

/** What a human approved: the weekly periods, and nothing else. */
export interface ApprovedHoursUpdate {
  /** `locations/{location}`, from the stored `resource_ref`. Never built from configuration. */
  readonly locationName: string
  readonly periods: readonly GbpBusinessPeriod[]
}

export interface HoursWriteResult {
  /** The periods as the profile now holds them. */
  readonly periods: readonly GbpBusinessPeriod[]
  /**
   * The dated variations as the profile held them BEFORE the write, and as it holds them after.
   *
   * Both, on the result, rather than a boolean this module computed. This is the fact the whole write
   * path is shaped around — docs/10 §7's *"a naive write wipes them"* — and the honest form of the claim
   * is the two lists a caller can compare for itself. A `specialHoursUnchanged: true` would be the
   * module under test grading its own work, and it would read the same if both lists were empty.
   */
  readonly specialHourPeriodsBefore: readonly GbpSpecialHourPeriod[]
  readonly specialHourPeriodsAfter: readonly GbpSpecialHourPeriod[]
}

export interface HoursWriteDeps {
  readonly transport: Pick<BusinessProfileProvider, 'getLocation' | 'updateLocation'>
  /**
   * The per-profile edit limiter.
   *
   * An argument so the reviews path and this one can share ONE window for one profile, which is what
   * the 10-per-minute cap is a claim about. `businessInformationEditLimit` builds the right shape; a
   * caller that has no limiter gets {@link hoursLimitFor}.
   */
  readonly limit: PerProfileRateLimit
}

/** The limiter for a caller that has none of its own. One per profile — see the module header. */
export function hoursLimitFor(clock: RateLimitClock): PerProfileRateLimit {
  return businessInformationEditLimit(clock)
}

/**
 * Applies a human-approved weekly-hours change, read-modify-write, with a one-field mask.
 *
 * The read is what makes this a read-modify-write rather than a write: it is how the caller learns what
 * the profile held, and it is what the result's before-and-after pair of `specialHourPeriods` is built
 * from. It is deliberately NOT used to build the payload — that is the whole point — so the only field
 * that leaves this process is `regularHours`.
 */
export async function applyApprovedHours(
  deps: HoursWriteDeps,
  update: ApprovedHoursUpdate,
): Promise<HoursWriteResult> {
  if (update.periods.length === 0) {
    // A mask naming `regularHours` with no periods CLEARS the hours on the profile. That is a legitimate
    // API call and never a thing a human meant by "update the hours", so it is refused here rather than
    // reaching Google as an accidental erasure.
    throw new AppError(
      'invariant_violated',
      'An approved hours update carries no periods. Patching regularHours with an empty period list ' +
        'clears the trading hours on the Google profile, which is not what an approval to change them ' +
        'means — a profile with no hours is one Google will not show opening times for at all.',
      { userFacing: true, details: { reason: 'google_hours_update_empty' } },
    )
  }
  assertReadMask('locations.get', LOCATION_READ_MASK)
  const before = await deps.transport.getLocation({
    name: update.locationName,
    readMask: LOCATION_READ_MASK,
  })

  const payload: Partial<GbpLocation> = { regularHours: { periods: update.periods } }
  const updateMask: readonly string[] = ['regularHours']
  assertUpdateMask(updateMask, payload)

  const after = await deps.limit.run(async () =>
    deps.transport.updateLocation({ name: update.locationName, location: payload, updateMask }),
  )
  return {
    periods: after.regularHours?.periods ?? [],
    specialHourPeriodsBefore: before.specialHours?.specialHourPeriods ?? [],
    specialHourPeriodsAfter: after.specialHours?.specialHourPeriods ?? [],
  }
}
