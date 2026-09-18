/**
 * What a job *is*: the three types the registry, the handlers and the harness all speak.
 *
 * A separate module from `registry.ts` for one structural reason. A job body that imported its own
 * `JobContext` from the registry the registry imports it back into is a cycle — `pnpm boundaries` reports
 * it as one, and `no-circular` is an error because a cycle makes build order and reasoning undecidable.
 * The types have no dependencies of their own, so extracting them costs nothing and lets every future job
 * module declare its own `JobDefinition` beside its handler instead of leaving half of it in the registry.
 *
 * `registry.ts` re-exports all three, so nothing that already imports them from there has to change.
 */
export interface JobContext {
  readonly jobId: string
  /** The instant the handler started, injected so a job body never reads the clock itself. */
  readonly now: () => string
}

export type JobHandler<Data> = (data: Data, context: JobContext) => Promise<void>

export interface JobDefinition<Data = unknown> {
  /** Queue name. Kebab-case, and the same string the cron schedules. */
  readonly name: string
  /** Why this job exists. Not optional — an unexplained cron is one nobody dares delete. */
  readonly purpose: string
  /**
   * A 5-field cron expression in Asia/Dubai, or `undefined` for a queue that is only sent to.
   *
   * Validated at import time by `assertRegistry`, because a malformed expression is accepted by
   * `boss.schedule` and simply never fires.
   */
  readonly cron?: string
  /**
   * The `agent_definition` this job reports to.
   *
   * **Required on any job with a `cron`**, and that is the load-bearing part of this type. A scheduled
   * job with no agent row has no declared interval and no budget, so nothing is watching it and nothing
   * is capping it — and a cron nobody watches is the failure G-AGT-01 exists to remove. `pnpm jobs`
   * rejects a cron without one, and `agents.itest.ts` asserts every registered cron's agent has a row.
   *
   * A queue that is only sent to needs none: its caller is a request or another job, and that caller is
   * the thing being watched.
   */
  readonly agent?: string
  readonly retryLimit: number
  readonly retryDelaySeconds: number
  readonly retryBackoff: boolean
  /** Seconds a handler may run before pg-boss reclaims the job as expired. */
  readonly expireInSeconds: number
  readonly handler: JobHandler<Data>
}
