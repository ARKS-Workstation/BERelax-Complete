import { getDefinition, validateSetting } from '@berelax/config'
import {
  ASIA_DUBAI,
  fromLocal,
  instantToIso,
  localDate,
  localTime,
  offsetMinutes,
  toLocal,
} from '@berelax/core'
import { GOOGLE_PUBLISHING_STATUSES } from '@berelax/google'
import { describe, expect, it } from 'vitest'
import { cronRegistrations, isValidCron, JOB_REGISTRY, SCHEDULE_TIMEZONE } from '../registry.ts'
import {
  GBP_ACCESS_SETTING,
  GOOGLE_HEALTH_AGENT,
  GOOGLE_LIVENESS_AGENT,
  PUBLISHING_STATUS_SETTING,
} from './google-connection-health.ts'

/**
 * The two schedules, and the one thing about them that is easy to get wrong in a way nothing notices.
 *
 * A cron is stored as **local time plus a zone**, not as a pre-computed UTC hour. Writing `0 23 * * *`
 * and calling it "03:00 Dubai" would be correct today and would be a silent lie the moment the schedule
 * is read by somebody, moved to another entity, or compared against an Asia/Dubai timestamp — and it is
 * exactly the shape of mistake that cannot be caught by a passing job. So this file asserts both halves:
 * the stored expression is the local hour, and it resolves to 23:00 UTC because Asia/Dubai is a **fixed**
 * +04:00 with no daylight saving.
 *
 * The no-DST claim is asserted empirically, over every month, rather than by grepping the source for a
 * branch. A branch could be absent and the offset still be wrong; an offset that never moves is the
 * property that actually matters.
 */

const health = JOB_REGISTRY.find((job) => job.name === 'google-connection.health')
const liveness = JOB_REGISTRY.find((job) => job.name === 'google-connection.liveness')

describe('acceptance — the deep check is at 03:00 Asia/Dubai and the probe is hourly at minute 0', () => {
  it('declares both crons, each naming its own agent', () => {
    expect(health?.cron).toBe('0 3 * * *')
    expect(liveness?.cron).toBe('0 * * * *')
    expect(health?.agent).toBe(GOOGLE_HEALTH_AGENT)
    expect(liveness?.agent).toBe(GOOGLE_LIVENESS_AGENT)
    // Two agents, not one. Sharing a heartbeat would let the hourly probe keep it minutes old for ever
    // and make a dead daily pass invisible — see migration 0033.
    expect(health?.agent).not.toBe(liveness?.agent)
    expect(isValidCron(health?.cron ?? '')).toBe(true)
    expect(isValidCron(liveness?.cron ?? '')).toBe(true)
  })

  it('stores the LOCAL hour and lets the zone do the conversion', () => {
    // The expression is `0 3`, not `0 23`, and `registerJobs` passes `tz: 'Asia/Dubai'` to pg-boss. A
    // pre-computed UTC hour is the mistake this asserts against: it reads as a 23:00 job to anybody
    // looking, and it stops being 03:00 local the day the zone is not this one.
    expect(SCHEDULE_TIMEZONE).toBe('Asia/Dubai')
    expect(health?.cron?.split(/\s+/)[1]).toBe('3')
    expect(health?.cron?.split(/\s+/)[1]).not.toBe('23')
  })

  it('resolves 03:00 Asia/Dubai to 23:00 UTC the previous day, in every month of the year', () => {
    // Twelve months, because this is the claim a DST branch would break — and it would break it for only
    // part of the year, which is the shape of bug that survives a test asserting one date.
    const months = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'))
    for (const month of months) {
      const date = localDate(`2026-${month}-15`)
      const instant = fromLocal(date, localTime('03:00'), ASIA_DUBAI)
      const iso = instantToIso(instant)
      expect(iso, `${date} 03:00 Asia/Dubai`).toBe(`2026-${month}-14T23:00:00.000Z`)
      // And back again, so the round trip is the claim rather than one direction of it.
      expect(toLocal(instant, ASIA_DUBAI)).toEqual({ date, time: '03:00' })
    }
  })

  it('uses a fixed +04:00 offset with no daylight saving anywhere in the year', () => {
    // The property, stated directly. Asia/Dubai has never observed DST; asserting the offset over the
    // whole year is what makes "no DST branch" a fact about behaviour rather than about source code.
    const offsets = new Set(
      Array.from({ length: 12 }, (_, index) =>
        offsetMinutes(
          fromLocal(localDate(`2026-${String(index + 1).padStart(2, '0')}-15`), localTime('03:00')),
          ASIA_DUBAI,
        ),
      ),
    )
    expect([...offsets]).toEqual([240])
  })

  it('resolves the hourly probe to minute 0 of every UTC hour, because the offset is whole hours', () => {
    // A zone at +04:00 shifts the hour and not the minute, so `0 * * * *` in Asia/Dubai fires at minute 0
    // in UTC too. That is worth stating: a zone at +05:30 would not, and this assertion is what would
    // fail if the schedule were ever moved to one.
    for (const hour of ['00', '06', '13', '23']) {
      const instant = fromLocal(localDate('2026-09-18'), localTime(`${hour}:00`), ASIA_DUBAI)
      expect(instantToIso(instant).slice(14)).toBe('00:00.000Z')
    }
  })

  it('has no other cron whose agent is either of these two', () => {
    // The control on the two-agent claim: a third cron quietly reporting to `google_health` would
    // reintroduce the shared-heartbeat problem, and this is where it would be noticed.
    const sharing = cronRegistrations(JOB_REGISTRY).filter(
      (cron) =>
        (cron.agent === GOOGLE_HEALTH_AGENT || cron.agent === GOOGLE_LIVENESS_AGENT) &&
        cron.name !== 'google-connection.health' &&
        cron.name !== 'google-connection.liveness',
    )
    expect(sharing).toEqual([])
  })
})

