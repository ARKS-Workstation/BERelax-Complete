import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../audit.ts'
import { createConnection, type Sql } from '../connection.ts'
import { withUnitOfWork } from '../tx.ts'
import {
  hashOtpCode,
  issueOtpChallenge,
  OTP_CODE_DIGITS,
  OTP_LOCK_MINUTES,
  OTP_MAX_FAILED_ATTEMPTS,
  OTP_MAX_REQUESTS_PER_IP,
  OTP_MAX_REQUESTS_PER_PHONE,
  OTP_TTL_MINUTES,
  verifyOtpCode,
} from './otp.ts'

/**
 * B-LIFE-02 — the OTP challenge against a real PostgreSQL, under a frozen clock.
 *
 * ## Why this is an `.itest.ts` and not the `otp.test.ts` the manifest names
 *
 * Every claim in this unit is a claim about rows: that the code is not in one, that a second
 * verification finds the challenge consumed, that the attempt counter survives a new code being
 * issued. The unit runner has no database, so the `.test.ts` version of this file could only assert
 * against a fake — and a fake would be asserting that the fake works. `otp.test.ts` keeps the two
 * assertions that are genuinely pure (the code shape, and the hash being a function of the salt).
 *
 * ## Why the clock is an argument everywhere
 *
 * Expiry is five minutes, the lock is fifteen and the rate-limit windows are fifteen and sixty. Under
 * a real clock those are provable only by waiting, which means they are never provable. Every instant
 * below is computed from one frozen origin.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** 22:00 Asia/Dubai: open business hours, and the hour most OTPs in this business are sent in. */
const FROZEN_ORIGIN_MS = Date.parse('2026-09-18T18:00:00.000Z')
const at = (minutes: number): string => new Date(FROZEN_ORIGIN_MS + minutes * 60_000).toISOString()

/**
 * Fixture numbers on the unallocated `59` prefix, copied rather than imported.
 *
 * `packages/fixtures/src/synthetic.ts` owns `SYNTHETIC_MOBILE_PREFIX` and this file cannot import it:
 * `@berelax/fixtures` depends on `@berelax/db`, so the import would be a cycle. The property that
 * matters — 059 is not an allocated UAE mobile prefix, so none of these can reach a handset — is
 * asserted there, and `packages/fixtures/src/customer-identity.itest.ts` exercises the same numbers
 * through the real constant.
 */
const SYNTHETIC = (serial: number): string => `+97159${String(serial).padStart(7, '0')}`
const PHONE = SYNTHETIC(42)
const OTHER_PHONE = SYNTHETIC(43)
const REQUEST_IP = '198.51.100.7'

/** The actor on a public OTP request: a customer, and not one we can name. */
const CALLER: Actor = { kind: 'customer', label: 'OTP request (unauthenticated)' }

/** A schema of its own for the known-bad fixture table; `public` is drift-checked. */
const FIXTURE_SCHEMA = 'otp_itest'

const sql: Sql = createConnection({ url, max: 4 })

/**
 * Words that would mean a code is stored in the clear.
 *
 * `code_hash` and `code_salt` are the two legitimate `code%` columns. Anything else matching is the
 * failure this looks for: a `code` column added "just for debugging" that then appears in every
 * backup, every replica and every query log.
 */
