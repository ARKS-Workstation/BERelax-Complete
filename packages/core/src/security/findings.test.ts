import { describe, expect, it } from 'vitest'
import {
  FINDING_RULES,
  FINDINGS_REGISTER_VERSION,
  type FindingsRegister,
  findingProblems,
  goNoGoVerdict,
  parseFindingsRegister,
  renderGoNoGo,
  type SecurityFinding,
} from './findings.ts'

const finding = (overrides: Partial<SecurityFinding> = {}): SecurityFinding => ({
  id: 'F-0001',
  title: 'A probe finding, written for a test',
  severity: 'critical',
  status: 'open',
  source: 'automated_baseline',
  detail: 'The fixture origin answered 200 to an admin path with no session cookie.',
  surface: '/settings/integrations',
  raisedAtIso: '2026-10-03T00:00:00.000Z',
  ...overrides,
})

const register = (findings: readonly SecurityFinding[], booked = true): FindingsRegister => ({
  registerVersion: FINDINGS_REGISTER_VERSION,
  engagement: {
    booked,
    standIn: 'the automated baseline scan over the declared route list',
    openQuestionId: 'Y13-pentest',
  },
  findings,
})

const rules = (problems: readonly { rule: string }[]) => problems.map((problem) => problem.rule)

describe('closed sets', () => {
  // The acceptance line: an unknown severity FAILS rather than defaulting. A defaulted severity is how
  // a critical finding becomes a medium, and nothing downstream would say so.
  it('refuses an imported report whose severity is not in the closed set', () => {
    const { register: parsed, problems } = parseFindingsRegister(
      { ...register([]), findings: [{ ...finding(), severity: 'Critical' }] },
      'fixture',
    )
    expect(parsed).toBeNull()
    expect(rules(problems)).toContain(FINDING_RULES.unknownSeverity)
  })

  it('refuses an unknown status and an unknown source', () => {
    expect(
      rules(
        parseFindingsRegister(
          { ...register([]), findings: [{ ...finding(), status: 'wontfix' }] },
          'fixture',
        ).problems,
      ),
    ).toContain(FINDING_RULES.unknownStatus)
    expect(
      rules(
        parseFindingsRegister(
          { ...register([]), findings: [{ ...finding(), source: 'a hunch' }] },
          'fixture',
        ).problems,
      ),
    ).toContain(FINDING_RULES.malformed)
  })

  it('refuses the same id twice, because the second would win a lookup silently', () => {
    expect(
      rules(
        parseFindingsRegister(
          { ...register([]), findings: [finding(), finding({ severity: 'low' })] },
          'fixture',
        ).problems,
      ),
    ).toContain(FINDING_RULES.duplicateId)
  })

  it('refuses a register that does not say whether an engagement happened', () => {
    const { problems } = parseFindingsRegister(
      { registerVersion: FINDINGS_REGISTER_VERSION, findings: [] },
      'fixture',
    )
    expect(rules(problems)).toContain(FINDING_RULES.malformed)
  })

  // The control: a well-formed register parses, so the refusals above are about the defect and not
  // about the parser refusing everything.
  it('parses a well-formed register', () => {
    const { register: parsed, problems } = parseFindingsRegister(register([finding()]), 'fixture')
    expect(problems).toEqual([])
    expect(parsed?.findings).toHaveLength(1)
  })
})

describe('the closing rule', () => {
  it('refuses fixed with neither a commit nor a test reference', () => {
    expect(rules(findingProblems(finding({ status: 'fixed' })))).toContain(
      FINDING_RULES.closedWithoutEvidence,
    )
  })

  it('accepts fixed with either', () => {
    expect(
      findingProblems(finding({ status: 'fixed', remediation: { commit: 'abc1234' } })),
    ).toEqual([])
    expect(
      findingProblems(
        finding({ status: 'fixed', remediation: { testReference: 'packages/core/x.test.ts' } }),
      ),
    ).toEqual([])
  })

  it('refuses accepted_with_rationale without a rationale and without a role', () => {
    expect(rules(findingProblems(finding({ status: 'accepted_with_rationale' })))).toContain(
      FINDING_RULES.acceptedWithoutRationale,
    )
    expect(
      rules(
        findingProblems(
          finding({ status: 'accepted_with_rationale', remediation: { rationale: 'because' } }),
        ),
      ),
    ).toContain(FINDING_RULES.acceptedWithoutRationale)
    expect(
      findingProblems(
        finding({
          status: 'accepted_with_rationale',
          remediation: { rationale: 'because', acceptedBy: 'owner' },
        }),
      ),
    ).toEqual([])
  })

  it('refuses a false positive with no reason and a duplicate with no original', () => {
    expect(rules(findingProblems(finding({ status: 'false_positive' })))).toContain(
      FINDING_RULES.closedWithoutEvidence,
    )
    expect(rules(findingProblems(finding({ status: 'duplicate' })))).toContain(
      FINDING_RULES.duplicateWithoutOriginal,
    )
  })

  // The other direction, which the acceptance line implies rather than states: a row that is open and
  // carries remediation is a row somebody fixed and did not close.
  it('refuses remediation on a finding that is still open', () => {
    expect(rules(findingProblems(finding({ remediation: { commit: 'abc1234' } })))).toContain(
      FINDING_RULES.malformed,
    )
  })
})

