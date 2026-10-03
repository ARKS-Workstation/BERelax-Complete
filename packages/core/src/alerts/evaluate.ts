import {
  ALERT_REGISTRY,
  type AlertDefinition,
  type AlertId,
  type AlertSeverity,
} from '@berelax/shared'

/**
 * The alert decision: an observation and a threshold in, a verdict out. Pure, clock injected by the
 * caller, and it reads the registry rather than a list of its own.
 *
 * ## Why the decision is here and not in the query
 *
 * Because there are three answers and not two. `observed >= threshold` is trivial arithmetic; what is
 * not trivial is that a threshold can be UNREADABLE — an `app_setting` row holding `"fifteen"`, or
 * holding `null` because somebody cleared it — and a query that compared a number against `NaN` would
 * answer `false`, which reads as "clear". An alert that reports all-clear because its own configuration
 * is corrupt is the worst of the three outcomes and the one nothing would notice, so it is a verdict
 * with a name (`threshold_unreadable`) and the evaluator's caller raises it as a fault.
 *
 * ## Why there is no stored alert row
 *
 * `agent_alert` (0021) stores one row per unbroken silence, deduplicated by an incident key, because the
 * thing it watches is an ABSENCE — there is no row that says "no run happened", so the alert itself has
 * to be the evidence. Every alert in this registry is the opposite: each one is a measurement over rows
 * that are already there, so the firing state is DERIVED and clears by itself when the rows change. A
 * second table holding "is this alert on" would be the brief's "a second statement of a fact drifts",
 * with the drifting copy on the row an operator reads — and clearing it would need a writer nobody would
 * remember to call. The notification is what needs deduplicating, not the state, and
 * `outbox_event.idempotency_key` already does that: the incident key is derived from the observation, so
 * a repeated pass inside one incident inserts nothing.
 */

/** What a reader measured for one alert. */
export interface AlertObservation {
  readonly alertId: AlertId
  /** The measured figure, in the entry's own threshold unit. */
  readonly observed: number
  /**
   * A label for the incident this observation belongs to.
   *
   * Derived from the observation and NOT from the clock, which is the whole trick: every pass during one
   * incident computes the same value, so the notification's idempotency key is stable and the second
   * pass inserts nothing. `agent_alert`'s comment says it from the other side — a watchdog running every
   * fifteen minutes would otherwise raise ninety-six notifications for one broken agent, and the
   * ninety-sixth is the one nobody reads.
   */
  readonly incidentKey: string
  /** What the operator needs in order to act, carried onto the notification. */
  readonly detail: Readonly<Record<string, unknown>>
}

export interface AlertFiring {
  readonly kind: 'firing'
  readonly alertId: AlertId
  readonly severity: AlertSeverity
  readonly runbook: string
  readonly observed: number
  readonly threshold: number
  readonly incidentKey: string
  readonly detail: Readonly<Record<string, unknown>>
}

export interface AlertClear {
  readonly kind: 'clear'
  readonly alertId: AlertId
  readonly observed: number
  readonly threshold: number
}

/**
 * The third answer. A threshold nobody can read is not a clear alert.
 *
 * `reason` names the setting and what was found, because the fault is in configuration and the person
 * who has to fix it needs the key.
 */
export interface AlertThresholdUnreadable {
  readonly kind: 'threshold_unreadable'
  readonly alertId: AlertId
  readonly settingKey: string
  readonly reason: string
}

export type AlertVerdict = AlertFiring | AlertClear | AlertThresholdUnreadable

/** Stored threshold settings, as read. `unknown` because a stored row may be anything at all. */
export type AlertThresholdSettings = ReadonlyMap<string, unknown>

/**
 * Resolves one entry's threshold to a number.
 *
 * A structural threshold needs no lookup: its figure is in the registry pointing at the migration that
 * owns it. A setting threshold is read from the map, and a value that is not a finite integer is a fault
 * rather than a fallback — falling back to the registry's declared default would mean a corrupt row
 * silently restored the figure somebody had deliberately changed.
 */
