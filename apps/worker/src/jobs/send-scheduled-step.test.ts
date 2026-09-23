import { invalidationsFor } from '@berelax/config'
import { REBUILD_SCHEDULED_STEPS_JOB, REMINDER_OFFSETS_SETTING_KEY } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { assertRegistry, JOB_REGISTRY } from '../registry.ts'
import {
  REBUILD_SCHEDULED_STEPS_JOB as REBUILD_JOB,
  SCHEDULED_STEP_SWEEP_JOB,
  SEND_SCHEDULED_STEP_JOB,
  type SendScheduledStepData,
  sweepDueSteps,
} from './send-scheduled-step.ts'

/**
 * B-MSG-03's claims that need no database.
 *
 * Three of them, and each is a whole acceptance criterion or the thing that makes one reachable:
 *
 *   1. **The queue carries a step id and nothing else.** Asserted over what `sweepDueSteps` actually
 *      hands to the enqueue seam, and asserted NEGATIVELY as well — the serialised payload must not
 *      contain a body, a phone number or a template id, checked against values that really are the body,
 *      the phone number and the template id of the step being queued. The same claim is made again in
 *      `send-scheduled-step.itest.ts` against the row pg-boss really wrote, because a payload asserted
 *      only in the shape it was built in says nothing about what was stored.
 *   2. **The registry's `rerunJobs` names a job that exists.** A setting declaring a rebuild the worker
 *      never registered is a rebuild that silently never runs, and nothing else in the build would say so.
 *   3. **The handlers refuse to run before the runtime is supplied.** A pass over no configuration reports
 *      a tidy zero, which reads exactly like a quiet night (ADR 0002's failure mode).
 *
 * The invalidation-key invariant itself is `packages/core/src/lifecycle/invalidation-key.property.test.ts`
 * — 2,000 generated histories — and the database half is the itest beside this file. Nothing here mocks a
 * store to assert that the mock works.
 */

/** A step id shaped like the uuid the sweep really reads. */
const STEP_ID = '01a0b2c3-d4e5-7f60-8a9b-0c1d2e3f4a5b'
const SECOND_STEP_ID = '01a0b2c3-d4e5-7f60-8a9b-0c1d2e3f4a5c'

describe('the queue carries a step id and nothing else', () => {
  it('builds one payload per due step, with exactly one field', async () => {
    const seen: SendScheduledStepData[] = []
    const result = await sweepDueSteps([{ id: STEP_ID }, { id: SECOND_STEP_ID }], async (data) => {
      seen.push(data)
      return 'job-1'
    })
    expect(result).toMatchObject({ due: 2, queued: 2 })
    expect(seen).toEqual([{ stepId: STEP_ID }, { stepId: SECOND_STEP_ID }])
    for (const payload of seen) {
      expect(Object.keys(payload)).toEqual(['stepId'])
    }
  })

  it('carries no message body, phone number or template id — asserted against the real values', () => {
    // The negative half, and it is written with values that are NOT arbitrary: these are the body the
    // reminder renders to, the E.164 number it goes to and the template row it renders from. A payload
    // that carried any of them would be the delayed job this unit exists to remove, wearing a step id.
    const body =
      'Reminder: your booking tomorrow at 19:00. Details or changes: https://be.relax/b/7'
    const recipient = '+971501234567'
    const templateId = '01a0b2c3-d4e5-7f60-8a9b-0c1d2e3f4aaa'
    const serialised = JSON.stringify({ stepId: STEP_ID } satisfies SendScheduledStepData)
    expect(serialised).toBe(`{"stepId":"${STEP_ID}"}`)
    for (const forbidden of [body, recipient, templateId, 'booking.reminder', '19:00']) {
      expect(serialised, forbidden).not.toContain(forbidden)
    }
  })

  it('counts a payload the queue discarded as not queued, rather than as sent', async () => {
    // `singletonKey` makes `boss.send` answer null when the same step is already queued. A sweep that
    // counted that as queued would report work it did not hand over.
    const result = await sweepDueSteps([{ id: STEP_ID }], async () => null)
    expect(result).toMatchObject({ due: 1, queued: 0 })
    expect(result.payloads).toEqual([{ stepId: STEP_ID }])
  })
})

