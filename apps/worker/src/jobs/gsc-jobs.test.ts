import { ASIA_DUBAI, fromLocal, instantToIso, localDate, localTime } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { cronRegistrations, isValidCron, JOB_REGISTRY, SCHEDULE_TIMEZONE } from '../registry.ts'
import { SEO_GSC_SNAPSHOT_AGENT } from './gsc-nightly-snapshot.ts'
import { SEO_URL_INSPECTION_AGENT } from './gsc-url-inspection-rotation.ts'

/**
 * G-SEO-01 — the two SEO crons, and the pairing that is easy to get wrong invisibly.
 *
 * Nothing in the database stops either cron from naming the other's agent, or from naming `seo_agent`:
 * every one of them is a valid `agent_definition` row. The consequence of getting it wrong is silent in
 * exactly the way the agent registry exists to prevent — the watchdog measures the absence of a success
 * **per agent**, so two crons sharing a heartbeat report as healthy whenever either of them runs, and a
 * pass that has stopped entirely is invisible for ever.
 *
 * So the pairing is a test, and `scripts/test-gates.mjs` breaks the registry and requires this file to
 * fail. A test of this kind is worth nothing until it has been seen to fail.
 */

const snapshot = JOB_REGISTRY.find((job) => job.name === 'seo.gsc-snapshot')
const rotation = JOB_REGISTRY.find((job) => job.name === 'seo.url-inspection')

describe('acceptance — the nightly snapshot and the inspection rotation are separate watched agents', () => {
  it('declares both crons, each naming its own agent', () => {
    expect(snapshot?.cron).toBe('45 4 * * *')
    expect(rotation?.cron).toBe('30 5 * * *')
    expect(snapshot?.agent).toBe(SEO_GSC_SNAPSHOT_AGENT)
    expect(rotation?.agent).toBe(SEO_URL_INSPECTION_AGENT)
    // Two agents, not one: the rotation can be refused all night by an exhausted quota while the snapshot
    // is perfectly healthy, and a shared heartbeat would report the pair as fine because one of them ran.
    expect(snapshot?.agent).not.toBe(rotation?.agent)
    expect(isValidCron(snapshot?.cron ?? '')).toBe(true)
    expect(isValidCron(rotation?.cron ?? '')).toBe(true)
  })

  it('reports to neither seo_agent nor either Google health agent', () => {
    // `seo_agent` declares a SEVEN-DAY interval, because it is the weekly review (G-SEO-05). A nightly
    // pass writing that heartbeat would keep it hours old for ever and make a weekly report that had
    // stopped being produced invisible. Migration 0042 seeds the two agents used instead.
    for (const job of [snapshot, rotation]) {
      expect(job?.agent).not.toBe('seo_agent')
      expect(job?.agent).not.toBe('google_health')
      expect(job?.agent).not.toBe('google_liveness')
    }
  })

  it('has no other cron reporting to either of these agents', () => {
    // The control on the claim above: a third cron quietly naming `seo_gsc_snapshot` would reintroduce the
    // shared-heartbeat problem, and this is where it would be noticed.
    const sharing = cronRegistrations(JOB_REGISTRY).filter(
      (cron) =>
        (cron.agent === SEO_GSC_SNAPSHOT_AGENT || cron.agent === SEO_URL_INSPECTION_AGENT) &&
        cron.name !== 'seo.gsc-snapshot' &&
        cron.name !== 'seo.url-inspection',
    )
    expect(sharing).toEqual([])
  })

  it('runs the rotation after the snapshot, because the snapshot registers its candidates', () => {
    // Same zone, so the two expressions are comparable as local minutes. The rotation inspects a list the
    // snapshot maintains, so the order is load-bearing rather than aesthetic.
    const minutes = (cron: string | undefined): number => {
      const [minute = '0', hour = '0'] = (cron ?? '').split(/\s+/)
      return Number(hour) * 60 + Number(minute)
    }
    expect(minutes(rotation?.cron)).toBeGreaterThan(minutes(snapshot?.cron))
  })

  it('stores the LOCAL hour and lets the zone do the conversion', () => {
    // `45 4`, not `45 0`: a pre-computed UTC hour reads as a 00:45 job to anybody looking and stops being
    // 04:45 local the day the business is not in this zone. Asia/Dubai is a fixed +04:00 with no DST, so
    // the conversion is stated here as a fact rather than assumed.
    expect(SCHEDULE_TIMEZONE).toBe('Asia/Dubai')
    expect(snapshot?.cron?.split(/\s+/)[1]).toBe('4')
    expect(instantToIso(fromLocal(localDate('2026-09-19'), localTime('04:45'), ASIA_DUBAI))).toBe(
      '2026-09-19T00:45:00.000Z',
    )
    expect(instantToIso(fromLocal(localDate('2026-09-19'), localTime('05:30'), ASIA_DUBAI))).toBe(
      '2026-09-19T01:30:00.000Z',
    )
  })

  it('runs after trading closes at 02:00 and after the Google health check at 03:00', () => {
    // 04:45 and 05:30 are after the 02:00 close, and after the health check that forces a token refresh
    // and records a dead grant — deliberately, so the SEO passes are not the thing that discovers one an
    // hour before the job whose purpose is to.
    const hourOf = (cron: string | undefined): number => Number((cron ?? '').split(/\s+/)[1])
    expect(hourOf(snapshot?.cron)).toBeGreaterThan(3)
    expect(hourOf(rotation?.cron)).toBeGreaterThan(3)
  })

  it('states a purpose and a retry policy on both, sized to what each pass does', () => {
    for (const job of [snapshot, rotation]) {
      expect(job?.purpose.length ?? 0).toBeGreaterThan(80)
      expect(job?.retryLimit ?? 0).toBeGreaterThanOrEqual(1)
      expect(job?.expireInSeconds ?? 0).toBeGreaterThan(0)
    }
    // Up to 2,000 sequential inspections takes longer than two paged fetches and sixty upserts.
    expect((rotation?.expireInSeconds ?? 0) > (snapshot?.expireInSeconds ?? 0)).toBe(true)
  })
})