describe('the settings the tripwire reads are the settings the registry declares', () => {
  it('accepts exactly the publishing statuses the tripwire understands', () => {
    // Two enums in two packages that may not import each other: `@berelax/config` holds the zod schema
    // and `@berelax/google` holds the union. This is the assertion that stops them drifting, and it is
    // here because `apps/worker` is the first place that depends on both.
    for (const status of GOOGLE_PUBLISHING_STATUSES) {
      expect(validateSetting(PUBLISHING_STATUS_SETTING, status)).toBe(status)
    }
    // `internal` is the plausible wrong answer — a real thing in Google's console, and not a publishing
    // status. It must be refused rather than stored and later coerced.
    expect(() => validateSetting(PUBLISHING_STATUS_SETTING, 'internal')).toThrow()
  })

  it('defaults to the strict answer on both, so an undecided project is not reported as safe', () => {
    // Testing, because it is the default state of every Cloud project and assuming Production silences
    // the tripwire. Not-approved, because a pending application is the launch-day normal and reporting it
    // as a fault would put a red banner on every admin page for six weeks.
    expect(getDefinition(PUBLISHING_STATUS_SETTING).defaultValue).toBe('testing')
    expect(getDefinition(GBP_ACCESS_SETTING).defaultValue).toBe(false)
  })

  it('names an OPEN-QUESTIONS id on each, because neither answer is known yet', () => {
    expect(getDefinition(PUBLISHING_STATUS_SETTING).provisional?.openQuestionId).toBe(
      'Y4-token-test',
    )
    expect(getDefinition(GBP_ACCESS_SETTING).provisional?.openQuestionId).toBe('Y2-gbp-status')
  })
})

describe('the schedule is readable as a sentence', () => {
  it('states a purpose on both, because an unexplained cron is one nobody dares delete', () => {
    for (const job of [health, liveness]) {
      expect(job?.purpose.length ?? 0).toBeGreaterThan(80)
      expect(job?.retryLimit ?? 0).toBeGreaterThanOrEqual(1)
      expect(job?.expireInSeconds ?? 0).toBeGreaterThan(0)
    }
    // The deep check forces a refresh and makes three reads; the probe makes one. The expiry windows
    // reflect that rather than being copied from each other.
    expect((health?.expireInSeconds ?? 0) > (liveness?.expireInSeconds ?? 0)).toBe(true)
  })
})
