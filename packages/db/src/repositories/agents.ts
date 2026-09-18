import type { Sql } from '../connection.ts'

/**
 * The agent registry's write paths.
 *
 * Three of them, and the shape of each is decided by a failure it prevents.
 *
 * `withAgentRun` wraps a job body so the heartbeat is written whatever happens — including when the body
 * throws, which is the case the obvious implementation misses. A heartbeat written only on success cannot
 * tell "running and failing every time" from "not running at all", and those two want different people
 * woken up at different times of night.
 *
 * `raiseAlert` inserts and swallows the unique violation, so a repeated watchdog pass during one unbroken
 * silence adds nothing. Checking first and then inserting would be a race between two watchdog passes,
 * and the losing one would throw in a cron nobody watches.
 *
 * `setKillSwitch` and `setEnabled` are separate because the two fields mean different things: disabling
 * is configuration, killing is an operator stopping a running thing now. Re-enabling moves
 * `enabled_since`, which is what keeps a backdated alert from firing the moment somebody finishes fixing
 * something.
 *
 * This module does no arithmetic. Whether an agent is overdue is `evaluateAgentHealth` in
 * `@berelax/core`, and `db` may not import `core` — so the caller evaluates and hands the verdict here.
 */

export type AgentOutcome =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'stopped_by_kill_switch'
  | 'budget_exceeded'

export interface AgentDefinitionRow {
  readonly agentKey: string
  readonly displayName: string
  readonly purpose: string
  readonly expectedIntervalSeconds: number
  readonly budgetFilsPerRun: number
  readonly enabled: boolean
  readonly killSwitch: boolean
  /** Epoch milliseconds. */
  readonly enabledSince: number
}

export interface AgentHeartbeatRow {
  readonly agentKey: string
  readonly lastRunAt: number | undefined
  readonly lastSuccessAt: number | undefined
  readonly lastFailureAt: number | undefined
  readonly lastError: string | undefined
  readonly lastOutcome: string | undefined
  readonly consecutiveFailures: number
}

export interface AgentRunResult {
  readonly runId: string
  readonly outcome: AgentOutcome
  readonly costFils: number
  readonly error: string | undefined
}

/** Every agent, with its heartbeat, for the watchdog to evaluate. */
export async function agentsWithHeartbeat(
  sql: Sql,
): Promise<readonly (AgentDefinitionRow & { heartbeat: AgentHeartbeatRow })[]> {
  const rows = (await sql`
    select d.agent_key,
           d.display_name,
           d.purpose,
           d.expected_interval_seconds,
           d.budget_fils_per_run::text as budget_fils_per_run,
           d.enabled,
           d.kill_switch,
           d.enabled_since,
           h.last_run_at,
           h.last_success_at,
           h.last_failure_at,
           h.last_error,
           h.last_outcome,
           h.consecutive_failures
    from agent_definition d
    join agent_heartbeat h on h.agent_key = d.agent_key
    order by d.agent_key
  `) as unknown as Record<string, unknown>[]

  return rows.map((row) => ({
    agentKey: row['agent_key'] as string,
    displayName: row['display_name'] as string,
    purpose: row['purpose'] as string,
    expectedIntervalSeconds: row['expected_interval_seconds'] as number,
    budgetFilsPerRun: Number(row['budget_fils_per_run']),
    enabled: row['enabled'] as boolean,
    killSwitch: row['kill_switch'] as boolean,
    enabledSince: (row['enabled_since'] as Date).getTime(),
    heartbeat: {
      agentKey: row['agent_key'] as string,
      lastRunAt: instantOf(row['last_run_at']),
      lastSuccessAt: instantOf(row['last_success_at']),
      lastFailureAt: instantOf(row['last_failure_at']),
      lastError: (row['last_error'] as string | null) ?? undefined,
      lastOutcome: (row['last_outcome'] as string | null) ?? undefined,
      consecutiveFailures: row['consecutive_failures'] as number,
    },
  }))
}

function instantOf(value: unknown): number | undefined {
  return value instanceof Date ? value.getTime() : undefined
}