describe('the go/no-go verdict', () => {
  // The acceptance line, in both halves: a seeded critical finding blocks by name, and triaging it to
  // fixed or accepted clears it.
  it('is blocked by an unresolved critical finding, naming it', () => {
    const verdict = goNoGoVerdict(register([finding()]))
    expect(verdict.go).toBe(false)
    const detail = verdict.go ? '' : verdict.problems.map((p) => p.detail).join('\n')
    expect(detail).toContain('F-0001')
    expect(verdict.go ? [] : rules(verdict.problems)).toContain(FINDING_RULES.blocking)
  })

  it('clears when that finding is fixed with evidence, or accepted with a rationale', () => {
    expect(
      goNoGoVerdict(register([finding({ status: 'fixed', remediation: { commit: 'abc1234' } })]))
        .go,
    ).toBe(true)
    expect(
      goNoGoVerdict(
        register([
          finding({
            status: 'accepted_with_rationale',
            remediation: {
              rationale: 'rate limiting is H-HARD-01 and is not built',
              acceptedBy: 'owner',
            },
          }),
        ]),
      ).go,
    ).toBe(true)
  })

  it('is blocked by a high finding and not by a medium one', () => {
    expect(goNoGoVerdict(register([finding({ severity: 'high' })])).go).toBe(false)
    expect(goNoGoVerdict(register([finding({ severity: 'medium' })])).go).toBe(true)
  })

  // The one that matters today. An empty register is not a clean one: no engagement has been performed,
  // and "no findings" is indistinguishable from "nobody looked" (ADR 0002).
  it('refuses while no engagement has been performed, even with an empty register', () => {
    const verdict = goNoGoVerdict(register([], false))
    expect(verdict.go).toBe(false)
    expect(verdict.go ? [] : rules(verdict.problems)).toContain(FINDING_RULES.engagementNotBooked)
  })

  it('and an empty register with an engagement performed is a go', () => {
    expect(goNoGoVerdict(register([], true)).go).toBe(true)
  })
})

describe('the go/no-go output', () => {
  /*
    The acceptance line's snapshot test. Every finding appears, including the CLOSED ones, which is the
    point: an output listing only the blockers tells a reader nothing about what was accepted on their
    behalf. An inline snapshot rather than a file, so a change to the rendering is visible in the diff of
    the test that asserts it.
  */
  it('surfaces the whole register, closed findings included', () => {
    const rendered = renderGoNoGo(
      register(
        [
          finding(),
          finding({
            id: 'F-0002',
            title: 'A medium finding, accepted',
            severity: 'medium',
            status: 'accepted_with_rationale',
            source: 'penetration_test',
            surface: '/api/collect',
            remediation: { rationale: 'the endpoint takes no credential', acceptedBy: 'owner' },
          }),
        ],
        false,
      ),
    )
    expect(rendered).toMatchInlineSnapshot(`
      "SECURITY GO/NO-GO
      engagement: NOT PERFORMED (Y13-pentest)
      stands in: the automated baseline scan over the declared route list

      findings: 2
        critical: 1 (1 unresolved)
        high: 0 (0 unresolved)
        medium: 1 (0 unresolved)
        low: 0 (0 unresolved)
        informational: 0 (0 unresolved)

        [critical/open] F-0001 A probe finding, written for a test (automated_baseline) on /settings/integrations
        [medium/accepted_with_rationale] F-0002 A medium finding, accepted (penetration_test) on /api/collect
            accepted by owner; rationale: the endpoint takes no credential

      VERDICT: no-go, 2 problem(s)
        [go-live-blocked-by-finding] F-0001 (critical, open): A probe finding, written for a test — /settings/integrations
        [go-live-blocked-engagement-not-performed] no penetration test has been performed, so this register being clear says nothing. "No findings" and "nobody looked" are the same register (Y13-pentest). What stands in: the automated baseline scan over the declared route list"
    `)
  })
})
