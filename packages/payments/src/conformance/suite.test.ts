import { parseConfig } from '@berelax/config'
import { FILS_CONVENTION, fixedClock } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { createFakeCardGateway } from '../adapters/fake-card.ts'
import { createManualGateway } from '../adapters/manual.ts'
import { createPaymentGateways } from '../registry.ts'
import {
  createSaboteurGateway,
  SABOTEUR_DEFECTS,
  SABOTEUR_EXPECTATIONS,
  SABOTEUR_PRIMARY_RULE,
  type SaboteurDefect,
} from './fixtures/saboteur.ts'
import {
  CONFORMANCE_RULE_IDS,
  CONFORMANCE_RULES,
  type ConformanceCandidate,
  describeReport,
  runPaymentGatewayConformance,
} from './suite.ts'

/**
 * The conformance suite, run against every adapter and against every way of breaking one.
 *
 * Three halves, and the third is the one that gives the other two meaning:
 *
 *   1. Every adapter the registry builds passes every rule, unmodified. The same suite, not a variant per
 *      adapter — that is what makes swapping in a real gateway a configuration change.
 *   2. Every rule is EVALUATED for every adapter. A capability flag must not be a way of skipping a case,
 *      so the result count is asserted equal to the declared rule count.
 *   3. Every deliberately broken fixture fails exactly the rules it breaks, by id, and the unbroken
 *      fixture passes. ADR 0003: a conformance suite nothing has ever failed is a suite that conforms to
 *      nothing.
 */

const CLOCK = '2026-09-28T19:30:00.000Z'

function testConfig(overrides: Record<string, string> = {}) {
  return parseConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/berelax_test',
    ...overrides,
  })
}

/** The candidates, taken from the registry rather than written down. */
const registry = createPaymentGateways({ config: testConfig(), clock: fixedClock(CLOCK) })

const CANDIDATES: readonly ConformanceCandidate[] = [
  { name: 'manual till', build: (deps) => createManualGateway(deps) },
  { name: 'fake card gateway', build: (deps) => createFakeCardGateway(deps) },
]

describe('every adapter in the registry is a conformance candidate', () => {
  it('has a candidate for every gateway the registry builds, and no more', () => {
    // Written as a name comparison rather than a count, because the failure this guards is a gateway added
    // to the registry with no candidate here — which a count would catch only until somebody added two.
    const built = registry.all.map((gateway) => gateway.name).sort()
    const exercised = CANDIDATES.map(
      (candidate) =>
        candidate.build({
          clock: fixedClock(CLOCK),
          records: registry.records,
          failures: registry.failures,
        }).name,
    ).sort()
    expect(exercised).toEqual(built)
  })
})

describe('the same conformance suite accepts every adapter, unmodified', () => {
  for (const candidate of CANDIDATES) {
    it(`${candidate.name} conforms`, async () => {
      const report = await runPaymentGatewayConformance(candidate)
      expect(report.conforms, describeReport(report)).toBe(true)
    })

    it(`${candidate.name} is measured against every declared rule, with none skipped`, async () => {
      // The hole a capability flag invites: an adapter that opts out of a rule by declaring itself unable.
      // Every rule checks both directions of every flag, so the count is exact for every adapter.
      const report = await runPaymentGatewayConformance(candidate)
      expect([...report.results.map((result) => result.ruleId)].sort()).toEqual([
        ...CONFORMANCE_RULE_IDS,
      ])
    })
  }
})

describe('the suite rejects a non-conforming adapter, by rule name', () => {
  const saboteur = (defect: SaboteurDefect): ConformanceCandidate => ({
    name: `saboteur(${defect})`,
    build: (deps) => createSaboteurGateway({ ...deps, defect }),
  })

  it('accepts the unbroken fixture, so every failure below is attributable to its defect', async () => {
    // The control. Without it, every rejection below could be explained by the fixture being generally
    // shoddy, and the rules would be measuring the fixture rather than the defect.
    const report = await runPaymentGatewayConformance(saboteur('none'))
    expect(report.conforms, describeReport(report)).toBe(true)
  })

  it('declares a defect for every rule, so no rule is unfalsifiable', () => {
    // A rule no fixture can break is a rule that has never been seen to fail, which is the state ADR 0003
    // says is indistinguishable from not having the rule at all.
    const covered = new Set(
      Object.values(SABOTEUR_PRIMARY_RULE).filter((id): id is string => id !== null),
    )
    expect([...covered].sort()).toEqual([...CONFORMANCE_RULE_IDS])
  })

  for (const defect of SABOTEUR_DEFECTS) {
    if (defect === 'none') continue
    it(`rejects "${defect}" and names exactly the rules it breaks`, async () => {
      const report = await runPaymentGatewayConformance(saboteur(defect))
      expect(report.conforms, describeReport(report)).toBe(false)
      // Set equality, not membership. A defect that starts failing an extra rule — or stops failing its
      // own — fails here rather than staying quietly red for a reason nobody checked.
      expect([...report.failed], describeReport(report)).toEqual([...SABOTEUR_EXPECTATIONS[defect]])
      const primary = SABOTEUR_PRIMARY_RULE[defect]
      expect(primary, `"${defect}" declares no primary rule`).not.toBeNull()
      expect(
        report.failed,
        `"${defect}" no longer fails ${String(primary)}, the rule it exists to break`,
      ).toContain(primary)
    })
  }

  it('reports the no-op adapter as failing the movement rule specifically', async () => {
    // The acceptance line, asserted as itself rather than inferred from the table above: "a deliberately
    // no-op adapter that returns success without writing a visible outbox or ledger record fails a named
    // conformance case".
    const report = await runPaymentGatewayConformance(saboteur('records-nothing'))
    const movement = report.results.find((result) => result.ruleId === 'records-every-movement')
    expect(movement?.passed).toBe(false)
    expect(movement?.detail).toMatch(/0 movements/)
  })
})

describe('the minor-unit edge has a caller', () => {
  it('has at least one adapter speaking a convention that is not ours', () => {
    // ADR 0007 requires a foreign convention to be converted at the adapter's edge and nowhere else. If
    // every adapter happened to speak fils, that requirement would ship untested: `toGatewayMinor` and
    // `fromGatewayMinor` would have no caller, and
    // `amounts-round-trip-through-the-declared-minor-units` would pass for every candidate without the
    // conversion ever running. So the claim is asserted about the registry rather than assumed.
    const foreign = registry.all.filter(
      (gateway) => gateway.minorUnits.exponent !== FILS_CONVENTION.exponent,
    )
    expect(
      foreign.map((gateway) => gateway.name),
      'no adapter converts at its edge, so the conversion the suite checks has no caller',
    ).not.toEqual([])
  })

  it('the control: our own convention is still the one amounts are stored in', () => {
    expect(FILS_CONVENTION.exponent).toBe(2)
    expect(registry.till.minorUnits.exponent).toBe(FILS_CONVENTION.exponent)
  })
})

describe('the rule set itself', () => {
  it('states an id, a title and a reason for every rule', () => {
    for (const rule of CONFORMANCE_RULES) {
      expect(rule.id).toMatch(/^[a-z][a-z0-9-]+$/)
      expect(rule.title.length).toBeGreaterThan(20)
      // The reason is what a reader needs when a rule fails and the adapter looks fine. A rule with no
      // stated consequence gets deleted by the next person who cannot see why it is there.
      expect(rule.why.length).toBeGreaterThan(80)
    }
  })

  it('has no duplicate ids', () => {
    expect(new Set(CONFORMANCE_RULE_IDS).size).toBe(CONFORMANCE_RULE_IDS.length)
  })
})
