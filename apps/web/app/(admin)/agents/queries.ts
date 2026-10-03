import {
  type AgentReason,
  agentConsoleReason,
  filsFromStoredDigits,
  type GoogleConnectionDisplayState,
  type Money,
  money,
} from '@berelax/core'
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

// --- the console screen's own reads (G-AGT-02) -----------------------------------------------------

/**
 * What one agent's money looks like for one trading date.
 *
 * ## Why this is cost-to-date against a PER-RUN budget, and what is therefore unknown
 *
 * `agent_definition.budget_fils_per_run` is the only budget this schema holds, and it is a ceiling for
 * ONE run — enforced mid-run by `createRunBudget`, which is what makes `budget_exceeded` a real outcome
 * rather than a report. There is no per-day, per-week or per-month budget anywhere, so "cost to date
 * against its budget" has to be assembled from the two figures that exist:
 *
 *   - `spent` is MEASURED: `sum(agent_run.cost_fils)` over the date's runs. Every figure on this screen
 *     comes from that column and nothing is modelled.
 *   - `ceiling` is DERIVED: `budget_fils_per_run × runs`, which is what the day was permitted to cost
 *     given how many times it ran.
 *
 * The derivation carries an assumption and the screen says so: it assumes every run was entitled to its
 * full ceiling, which is true of the enforcement and is not a budget anybody set for a DAY. `Y13-agent-
 * period-budget` records the gap. This is the brief's rule applied literally — the specification gives a
 * mechanism and no figure, so the mechanism is built and the figure is filed as a question rather than
 * invented.
 *
 * ## Why an agent with a nought budget has no ratio
 *
 * Twenty-nine of the thirty-two seeded agents have `budget_fils_per_run = 0`, and that is a MEASURED
 * nought rather than a missing figure: those passes read this build's own tables and perform no outbound
 * call, so there is nothing for them to spend. A nought ceiling has no percentage — `spent / 0` is not
 * 100% and is not infinity — so {@link AgentCost.share} is null for them and the screen prints "no
 * budget" rather than a figure (ADR 0002).
 */
export interface AgentCost {
  /** Integer fils, measured. `Money` so a float cannot be constructed (ADR 0007, the F05 type). */
  readonly spent: Money
  /** The per-run ceiling the definition carries. Nought for an agent that spends nothing. */
  readonly perRun: Money
  readonly runs: number
  /** `perRun × runs`. Nought exactly when `perRun` is. */
  readonly ceiling: Money
  /**
   * `spent` over `ceiling` in per mille, or null when there is no ceiling to be a share of.
   *
   * Per mille integers for the reason every rate in this build is one: a percentage computed in floating
   * point and rendered to one decimal place disagrees with the two integers it came from.
   */
  readonly share: number | null
  /** The worst single run's share of its own per-run ceiling, in per mille, or null. */
  readonly worstRunShare: number | null
}

/** The warning variant fires at this share of a budget. 99%, which the acceptance line names. */
export const AGENT_BUDGET_WARNING_PER_MILLE = 990

/** True when a run has spent at least 99% of what one run is allowed. */
export const agentBudgetWarns = (cost: AgentCost): boolean =>
  cost.worstRunShare !== null && cost.worstRunShare >= AGENT_BUDGET_WARNING_PER_MILLE

const perMille = (numerator: bigint, denominator: bigint): number | null =>
  denominator <= 0n ? null : Number((numerator * 1000n) / denominator)

/**
 * Every agent's money for one trading date, by key.
 *
 * `agent_run.trading_date` and not `started_at::date`: a run that began at 01:30 belongs to the previous
 * trading date (ADR 0007), and a calendar-date grouping would move a night's spend onto the wrong day —
 * which for a budget is the difference between a day that was inside it and one that was not.
 *
 * A `Map` rather than rows, because the caller joins it to the agent list and an agent with no run on the
 * date must get a zero-run cost rather than being absent from the console.
 */
export async function agentCosts(
  sql: Sql,
  query: { readonly tradingDate: string },
): Promise<ReadonlyMap<string, AgentCost>> {
  const rows = await sql<
    { agentKey: string; perRun: string; runs: number; spent: string; worstRun: string }[]
  >`
    select d.agent_key                                  as "agentKey",
           d.budget_fils_per_run::text                  as "perRun",
           count(r.run_id)::int                         as runs,
           coalesce(sum(r.cost_fils), 0)::text          as spent,
           coalesce(max(r.cost_fils), 0)::text          as "worstRun"
      from agent_definition d
      left join agent_run r
        on r.agent_key = d.agent_key and r.trading_date = ${query.tradingDate}::date
     group by d.agent_key, d.budget_fils_per_run
     order by d.agent_key
  `
  return new Map(
    rows.map((row) => {
      const perRunFils = BigInt(row.perRun)
      const spentFils = BigInt(row.spent)
      const ceilingFils = perRunFils * BigInt(row.runs)
      return [
        row.agentKey,
        {
          spent: money(filsFromStoredDigits(row.spent, 'agent_run.cost_fils')),
          perRun: money(filsFromStoredDigits(row.perRun, 'agent_definition.budget_fils_per_run')),
          runs: row.runs,
          ceiling: money(filsFromStoredDigits(ceilingFils.toString(), 'the derived daily ceiling')),
          share: perMille(spentFils, ceilingFils),
          worstRunShare: perMille(BigInt(row.worstRun), perRunFils),
        } satisfies AgentCost,
      ]
    }),
  )
}