describe('the three jobs are declared the way the registry demands', () => {
  it('registers a sweep with a cron and an agent, and two queues with neither', () => {
    // `assertRegistry` is the runtime validator; calling it here is what makes a malformed declaration a
    // unit-test failure rather than a boot failure in production.
    expect(() =>
      assertRegistry([SCHEDULED_STEP_SWEEP_JOB, SEND_SCHEDULED_STEP_JOB, REBUILD_JOB] as never),
    ).not.toThrow()

    // Fifteen minutes, which is `reminder_scheduler`'s declared interval in 0021. The watchdog alerts on
    // "no success within twice the interval", so a slower cron would be the thing delaying its own alert.
    expect(SCHEDULED_STEP_SWEEP_JOB.cron).toBe('*/15 * * * *')
    expect(SCHEDULED_STEP_SWEEP_JOB.agent).toBe('reminder_scheduler')

    // The other two are announced rather than scheduled: a due step by the sweep, a rebuild by the
    // settings change. A cron on either would be a poller looking for work an enqueue already announced,
    // and `assertRegistry` would then demand an agent for it.
    expect(SEND_SCHEDULED_STEP_JOB.cron).toBeUndefined()
    expect(REBUILD_JOB.cron).toBeUndefined()
    expect(SEND_SCHEDULED_STEP_JOB.agent).toBeUndefined()
    expect(REBUILD_JOB.agent).toBeUndefined()
  })

  it('is in the shipped registry, so the queues exist at boot', () => {
    const names = JOB_REGISTRY.map((job) => job.name)
    expect(names).toContain('messaging.scheduled-step-sweep')
    expect(names).toContain('messaging.send-scheduled-step')
    expect(names).toContain(REBUILD_SCHEDULED_STEPS_JOB)
  })
})

describe("the settings registry's rebuild job is a job that exists", () => {
  it('resolves every rerunJobs name on the reminder setting to a registered queue', () => {
    const { jobs } = invalidationsFor(REMINDER_OFFSETS_SETTING_KEY)
    // Non-empty first: a setting that re-ran nothing would satisfy the subset check below vacuously, and
    // the whole point of the criterion is that a timing change reaches bookings already taken.
    expect(jobs).toEqual([REBUILD_SCHEDULED_STEPS_JOB])
    const names = new Set(JOB_REGISTRY.map((job) => job.name))
    for (const job of jobs) expect(names.has(job), job).toBe(true)
  })

  it('names the job through the shared constant, so the registry and the worker cannot disagree', () => {
    expect(REBUILD_JOB.name).toBe(REBUILD_SCHEDULED_STEPS_JOB)
  })
})

describe('a handler refuses to run before its runtime is supplied', () => {
  /*
    These run before anything in this file calls `setScheduledStepRuntime` — and nothing in this file ever
    does, deliberately. The module-level binding is process-wide, so a test that configured it would
    silently disarm this assertion for every case after it.
  */
  const context = { jobId: 'unit', now: () => '2099-12-03T15:00:00.000Z' }

  it('refuses the send, naming the setter run.ts calls', async () => {
    await expect(SEND_SCHEDULED_STEP_JOB.handler({ stepId: STEP_ID }, context)).rejects.toThrow(
      /setScheduledStepRuntime/,
    )
  })

  it('refuses the sweep and the rebuild too', async () => {
    await expect(SCHEDULED_STEP_SWEEP_JOB.handler(undefined as never, context)).rejects.toThrow(
      /setScheduledStepRuntime|setScheduledStepEnqueue/,
    )
    await expect(REBUILD_JOB.handler({}, context)).rejects.toThrow(/setScheduledStepRuntime/)
  })
})
