import type { Sql } from '../connection.ts'
import { readSetting } from '../settings-store.ts'

/**
 * The reminder set, as it is stored (B-MSG-03).
 *
 * `booking.reminder_offsets_hours` is an F09 setting declared `provisional: true` against **Y9-windows**,
 * the same open question the cancellation window carries: nobody has told this build what the salon's
 * reminder policy is, so 24 hours and 2 hours are an assumption and are marked as one.
 *
 * Reading it is all this file does, and it returns `unknown` on purpose, exactly as `readCancellationWindow`
 * does and for the same reason: NORMALISING it is `reminderOffsetsFrom` in `@berelax/core`, which
 * `packages/db` may not import. Coercing on the way across would have to decide what a malformed row
 * means, and the honest answers differ — `[]` is a legal reminder set meaning "remind nobody", so a reader
 * that turned an unreadable value into an empty list would make a corrupt setting indistinguishable from
 * an owner who had deliberately turned reminders off.
 *
 * The key is spelled in three packages that may not import each other: the registry (`packages/config`),
 * the rule (`packages/core`) and this reader. `packages/fixtures/src/scheduled-step.itest.ts` is where all
 * three can be imported at once, and it asserts the three spellings are one string.
 */

/** `booking.reminder_offsets_hours`. Provisionally [24, 2] (Y9-windows). */
export const REMINDER_OFFSETS_SETTING_KEY = 'booking.reminder_offsets_hours'

/** The stored reminder set, unnormalised. See this module's header for why it is not a `number[]`. */
export async function readReminderOffsets(sql: Sql): Promise<unknown> {
  return await readSetting<unknown>(sql, REMINDER_OFFSETS_SETTING_KEY)
}
