import {
  BREACH_CLOCK_OPEN_QUESTION_ID,
  BREACH_NOTIFICATION_HOURS_SETTING_KEY,
} from '@berelax/shared'
import type { Sql } from '../connection.ts'
import { readSetting } from '../settings-store.ts'

/**
 * The one PDPL figure this build holds, and it is a `provisional` setting rather than a constant.
 *
 * docs/04 §8 marks Federal Decree-Law 45 of 2021 and its executive regulations `[UNVERIFIED]`, and says
 * in so many words to confirm *the breach notification threshold and deadline*. So 72 hours is the
 * build's reading of a secondary source. Holding it as a constant would make the correction a release
 * and — the part that matters more — would make it read, wherever it appeared, exactly like a figure
 * somebody had looked up. As a `provisional` F09 setting it appears on the Unconfirmed Assumptions panel
 * against {@link BREACH_CLOCK_OPEN_QUESTION_ID} and is corrected by one audited settings change.
 *
 * ## Why this returns a number and `readObligationReminderOffsets` returns `unknown`
 *
 * Those two return `unknown` because normalising a stored LADDER is a rule in `@berelax/core` and
 * because `[]` is a legal ladder meaning "send nothing" — so a reader that coerced could not tell a
 * corrupt row from a deliberate silence. Neither applies here. There is no legal value of this setting
 * that means "no deadline": the schema's floor is one hour, so anything a reader cannot turn into a
 * whole number of hours is a fault and not a choice. And the consumer is a pure function in
 * `@berelax/core` that throws on a period it cannot use, which is the behaviour this reader has to
 * preserve rather than paper over.
 *
 * It therefore throws, with the key in the message, rather than falling back. A fallback here would be
 * the invented figure in the one place nobody looks: the alert ladder's `threshold_unreadable` verdict
 * exists for the same reason one directory along, and this is the same argument about a statutory
 * deadline, where the cost of being quietly wrong is a missed notification.
 */

export { BREACH_NOTIFICATION_HOURS_SETTING_KEY } from '@berelax/shared'

export async function readBreachNotificationHours(sql: Sql): Promise<number> {
  const raw = await readSetting<unknown>(sql, BREACH_NOTIFICATION_HOURS_SETTING_KEY)
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new Error(
      `BreachPeriodUnreadable: "${BREACH_NOTIFICATION_HOURS_SETTING_KEY}" holds ` +
        `${JSON.stringify(raw) ?? 'undefined'}, which is not a whole number of hours. The breach ` +
        'clock is not defaulted here: a default would be an invented statutory period in the one ' +
        `place nobody looks. The figure is provisional against ${BREACH_CLOCK_OPEN_QUESTION_ID}.`,
    )
  }
  return raw
}
