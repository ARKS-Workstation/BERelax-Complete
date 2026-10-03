import {
  agentsWithHeartbeat,
  type DeadLetteredDispatch,
  deadLetteredDispatches,
  openAlerts,
  type Sql,
} from '@berelax/db'

/**
 * The agent console's reads (A-MEAS-06): what every agent's heartbeat says, and what has given up.
 *
 * ## Why this is a query module and not a route
 *
 * `apps/web/src/routes/registry.ts` is in exact bijection with the filesystem and requires every DOCUMENT
 * to be served in both locales, so a screen here would need an Arabic admin document and the W-SYS-01
 * shell. There is no agent console document yet — nothing under `app/(admin)/agents` serves a route except
 * G-SEO's snapshot — so these are the functions the screen that arrives will call, which is A-MEAS-07's
 * recorded precedent for `revenue-by-source.ts`.
 *
 * ## Why the dead-letter read exists at all
 *
 * Because a dead-letter queue nothing reads is the same defect one level down from a watchdog nothing
 * watches: the row exists, the failure is recorded, and nobody is told. 0151's own header names this file
 * as the reader, and the index `analytics_dispatch_dead_letter_idx` exists for this query. The watchdog is
 * the second reader and puts the COUNT on every alert it raises; this is the one that lists the rows, with
 * the provider's own last words on each — which is the only record of why a conversion will never go out.
 *
 * ## What a row here does NOT offer
 *
 * A delete. ZY711 refuses one for every role including the owner, because the row IS the record that a
 * conversion was permanently not delivered and A-MEAS-07 reconciles against exactly that: a deleted dead
 * letter makes a conversion the platform never heard about indistinguishable from one nobody enqueued, so
 * the day would reconcile while the money was short. The remedy is to re-queue, which the ZY312 consent
 * gate re-judges on the way (ADR 0091) — so a conversion re-opened after a withdrawal is refused rather
 * than sent.
 */

/** One agent, as a console row: the four heartbeat fields, and whether the watchdog would alert. */
export interface AgentConsoleRow {
  readonly agentKey: string
  readonly displayName: string
  readonly purpose: string
  readonly enabled: boolean
  readonly killSwitch: boolean
  readonly expectedIntervalSeconds: number
  /** ISO instants, or `null` for an agent that has never run. The four fields of 0021 plus 0151's. */
  readonly lastRunAtIso: string | null
  readonly lastSuccessAtIso: string | null
  readonly nextRunAtIso: string | null
  readonly lastError: string | null
  readonly lastOutcome: string | null
  readonly consecutiveFailures: number
  /**
   * Whether this agent has an unacknowledged alert open.
   *
   * Read from `agent_alert` rather than recomputed from the heartbeat, deliberately: the watchdog's
   * verdict is what woke somebody, and a console that re-derived it would show a different answer the
   * moment the two disagreed — which is exactly when somebody is looking.
   */
  readonly alertOpen: boolean
}

export interface AgentConsole {
  readonly agents: readonly AgentConsoleRow[]
  /** Dispatches that have given up, newest first. Never deleted (ZY711); re-queue instead. */
  readonly deadLetters: readonly DeadLetteredDispatch[]
}

const isoOrNull = (epochMs: number | undefined): string | null =>
  epochMs === undefined ? null : new Date(epochMs).toISOString()

/**
 * Everything the console shows, in two reads.
 *
 * `agentsWithHeartbeat` INNER JOINS `agent_definition` and `agent_heartbeat`, so an agent with no
 * heartbeat row is invisible here exactly as it is to the watchdog — which is the state 0021's convention
 * and `pnpm jobs` exist to make impossible, and not something this module should paper over with an outer
 * join. A missing agent is a failing gate, not a blank cell.
 */
export async function agentConsole(
  sql: Sql,
  options: { readonly deadLetterLimit?: number } = {},
): Promise<AgentConsole> {
  const agents = await agentsWithHeartbeat(sql)
  const alerts = await openAlerts(sql)
  const alerting = new Set(alerts.map((alert) => alert.agentKey))
  const deadLetters = await deadLetteredDispatches(sql, {
    limit: options.deadLetterLimit ?? 50,
  })
  return {
    agents: agents.map((agent) => ({
      agentKey: agent.agentKey,
      displayName: agent.displayName,
      purpose: agent.purpose,
      enabled: agent.enabled,
      killSwitch: agent.killSwitch,
      expectedIntervalSeconds: agent.expectedIntervalSeconds,
      lastRunAtIso: isoOrNull(agent.heartbeat.lastRunAt),
      lastSuccessAtIso: isoOrNull(agent.heartbeat.lastSuccessAt),
      nextRunAtIso: isoOrNull(agent.heartbeat.nextRunAt),
      lastError: agent.heartbeat.lastError ?? null,
      lastOutcome: agent.heartbeat.lastOutcome ?? null,
      consecutiveFailures: agent.heartbeat.consecutiveFailures,
      alertOpen: alerting.has(agent.agentKey),
    })),
    deadLetters,
  }
}

/**
 * The two analytics agents, named, for the panel that is about this pipeline rather than about all twelve.
 *
 * Spelled as a pair because A-MEAS-06's acceptance line is about exactly these two: the five-minute
 * consumer and the nightly rollup. `offline_conversions` is the third of the family and has its own agent
 * from 0151 — it is included, because the whole reason it stopped sharing the consumer's heartbeat is that
 * a shared one hid it.
 */
export const AGENT_CONSOLE_ANALYTICS_KEYS: readonly string[] = Object.freeze([
  'analytics_dispatch',
  'nightly_rollups',
  'offline_conversions',
])

export async function analyticsAgentConsole(sql: Sql): Promise<AgentConsole> {
  const whole = await agentConsole(sql)
  return {
    agents: whole.agents.filter((agent) => AGENT_CONSOLE_ANALYTICS_KEYS.includes(agent.agentKey)),
    deadLetters: whole.deadLetters,
  }
}
