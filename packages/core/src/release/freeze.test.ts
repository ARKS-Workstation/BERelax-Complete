import { describe, expect, it } from 'vitest'
import {
  FREEZE_REGISTER_VERSION,
  FREEZE_RULES,
  type FreezeRegister,
  freezeProblems,
  LAUNCH_BLOCKING_LABEL,
  mergePermitted,
  parseFreezeRegister,
  renderFreeze,
} from './freeze.ts'

/**
 * The freeze: a claim a human makes, and a merge rule derived from it.
 *
 * Two things are asserted here that nothing else can assert, and each is paired with its control:
 *
 *   1. **A frozen register with no claimant is refused.** Without that, a freeze is a state that
 *      arrived from nowhere and can be lifted by anybody, which is exactly what migration 0128 refuses
 *      for a posting claim.
 *   2. **A frozen tree refuses an unlabelled change** — and permits a labelled one, which is the
 *      control that keeps the rule a rule rather than a stop.
 */

const OPEN: FreezeRegister = {
  registerVersion: FREEZE_REGISTER_VERSION,
  state: 'open',
  claim: null,
  openQuestionId: 'Y13-cutover-window',
}

const FROZEN_CLAIM = {
  declaredBy: 'owner',
  declaredAtIso: '2097-04-18T06:00:00.000Z',
  rationale: 'a fixture freeze, declared so that the refusal below can be seen to fire',
} as const

const FROZEN: FreezeRegister = {
  registerVersion: FREEZE_REGISTER_VERSION,
  state: 'frozen',
  claim: FROZEN_CLAIM,
  openQuestionId: null,
}

const rules = (register: FreezeRegister): readonly string[] =>
  freezeProblems(register).map((problem) => problem.rule)

describe('the register', () => {
  it('parses the shipped shape and refuses a version it does not read', () => {
    const { register, problems } = parseFreezeRegister(
      { registerVersion: 1, state: 'open', claim: null, openQuestionId: 'Y13-cutover-window' },
      'fixture',
    )
    expect(problems).toHaveLength(0)
    expect(register?.state).toBe('open')
    expect(
      parseFreezeRegister({ registerVersion: 2, state: 'open' }, 'fixture').register,
    ).toBeNull()
  })

  it('refuses a state outside the closed set rather than defaulting it', () => {
    const { register, problems } = parseFreezeRegister(
      { registerVersion: 1, state: 'thawing', claim: null, openQuestionId: 'Y13-cutover-window' },
      'fixture',
    )
    expect(register).toBeNull()
    expect(problems[0]?.rule).toBe(FREEZE_RULES.unknownState)
  })

  it('refuses a claim missing the who, the when or the why', () => {
    for (const absent of ['declaredBy', 'declaredAtIso', 'rationale'] as const) {
      const claim: Record<string, string> = {
        declaredBy: 'owner',
        declaredAtIso: '2097-04-18T06:00:00.000Z',
        rationale: 'because',
      }
      delete claim[absent]
      const { register, problems } = parseFreezeRegister(
        { registerVersion: 1, state: 'frozen', claim, openQuestionId: null },
        'fixture',
      )
      expect(register, absent).toBeNull()
      expect(problems[0]?.rule, absent).toBe(FREEZE_RULES.declaredWithoutClaimant)
    }
  })

  it('refuses anything that is not an object, and a claim that is not one either', () => {
    expect(parseFreezeRegister(null, 'fixture').problems[0]?.rule).toBe(FREEZE_RULES.malformed)
    expect(parseFreezeRegister([1, 2], 'fixture').problems[0]?.rule).toBe(FREEZE_RULES.malformed)
    expect(
      parseFreezeRegister(
        { registerVersion: 1, state: 'frozen', claim: 'the owner said so' },
        'fixture',
      ).problems[0]?.rule,
    ).toBe(FREEZE_RULES.malformed)
  })
})

