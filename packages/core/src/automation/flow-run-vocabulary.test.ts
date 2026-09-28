import {
  FLOW_CONDITION_FACTS,
  FLOW_END_REASONS,
  FLOW_ENROLMENT_OUTCOMES,
  FLOW_EXIT_REASONS,
  FLOW_INTERPRETER_END_REASONS,
  FLOW_NODE_KINDS,
  FLOW_NODE_OUTCOMES,
  FLOW_RUN_MODES,
  FLOW_RUN_STATUSES,
  isFlowEndReason,
  isTerminalFlowRunStatus,
  MAX_ACTIVE_ENROLMENTS_PER_FLOW,
  MAX_DRY_RUN_PROJECTED_ROWS,
  MAX_FLOW_NODE_EXECUTIONS,
} from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { answerFlowCondition, type FlowContactFacts } from './step-plan.ts'

/**
 * The vocabularies the interpreter writes, held equal to the things they are derived from.
 *
 * Migration 0070 left `flow_enrolment.ended_reason` as `text` and said why: *"the interpreter that writes
 * it is C-AUTO-07's and a vocabulary guessed at here would be one somebody has to migrate."* The
 * vocabulary is now written, ONCE, in `@berelax/shared` — and this file is what stops it becoming a second
 * statement of the DSL's exit reasons. Both directions, because two lists that agree today are two lists.
 *
 * It is also where the condition table's completeness is asserted. `FLOW_CONDITION_FACTS` names the facts
 * a flow may test and `FlowContactFacts` is what the interpreter can answer; a fact in the first with
 * nothing in the second is a condition the interpreter would have to guess at, which is the exact failure
 * `schemas/flow.ts` chose the fact list to prevent.
 */

const FACTS: FlowContactFacts = Object.freeze({
  hasFutureAppointment: true,
  hasMarketingConsent: true,
  isVip: true,
  isBlocklisted: false,
  lifecycleState: 'active',
  tags: ['a_tag'],
  locale: 'en',
})

describe('the end-reason vocabulary is derived and not restated', () => {
  it('is exactly the DSL exit reasons plus the interpreter halts, in both directions', () => {
    expect([...FLOW_END_REASONS].sort()).toEqual(
      [...FLOW_EXIT_REASONS, ...FLOW_INTERPRETER_END_REASONS].sort(),
    )
    // Both halves are non-empty, so the equality above is not two empty lists agreeing (ADR 0002).
    expect(FLOW_EXIT_REASONS.length).toBeGreaterThan(2)
    expect(FLOW_INTERPRETER_END_REASONS.length).toBeGreaterThan(2)
    // And no member is in both, which would make one reason mean two things on the same column.
    const overlap = FLOW_EXIT_REASONS.filter((reason) =>
      (FLOW_INTERPRETER_END_REASONS as readonly string[]).includes(reason),
    )
    expect(overlap).toEqual([])
  })

  it('recognises every member and refuses a word nobody writes', () => {
    for (const reason of FLOW_END_REASONS) expect(isFlowEndReason(reason), reason).toBe(true)
    // The control. Without it, `isFlowEndReason` returning true for everything would pass the loop above,
    // and the guard at the one writer would be admitting any text at all onto the column.
    expect(isFlowEndReason('finished_somehow')).toBe(false)
    expect(isFlowEndReason('')).toBe(false)
  })

  it('every run status but `running` is terminal, and `running` is not', () => {
    expect(FLOW_RUN_STATUSES.filter((status) => !isTerminalFlowRunStatus(status))).toEqual([
      'running',
    ])
    expect(FLOW_RUN_STATUSES.filter(isTerminalFlowRunStatus).length).toBe(
      FLOW_RUN_STATUSES.length - 1,
    )
    // `loop_detected` is a STATUS and not a reason folded into `cancelled`, which is the acceptance
    // line's wording and the only shape in which "how many runs are halting" is a count.
    expect(FLOW_RUN_STATUSES).toContain('loop_detected')
  })
})

describe('the interpreter can answer every fact a flow may test', () => {
  it('has a reading for each member of FLOW_CONDITION_FACTS', () => {
    const value: Readonly<Record<string, string | undefined>> = {
      lifecycle_state: 'active',
      tag: 'a_tag',
      locale: 'en',
    }
    for (const fact of FLOW_CONDITION_FACTS) {
      const operator = value[fact] === undefined ? 'is_true' : 'equals'
      const verdict = answerFlowCondition({ fact, operator, value: value[fact] }, FACTS)
      expect(verdict.kind, `${fact} is unanswerable`).toBe('answered')
    }
    expect(FLOW_CONDITION_FACTS.length).toBeGreaterThan(5)
  })

  it('the control: a fact the DSL does not declare is UNREADABLE rather than false', () => {
    // A `default` arm answering `false` would pass the loop above for every future fact and would
    // silently take the false branch for every contact. This is the assertion that forbids one.
    const verdict = answerFlowCondition(
      { fact: 'has_outstanding_balance', operator: 'is_true' },
      FACTS,
    )
    expect(verdict.kind).toBe('unreadable')
    expect(FLOW_CONDITION_FACTS as readonly string[]).not.toContain('has_outstanding_balance')
  })
})

describe('the three provisional bounds are ceilings, and are stated once', () => {
  it('each one is a positive whole number, and each is the manifest figure', () => {
    // The figures are `build/manifest.yaml`'s C-AUTO-07 `provisional` line. Asserted here so a change to
    // any of them is a change somebody has to make deliberately and can be seen in a diff — which is what
    // "provisional values marked provisional" costs (docs/12 §1.5).
    expect(MAX_FLOW_NODE_EXECUTIONS).toBe(200)
    expect(MAX_ACTIVE_ENROLMENTS_PER_FLOW).toBe(5_000)
    expect(MAX_DRY_RUN_PROJECTED_ROWS).toBe(1_000)
    for (const bound of [
      MAX_FLOW_NODE_EXECUTIONS,
      MAX_ACTIVE_ENROLMENTS_PER_FLOW,
      MAX_DRY_RUN_PROJECTED_ROWS,
    ]) {
      expect(Number.isInteger(bound)).toBe(true)
      expect(bound).toBeGreaterThan(0)
    }
  })
})

describe('the outcome vocabularies name what a caller branches on', () => {
  it('carries the typed duplicate and already-enrolled members the acceptance names', () => {
    // Named rather than counted: these two strings are what the acceptance lines say a caller reads, and
    // a rename would otherwise be caught only by whichever test happened to spell it.
    expect(FLOW_NODE_OUTCOMES).toContain('duplicate')
    expect(FLOW_ENROLMENT_OUTCOMES).toContain('already_enrolled')
    expect(FLOW_RUN_MODES).toEqual(['live', 'dry_run'])
  })

  it('has an outcome for every node kind that can have a side effect', () => {
    // Three kinds act outside the run — a message, a tag, a stage — and every other kind is `no_effect`.
    // The assertion is over the KINDS so a ninth kind added to the DSL is a decision somebody takes here.
    const acting = FLOW_NODE_KINDS.filter((kind) => kind.startsWith('action_'))
    expect([...acting].sort()).toEqual(['action_message', 'action_stage', 'action_tag'])
    expect(FLOW_NODE_OUTCOMES).toContain('no_effect')
  })
})
