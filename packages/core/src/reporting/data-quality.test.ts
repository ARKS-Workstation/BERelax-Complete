import { describe, expect, it } from 'vitest'
import { localDate } from '../time.ts'
import {
  assertDataQuality,
  checksGating,
  DATA_QUALITY_CHECK_IDS,
  DATA_QUALITY_CHECKS,
  DATA_QUALITY_RULES,
  DATA_QUALITY_SUBJECTS,
  type DataQualityCheck,
  type DataQualityOutcome,
  type DataQualityReading,
  type DataQualityReadings,
  dataQualityFindings,
  datasetsOfKpi,
  GATED_FIGURE_STATES,
  type GatedFigure,
  gateFigure,
  gateKpi,
  judgeDataQuality,
  judgeDataQualityReading,
  outcomesGating,
  publishGatedFigure,
  resolveDataQualityCheck,
  STALE_VIEW_AFTER_MINUTES,
} from './data-quality.ts'
import { EMPTY_KPI_INPUT, type KpiInput, type KpiResult } from './kpi-expression.ts'
import { KPI_REGISTRY, resolveKpi } from './kpi-registry.ts'
import type { KpiOutcome } from './operational-kpis.ts'

/**
 * R-REP-07 — the gate that refuses to show an unsound figure.
 *
 * The claim this file is for is the one the acceptance line words as "no code path reaches a number
 * without a passing check", and it is made three ways because no one of them is enough on its own:
 *
 *   * **By type.** `publishGatedFigure` takes `Extract<GatedFigure, { state: 'value' }>`, so handing it
 *     a refusal does not compile. A test cannot assert that, which is why the control below is a
 *     `@ts-expect-error` — the one assertion in this file that fails if the type widens.
 *   * **By value.** Every state of the union is produced and the printed text is inspected for digits.
 *     A renderer that formatted a refusal would be caught even if the type permitted it.
 *   * **By rule.** Each detector in `dataQualityFindings` is handed a registry that violates it and
 *     required to report its own name, for ADR 0003's reason: a rule nobody has seen fire is not known
 *     to be a rule.
 *
 * The derivation of WHICH checks gate a figure is the other half, and it is asserted over the shipped
 * KPI registry rather than over a fixture, because the thing that can go wrong is a real KPI reaching no
 * check.
 */

/** A reading that holds. `left === right`, so the check passes whatever its relation is. */
const holding = (checkId: DataQualityCheck['id']): DataQualityReading => ({
  checkId,
  lastRanAtIso: '2026-10-03T02:00:00.000Z',
  observed: {
    left: { label: 'the facts', value: 1_000n },
    right: { label: 'the journal', value: 1_000n },
    offendingRows: 0,
  },
})

/** A reading that does not hold, by `by` in the check's own measure. */
const breaching = (checkId: DataQualityCheck['id'], by: bigint): DataQualityReading => ({
  checkId,
  lastRanAtIso: '2026-10-03T02:00:00.000Z',
  observed: {
    left: { label: 'the facts', value: 1_000n + by },
    right: { label: 'the journal', value: 1_000n },
    offendingRows: 1,
  },
})

/** A reading from a pass that has never run. */
const neverRun = (checkId: DataQualityCheck['id']): DataQualityReading => ({
  checkId,
  lastRanAtIso: null,
  observed: null,
})

const readings = (
  overrides: Partial<Record<DataQualityCheck['id'], DataQualityReading>> = {},
): DataQualityReadings => {
  const base = Object.fromEntries(DATA_QUALITY_CHECK_IDS.map((id) => [id, holding(id)])) as Record<
    DataQualityCheck['id'],
    DataQualityReading
  >
  return Object.freeze({ ...base, ...overrides })
}

const outcomesFor = (
  overrides: Partial<Record<DataQualityCheck['id'], DataQualityReading>> = {},
): readonly DataQualityOutcome[] => judgeDataQuality(readings(overrides))

