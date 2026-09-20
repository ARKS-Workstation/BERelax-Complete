import type { Sql } from '../connection.ts'
import { readSetting } from '../settings-store.ts'

/**
 * The cancellation window, as it is stored (B-LIFE-03).
 *
 * `booking.cancellation_window_hours` is an F09 setting declared `provisional: true` against **Y9-windows**
 * with the note "24 hours, flagged only, no fee". Reading it is all this file does, and it returns the value
 * as `unknown` on purpose: NORMALISING it is `cancellationWindowHours` in `@berelax/core`, which
 * `packages/db` may not import, and a second normaliser here would be a second answer to "what is the
 * window" the first time a stored row went wrong.
 *
 * `readSetting` is the one read path for a setting — it checks the key against the F09 registry and throws
 * on an undeclared one, and it falls back to the registry's declared default so a freshly migrated database
 * with no `app_setting` row behaves exactly like a seeded one.
 *
 * The key is spelled in three packages that may not import each other: the registry (`packages/config`), the
 * rule (`packages/core`) and this reader. `appointment-reschedule.itest.ts` is where all three can be
 * imported at once, and it asserts the three spellings are one string and that the definition is still
 * `provisional`.
 */

/** `booking.cancellation_window_hours`. Provisionally 24 (Y9-windows), flagged only, no fee. */
export const CANCELLATION_WINDOW_SETTING_KEY = 'booking.cancellation_window_hours'

/**
 * The stored window, unnormalised.
 *
 * Deliberately not a `Promise<number>`. A reader that coerced would have to decide what `null` means, and
 * `Number(null)` is 0 — a window of zero, which is a LEGAL setting meaning "flag nothing". Handing the raw
 * value to core's normaliser keeps "the row is corrupt" and "the owner set zero" two different facts.
 */
export async function readCancellationWindow(sql: Sql): Promise<unknown> {
  return await readSetting<unknown>(sql, CANCELLATION_WINDOW_SETTING_KEY)
}
