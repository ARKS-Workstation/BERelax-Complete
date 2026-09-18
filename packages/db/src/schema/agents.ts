import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * The agent registry — the mirror of 0021.
 *
 * Eight agents in this system work on a schedule nobody watches in real time, and every one of them
 * fails the same way: silently. docs/10 §6 states the rule this table set exists to enforce — a pg-boss
 * job failure is not evidence anybody has seen, because nobody reads `pgboss.job`. So an agent declares
 * how often it expects to succeed, and a watchdog alerts when it has not, whatever the cause.
 */
export const agentDefinition = pgTable('agent_definition', {
  agentKey: text('agent_key').primaryKey(),
  displayName: text('display_name').notNull(),
  purpose: text('purpose').notNull(),
  /** The watchdog alerts at twice this, so a daily agent is not paged for being four hours late. */
  expectedIntervalSeconds: integer('expected_interval_seconds').notNull(),
  /**
   * `mode: 'bigint'` because the underlying domain is `fils`, which is `bigint`.
   *
   * The driver returns bigint as a string precisely so a value beyond 2^53 cannot be silently rounded;
   * `mode: 'number'` would undo that, on a money column.
   */
  budgetFilsPerRun: bigint('budget_fils_per_run', { mode: 'bigint' }).notNull(),
  enabled: boolean('enabled').notNull(),
  /**
   * Distinct from `enabled`. `enabled` is configuration — this agent is part of the product.
   * `kill_switch` is an operator stopping a running thing now: a disabled agent is silent by design, a
   * killed one is an incident, and the two want different audit stories.
   */
  killSwitch: boolean('kill_switch').notNull(),
  /** Silence is measured from `greatest(last_success_at, enabled_since)`. See the watchdog. */
  enabledSince: timestamp('enabled_since', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const agentRun = pgTable(
  'agent_run',
  {
    runId: uuid('run_id').primaryKey().default(sql`uuid_generate_v7()`),
    agentKey: text('agent_key')
      .notNull()
      .references(() => agentDefinition.agentKey),
    /**
     * The pg-boss job id, as text with no foreign key.
     *
     * The job row is subject to pg-boss's retention policy and will eventually be deleted, so a
     * foreign key would either block retention or cascade away the run history — and the run history is
     * the thing somebody reads six weeks later when the LLM bill is queried.
     */
    jobId: text('job_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    outcome: text('outcome').notNull(),
    /** Recorded even on a run that aborted: partial spend the bill would otherwise not explain. */
    costFils: bigint('cost_fils', { mode: 'bigint' }).notNull(),
    error: text('error'),
    /**
     * The trading date, not the calendar date.
     *
     * Trading runs 11:00–02:00, so a 01:30 run belongs to the previous trading day. A per-day agent cost
     * report cutting on the calendar date would split one night's work across two rows.
     */
    tradingDate: date('trading_date'),
  },
  (t) => [
    index('agent_run_agent_started_idx').on(t.agentKey, t.startedAt.desc()),
    index('agent_run_unfinished_idx').on(t.agentKey).where(sql`outcome = 'running'`),
    check(
      'agent_run_outcome_check',
      sql`outcome in ('running', 'succeeded', 'failed', 'stopped_by_kill_switch', 'budget_exceeded')`,
    ),
    check('agent_run_finished_check', sql`(outcome = 'running') = (finished_at is null)`),
    check(
      'agent_run_error_check',
      sql`(error is null) or (outcome in ('failed', 'budget_exceeded'))`,
    ),
  ],
)

export const agentHeartbeat = pgTable('agent_heartbeat', {
  agentKey: text('agent_key')
    .primaryKey()
    .references(() => agentDefinition.agentKey),
  /**
   * Written on failure as well as success, which is the whole point.
   *
   * A heartbeat that recorded only successes cannot tell "running and failing every time" from "not
   * running at all", and those two need different people woken up.
   */
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  lastError: text('last_error'),
  lastOutcome: text('last_outcome'),
  consecutiveFailures: integer('consecutive_failures').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const agentAlert = pgTable(
  'agent_alert',
  {
    alertId: uuid('alert_id').primaryKey().default(sql`uuid_generate_v7()`),
    agentKey: text('agent_key')
      .notNull()
      .references(() => agentDefinition.agentKey),
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull(),
    /**
     * One alert per unbroken silence.
     *
     * Derived from the last success the watchdog saw, so every pass during the same incident computes
     * the same key and the unique constraint discards the duplicate. A watchdog running every fifteen
     * minutes would otherwise raise ninety-six alerts for one broken agent, and the ninety-sixth is the
     * one nobody reads.
     */
    incidentKey: text('incident_key').notNull(),
    silentForSeconds: integer('silent_for_seconds').notNull(),
    detail: jsonb('detail').notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  },
  (t) => [
    unique('agent_alert_agent_key_incident_key_key').on(t.agentKey, t.incidentKey),
    check('agent_alert_silent_for_seconds_check', sql`silent_for_seconds >= 0`),
  ],
)
