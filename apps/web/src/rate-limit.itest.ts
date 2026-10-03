import {
  createConnection,
  deleteRateLimitWindowsBefore,
  readRateLimitWindow,
  readRateLimitWindows,
  type Sql,
} from '@berelax/db'
import { RATE_LIMIT_POLICIES, RATE_LIMIT_RETENTION_DAYS, windowStartFor } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { takeRateLimit } from './security/rate-limit.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The ceiling fires at the boundary, the state is in PostgreSQL, and the row is the measurement
 * (H-HARD-01).
 *
 * ## The three claims, and why each one needs a database
 *
 * **The boundary.** `decideRateLimit` is pure and its arithmetic is unit-tested, but the number it is
 * given comes from an upsert, and the off-by-one this unit can actually commit is between the two: does
 * `hits` returned by `insert … on conflict … do update set hits = hits + 1 … returning hits` include the
 * request being decided? The answer decides whether a policy of 20 permits the twentieth request or the
 * nineteenth, and nothing short of real statements against a real table can answer it.
 *
 * **Survival.** The acceptance line is *"rate-limit state is server-side and survives a worker restart"*.
 * The only honest reading of that is a fresh connection — a new pool, nothing shared with the one that
 * counted — reaching the same ceiling. A test with one connection would pass against a counter in a
 * module-level `Map`, which is exactly what this table exists instead of.
 *
 * **The measurement.** *An unmeasured limit is a guess* (brief rule 15). `hits` is the traffic and
 * `refusals` is how often the ceiling fired, and the two together are the only way to tell a limit that is
 * working from one that is too low. That is a claim about what the row CONTAINS afterwards, which is a
 * read.
 *
 * ## Why there is no `/api/v1/otp` case here
 *
 * Because this unit removed its OTP ceiling rather than adding one. A-FIRST-02 already holds both — per
 * phone and per IP, over `otp_challenge`, with an audit row — and `otp-route.itest.ts` already asserts the
 * 429 for each and the identical answer for a known and an unknown number. A second set of cases here
 * would be a second claim about one behaviour, and the duplicate COUNTER was the defect this unit found.
 *
 * ## Keys, and why nothing is deleted between cases
 *
 * Every case keys on an address inside the documentation range `203.0.113.0/24` (RFC 5737) with a per-run
 * suffix, and the window is pinned to an instant far in the future. So two runs never share a row, nothing
 * has to be cleaned up, and `rate_limit_window` keeps its append-mostly shape — which is also how the
 * retention case can delete rows of its own without touching anybody else's.
 */

/**
 * The key is an ADDRESS and nothing else, so the per-run discriminator has to be the WINDOW.
 *
 * The first draft suffixed the address — `203.0.113.10-48219` — and every case answered `unidentified`:
 * `callerAddressFrom` validates the header as an address and returns null for anything else, which is the
 * whole reason a misconfigured proxy cannot put every caller in one bucket. So the suffix moved to the
 * instant: each run picks its own hour, far in the future, and the longest policy window is ten minutes,
 * so two runs can never share a row. The addresses are then the plain documentation range (RFC 5737),
 * which is never a real caller.
 */
const RUN = Date.now() % 40_000
const AT_ISO = new Date(Date.parse('2099-01-01T00:00:00.000Z') + RUN * 3_600_000).toISOString()
/** The retention case's own era, equally per-run, so its sweep cannot reach another run's rows. */
const ANCIENT_ISO = new Date(Date.parse('2001-01-01T00:00:00.000Z') + RUN * 3_600_000).toISOString()

const keyFor = (n: number): string => `203.0.113.${String(n)}`

let sql: Sql

/** A request carrying a caller address, which is all `takeRateLimit` reads. */
function requestFrom(key: string): Request {
  return new Request('https://berelax.test/api/v1/book', {
    method: 'POST',
    headers: { 'x-forwarded-for': key },
  })
}

