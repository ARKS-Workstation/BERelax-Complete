import { z } from 'zod'

/**
 * The EXPIRING_SOON window: the setting key, the provisional default and the schema bounding it.
 *
 * ## Why it is here and not in the module that applies it
 *
 * The same boundary `./gender-matching.ts` describes, and for the same three readers. `@berelax/config`
 * declares the setting and validates what may be written into it; `@berelax/db` reads the stored value
 * and hands it to the evaluator; `@berelax/core` is the evaluator. `packages/db` must never import
 * `packages/core`, and `packages/config` depends on this package alone — so a number spelled in core
 * would be re-spelled in the registry's `defaultValue`, and the day 60 becomes 90 one of the two learns
 * about it.
 *
 * ## 60 days is the build's choice, not anybody's answer
 *
 * docs/04 §7 lists the therapist screening requirements "**[UNVERIFIED]** … with renewal intervals", so
 * the renewal interval is unknown and the warning window that should precede it is unknown with it.
 * Sixty is the longest of the three obvious candidates (30, 60, 90), which makes it the conservative
 * one in the direction that matters: a warning that arrives too early is noise on a screen, and one that
 * arrives too late is a therapist removed from availability with no notice and a day of bookings to
 * reassign by hand. It is `provisional: true` against Y1-licence in the registry, so it is listed by the
 * Unconfirmed Assumptions query until a human confirms it.
 *
 * It is a warning and never a refusal: an employee whose every mandatory document is EXPIRING_SOON is
 * still eligible (`packages/core/src/hr/credentials.ts`). Widening the window therefore cannot make
 * anybody unbookable, which is why the setting is `operational` rather than `compliance_locked` — the
 * safety-critical settings are the ones that can relax a constraint, and this one has none to relax.
 */

/** The registry key. One spelling for the registry, the reader, the evaluator and the tests. */
export const CREDENTIAL_EXPIRING_SOON_SETTING_KEY = 'hr.credential_expiring_soon_days'

/**
 * The provisional window, in whole days.
 *
 * Exported so no call site writes `60` as a fall-back of its own. A fall-back spelled at the call site
 * is a second default, and the second one is the one nobody corrects.
 */
export const PROVISIONAL_EXPIRING_SOON_DAYS = 60

/**
 * What may be WRITTEN: a whole number of days from 0 to 365.
 *
 * Zero is legitimate and means "warn me on the day it expires", which is a policy somebody may hold.
 * The upper bound is a year because a window longer than the renewal cycle marks every document on file
 * as expiring soon, at which point the badge distinguishes nothing — a setting that can be configured
 * into meaninglessness is the "free-text box" docs/07 §2 declines to call configurable.
 *
 * Integer rather than a float, because the window is compared against a whole number of days between
 * two calendar dates: 60.5 days is a badge that appears at a time of day nobody can name.
 */
export const credentialExpiringSoonDaysSchema = z.number().int().min(0).max(365)
