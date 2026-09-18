import { evaluateAgentHealth, type Instant, isOverdue } from '@berelax/core'
import { agentsWithHeartbeat, raiseAlert, type Sql } from '@berelax/db'

/**
 * The watchdog pass.
 *
 * Reads every agent, evaluates each against its own declared interval, and raises one alert per unbroken
 * silence. The arithmetic is `evaluateAgentHealth` in `@berelax/core` — pure, clock injected, and tested
 * at the boundary — and this module does the reading and the writing.
 *
 * It watches itself, and that is not an oversight. A watchdog that stops running is the one failure the
 * watchdog cannot report, so it has an `agent_definition` row like everything else and its own heartbeat
 * goes stale if it stops. Something outside this process has to notice that, which is the alerting
 * ladder in H-HARD-05; what this unit guarantees is that the evidence exists.
 */
export interface WatchdogResult {
  readonly checked: number
  readonly overdue: readonly string[]
  /** Agents whose alert was newly inserted. Excludes an incident already alerted on. */
  readonly raised: readonly string[]
  readonly disabled: readonly string[]
}

export async function runWatchdog(sql: Sql, now: Instant): Promise<WatchdogResult> {
  const agents = await agentsWithHeartbeat(sql)
  const overdue: string[] = []
  const raised: string[] = []
  const disabled: string[] = []

  for (const agent of agents) {
    const health = evaluateAgentHealth(
      {
        agentKey: agent.agentKey,
        enabled: agent.enabled,
        enabledSince: agent.enabledSince as Instant,
        expectedIntervalSeconds: agent.expectedIntervalSeconds,
        lastSuccessAt: agent.heartbeat.lastSuccessAt as Instant | undefined,
      },
      now,
    )

    if (health.kind === 'disabled') {
      disabled.push(agent.agentKey)
      continue
    }
    if (!isOverdue(health)) continue

    overdue.push(agent.agentKey)
    const inserted = await raiseAlert(sql, {
      agentKey: agent.agentKey,
      incidentKey: health.incidentKey,
      silentForSeconds: health.silentForSeconds,
      raisedAtIso: new Date(now).toISOString(),
      detail: {
        displayName: agent.displayName,
        expectedIntervalSeconds: agent.expectedIntervalSeconds,
        // The last outcome distinguishes the two shapes of silence an operator has to act on
        // differently: `failed` means read a stack trace, null means nothing has run at all.
        lastOutcome: agent.heartbeat.lastOutcome ?? null,
        lastError: agent.heartbeat.lastError ?? null,
        consecutiveFailures: agent.heartbeat.consecutiveFailures,
      },
    })
    if (inserted) raised.push(agent.agentKey)
  }

  return { checked: agents.length, overdue, raised, disabled }
}
