import { ALERT_REGISTRY, alertDefinition } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  type AlertObservation,
  evaluateAlert,
  evaluateAlerts,
  firingAlerts,
  resolveAlertThreshold,
  unreadableThresholds,
} from './evaluate.ts'

/**
 * The alert decision, and the third answer.
 *
 * Every case here is paired with a control that must come out differently, because the shape of failure
 * this whole unit is about is a check that reports all-clear while examining nothing — so "clear" is
 * never asserted without also showing that the same code can say "firing" about the same alert.
 */
const EXPORT = alertDefinition('customer_list_export')
const LAG = alertDefinition('outbox_lag')

const observation = (alertId: string, observed: number): AlertObservation =>
  ({ alertId, observed, incidentKey: `k-${observed}`, detail: {} }) as AlertObservation

const settings = (value: unknown) =>
  new Map<string, unknown>([['alerts.outbox_lag_seconds', value]])

const everyObservation = (observed: number) =>
  ALERT_REGISTRY.map((entry) => observation(entry.id, observed))

/** Every threshold setting at a value that is readable and very large. */
const generousSettings = () =>
  new Map<string, unknown>(
    ALERT_REGISTRY.flatMap((entry): readonly [string, unknown][] =>
      entry.threshold.kind === 'setting' ? [[entry.threshold.settingKey, 1_000_000]] : [],
    ),
  )

describe('resolveAlertThreshold', () => {
  it('reads a structural threshold without a lookup', () => {
    expect(resolveAlertThreshold(EXPORT, new Map())).toEqual({ value: 2 })
  })

  it('reads a setting threshold from the map', () => {
    expect(resolveAlertThreshold(LAG, settings(900))).toEqual({ value: 900 })
  })

  it('reports an absent setting as unreadable, and NOT as the registry default', () => {
    // Falling back would mean a cleared row silently restored a figure somebody had deliberately
    // changed, and the alert would then fire or not fire for a reason nothing on any screen explains.
    const resolved = resolveAlertThreshold(LAG, new Map())
    expect('unreadable' in resolved).toBe(true)
  })

  it.each([['fifteen'], [null], [undefined], [12.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'reports %o as unreadable rather than coercing it',
    (value) => {
      const resolved = resolveAlertThreshold(LAG, settings(value))
      expect('unreadable' in resolved, `${String(value)} was accepted`).toBe(true)
    },
  )
})

describe('evaluateAlert', () => {
  it('fires AT the threshold, not above it', () => {
    // A threshold is the point at which the condition is abnormal, so the figure is inside the alert.
    // The export alert is where this is visible: two subjects IS the bulk read.
    expect(evaluateAlert(EXPORT, observation('customer_list_export', 2), new Map()).kind).toBe(
      'firing',
    )
  })

  it('is clear below it, and the control is the case above', () => {
    const verdict = evaluateAlert(EXPORT, observation('customer_list_export', 1), new Map())
    expect(verdict.kind).toBe('clear')
    if (verdict.kind !== 'clear') throw new Error('unreachable')
    expect(verdict.observed).toBe(1)
    expect(verdict.threshold).toBe(2)
  })

  it('carries the severity and the runbook onto a firing verdict, so a notification can route itself', () => {
    const verdict = evaluateAlert(EXPORT, observation('customer_list_export', 9), new Map())
    if (verdict.kind !== 'firing') throw new Error('expected firing')
    expect(verdict.severity).toBe(EXPORT.severity)
    expect(verdict.runbook).toBe(EXPORT.runbook)
    expect(verdict.incidentKey).toBe('k-9')
  })

  it('answers threshold_unreadable rather than clear when the setting is corrupt', () => {
    // The case the whole three-valued verdict exists for. A comparison against NaN answers `false`,
    // which reads as "nothing is wrong" — and an alert reporting all-clear because its own
    // configuration is broken is the one outcome nothing would ever notice.
    const verdict = evaluateAlert(LAG, observation('outbox_lag', 99_999), settings('fifteen'))
    expect(verdict.kind).toBe('threshold_unreadable')
    if (verdict.kind !== 'threshold_unreadable') throw new Error('unreachable')
    expect(verdict.settingKey).toBe('alerts.outbox_lag_seconds')
    expect(verdict.reason).toContain('alerts.outbox_lag_seconds')
    // The control: the SAME observation against a readable threshold fires. So the verdict above is
    // about the configuration and not about the figure being too small.
    expect(evaluateAlert(LAG, observation('outbox_lag', 99_999), settings(900)).kind).toBe('firing')
  })
})

describe('evaluateAlerts', () => {
  it('returns one verdict per registered alert, in registry order', () => {
    const verdicts = evaluateAlerts(everyObservation(0), generousSettings())
    expect(verdicts.map((v) => v.alertId)).toEqual(ALERT_REGISTRY.map((e) => e.id))
  })

  it('refuses an incomplete set rather than reporting the rest as clear', () => {
    // A pass that observed five of six and reported five clears is indistinguishable from a quiet day,
    // which is the shape of failure this unit exists to remove.
    const short = everyObservation(0).slice(1)
    expect(() => evaluateAlerts(short, generousSettings())).toThrow(/No observation was supplied/)
  })

  it('refuses an observation for an alert nothing registers', () => {
    expect(() =>
      evaluateAlerts(
        [...everyObservation(0), observation('invented_alert', 1)],
        generousSettings(),
      ),
    ).toThrow(/ALERT_REGISTRY does not declare/)
  })

  it('separates the firing verdicts from the faults, and neither reads as the other', () => {
    const huge = everyObservation(1_000_000_000)
    const broken = new Map<string, unknown>(
      [...generousSettings()].map(([key]): [string, unknown] => [key, 'not a number']),
    )
    const verdicts = evaluateAlerts(huge, broken)
    // Every setting-thresholded alert is a fault; the structural ones still fire. That split is the
    // point: a corrupt settings table must not silence the alerts that need no setting.
    const structural = ALERT_REGISTRY.filter((e) => e.threshold.kind === 'structural').map(
      (e) => e.id,
    )
    expect(
      firingAlerts(verdicts)
        .map((v) => v.alertId)
        .sort(),
    ).toEqual([...structural].sort())
    expect(unreadableThresholds(verdicts).length).toBe(ALERT_REGISTRY.length - structural.length)
    // And the control: readable settings turn every one of them into a firing verdict instead.
    const readable = evaluateAlerts(
      huge,
      new Map([...generousSettings()].map(([k]): [string, unknown] => [k, 1])),
    )
    expect(firingAlerts(readable).length).toBe(ALERT_REGISTRY.length)
    expect(unreadableThresholds(readable)).toHaveLength(0)
  })
})
