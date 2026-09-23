import { parseConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import {
  createConnection,
  OTP_MAX_REQUESTS_PER_IP,
  OTP_MAX_REQUESTS_PER_PHONE,
  OTP_TTL_MINUTES,
  type Sql,
} from '@berelax/db'
import { SYNTHETIC_MOBILE_PREFIX } from '@berelax/fixtures'
import {
  InMemoryOutbox,
  PROVISIONAL_SENDER_IDS,
  type SendContext,
  TDRA_PROMOTIONAL_WINDOW,
} from '@berelax/messaging'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { handleOtpRequest, type OtpEndpointDeps } from '../app/api/v1/otp/handler.ts'

/**
 * B-LIFE-02 — `POST /api/v1/otp`, driven against a real PostgreSQL and the SMSala fake.
 *
 * The handler is called directly rather than over HTTP. That is deliberate: the enumeration-resistance
 * assertion measures response time, and a `next start` in front of it would add the variance of a
 * Node HTTP server, a router and a JSON parser to every sample — variance that has nothing to do with
 * the property under test and would force the tolerance so wide that it proved nothing.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const FROZEN_ISO = '2026-09-18T18:00:00.000Z'

/**
 * Numbers on the unallocated `59` prefix, so nothing here can reach a handset.
 *
 * `SYNTHETIC_MOBILE_PREFIX` comes from `packages/fixtures`, which owns the guarantee and asserts it.
 * The serial's leading digit separates the two populations this file needs: `1` for numbers the
 * business already knows, `2` for numbers it has never seen.
 */
const known = (n: number): string => `+971${SYNTHETIC_MOBILE_PREFIX}1${String(n).padStart(6, '0')}`
const unknown = (n: number): string =>
  `+971${SYNTHETIC_MOBILE_PREFIX}2${String(n).padStart(6, '0')}`

const sql: Sql = createConnection({ url, max: 4 })

interface Harness {
  readonly deps: OtpEndpointDeps
  readonly outbox: InMemoryOutbox
  readonly sms: ReturnType<typeof createSmsalaTransport>
}

/**
 * The send context the route builds, with the clock frozen and the fake transport in place.
 *
 * `APP_ENV=test`, so the staging guard (F03) diverts every recipient that is not allowlisted into the
 * local outbox — which is where these tests read the message from. An allowlisted recipient reaches the
 * SMSala fake instead, and one test uses that to prove the message really does travel the whole path.
 */
function harness(options: { allowlist?: readonly string[]; nowIso?: string } = {}): Harness {
  const nowIso = options.nowIso ?? FROZEN_ISO
  const config = parseConfig({
    APP_ENV: 'test',
    DATABASE_URL: url,
    OUTBOUND_ALLOWLIST: (options.allowlist ?? []).join(','),
    SMS_PROVIDER: 'fake',
  })
  const sms = createSmsalaTransport({ config, now: () => nowIso })
  const outbox = new InMemoryOutbox()
  const send: SendContext = {
    appEnv: config.APP_ENV,
    outboundAllowlist: config.OUTBOUND_ALLOWLIST,
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [sms.transport],
    outbox,
    clock: { now: () => Date.parse(nowIso) as Instant },
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      // Transactional traffic returns from the gate before any evaluator is read, so these throwing
      // stubs are the same fail-closed wiring the route ships with — and a proof that an OTP does not
      // depend on the consent store at all. C-CRM-03 has since built it, and this route still prefetches
      // nothing: the real evaluator is assembled over a campaign's recipient list, and an OTP has none.
      evaluators: {
        hasConsent: () => {
          throw new Error('no consent store yet')
        },
        isSuppressed: () => {
          throw new Error('no suppression list yet')
        },
        frequencyCapReached: () => {
          throw new Error('no frequency store yet')
        },
      },
    },
  }
  return { deps: { sql, now: () => nowIso, send }, outbox, sms }
}

function otpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://be.relax/api/v1/otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

interface Observed {
  readonly status: number
  readonly body: string
  readonly elapsedMs: number
}

async function observe(deps: OtpEndpointDeps, request: Request): Promise<Observed> {
  const started = performance.now()
  const response = await handleOtpRequest(deps, request)
  const body = await response.text()
  return { status: response.status, body, elapsedMs: performance.now() - started }
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0)
}

