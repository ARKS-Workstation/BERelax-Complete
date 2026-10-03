import { describe, expect, it } from 'vitest'
import {
  type AgentReasonInput,
  ALERT_OPEN_REASON,
  agentConsoleReason,
  agentReasonText,
  BUDGET_EXCEEDED_REASON,
  DISABLED_REASON,
  GOOGLE_DEPENDENT_AGENTS,
  KILL_SWITCH_REASON,
} from './console-reason.ts'

/**
 * Why an agent is in the state it is in (G-AGT-02, ADR 0116).
 *
 * ## What this file is for that the console's render test is not
 *
 * `agent-console-render.test.ts` asserts the BYTES for a reason it is handed, so it cannot tell a correct
 * derivation from a renderer that was given the right answer — which gate 194b found: a `dependence`
 * flipped from `degrades` to `pauses` changed nothing there, because that file constructs the reason kind
 * itself. This file is where the derivation is the subject: the facts go in, the reason comes out, and
 * the precedence between two causes that are both true is asserted rather than described.
 *
 * ## The two things it must be shown to do
 *
 * **Never produce a generic sentence.** Every reason carries a declared consequence or the agent's own
 * `last_error`, and the one case with neither names which field is empty. There is no input below that
 * produces a sentence this file cannot point at the cause of.
 *
 * **Give one cause two answers.** A broken Google grant pauses an agent that publishes through the
 * connection and degrades one that reads through it, and reporting either as the other sends somebody
 * after the wrong thing.
 */

const RUNNING: AgentReasonInput = {
  agentKey: 'nightly_rollups',
  enabled: true,
  killSwitch: false,
  consecutiveFailures: 0,
  lastOutcome: 'succeeded',
  lastError: null,
  alertOpen: false,
  googleState: 'healthy',
}

const input = (overrides: Partial<AgentReasonInput> = {}): AgentReasonInput => ({
  ...RUNNING,
  ...overrides,
})

describe('a healthy agent has a state and no sentence', () => {
  it('answers running, and running carries no text', () => {
    const reason = agentConsoleReason(RUNNING)
    expect(reason.kind).toBe('running')
    // Null and not "Running normally": a row with no problem has no reason, and a sentence there would
    // be one more line on a screen whose value is that its lines mean something.
    expect(agentReasonText(reason)).toBeNull()
  })
})

describe('one broken connection, two different answers', () => {
  it('pauses an agent that publishes through the grant', () => {
    const reason = agentConsoleReason(
      input({ agentKey: 'review_autoresponder', googleState: 'broken' }),
    )
    expect(reason.kind).toBe('google_paused')
    expect(agentReasonText(reason)).toBe('paused: Google connection needs re-authorising')
  })

  it('degrades an agent that reads through it', () => {
    const reason = agentConsoleReason(input({ agentKey: 'seo_agent', googleState: 'broken' }))
    expect(reason.kind).toBe('google_degraded')
    expect(agentReasonText(reason)).toContain('cached history we keep')
    // The two sentences are different, which is the whole point.
    expect(agentReasonText(reason)).not.toContain('needs re-authorising')
  })

  it('reads the declared dependence rather than the agent’s name', () => {
    // The derivation is over the TABLE, so every entry's own answer is asserted — which is what makes a
    // flipped `dependence` a failing test rather than a sentence nobody compares.
    for (const [agentKey, entry] of Object.entries(GOOGLE_DEPENDENT_AGENTS)) {
      const reason = agentConsoleReason(input({ agentKey, googleState: 'broken' }))
      expect(reason.kind, agentKey).toBe(
        entry.dependence === 'pauses' ? 'google_paused' : 'google_degraded',
      )
      expect(agentReasonText(reason), agentKey).toBe(entry.whenBroken)
    }
    // Both kinds are represented, so the loop above is not asserting one branch twenty times.
    const kinds = new Set(Object.values(GOOGLE_DEPENDENT_AGENTS).map((e) => e.dependence))
    expect([...kinds].toSorted()).toEqual(['degrades', 'pauses'])
  })

  it('says nothing about Google for an agent that does not use it', () => {
    const reason = agentConsoleReason(input({ agentKey: 'nightly_rollups', googleState: 'broken' }))
    expect(reason.kind).toBe('running')
    // The table is deliberately not exhaustive: an unlisted agent is unaffected, which is what lets a
    // new agent_definition row appear on the console with no code change.
    expect(GOOGLE_DEPENDENT_AGENTS['nightly_rollups']).toBeUndefined()
  })

  it('says nothing about Google for a connection that is not broken', () => {
    for (const state of ['healthy', 'expiring_soon', 'degraded', 'pending_gbp_approval'] as const) {
      const reason = agentConsoleReason(
        input({ agentKey: 'review_autoresponder', googleState: state }),
      )
      expect(reason.kind, state).toBe('running')
    }
    // And for no connection at all, which is not a dead grant: an agent that needs one has never run.
    expect(agentConsoleReason(input({ agentKey: 'seo_agent', googleState: null })).kind).toBe(
      'running',
    )
  })
})

