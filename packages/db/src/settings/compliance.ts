import {
  OBLIGATION_ESCALATION_OFFSETS_SETTING_KEY,
  OBLIGATION_REMINDER_OFFSETS_SETTING_KEY,
} from '@berelax/shared'
import type { Sql } from '../connection.ts'
import { readSetting } from '../settings-store.ts'

/**
 * The compliance calendar's two notice ladders, as they are stored (M-VAT-11).
 *
 * Reading them is all this file does, and both return `unknown` on purpose — exactly as
 * `readReminderOffsets` does one file along, and for the same reason. NORMALISING a stored ladder is
 * `obligationNoticeOffsetsFrom` in `@berelax/core`, which `packages/db` may not import. Coercing on the
 * way across would have to decide what a malformed row means, and the honest answers differ: `[]` is a
 * legal ladder meaning "send nothing", so a reader that turned an unreadable value into an empty list
 * would make a corrupt setting indistinguishable from an owner who had deliberately switched the notices
 * off — and switching them off is a decision, not a fault.
 *
 * Both keys are spelled in three packages that may not import each other: the registry
 * (`packages/config`), the rule (`packages/core`) and this reader. They are re-exported from
 * `@berelax/shared` rather than typed again here, so there is one string and a mismatch is not
 * expressible; the itest in `apps/worker` is where all three can be imported at once and asserts it.
 *
 * ## Why a change to either re-runs a job
 *
 * Because it changes WHICH NOTICES ARE DUE. A ladder of [60, 30, 7] and a ladder of [45, 14] do not
 * merely differ in timing — they name different steps, so every pending notice built under the old one
 * carries a label the new one does not declare. The F09 registry's `rerunJobs` on both keys names
 * `compliance.rebuild-obligation-notices`, which supersedes the pending rows and plans the new set over
 * the SAME occurrences. Applying a new ladder only to occurrences generated afterwards would leave the
 * twelve months already in the calendar on the old timing, which is the half a default applied at
 * creation time misses.
 */

export {
  OBLIGATION_ESCALATION_OFFSETS_SETTING_KEY,
  OBLIGATION_REMINDER_OFFSETS_SETTING_KEY,
} from '@berelax/shared'

/** Days BEFORE a due date each reminder is sent. Provisionally [60, 30, 7] (Y1-licence). */
export async function readObligationReminderOffsets(sql: Sql): Promise<unknown> {
  return await readSetting<unknown>(sql, OBLIGATION_REMINDER_OFFSETS_SETTING_KEY)
}

/** Days AFTER an unacknowledged due date each escalation is sent. Provisionally [7, 21]. */
export async function readObligationEscalationOffsets(sql: Sql): Promise<unknown> {
  return await readSetting<unknown>(sql, OBLIGATION_ESCALATION_OFFSETS_SETTING_KEY)
}
