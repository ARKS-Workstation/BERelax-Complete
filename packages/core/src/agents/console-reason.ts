import type { GoogleConnectionDisplayState } from '../google/connection.ts'

/**
 * Why an agent is in the state it is in, as a VALUE (G-AGT-02).
 *
 * ## The acceptance line, and why it is a type rather than a convention
 *
 * *"Real reason, never generic … a DOM test asserts the string 'An error occurred' appears nowhere on the
 * page"*. A test over the rendered bytes is the right check and it is not the mechanism: a page can pass
 * it today and grow a fallback branch tomorrow, and the fallback branch is exactly what a reviewer skims
 * past — `?? 'An error occurred'` is eleven characters and reads as defensive programming.
 *
 * So {@link AgentReason} is a discriminated union, every member of which carries either a sentence
 * declared HERE for a named cause or the agent's OWN words out of `agent_heartbeat.last_error`. There is
 * no member a renderer could reach without a cause, which means there is nowhere for a generic string to
 * live: {@link agentConsoleReason} is total over its input and returns `running` when nothing is wrong,
 * and `running` is a state rather than a message. ADR 0116 records that.
 *
 * ## Why a broken Google connection is two different reasons
 *
 * The acceptance line asks for one state to produce two sentences: *"with the Google connection
 * status=broken the autoresponder row renders 'paused: Google connection needs re-authorising' and the
 * SEO agent row renders its own cached-history degradation string"*. That is not a special case, it is
 * the shape: what a dead grant does to an agent depends on what the agent used the grant FOR.
 *
 *   - The review autoresponder PUBLISHES through the connection. With no grant it cannot post a reply at
 *     all, so it is PAUSED and the remedy is to reconnect.
 *   - The SEO agent READS through it. With no grant it falls back to the history it keeps, so it still
 *     runs and its figures are older than they look — which is a DEGRADATION, and the remedy is to
 *     reconnect eventually and to distrust the week's deltas meanwhile.
 *
 * Reporting either as the other is the specific defect this table prevents. "Paused" about an agent that
 * is running makes somebody look for a stopped worker; "degraded" about an agent that cannot act at all
 * means review replies stop being posted and the console says the figures may be stale.
 *
 * ## Pure
 *
 * No clock, no I/O. Every input is a fact the caller read: the definition's two switches, the heartbeat's
 * last outcome and error, whether the watchdog has an alert open, and the connection's display state.
 */

/** What a dead Google grant does to one agent. An agent not in the table is unaffected by it. */
export const AGENT_GOOGLE_DEPENDENCE = ['pauses', 'degrades'] as const
export type AgentGoogleDependence = (typeof AGENT_GOOGLE_DEPENDENCE)[number]

export interface GoogleDependence {
  readonly dependence: AgentGoogleDependence
  /** The sentence the console renders when the connection is broken. The agent's own consequence. */
  readonly whenBroken: string
}

/**
 * The agents a Google grant is load-bearing for, and what its absence does to each.
 *
 * Keyed by `agent_definition.agent_key`, and deliberately NOT exhaustive: an agent that is not here is
 * unaffected by the connection, which is the ordinary case and is what lets a new `agent_definition` row
 * appear on the console with no code change — the acceptance line's first claim. An exhaustive
 * `Record<AgentKey, …>` would make adding an agent a compile error in this file, which is the opposite of
 * what that line asks for.
 *
 * The sentences are HERE and not in the database because they are a consequence of the architecture
 * rather than a fact about a row: what a missing grant does to the autoresponder is decided by the
 * autoresponder's design, and a settings-table copy of it would be a sentence an operator could edit into
 * something untrue about code they cannot see.
 */
export const GOOGLE_DEPENDENT_AGENTS: Readonly<Record<string, GoogleDependence>> = Object.freeze({
  review_autoresponder: Object.freeze({
    dependence: 'pauses',
    whenBroken: 'paused: Google connection needs re-authorising',
  }),
  review_count_tripwire: Object.freeze({
    dependence: 'pauses',
    whenBroken: 'paused: Google connection needs re-authorising',
  }),
  review_monday_nudge: Object.freeze({
    dependence: 'pauses',
    whenBroken: 'paused: Google connection needs re-authorising',
  }),
  seo_agent: Object.freeze({
    dependence: 'degrades',
    whenBroken:
      'degraded: this week’s figures come from the cached history we keep, not from Search Console, ' +
      'so the deltas are against older data than they appear to be',
  }),
  seo_gsc_snapshot: Object.freeze({
    dependence: 'degrades',
    whenBroken:
      'degraded: no new snapshot can be taken, so the stored history stops advancing and every report ' +
      'built on it reads the same week twice',
  }),
  seo_url_inspection: Object.freeze({
    dependence: 'pauses',
    whenBroken: 'paused: Google connection needs re-authorising',
  }),
  google_health: Object.freeze({
    dependence: 'degrades',
    whenBroken:
      'degraded: the health pass can see the stored connection and not the account behind it, so it ' +
      'reports what was last known rather than what is true now',
  }),
  google_liveness: Object.freeze({
    dependence: 'pauses',
    whenBroken: 'paused: Google connection needs re-authorising',
  }),
})