describe('the shipped check registry', () => {
  it('is sound, and the rules are the ones a screen can print', () => {
    expect(() => assertDataQuality()).not.toThrow()
    expect(dataQualityFindings()).toEqual([])
    // The control: the rule names are distinct, so a finding cannot be reported under a name another
    // rule also uses.
    expect(new Set(DATA_QUALITY_RULES).size).toBe(DATA_QUALITY_RULES.length)
    expect(DATA_QUALITY_CHECKS.length).toBe(DATA_QUALITY_CHECK_IDS.length)
  })

  it('states the staleness window once, as the acceptance line gives it', () => {
    // 26 hours, in minutes. Asserted because the figure is the acceptance line's and not this build's:
    // a window quietly widened to 48 hours would make every freshness row pass for two days.
    expect(STALE_VIEW_AFTER_MINUTES).toBe(1_560)
  })

  it('resolves a registered check and refuses an unregistered name', () => {
    expect(resolveDataQualityCheck('ledger_vs_facts').measure).toBe('fils')
    expect(() => resolveDataQualityCheck('ledger_versus_facts')).toThrow(/No data-quality check/)
  })

  it('has view freshness attest every subject, which is what makes the coverage rule hold', () => {
    const freshness = resolveDataQualityCheck('view_freshness')
    expect([...freshness.attests].sort()).toEqual([...DATA_QUALITY_SUBJECTS].sort())
    // And the control in the other direction: at least one check attests LESS than everything, or the
    // gating derivation below would be the same answer for every figure.
    expect(
      DATA_QUALITY_CHECKS.some((check) => check.attests.length < DATA_QUALITY_SUBJECTS.length),
    ).toBe(true)
  })
})

describe('each rule has been seen to fire', () => {
  /** The shipped checks with one entry replaced. */
  const withCheck = (id: DataQualityCheck['id'], patch: Partial<DataQualityCheck>) =>
    DATA_QUALITY_CHECKS.map((check) => (check.id === id ? { ...check, ...patch } : check))

  const rulesFrom = (checks: readonly DataQualityCheck[]): readonly string[] =>
    dataQualityFindings({ checks }).map((finding) => finding.rule)

  it('reports a check registered out of declaration order', () => {
    const reordered = [...DATA_QUALITY_CHECKS].reverse()
    expect(rulesFrom(reordered)).toContain(
      'check-ids-are-unique-and-registered-in-declaration-order',
    )
  })

  it('reports an empty label and an empty summary', () => {
    expect(rulesFrom(withCheck('bot_share', { label: '  ' }))).toContain(
      'check-carries-a-label-and-a-summary',
    )
    expect(rulesFrom(withCheck('bot_share', { summary: '' }))).toContain(
      'check-carries-a-label-and-a-summary',
    )
  })

  it('reports a check that attests nothing, and one that attests a name nothing reads', () => {
    expect(rulesFrom(withCheck('bot_share', { attests: [] }))).toContain(
      'check-attests-a-known-subject',
    )
    expect(
      rulesFrom(
        withCheck('bot_share', {
          attests: ['sessionsThatDoNotExist' as (typeof DATA_QUALITY_SUBJECTS)[number]],
        }),
      ),
    ).toContain('check-attests-a-known-subject')
  })

  it('reports a check with no drill-down', () => {
    expect(
      rulesFrom(withCheck('bot_share', { drillDown: { relation: '', predicate: 'x' } })),
    ).toContain('check-declares-a-drill-down')
    expect(
      rulesFrom(withCheck('bot_share', { drillDown: { relation: 'x', predicate: '   ' } })),
    ).toContain('check-declares-a-drill-down')
  })

  it('reports a KPI dataset no check attests, which is the failure that looks like success', () => {
    // The mutation nobody would review as a defect: freshness narrowed from "everything" to the facts.
    // Every other rule still passes, every tile still renders, and the figures reading the dimensions
    // are suddenly gated by nothing at all.
    const narrowed = withCheck('view_freshness', { attests: ['revenueLines'] })
    const rules = rulesFrom(narrowed)
    expect(rules).toContain('every-kpi-dataset-is-attested-by-a-check')
    expect(rules).toContain('every-kpi-is-gated-by-at-least-one-check')
  })

  it('reports a KPI that reaches no check at all', () => {
    // Every check stripped of every subject but one that no measure reads. The registry is otherwise
    // intact, so this is the rule about the KPIs rather than about the datasets.
    const blinded = DATA_QUALITY_CHECKS.map((check) => ({
      ...check,
      attests: ['conversionDispatches' as const],
    }))
    expect(rulesFrom(blinded)).toContain('every-kpi-is-gated-by-at-least-one-check')
  })

  it('throws naming the rules that fired', () => {
    expect(() => assertDataQuality({ checks: withCheck('bot_share', { attests: [] }) })).toThrow(
      /check-attests-a-known-subject/,
    )
  })
})

