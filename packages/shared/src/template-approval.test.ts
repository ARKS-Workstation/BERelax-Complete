/**
 * C-AUTO-01 — the shape of the approval state machine, stated over the whole 4x4 of ordered pairs.
 *
 * The edges themselves are a list, and a test that repeated the list would agree with it by
 * construction. What is worth asserting is the SHAPE the list is supposed to have, because that is what
 * a later edit can quietly break:
 *
 *   1. **Nothing reaches `approved` except from `pending`.** This is the whole machine. A `draft ->
 *      approved` edge means one UPDATE approves words nobody was shown, and `rejected -> approved` means
 *      a rejection is overturned without anybody re-authoring it.
 *   2. **Every state is reachable and nothing is a dead end**, except in the direction that matters:
 *      every state can be left, so no template is ever stuck.
 *   3. **`approved` is the only sendable state**, and `isSendableApproval` is total over the vocabulary
 *      rather than a comparison at each call site — a fifth state is not sendable until somebody says so.
 *
 * `packages/fixtures/src/message-template.itest.ts` asserts the SQL half agrees on all sixteen pairs.
 * This file is about the list itself; that one is about the two implementations of it.
 */
import { describe, expect, it } from 'vitest'
import {
  isSendableApproval,
  isTemplateApprovalTransition,
  TEMPLATE_APPROVAL_STATES,
  TEMPLATE_APPROVAL_TRANSITIONS,
  type TemplateApprovalState,
} from './messaging.ts'

/** All sixteen ordered pairs, including the four self-moves. */
const ORDERED_PAIRS: readonly (readonly [TemplateApprovalState, TemplateApprovalState])[] =
  TEMPLATE_APPROVAL_STATES.flatMap((from) =>
    TEMPLATE_APPROVAL_STATES.map((to) => [from, to] as const),
  )

describe('the approval state machine', () => {
  it('declares its edges once, with no duplicate', () => {
    const spelled = TEMPLATE_APPROVAL_TRANSITIONS.map(([from, to]) => `${from}->${to}`)
    expect(new Set(spelled).size).toBe(spelled.length)
  })

  it('answers every one of the sixteen ordered pairs', () => {
    expect(ORDERED_PAIRS).toHaveLength(16)
    for (const [from, to] of ORDERED_PAIRS) {
      expect(typeof isTemplateApprovalTransition(from, to), `${from}->${to}`).toBe('boolean')
    }
  })

  it('lets nothing reach approved except pending', () => {
    for (const from of TEMPLATE_APPROVAL_STATES) {
      const allowed = isTemplateApprovalTransition(from, 'approved')
      // The one rule the whole machine exists for. `draft -> approved` is a template approved in one
      // step by whoever wrote it; `rejected -> approved` is a rejection overturned with nothing changed.
      expect(allowed, `${from}->approved`).toBe(from === 'pending')
    }
  })

  it('treats a self-move as not an edge, so a no-op UPDATE is not a transition', () => {
    for (const state of TEMPLATE_APPROVAL_STATES) {
      expect(isTemplateApprovalTransition(state, state), `${state}->${state}`).toBe(false)
    }
  })

  it('leaves no state stuck: every state has a way out', () => {
    for (const from of TEMPLATE_APPROVAL_STATES) {
      const out = TEMPLATE_APPROVAL_STATES.filter((to) => isTemplateApprovalTransition(from, to))
      expect(out.length, `${from} has no outgoing edge`).toBeGreaterThan(0)
    }
  })

  it('permits at least one edge and refuses at least one, so neither claim is vacuous', () => {
    // The control that matters for a predicate: a function that answered `true` for everything would
    // satisfy "every state has a way out", and one that answered `false` for everything would satisfy
    // "nothing reaches approved except pending".
    const permitted = ORDERED_PAIRS.filter(([from, to]) => isTemplateApprovalTransition(from, to))
    expect(permitted.length).toBeGreaterThan(0)
    expect(permitted.length).toBeLessThan(ORDERED_PAIRS.length)
  })

  it('names one sendable state, and answers for every state in the vocabulary', () => {
    const sendable = TEMPLATE_APPROVAL_STATES.filter(isSendableApproval)
    expect(sendable).toEqual(['approved'])
    // Total rather than a `switch` with a permissive default: a fifth state added to the vocabulary is
    // not sendable, which is the direction a new label should arrive in.
    for (const state of TEMPLATE_APPROVAL_STATES) {
      expect(typeof isSendableApproval(state), state).toBe('boolean')
    }
  })
})