export function resolveAlertThreshold(
  entry: AlertDefinition,
  settings: AlertThresholdSettings,
): { readonly value: number } | { readonly unreadable: string; readonly settingKey: string } {
  if (entry.threshold.kind === 'structural') return { value: entry.threshold.value }
  const key = entry.threshold.settingKey
  if (!settings.has(key)) {
    return { settingKey: key, unreadable: `no value for "${key}" was read` }
  }
  const raw = settings.get(key)
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return {
      settingKey: key,
      unreadable: `"${key}" holds ${JSON.stringify(raw) ?? 'undefined'}, which is not a whole number`,
    }
  }
  return { value: raw }
}

/**
 * One verdict.
 *
 * `>=` and not `>`: a threshold is the point at which the condition is abnormal, so the figure itself is
 * inside the alert. The export alert is the one that makes the choice visible — its structural threshold
 * is two subjects, and an export covering exactly two subjects is the bulk read.
 */
export function evaluateAlert(
  entry: AlertDefinition,
  observation: AlertObservation,
  settings: AlertThresholdSettings,
): AlertVerdict {
  const threshold = resolveAlertThreshold(entry, settings)
  if ('unreadable' in threshold) {
    return {
      kind: 'threshold_unreadable',
      alertId: observation.alertId,
      settingKey: threshold.settingKey,
      reason: threshold.unreadable,
    }
  }
  if (observation.observed < threshold.value) {
    return {
      kind: 'clear',
      alertId: observation.alertId,
      observed: observation.observed,
      threshold: threshold.value,
    }
  }
  return {
    kind: 'firing',
    alertId: observation.alertId,
    severity: entry.severity,
    runbook: entry.runbook,
    observed: observation.observed,
    threshold: threshold.value,
    incidentKey: observation.incidentKey,
    detail: observation.detail,
  }
}

/**
 * Every verdict, in registry order, and it refuses an incomplete set.
 *
 * The refusal is the point. A pass that observed five of the six alerts and reported five clears would
 * be indistinguishable from a quiet day, which is the shape of failure this whole unit exists to remove
 * — so a missing observation throws by name instead. The caller's observer map is a
 * `Record<AlertId, …>` and cannot be written with a gap, which makes this unreachable through the
 * ordinary path; it is reachable through a reader that returned early on an error, which is exactly the
 * case that must not read as all-clear.
 */
export function evaluateAlerts(
  observations: readonly AlertObservation[],
  settings: AlertThresholdSettings,
): readonly AlertVerdict[] {
  const byId = new Map<string, AlertObservation>(observations.map((o) => [o.alertId, o]))
  const missing = ALERT_REGISTRY.filter((entry) => !byId.has(entry.id)).map((entry) => entry.id)
  if (missing.length > 0) {
    throw new Error(
      `No observation was supplied for ${missing.join(', ')}. An alert pass that silently skips a ` +
        'registered condition reports the same thing as a quiet day.',
    )
  }
  const unknown = observations.filter(
    (o) => !ALERT_REGISTRY.some((entry) => entry.id === o.alertId),
  )
  if (unknown.length > 0) {
    throw new Error(
      `Observations were supplied for ${unknown.map((o) => o.alertId).join(', ')}, which ALERT_REGISTRY ` +
        'does not declare. An alert raised from a string is one nothing can route, threshold or document.',
    )
  }
  return ALERT_REGISTRY.map((entry) => {
    const observation = byId.get(entry.id)
    if (observation === undefined) throw new Error(`unreachable: ${entry.id}`)
    return evaluateAlert(entry, observation, settings)
  })
}

/** The firing verdicts, for a caller that only wants to notify. */
export function firingAlerts(verdicts: readonly AlertVerdict[]): readonly AlertFiring[] {
  return verdicts.filter((v): v is AlertFiring => v.kind === 'firing')
}

/** The configuration faults, which a caller must not treat as clears. */
export function unreadableThresholds(
  verdicts: readonly AlertVerdict[],
): readonly AlertThresholdUnreadable[] {
  return verdicts.filter((v): v is AlertThresholdUnreadable => v.kind === 'threshold_unreadable')
}