describe('a failure speaks in the agent’s own words', () => {
  it('prints last_error verbatim', () => {
    const reason = agentConsoleReason(
      input({ consecutiveFailures: 3, lastOutcome: 'failed', lastError: 'ETIMEDOUT after 30s' }),
    )
    expect(reason.kind).toBe('failing')
    expect(agentReasonText(reason)).toBe('ETIMEDOUT after 30s')
    expect(reason.kind === 'failing' ? reason.consecutiveFailures : 0).toBe(3)
  })

  it('names which field is empty when there are no words', () => {
    for (const lastError of [null, '', '   ']) {
      const reason = agentConsoleReason(
        input({ consecutiveFailures: 2, lastOutcome: 'failed', lastError }),
      )
      expect(reason.kind, JSON.stringify(lastError)).toBe('failing_without_words')
      expect(agentReasonText(reason)).toContain('agent_heartbeat.last_error is empty')
      expect(agentReasonText(reason)).toContain('agent_run.error')
    }
  })

  it('produces no generic sentence for any input, which is ADR 0116’s whole claim', () => {
    const inputs: readonly AgentReasonInput[] = [
      RUNNING,
      input({ killSwitch: true }),
      input({ enabled: false }),
      input({ agentKey: 'review_autoresponder', googleState: 'broken' }),
      input({ agentKey: 'seo_agent', googleState: 'broken' }),
      input({ consecutiveFailures: 1, lastError: 'a real message' }),
      input({ consecutiveFailures: 1, lastError: null }),
      input({ lastOutcome: 'budget_exceeded' }),
      input({ alertOpen: true }),
      // An unknown outcome and an unknown state, which is the shape of an input nobody anticipated.
      input({ lastOutcome: 'something_nobody_declared' }),
    ]
    for (const candidate of inputs) {
      const reason = agentConsoleReason(candidate)
      const text = agentReasonText(reason)
      if (text === null) continue
      for (const generic of [
        'An error occurred',
        'an error occurred',
        'Unknown',
        'Something went wrong',
      ]) {
        expect(text, `${JSON.stringify(candidate)} produced ${generic}`).not.toContain(generic)
      }
      /*
        A length floor on the DECLARED sentences only.

        `failing` prints the agent's own `last_error` verbatim, and how long that is the agent's business
        — the first version of this case applied the floor to every kind and failed on a fourteen-character
        message, which is a real thing a job writes. A console that paraphrased a short error to satisfy a
        length rule would be exactly the layer ADR 0116 refuses. Every sentence this MODULE declares says
        something, and that is what is asserted.
      */
      if (reason.kind !== 'failing') {
        expect(text.length, JSON.stringify(candidate)).toBeGreaterThan(20)
      }
    }
    expect(inputs).toHaveLength(10)
  })
})

describe('the precedence between two causes that are both true', () => {
  it('puts a kill switch above everything', () => {
    // Somebody's deliberate act. Reporting a failure for an agent that has been switched off sends a
    // person after a bug that is a decision.
    const reason = agentConsoleReason(
      input({
        killSwitch: true,
        enabled: false,
        consecutiveFailures: 9,
        lastError: 'ETIMEDOUT',
        alertOpen: true,
        agentKey: 'review_autoresponder',
        googleState: 'broken',
      }),
    )
    expect(reason.kind).toBe('kill_switch')
    expect(agentReasonText(reason)).toBe(KILL_SWITCH_REASON)
  })

  it('puts being switched off above a failure', () => {
    const reason = agentConsoleReason(
      input({ enabled: false, consecutiveFailures: 4, lastError: 'ETIMEDOUT' }),
    )
    expect(reason.kind).toBe('disabled')
    expect(agentReasonText(reason)).toBe(DISABLED_REASON)
  })

  it('puts a broken grant above the failure it explains', () => {
    // An autoresponder whose grant has expired fails every run. The useful sentence is the grant.
    const reason = agentConsoleReason(
      input({
        agentKey: 'review_autoresponder',
        googleState: 'broken',
        consecutiveFailures: 6,
        lastError: 'PERMISSION_DENIED posting a reply',
      }),
    )
    expect(reason.kind).toBe('google_paused')
  })

  it('puts a spent budget above a failure, because the run was stopped rather than broken', () => {
    const reason = agentConsoleReason(
      input({
        lastOutcome: 'budget_exceeded',
        consecutiveFailures: 1,
        lastError: 'BudgetExceeded',
      }),
    )
    expect(reason.kind).toBe('budget_exceeded')
    expect(agentReasonText(reason)).toBe(BUDGET_EXCEEDED_REASON)
  })

  it('puts a failure above an open alert, because the two need different people', () => {
    // Running and failing needs a stack trace; stopped needs a worker. The heartbeat distinguishes them
    // only by which of the two it recorded.
    const failing = agentConsoleReason(
      input({ consecutiveFailures: 2, lastError: 'ETIMEDOUT', alertOpen: true }),
    )
    expect(failing.kind).toBe('failing')
    const stopped = agentConsoleReason(input({ alertOpen: true }))
    expect(stopped.kind).toBe('alert_open')
    expect(agentReasonText(stopped)).toBe(ALERT_OPEN_REASON)
  })
})