// --- the declared tolerance --------------------------------------------------------------------

/** Samples per path. Fifty, as the acceptance criterion requires. */
const ENUMERATION_SAMPLES = 50

/**
 * How far the two medians may differ, as a fraction of the smaller one.
 *
 * ## Why a ratio, and why this figure
 *
 * A request here is a handful of round trips to a local PostgreSQL, so the absolute figure is a few
 * milliseconds and moves with the machine: a shared CI runner, a cold page cache and another unit's
 * integration suite on the next core all change it. A fixed millisecond budget would therefore be
 * either flaky on a loaded box or meaningless on an idle one, while a ratio is scale-free.
 *
 * Fifty per cent sounds enormous and is the honest number. What this test can detect is a
 * **structural** difference — a branch that does more or less work on one path, which is what an
 * enumeration oracle actually is: an extra query, a skipped send, an early return. Any of those costs
 * a round trip, and a round trip is far more than half of this total. What it cannot detect is a
 * sub-millisecond difference, and neither can an attacker: they are measuring across the internet,
 * where jitter is orders of magnitude larger than an index lookup.
 *
 * ## Why medians and not means
 *
 * One sample that hit a GC pause or a connection checkout moves a mean by more than the effect being
 * measured. The median is unmoved by a handful of outliers, which is exactly the shape of noise a
 * database round trip produces.
 */
const ENUMERATION_TOLERANCE_RATIO = 0.5

/**
 * A floor under the ratio, in milliseconds.
 *
 * With medians of two or three milliseconds, fifty per cent is one millisecond, and one millisecond is
 * scheduler noise rather than evidence. The floor keeps the test from failing on jitter while still
 * being far below the cost of the extra round trip this is looking for.
 */
const ENUMERATION_TOLERANCE_FLOOR_MS = 15

function mediansWithinTolerance(a: readonly number[], b: readonly number[]): boolean {
  const [fast, slow] = [median(a), median(b)].sort((x, y) => x - y)
  const allowed = Math.max(
    ENUMERATION_TOLERANCE_FLOOR_MS,
    (fast ?? 0) * ENUMERATION_TOLERANCE_RATIO,
  )
  return (slow ?? 0) - (fast ?? 0) <= allowed
}

beforeEach(async () => {
  await sql`delete from otp_challenge`
  await sql`delete from otp_phone_lock`
  await sql`delete from customer`
})

afterAll(async () => {
  await sql`delete from customer`
  await sql.end({ timeout: 5 })
})

describe('the success response', () => {
  it('sends the code through the choke point and into the local outbox', async () => {
    const { deps, outbox, sms } = harness()
    const response = await handleOtpRequest(deps, otpRequest({ phone: unknown(1) }))
    expect(response.status).toBe(202)
    const body = await response.json()
    expect(body).toEqual({ status: 'sent', expiresInSeconds: OTP_TTL_MINUTES * 60, codeLength: 6 })

    // The message went through sendMessage, which diverted it: APP_ENV=test and the recipient is not
    // allowlisted, so the local outbox holds it and no provider was called (ADR 0005).
    expect(outbox.size).toBe(1)
    const entry = outbox.all()[0]
    expect(entry?.message.templateKey).toBe('auth.otp')
    expect(entry?.message.messageClass).toBe('transactional')
    expect(entry?.message.recipient).toBe(unknown(1))
    expect(entry?.message.body).toMatch(/^Your code is \d{6}, valid 5 minutes\./)
    expect(sms.calls.all()).toHaveLength(0)

    // And the code is in the SMS, not in the response. A response that carried the code would make
    // the SMS decorative.
    const code = /\d{6}/.exec(entry?.message.body ?? '')?.[0]
    expect(code).toBeDefined()
    expect(JSON.stringify(body)).not.toContain(code)
  })

  it('reaches the SMSala fake when the recipient is allowlisted', async () => {
    // The control for the test above: without it, "the outbox holds the message" is satisfied by a
    // transport that is never reachable at all, and the whole send path could be broken.
    const recipient = known(1)
    const { deps, outbox, sms } = harness({ allowlist: [recipient] })
    expect((await handleOtpRequest(deps, otpRequest({ phone: recipient }))).status).toBe(202)
    expect(outbox.size).toBe(0)
    const calls = sms.calls.forProvider('smsala')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.outcome).toBe('success')
    // From the transactional identity, chosen by the template class and not by this call site.
    expect(calls[0]?.summary).toContain(`'${PROVISIONAL_SENDER_IDS.transactional.value}'`)
  })

  it('renders the Arabic template for an Arabic request', async () => {
    const { deps, outbox } = harness()
    await handleOtpRequest(deps, otpRequest({ phone: unknown(2), locale: 'ar' }))
    const entry = outbox.all()[0]
    expect(entry?.message.locale).toBe('ar')
    // The Arabic body, not the English one: a customer who booked in Arabic and is texted in English
    // has been told the system does not remember them.
    expect(entry?.message.body).not.toMatch(/Your code/)
    expect(entry?.message.body).toMatch(/\d{6}/)
  })
})

