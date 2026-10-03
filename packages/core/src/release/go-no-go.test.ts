import { describe, expect, it } from 'vitest'
import {
  GO_NO_GO_REQUIREMENTS,
  GO_NO_GO_RULES,
  type GoNoGoFinding,
  type GoNoGoRequirement,
  releaseGoNoGoVerdict,
  renderReleaseGoNoGo,
} from './go-no-go.ts'

/**
 * The go/no-go verdict, and the thing that makes it worth having: it can say NO, and it says it about
 * exactly the requirement that is unmet.
 *
 * Every assertion here is paired with a control, because every one of them is a difference against a
 * list and a difference against an empty list is empty (ADR 0002, ADR 0003). The pairs matter most in
 * the two directions a release gate rots: a verdict that cannot refuse, and a verdict that refuses
 * everything and is therefore switched off.
 */

/** Every declared requirement, met. The control for every refusal below. */
const allMet = (): readonly GoNoGoFinding[] =>
  GO_NO_GO_REQUIREMENTS.map((requirement) => ({
    id: requirement.id,
    state: 'met' as const,
    detail: `${requirement.id} cleared by a fixture`,
  }))

const problemRules = (findings: readonly GoNoGoFinding[]): readonly string[] => {
  const verdict = releaseGoNoGoVerdict(findings)
  return verdict.go ? [] : verdict.problems.map((problem) => problem.rule)
}

describe('the requirement list', () => {
  it('declares the six items H-MIG-11 names, each with an id, a reason and what answers it', () => {
    expect(GO_NO_GO_REQUIREMENTS.map((requirement) => requirement.id)).toEqual([
      'external-items-cleared',
      'milestones-demonstrated',
      'restore-drill-current',
      'security-findings-clear',
      'three-clean-dry-runs',
      'provisional-settings-confirmed',
    ])
    for (const requirement of GO_NO_GO_REQUIREMENTS) {
      expect(requirement.why.length, requirement.id).toBeGreaterThan(80)
      expect(requirement.answeredBy.length, requirement.id).toBeGreaterThan(20)
      expect(requirement.label.length, requirement.id).toBeGreaterThan(8)
    }
  })

  it('names no threshold of its own, because each one belongs to the check that owns it', () => {
    // The minimum of three dry runs, the blocking severities and the maximum drill age are each stated
    // once, elsewhere. A copy here would be the second statement that drifts — and it would be the one
    // the release gate read.
    const text = GO_NO_GO_REQUIREMENTS.map((r) => `${r.why} ${r.answeredBy}`).join(' ')
    expect(text).not.toMatch(/\b\d+\s*days?\b/)
  })
})