export async function findAgent(
  sql: Sql,
  agentKey: string,
): Promise<AgentDefinitionRow | undefined> {
  const all = await agentsWithHeartbeat(sql)
  return all.find((agent) => agent.agentKey === agentKey)
}

export interface RunOptions {
  readonly agentKey: string
  readonly jobId?: string
  /** ISO instant the run started. Injected; this module never reads the clock. */
  readonly startedAtIso: string
  /** The trading date the run belongs to, resolved by the caller on `business_day`. */
  readonly tradingDate?: string
}

export type RunBody = (charge: (fils: number) => void) => Promise<void>

/**
 * Runs a job body as an agent run, recording the attempt and the heartbeat whatever the outcome.
 *
 * Deliberately **not** one transaction around the body. The run row and the heartbeat must survive a
 * body that throws, and a single transaction would roll back the evidence along with the work — which is
 * precisely the case the whole heartbeat contract exists to make visible. So: insert the run, run the
 * body, then record the outcome. Three statements, and the middle one is allowed to fail.
 */
export async function withAgentRun(
  sql: Sql,
  options: RunOptions,
  body: RunBody,
  budgetFactory: (capFils: number) => { charge(fils: number): void; readonly spentFils: number },
): Promise<AgentRunResult> {
  const definition = await findAgent(sql, options.agentKey)
  if (definition === undefined) {
    // Not a soft failure. An agent running with no definition has no expected interval and no budget, so
    // nothing is watching it and nothing is capping it — which is the state this table set exists to make
    // impossible.
    throw new Error(
      `No agent_definition row for '${options.agentKey}'. Every scheduled job must have one; ` +
        'see packages/db/migrations/0021_agent_registry.sql.',
    )
  }

  if (definition.killSwitch) {
    // The body is never called. An operator who flipped this wants the work stopped, not attempted once
    // more; and the run is recorded so the console shows *why* nothing happened rather than showing
    // nothing at all.
    const runId = await insertRun(sql, options, 'stopped_by_kill_switch', 0, undefined)
    await recordHeartbeat(
      sql,
      options.agentKey,
      'stopped_by_kill_switch',
      options.startedAtIso,
      undefined,
    )
    return { runId, outcome: 'stopped_by_kill_switch', costFils: 0, error: undefined }
  }

  const runId = await insertRun(sql, options, 'running', 0, undefined)
  const budget = budgetFactory(definition.budgetFilsPerRun)

  try {
    await body((fils) => budget.charge(fils))
  } catch (error) {
    // A budget abort is not the same as a bug, and the console needs to tell them apart: one means the
    // agent needs a larger cap or a smaller task, the other means somebody should read a stack trace.
    const outcome: AgentOutcome =
      error instanceof Error && error.name === 'BudgetExceeded' ? 'budget_exceeded' : 'failed'
    const message = error instanceof Error ? error.message : String(error)
    await finishRun(sql, runId, outcome, budget.spentFils, message)
    await recordHeartbeat(sql, options.agentKey, outcome, options.startedAtIso, message)
    return { runId, outcome, costFils: budget.spentFils, error: message }
  }

  await finishRun(sql, runId, 'succeeded', budget.spentFils, undefined)
  await recordHeartbeat(sql, options.agentKey, 'succeeded', options.startedAtIso, undefined)
  return { runId, outcome: 'succeeded', costFils: budget.spentFils, error: undefined }
}

async function insertRun(
  sql: Sql,
  options: RunOptions,
  outcome: AgentOutcome,
  costFils: number,
  error: string | undefined,
): Promise<string> {
  const finished = outcome === 'running' ? null : options.startedAtIso
  const [row] = (await sql`
    insert into agent_run (agent_key, job_id, started_at, finished_at, outcome, cost_fils, error, trading_date)
    values (${options.agentKey}, ${options.jobId ?? null}, ${options.startedAtIso}::timestamptz,
            ${finished}::timestamptz, ${outcome}, ${costFils}, ${error ?? null},
            ${options.tradingDate ?? null}::date)
    returning run_id::text
  `) as unknown as { run_id: string }[]
  if (row === undefined) throw new Error('agent_run insert returned no row')
  return row.run_id
}