describe('enumeration resistance', () => {
  it('answers a known and an unknown number identically, in status, body and time', async () => {
    const { deps } = harness()

    // Fifty numbers the business knows, fifty it has never seen. Every request uses a different
    // number so the per-number rate limit cannot fire, and no forwarded-for header is sent so the
    // per-IP limit is not the thing being measured either.
    const knownNumbers = Array.from({ length: ENUMERATION_SAMPLES }, (_, n) => known(n))
    await sql`
      insert into customer ${sql(
        knownNumbers.map((phone) => ({ phone_e164: phone, locale: 'en' })),
      )}
    `
    const [customers] = await sql<{ n: string }[]>`select count(*)::text as n from customer`
    expect(Number(customers?.n)).toBe(ENUMERATION_SAMPLES)

    const knownTimes: number[] = []
    const unknownTimes: number[] = []
    const statuses = new Set<number>()
    const bodies = new Set<string>()

    // Interleaved, not one batch after the other: a machine that gets busier halfway through would
    // otherwise load the second population only, and the difference would be the machine.
    for (let n = 0; n < ENUMERATION_SAMPLES; n += 1) {
      const first = await observe(deps, otpRequest({ phone: knownNumbers[n] }))
      const second = await observe(deps, otpRequest({ phone: unknown(n) }))
      knownTimes.push(first.elapsedMs)
      unknownTimes.push(second.elapsedMs)
      statuses.add(first.status)
      statuses.add(second.status)
      bodies.add(first.body)
      bodies.add(second.body)
    }

    // Identical status and byte-identical body, for all hundred requests.
    expect([...statuses]).toEqual([202])
    expect(bodies.size).toBe(1)

    // Asserted through an object so a failure prints both medians: "expected true to be false" from a
    // timing test is the least actionable message there is.
    expect({
      withinTolerance: mediansWithinTolerance(knownTimes, unknownTimes),
      knownMedianMs: Number(median(knownTimes).toFixed(2)),
      unknownMedianMs: Number(median(unknownTimes).toFixed(2)),
    }).toMatchObject({ withinTolerance: true })
  })

  it('detects a deliberate delay on the known-number path', async () => {
    // The control, and the reason the assertion above is worth making. A tolerance nobody has seen
    // reject anything is a tolerance that might be infinite (ADR 0003). The delay is an order of
    // magnitude larger than the floor, because what this proves is that the comparison fires — not
    // where its exact edge is.
    const DELIBERATE_DELAY_MS = 150
    const SAMPLES = 10
    const { deps } = harness()
    await sql`
      insert into customer ${sql(
        Array.from({ length: SAMPLES }, (_, n) => ({ phone_e164: known(600 + n), locale: 'en' })),
      )}
    `

    const delayed: number[] = []
    const plain: number[] = []
    // Ten samples, not fifty: the effect is 150ms and the point is that the comparison detects it.
    for (let n = 0; n < SAMPLES; n += 1) {
      const startedDelayed = performance.now()
      await new Promise((resolve) => setTimeout(resolve, DELIBERATE_DELAY_MS))
      await handleOtpRequest(deps, otpRequest({ phone: known(600 + n) }))
      delayed.push(performance.now() - startedDelayed)

      const startedPlain = performance.now()
      await handleOtpRequest(deps, otpRequest({ phone: unknown(600 + n) }))
      plain.push(performance.now() - startedPlain)
    }

    expect({
      withinTolerance: mediansWithinTolerance(delayed, plain),
      delayedMedianMs: Number(median(delayed).toFixed(2)),
      plainMedianMs: Number(median(plain).toFixed(2)),
    }).toMatchObject({ withinTolerance: false })
  })
})