describe('the claim rule', () => {
  it('accepts a freeze declared by a role, with an instant and a reason', () => {
    expect(rules(FROZEN)).toEqual([])
  })

  it('refuses a frozen tree with no claim behind it', () => {
    expect(rules({ ...FROZEN, claim: null })).toEqual([FREEZE_RULES.declaredWithoutClaimant])
  })

  it('refuses a claimant that is not an F07 role, because a name is a string this build invented', () => {
    const problems = freezeProblems({
      ...FROZEN,
      claim: { ...FROZEN_CLAIM, declaredBy: 'the release manager' },
    })
    expect(problems.map((problem) => problem.rule)).toEqual([FREEZE_RULES.claimantNotARole])
    expect(problems[0]?.detail).toContain('owner')
  })

  it('refuses an open register that still carries a claim', () => {
    expect(rules({ ...OPEN, claim: FROZEN_CLAIM })).toEqual([FREEZE_RULES.openWithClaimant])
  })

  it('refuses an open register that names no open question', () => {
    expect(rules({ ...OPEN, openQuestionId: null })).toEqual([FREEZE_RULES.openWithoutOpenQuestion])
  })
})

describe('the merge rule', () => {
  it('permits everything while the tree is open, and says nothing will declare a freeze', () => {
    const verdict = mergePermitted(OPEN, [])
    expect(verdict.permitted).toBe(true)
    if (!verdict.permitted) return
    expect(verdict.reason).toContain('not frozen')
    expect(verdict.reason).toContain('Y13-cutover-window')
  })

  it('refuses a change that is not labelled launch-blocking while the tree is frozen', () => {
    const verdict = mergePermitted(FROZEN, ['bug', 'documentation'])
    expect(verdict.permitted).toBe(false)
    if (verdict.permitted) return
    expect(verdict.problems.map((problem) => problem.rule)).toEqual([FREEZE_RULES.mergeRefused])
    expect(verdict.problems[0]?.detail).toContain(LAUNCH_BLOCKING_LABEL)
    expect(verdict.problems[0]?.detail).toContain('owner')
  })

  it('refuses a change with no labels at all while the tree is frozen', () => {
    const verdict = mergePermitted(FROZEN, [])
    expect(verdict.permitted).toBe(false)
    if (verdict.permitted) return
    expect(verdict.problems[0]?.detail).toContain('no labels')
  })

  it('permits a labelled change — the control that keeps the refusal a rule and not a stop', () => {
    const verdict = mergePermitted(FROZEN, ['bug', LAUNCH_BLOCKING_LABEL])
    expect(verdict.permitted).toBe(true)
    if (!verdict.permitted) return
    expect(verdict.reason).toContain(LAUNCH_BLOCKING_LABEL)
  })

  it('refuses ABSENT label information by its own rule, which an empty set is not', () => {
    const absent = mergePermitted(FROZEN, null)
    expect(absent.permitted).toBe(false)
    if (absent.permitted) return
    expect(absent.problems[0]?.rule).toBe(FREEZE_RULES.labelsNotSupplied)
    // And it is refused while the tree is OPEN too: a caller that did not look is a caller that did
    // not look, whatever the state happens to be.
    const openAbsent = mergePermitted(OPEN, null)
    expect(openAbsent.permitted).toBe(false)
  })

  it('refuses a merge against a malformed register rather than judging the labels', () => {
    const verdict = mergePermitted({ ...FROZEN, claim: null }, [LAUNCH_BLOCKING_LABEL])
    expect(verdict.permitted).toBe(false)
    if (verdict.permitted) return
    expect(verdict.problems[0]?.rule).toBe(FREEZE_RULES.declaredWithoutClaimant)
  })
})

describe('the rendering', () => {
  it('says who declared the freeze and when, and prints the refusal with its rule', () => {
    const rendered = renderFreeze(FROZEN, mergePermitted(FROZEN, ['bug']))
    expect(rendered).toContain('state: FROZEN')
    expect(rendered).toContain('declared by: owner at 2097-04-18T06:00:00.000Z')
    expect(rendered).toContain(`[${FREEZE_RULES.mergeRefused}]`)
  })

  it('says nobody declared it while the tree is open, and names the open question', () => {
    const rendered = renderFreeze(OPEN, mergePermitted(OPEN, []))
    expect(rendered).toContain('declared by: nobody (Y13-cutover-window)')
    expect(rendered).toContain('MERGE: permitted')
    // The control: the open rendering must not read as a freeze that has been lifted.
    expect(rendered).toContain('nothing in this build decides a freeze')
  })
})