async function finishRun(
  sql: Sql,
  runId: string,
  outcome: AgentOutcome,
  costFils: number,
  error: string | undefined,
): Promise<void> {
  await sql`
    update agent_run
    set outcome = ${outcome},
        cost_fils = ${costFils},
        error = ${error ?? null},
        finished_at = now()
    where run_id = ${runId}::uuid
  `
}

/**
 * Writes the heartbeat.
 *
 * `last_run_at` moves on every attempt; `last_success_at` only on a success. That asymmetry is the
 * contract, and it is what lets the watchdog measure the absence of a success while the console still
 * shows that the agent is alive and failing.
 *
 * A kill-switched run counts as an attempt but resets nothing: the consecutive-failure count is about the
 * body, and the body did not run.
 */
export async function recordHeartbeat(
  sql: Sql,
  agentKey: string,
  outcome: AgentOutcome,
  atIso: string,
  error: string | undefined,
): Promise<void> {
  const succeeded = outcome === 'succeeded'
  const failed = outcome === 'failed' || outcome === 'budget_exceeded'
  await sql`
    update agent_heartbeat
    set last_run_at = ${atIso}::timestamptz,
        last_outcome = ${outcome},
        last_success_at = case when ${succeeded} then ${atIso}::timestamptz else last_success_at end,
        last_failure_at = case when ${failed} then ${atIso}::timestamptz else last_failure_at end,
        last_error = case when ${failed} then ${error ?? null} when ${succeeded} then null else last_error end,
        consecutive_failures = case
          when ${succeeded} then 0
          when ${failed} then consecutive_failures + 1
          else consecutive_failures
        end
    where agent_key = ${agentKey}
  `
}

export interface AlertToRaise {
  readonly agentKey: string
  readonly incidentKey: string
  readonly silentForSeconds: number
  readonly raisedAtIso: string
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>
}

/**
 * Raises an alert, or does nothing if this incident already has one.
 *
 * `on conflict do nothing` rather than a read-then-write: two watchdog passes can overlap, and the loser
 * of a check-then-insert race throws inside a cron nobody is watching — which is the same class of
 * silent failure this whole unit exists to remove.
 */
export async function raiseAlert(sql: Sql, alert: AlertToRaise): Promise<boolean> {
  const inserted = (await sql`
    insert into agent_alert (agent_key, raised_at, incident_key, silent_for_seconds, detail)
    values (${alert.agentKey}, ${alert.raisedAtIso}::timestamptz, ${alert.incidentKey},
            ${alert.silentForSeconds}, ${sql.json({ ...(alert.detail ?? {}) })})
    on conflict (agent_key, incident_key) do nothing
    returning alert_id::text
  `) as unknown as { alert_id: string }[]
  return inserted.length === 1
}

export async function setKillSwitch(sql: Sql, agentKey: string, on: boolean): Promise<void> {
  await sql`update agent_definition set kill_switch = ${on} where agent_key = ${agentKey}`
}

/**
 * Enables or disables an agent.
 *
 * Enabling moves `enabled_since`, and that single line is what makes "re-enabling does not emit a
 * backdated alert" structural. Without it, an agent switched off for a week alerts the instant it comes
 * back, for silence that was deliberate.
 */
export async function setEnabled(
  sql: Sql,
  agentKey: string,
  enabled: boolean,
  atIso: string,
): Promise<void> {
  await sql`
    update agent_definition
    set enabled = ${enabled},
        enabled_since = case when ${enabled} and not enabled then ${atIso}::timestamptz else enabled_since end
    where agent_key = ${agentKey}
  `
}

/** Alerts not yet acknowledged, newest first. What a console shows and a notifier reads. */
export async function openAlerts(
  sql: Sql,
): Promise<readonly { agentKey: string; incidentKey: string; silentForSeconds: number }[]> {
  const rows = (await sql`
    select agent_key, incident_key, silent_for_seconds
    from agent_alert
    where acknowledged_at is null
    order by raised_at desc
  `) as unknown as { agent_key: string; incident_key: string; silent_for_seconds: number }[]
  return rows.map((row) => ({
    agentKey: row.agent_key,
    incidentKey: row.incident_key,
    silentForSeconds: row.silent_for_seconds,
  }))
}
