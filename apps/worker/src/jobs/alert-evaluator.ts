import {
  type AlertVerdict,
  evaluateAlerts,
  firingAlerts,
  type Instant,
  unreadableThresholds,
} from '@berelax/core'
import {
  observeAlerts,
  raiseAlertNotification,
  raiseAlertThresholdFault,
  readAlertThresholdSettings,
  type Sql,
} from '@berelax/db'
import { complianceAsOf } from './obligation-reminders.ts'

/**
 * The alert pass: read the registry's observations, evaluate them, notify what fired.
 *
 * ## Why this runs inside the watchdog's pass and is not a cron of its own
 *
 * Because a cron of its own would be a cron nobody watches, which is the exact failure G-AGT-01 exists
 * to remove and which this unit is the next floor of. A scheduled job must name an `agent_definition`,
 * and a new agent must bring its own `agent_heartbeat` row in a migration — `pnpm jobs` refuses a cron
 * without the first and `agents.itest.ts` refuses one without the second. This unit has no migration
 * allocated, so the honest choice was between a second agent row nobody allocated a number for and
 * running inside a pass that is ALREADY watched. The watchdog is that pass: it runs every fifteen
 * minutes, it has `agent_watchdog` in `agent_definition` with a declared interval and a heartbeat row,
 * and its whole subject is finding the things nothing else is looking at.
 *
 * What that buys, concretely: the alerting path inherits the heartbeat contract. If this pass stops, the
 * watchdog's `last_success_at` goes stale and that is evidence in a row. What it does NOT buy is an
 * alert about its own absence — no pass can report that it did not happen — and that limitation is
 * `the-pass-cannot-report-its-own-absence` in `UNDEFENDED_BY_DESIGN` rather than a comment here.
 *
 * ## What a pass does and does not write
 *
 * One outbox event per NEWLY firing incident, deduplicated by `outbox_event.idempotency_key`, and
 * nothing at all for an alert that is clear. There is no alert table: the firing state is a measurement
 * over rows that already exist, so it clears itself, and a stored copy of it would be the brief's second
 * statement of a fact with the drifting copy on the row an operator reads.
 *
 * A `threshold_unreadable` verdict is published as a different event type, because a broken setting and
 * a broken business are different problems for different people — and because the one thing that must
 * not happen is a corrupt threshold reading as all-clear.
 */
export interface AlertEvaluationResult {
  readonly verdicts: readonly AlertVerdict[]
  /** Alert ids whose notification was inserted by THIS pass. Excludes an incident already notified. */
  readonly raised: readonly string[]
  /** Alert ids that are firing, whether or not this pass was the one that notified. */
  readonly firing: readonly string[]
  /** Alert ids whose threshold could not be read. Never counted as clear. */
  readonly faulted: readonly string[]
}

export async function runAlertEvaluation(sql: Sql, now: Instant): Promise<AlertEvaluationResult> {
  const nowIso = new Date(now).toISOString()
  // The trading date and not the calendar date, and `complianceAsOf` and not a fourth copy of the six
  // lines that compose it: trading runs 11:00-02:00, so at 01:30 the business is still working the
  // previous trading date and an obligation due that date is not yet overdue. It is the compliance
  // calendar's own as-of date, which is the point — the alert and the screen a reader compares it with
  // must not disagree about what "overdue" means. `packages/db` may not import core (ADR 0001), so the
  // date arrives at the observers as an argument.
  const tradingDate = await complianceAsOf(sql, nowIso)
  const settings = await readAlertThresholdSettings(sql)
  const observations = await observeAlerts(sql, { nowIso, tradingDate })
  const verdicts = evaluateAlerts(observations, settings)

  const raised: string[] = []
  for (const firing of firingAlerts(verdicts)) {
    // One transaction per notification rather than one for the batch: a duplicate key on the fifth
    // alert must not discard the four that were new, and `publishEvent` answers `null` for the
    // duplicate rather than throwing, so there is nothing to roll back either way.
    const inserted = await sql.begin(async (tx) =>
      raiseAlertNotification(tx as unknown as Sql, firing),
    )
    if (inserted !== null) raised.push(firing.alertId)
  }
  for (const fault of unreadableThresholds(verdicts)) {
    await sql.begin(async (tx) => raiseAlertThresholdFault(tx as unknown as Sql, fault))
  }

  return {
    verdicts,
    raised,
    firing: firingAlerts(verdicts).map((v) => v.alertId),
    faulted: unreadableThresholds(verdicts).map((v) => v.alertId),
  }
}
