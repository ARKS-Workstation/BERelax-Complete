import { describe, expect, it } from 'vitest'
import { cronRegistrations, isValidCron, JOB_REGISTRY } from '../registry.ts'
import {
  ANALYTICS_PARTITIONS_AGENT,
  ANALYTICS_PARTITIONS_JOB,
  ANALYTICS_RETENTION_AGENT,
  ANALYTICS_RETENTION_JOB,
  countByAction,
  RETENTION_ACTIONS,
  type RetentionAction,
} from './analytics-partitions.ts'

/**
 * A-FIRST-01's two scheduled passes: that they are REGISTERED, and that their schedule is asserted.
 *
 * "A documented policy with no job is not retention." A module exporting a `JobDefinition` nothing imports
 * is exactly that: the cron never fires, `pnpm jobs` is happy because it only validates what the registry
 * holds, and the symptom is a table that grows for ever with nothing saying why. So the membership is a
 * test, and it is here rather than in the integration suite because it needs no database — the defect it
 * catches is a missing line in an array.
 *
 * The pairing is a test for `gsc-jobs.test.ts`'s reason, which applies with more force here: the watchdog
 * measures the absence of a success PER AGENT, so two crons sharing a heartbeat report as healthy whenever
 * either of them runs. Partition creation and retention fail independently and for unrelated causes — one
 * is refused by a lock, the other by an unpolicied table — and a shared agent would make either failure
 * invisible for as long as the other kept working.
 */

const partitions = JOB_REGISTRY.find((job) => job.name === ANALYTICS_PARTITIONS_JOB)
const retention = JOB_REGISTRY.find((job) => job.name === ANALYTICS_RETENTION_JOB)

describe('acceptance — the analytics partition and retention passes are registered and watched', () => {
  it('registers both jobs, which is what makes either of them run at all', () => {
    expect(partitions, `${ANALYTICS_PARTITIONS_JOB} is not in JOB_REGISTRY`).toBeDefined()
    expect(retention, `${ANALYTICS_RETENTION_JOB} is not in JOB_REGISTRY`).toBeDefined()
    // `worker.itest.ts` asserts the registry and `pgboss.schedule` equal each other in both directions, so
    // membership here is what makes the schedule exist in the database. Without these two lines a module
    // holding a perfectly correct JobDefinition would never fire once.
  })

  it('declares the schedule, each naming its own agent', () => {
    // 03:20, just after `audit.ensure-partitions` at 03:00 — the same obligation for `audit_event` — and
    // deliberately off the quarter hour, where `agent.watchdog` and the scheduled-step sweep both run.
    expect(partitions?.cron).toBe('20 3 * * *')
    // 05:50, after every other nightly pass, because each partition it detaches takes an ACCESS EXCLUSIVE
    // lock on the parent. Not a correctness ordering: what it removes is 90 days older than anything the
    // rollups read.
    expect(retention?.cron).toBe('50 5 * * *')
    expect(isValidCron(partitions?.cron ?? '')).toBe(true)
    expect(isValidCron(retention?.cron ?? '')).toBe(true)

    expect(partitions?.agent).toBe(ANALYTICS_PARTITIONS_AGENT)
    expect(retention?.agent).toBe(ANALYTICS_RETENTION_AGENT)
    // Two agents and not one. The rows are inserted by migration 0096 and
    // `apps/worker/src/jobs/agent-watchdog.itest.ts` asserts every registered cron's agent has one.
    expect(partitions?.agent).not.toBe(retention?.agent)
  })

  it('shares neither agent with any other cron in the registry', () => {
    // The other direction of the same rule, and the one a copy-paste gets wrong: naming an existing agent
    // is always valid — every `agent_definition` row is a legal value — and the consequence is silent.
    const crons = cronRegistrations(JOB_REGISTRY)
    for (const agent of [ANALYTICS_PARTITIONS_AGENT, ANALYTICS_RETENTION_AGENT]) {
      expect(
        crons.filter((cron) => cron.agent === agent).map((cron) => cron.name),
        `${agent} must be claimed by exactly one cron, or a dead pass is invisible behind a live one`,
      ).toHaveLength(1)
    }
    // The control: the registry this filtered was not empty, and it does hold other crons to be confused
    // with. Without it the assertion above passes over an empty array.
    expect(crons.length).toBeGreaterThan(8)
  })

  it('neither is a queue with no cron, which is what a pass nothing announces has to be', () => {
    // Both are obligations of the STORAGE rather than of anything a request did, so there is no caller to
    // watch and no enqueue to be announced by. A cron is therefore the right shape and an agent is required
    // — which is the rule `pnpm jobs` refuses statically.
    for (const job of [partitions, retention]) {
      expect(job?.cron).toBeDefined()
      expect((job?.agent ?? '').trim().length).toBeGreaterThan(0)
      expect(job?.purpose.length).toBeGreaterThan(80)
      expect(job?.retryLimit).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('countByAction', () => {
  const row = (action: string): RetentionAction => ({ relation: 'event', action, detail: 'x' })

  it('counts every action the pass can report, and reports a zero for the ones it did not', () => {
    const counts = countByAction([
      row('dropped_partition'),
      row('dropped_partition'),
      row('kept_partition'),
      row('exempt'),
    ])
    expect(counts.dropped_partition).toBe(2)
    expect(counts.kept_partition).toBe(1)
    expect(counts.exempt).toBe(1)
    // A zero rather than `undefined`, because the log line interpolates these directly and `undefined
    // partition(s) dropped` is a line a reader skips over rather than reads as a quiet night.
    expect(counts.purged_rows).toBe(0)
    expect(counts.guarded_default_partition).toBe(0)
  })

  it('starts every action at zero for an empty report, and knows all five', () => {
    const counts = countByAction([])
    expect(Object.keys(counts).sort()).toEqual([...RETENTION_ACTIONS].sort())
    expect(Object.values(counts)).toEqual([0, 0, 0, 0, 0])
  })

  it('ignores an action it does not know, rather than counting it as one it does', () => {
    // The alternative — incrementing whatever key arrives — would let a typo in the SQL create a sixth
    // count nobody reads while the figure it was meant to be part of stayed at zero. This is the honest
    // half; the other half is the integration suite, which holds RETENTION_ACTIONS equal to what the
    // function actually returns, so an action added in SQL alone is a red test rather than a lost figure.
    const counts = countByAction([row('droped_partition'), row('dropped_partition')])
    expect(counts.dropped_partition).toBe(1)
    expect(Object.keys(counts)).toHaveLength(RETENTION_ACTIONS.length)
  })
})