/** Every reason an agent row can carry. A sentence always comes from a cause. */
export type AgentReason =
  /** Nothing is wrong. A STATE and not a message, which is why it carries no text. */
  | { readonly kind: 'running' }
  | { readonly kind: 'kill_switch'; readonly text: string }
  | { readonly kind: 'disabled'; readonly text: string }
  /** A declared consequence of a broken Google grant. The text is {@link GoogleDependence.whenBroken}. */
  | { readonly kind: 'google_paused'; readonly text: string }
  | { readonly kind: 'google_degraded'; readonly text: string }
  /** The agent's OWN words, out of `agent_heartbeat.last_error`. Never a substitute for them. */
  | { readonly kind: 'failing'; readonly text: string; readonly consecutiveFailures: number }
  | { readonly kind: 'budget_exceeded'; readonly text: string }
  /** The watchdog has an unacknowledged alert and the heartbeat says nothing else. */
  | { readonly kind: 'alert_open'; readonly text: string }
  /**
   * The one case where the console has no words, and it says so.
   *
   * An agent whose heartbeat records a failure and no error text. That happens — a worker killed between
   * the attempt and the write leaves the streak without the reason — and the honest answer is to name the
   * absence rather than to invent a sentence. `'An error occurred'` is what a renderer would reach for
   * here, and this member is why it does not have to: the text says WHICH field is empty and WHERE to
   * look, which is a different and more useful sentence.
   */
  | {
      readonly kind: 'failing_without_words'
      readonly text: string
      readonly consecutiveFailures: number
    }

export const KILL_SWITCH_REASON = 'paused: a kill switch is on, so no run is started'
export const DISABLED_REASON = 'paused: switched off, so the scheduler does not run it'
export const BUDGET_EXCEEDED_REASON =
  'stopped mid-run: the per-run budget was spent, so the work was abandoned rather than overspent'
export const ALERT_OPEN_REASON =
  'overdue: the watchdog has an open alert and the heartbeat records no error, which is an agent that ' +
  'stopped running rather than one that is failing'
export const FAILING_WITHOUT_WORDS_REASON =
  'failing, and agent_heartbeat.last_error is empty — the run that failed did not get as far as writing ' +
  'its reason, which is what a worker killed mid-attempt leaves behind. The run log (agent_run.error) is ' +
  'where to look.'

export interface AgentReasonInput {
  readonly agentKey: string
  readonly enabled: boolean
  readonly killSwitch: boolean
  readonly consecutiveFailures: number
  /** `agent_heartbeat.last_outcome`, or null for an agent that has never finished a run. */
  readonly lastOutcome: string | null
  /** `agent_heartbeat.last_error`, or null. The agent's own words. */
  readonly lastError: string | null
  readonly alertOpen: boolean
  /** The Google connection's display state, or null when this build has no connection at all. */
  readonly googleState: GoogleConnectionDisplayState | null
}

/**
 * The reason, from the facts. Total, and ordered so the most actionable cause wins.
 *
 * The ORDER is the decision and it is worth reading as one. A kill switch beats everything because it is
 * the one cause that is somebody's deliberate act, and reporting a failure for an agent that has been
 * switched off sends a person after a bug that is a decision. Being switched off comes next for the same
 * reason. A broken Google grant beats a failure because it EXPLAINS the failure — an autoresponder whose
 * grant has expired fails every run, and the useful sentence is the grant rather than the symptom. A
 * failure beats an open alert because an agent that is running and failing needs a stack trace while one
 * that has stopped needs a worker, and the heartbeat can only distinguish them by which of the two it
 * recorded.
 */
export function agentConsoleReason(input: AgentReasonInput): AgentReason {
  if (input.killSwitch) return { kind: 'kill_switch', text: KILL_SWITCH_REASON }
  if (!input.enabled) return { kind: 'disabled', text: DISABLED_REASON }

  if (input.googleState === 'broken') {
    const dependence = GOOGLE_DEPENDENT_AGENTS[input.agentKey]
    if (dependence !== undefined) {
      return dependence.dependence === 'pauses'
        ? { kind: 'google_paused', text: dependence.whenBroken }
        : { kind: 'google_degraded', text: dependence.whenBroken }
    }
  }

  if (input.lastOutcome === 'budget_exceeded') {
    return { kind: 'budget_exceeded', text: BUDGET_EXCEEDED_REASON }
  }

  if (input.consecutiveFailures > 0) {
    const words = input.lastError?.trim() ?? ''
    return words === ''
      ? {
          kind: 'failing_without_words',
          text: FAILING_WITHOUT_WORDS_REASON,
          consecutiveFailures: input.consecutiveFailures,
        }
      : { kind: 'failing', text: words, consecutiveFailures: input.consecutiveFailures }
  }

  if (input.alertOpen) return { kind: 'alert_open', text: ALERT_OPEN_REASON }
  return { kind: 'running' }
}

/**
 * The reason as the sentence a row prints, or null for an agent that is simply running.
 *
 * `null` and not `'Running normally'`: a row with no problem has no reason, and a sentence there would be
 * one more line on a screen whose whole value is that the lines on it mean something. The renderer prints
 * the state instead.
 */
export function agentReasonText(reason: AgentReason): string | null {
  return reason.kind === 'running' ? null : reason.text
}