describe('a reading becomes an outcome', () => {
  it('reads unknown, never pass, for a check that has never run', () => {
    const outcome = judgeDataQualityReading(neverRun('ledger_vs_facts'))
    expect(outcome.state).toBe('unknown')
    expect(outcome.observed).toBeNull()
    expect(outcome.lastRanAtIso).toBeNull()
    expect(outcome.detail).toMatch(/never run/)
    // The control: the same check with a reading passes, so "unknown" is about the absence and not
    // about the check.
    expect(judgeDataQualityReading(holding('ledger_vs_facts')).state).toBe('pass')
  })

  it('fails on one fils, in both directions', () => {
    for (const by of [1n, -1n]) {
      const outcome = judgeDataQualityReading(breaching('ledger_vs_facts', by))
      expect(outcome.state).toBe('fail')
      expect(outcome.observed?.variance).toBe(by)
      expect(outcome.detail).toContain('variance')
    }
  })

  it('treats a bound as a bound and an identity as an identity', () => {
    // `view_freshness` is `at_most`, so a view YOUNGER than the window holds. The same figures under an
    // `equals` check do not, which is the control that the relation is read at all.
    const younger: DataQualityReading = {
      checkId: 'view_freshness',
      lastRanAtIso: '2026-10-03T02:00:00.000Z',
      observed: {
        left: { label: 'oldest view age', value: 120n },
        right: { label: 'the staleness window', value: BigInt(STALE_VIEW_AFTER_MINUTES) },
        offendingRows: 0,
      },
    }
    expect(judgeDataQualityReading(younger).state).toBe('pass')
    expect(judgeDataQualityReading(breaching('ledger_vs_facts', -1n)).state).toBe('fail')
  })

  it('calls an overdue view stale rather than failed', () => {
    const overdue: DataQualityReading = {
      checkId: 'view_freshness',
      lastRanAtIso: '2026-10-01T02:00:00.000Z',
      observed: {
        left: { label: 'oldest view age', value: BigInt(STALE_VIEW_AFTER_MINUTES + 1) },
        right: { label: 'the staleness window', value: BigInt(STALE_VIEW_AFTER_MINUTES) },
        offendingRows: 1,
      },
    }
    expect(judgeDataQualityReading(overdue).state).toBe('stale')
  })

  it('judges every registered check, in registry order', () => {
    const judged = judgeDataQuality(readings())
    expect(judged.map((outcome) => outcome.check.id)).toEqual([...DATA_QUALITY_CHECK_IDS])
    expect(judged.every((outcome) => outcome.detail.trim() !== '')).toBe(true)
  })
})