beforeAll(() => {
  sql = createConnection({ url: url as string, max: 4 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('the boundary', () => {
  it('permits exactly the policy limit and refuses the next one', async () => {
    /*
      The whole arithmetic, against real statements. `hits` comes back INCLUDING the request being
      decided, so the boundary is `hits > limit`: a policy of N permits the Nth and refuses the N+1th.
      Asserted by counting both sides rather than only the refusal — a test that stopped at "the 21st was
      refused" would pass against a limiter that refused the first.
    */
    const policy = RATE_LIMIT_POLICIES.booking
    const key = keyFor(10)
    const outcomes: string[] = []
    for (let n = 0; n < policy.limit; n += 1) {
      const outcome = await takeRateLimit({
        scope: 'booking',
        request: requestFrom(key),
        nowIso: AT_ISO,
        sql,
      })
      outcomes.push(outcome.kind)
    }
    expect(outcomes.every((kind) => kind === 'allowed')).toBe(true)
    expect(outcomes).toHaveLength(policy.limit)

    const refused = await takeRateLimit({
      scope: 'booking',
      request: requestFrom(key),
      nowIso: AT_ISO,
      sql,
    })
    expect(refused.kind).toBe('refused')
    if (refused.kind !== 'refused') throw new Error('unreachable')
    expect(refused.response.status).toBe(429)
    const body = (await refused.response.json()) as { error: string; reason: string }
    expect(body).toEqual({ error: 'too_many_requests', reason: 'rate_limited' })
    // `Retry-After` is what a well-behaved client waits on, and it is never zero — the last millisecond
    // of a window would round to one.
    expect(Number(refused.response.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(refused.response.headers.get('ratelimit-remaining')).toBe('0')
    expect(refused.response.headers.get('cache-control')).toBe('no-store')
  })

  it('counts the last permitted request as remaining zero, not as refused', async () => {
    // The off-by-one from the other side: the Nth request is ALLOWED and its remaining budget is zero.
    // A limiter that refused it would also satisfy "the N+1th is refused".
    const policy = RATE_LIMIT_POLICIES.consent
    const key = keyFor(11)
    let last: Awaited<ReturnType<typeof takeRateLimit>> | undefined
    for (let n = 0; n < policy.limit; n += 1) {
      last = await takeRateLimit({
        scope: 'consent',
        request: requestFrom(key),
        nowIso: AT_ISO,
        sql,
      })
    }
    expect(last?.kind).toBe('allowed')
    if (last?.kind !== 'allowed') throw new Error('unreachable')
    expect(last.headers['ratelimit-remaining']).toBe('0')
    expect(last.headers['ratelimit-limit']).toBe(String(policy.limit))
    expect(last.headers['ratelimit-policy']).toBe(`${policy.limit};w=${policy.windowSeconds}`)
  })

  it('counts each caller in its own bucket', async () => {
    // Otherwise one caller could refuse everybody, which is the failure mode the collector's shared
    // ANONYMOUS_BUCKET actually has and the reason a null key counts nothing here.
    const policy = RATE_LIMIT_POLICIES.whatsapp_ref
    const mine = keyFor(12)
    for (let n = 0; n <= policy.limit; n += 1) {
      await takeRateLimit({
        scope: 'whatsapp_ref',
        request: requestFrom(mine),
        nowIso: AT_ISO,
        sql,
      })
    }
    const refused = await takeRateLimit({
      scope: 'whatsapp_ref',
      request: requestFrom(mine),
      nowIso: AT_ISO,
      sql,
    })
    expect(refused.kind).toBe('refused')
    const neighbour = await takeRateLimit({
      scope: 'whatsapp_ref',
      request: requestFrom(keyFor(13)),
      nowIso: AT_ISO,
      sql,
    })
    expect(neighbour.kind).toBe('allowed')
  })

  it('counts each scope in its own bucket, so one endpoint cannot spend another’s budget', async () => {
    const key = keyFor(14)
    for (let n = 0; n <= RATE_LIMIT_POLICIES.consent.limit; n += 1) {
      await takeRateLimit({ scope: 'consent', request: requestFrom(key), nowIso: AT_ISO, sql })
    }
    expect(
      (await takeRateLimit({ scope: 'consent', request: requestFrom(key), nowIso: AT_ISO, sql }))
        .kind,
    ).toBe('refused')
    // The same caller, a different endpoint, a different row.
    expect(
      (await takeRateLimit({ scope: 'booking', request: requestFrom(key), nowIso: AT_ISO, sql }))
        .kind,
    ).toBe('allowed')
  })

  it('counts nothing and refuses nothing when there is no caller address', async () => {
    /*
      The stated consequence, asserted rather than hidden. A placeholder key would put every
      unidentifiable caller in one bucket and refuse them as one, so a misconfigured proxy would take
      every public endpoint down at once. The headers still go out, so a caller can see the ceiling
      exists even when this request was not attributed to anybody.
    */
    const before = (await readRateLimitWindows(sql, { scope: 'booking', limit: 500 })).length
    const outcome = await takeRateLimit({
      scope: 'booking',
      request: new Request('https://berelax.test/api/v1/book', { method: 'POST' }),
      nowIso: AT_ISO,
      sql,
    })
    expect(outcome.kind).toBe('unidentified')
    if (outcome.kind !== 'unidentified') throw new Error('unreachable')
    expect(outcome.headers['ratelimit-limit']).toBe(String(RATE_LIMIT_POLICIES.booking.limit))
    // A DELTA of zero and not a total: nothing was written. Other cases in this file write to the same
    // scope, so a total would be a claim about them.
    expect((await readRateLimitWindows(sql, { scope: 'booking', limit: 500 })).length).toBe(before)
  })

  it('refuses free text in x-forwarded-for rather than bucketing it', async () => {
    // Validated, not trusted: a header of free text would be one bucket for every caller who sent one.
    const outcome = await takeRateLimit({
      scope: 'booking',
      request: new Request('https://berelax.test/api/v1/book', {
        method: 'POST',
        headers: { 'x-forwarded-for': 'unknown' },
      }),
      nowIso: AT_ISO,
      sql,
    })
    expect(outcome.kind).toBe('unidentified')
  })
})

describe('the state is server-side', () => {
  it('reaches the ceiling across a worker restart, on a connection that shares nothing', async () => {
    /*
      Acceptance line 5, in the only form that can fail. The first half of the budget is spent on one
      connection; that connection is then ENDED, which is as close to a worker restart as a test can get
      without a process boundary — the pool is gone, and with it anything a module could have cached — and
      the second half is spent on a connection opened afterwards.

      A test on one connection would pass against a counter in a module-level `Map`, which is exactly what
      this table exists instead of. A test with two pools opened up front would pass against a counter
      shared through module state, so the first pool is closed before the second is opened.
    */
    const policy = RATE_LIMIT_POLICIES.booking
    const key = keyFor(20)
    const half = Math.floor(policy.limit / 2)

    const first = createConnection({ url: url as string, max: 2 })
    for (let n = 0; n < half; n += 1) {
      const outcome = await takeRateLimit({
        scope: 'booking',
        request: requestFrom(key),
        nowIso: AT_ISO,
        sql: first,
      })
      expect(outcome.kind).toBe('allowed')
    }
    await first.end({ timeout: 5 })

    const second = createConnection({ url: url as string, max: 2 })
    try {
      // The budget CONTINUES rather than restarting: the remaining allowance is what the first connection
      // left, which is the whole claim.
      for (let n = half; n < policy.limit; n += 1) {
        const outcome = await takeRateLimit({
          scope: 'booking',
          request: requestFrom(key),
          nowIso: AT_ISO,
          sql: second,
        })
        expect(outcome.kind, `request ${String(n + 1)} of ${String(policy.limit)}`).toBe('allowed')
      }
      const refused = await takeRateLimit({
        scope: 'booking',
        request: requestFrom(key),
        nowIso: AT_ISO,
        sql: second,
      })
      expect(refused.kind, 'the ceiling restarted with the connection').toBe('refused')
    } finally {
      await second.end({ timeout: 5 })
    }
  })

  it('starts a NEW window at the next boundary, keeping the old one as the measurement', async () => {
    /*
      The fixed window's defining property, and its stated cost: a caller may take `limit` at the end of
      one window and `limit` again at the start of the next, so the worst case over a window's length is
      twice the limit. Asserted rather than left implicit, because it is the thing somebody will be
      surprised by — and because the OLD row surviving is what makes the table a measurement rather than a
      counter that forgets.
    */
    const policy = RATE_LIMIT_POLICIES.collect
    const key = keyFor(21)
    const nextIso = new Date(Date.parse(AT_ISO) + policy.windowSeconds * 1000).toISOString()

    for (let n = 0; n <= policy.limit; n += 1) {
      await takeRateLimit({ scope: 'collect', request: requestFrom(key), nowIso: AT_ISO, sql })
    }
    expect(
      (await takeRateLimit({ scope: 'collect', request: requestFrom(key), nowIso: AT_ISO, sql }))
        .kind,
    ).toBe('refused')
    expect(
      (await takeRateLimit({ scope: 'collect', request: requestFrom(key), nowIso: nextIso, sql }))
        .kind,
    ).toBe('allowed')

    // Two rows, not one moved row. The window start is part of the primary key.
    const previous = await readRateLimitWindow(sql, {
      scope: 'collect',
      key,
      windowStartedAtIso: new Date(windowStartFor(policy, Date.parse(AT_ISO))).toISOString(),
    })
    const current = await readRateLimitWindow(sql, {
      scope: 'collect',
      key,
      windowStartedAtIso: new Date(windowStartFor(policy, Date.parse(nextIso))).toISOString(),
    })
    expect(previous?.hits).toBeGreaterThan(policy.limit)
    expect(current?.hits).toBe(1)
  })
})

describe('the row is the measurement', () => {
  it('records the traffic and the refusals separately', async () => {
    /*
      *An unmeasured limit is a guess.* `hits` is how much traffic there was and `refusals` is how often
      the ceiling fired, and the question "is this figure right" is answerable only from both — a row with
      hits far below the limit says the ceiling is untested, and refusals climbing says it is too low.

      Asserted as EXACT figures because this row is this run's alone: the key carries a per-run suffix.
    */
    const policy = RATE_LIMIT_POLICIES.payment_intent
    const key = keyFor(30)
    const overBy = 3
    for (let n = 0; n < policy.limit + overBy; n += 1) {
      await takeRateLimit({
        scope: 'payment_intent',
        request: requestFrom(key),
        nowIso: AT_ISO,
        sql,
      })
    }
    const windowStartedAtIso = new Date(windowStartFor(policy, Date.parse(AT_ISO))).toISOString()
    const row = await readRateLimitWindow(sql, {
      scope: 'payment_intent',
      key,
      windowStartedAtIso,
    })
    expect(row?.hits).toBe(policy.limit + overBy)
    expect(row?.refusals).toBe(overBy)
    expect(row?.lastSeenAt.getTime()).toBeGreaterThanOrEqual(row?.firstSeenAt.getTime() ?? 0)
  })

  it('appears in the reader an operator would use, newest first', async () => {
    const key = keyFor(31)
    await takeRateLimit({
      scope: 'payment_webhook',
      request: requestFrom(key),
      nowIso: AT_ISO,
      sql,
    })
    const windows = await readRateLimitWindows(sql, { scope: 'payment_webhook', limit: 500 })
    expect(windows.some((window) => window.key === key)).toBe(true)
    // Ordered, so "the recent past" is the first page rather than a scan.
    const starts = windows.map((window) => window.windowStartedAt.getTime())
    expect([...starts].sort((a, b) => b - a)).toEqual(starts)
  })

  it('refuses to be re-keyed, and refuses a counter that goes backwards (ZY861)', async () => {
    /*
      The row's identity is immutable and only its tallies move. Re-keying a window would move a
      measurement from one caller or one minute to another, after which the table could not answer whether
      a ceiling is right — which is the only reason it exists.

      A decrement is refused for the same reason in the other direction: a measurement edited after the
      fact, and the one shape that produces is a ceiling that looks like it never fired.
    */
    const key = keyFor(32)
    await takeRateLimit({ scope: 'collect', request: requestFrom(key), nowIso: AT_ISO, sql })
    const windowStartedAtIso = new Date(
      windowStartFor(RATE_LIMIT_POLICIES.collect, Date.parse(AT_ISO)),
    ).toISOString()

    await expect(
      sql`update rate_limit_window set key = ${`${key}-moved`}
           where scope = 'collect' and key = ${key}
             and window_started_at = ${windowStartedAtIso}::timestamptz`,
    ).rejects.toMatchObject({ code: 'ZY861' })

    await expect(
      sql`update rate_limit_window set hits = 0
           where scope = 'collect' and key = ${key}
             and window_started_at = ${windowStartedAtIso}::timestamptz`,
    ).rejects.toMatchObject({ code: 'ZY861' })

    // And the CHECK, which is the other half: a refusal cannot exceed the hits it is a subset of.
    await expect(
      sql`update rate_limit_window set refusals = hits + 1
           where scope = 'collect' and key = ${key}
             and window_started_at = ${windowStartedAtIso}::timestamptz`,
    ).rejects.toMatchObject({ constraint_name: 'rate_limit_window_refusals_are_a_subset' })
  })

  it('cannot be deleted by the application, so a caller cannot reset their own ceiling', async () => {
    /*
      The one privilege that would make the limit decorative. `berelax_app` keeps UPDATE here — the
      counters ARE the state and the upsert is the hot path, which is the one place in this estate that is
      true — and DELETE is revoked, because a caller who could delete their own window could start again.
    */
    const key = keyFor(33)
    await takeRateLimit({ scope: 'collect', request: requestFrom(key), nowIso: AT_ISO, sql })
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe('set local role berelax_app')
        await tx`delete from rate_limit_window where scope = 'collect' and key = ${key}`
      }),
    ).rejects.toMatchObject({ code: '42501' })
    // The control: the same role CAN count, or the endpoint would not work at all.
    await sql.begin(async (tx) => {
      await tx.unsafe('set local role berelax_app')
      await tx`update rate_limit_window set hits = hits + 1
                where scope = 'collect' and key = ${key}`
    })
  })

  it('is swept by the owner, within the retention bound', async () => {
    /*
      The key is a caller's IP address, which is personal data under the PDPL, and the proportionality
      argument for keeping one covers the length of a WINDOW rather than for ever. `RATE_LIMIT_RETENTION_DAYS`
      holds the bound and the reasoning; this is the mechanism.

      Nothing SCHEDULES it yet and `@berelax/shared` says so rather than implying a cron that does not
      exist — C-CRM-10's retention pass is driven by a retention profile and legal holds, which is a
      different machine. What is proved here is that the sweep works and is bounded: a window inside the
      retention period is untouched.
    */
    expect(RATE_LIMIT_RETENTION_DAYS).toBeGreaterThan(0)
    const old = keyFor(40)
    const recent = keyFor(41)
    const oldIso = ANCIENT_ISO
    await takeRateLimit({ scope: 'collect', request: requestFrom(old), nowIso: oldIso, sql })
    await takeRateLimit({ scope: 'collect', request: requestFrom(recent), nowIso: AT_ISO, sql })

    // Half an hour after this run's ancient window and well before the next run's, so the sweep's bound
    // is this run's own.
    const removed = await deleteRateLimitWindowsBefore(sql, {
      beforeIso: new Date(Date.parse(ANCIENT_ISO) + 1_800_000).toISOString(),
    })
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(
      await readRateLimitWindow(sql, {
        scope: 'collect',
        key: old,
        windowStartedAtIso: new Date(
          windowStartFor(RATE_LIMIT_POLICIES.collect, Date.parse(oldIso)),
        ).toISOString(),
      }),
    ).toBeNull()
    // The bound, which is what makes it a retention rule rather than a truncate.
    expect(
      await readRateLimitWindow(sql, {
        scope: 'collect',
        key: recent,
        windowStartedAtIso: new Date(
          windowStartFor(RATE_LIMIT_POLICIES.collect, Date.parse(AT_ISO)),
        ).toISOString(),
      }),
    ).not.toBeNull()
  })
})
