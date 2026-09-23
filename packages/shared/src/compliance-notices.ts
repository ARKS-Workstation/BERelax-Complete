/**
 * The compliance calendar's notice policy: the two setting keys, their bounds, their defaults, and the
 * job a change to either re-runs.
 *
 * Here for the reason `reminders.ts` is here, one file along. Four things that may not import each other
 * need these values to agree exactly: the F09 registry (`packages/config`), the rule that plans the
 * notices (`packages/core/src/compliance/obligation-notice.ts`), the readers
 * (`packages/db/src/settings/compliance.ts`) and the worker's job registry (`apps/worker`).
 * `packages/shared` is the leaf every one of them may import, so each string is written once and a
 * mismatch is not expressible.
 *
 * The same bounds are restated as CHECK constraints in migration 0060, and that duplication is
 * deliberate for 0051's reason: the database cannot import a TypeScript module, and a `reminder_9999d`
 * row would put a renewal notice in the calendar twenty-seven years before the renewal.
 *
 * ## Why the two windows are settings and not constants
 *
 * Because they are the two figures the owner will be wrong about first, and because changing them
 * changes **which notices are due** — which is exactly the case the registry's `rerunJobs` field exists
 * for. A constant would make the correction a deploy; a setting makes it a screen and a rebuild.
 */

/** How many days before a due date each reminder is sent. One spelling for four packages. */
export const OBLIGATION_REMINDER_OFFSETS_SETTING_KEY = 'compliance.obligation_reminder_offsets_days'

/** How many days after an unacknowledged due date each escalation is sent. */
export const OBLIGATION_ESCALATION_OFFSETS_SETTING_KEY =
  'compliance.obligation_escalation_offsets_days'

/**
 * 60, 30 and 7 days before the due date.
 *
 * Provisional against OPEN-QUESTIONS **Y1-licence**, which is the same open question the credential
 * warning window carries and for the same reason: docs/04 §1 and §7 mark the licence classification and
 * every renewal interval `[UNVERIFIED]`, so how long a renewal actually takes at ADDED, at Abu Dhabi
 * Municipality or at MOHRE is not on file. The lead time that should precede an unknown interval is
 * unknown with it.
 *
 * Three notices rather than one, and 60 days as the longest, because the failure is asymmetric: a notice
 * too early is noise somebody ignores, and a notice too late is a lapsed trade licence that blocks
 * publishing and a lapsed credential that takes a therapist off the rota with a day of bookings to
 * reassign by hand. The real answer is a settings change, not a migration.
 */
export const DEFAULT_OBLIGATION_REMINDER_OFFSETS_DAYS: readonly number[] = Object.freeze([
  60, 30, 7,
])

/**
 * 7 and 21 days after the due date, if nobody has acknowledged it.
 *
 * Also provisional against **Y1-licence**: an escalation interval is a judgement about how long a
 * renewal can safely sit unacknowledged, which follows from how long the renewal takes. A week is the
 * conservative first rung — short enough that the second rung still lands three weeks before a month has
 * passed — and the second exists because one escalation that nobody answers is a notice with nowhere
 * left to go.
 */
export const DEFAULT_OBLIGATION_ESCALATION_OFFSETS_DAYS: readonly number[] = Object.freeze([7, 21])

/**
 * A year. Beyond it the "reminder" precedes the previous renewal.
 *
 * An annual obligation generates one occurrence a year, so a lead time of 366 days or more would make
 * the notice for next year's renewal fall due before this year's — which reads, in the calendar, as a
 * reminder for the wrong cycle.
 */
export const MAX_OBLIGATION_NOTICE_OFFSET_DAYS = 365

/** At most four rungs on either ladder. More than four notices about one duty is not a ladder. */
export const MAX_OBLIGATION_NOTICE_OFFSETS = 4

/**
 * The queue a change to either window re-runs.
 *
 * Named here rather than in the worker for `REBUILD_SCHEDULED_STEPS_JOB`'s reason: the F09 registry
 * declares this string in `rerunJobs` and the worker registers a queue under it, and a registry naming
 * one string while the worker registers another declares a rebuild that never runs, with nothing to say
 * so.
 */
export const REBUILD_OBLIGATION_NOTICES_JOB = 'compliance.rebuild-obligation-notices'

/** The `agent_definition` row the compliance calendar's cron reports to (0060). */
export const COMPLIANCE_CALENDAR_AGENT = 'compliance_calendar'