describe('which checks gate which figure, derived rather than declared', () => {
  it('finds the checks that attest a subject', () => {
    expect(checksGating(['revenueLines']).map((check) => check.id)).toEqual([
      'ledger_vs_facts',
      'rollup_vs_raw',
      'view_freshness',
    ])
    expect(checksGating(['analyticsSessions']).map((check) => check.id)).toEqual([
      'ref_capture',
      'bot_share',
      'view_freshness',
    ])
    // The control: a subject nothing attests gates nothing, so the intersection is doing work.
    expect(checksGating([])).toEqual([])
  })

  it('derives a KPI’s datasets from the measures it reaches, through another KPI', () => {
    const revparh = resolveKpi('revenue_per_available_room_hour')
    const datasets = datasetsOfKpi(revparh)
    // RevPARH divides treatment revenue by available room hours, and the denominator is reached only
    // through `available_room_hours` and then `available_room_minutes` — so `businessDays` and
    // `roomDays` are in the answer only if the walk follows a KPI reference twice rather than stopping
    // at the direct measures. That is the whole difference between derived dependence and a list.
    expect(datasets).toContain('revenueLines')
    expect(datasets).toContain('businessDays')
    expect(datasets).toContain('roomDays')
    expect(datasets.every((subject) => DATA_QUALITY_SUBJECTS.includes(subject))).toBe(true)
  })

  it('gates every shipped KPI with at least one check', () => {
    const ungated = KPI_REGISTRY.kpis.filter((kpi) => checksGating(datasetsOfKpi(kpi)).length === 0)
    expect(ungated.map((kpi) => kpi.id)).toEqual([])
    // And the non-vacuity floor: there are KPIs to gate.
    expect(KPI_REGISTRY.kpis.length).toBeGreaterThan(5)
  })

  it('narrows a full outcome set to the gating ones', () => {
    const all = outcomesFor()
    const gating = outcomesGating(all, ['conversionDispatches'])
    expect(gating.map((outcome) => outcome.check.id)).toEqual([
      'dispatch_reconciliation',
      'view_freshness',
    ])
    expect(gating.length).toBeLessThan(all.length)
  })
})

describe('the gate', () => {
  const measured: KpiOutcome<string> = { state: 'value', value: '1.0000' }

  it('passes a figure through when every gating check holds', () => {
    expect(gateFigure(measured, outcomesFor())).toEqual(measured)
  })

  it('refuses an unreconciled figure, and carries no value field', () => {
    const gated = gateFigure(
      measured,
      outcomesGating(outcomesFor({ ledger_vs_facts: breaching('ledger_vs_facts', 1n) }), [
        'revenueLines',
      ]),
    )
    expect(gated.state).toBe('unreconciled')
    expect('value' in gated).toBe(false)
    if (gated.state !== 'unreconciled') throw new Error('narrowing')
    expect(gated.refusedBy.map((refusal) => refusal.checkId)).toEqual(['ledger_vs_facts'])
    expect(gated.why).toMatch(/cannot/)
  })

  it('distinguishes a check that disagreed from one that never ran', () => {
    const unattested = gateFigure(
      measured,
      outcomesGating(outcomesFor({ ledger_vs_facts: neverRun('ledger_vs_facts') }), [
        'revenueLines',
      ]),
    )
    expect(unattested.state).toBe('unattested')
    // The two must not be the same answer: reporting "never compared" as "they disagree" sends a reader
    // looking for a discrepancy that nothing has claimed exists.
    expect(unattested.state).not.toBe('unreconciled')
  })

  it('reports a disagreement in preference to a stale view, and lists both', () => {
    const gated = gateFigure(
      measured,
      outcomesGating(
        outcomesFor({
          ledger_vs_facts: breaching('ledger_vs_facts', 1n),
          view_freshness: breaching('view_freshness', 1n),
        }),
        ['revenueLines'],
      ),
    )
    expect(gated.state).toBe('unreconciled')
    if (gated.state !== 'unreconciled') throw new Error('narrowing')
    expect(gated.refusedBy.map((refusal) => refusal.checkId)).toEqual([
      'ledger_vs_facts',
      'view_freshness',
    ])
  })

  it('marks a figure stale when only the freshness check is out', () => {
    const gated = gateFigure(
      measured,
      outcomesGating(outcomesFor({ view_freshness: breaching('view_freshness', 1n) }), [
        'revenueLines',
      ]),
    )
    expect(gated.state).toBe('stale')
  })

  it('leaves an ADR 0070 refusal exactly as the KPI produced it', () => {
    // The gate adds states; it does not reinterpret the four that were already there. A gate that
    // relabelled `not_attributable` as `unreconciled` would make an unpriced cost look like a broken
    // reconciliation, and somebody would go looking for the discrepancy.
    const refusal: KpiOutcome<string> = {
      state: 'not_attributable',
      why: 'no unit cost basis',
      missing: ['therapist'],
      openQuestionIds: ['Y9-unit-cost-basis'],
    }
    expect(gateFigure(refusal, outcomesFor())).toEqual(refusal)
  })

  it('covers every state the union declares', () => {
    const produced = new Set<string>()
    for (const outcome of [
      { state: 'value', value: '1' } as KpiOutcome<string>,
      { state: 'no_denominator', why: 'x' } as KpiOutcome<string>,
      { state: 'no_data', why: 'x', missingFigures: [] } as KpiOutcome<string>,
      {
        state: 'not_attributable',
        why: 'x',
        missing: [],
        openQuestionIds: [],
      } as KpiOutcome<string>,
    ]) {
      produced.add(gateFigure(outcome, outcomesFor()).state)
    }
    for (const broken of [
      { ledger_vs_facts: breaching('ledger_vs_facts', 1n) },
      { ledger_vs_facts: neverRun('ledger_vs_facts') },
      { view_freshness: breaching('view_freshness', 1n) },
    ]) {
      produced.add(
        gateFigure(
          { state: 'value', value: '1' } as KpiOutcome<string>,
          outcomesGating(outcomesFor(broken), ['revenueLines']),
        ).state,
      )
    }
    expect([...produced].sort()).toEqual([...GATED_FIGURE_STATES].sort())
  })
})