async function plaintextColumns(schema: string, table: string): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    select column_name
    from information_schema.columns
    where table_schema = ${schema}
      and table_name = ${table}
      and column_name ~ '(code|otp|secret|plaintext)'
      and column_name not in ('code_hash', 'code_salt')
    order by column_name
  `
  return rows.map((row) => row.column_name)
}

async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '0')
}

async function issue(options: {
  phone?: string
  ip?: string | null
  nowIso?: string
  purpose?: 'booking_verify' | 'view_bookings'
}) {
  return await withUnitOfWork(sql, CALLER, (uow) =>
    issueOtpChallenge(uow, {
      phoneE164: options.phone ?? PHONE,
      purpose: options.purpose ?? 'booking_verify',
      nowIso: options.nowIso ?? at(0),
      requestIp: options.ip === undefined ? REQUEST_IP : options.ip,
      requestId: null,
    }),
  )
}

async function verify(code: string, nowIso: string, phone = PHONE) {
  return await withUnitOfWork(sql, CALLER, (uow) =>
    verifyOtpCode(uow, { phoneE164: phone, purpose: 'booking_verify', code, nowIso }),
  )
}

/** The code, or a failure — every test here needs the code, and `kind` narrowing three times is noise. */
async function issuedCode(options: Parameters<typeof issue>[0] = {}): Promise<string> {
  const result = await issue(options)
  if (result.kind !== 'issued') throw new Error(`Expected an issued code, got ${result.kind}`)
  return result.code
}

beforeEach(async () => {
  // Neither table is append-only, so a truncate is honest here. audit_event IS append-only (ADR 0008),
  // which is why every assertion on it below is a delta.
  await sql`delete from otp_challenge`
  await sql`delete from otp_phone_lock`
})

afterAll(async () => {
  await sql.unsafe(`drop schema if exists ${FIXTURE_SCHEMA} cascade`)
  await sql.end({ timeout: 5 })
})

describe('the OTP code is never stored in the clear', () => {
  it('has no plaintext column, and the detector that says so can fail', async () => {
    expect(await plaintextColumns('public', 'otp_challenge')).toEqual([])

    // The control. A detector that matched nothing would report every table clean forever, which is
    // precisely the shape of gate ADR 0003 exists about. So build the table it must catch.
    await sql.unsafe(`create schema if not exists ${FIXTURE_SCHEMA}`)
    await sql.unsafe(`
      create table if not exists ${FIXTURE_SCHEMA}.otp_challenge_with_plaintext (
        id uuid primary key default uuid_generate_v7(),
        code text not null,
        otp_secret text
      )
    `)
    expect(await plaintextColumns(FIXTURE_SCHEMA, 'otp_challenge_with_plaintext')).toEqual([
      'code',
      'otp_secret',
    ])
  })

  it('stores a hash that is not the code, and nothing in the row is', async () => {
    const code = await issuedCode({})
    expect(code).toMatch(new RegExp(`^\\d{${OTP_CODE_DIGITS}}$`))

    // The hash columns are excluded and asserted separately: bytea serialises as a hex string, and a
    // six-digit code can appear inside 32 bytes of hex by chance often enough to make a test flaky.
    const [row] = await sql<{ body: Record<string, unknown>; code_hash: Buffer }[]>`
      select to_jsonb(c) - 'code_hash' - 'code_salt' as body, c.code_hash from otp_challenge c
    `
    if (row === undefined) throw new Error('no challenge row')
    // The whole row, serialised: no column holds the code, including the ones nobody thought about.
    expect(JSON.stringify(row.body)).not.toContain(code)
    expect(row.code_hash.toString('utf8')).not.toContain(code)

    // The control. The same scan over a row that DOES carry the code must find it — otherwise the
    // assertion above passes for a serialisation that silently dropped the columns.
    await sql`update otp_challenge set request_id = ${code}`
    const [leaky] = await sql<{ body: Record<string, unknown> }[]>`
      select to_jsonb(c) - 'code_hash' - 'code_salt' as body from otp_challenge c
    `
    expect(JSON.stringify(leaky?.body)).toContain(code)
  })

  it('binds the hash to the row salt, so two challenges with one code do not look alike', async () => {
    const code = await issuedCode({})
    const [first] = await sql<{ code_hash: Buffer; code_salt: Buffer }[]>`
      select code_hash, code_salt from otp_challenge
    `
    if (first === undefined) throw new Error('no challenge row')
    // The stored hash is exactly the HMAC under the stored salt: the verify path is not doing
    // something else that happens to agree.
    expect(hashOtpCode(code, first.code_salt).equals(first.code_hash)).toBe(true)
    // And under a different salt it is a different hash, which is what the per-row salt is for.
    expect(hashOtpCode(code, Buffer.from('another-salt')).equals(first.code_hash)).toBe(false)
  })
})

describe('an OTP code is single use', () => {
  it('verifies once and then refuses the same code', async () => {
    const code = await issuedCode({})
    expect(await verify(code, at(1))).toEqual({
      kind: 'verified',
      challengeId: expect.any(String),
    })

    const replay = await verify(code, at(2))
    expect(replay.kind).toBe('rejected')
    if (replay.kind === 'rejected') expect(replay.reason).toBe('no_live_challenge')

    const [consumed] = await sql<{ consumed_at: Date | null }[]>`
      select consumed_at from otp_challenge
    `
    expect(consumed?.consumed_at).not.toBeNull()
  })

  it('supersedes the previous code when a new one is issued', async () => {
    const first = await issuedCode({})
    const second = await issuedCode({ nowIso: at(1) })
    expect(second).not.toBe(first)

    // The old code stops working the moment a new one exists. Without this, a resend leaves two live
    // codes and an intercepted earlier SMS keeps working for its full five minutes.
    const stale = await verify(first, at(2))
    expect(stale.kind).toBe('rejected')
    if (stale.kind === 'rejected') expect(stale.reason).toBe('wrong_code')

    // The control: the newest code does verify, so "rejected" above is about supersession and not
    // about the verify path being broken.
    expect((await verify(second, at(2))).kind).toBe('verified')
  })
})

describe('an OTP code expires after five minutes', () => {
  it('verifies one second before expiry and refuses one second after', async () => {
    const early = await issuedCode({})
    expect((await verify(early, at(OTP_TTL_MINUTES - 1 / 60))).kind).toBe('verified')

    const late = await issuedCode({ nowIso: at(10) })
    const expired = await verify(late, at(10 + OTP_TTL_MINUTES + 1 / 60))
    expect(expired.kind).toBe('rejected')
    if (expired.kind === 'rejected') expect(expired.reason).toBe('expired')
  })

  it('writes the expiry from the injected clock, not from the database wall clock', async () => {
    await issue({ nowIso: at(0) })
    const [row] = await sql<{ issued_at: Date; expires_at: Date }[]>`
      select issued_at, expires_at from otp_challenge
    `
    if (row === undefined) throw new Error('no challenge row')
    expect(row.issued_at.toISOString()).toBe(at(0))
    expect(row.expires_at.getTime() - row.issued_at.getTime()).toBe(OTP_TTL_MINUTES * 60_000)
    // The control: a row that read now() would carry today's real instant, not the frozen one.
    expect(Math.abs(row.issued_at.getTime() - Date.now())).toBeGreaterThan(60_000)
  })
})

describe('five failed attempts lock the number for fifteen minutes', () => {
  /** A code of the right shape that is not the right code. */
  const wrongCode = (code: string): string => (code === '000000' ? '111111' : '000000')

  it('counts wrong guesses, locks on the fifth, and refuses the right code while locked', async () => {
    const code = await issuedCode({})
    const wrong = wrongCode(code)

    for (let attempt = 1; attempt < OTP_MAX_FAILED_ATTEMPTS; attempt += 1) {
      const rejected = await verify(wrong, at(1))
      expect(rejected.kind).toBe('rejected')
      if (rejected.kind === 'rejected') {
        expect(rejected.reason).toBe('wrong_code')
        expect(rejected.attemptsRemaining).toBe(OTP_MAX_FAILED_ATTEMPTS - attempt)
      }
    }

    const locked = await verify(wrong, at(1))
    expect(locked.kind).toBe('rejected')
    if (locked.kind === 'rejected') {
      expect(locked.reason).toBe('locked')
      expect(locked.attemptsRemaining).toBe(0)
      expect(locked.retryAfterSeconds).toBe(OTP_LOCK_MINUTES * 60)
    }

    // The assertion that makes the lock a lock: the CORRECT code is refused too. A "lock" that only
    // refuses wrong codes has cost an attacker nothing.
    const rightButLocked = await verify(code, at(2))
    expect(rightButLocked.kind).toBe('rejected')
    if (rightButLocked.kind === 'rejected') expect(rightButLocked.reason).toBe('locked')

    const [lock] = await sql<{ consecutive_failures: number; locked_until: Date }[]>`
      select consecutive_failures, locked_until from otp_phone_lock where phone_e164 = ${PHONE}
    `
    expect(lock?.consecutive_failures).toBe(OTP_MAX_FAILED_ATTEMPTS)
    expect(lock?.locked_until.toISOString()).toBe(at(1 + OTP_LOCK_MINUTES))
  })

  it('lifts the lock after fifteen minutes and not before', async () => {
    const code = await issuedCode({})
    for (let attempt = 0; attempt < OTP_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await verify(wrongCode(code), at(1))
    }

    // One minute before the lock lifts, a request for a new code is still refused.
    const tooEarly = await issue({ nowIso: at(1 + OTP_LOCK_MINUTES - 1) })
    expect(tooEarly.kind).toBe('locked')

    // After it lifts, a new code is issued and verifies. The original code is long expired by now,
    // which is why this asserts on a fresh one rather than replaying the old.
    const afterLock = await issue({ nowIso: at(1 + OTP_LOCK_MINUTES) })
    expect(afterLock.kind).toBe('issued')
    if (afterLock.kind === 'issued') {
      expect((await verify(afterLock.code, at(1 + OTP_LOCK_MINUTES))).kind).toBe('verified')
    }
  })

  it('does not reset the counter when a new code is requested', async () => {
    // The defect this is about: an attempt counter on the challenge row makes five attempts five
    // attempts PER CODE, and the resend button makes that unlimited.
    const first = await issuedCode({})
    for (let attempt = 0; attempt < OTP_MAX_FAILED_ATTEMPTS - 1; attempt += 1) {
      await verify(wrongCode(first), at(1))
    }
    const second = await issuedCode({ nowIso: at(2) })
    const locked = await verify(wrongCode(second), at(2))
    expect(locked.kind).toBe('rejected')
    if (locked.kind === 'rejected') expect(locked.reason).toBe('locked')
  })

  it('clears the counter on a successful verification', async () => {
    const code = await issuedCode({})
    for (let attempt = 0; attempt < OTP_MAX_FAILED_ATTEMPTS - 1; attempt += 1) {
      await verify(wrongCode(code), at(1))
    }
    expect((await verify(code, at(1))).kind).toBe('verified')
    const [lock] = await sql<{ consecutive_failures: number }[]>`
      select consecutive_failures from otp_phone_lock where phone_e164 = ${PHONE}
    `
    // Four honest mistakes and a success must not leave the number one mistake from a lock next week.
    expect(lock?.consecutive_failures).toBe(0)
  })
})

describe('OTP requests are rate limited per phone and per IP, independently', () => {
  it('refuses the fourth request for one number inside the window, and audits it', async () => {
    const before = await auditCount('otp.rate_limited')
    for (let n = 0; n < OTP_MAX_REQUESTS_PER_PHONE; n += 1) {
      expect((await issue({ nowIso: at(n) })).kind).toBe('issued')
    }
    const refused = await issue({ nowIso: at(OTP_MAX_REQUESTS_PER_PHONE) })
    expect(refused.kind).toBe('rate_limited')
    if (refused.kind === 'rate_limited') {
      expect(refused.limit).toBe('phone')
      expect(refused.retryAfterSeconds).toBeGreaterThan(0)
    }
    // A delta, never a total: audit_event is append-only and shared with every other test.
    expect(await auditCount('otp.rate_limited')).toBe(before + 1)

    // The control: a DIFFERENT number from the same IP is still served, which is what makes this the
    // per-phone limit rather than the per-IP one firing early.
    expect((await issue({ phone: OTHER_PHONE, nowIso: at(4) })).kind).toBe('issued')
  })

  it('frees the number once the window slides past the oldest request', async () => {
    for (let n = 0; n < OTP_MAX_REQUESTS_PER_PHONE; n += 1) {
      await issue({ nowIso: at(n) })
    }
    expect((await issue({ nowIso: at(10) })).kind).toBe('rate_limited')
    // 16 minutes after the first request, the oldest has left the 15-minute window.
    expect((await issue({ nowIso: at(16) })).kind).toBe('issued')
  })

  it('refuses the eleventh request from one IP across many numbers, and audits it', async () => {
    const before = await auditCount('otp.rate_limited')
    // Spread over distinct numbers so the per-phone limit cannot be what fires: each number gets one
    // request, and the per-IP counter is the only thing accumulating.
    for (let n = 0; n < OTP_MAX_REQUESTS_PER_IP; n += 1) {
      expect((await issue({ phone: SYNTHETIC(100 + n), nowIso: at(n) })).kind).toBe('issued')
    }
    const refused = await issue({ phone: SYNTHETIC(999), nowIso: at(OTP_MAX_REQUESTS_PER_IP) })
    expect(refused.kind).toBe('rate_limited')
    if (refused.kind === 'rate_limited') expect(refused.limit).toBe('ip')
    expect(await auditCount('otp.rate_limited')).toBe(before + 1)

    // The control: the same number from a different address is served. Without it, this test passes
    // just as well when the per-phone limit has silently become a global one.
    expect(
      (
        await issue({
          phone: SYNTHETIC(999),
          ip: '198.51.100.9',
          nowIso: at(OTP_MAX_REQUESTS_PER_IP),
        })
      ).kind,
    ).toBe('issued')
  })

  it('applies no IP limit when the edge supplied no address', async () => {
    // A null IP is not a bucket: counting nulls together would let one proxy-stripped request block
    // every other. The per-phone limit still applies, which is why each request here is a new number.
    for (let n = 0; n < OTP_MAX_REQUESTS_PER_IP + 2; n += 1) {
      expect((await issue({ phone: SYNTHETIC(200 + n), ip: null, nowIso: at(n) })).kind).toBe(
        'issued',
      )
    }
  })
})

describe('the audit trail', () => {
  it('records an issue without recording the code', async () => {
    const before = await auditCount('otp.issued')
    const code = await issuedCode({})
    expect(await auditCount('otp.issued')).toBe(before + 1)

    const [row] = await sql<{ after_state: Record<string, unknown> }[]>`
      select after_state from audit_event where action = 'otp.issued'
      order by occurred_at desc limit 1
    `
    const serialised = JSON.stringify(row?.after_state)
    expect(serialised).toContain(PHONE)
    expect(serialised).not.toContain(code)
  })

  it('records a lock', async () => {
    const before = await auditCount('otp.phone_locked')
    const code = await issuedCode({})
    const wrong = code === '000000' ? '111111' : '000000'
    for (let attempt = 0; attempt < OTP_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await verify(wrong, at(1))
    }
    expect(await auditCount('otp.phone_locked')).toBe(before + 1)
  })
})
