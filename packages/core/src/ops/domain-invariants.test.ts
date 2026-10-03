import { describe, expect, it } from 'vitest'
import {
  DOMAIN_INVARIANT_RULES,
  DOMAIN_INVARIANTS,
  type DomainInvariantCensus,
  domainInvariantProblems,
  renderDomainInvariantCensus,
} from './domain-invariants.ts'

/**
 * The verdict over a census, and the floors that stop an empty one reading as a clean estate.
 *
 * The four claims themselves are proved against a real database in
 * `packages/fixtures/src/domain-invariants.itest.ts`, which plants one breach per claim with the
 * database's own guard dropped. What is proved here is the part that has no database in it: that a
 * census which examined nothing is refused, and that the report says so on its face.
 */

/** A census over a populated, clean estate. The control for every refusal below. */
const clean = (over: Partial<DomainInvariantCensus> = {}): DomainInvariantCensus => ({
  appointmentsExamined: 412,
  roomsExamined: 5,
  tradingDatesExamined: 149,
  afterMidnightExamined: 17,
  therapistOverlaps: [],
  roomsOverCapacity: [],
  pastClose: [],
  wrongBusinessDay: [],
  daysNotTrading: [],
  ...over,
})

const rules = (census: DomainInvariantCensus): readonly string[] =>
  domainInvariantProblems(census).map((problem) => problem.rule)

describe('the declared claims', () => {
  it('are the four docs/14 §3 names, in its order, each with where the rule is stated once', () => {
    expect(DOMAIN_INVARIANTS.map((invariant) => invariant.claim)).toEqual([
      'no double-booked therapist',
      'no room over capacity',
      'nothing scheduled past close once turnaround is counted',
      'an after-midnight slot resolves to the correct business day',
    ])
    for (const invariant of DOMAIN_INVARIANTS) {
      expect(invariant.oneStatement.length, invariant.id).toBeGreaterThan(80)
      expect(Object.values(DOMAIN_INVARIANT_RULES), invariant.id).toContain(invariant.rule)
    }
  })
})

describe('the verdict', () => {
  it('passes a populated, clean census — the control that makes every refusal informative', () => {
    expect(rules(clean())).toEqual([])
  })

  it('refuses a census that examined no appointment', () => {
    expect(rules(clean({ appointmentsExamined: 0 }))).toEqual([
      DOMAIN_INVARIANT_RULES.examinedNothing,
    ])
  })

  it('refuses a census that examined no room, and one that examined no trading date', () => {
    expect(rules(clean({ roomsExamined: 0 }))).toEqual([DOMAIN_INVARIANT_RULES.examinedNothing])
    expect(rules(clean({ tradingDatesExamined: 0 }))).toEqual([
      DOMAIN_INVARIANT_RULES.examinedNothing,
    ])
  })

  it('reports every breach of every kind, under the rule it was found under', () => {
    const census = clean({
      therapistOverlaps: [
        { rule: DOMAIN_INVARIANT_RULES.doubleBookedTherapist, detail: 'two at once' },
      ],
      roomsOverCapacity: [
        { rule: DOMAIN_INVARIANT_RULES.roomOverCapacity, detail: 'three in two' },
      ],
      pastClose: [{ rule: DOMAIN_INVARIANT_RULES.pastClose, detail: 'ends after close' }],
      wrongBusinessDay: [{ rule: DOMAIN_INVARIANT_RULES.wrongBusinessDay, detail: 'wrong day' }],
      daysNotTrading: [{ rule: DOMAIN_INVARIANT_RULES.dayNotTrading, detail: 'no such day' }],
    })
    expect(rules(census)).toEqual([
      DOMAIN_INVARIANT_RULES.doubleBookedTherapist,
      DOMAIN_INVARIANT_RULES.roomOverCapacity,
      DOMAIN_INVARIANT_RULES.pastClose,
      DOMAIN_INVARIANT_RULES.wrongBusinessDay,
      DOMAIN_INVARIANT_RULES.dayNotTrading,
    ])
  })
})

describe('the rendering', () => {
  it('marks each claim HOLDS or BREACH and prints what was examined', () => {
    const rendered = renderDomainInvariantCensus(clean())
    for (const invariant of DOMAIN_INVARIANTS) {
      expect(rendered, invariant.id).toContain(`HOLDS   ${invariant.id}`)
    }
    expect(rendered).toContain('examined: 412 appointment(s), 5 room(s), 149 trading date(s)')
    expect(rendered).toContain('VERDICT: all four hold')
  })

  it('says out loud when the after-midnight claim held over a population of zero', () => {
    // Brief rule 22: a property whose generator cannot exercise the claim holds for a resolver that is
    // completely wrong. Trading runs 11:00-02:00, so an estate with no after-midnight appointment has
    // not tested the fourth claim at all — and the figure that says so has to be printed on a PASSING
    // run or nobody will see it.
    expect(renderDomainInvariantCensus(clean({ afterMidnightExamined: 0 }))).toContain(
      'held over a population of zero',
    )
    expect(renderDomainInvariantCensus(clean())).not.toContain('held over a population of zero')
  })

  it('does not print that warning over an empty estate, where the floor is the real answer', () => {
    const empty = clean({ appointmentsExamined: 0, afterMidnightExamined: 0 })
    const rendered = renderDomainInvariantCensus(empty)
    expect(rendered).not.toContain('held over a population of zero')
    expect(rendered).toContain(DOMAIN_INVARIANT_RULES.examinedNothing)
  })

  it('counts the not-trading days under the close claim, which is what they break', () => {
    const rendered = renderDomainInvariantCensus(
      clean({
        daysNotTrading: [{ rule: DOMAIN_INVARIANT_RULES.dayNotTrading, detail: 'no such day' }],
      }),
    )
    expect(rendered).toContain('BREACH  NOTHING_PAST_CLOSE_WITH_TURNAROUND')
    expect(rendered).toContain('HOLDS   NO_DOUBLE_BOOKED_THERAPIST')
  })

  it('is deterministic over the same census', () => {
    expect(renderDomainInvariantCensus(clean())).toBe(renderDomainInvariantCensus(clean()))
  })
})
