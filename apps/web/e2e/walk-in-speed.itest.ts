import { readFileSync } from 'node:fs'
import { MINIMUM_WALK_IN_SAMPLES, percentileMs, walkInSpeedVerdict } from '@berelax/core'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { WALK_IN_SPEED_BUDGET_MS, WALK_IN_SPEED_PERCENTILE } from '@berelax/shared'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * H-MIG-10's front-desk stopwatch, and the committed report it writes.
 *
 * ## The suite has two halves and only one of them can run anywhere
 *
 * **The report's integrity ALWAYS runs.** `artifacts/pilot/walk-in-speed.json` is a committed artefact,
 * and the dangerous state for it is a figure nobody measured — so this file reads it and asserts that a
 * `not_measured` report carries no percentile at all, that a measured one names the machine it was taken
 * on, and that the budget in it is the shared constant rather than a literal somebody typed. That half is
 * about the file and needs no browser.
 *
 * **The stopwatch is opt-in, behind `WALK_IN_SPEED_MEASURE=1`, and skips LOUDLY otherwise.** Brief rule
 * 23 is the reason and it is not a convenience: a wall-clock assertion measures the MACHINE, not the
 * code. The acceptance line names "the seeded dataset" and no hardware, and a p95 taken in an agent
 * container with six other agents on four cores is a figure about the container — which, written into a
 * committed report, is indistinguishable from a figure about the product. So the measurement is taken
 * deliberately, on a machine somebody chose, and the committed report says `not_measured` until then.
 * The skip message goes to STDERR, because vitest's reporter shows a skipped test's stdout to nobody.
 *
 * This is the unit's own provisional note, enforced: *real-device results recorded as absent, not assumed
 * passing* (Y12-pilot, Y14-devices).
 */

const REPORT_PATH = 'artifacts/pilot/walk-in-speed.json'
const MEASURE = process.env['WALK_IN_SPEED_MEASURE'] === '1'

interface WalkInSpeedReport {
  readonly budgetMs: number
  readonly percentile: number
  readonly minimumSamples: number
  readonly verdict: string
  readonly samples: number
  readonly p95Ms: number | null
  readonly machine: string | null
  readonly measuredAt: string | null
  readonly openQuestions: readonly string[]
}

let server: WebServer | undefined

afterAll(async () => {
  await server?.stop()
})

describe('the committed walk-in speed report', () => {
  const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as WalkInSpeedReport

  it('states the budget and the percentile the shared constants hold, not its own', () => {
    // A report whose budget was a literal would go on passing after the requirement changed.
    expect(report.budgetMs).toBe(WALK_IN_SPEED_BUDGET_MS)
    expect(report.percentile).toBe(WALK_IN_SPEED_PERCENTILE)
    expect(report.minimumSamples).toBe(MINIMUM_WALK_IN_SAMPLES)
  })

  it('carries no percentile at all while it is not measured', () => {
    /*
      The claim the artefact exists for. A `p95Ms` of 0 would pass a ten-second budget with room to
      spare, and an absent field would read, to anything that checks it, exactly like a report nobody had
      got round to generating. So `not_measured` is a VALUE and it is accompanied by nulls — ADR 0070's
      rule applied to a latency instead of a cost.
    */
    if (report.verdict === 'not_measured') {
      expect(report.p95Ms).toBeNull()
      expect(report.measuredAt).toBeNull()
      expect(report.samples).toBe(0)
      // And it names what is waiting on a real pilot, rather than being silently unfinished.
      expect(report.openQuestions.length).toBeGreaterThan(0)
      return
    }
    // A measured report has to say WHERE, because that is the half of a latency claim that is about the
    // machine. Both branches are asserted so neither can rot while the other is the one in the file.
    expect(report.p95Ms).toBeGreaterThan(0)
    expect(report.machine).toBeTruthy()
    expect(report.measuredAt).toBeTruthy()
    expect(report.samples).toBeGreaterThanOrEqual(MINIMUM_WALK_IN_SAMPLES)
  })

  it('agrees with the verdict the arithmetic gives for its own figures', () => {
    // The report and `walkInSpeedVerdict` are two statements of one judgement, so they are held equal
    // here rather than trusted: a report hand-edited to `within_budget` over 3 samples fails.
    const samples =
      report.p95Ms === null ? [] : Array.from({ length: report.samples }, () => report.p95Ms ?? 0)
    expect(walkInSpeedVerdict(samples, { budgetMs: report.budgetMs }).kind).toBe(report.verdict)
  })
})

describe('the walk-in stopwatch', () => {
  it('measures a walk-in booking at the 95th percentile on the seeded dataset', async () => {
    if (!MEASURE) {
      process.stderr.write(
        `\n[walk-in-speed] SKIPPED. The requirement is a walk-in bookable in under ` +
          `${WALK_IN_SPEED_BUDGET_MS} ms at the ${WALK_IN_SPEED_PERCENTILE}th percentile, over at ` +
          `least ${MINIMUM_WALK_IN_SAMPLES} samples. It is not taken here: a wall-clock percentile ` +
          'measured in an agent container with several agents on four cores is a figure about the ' +
          'container, and written into a committed report it would be indistinguishable from a figure ' +
          `about the product (brief rule 23). ${REPORT_PATH} therefore records not_measured. Run this ` +
          'with WALK_IN_SPEED_MEASURE=1 on the machine the claim is about, after ' +
          '`pnpm --filter @berelax/web build`.\n',
      )
      return
    }
    server = await startWebServer({
      suite: 'walk-in-speed',
      cwd: new URL('..', import.meta.url).pathname,
    })
    const samples: number[] = []
    for (let at = 0; at < MINIMUM_WALK_IN_SAMPLES; at += 1) {
      const started = performance.now()
      // The stopwatch is around the SERVER's answer to the quick-book screen, which is the step the
      // front desk waits on. Deliberately not around a scripted click sequence: a human's typing speed
      // is not what the requirement is about, and including it would make the figure depend on the
      // script rather than on the application.
      const response = await fetch(`${server.origin}/quick-book`, { redirect: 'manual' })
      await response.arrayBuffer()
      samples.push(performance.now() - started)
    }
    const verdict = walkInSpeedVerdict(samples)
    process.stderr.write(
      `\n[walk-in-speed] ${verdict.kind}: p${WALK_IN_SPEED_PERCENTILE} ` +
        `${String(percentileMs(samples, WALK_IN_SPEED_PERCENTILE))} ms over ${samples.length} ` +
        `samples, budget ${WALK_IN_SPEED_BUDGET_MS} ms. Write this into ${REPORT_PATH} with the ` +
        'machine it was taken on.\n',
    )
    expect(verdict.kind).not.toBe('not_measured')
  }, 120_000)
})
