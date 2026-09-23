/**
 * The reminder set: the setting key, its bounds, its default, and the job a change to it re-runs.
 *
 * Here for the reason `gender-matching.ts` is here. Four things that may not import each other need these
 * values to agree exactly: the F09 registry (`packages/config`), the rule that derives the keys
 * (`packages/core/src/lifecycle/invalidation-key.ts`), the reader (`packages/db/src/settings/reminders.ts`)
 * and the worker's job registry (`apps/worker`). `packages/shared` is the leaf every one of them may
 * import, so the string is written once and a mismatch is not expressible.
 *
 * The same bounds are restated as a CHECK constraint in migration 0051, and that duplication is
 * deliberate rather than an oversight: the database cannot import a TypeScript module, and a
 * `reminder_9999h` row would schedule a reminder for a year before the booking. The pair is kept honest by
 * `packages/fixtures/src/scheduled-step.itest.ts`, which asserts the constraint refuses exactly what the
 * schema here refuses.
 */

/** The registry key the reminder set is stored under. One spelling for four packages. */
export const REMINDER_OFFSETS_SETTING_KEY = 'booking.reminder_offsets_hours'

/**
 * 24 hours and 2 hours before the treatment.
 *
 * Provisional against OPEN-QUESTIONS **Y9-windows**, the same open question the cancellation window
 * carries: nobody has told this build what the salon's reminder policy is. Two reminders is the
 * conservative reading — one is easy to miss, and a third is what gets a sender identity reported — and
 * the pair is a SETTING precisely so that the real answer is a settings change rather than a migration.
 */
export const DEFAULT_REMINDER_OFFSETS_HOURS: readonly number[] = Object.freeze([24, 2])

/** A week. Beyond it the "reminder" arrives before the customer has thought about the appointment. */
export const MAX_REMINDER_OFFSET_HOURS = 168

/** At most four reminders about one appointment. More than that is not a reminder set, it is a campaign. */
export const MAX_REMINDER_OFFSETS = 4

/**
 * The queue a change to the reminder set re-runs.
 *
 * The F09 registry has carried a `rerunJobs` field since it was written, with the comment "Jobs to re-run
 * on change, e.g. rebuilding scheduled reminders". This is that job, and this constant is why the
 * registry's declaration and the worker's registration cannot be two different strings — which is the
 * failure that makes a declared rebuild never run and nothing say so.
 */
export const REBUILD_SCHEDULED_STEPS_JOB = 'messaging.rebuild-scheduled-steps'
