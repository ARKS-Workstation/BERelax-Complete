import { describe, expect, it } from 'vitest'
import {
  ALERT_IDS,
  ALERT_REGISTRY,
  ALERT_SEVERITIES,
  ALERT_SURFACES,
  ALERT_THRESHOLD_SETTING_KEYS,
  alertDefinition,
  UNDEFENDED_BY_DESIGN,
} from './registry.ts'

/**
 * The registry's own invariants, and the two that only a test can state.
 *
 * `pnpm alerts` proves the claims that reach outside the file — the runbook heading, the setting, the
 * open question, the observer map. These are the claims about the table itself, plus the one thing the
 * gate cannot do: show that the module REFUSES a bad table, rather than that the committed table happens
 * to be good (ADR 0003's argument, applied to a module-load assertion).
 */
describe('the alert registry', () => {
  it('declares a severity, a threshold, a runbook, an audience and an SLO shape for every entry', () => {
    expect(ALERT_REGISTRY.length).toBeGreaterThan(0)
    for (const entry of ALERT_REGISTRY) {
      expect(ALERT_SEVERITIES, entry.id).toContain(entry.severity)
      expect(ALERT_SURFACES, entry.id).toContain(entry.route.surface)
      expect(entry.route.audience.length, entry.id).toBeGreaterThan(0)
      expect(entry.runbook, entry.id).toMatch(/^[a-z-]+#[a-z0-9-]+$/)
      expect(entry.slo.measuredFrom.length, entry.id).toBeGreaterThan(0)
      expect(entry.slo.windowDays, entry.id).toBeGreaterThan(0)
    }
  })

  it('carries no SLO target anywhere, which is the claim the type makes and this is the control', () => {
    // The control the type cannot be: `target: null` makes a figure inexpressible in a tree that
    // typechecks, and a tree where somebody widened the type would still pass every other case here.
    for (const entry of ALERT_REGISTRY) {
      expect(entry.slo.target, `${entry.id} has an SLO target`).toBeNull()
      expect(typeof entry.slo.target, entry.id).not.toBe('number')
    }
  })

  it('has one id per entry and resolves each of them', () => {
    expect(new Set(ALERT_IDS).size).toBe(ALERT_IDS.length)
    for (const id of ALERT_IDS) expect(alertDefinition(id).id).toBe(id)
  })

  it('refuses an id nothing registers, rather than answering with a default', () => {
    // An alert raised from a string is one nothing can route, threshold or document, and the failure
    // mode of a lenient lookup is a notification with no severity and no runbook.
    expect(() => alertDefinition('outbox_lagg')).toThrow(/No alert is registered as "outbox_lagg"/)
  })

  it('names every threshold setting exactly once, so two alerts cannot share a knob by accident', () => {
    expect(new Set(ALERT_THRESHOLD_SETTING_KEYS).size).toBe(ALERT_THRESHOLD_SETTING_KEYS.length)
  })

  it('states what is NOT defended, and every exception is named by an alert', () => {
    // The insider-threat exception. Non-empty is the assertion that matters: docs/06 D4 says the
    // realistic breach is somebody inside the business, the owner can read everything, and an empty
    // list here would claim a coverage this build does not have.
    expect(UNDEFENDED_BY_DESIGN.length).toBeGreaterThan(0)
    const named = new Set<string>(ALERT_REGISTRY.flatMap((e): readonly string[] => e.doesNotCover))
    for (const kase of UNDEFENDED_BY_DESIGN) {
      expect(named, `${kase.id} is defined and no alert names it`).toContain(kase.id)
      for (const field of [kase.what, kase.who, kase.why, kase.wouldNeed]) {
        expect(field.trim().length).toBeGreaterThan(29)
      }
    }
  })

  it('names the owner in the exception list, which is the one role the trail cannot constrain', () => {
    // Not decorative. The owner holds the widest grant in the F07 matrix and the database credential, so
    // every control in this registry is a detection control for that role and not a prevention one. An
    // exception list that did not say so would be the implied-coverage this unit exists to avoid.
    const owner = UNDEFENDED_BY_DESIGN.find((kase) => kase.id === 'owner-reads-everything')
    expect(owner, 'the owner exception is missing').toBeDefined()
    expect(owner?.why).toMatch(/second principal|auditor/i)
  })

  it('points a structural threshold at a file rather than repeating the figure', () => {
    for (const entry of ALERT_REGISTRY) {
      if (entry.threshold.kind !== 'structural') continue
      expect(entry.threshold.statedIn, entry.id).toMatch(/^(packages|apps|docs|scripts)\//)
    }
  })
})