describe('the verdict', () => {
  it('says go when every requirement is met — the control that makes a NO informative', () => {
    const verdict = releaseGoNoGoVerdict(allMet())
    expect(verdict.go).toBe(true)
    expect(verdict.examined).toBe(GO_NO_GO_REQUIREMENTS.length)
    expect(verdict.items.every((item) => item.state === 'met')).toBe(true)
  })

  it('names exactly the one unmet requirement and no other', () => {
    const findings = allMet().map((finding) =>
      finding.id === 'three-clean-dry-runs'
        ? { ...finding, state: 'unmet' as const, detail: 'only two runs are recorded' }
        : finding,
    )
    const verdict = releaseGoNoGoVerdict(findings)
    expect(verdict.go).toBe(false)
    if (verdict.go) return
    expect(verdict.problems).toHaveLength(1)
    expect(verdict.problems[0]?.rule).toBe(GO_NO_GO_RULES.unmet)
    expect(verdict.problems[0]?.detail).toContain('three-clean-dry-runs')
    expect(verdict.problems[0]?.detail).toContain('only two runs are recorded')
    for (const other of GO_NO_GO_REQUIREMENTS) {
      if (other.id === 'three-clean-dry-runs') continue
      expect(verdict.problems[0]?.detail).not.toContain(other.id)
    }
  })

  it('names every unmet requirement when several are, rather than the first', () => {
    const findings = allMet().map((finding) =>
      finding.id === 'external-items-cleared' || finding.id === 'security-findings-clear'
        ? { ...finding, state: 'unmet' as const, detail: `${finding.id} refused` }
        : finding,
    )
    const verdict = releaseGoNoGoVerdict(findings)
    expect(verdict.go).toBe(false)
    if (verdict.go) return
    expect(verdict.problems.map((problem) => problem.detail.split(':')[0])).toEqual([
      'external-items-cleared',
      'security-findings-clear',
    ])
  })

  it('blocks on an UNKNOWN as hard as on an unmet, and says which it was', () => {
    const findings = allMet().map((finding) =>
      finding.id === 'restore-drill-current'
        ? { ...finding, state: 'unknown' as const, detail: 'no maximum age is configured' }
        : finding,
    )
    const verdict = releaseGoNoGoVerdict(findings)
    expect(verdict.go).toBe(false)
    if (verdict.go) return
    expect(verdict.problems).toHaveLength(1)
    expect(verdict.problems[0]?.rule).toBe(GO_NO_GO_RULES.unknown)
    // Distinguishable to a reader, and not to the verdict. Both halves are the claim.
    expect(verdict.problems[0]?.detail).toContain('no maximum age is configured')
    expect(verdict.problems[0]?.rule).not.toBe(GO_NO_GO_RULES.unmet)
  })

  it('refuses a declared requirement nothing examined, and still gives it a row', () => {
    const findings = allMet().filter((finding) => finding.id !== 'milestones-demonstrated')
    const verdict = releaseGoNoGoVerdict(findings)
    expect(verdict.go).toBe(false)
    if (verdict.go) return
    expect(verdict.problems.map((problem) => problem.rule)).toEqual([GO_NO_GO_RULES.notAnswered])
    expect(verdict.problems[0]?.detail).toContain('milestones-demonstrated')
    expect(verdict.examined).toBe(GO_NO_GO_REQUIREMENTS.length - 1)
    // The shorter table is the defect this refusal exists for, so the row is still printed.
    expect(verdict.items).toHaveLength(GO_NO_GO_REQUIREMENTS.length)
    expect(verdict.items.find((item) => item.id === 'milestones-demonstrated')?.state).toBe(
      'unknown',
    )
  })

  it('refuses a finding for an id the list does not declare', () => {
    expect(
      problemRules([...allMet(), { id: 'invented', state: 'met', detail: 'cleared' }]),
    ).toEqual([GO_NO_GO_RULES.notDeclared])
  })

  it('refuses a state outside the closed set rather than defaulting it', () => {
    const findings = allMet().map((finding) =>
      finding.id === 'three-clean-dry-runs'
        ? { ...finding, state: 'probably_fine' as unknown as 'met' }
        : finding,
    )
    const rules = problemRules(findings)
    // Two refusals, and both are the point: the state is refused, and the requirement is then
    // unexamined — a defaulted state would have produced neither.
    expect(rules).toEqual([GO_NO_GO_RULES.notDeclared, GO_NO_GO_RULES.notAnswered])
  })

  it('refuses one requirement answered twice, because the second answer wins a lookup', () => {
    const findings = [
      ...allMet(),
      { id: 'security-findings-clear', state: 'met' as const, detail: 'a second, cleaner answer' },
    ]
    expect(problemRules(findings)).toEqual([GO_NO_GO_RULES.answeredTwice])
  })

  it('refuses a verdict over no findings at all — the floor', () => {
    const verdict = releaseGoNoGoVerdict([])
    expect(verdict.go).toBe(false)
    if (verdict.go) return
    expect(verdict.problems[0]?.rule).toBe(GO_NO_GO_RULES.examinedNothing)
    expect(verdict.examined).toBe(0)
  })

  it('refuses a verdict over no requirements at all, which would otherwise be a go', () => {
    const verdict = releaseGoNoGoVerdict([], [])
    expect(verdict.go).toBe(false)
    if (verdict.go) return
    expect(verdict.problems.map((problem) => problem.rule)).toEqual([
      GO_NO_GO_RULES.examinedNothing,
      GO_NO_GO_RULES.examinedNothing,
    ])
  })

  it('judges an injected requirement list, so a gate can hold a short one to the same rules', () => {
    const requirements: readonly GoNoGoRequirement[] = [
      { id: 'only-one', label: 'The only one', why: 'because', answeredBy: 'a fixture' },
    ]
    expect(
      releaseGoNoGoVerdict([{ id: 'only-one', state: 'met', detail: 'cleared' }], requirements).go,
    ).toBe(true)
    const refused = releaseGoNoGoVerdict(
      [{ id: 'only-one', state: 'unmet', detail: 'refused' }],
      requirements,
    )
    expect(refused.go).toBe(false)
  })
})

describe('the rendering', () => {
  it('prints a row for every requirement including the met ones, and the verdict', () => {
    const rendered = renderReleaseGoNoGo(releaseGoNoGoVerdict(allMet()))
    expect(rendered).toContain('RELEASE GO/NO-GO')
    for (const requirement of GO_NO_GO_REQUIREMENTS) {
      expect(rendered, requirement.id).toContain(requirement.label)
      // The id too, on a met row: the cleared half of the set has to be searchable by the name its
      // problems would be reported under.
      expect(rendered, requirement.id).toContain(requirement.id)
    }
    expect(rendered).toContain(`requirements examined: 6 of 6`)
    expect(rendered).toContain('VERDICT: go')
  })

  it('prints every problem with its rule name, so a gate can assert the rule', () => {
    const findings = allMet().map((finding) =>
      finding.id === 'external-items-cleared'
        ? { ...finding, state: 'unmet' as const, detail: '48 items are open' }
        : finding,
    )
    const rendered = renderReleaseGoNoGo(releaseGoNoGoVerdict(findings))
    expect(rendered).toContain('VERDICT: no-go, 1 problem(s)')
    expect(rendered).toContain(
      `[${GO_NO_GO_RULES.unmet}] external-items-cleared: 48 items are open`,
    )
    // The control: the same renderer over the cleared set says nothing of the kind.
    expect(renderReleaseGoNoGo(releaseGoNoGoVerdict(allMet()))).not.toContain(GO_NO_GO_RULES.unmet)
  })

  it('is deterministic over the same verdict', () => {
    const verdict = releaseGoNoGoVerdict(allMet())
    expect(renderReleaseGoNoGo(verdict)).toBe(renderReleaseGoNoGo(verdict))
  })
})