describe('refusals', () => {
  it('answers 429 with Retry-After when one number asks too often, and audits it', async () => {
    const { deps } = harness()
    const phone = unknown(10)
    const before = await auditCount('otp.rate_limited')
    for (let n = 0; n < OTP_MAX_REQUESTS_PER_PHONE; n += 1) {
      expect((await handleOtpRequest(deps, otpRequest({ phone }))).status).toBe(202)
    }
    const refused = await handleOtpRequest(deps, otpRequest({ phone }))
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await refused.json()).toMatchObject({
      error: 'too_many_requests',
      reason: 'rate_limited',
    })
    expect(await auditCount('otp.rate_limited')).toBe(before + 1)

    // The control: a different number is still served, so this is the per-number limit and not a
    // global stop.
    expect((await handleOtpRequest(deps, otpRequest({ phone: unknown(11) }))).status).toBe(202)
  })

  it('answers 429 when one address asks too often across many numbers, and audits it', async () => {
    const { deps } = harness()
    const headers = { 'x-forwarded-for': '203.0.113.5, 70.41.3.18' }
    const before = await auditCount('otp.rate_limited')
    for (let n = 0; n < OTP_MAX_REQUESTS_PER_IP; n += 1) {
      const response = await handleOtpRequest(deps, otpRequest({ phone: unknown(20 + n) }, headers))
      expect(response.status).toBe(202)
    }
    const refused = await handleOtpRequest(deps, otpRequest({ phone: unknown(99) }, headers))
    expect(refused.status).toBe(429)
    expect(await auditCount('otp.rate_limited')).toBe(before + 1)

    // The first entry in x-forwarded-for is the client; the rest are proxies. Asserted by way of the
    // control: the same number from a different client address is served.
    expect(
      (
        await handleOtpRequest(
          deps,
          otpRequest(
            { phone: unknown(99) },
            {
              'x-forwarded-for': '203.0.113.6',
            },
          ),
        )
      ).status,
    ).toBe(202)

    // `host()` and not `::text`: casting inet to text appends the /32 netmask, which is a property of
    // the cast rather than of what was stored.
    //
    // Narrowed by phone, not `order by issued_at limit 1`. `harness()` runs on a FROZEN clock and
    // `otp_challenge.issued_at` has no default (0019 makes the application supply it), so every row this
    // test writes carries the SAME timestamp: that ordering is one big tie and Postgres may return any
    // member of it, including the control request's row from 203.0.113.6. It did, on W-SITE-05's verify.
    // `unknown(20)` is the first number the loop used and only the loop used it, so this is the row the
    // assertion is about.
    const [stored] = await sql<{ request_ip: string }[]>`
      select host(request_ip) as request_ip from otp_challenge where phone_e164 = ${unknown(20)}
    `
    expect(stored?.request_ip).toBe('203.0.113.5')
  })

  it('answers 422 with the named reason for a landline', async () => {
    const { deps, outbox } = harness()
    const response = await handleOtpRequest(deps, otpRequest({ phone: '02 123 4567' }))
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: 'phone_not_eligible',
      reason: 'landline_not_an_sms_target',
    })
    // Nothing was sent and nothing was charged for.
    expect(outbox.size).toBe(0)

    // The control: a mobile of the same length is accepted, so 422 is about the number and not about
    // the endpoint being broken.
    expect((await handleOtpRequest(deps, otpRequest({ phone: unknown(30) }))).status).toBe(202)
  })

  it('answers 400 for a body it cannot read', async () => {
    const { deps } = harness()
    for (const body of ['not json', {}, { phone: 1234 }, { phone: unknown(1), purpose: 'admin' }]) {
      const response = await handleOtpRequest(deps, otpRequest(body))
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_request' })
    }
    // An unrecognised purpose is refused rather than defaulted, which is the interesting case above:
    // a code issued for one purpose must not be usable for another.
    expect((await handleOtpRequest(deps, otpRequest({ phone: unknown(31) }))).status).toBe(202)
  })
})

async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '0')
}
