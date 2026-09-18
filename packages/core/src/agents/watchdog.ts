import type { Instant } from '../time.ts'

/**
 * The watchdog: alert on the **absence of a success**, not on the presence of an error.
 *
 * This is the inversion the whole agent substrate is built on, and it is worth being precise about why.
 * Every obvious alarm watches for failures — a handler threw, a provider returned 500, a job was marked
 * failed. Each of those catches a real problem, and together they catch none of the problems that
 * actually happen to scheduled work:
 *
 *  - a cron renamed in one place and not the other, so nothing is scheduled at all;
 *  - a deploy that dropped the registration, so the queue exists and nothing feeds it;
 *  - a worker that lost its database connection and is sitting quietly in a retry loop;
 *  - a kill switch somebody flipped during an incident three weeks ago and nobody flipped back.
 *
 * None of those produces an error anywhere. All four look exactly like an agent with nothing to do.
 * Measuring silence catches all of them, and catches the ones nobody has thought of yet, because the
 * condition is not "something went wrong" but "the thing that should have happened has not".
 *
 * docs/10 §6: a pg-boss job failure is not evidence anybody has seen, because nobody reads
 * `pgboss.job`.
 *
 * Pure: the clock is an argument, and every timestamp comes from the caller.
 */

/**
 * How many expected intervals of silence before an alert.
 *
 * Two, not one. An agent that runs daily at 03:00 and is thirty minutes late is not an incident — the
 * queue was busy, a deploy shifted it, the poll landed on the wrong side of the minute. Two whole
 * intervals means a genuine miss has been observed and the *next* one has been missed too, which cannot
 * be explained by jitter. It is also the figure the manifest's boundary test pins: 47h59m on a 24h
 * interval is healthy, 48h01m is not.
 */
export const OVERDUE_INTERVAL_MULTIPLE = 2

export interface AgentHealthInput {
  readonly agentKey: string
  readonly enabled: boolean
  /**
   * When the agent last became enabled.
   *
   * Silence is measured from the later of this and the last success, and that is what makes "re-enabling
   * does not emit a backdated alert" structural rather than a special case. Without it, switching an
   * agent off for a week and back on produces an immediate alert for a week of silence that was
   * deliberate — an alarm that fires the moment somebody finishes fixing something, which is the fastest
   * way to teach a team to ignore an alarm.
   */
  readonly enabledSince: Instant
  readonly expectedIntervalSeconds: number
  /** Undefined for an agent that has never succeeded, including one that has never run. */
  readonly lastSuccessAt: Instant | undefined
}

export type AgentHealth =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'healthy'; readonly silentForSeconds: number }
  | {
      readonly kind: 'overdue'
      readonly silentForSeconds: number
      readonly overdueBySeconds: number
      /**
       * Identifies the incident, so a repeated pass does not raise a second alert.
       *
       * Derived from the instant silence started rather than from the time of the alert: every pass
       * during the same unbroken silence computes the same value, and the unique constraint on
       * `agent_alert` discards the duplicate. A fifteen-minute watchdog would otherwise raise
       * ninety-six alerts for one broken agent, and the ninety-sixth is the one nobody reads.
       *
       * It changes the moment a success lands, which is exactly when a new silence could begin.
       */
      readonly incidentKey: string
    }

/**
 * The instant silence began: the later of the last success and the moment the agent became enabled.
 */
export function silenceStartedAt(input: AgentHealthInput): Instant {
  const success = input.lastSuccessAt
  if (success === undefined) return input.enabledSince
  return (success > input.enabledSince ? success : input.enabledSince) as Instant
}

export function evaluateAgentHealth(input: AgentHealthInput, now: Instant): AgentHealth {
  // A disabled agent is silent by design. Checked first, before any arithmetic, because an agent
  // disabled for a year would otherwise produce the largest overdue figure in the system.
  if (!input.enabled) return { kind: 'disabled' }

  const from = silenceStartedAt(input)
  // `max(0, …)` rather than a signed figure. A clock that went backwards, or an `enabled_since` in the
  // future because somebody scheduled an enable, should read as "no silence yet" and not as a negative
  // duration that compares as less than every threshold by accident.
  const silentForSeconds = Math.max(0, Math.floor((now - from) / 1000))
  const thresholdSeconds = input.expectedIntervalSeconds * OVERDUE_INTERVAL_MULTIPLE

  // Strictly greater than. At exactly twice the interval the agent is due, not late — and a boundary
  // that alerted at equality would fire on every agent whose schedule happens to align with the
  // watchdog's own, which is most of them, once a day, forever.
  if (silentForSeconds <= thresholdSeconds) return { kind: 'healthy', silentForSeconds }

  return {
    kind: 'overdue',
    silentForSeconds,
    overdueBySeconds: silentForSeconds - thresholdSeconds,
    incidentKey: incidentKeyFor(input.agentKey, from),
  }
}

/**
 * The incident key: the agent and the instant its silence began.
 *
 * Deliberately not including `now`, and deliberately not a random id. Those are the two ways this goes
 * wrong: a key with the current time in it dedupes nothing, and a random key dedupes nothing while
 * looking as though it should.
 */
export function incidentKeyFor(agentKey: string, silenceStarted: Instant): string {
  return `${agentKey}:${silenceStarted}`
}

/** True when a health verdict should produce an alert row. */
export function isOverdue(
  health: AgentHealth,
): health is Extract<AgentHealth, { kind: 'overdue' }> {
  return health.kind === 'overdue'
}

/**
 * Per-run budget.
 *
 * An LLM agent's cost is not bounded by anything the agent itself knows: a retry loop, a document longer
 * than expected, a prompt that grew. The cap is per *run* rather than per month because a monthly cap is
 * discovered on the day it is breached, by which point the money is spent — and because a runaway run is
 * the failure that produces a month's budget in an afternoon.
 */
export class BudgetExceeded extends Error {
  readonly spentFils: number
  readonly capFils: number
  readonly attemptedFils: number

  constructor(spentFils: number, capFils: number, attemptedFils: number) {
    super(
      `Agent budget exceeded: ${spentFils} fils already spent, a further ${attemptedFils} would ` +
        `exceed the ${capFils} fils per-run cap`,
    )
    this.name = 'BudgetExceeded'
    this.spentFils = spentFils
    this.capFils = capFils
    this.attemptedFils = attemptedFils
  }
}

export interface RunBudget {
  /** Charges the run, or throws `BudgetExceeded` leaving the recorded spend unchanged. */
  charge(fils: number): void
  readonly spentFils: number
  readonly capFils: number
}

/**
 * A budget a job body charges against.
 *
 * `charge` throws rather than returning false, because the alternative is an agent that carries on with
 * no money — and the thing it does next is usually the write, which is the one step that must not happen
 * on a partial result. The spend already made is readable afterwards and is persisted on the aborted
 * run: a budget-exceeded run that recorded nothing would make the month's bill unexplainable by exactly
 * the runs that caused it.
 */
export function createRunBudget(capFils: number): RunBudget {
  let spent = 0
  return {
    charge(fils: number): void {
      if (!Number.isInteger(fils) || fils < 0) {
        throw new RangeError(`A charge must be a non-negative integer number of fils, got ${fils}`)
      }
      if (spent + fils > capFils) throw new BudgetExceeded(spent, capFils, fils)
      spent += fils
    },
    get spentFils() {
      return spent
    },
    get capFils() {
      return capFils
    },
  }
}
