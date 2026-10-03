import { PILOT_FEEDBACK_CATEGORIES, PILOT_FEEDBACK_FIX_CATEGORIES } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { PILOT_FEEDBACK_REFUSALS, pilotFixUnitYaml, planPilotFeedback } from './feedback.ts'

/**
 * The taxonomy and the generator, with a control against every claim.
 *
 * The log here is SYNTHETIC and says so: the pilot has not run (Y12-pilot), so there is no real feedback
 * and an invented complaint in a committed fixture would be indistinguishable from a reported one. What
 * is being tested is the mechanism — which categories become units, which do not, and what a malformed
 * item does — and none of that needs a real complaint.
 */

const SYNTHETIC = [
  {
    id: 'SYN-1',
    category: 'too_many_steps',
    summary: 'synthetic fixture item: the walk-in flow asks twice for the same cell',
    reportedBy: 'the H-MIG-10 fixture',
    surface: 'quick-book',
  },
  {
    id: 'SYN-2',
    category: 'device_or_hardware',
    summary: 'synthetic fixture item: the receipt printer',
    reportedBy: 'the H-MIG-10 fixture',
    surface: 'till',
  },
  {
    id: 'SYN-3',
    category: 'wrong_default',
    summary: 'synthetic fixture item: a field starts on the wrong value',
    reportedBy: 'the H-MIG-10 fixture',
    surface: 'diary',
  },
  {
    id: 'SYN-4',
    category: 'not_a_defect',
    summary: 'synthetic fixture item: it works as intended and nobody had said so',
    reportedBy: 'the H-MIG-10 fixture',
    surface: 'diary',
  },
]

describe('the closed taxonomy', () => {
  it('names eight categories and exactly two of them produce no unit', () => {
    expect(PILOT_FEEDBACK_CATEGORIES).toHaveLength(8)
    const notUnits = PILOT_FEEDBACK_CATEGORIES.filter((entry) => !entry.fixUnit)
    expect(notUnits.map((entry) => entry.category)).toEqual(['device_or_hardware', 'not_a_defect'])
    // And each of the two says why, from the taxonomy itself: a category that produced nothing and gave
    // no reason is an item whoever reported it will raise again.
    for (const entry of notUnits) expect(entry.reason.length).toBeGreaterThan(20)
    for (const entry of PILOT_FEEDBACK_CATEGORIES.filter((e) => e.fixUnit)) {
      expect(entry.reason, entry.category).toBe('')
    }
    expect(PILOT_FEEDBACK_FIX_CATEGORIES).toHaveLength(6)
  })
})

describe('planning the fix units', () => {
  it('turns every fixable item into a unit with an id and reports the others', () => {
    const plan = planPilotFeedback(SYNTHETIC)
    expect(plan.units.map((unit) => unit.id)).toEqual(['H-PILOT-01', 'H-PILOT-02'])
    expect(plan.units.map((unit) => unit.feedbackId)).toEqual(['SYN-1', 'SYN-3'])
    // The ordinal is the position among the units, not in the LOG: a gap at H-PILOT-02 would read as a
    // unit somebody deleted.
    expect(plan.units[1]?.id).toBe('H-PILOT-02')
    expect(plan.notUnits.map((entry) => entry.feedbackId)).toEqual(['SYN-2', 'SYN-4'])
    expect(plan.notUnits[0]?.reason).toContain('Y14-devices')
    expect(plan.notUnits[1]?.reason).toContain('stop recording feedback')
    expect(plan.refused).toEqual([])
  })

  it('refuses an unknown category by name and names the eight it could have been', () => {
    const plan = planPilotFeedback([{ ...SYNTHETIC[0], category: 'slow-ish' }])
    expect(plan.units).toEqual([])
    expect(plan.refused[0]?.reason).toContain(PILOT_FEEDBACK_REFUSALS.unknownCategory)
    expect(plan.refused[0]?.reason).toContain('too_many_steps')
    expect(plan.refused[0]?.reason).toContain('not_a_defect')
  })

  it('refuses an item with no id, no summary, no reporter, or a repeated id', () => {
    const refusals = (items: readonly unknown[]) =>
      planPilotFeedback(items).refused.map((entry) => entry.reason)
    expect(refusals([{ ...SYNTHETIC[0], id: '  ' }])[0]).toContain(
      PILOT_FEEDBACK_REFUSALS.idMissing,
    )
    expect(refusals([{ ...SYNTHETIC[0], summary: '' }])[0]).toContain(
      PILOT_FEEDBACK_REFUSALS.summaryMissing,
    )
    expect(refusals([{ ...SYNTHETIC[0], reportedBy: '' }])[0]).toContain(
      PILOT_FEEDBACK_REFUSALS.reporterMissing,
    )
    // A repeated id would make two units point at one complaint, so the second is refused and the first
    // survives — the other way round would lose the item somebody actually reported first.
    const repeated = planPilotFeedback([SYNTHETIC[0], SYNTHETIC[0]])
    expect(repeated.units).toHaveLength(1)
    expect(repeated.refused[0]?.reason).toContain(PILOT_FEEDBACK_REFUSALS.duplicateId)
  })

  it('does not pass vacuously: an empty log produces no unit and no refusal', () => {
    // The control. Every assertion above is over a list, and a planner that returned empty lists for
    // everything would satisfy the refusal cases too.
    expect(planPilotFeedback([])).toEqual({ units: [], notUnits: [], refused: [] })
    expect(planPilotFeedback(SYNTHETIC).units.length).toBeGreaterThan(0)
  })
})

describe('the manifest fragment', () => {
  it('carries the id, the feedback it came from and the dependency', () => {
    const [unit] = planPilotFeedback(SYNTHETIC).units
    expect(unit).toBeDefined()
    const yaml = pilotFixUnitYaml(unit as never)
    expect(yaml).toContain('- id: H-PILOT-01')
    expect(yaml).toContain("id: 'SYN-1'")
    expect(yaml).toContain('category: too_many_steps')
    expect(yaml).toContain('- H-MIG-10')
  })

  it('doubles a quote in a reporter’s own words rather than emitting a file that parses wrong', () => {
    const plan = planPilotFeedback([{ ...SYNTHETIC[0], summary: "it won't let me pick a room" }])
    const yaml = pilotFixUnitYaml(plan.units[0] as never)
    expect(yaml).toContain("'it won''t let me pick a room'")
  })
})