/**
 * How many items are waiting for a person, per agent that has a queue.
 *
 * Counted in SQL and never read off a list, which is `settings-store.itest.ts`'s lesson: a limit is right
 * for a panel and wrong for a count, and a capped reader pinned at its limit reports the cap as the
 * answer. The acceptance line is *"match a SQL count exactly"*, and the only way to mean that is to
 * compare against the same `count(*)`.
 *
 * Two queues today, both named by the acceptance line. An agent with no queue is absent from the map and
 * the console prints a dash rather than a nought: "nothing is waiting" and "this agent has nothing that
 * waits" are different facts, and only one of them is a number.
 */
export const REVIEW_REPLY_AGENT_KEY = 'review_autoresponder'
export const SEO_SUGGESTION_AGENT_KEY = 'seo_agent'

export async function agentPendingApprovals(sql: Sql): Promise<ReadonlyMap<string, number>> {
  /*
   * A drafted reply nobody has approved and nobody has quarantined.
   *
   * All three clauses. `reply_draft is not null` is a reply that exists; `reply_approved_text is null` is
   * one nobody has approved — approval writes the text it approved, which is the compliance-relevant
   * fact (0128, ZY341); and `draft_quarantine_reason is null` excludes the drafts the linter refused,
   * which are NOT waiting for a person at all. Counting a quarantined draft would put an item on the
   * owner's queue that the queue screen does not show.
   */
  const [drafts] = await sql<{ n: string }[]>`
    select count(*)::text as n
      from google_reviews
     where reply_draft is not null
       and reply_approved_text is null
       and draft_quarantine_reason is null
  `
  const [suggestions] = await sql<{ n: string }[]>`
    select count(*)::text as n from seo_suggestion where state = 'proposed'
  `
  if (drafts === undefined || suggestions === undefined) {
    // An aggregate over an empty table returns one row, so this cannot happen — and it is named rather
    // than coalesced, because a nought here is "nothing is waiting" and that is the one answer a reader
    // that failed must not give.
    throw new Error(
      'A pending-approval count returned no row, which an aggregate over an empty table cannot.',
    )
  }
  return new Map([
    [REVIEW_REPLY_AGENT_KEY, Number(drafts.n)],
    [SEO_SUGGESTION_AGENT_KEY, Number(suggestions.n)],
  ])
}

/** One row of the console: the registry's agent, its heartbeat, its money, its queue and its reason. */
export interface AgentConsoleScreenRow extends AgentConsoleRow {
  readonly cost: AgentCost
  /** Null for an agent with no queue, which is different from a queue with nothing in it. */
  readonly pending: number | null
  readonly reason: AgentReason
}

export interface AgentConsoleScreen {
  readonly tradingDate: string
  readonly rows: readonly AgentConsoleScreenRow[]
  /** The Google connection's display state, or null when nothing is connected. Drives two reasons. */
  readonly googleState: GoogleConnectionDisplayState | null
  readonly deadLetters: readonly DeadLetteredDispatch[]
}

/**
 * The whole console, for one trading date.
 *
 * The rows come from {@link agentConsole}, which INNER JOINs `agent_definition` to `agent_heartbeat` —
 * so the list is the registry's and not a hand-maintained one, and an `agent_definition` row with a
 * heartbeat appears here with no code change. That is the acceptance line's first claim, and the reason
 * the join is inner rather than outer is 0021's: an agent with no heartbeat is invisible to the watchdog
 * too, and `pnpm jobs` refuses one, so a missing agent is a failing gate rather than a blank cell.
 */
export async function agentConsoleScreen(
  sql: Sql,
  query: {
    readonly tradingDate: string
    readonly googleState: GoogleConnectionDisplayState | null
  },
): Promise<AgentConsoleScreen> {
  const base = await agentConsole(sql)
  const costs = await agentCosts(sql, { tradingDate: query.tradingDate })
  const pending = await agentPendingApprovals(sql)
  const zero: AgentCost = {
    spent: money(filsFromStoredDigits('0', 'agent_run.cost_fils')),
    perRun: money(filsFromStoredDigits('0', 'agent_definition.budget_fils_per_run')),
    runs: 0,
    ceiling: money(filsFromStoredDigits('0', 'the derived daily ceiling')),
    share: null,
    worstRunShare: null,
  }
  return {
    tradingDate: query.tradingDate,
    googleState: query.googleState,
    deadLetters: base.deadLetters,
    rows: base.agents.map((agent) => ({
      ...agent,
      cost: costs.get(agent.agentKey) ?? zero,
      pending: pending.get(agent.agentKey) ?? null,
      reason: agentConsoleReason({
        agentKey: agent.agentKey,
        enabled: agent.enabled,
        killSwitch: agent.killSwitch,
        consecutiveFailures: agent.consecutiveFailures,
        lastOutcome: agent.lastOutcome,
        lastError: agent.lastError,
        alertOpen: agent.alertOpen,
        googleState: query.googleState,
      }),
    })),
  }
}