describe('no code path reaches a number without a passing check', () => {
  const kpi = resolveKpi('room_utilisation')
  const DAY = localDate('2026-09-01')

  /**
   * An input that makes the utilisation KPI measurable, so the gate is the only thing refusing.
   *
   * `...EMPTY_KPI_INPUT` and never a cast: an empty dataset and an absent field are different claims to
   * the rule that holds a measure to the fields it declares, and a spread is what makes a dataset added
   * by a later unit arrive here empty rather than undefined.
   */
  const input: KpiInput = {
    ...EMPTY_KPI_INPUT,
    businessDays: [{ businessDay: DAY, openMinutes: 900 }],
    roomDays: [{ businessDay: DAY, roomId: 'room-1' }],
    appointments: [
      {
        businessDay: DAY,
        roomId: 'room-1',
        employeeId: 'employee-1',
        isDelivered: true,
        treatmentMinutes: 420,
        turnaroundMinutes: 30,
      },
    ],
  }

  it('publishes a figure when the gate lets it through', () => {
    const gated = gateKpi({ kpi, input, outcomes: outcomesFor() })
    expect(gated.state).toBe('value')
    if (gated.state !== 'value') throw new Error('narrowing')
    expect(publishGatedFigure(gated)).toMatch(/^[0-9.]+$/)
  })

  it('refuses the same figure when a gating check fails', () => {
    const gated = gateKpi({
      kpi,
      input,
      outcomes: outcomesFor({ rollup_vs_raw: breaching('rollup_vs_raw', 1n) }),
    })
    expect(gated.state).toBe('unreconciled')
  })

  it('cannot be asked to publish a refusal', () => {
    const gated: GatedFigure<KpiResult> = {
      state: 'unreconciled',
      why: 'x',
      refusedBy: [],
    }
    // The one assertion in this file that is about the TYPE and not about a value. If the parameter of
    // `publishGatedFigure` ever widens past the `value` state, this line stops erroring and the test
    // fails — which is the only way a test can hold a type.
    // @ts-expect-error a refusal is not a published figure, and that is the whole acceptance line
    expect(() => publishGatedFigure(gated)).toThrow()
  })
})
